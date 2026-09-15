import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { readAuditEvents } from "./audit";

/**
 * Token/credit usage reader.
 *
 * Kiro persists chat sessions under ~/.kiro/sessions in two shapes:
 *   - IDE : <workspaceHash>/sess_<uuid>/{session.json, messages.jsonl}
 *           messages.jsonl is an append-only event log; `usage_summary`
 *           payloads carry per-turn credits, `session_metadata(contextUsage)`
 *           the context-window fill. Matched to a workspace via
 *           session.json workspacePaths/rootPaths.
 *   - CLI : cli/<uuid>.{json,jsonl}
 *           <uuid>.json holds per-turn stats (user_turn_metadatas[] with
 *           metering_usage credits) keyed to a `cwd`.
 *
 * Reads are READ-ONLY. Two performance measures keep this off the hot path:
 *   1. Parsing is async (fs.promises) with bounded concurrency, and the store
 *      refreshes with a sequence guard so it never blocks the UI thread.
 *   2. A parse cache keyed by file mtime+size means unchanged sessions are
 *      never re-read — only new/modified session logs are parsed on refresh.
 * Stage/intent attribution (cheap, in-memory) is re-run each load.
 */

export type UsageScope = "workspace" | "global";

/** One prompt turn (one user⇄assistant exchange) with its credit usage. */
export interface TurnUsage {
  /** 1-based turn index within the session. */
  index: number;
  startedAt: string;
  endedAt: string;
  /** Sum of promptTurnSummaries[].usage — credits consumed by this turn. */
  credits: number;
  /** Kiro's unit label ("credit"/"credits"), best-effort. */
  unit: string;
  /** Turn wall-clock time in milliseconds (from usage_summary.elapsedTime). */
  elapsedMs: number;
  /** usage_summary.status ("success", …) or "in-progress" when unfinished. */
  status: string;
  /** Distinct tool names used in the turn. */
  tools: string[];
  /** Latest context-window fill % observed within the turn, if any. */
  contextPercent?: number;
  /** First user prompt text of the turn (trimmed), for labelling. */
  prompt?: string;
  /** Attributed AI-DLC stage slug (best-effort), if resolvable. */
  stageSlug?: string;
  /** Attributed AI-DLC intent (audit dir name) active at this turn's time. */
  intentName?: string;
  /** Whether a usage_summary closed this turn (false = still running). */
  complete: boolean;
}

/** One Kiro chat session. */
export interface SessionUsage {
  id: string;
  title: string;
  /** Absolute path to the session directory (IDE) or .json file (CLI). */
  dir: string;
  /** The session's primary workspace/cwd, for global grouping. */
  workspace?: string;
  modelId?: string;
  agentMode?: string;
  createdAt: string;
  lastModifiedAt: string;
  /** Sum of turn credits across the session. */
  totalCredits: number;
  /** Most recent context-window fill %, if any. */
  latestContextPercent?: number;
  turns: TurnUsage[];
}

/** Per-key aggregation (stage / intent / workspace). */
export interface StageUsage {
  credits: number;
  turns: number;
}

/** Everything the views need. */
export interface WorkspaceUsage {
  /** "workspace" (matched to the active AI-DLC root) or "global" (all). */
  scope: UsageScope;
  /** Sessions newest-first (by lastModifiedAt). */
  sessions: SessionUsage[];
  /** stage slug → aggregated usage, SCOPED TO THE ACTIVE INTENT (workspace
   *  scope only). Empty in global scope. */
  byStage: Map<string, StageUsage>;
  /** intent name → aggregated usage across all intents (workspace scope). */
  byIntent: Map<string, StageUsage>;
  /** The active intent (audit dir name) byStage is scoped to, if any. */
  activeIntent?: string;
  totalCredits: number;
  turnCount: number;
  /** True when at least one turn could be attributed to a stage/intent. */
  hasStageAttribution: boolean;
  /** Absolute sessions root that was scanned (for diagnostics). */
  sessionsRoot: string;
  /** Active period filter: "" = all time, else "YYYY-MM". */
  period: string;
  /** Distinct months ("YYYY-MM") present across all scanned sessions,
   *  newest-first — the choices offered by the period picker. */
  months: string[];
}

/** Kiro's per-user session store. Honors KIRO_HOME if set, else ~/.kiro. */
export function sessionsRoot(): string {
  const home = process.env.KIRO_HOME
    ? process.env.KIRO_HOME
    : path.join(os.homedir(), ".kiro");
  return path.join(home, "sessions");
}

/* ------------------------------ async fs io ------------------------------ */

async function readdirAsync(dir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dir);
  } catch {
    return [];
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function readFileAsync(file: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

async function readJsonAsync<T>(file: string): Promise<T | undefined> {
  const text = await readFileAsync(file);
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** A cheap freshness key for a file: `${mtimeMs}:${size}`, or undefined. */
async function statKey(file: string): Promise<string | undefined> {
  try {
    const s = await fs.promises.stat(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return undefined;
  }
}

/** Run `fn` over `items` with at most `limit` in flight (fd-safe). */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) {
        return;
      }
      results[i] = await fn(items[i]);
    }
  };
  const n = Math.min(Math.max(1, limit), items.length || 1);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/* -------------------------------- caching -------------------------------- */
//
// Parsing messages.jsonl / CLI logs is the expensive part. We cache the parsed
// SessionUsage keyed by the session's identity (dir/base path), invalidated by
// the log file's mtime+size. A refresh re-parses only sessions whose log has
// changed; everything else is reused. Attribution tags on cached turns are
// re-set on every load, so sharing objects across scopes is safe.

interface CacheEntry {
  statKey: string;
  session: SessionUsage;
}
const sessionCache = new Map<string, CacheEntry>();

/* -------------------------------- matching ------------------------------- */

interface SessionMeta {
  id?: string;
  title?: string;
  modelId?: string;
  agentMode?: string;
  createdAt?: string;
  lastModifiedAt?: string;
  workspacePaths?: string[];
  rootPaths?: string[];
}

/** Whether two absolute paths overlap (equal, or one contains the other). */
function pathsOverlap(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const aa = a.endsWith(path.sep) ? a : a + path.sep;
  const bb = b.endsWith(path.sep) ? b : b + path.sep;
  return a.startsWith(bb) || b.startsWith(aa);
}

/** Trim a prompt to a compact single-line snippet for tree labels. */
function snippet(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
          ? (c as { text: string }).text
          : "",
      )
      .join(" ");
  }
  return "";
}

/* ----------------------------- IDE parsing ------------------------------- */

interface RawMessage {
  timestamp?: string;
  payload?: {
    type?: string;
    content?: unknown;
    key?: string;
    value?: { usagePercentage?: number };
    promptTurnSummaries?: {
      unit?: string;
      usage?: number;
      usedTools?: string[];
    }[];
    elapsedTime?: number;
    status?: string;
  };
}

/** Parse messages.jsonl text into ordered turns. A turn is the run of messages
 *  closed by a `usage_summary` (turn_end); trailing messages with no summary
 *  form a final in-progress turn. */
function parseTurnsFromText(raw: string): {
  turns: TurnUsage[];
  latestContextPercent?: number;
} {
  const turns: TurnUsage[] = [];
  let latestContextPercent: number | undefined;

  let idx = 0;
  let firstTs: string | undefined;
  let prompt: string | undefined;
  let turnContext: number | undefined;
  let started = false;

  const reset = (): void => {
    firstTs = undefined;
    prompt = undefined;
    turnContext = undefined;
    started = false;
  };

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let msg: RawMessage;
    try {
      msg = JSON.parse(line) as RawMessage;
    } catch {
      continue;
    }
    const p = msg.payload ?? {};
    const type = p.type;
    if (!started) {
      firstTs = msg.timestamp;
      started = true;
    }

    if (type === "user" && prompt === undefined) {
      const text = contentToText(p.content);
      if (text.trim()) {
        prompt = snippet(text);
      }
    } else if (type === "session_metadata" && p.key === "contextUsage") {
      const pct = p.value?.usagePercentage;
      if (typeof pct === "number") {
        turnContext = pct;
        latestContextPercent = pct;
      }
    } else if (type === "usage_summary") {
      const summaries = p.promptTurnSummaries ?? [];
      let credits = 0;
      const tools = new Set<string>();
      let unit = "credit";
      for (const s of summaries) {
        if (typeof s.usage === "number") {
          credits += s.usage;
        }
        if (s.unit) {
          unit = s.unit;
        }
        for (const tool of s.usedTools ?? []) {
          tools.add(tool);
        }
      }
      idx += 1;
      turns.push({
        index: idx,
        startedAt: firstTs ?? msg.timestamp ?? "",
        endedAt: msg.timestamp ?? firstTs ?? "",
        credits,
        unit,
        elapsedMs: typeof p.elapsedTime === "number" ? p.elapsedTime : 0,
        status: p.status ?? "success",
        tools: [...tools],
        contextPercent: turnContext,
        prompt,
        complete: true,
      });
      reset();
    }
  }

  if (started && prompt !== undefined) {
    idx += 1;
    turns.push({
      index: idx,
      startedAt: firstTs ?? "",
      endedAt: "",
      credits: 0,
      unit: "credit",
      elapsedMs: 0,
      status: "in-progress",
      tools: [],
      contextPercent: turnContext,
      prompt,
      complete: false,
    });
  }

  return { turns, latestContextPercent };
}

/** Load one IDE session dir, using the parse cache. Returns undefined when it
 *  doesn't match `root` (when a root filter is given) or can't be read. */
async function loadIdeSession(
  sessDir: string,
  root: string | undefined,
): Promise<SessionUsage | undefined> {
  const meta = await readJsonAsync<SessionMeta>(
    path.join(sessDir, "session.json"),
  );
  if (!meta) {
    return undefined;
  }
  const wsPaths = [
    ...(meta.workspacePaths ?? []),
    ...(meta.rootPaths ?? []),
  ].filter((p): p is string => typeof p === "string");
  if (root && !wsPaths.some((p) => pathsOverlap(p, root))) {
    return undefined;
  }

  const msgFile = path.join(sessDir, "messages.jsonl");
  const key = await statKey(msgFile);
  const cached = sessionCache.get(sessDir);
  if (cached && key && cached.statKey === key) {
    return cached.session;
  }

  const text = (await readFileAsync(msgFile)) ?? "";
  const { turns, latestContextPercent } = parseTurnsFromText(text);
  const session: SessionUsage = {
    id: meta.id ?? path.basename(sessDir),
    title: meta.title?.trim() || meta.id || path.basename(sessDir),
    dir: sessDir,
    workspace: wsPaths[0],
    modelId: meta.modelId,
    agentMode: meta.agentMode,
    createdAt: meta.createdAt ?? "",
    lastModifiedAt: meta.lastModifiedAt ?? meta.createdAt ?? "",
    totalCredits: turns.reduce((sum, tn) => sum + tn.credits, 0),
    latestContextPercent,
    turns,
  };
  if (key) {
    sessionCache.set(sessDir, { statKey: key, session });
  }
  return session;
}

/* ----------------------------- CLI parsing ------------------------------- */

interface CliMeteringEntry {
  value?: number;
  unit?: string;
}

interface CliTurnMeta {
  metering_usage?: CliMeteringEntry[];
  turn_duration?: { secs?: number; nanos?: number };
  end_timestamp?: string;
  end_reason?: string;
  context_usage_percentage?: number;
  final_context_usage_percentage?: number;
  builtin_tool_uses?: Record<string, number>;
  model?: string;
}

interface CliSessionFile {
  session_id?: string;
  cwd?: string;
  created_at?: string;
  updated_at?: string;
  title?: string;
  session_state?: {
    conversation_metadata?: {
      user_turn_metadatas?: CliTurnMeta[];
      last_context_usage?: { percentage?: number; model_id?: string };
    };
  };
}

/** Extract user-prompt snippets from CLI .jsonl text, in turn order.
 *  Each `Prompt` record is one user turn. */
function parseCliPromptsFromText(raw: string): string[] {
  const prompts: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let rec: { kind?: string; data?: { content?: unknown } };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
    }
    if (rec.kind !== "Prompt") {
      continue;
    }
    const content = rec.data?.content;
    let text = "";
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as { kind?: string; data?: unknown };
        if (b && b.kind === "text" && typeof b.data === "string") {
          text += b.data + " ";
        }
      }
    }
    prompts.push(snippet(text));
  }
  return prompts;
}

function buildCliSession(
  base: string,
  meta: CliSessionFile,
  prompts: string[],
): SessionUsage {
  const cm = meta.session_state?.conversation_metadata;
  const turnMetas = cm?.user_turn_metadatas ?? [];
  const turns: TurnUsage[] = [];
  let latestContextPercent = cm?.last_context_usage?.percentage;
  let modelId: string | undefined;

  turnMetas.forEach((tm, i) => {
    let credits = 0;
    let unit = "credit";
    for (const m of tm.metering_usage ?? []) {
      if (typeof m.value === "number") {
        credits += m.value;
      }
      if (m.unit) {
        unit = m.unit;
      }
    }
    const durSecs = tm.turn_duration?.secs ?? 0;
    const durNanos = tm.turn_duration?.nanos ?? 0;
    const ctx = tm.final_context_usage_percentage ?? tm.context_usage_percentage;
    if (typeof ctx === "number") {
      latestContextPercent = ctx;
    }
    if (tm.model) {
      modelId = tm.model;
    }
    const endedAt = tm.end_timestamp ?? "";
    turns.push({
      index: i + 1,
      startedAt: endedAt, // CLI has no per-turn start; end is the correlator
      endedAt,
      credits,
      unit,
      elapsedMs: Math.round(durSecs * 1000 + durNanos / 1e6),
      status:
        tm.end_reason === "UserTurnEnd" ? "success" : tm.end_reason ?? "success",
      tools: tm.builtin_tool_uses ? Object.keys(tm.builtin_tool_uses) : [],
      contextPercent: ctx,
      prompt: prompts[i],
      complete: true,
    });
  });

  return {
    id: meta.session_id ?? path.basename(base),
    title: meta.title?.trim() || meta.session_id || path.basename(base),
    dir: base + ".json",
    workspace: meta.cwd,
    modelId: modelId ?? cm?.last_context_usage?.model_id,
    agentMode: "cli",
    createdAt: meta.created_at ?? "",
    lastModifiedAt: meta.updated_at ?? meta.created_at ?? "",
    totalCredits: turns.reduce((sum, tn) => sum + tn.credits, 0),
    latestContextPercent,
    turns,
  };
}

/** Load one CLI session (base path without extension), using the parse cache. */
async function loadCliSession(
  base: string,
  root: string | undefined,
): Promise<SessionUsage | undefined> {
  const meta = await readJsonAsync<CliSessionFile>(base + ".json");
  if (!meta || !meta.cwd) {
    return undefined;
  }
  if (root && !pathsOverlap(meta.cwd, root)) {
    return undefined;
  }
  // Credits live in the .json; use it as the freshness key.
  const key = await statKey(base + ".json");
  const cached = sessionCache.get(base);
  if (cached && key && cached.statKey === key) {
    return cached.session;
  }
  const promptsText = (await readFileAsync(base + ".jsonl")) ?? "";
  const session = buildCliSession(base, meta, parseCliPromptsFromText(promptsText));
  if (key) {
    sessionCache.set(base, { statKey: key, session });
  }
  return session;
}

/* ------------------------------- scanning -------------------------------- */

/** Scan the sessions store (both formats) and return sessions, newest-first.
 *  `root` filters to a workspace; undefined scans everything (global scope).
 *  Async + concurrency-limited; unchanged sessions come from the parse cache. */
async function scanSessions(root: string | undefined): Promise<SessionUsage[]> {
  const store = sessionsRoot();
  const jobs: { kind: "ide" | "cli"; p: string }[] = [];

  for (const entry of await readdirAsync(store)) {
    if (entry.startsWith(".")) {
      continue;
    }
    const entryPath = path.join(store, entry);
    if (!(await isDir(entryPath))) {
      continue;
    }
    if (entry === "cli") {
      const bases = new Set<string>();
      for (const file of await readdirAsync(entryPath)) {
        if (file.endsWith(".json")) {
          bases.add(file.slice(0, -".json".length));
        }
      }
      for (const b of bases) {
        jobs.push({ kind: "cli", p: path.join(entryPath, b) });
      }
    } else {
      for (const sess of await readdirAsync(entryPath)) {
        if (sess.startsWith("sess_")) {
          jobs.push({ kind: "ide", p: path.join(entryPath, sess) });
        }
      }
    }
  }

  const parsed = await mapLimit(jobs, 24, (j) =>
    j.kind === "ide" ? loadIdeSession(j.p, root) : loadCliSession(j.p, root),
  );
  const out = parsed.filter(
    (x): x is SessionUsage => !!x && x.turns.length > 0,
  );
  out.sort((a, b) => b.lastModifiedAt.localeCompare(a.lastModifiedAt));
  return out;
}

/* ---------------------------- stage attribution -------------------------- */

/** One intent's audit activity: its stage events (sorted) and the wall-clock
 *  window they span, for window-containment attribution. */
interface IntentAudit {
  intent: string;
  startMs: number;
  endMs: number;
  events: { tsMs: number; slug: string }[];
}

function safeReaddirSync(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Build per-intent audit windows by scanning every sibling intent under the
 *  same space (…/intents/<intent>/audit). Intents with no stage events are
 *  skipped. Sync — audit is small and runs once per load. */
function intentAudits(recordDir: string): IntentAudit[] {
  const intentsDir = path.dirname(recordDir);
  const names = safeReaddirSync(intentsDir);
  const dirs =
    names.length > 0 ? names.map((n) => path.join(intentsDir, n)) : [recordDir];

  const audits: IntentAudit[] = [];
  for (const dir of dirs) {
    try {
      if (!fs.statSync(dir).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    const events: { tsMs: number; slug: string }[] = [];
    for (const e of readAuditEvents(dir)) {
      if (!e.stage || !e.timestamp) {
        continue;
      }
      const tsMs = Date.parse(e.timestamp);
      if (!Number.isNaN(tsMs)) {
        events.push({ tsMs, slug: e.stage });
      }
    }
    if (events.length === 0) {
      continue;
    }
    events.sort((a, b) => a.tsMs - b.tsMs);
    audits.push({
      intent: path.basename(dir),
      startMs: events[0].tsMs,
      endMs: events[events.length - 1].tsMs,
      events,
    });
  }
  return audits;
}

/** Grace (ms) added to an intent's audit window end. */
const INTENT_GRACE_MS = 2 * 60 * 60 * 1000;

/** Stage active at time `tMs` within a single intent's own timeline (last
 *  stage event at or before it; the first stage before any event). */
function stageWithin(audit: IntentAudit, tMs: number): string {
  let slug = audit.events[0].slug;
  for (const e of audit.events) {
    if (e.tsMs <= tMs) {
      slug = e.slug;
    } else {
      break;
    }
  }
  return slug;
}

/** Attribute a turn (at time `ts`) to the intent whose audit window contains
 *  it (latest-starting window wins on overlap), then to the stage active
 *  within that intent. Undefined when no window contains the turn. */
function stageAt(
  audits: IntentAudit[],
  ts: string,
): { intent: string; slug: string } | undefined {
  const t = Date.parse(ts);
  if (Number.isNaN(t) || audits.length === 0) {
    return undefined;
  }
  let best: IntentAudit | undefined;
  for (const a of audits) {
    if (t >= a.startMs && t <= a.endMs + INTENT_GRACE_MS) {
      if (!best || a.startMs > best.startMs) {
        best = a;
      }
    }
  }
  if (!best) {
    return undefined;
  }
  let slug = best.events[0].slug;
  for (const e of best.events) {
    if (e.tsMs <= t) {
      slug = e.slug;
    } else {
      break;
    }
  }
  return { intent: best.intent, slug };
}

/* -------------------------------- loading -------------------------------- */

function emptyUsage(scope: UsageScope, period: string): WorkspaceUsage {
  return {
    scope,
    sessions: [],
    byStage: new Map(),
    byIntent: new Map(),
    totalCredits: 0,
    turnCount: 0,
    hasStageAttribution: false,
    sessionsRoot: sessionsRoot(),
    period,
    months: [],
  };
}

/** Month bucket ("YYYY-MM") of a turn, from its end (or start) timestamp. */
function turnMonth(turn: TurnUsage): string {
  const ts = turn.endedAt || turn.startedAt;
  return ts.length >= 7 ? ts.slice(0, 7) : "";
}

const bump = (
  map: Map<string, StageUsage>,
  key: string,
  credits: number,
): void => {
  const agg = map.get(key) ?? { credits: 0, turns: 0 };
  agg.credits += credits;
  agg.turns += 1;
  map.set(key, agg);
};

/**
 * Load usage.
 *
 * Two concerns are kept independent:
 *  - The per-stage / per-intent aggregation (`byStage`/`byIntent`) that feeds
 *    the Progress badges + stage-detail card is ALWAYS computed from the active
 *    workspace's sessions and its intent audit — regardless of the view scope.
 *    (So switching the Token Usage view to "global" never blanks the badges.)
 *  - The `sessions` list + totals shown IN the Token Usage view follow the
 *    scope ("workspace" = matched to `root`, "global" = every session grouped
 *    by workspace) and the `period` filter ("" = all time, else "YYYY-MM").
 *
 * Async and cache-backed: only changed session logs are re-parsed.
 */
export async function loadUsage(
  root: string | undefined,
  recordDir: string | undefined,
  scope: UsageScope,
  period = "",
): Promise<WorkspaceUsage> {
  if (scope === "workspace" && !root) {
    return emptyUsage(scope, period);
  }

  // Workspace-matched sessions always drive attribution (progress badges).
  const wsSessions = root ? await scanSessions(root) : [];
  // The view shows either the workspace subset or all sessions (global).
  const viewSessions =
    scope === "global" ? await scanSessions(undefined) : wsSessions;

  const activeIntent = recordDir ? path.basename(recordDir) : undefined;
  const audits = recordDir ? intentAudits(recordDir) : [];
  const inPeriod = (turn: TurnUsage): boolean =>
    !period || turnMonth(turn) === period;

  // --- Progress badges: attribute the active workspace's turns, ALL-TIME and
  // independent of the view scope/period, so the badges stay stable. In
  // workspace scope we also tag the turns for the view's intent/stage grouping. ---
  const byStage = new Map<string, StageUsage>();
  const byIntent = new Map<string, StageUsage>();
  let hasStageAttribution = false;
  // The active intent's own audit window, used to accumulate its per-stage
  // badges inclusively across its whole lifespan (see below).
  const activeAudit = activeIntent
    ? audits.find((a) => a.intent === activeIntent)
    : undefined;
  for (const session of wsSessions) {
    for (const turn of session.turns) {
      const ts = turn.endedAt || turn.startedAt;
      const tMs = Date.parse(ts);
      const attr = audits.length > 0 ? stageAt(audits, ts) : undefined;
      if (scope === "workspace") {
        turn.stageSlug = attr?.slug;
        turn.intentName = attr?.intent;
      }
      if (attr) {
        hasStageAttribution = true;
        bump(byIntent, attr.intent, turn.credits);
      }
      // Per-stage badges (Progress view / stage-detail card): attribute every
      // turn that falls in the ACTIVE intent's lifespan window to that intent's
      // stage-at-time, INCLUSIVELY — even if an overlapping sibling intent's
      // window would otherwise claim it. This keeps the badges accumulating
      // across sessions, so continuing the workflow in a fresh session (e.g.
      // after a context reset) adds to the stage total instead of resetting it.
      // (Trade-off: intents worked in parallel in the same period are approximate.)
      if (
        activeAudit &&
        !Number.isNaN(tMs) &&
        tMs >= activeAudit.startMs &&
        tMs <= activeAudit.endMs + INTENT_GRACE_MS
      ) {
        hasStageAttribution = true;
        bump(byStage, stageWithin(activeAudit, tMs), turn.credits);
      }
    }
  }

  // In global scope the view is a flat per-workspace list, so clear any stale
  // intent/stage tags on the (cache-shared) view turns.
  if (scope === "global") {
    for (const session of viewSessions) {
      for (const turn of session.turns) {
        turn.stageSlug = undefined;
        turn.intentName = undefined;
      }
    }
  }

  // --- View sessions + totals: apply the period filter (turn-level, so a
  // session spanning months is split correctly). Build period-filtered copies
  // so the shared cache is never mutated. ---
  const months = new Set<string>();
  const sessions: SessionUsage[] = [];
  let totalCredits = 0;
  let turnCount = 0;
  for (const session of viewSessions) {
    for (const turn of session.turns) {
      const m = turnMonth(turn);
      if (m) {
        months.add(m);
      }
    }
    const turns = period ? session.turns.filter(inPeriod) : session.turns;
    if (turns.length === 0) {
      continue;
    }
    const view: SessionUsage = period
      ? {
          ...session,
          turns,
          totalCredits: turns.reduce((s, tn) => s + tn.credits, 0),
        }
      : session;
    sessions.push(view);
    totalCredits += view.totalCredits;
    turnCount += turns.length;
  }
  sessions.sort((a, b) => b.lastModifiedAt.localeCompare(a.lastModifiedAt));

  return {
    scope,
    sessions,
    byStage,
    byIntent,
    activeIntent,
    totalCredits,
    turnCount,
    hasStageAttribution,
    sessionsRoot: sessionsRoot(),
    period,
    months: [...months].sort().reverse(),
  };
}

/** Format a credit amount compactly (e.g. 3.93 → "3.9", 128 → "128"). */
export function fmtCredits(credits: number): string {
  if (!Number.isFinite(credits) || credits <= 0) {
    return "0";
  }
  if (credits >= 100) {
    return String(Math.round(credits));
  }
  if (credits >= 10) {
    return credits.toFixed(1);
  }
  return credits.toFixed(2);
}

/**
 * Shared usage store. Mirrors PanelStore: holds the latest WorkspaceUsage and
 * notifies views on refresh. refresh() is async and fire-and-forget with a
 * monotonic sequence guard so a slow scan never blocks the UI thread and a
 * stale result can't overwrite a newer one.
 */
export class UsageStore {
  private _usage: WorkspaceUsage | undefined;
  private _seq = 0;
  private readonly _emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this._emitter.event;

  constructor(
    private _root: string | undefined,
    private _recordDir: string | undefined,
    private _scope: UsageScope = "workspace",
    private _period = "",
    private _enabled = true,
  ) {}

  /** Whether usage tracking is on. When off, no session scanning happens and
   *  all usage surfaces (view, progress badges, stage card) go blank — a way to
   *  fully disable the feature and its background work. */
  get enabled(): boolean {
    return this._enabled;
  }

  /** Turn tracking on/off. Enabling triggers a reload; disabling clears the
   *  cached result and skips all scanning. */
  setEnabled(enabled: boolean): void {
    if (enabled === this._enabled) {
      return;
    }
    this._enabled = enabled;
    if (enabled) {
      this.refresh();
    } else {
      this._usage = undefined;
      this._emitter.fire();
    }
  }

  get usage(): WorkspaceUsage | undefined {
    return this._usage;
  }

  get root(): string | undefined {
    return this._root;
  }

  get scope(): UsageScope {
    return this._scope;
  }

  get period(): string {
    return this._period;
  }

  /** Retarget at a different workspace root. Store-only; caller drives refresh. */
  setRoot(root: string | undefined): void {
    this._root = root;
  }

  /** Update the active intent record dir. Store-only; caller drives refresh. */
  setRecordDir(recordDir: string | undefined): void {
    this._recordDir = recordDir;
  }

  /** Switch between workspace and global scope; reloads on a real change. */
  setScope(scope: UsageScope): void {
    if (scope === this._scope) {
      return;
    }
    this._scope = scope;
    this.refresh();
  }

  /** Set the period filter ("" = all time, else "YYYY-MM"); reloads on change. */
  setPeriod(period: string): void {
    if (period === this._period) {
      return;
    }
    this._period = period;
    this.refresh();
  }

  refresh(): void {
    if (!this._enabled) {
      this._usage = undefined;
      this._emitter.fire();
      return;
    }
    const seq = ++this._seq;
    void loadUsage(this._root, this._recordDir, this._scope, this._period).then((usage) => {
      if (seq !== this._seq) {
        return; // a newer refresh superseded this one
      }
      this._usage = usage;
      this._emitter.fire();
    });
  }

  /** Aggregated credits for one stage (active-intent scoped), or undefined. */
  stageUsage(slug: string): StageUsage | undefined {
    return this._usage?.byStage.get(slug);
  }

  /** Aggregated credits for one intent, or undefined when not attributed. */
  intentUsage(intent: string): StageUsage | undefined {
    return this._usage?.byIntent.get(intent);
  }

  /** Cumulative credits + turns for the ACTIVE intent across its whole
   *  lifespan (sum of its per-stage badges). This is stable across sessions —
   *  resuming the workflow in a new session keeps adding to it — so it never
   *  "resets" the way a single stage's badge appears to when the workflow moves
   *  to a new stage. Returns undefined when there is no attributed usage. */
  activeIntentTotal(): StageUsage | undefined {
    const byStage = this._usage?.byStage;
    if (!byStage || byStage.size === 0) {
      return undefined;
    }
    let credits = 0;
    let turns = 0;
    for (const agg of byStage.values()) {
      credits += agg.credits;
      turns += agg.turns;
    }
    return { credits, turns };
  }
}
