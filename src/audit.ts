import * as fs from "fs";
import * as path from "path";

export interface AuditEvent {
  event: string;
  timestamp: string;
  stage?: string;
  fields: Record<string, string>;
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Parse one audit shard (markdown blocks split by `---`) into events. */
function parseShard(text: string): AuditEvent[] {
  const out: AuditEvent[] = [];
  for (const block of text.split(/\n---\s*\n/)) {
    const fields: Record<string, string> = {};
    for (const line of block.split(/\r?\n/)) {
      const m = line.match(/^\*\*([^*]+)\*\*:\s*(.*)$/);
      if (m) {
        fields[m[1].trim()] = m[2].trim();
      }
    }
    if (!fields.Event) {
      continue;
    }
    out.push({
      event: fields.Event,
      timestamp: fields.Timestamp ?? "",
      stage: fields.Stage,
      fields,
    });
  }
  return out;
}

/** All audit events across every shard in `<record>/audit`, oldest first.
 *  De-duplicated: the same event can appear in more than one per-clone shard. */
export function readAuditEvents(recordDir: string): AuditEvent[] {
  const auditDir = path.join(recordDir, "audit");
  const events: AuditEvent[] = [];
  for (const name of safeReaddir(auditDir)) {
    if (!name.endsWith(".md")) {
      continue;
    }
    try {
      events.push(...parseShard(fs.readFileSync(path.join(auditDir, name), "utf8")));
    } catch {
      /* skip unreadable shard */
    }
  }
  const seen = new Set<string>();
  const unique = events.filter((e) => {
    const key = `${e.timestamp}|${e.event}|${e.stage ?? ""}|${e.fields.Message ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return unique;
}

/** Events tied to one stage (by the `Stage` field), oldest first. */
export function readStageEvents(recordDir: string, stageSlug: string): AuditEvent[] {
  return readAuditEvents(recordDir).filter((e) => e.stage === stageSlug);
}
