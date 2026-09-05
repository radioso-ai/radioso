import { randomUUID } from "node:crypto";

import type {
  AudiencePulsePromptEvidenceReference,
  AudiencePulseSnapshotRecord,
  AudiencePulseSnapshotStore,
} from "../../modules/audiencePulse/contracts.js";
import type { AudiencePulseStoredReport } from "../../modules/audiencePulse/domain/report.js";
import { currentTimestamp, toSanitizedJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface AudiencePulseSnapshotRow {
  workspace_id: string;
  revision: string;
  period_start: Date;
  period_end: Date;
  generated_at: Date;
  report: unknown;
  prompt_evidence_refs: unknown;
  created_at: Date;
  updated_at: Date;
}

const audiencePulseSnapshotColumns = [
  "workspace_id",
  "revision",
  "period_start",
  "period_end",
  "generated_at",
  "report",
  "prompt_evidence_refs",
  "created_at",
  "updated_at",
] as const;

const isPromptEvidenceReference = (value: unknown): value is AudiencePulsePromptEvidenceReference =>
  Boolean(
    value
      && typeof value === "object"
      && typeof (value as Record<string, unknown>).evidenceId === "string"
      && typeof (value as Record<string, unknown>).messageId === "string"
      && typeof (value as Record<string, unknown>).conversationId === "string",
  );

const parseSnapshotJson = (row: AudiencePulseSnapshotRow): {
  report: AudiencePulseStoredReport;
  promptEvidenceRefs: AudiencePulsePromptEvidenceReference[];
} => {
  if (!row.report || typeof row.report !== "object" || Array.isArray(row.report)) {
    throw new Error("Audience Pulse snapshot report is invalid");
  }
  if (!Array.isArray(row.prompt_evidence_refs) || !row.prompt_evidence_refs.every(isPromptEvidenceReference)) {
    throw new Error("Audience Pulse snapshot evidence references are invalid");
  }
  // The only writer is the validated Audience Pulse domain service. The lightweight
  // row guard above protects the database boundary from malformed JSONB rows.
  return {
    report: row.report as AudiencePulseStoredReport,
    promptEvidenceRefs: row.prompt_evidence_refs,
  };
};

const mapSnapshot = (row: AudiencePulseSnapshotRow): AudiencePulseSnapshotRecord => {
  const json = parseSnapshotJson(row);
  return {
    workspaceId: row.workspace_id,
    revision: row.revision,
    period: { start: new Date(row.period_start), end: new Date(row.period_end) },
    generatedAt: new Date(row.generated_at),
    report: json.report,
    promptEvidenceRefs: json.promptEvidenceRefs,
  };
};

/** Postgres adapter for the one current workspace snapshot. */
export class AudiencePulseSnapshotRepository implements AudiencePulseSnapshotStore {
  constructor(private readonly db: Db) {}

  async find(workspaceId: string): Promise<AudiencePulseSnapshotRecord | null> {
    const row = await this.db
      .selectFrom("audience_pulse_snapshots")
      .select(audiencePulseSnapshotColumns)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return row ? mapSnapshot(row) : null;
  }

  async replace(input: Omit<AudiencePulseSnapshotRecord, "revision">): Promise<AudiencePulseSnapshotRecord> {
    const revision = randomUUID();
    const row = await this.db
      .insertInto("audience_pulse_snapshots")
      .values({
        workspace_id: input.workspaceId,
        revision,
        period_start: input.period.start,
        period_end: input.period.end,
        generated_at: input.generatedAt,
        report: toSanitizedJsonb(input.report),
        prompt_evidence_refs: toSanitizedJsonb(input.promptEvidenceRefs),
      })
      .onConflict((oc) =>
        oc.column("workspace_id").doUpdateSet((eb) => ({
          revision: eb.ref("excluded.revision"),
          period_start: eb.ref("excluded.period_start"),
          period_end: eb.ref("excluded.period_end"),
          generated_at: eb.ref("excluded.generated_at"),
          report: eb.ref("excluded.report"),
          prompt_evidence_refs: eb.ref("excluded.prompt_evidence_refs"),
          updated_at: currentTimestamp(),
        })),
      )
      .returning(audiencePulseSnapshotColumns)
      .executeTakeFirstOrThrow();
    return mapSnapshot(row);
  }

  async invalidate(input: { workspaceId: string; expectedRevision: string }): Promise<boolean> {
    const result = await this.db
      .deleteFrom("audience_pulse_snapshots")
      .where("workspace_id", "=", input.workspaceId)
      .where("revision", "=", input.expectedRevision)
      .executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }
}
