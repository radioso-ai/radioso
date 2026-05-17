import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { ActivityStage, ActivityTrace, SkillDefinition, UsageLimitDatabasePort } from "../radiosoModuleTypes.js";

export type SkillSubmissionStatus = "pending" | "delivering" | "delivered" | "failed";

export interface SkillSubmissionRow {
  id: string;
  account_id: string | null;
  workspace_id: string;
  conversation_id: string;
  assistant_message_id: string | null;
  skill_name: string;
  source_channel: string | null;
  source_origin: string | null;
  trigger_source: string;
  trigger_reason: string | null;
  idempotency_key: string | null;
  fields: Record<string, unknown>;
  subject_identity: string | null;
  status: SkillSubmissionStatus;
  attempts: number;
  next_retry_at: Date;
  final_delivery_error: string | null;
  activity_trace: ActivityTrace | null;
  created_at: Date;
  updated_at: Date;
}

export interface SkillSubmissionListRow extends SkillSubmissionRow {
  total_count?: string;
}

export interface SkillSubmissionInsert {
  id: string;
  accountId?: string | null;
  workspaceId: string;
  conversationId: string;
  assistantMessageId?: string | null;
  skillName: string;
  sourceChannel?: string | null;
  sourceOrigin?: string | null;
  triggerSource: string;
  triggerReason?: string | null;
  idempotencyKey?: string | null;
  fields: Record<string, unknown>;
  subjectIdentity?: string | null;
  activityTrace: ActivityTrace | null;
}

export type SkillSubmissionFieldValidation = "strict" | "passthrough";

export interface SkillSubmissionRepositoryLogger {
  error?(entry: unknown, message?: string): void;
}

export interface SkillSubmissionInvalidClaim {
  row: SkillSubmissionRow;
  reason: string;
  activityTrace: ActivityTrace;
  error: unknown;
}

export interface SkillSubmissionRepositoryOptions {
  logger?: SkillSubmissionRepositoryLogger;
  onInvalidClaim?(input: SkillSubmissionInvalidClaim): Promise<void> | void;
}

const MAX_FAILURE_REASON_LENGTH = 1000;
const INVALID_FIELDS_STAGE_ID = "stored_field_validation";

const FULL_COLUMNS = `
  id::text,
  account_id::text,
  workspace_id::text,
  conversation_id::text,
  assistant_message_id::text,
  skill_name,
  source_channel,
  source_origin,
  trigger_source,
  trigger_reason,
  idempotency_key,
  fields,
  subject_identity,
  status,
  attempts,
  next_retry_at,
  final_delivery_error,
  activity_trace,
  created_at,
  updated_at
`;

const queryRows = async <T>(
  database: UsageLimitDatabasePort,
  text: string,
  params: unknown[],
): Promise<T[]> => {
  const result = await database.query<T>(text, params);
  return Array.isArray(result) ? result : result.rows;
};

const parseJsonField = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
};

const fieldSchemaFor = (field: NonNullable<SkillDefinition["intake"]>["fields"][number]): z.ZodTypeAny => {
  let schema: z.ZodTypeAny;
  switch (field.type) {
    case "email":
      schema = z.string().trim().email();
      break;
    case "number":
      schema = z.number();
      break;
    case "enum":
      schema = field.enumValues?.length
        ? z.enum(field.enumValues as [string, ...string[]])
        : z.string();
      break;
    case "phone":
    case "date":
    case "string":
      schema = z.string();
      break;
  }
  const stringLikeField = field.type === "string" ||
    field.type === "email" ||
    field.type === "phone" ||
    field.type === "date";
  if (stringLikeField && field.maxLength) {
    schema = (schema as z.ZodString).max(field.maxLength);
  }
  if (field.pattern && stringLikeField && field.type !== "email") {
    schema = (schema as z.ZodString).regex(new RegExp(field.pattern));
  }
  return field.required ? schema : schema.optional();
};

const buildFieldsSchema = (definition: SkillDefinition): z.ZodObject<Record<string, z.ZodTypeAny>> | null => {
  if (!definition.intake) {
    return null;
  }
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of definition.intake.fields) {
    shape[field.name] = fieldSchemaFor(field);
  }
  return z.object(shape).passthrough();
};

const buildInvalidFieldsTrace = (row: SkillSubmissionRow, reason: string): ActivityTrace => {
  const now = new Date().toISOString();
  const existingTrace = row.activity_trace;
  const traceId = existingTrace?.traceId ?? randomUUID();
  const startedAt = existingTrace?.startedAt ?? now;
  const stage: ActivityStage = {
    stageId: INVALID_FIELDS_STAGE_ID,
    kind: "validation",
    label: "Stored field validation",
    status: "failed",
    startedAt: now,
    reason,
    outputs: {
      status: "failed",
      finalDeliveryError: reason,
    },
    metrics: {
      attempt: row.attempts + 1,
    },
  };
  const existingStages = existingTrace?.stages ?? [];
  const existingStageIndex = existingStages.findIndex((candidate) => candidate.stageId === INVALID_FIELDS_STAGE_ID);
  const stages = existingStageIndex >= 0
    ? existingStages.map((candidate) => candidate.stageId === INVALID_FIELDS_STAGE_ID ? stage : candidate)
    : [...existingStages, stage];
  const links = existingTrace?.links ? [...existingTrace.links] : [];
  if (existingStageIndex < 0 && existingStages.length > 0) {
    const previousStage = existingStages[existingStages.length - 1];
    links.push({
      fromStageId: previousStage.stageId,
      toStageId: INVALID_FIELDS_STAGE_ID,
      kind: "sequence",
    });
  }
  return {
    traceId,
    startedAt,
    completedAt: now,
    totalDurationMs: Math.max(0, Date.parse(now) - Date.parse(startedAt)),
    stages,
    links,
    summary: {
      ...(existingTrace?.summary ?? {}),
      traceId,
      skillName: row.skill_name,
      status: "failed",
      outcome: "stored_fields_validation_failed",
    },
  };
};

export class SkillSubmissionRepository {
  private readonly fieldSchemas = new Map<string, z.ZodObject<Record<string, z.ZodTypeAny>>>();

  constructor(
    private readonly database: UsageLimitDatabasePort,
    definitions: SkillDefinition[] = [],
    private readonly options: SkillSubmissionRepositoryOptions = {},
  ) {
    for (const definition of definitions) {
      const schema = buildFieldsSchema(definition);
      if (schema) {
        this.fieldSchemas.set(definition.name, schema);
      }
    }
  }

  private normalizeRow<T extends SkillSubmissionRow>(
    row: T,
    fieldValidation: SkillSubmissionFieldValidation = "strict",
  ): T {
    const fields = parseJsonField(row.fields);
    const schema = this.fieldSchemas.get(row.skill_name);
    return {
      ...row,
      fields: schema && fieldValidation === "strict" ? schema.parse(fields) : fields,
    };
  }

  async insert(input: SkillSubmissionInsert): Promise<SkillSubmissionRow | null> {
    const rows = await queryRows<SkillSubmissionRow>(
      this.database,
      `INSERT INTO skill_submissions (
         id, account_id, workspace_id, conversation_id, assistant_message_id,
         skill_name, source_channel, source_origin, trigger_source, trigger_reason,
         idempotency_key, fields, subject_identity, status, next_retry_at, activity_trace
       )
       VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9, $10,
         $11, $12::jsonb, $13, 'pending', NOW(), $14::jsonb
       )
       ON CONFLICT (workspace_id, skill_name, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO NOTHING
       RETURNING ${FULL_COLUMNS}`,
      [
        input.id,
        input.accountId ?? null,
        input.workspaceId,
        input.conversationId,
        input.assistantMessageId ?? null,
        input.skillName,
        input.sourceChannel ?? null,
        input.sourceOrigin ?? null,
        input.triggerSource,
        input.triggerReason ?? null,
        input.idempotencyKey ?? null,
        JSON.stringify(input.fields),
        input.subjectIdentity ?? null,
        input.activityTrace,
      ],
    );
    return rows[0] ? this.normalizeRow(rows[0]) : null;
  }

  async findByIdempotencyKey(
    workspaceId: string,
    skillName: string,
    idempotencyKey: string,
    input: { fieldValidation?: SkillSubmissionFieldValidation } = {},
  ): Promise<SkillSubmissionRow | null> {
    const [row] = await queryRows<SkillSubmissionRow>(
      this.database,
      `SELECT ${FULL_COLUMNS}
       FROM skill_submissions
       WHERE workspace_id = $1
         AND skill_name = $2
         AND idempotency_key = $3
       LIMIT 1`,
      [workspaceId, skillName, idempotencyKey],
    );
    return row ? this.normalizeRow(row, input.fieldValidation) : null;
  }

  async claimDueDeliveries(input: {
    maxAttempts: number;
    limit: number;
    skillName?: string;
  }): Promise<SkillSubmissionRow[]> {
    const rows = await queryRows<SkillSubmissionRow>(
      this.database,
      `UPDATE skill_submissions
       SET status = 'delivering',
           updated_at = NOW()
       WHERE id IN (
         SELECT id
         FROM skill_submissions
         WHERE status = 'pending'
           AND next_retry_at <= NOW()
           AND attempts < $1
           AND ($3::text IS NULL OR skill_name = $3)
         ORDER BY next_retry_at ASC, created_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${FULL_COLUMNS}`,
      [input.maxAttempts, input.limit, input.skillName ?? null],
    );
    return this.normalizeClaimedRows(rows);
  }

  async markDelivered(id: string, activityTrace: ActivityTrace | null): Promise<void> {
    await queryRows(
      this.database,
      `UPDATE skill_submissions
       SET status = 'delivered',
           attempts = attempts + 1,
           final_delivery_error = NULL,
           activity_trace = COALESCE($2::jsonb, activity_trace),
           updated_at = NOW()
       WHERE id = $1`,
      [id, activityTrace],
    );
  }

  private async normalizeClaimedRows(rows: SkillSubmissionRow[]): Promise<SkillSubmissionRow[]> {
    const validRows: SkillSubmissionRow[] = [];
    for (const row of rows) {
      try {
        validRows.push(this.normalizeRow(row));
      } catch (error) {
        await this.recordInvalidClaim(row, error);
      }
    }
    return validRows;
  }

  private truncateFailureReason(reason: string): string {
    return reason.slice(0, MAX_FAILURE_REASON_LENGTH);
  }

  private async recordInvalidClaim(row: SkillSubmissionRow, error: unknown): Promise<void> {
    const reason = error instanceof Error
      ? `Stored skill submission fields failed validation: ${error.message}`
      : "Stored skill submission fields failed validation.";
    const truncatedReason = this.truncateFailureReason(reason);
    const activityTrace = buildInvalidFieldsTrace(row, truncatedReason);
    this.options.logger?.error?.(
      {
        submissionId: row.id,
        workspaceId: row.workspace_id,
        skillName: row.skill_name,
        attempts: row.attempts + 1,
        err: error instanceof Error ? error.message : String(error),
      },
      "Stored skill submission fields failed validation during delivery claim",
    );
    await queryRows(
      this.database,
      `UPDATE skill_submissions
       SET status = 'failed',
           attempts = attempts + 1,
           final_delivery_error = $2,
           activity_trace = COALESCE($3::jsonb, activity_trace),
           updated_at = NOW()
       WHERE id = $1`,
      [row.id, truncatedReason, activityTrace],
    );
    try {
      await this.options.onInvalidClaim?.({
        row,
        reason: truncatedReason,
        activityTrace,
        error,
      });
    } catch (hookError) {
      this.options.logger?.error?.(
        {
          submissionId: row.id,
          workspaceId: row.workspace_id,
          skillName: row.skill_name,
          err: hookError instanceof Error ? hookError.message : String(hookError),
        },
        "Stored skill submission invalid-claim hook failed",
      );
    }
  }

  async recordFailure(input: {
    id: string;
    nextStatus: "pending" | "failed";
    nextRetryDelaySeconds: number;
    reason: string;
    activityTrace: ActivityTrace | null;
  }): Promise<void> {
    await queryRows(
      this.database,
      `UPDATE skill_submissions
       SET status = $2,
           attempts = attempts + 1,
           next_retry_at = CASE WHEN $2 = 'pending' THEN NOW() + ($3::text || ' seconds')::interval ELSE next_retry_at END,
           final_delivery_error = $4,
           activity_trace = COALESCE($5::jsonb, activity_trace),
           updated_at = NOW()
       WHERE id = $1`,
      [
        input.id,
        input.nextStatus,
        input.nextRetryDelaySeconds,
        this.truncateFailureReason(input.reason),
        input.activityTrace,
      ],
    );
  }

  async findById(
    workspaceId: string,
    id: string,
    input: { fieldValidation?: SkillSubmissionFieldValidation } = {},
  ): Promise<SkillSubmissionRow | null> {
    const [row] = await queryRows<SkillSubmissionRow>(
      this.database,
      `SELECT ${FULL_COLUMNS}
       FROM skill_submissions
       WHERE workspace_id = $1
         AND id = $2
       LIMIT 1`,
      [workspaceId, id],
    );
    return row ? this.normalizeRow(row, input.fieldValidation) : null;
  }

  async listByWorkspace(input: {
    workspaceId: string;
    skillName?: string;
    limit: number;
    offset: number;
    fieldValidation?: SkillSubmissionFieldValidation;
  }): Promise<{ rows: SkillSubmissionRow[]; total: number }> {
    const rows = await queryRows<SkillSubmissionListRow>(
      this.database,
      `SELECT
         COUNT(*) OVER()::text AS total_count,
         ${FULL_COLUMNS}
       FROM skill_submissions
       WHERE workspace_id = $1
         AND ($2::text IS NULL OR skill_name = $2)
       ORDER BY created_at DESC, id DESC
       LIMIT $3
       OFFSET $4`,
      [input.workspaceId, input.skillName ?? null, input.limit, input.offset],
    );
    const total = Number(rows[0]?.total_count ?? "0");
    return {
      rows: rows.map((row) => this.normalizeRow(row, input.fieldValidation)),
      total,
    };
  }
}
