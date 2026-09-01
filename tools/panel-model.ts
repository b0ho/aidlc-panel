#!/usr/bin/env bun
/**
 * panel-model — ADDON, read-only.
 *
 * Emits the full JSON model consumed by the AI-DLC Kiro panel extension.
 * This is an addon overlay tool: it imports the engine library for state
 * parsing but never writes engine state and never modifies any shipped engine
 * file. If the engine's file formats change, only this one file needs to track
 * them — the VS Code extension stays decoupled.
 *
 * Usage:
 *   bun .kiro/tools/panel-model.ts --json [--project-dir <dir>]
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  activeIntent,
  activeSpace,
  getField,
  listIntents,
  loadStageGraph,
  parseCheckboxes,
  recordDir,
  resolveProjectDir,
  type StageEntry,
} from "./aidlc-lib.ts";

// Korean stage descriptions for tooltips. Static domain text (mirrors the
// shipped dashboard's copy); kept here so the extension needs no engine import.
const STAGE_PURPOSES: Record<string, string> = {
  "workspace-scaffold": "Intent별 기록, 산출물, 검증 디렉터리를 준비합니다.",
  "workspace-detection": "기존 코드와 기술 환경을 탐지해 신규/변경 여부를 판별합니다.",
  "state-init": "Scope와 실행 Stage를 확정하고 추적 가능한 워크플로 상태를 생성합니다.",
  "intent-capture": "해결할 문제, 목표, 성공 기준과 이해관계자를 명확히 합니다.",
  "market-research": "시장·대안·경쟁 환경을 조사해 제품 판단의 근거를 만듭니다.",
  feasibility: "기술·사업·운영 제약과 위험을 검토해 실행 가능성을 평가합니다.",
  "scope-definition": "포함/제외 Scope와 Intent 백로그를 확정합니다.",
  "team-formation": "필요 역량과 협업팀 구성을 정하고 역할 공백을 확인합니다.",
  "rough-mockups": "핵심 사용자 흐름과 화면 구조를 빠르게 시각화합니다.",
  "approval-handoff": "Ideation 결과를 검증하고 Inception 진입 승인을 받습니다.",
  "reverse-engineering": "기존 시스템의 구조, 동작과 변경 영향을 분석합니다.",
  "practices-discovery": "브랜치, 테스트, 리뷰, 배포 등 팀의 작업 방식을 확인합니다.",
  "requirements-analysis": "기능·비기능 요구사항, 제약, 가정과 제외 Scope를 정리합니다.",
  "user-stories": "요구사항을 사용자 가치와 검증 가능한 인수 기준으로 전환합니다.",
  "refined-mockups": "상세 상호작용과 접근성을 구체화합니다.",
  "application-design": "컴포넌트, 서비스, 인터페이스와 주요 아키텍처 결정을 설계합니다.",
  "units-generation": "시스템을 Unit of Work로 분해하고 의존성 DAG를 만듭니다.",
  "delivery-planning": "Unit of Work를 Bolt로 묶고 순서·위험·의존성을 정합니다.",
  "functional-design": "도메인 모델, 규칙, 로직과 화면 컴포넌트를 상세 설계합니다.",
  "nfr-requirements": "보안·성능·신뢰성·확장성 목표를 정량화합니다.",
  "nfr-design": "비기능 요구사항을 만족할 구조와 전략을 설계합니다.",
  "infrastructure-design": "실행 환경, 네트워크, 데이터, IaC와 배포 토폴로지를 설계합니다.",
  "code-generation": "승인된 설계를 실제 애플리케이션 코드와 테스트로 구현합니다.",
  "build-and-test": "빌드와 테스트를 실행해 수렴 여부와 품질을 검증합니다.",
  "ci-pipeline": "자동 빌드·테스트·품질 검증 파이프라인을 구성합니다.",
  "deployment-pipeline": "승격, 승인, 롤백을 포함한 배포 자동화 경로를 준비합니다.",
  "environment-provisioning": "애플리케이션 실행 환경과 리소스를 프로비저닝합니다.",
  "deployment-execution": "승인된 릴리스를 대상 환경에 배포하고 결과를 확인합니다.",
  "observability-setup": "로그, 메트릭, 트레이싱, 대시보드와 알림을 구성합니다.",
  "incident-response": "장애 등급, 대응 절차, 책임과 복구 방식을 준비합니다.",
  "performance-validation": "실제 부하 조건에서 성능 목표 충족 여부를 검증합니다.",
  "feedback-optimization": "운영 신호와 사용자 피드백을 다음 개선 사이클로 연결합니다.",
};

// English stage descriptions (the base language). Selected when --lang is not
// "ko"; mirrors the STAGE_PURPOSES map above key-for-key.
const STAGE_PURPOSES_EN: Record<string, string> = {
  "workspace-scaffold": "Prepare the per-intent record, artifact, and verification directories.",
  "workspace-detection": "Detect existing code and the tech stack to determine new vs. changed work.",
  "state-init": "Confirm the scope and stages to run, and create trackable workflow state.",
  "intent-capture": "Clarify the problem to solve, goals, success criteria, and stakeholders.",
  "market-research": "Research the market, alternatives, and competition to ground product decisions.",
  feasibility: "Assess technical, business, and operational constraints and risks.",
  "scope-definition": "Finalize the in/out scope and the intent backlog.",
  "team-formation": "Decide required skills and team composition, and check for role gaps.",
  "rough-mockups": "Quickly visualize core user flows and screen structure.",
  "approval-handoff": "Validate the Ideation results and get approval to enter Inception.",
  "reverse-engineering": "Analyze the existing system's structure, behavior, and change impact.",
  "practices-discovery": "Confirm the team's ways of working: branching, testing, review, deployment.",
  "requirements-analysis": "Organize functional/non-functional requirements, constraints, assumptions, and exclusions.",
  "user-stories": "Turn requirements into user value and verifiable acceptance criteria.",
  "refined-mockups": "Detail interactions and accessibility.",
  "application-design": "Design components, services, interfaces, and key architectural decisions.",
  "units-generation": "Decompose the system into units of work and build the dependency DAG.",
  "delivery-planning": "Group units of work into Bolts and set their order, risk, and dependencies.",
  "functional-design": "Design the domain model, rules, logic, and screen components in detail.",
  "nfr-requirements": "Quantify security, performance, reliability, and scalability targets.",
  "nfr-design": "Design the structure and strategy to meet non-functional requirements.",
  "infrastructure-design": "Design the runtime environment, network, data, IaC, and deployment topology.",
  "code-generation": "Implement the approved design as real application code and tests.",
  "build-and-test": "Run build and tests to verify convergence and quality.",
  "ci-pipeline": "Set up an automated build/test/quality-check pipeline.",
  "deployment-pipeline": "Prepare the deployment automation path, including promotion, approval, and rollback.",
  "environment-provisioning": "Provision the application runtime environment and resources.",
  "deployment-execution": "Deploy the approved release to the target environment and verify the result.",
  "observability-setup": "Set up logs, metrics, tracing, dashboards, and alerts.",
  "incident-response": "Prepare incident severity, response procedures, ownership, and recovery.",
  "performance-validation": "Verify performance targets under realistic load.",
  "feedback-optimization": "Connect operational signals and user feedback into the next improvement cycle.",
};

const PHASE_LABELS: Record<string, string> = {
  initialization: "Initialization",
  ideation: "Ideation",
  inception: "Inception",
  construction: "Construction",
  operation: "Operation",
};

const PHASE_ORDER = [
  "initialization",
  "ideation",
  "inception",
  "construction",
  "operation",
];

type StageStatus =
  | "completed"
  | "in-progress"
  | "awaiting-approval"
  | "revising"
  | "pending"
  | "skipped";

interface ArtifactModel {
  name: string; // path relative to record dir, posix
  absPath: string; // absolute path
}

interface StageModel {
  slug: string;
  number: string;
  name: string;
  phase: string;
  status: StageStatus;
  purpose: string;
  leadAgent: string;
  supportAgents: string[];
  consumes: string[];
  produces: string[];
  condition: string;
  artifacts: ArtifactModel[];
  // Q&A state: a `*-questions.md` file may sit in the stage dir asking the user
  // to fill in `[Answer]:` markers. openQuestions counts the still-unanswered
  // markers; when > 0 the workflow is effectively waiting on the user.
  openQuestions: number;
  totalQuestions: number;
  questionsFile: string | null; // absolute path, when a questions file exists
}

interface PhaseModel {
  phase: string;
  label: string;
  completed: number;
  total: number;
  percent: number;
  stages: StageModel[];
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// Mirror of the shipped dashboard's artifact resolver: find <phase>/<slug>/*.md
// files whose basename matches the stage's produces[] set, including the
// per-Bolt construction nesting.
function artifactFiles(
  recordPath: string,
  phase: string,
  slug: string,
  produces: string[],
): string[] {
  const allowed = new Set(produces);
  if (allowed.size === 0) return [];
  const candidates = [join(recordPath, phase, slug)];

  if (phase === "construction") {
    const constructionDir = join(recordPath, phase);
    if (existsSync(constructionDir)) {
      for (const entry of readdirSync(constructionDir)) {
        const nested = join(constructionDir, entry, slug);
        if (existsSync(nested)) candidates.push(nested);
      }
    }
  }

  const files = new Set<string>();
  for (const candidate of candidates) {
    if (!existsSync(candidate) || !statSync(candidate).isDirectory()) continue;
    for (const entry of readdirSync(candidate)) {
      const fullPath = join(candidate, entry);
      const artifactName = entry.endsWith(".md") ? entry.slice(0, -3) : "";
      if (statSync(fullPath).isFile() && allowed.has(artifactName)) {
        files.add(fullPath);
      }
    }
  }
  return [...files].sort();
}

function percentOf(completed: number, total: number): number {
  return total === 0 ? 0 : Math.round((completed / total) * 100);
}

// Resolve the on-disk directories that hold a stage's working files, mirroring
// artifactFiles(): the flat <phase>/<slug> dir plus, for construction, any
// per-Bolt <construction>/<bolt>/<slug> nesting.
function stageDirs(recordPath: string, phase: string, slug: string): string[] {
  const dirs = [join(recordPath, phase, slug)];
  if (phase === "construction") {
    const constructionDir = join(recordPath, phase);
    if (existsSync(constructionDir)) {
      for (const entry of readdirSync(constructionDir)) {
        const nested = join(constructionDir, entry, slug);
        if (existsSync(nested)) dirs.push(nested);
      }
    }
  }
  return dirs;
}

// Count questions and still-open (unanswered) ones in a `*-questions.md` Q&A
// file. A question is any `[Answer]:` marker; it is OPEN when no non-empty
// answer text follows the marker — either on the same line or on subsequent
// lines up to the next `[Answer]:`, a `---` rule, or a markdown heading.
function parseQuestions(raw: string): { total: number; open: number } {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let total = 0;
  let open = 0;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^\s*\[Answer\]:\s*(.*)$/);
    if (!marker) continue;
    total++;
    let answered = marker[1].trim().length > 0;
    for (let j = i + 1; !answered && j < lines.length; j++) {
      const line = lines[j];
      if (/^\s*\[Answer\]:/.test(line)) break;
      if (/^\s*---\s*$/.test(line)) break;
      if (/^\s*#{1,6}\s/.test(line)) break;
      if (line.trim().length > 0) answered = true;
    }
    if (!answered) open++;
  }
  return { total, open };
}

// Scan a stage's dirs for `*-questions.md` Q&A files and aggregate their
// answered/open counts. questionsFile prefers a file that still has open
// questions so the UI links to the one the user needs to act on.
function stageQuestions(
  recordPath: string,
  phase: string,
  slug: string,
): { file: string | null; open: number; total: number } {
  let file: string | null = null;
  let open = 0;
  let total = 0;
  for (const dir of stageDirs(recordPath, phase, slug)) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith("-questions.md")) continue;
      const full = join(dir, entry);
      if (!statSync(full).isFile()) continue;
      const counts = parseQuestions(readFileSync(full, "utf8"));
      total += counts.total;
      open += counts.open;
      if (file === null || counts.open > 0) file = full;
    }
  }
  return { file, open, total };
}

function buildModel(): unknown {
  const projectDir = resolveProjectDir(argValue("--project-dir"));
  const space = activeSpace(projectDir);
  const intentDir = activeIntent(projectDir, space);
  // Display language for the strings this tool emits (stage purposes,
  // next-action phrasing, and user-facing messages). English is the base.
  const ko = argValue("--lang") === "ko";
  const purposes = ko ? STAGE_PURPOSES : STAGE_PURPOSES_EN;

  const intents = listIntents(projectDir, space).map((i) => ({
    dirName: i.dirName,
    slug: i.slug,
    status: i.status,
    scope: i.scope ?? null,
    active: i.active,
  }));

  if (!intentDir) {
    return {
      ok: false,
      reason: "no-active-intent",
      message: ko
        ? "활성 Intent가 없습니다. /aidlc로 워크플로를 시작하세요."
        : "No active intent. Start a workflow with /aidlc.",
      space,
      intents,
    };
  }

  const recordPath = recordDir(projectDir, intentDir, space);
  if (!recordPath || !existsSync(join(recordPath, "aidlc-state.md"))) {
    return {
      ok: false,
      reason: "no-state",
      message: ko
        ? "활성 Intent의 상태 파일을 찾을 수 없습니다."
        : "Could not find the active intent's state file.",
      space,
      intent: intentDir,
      intents,
    };
  }

  const statePath = join(recordPath, "aidlc-state.md");
  const state = readFileSync(statePath, "utf8");
  const checkboxes = new Map(parseCheckboxes(state).map((c) => [c.slug, c]));
  const graph: StageEntry[] = loadStageGraph();

  const stages: StageModel[] = graph
    .filter((entry) => checkboxes.has(entry.slug))
    .map((entry) => {
      const checkbox = checkboxes.get(entry.slug)!;
      const status: StageStatus = checkbox.suffix.startsWith("SKIP")
        ? "skipped"
        : (checkbox.state as StageStatus);
      const artifacts = artifactFiles(
        recordPath,
        entry.phase,
        entry.slug,
        entry.produces ?? [],
      ).map((filePath) => ({
        name: relative(recordPath, filePath).replaceAll("\\", "/"),
        absPath: filePath,
      }));
      const questions = stageQuestions(recordPath, entry.phase, entry.slug);
      return {
        slug: entry.slug,
        number: entry.number,
        name: entry.name,
        phase: entry.phase,
        status,
        purpose:
          purposes[entry.slug] ??
          entry.condition ??
          (ko
            ? "이 Stage에 정의된 결과를 생성합니다."
            : "Produces the results defined for this stage."),
        leadAgent: entry.lead_agent,
        supportAgents: entry.support_agents ?? [],
        consumes: (entry.consumes ?? []).map((c) =>
          typeof c === "string"
            ? c
            : `${c.artifact}${
                c.required === false ? (ko ? " (선택)" : " (optional)") : ""
              }`,
        ),
        produces: entry.produces ?? [],
        condition: entry.condition ?? "",
        artifacts,
        openQuestions: questions.open,
        totalQuestions: questions.total,
        questionsFile: questions.file,
      };
    });

  const byPhase = new Map<string, StageModel[]>();
  for (const s of stages) {
    if (!byPhase.has(s.phase)) byPhase.set(s.phase, []);
    byPhase.get(s.phase)!.push(s);
  }
  const phases: PhaseModel[] = PHASE_ORDER.filter((p) => byPhase.has(p)).map(
    (phase) => {
      const list = byPhase.get(phase)!;
      const executable = list.filter((s) => s.status !== "skipped");
      const completed = executable.filter(
        (s) => s.status === "completed",
      ).length;
      return {
        phase,
        label: PHASE_LABELS[phase] ?? phase,
        completed,
        total: executable.length,
        percent: percentOf(completed, executable.length),
        stages: list,
      };
    },
  );

  const executable = stages.filter((s) => s.status !== "skipped");
  const completed = executable.filter((s) => s.status === "completed").length;
  const remaining = executable.filter((s) => s.status === "pending").length;

  const currentStageSlug = getField(state, "Current Stage") ?? "";
  const nextStageSlug = getField(state, "Next Stage") ?? "";
  const currentStage = stages.find((s) => s.slug === currentStageSlug);
  const nextAction = currentStage
    ? `${currentStage.name}${
        currentStage.status === "awaiting-approval"
          ? ko
            ? " 승인 여부 결정"
            : " — decide approval"
          : currentStage.status === "revising"
            ? ko
              ? " 수정 사항 반영"
              : " — apply revisions"
            : ko
              ? " 수행"
              : " — execute"
      }`
    : ko
      ? "Workflow 완료 확인"
      : "Confirm workflow completion";

  return {
    ok: true,
    projectDir,
    space,
    intent: intentDir,
    intentSlug: getField(state, "Intent") || intentDir,
    scope: getField(state, "Scope") ?? "",
    lifecyclePhase: (getField(state, "Lifecycle Phase") ?? "").toLowerCase(),
    parked: (getField(state, "Parked") ?? "").trim().length > 0,
    parkedAtStage: getField(state, "Parked At Stage") ?? "",
    currentStage: currentStageSlug,
    nextStage: nextStageSlug,
    nextAction,
    pendingArtifacts: getField(state, "Pending Artifacts") || "none",
    overall: {
      completed,
      total: executable.length,
      remaining,
      percent: percentOf(completed, executable.length),
    },
    phases,
    stages,
    intents,
  };
}

function main(): void {
  try {
    const model = buildModel();
    process.stdout.write(JSON.stringify(model, null, 2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ ok: false, reason: "error", message }));
    process.exitCode = 1;
  }
}

main();
