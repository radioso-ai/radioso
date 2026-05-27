import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";
import { z } from "zod";

import type {
  SkillDefinition,
  SkillExecutorRegistry,
  SkillIntakeField,
} from "../../skills/public.js";
import type { ActivityStage, ActivityStageStatus, ActivitySummary, ActivityTrace } from "../../retrieval/public.js";
import type { ChatIntakeProviderPort, ChatIntakeResult } from "./chatIntakeProvider.js";

type ChatIntakeInput = Parameters<ChatIntakeProviderPort["handle"]>[0];
const DEFAULT_SKILL_INTAKE_TTL_MS = 15 * 60 * 1000;

export interface IntakeState {
  id?: string;
  skillName: string;
  collected: Record<string, unknown>;
  missing: string[];
  status: "active" | "paused" | "completed";
  lastPromptedField: string | null;
}

export interface SkillIntakeStateStore {
  findOpen(input: {
    workspaceId: string;
    conversationId: string;
    skillName: string;
  }): Promise<IntakeState | null>;
  save(input: {
    workspaceId: string;
    conversationId: string;
    state: IntakeState;
  }): Promise<IntakeState>;
}

interface SkillIntakeStateRow extends QueryResultRow {
  id: string;
  skill_name: string;
  status: IntakeState["status"];
  collected: unknown;
  missing: string[];
  expires_at: Date | string | null;
  last_prompted_field: string | null;
}

export interface SkillIntakeStateDatabase {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface SkillIntakeExecutionResult {
  answer: string;
  outputs?: Record<string, unknown>;
}

export interface ConfiguredSkillIntakeAdapter {
  skill: SkillDefinition;
  shouldStart(input: ChatIntakeInput): Promise<boolean>;
  extractFields(input: ChatIntakeInput, state: { collected: Record<string, unknown> | null }): Promise<Record<string, unknown>>;
  composeAnswer(input: {
    kind: "missing" | "invalid";
    skill: SkillDefinition;
    missing: SkillIntakeField[];
    invalid: SkillIntakeField[];
    collected: Record<string, unknown>;
    chat: ChatIntakeInput;
    userExpectedLocale?: string | null;
  }): Promise<string>;
  execute?(input: {
    skill: SkillDefinition;
    collected: Record<string, unknown>;
    chat: ChatIntakeInput;
  }): Promise<SkillIntakeExecutionResult>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export class InMemorySkillIntakeStateStore implements SkillIntakeStateStore {
  private readonly states = new Map<string, IntakeState>();

  async findOpen(input: {
    workspaceId: string;
    conversationId: string;
    skillName: string;
  }): Promise<IntakeState | null> {
    const state = this.states.get(`${input.workspaceId}:${input.conversationId}:${input.skillName}`);
    return state && (state.status === "active" || state.status === "paused") ? { ...state } : null;
  }

  async save(input: {
    workspaceId: string;
    conversationId: string;
    state: IntakeState;
  }): Promise<IntakeState> {
    const state = {
      ...input.state,
      id: input.state.id ?? randomUUID(),
    };
    this.states.set(`${input.workspaceId}:${input.conversationId}:${state.skillName}`, state);
    return { ...state };
  }
}

const normalizeCollected = (value: unknown): Record<string, unknown> =>
  isObject(value) ? value : {};

const scrubSensitiveCollected = (
  fields: SkillIntakeField[],
  collected: Record<string, unknown>,
): Record<string, unknown> => {
  const sensitiveNames = new Set(fields.filter((field) => field.sensitive).map((field) => field.name));
  if (sensitiveNames.size === 0) {
    return collected;
  }
  return Object.fromEntries(Object.entries(collected).filter(([name]) => !sensitiveNames.has(name)));
};

const mapStateRow = (row: SkillIntakeStateRow): IntakeState => ({
  id: row.id,
  skillName: row.skill_name,
  collected: normalizeCollected(row.collected),
  missing: Array.isArray(row.missing) ? row.missing : [],
  status: row.status,
  lastPromptedField: row.last_prompted_field,
});

export class DatabaseSkillIntakeStateStore implements SkillIntakeStateStore {
  constructor(
    private readonly database: SkillIntakeStateDatabase,
    private readonly options: { ttlMs?: number } = {},
  ) {}

  private get ttlMs(): number {
    return this.options.ttlMs ?? DEFAULT_SKILL_INTAKE_TTL_MS;
  }

  private async expireStaleOpenStates(input: {
    workspaceId: string;
    conversationId: string;
    skillName: string;
  }): Promise<void> {
    await this.database.query(
      `UPDATE skill_intake_states
       SET status = 'expired',
           collected = '{}'::jsonb,
           invalid = '{}'::jsonb,
           missing = ARRAY[]::text[],
           last_prompted_field = NULL,
           updated_at = NOW()
       WHERE workspace_id = $1
         AND conversation_id = $2
         AND skill_name = $3
         AND status IN ('active', 'paused', 'awaiting_confirmation', 'awaiting_tool')
         AND expires_at IS NOT NULL
         AND expires_at <= NOW()`,
      [input.workspaceId, input.conversationId, input.skillName],
    );
  }

  async findOpen(input: {
    workspaceId: string;
    conversationId: string;
    skillName: string;
  }): Promise<IntakeState | null> {
    await this.expireStaleOpenStates(input);
    const [row] = await this.database.query<SkillIntakeStateRow>(
      `SELECT id::text, skill_name, status, collected, missing, expires_at, last_prompted_field
       FROM skill_intake_states
       WHERE workspace_id = $1
         AND conversation_id = $2
         AND skill_name = $3
         AND status IN ('active', 'paused')
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY updated_at DESC
       LIMIT 1`,
      [input.workspaceId, input.conversationId, input.skillName],
    );
    return row ? mapStateRow(row) : null;
  }

  async save(input: {
    workspaceId: string;
    conversationId: string;
    state: IntakeState;
  }): Promise<IntakeState> {
    await this.expireStaleOpenStates({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      skillName: input.state.skillName,
    });

    if (input.state.id) {
      const [row] = await this.database.query<SkillIntakeStateRow>(
        `UPDATE skill_intake_states
         SET status = $2,
             collected = $3::jsonb,
             missing = $4::text[],
             last_prompted_field = $5,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id::text, skill_name, status, collected, missing, expires_at, last_prompted_field`,
        [
          input.state.id,
          input.state.status,
          JSON.stringify(input.state.collected),
          input.state.missing,
          input.state.lastPromptedField,
        ],
      );
      return row ? mapStateRow(row) : input.state;
    }

    const [row] = await this.database.query<SkillIntakeStateRow>(
      `INSERT INTO skill_intake_states (
         id,
         workspace_id,
         conversation_id,
         skill_name,
         status,
         collected,
         invalid,
         missing,
         expires_at,
         last_prompted_field
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, '{}'::jsonb, $7::text[], $8, $9)
       RETURNING id::text, skill_name, status, collected, missing, expires_at, last_prompted_field`,
      [
        randomUUID(),
        input.workspaceId,
        input.conversationId,
        input.state.skillName,
        input.state.status,
        JSON.stringify(input.state.collected),
        input.state.missing,
        new Date(Date.now() + this.ttlMs).toISOString(),
        input.state.lastPromptedField,
      ],
    );
    return row ? mapStateRow(row) : input.state;
  }
}

const buildStage = (
  stageId: string,
  kind: string,
  label: string,
  status: ActivityStageStatus,
  fields: Omit<ActivityStage, "stageId" | "kind" | "label" | "status"> = {},
): ActivityStage => ({
  stageId,
  kind,
  label,
  status,
  startedAt: fields.startedAt ?? new Date().toISOString(),
  ...fields,
});

const buildTrace = (
  skillName: string,
  stages: ActivityStage[],
  outcome: string,
  status: ActivitySummary["status"],
): ActivityTrace => {
  const startedAt = stages[0]?.startedAt ?? new Date().toISOString();
  const completedAt = new Date().toISOString();
  const trace: ActivityTrace = {
    traceId: randomUUID(),
    startedAt,
    completedAt,
    totalDurationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    stages,
    links: stages.slice(0, -1).map((stage, index) => ({
      fromStageId: stage.stageId,
      toStageId: stages[index + 1]?.stageId ?? stage.stageId,
      kind: "sequence",
    })),
  };
  return {
    ...trace,
    summary: {
      traceId: trace.traceId,
      skillName,
      surface: "assistant",
      path: skillName,
      status,
      outcome,
      primaryCounts: {
        stageCount: stages.length,
      },
    },
  };
};

const normalizeString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const validateFieldValue = (field: SkillIntakeField, value: unknown): unknown | null => {
  if (value === undefined || value === null) {
    return null;
  }

  if (field.type === "email") {
    const parsed = z.string().trim().email().safeParse(value);
    return parsed.success ? parsed.data.toLowerCase() : null;
  }

  if (field.type === "number") {
    const numberValue = typeof value === "number" ? value : Number(normalizeString(value));
    return Number.isFinite(numberValue) ? numberValue : null;
  }

  if (field.type === "enum") {
    const stringValue = normalizeString(value);
    return stringValue && field.enumValues?.includes(stringValue) ? stringValue : null;
  }

  if (field.type === "date") {
    const stringValue = normalizeString(value);
    return stringValue && Number.isFinite(Date.parse(stringValue)) ? stringValue : null;
  }

  const stringValue = normalizeString(value);
  if (!stringValue) {
    return null;
  }
  if (field.maxLength && stringValue.length > field.maxLength) {
    return null;
  }
  if (field.pattern && !new RegExp(field.pattern).test(stringValue)) {
    return null;
  }
  return stringValue;
};

const looksLikeSingleFieldAttempt = (field: SkillIntakeField, query: string): boolean => {
  const value = normalizeString(query);
  if (!value) {
    return false;
  }

  if (field.type === "email") {
    return value.includes("@") && !/\s/u.test(value);
  }

  if (field.type === "number") {
    return Number.isFinite(Number(value));
  }

  if (field.type === "date") {
    return Number.isFinite(Date.parse(value));
  }

  if (field.type === "enum") {
    return !/\s/u.test(value);
  }

  if (field.pattern) {
    return !/\s/u.test(value) && value.length <= 64;
  }

  return true;
};

const inferSingleMissingFieldAttempt = (
  fields: SkillIntakeField[],
  state: IntakeState,
  query: string,
): Record<string, unknown> => {
  if (state.missing.length !== 1) {
    return {};
  }
  const field = fields.find((candidate) => candidate.name === state.missing[0]);
  if (!field || !looksLikeSingleFieldAttempt(field, query)) {
    return {};
  }
  return { [field.name]: query };
};

const requiredMissingFields = (
  fields: SkillIntakeField[],
  collected: Record<string, unknown>,
): SkillIntakeField[] =>
  fields.filter((field) => field.required && !Object.hasOwn(collected, field.name));

const validateExtractedFields = (
  fields: SkillIntakeField[],
  extracted: Record<string, unknown>,
): { valid: Record<string, unknown>; invalid: SkillIntakeField[] } => {
  const valid: Record<string, unknown> = {};
  const invalid: SkillIntakeField[] = [];
  for (const field of fields) {
    if (!Object.hasOwn(extracted, field.name)) {
      continue;
    }
    const normalized = validateFieldValue(field, extracted[field.name]);
    if (normalized === null) {
      invalid.push(field);
    } else {
      valid[field.name] = normalized;
    }
  }
  return { valid, invalid };
};

export class ConfiguredSkillIntakeProvider implements ChatIntakeProviderPort {
  private readonly stateStore: SkillIntakeStateStore;
  private readonly executorRegistry: SkillExecutorRegistry | null;

  constructor(
    private readonly adapters: ConfiguredSkillIntakeAdapter[],
    options: {
      stateStore?: SkillIntakeStateStore;
      executorRegistry?: SkillExecutorRegistry;
    } = {},
  ) {
    this.stateStore = options.stateStore ?? new InMemorySkillIntakeStateStore();
    this.executorRegistry = options.executorRegistry ?? null;
  }

  async handle(input: ChatIntakeInput): Promise<ChatIntakeResult | null> {
    const active = await this.findActive(input);
    if (active) {
      return this.continueState(input, active.adapter, active.state);
    }

    for (const adapter of this.adapters) {
      if (!adapter.skill.intake?.enabled || !await adapter.shouldStart(input)) {
        continue;
      }
      return this.startState(input, adapter);
    }

    return null;
  }

  async getState(input: { workspaceId: string; conversationId: string; skillName: string }): Promise<IntakeState | null> {
    return this.stateStore.findOpen(input);
  }

  private async findActive(input: ChatIntakeInput): Promise<{ adapter: ConfiguredSkillIntakeAdapter; state: IntakeState } | null> {
    for (const adapter of this.adapters) {
      const state = await this.stateStore.findOpen({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        skillName: adapter.skill.name,
      });
      if (state && (state.status === "active" || state.status === "paused")) {
        return { adapter, state };
      }
    }
    return null;
  }

  private async dispatchExecution(
    adapter: ConfiguredSkillIntakeAdapter,
    collected: Record<string, unknown>,
    input: ChatIntakeInput,
  ): Promise<SkillIntakeExecutionResult> {
    const { skill } = adapter;
    if (skill.execution) {
      const executor = this.executorRegistry?.resolve(skill.execution) ?? null;
      if (!executor) {
        const identifier = skill.execution.kind === "webhook"
          ? `provider=${skill.execution.provider}`
          : `adapter=${skill.execution.adapter}`;
        throw new Error(
          `No skill executor registered for ${skill.execution.kind} (${identifier}) declared by skill "${skill.name}"`,
        );
      }
      return executor.execute({ skill, collected, context: { chat: input } });
    }
    if (!adapter.execute) {
      throw new Error(
        `Skill "${skill.name}" has no execution metadata and its intake adapter provides no execute() fallback`,
      );
    }
    return adapter.execute({ skill, collected, chat: input });
  }

  private async startState(input: ChatIntakeInput, adapter: ConfiguredSkillIntakeAdapter): Promise<ChatIntakeResult> {
    return this.collect(input, adapter, {
      skillName: adapter.skill.name,
      collected: {},
      missing: adapter.skill.intake?.fields.filter((field) => field.required).map((field) => field.name) ?? [],
      status: "active",
      lastPromptedField: null,
    });
  }

  private async continueState(
    input: ChatIntakeInput,
    adapter: ConfiguredSkillIntakeAdapter,
    state: IntakeState,
  ): Promise<ChatIntakeResult | null> {
    const intakeFields = adapter.skill.intake?.fields ?? [];
    const extracted = await adapter.extractFields(input, { collected: state.collected });
    const inferred = Object.keys(extracted).length === 0
      ? inferSingleMissingFieldAttempt(intakeFields, state, input.query)
      : {};
    const candidate = Object.keys(extracted).length === 0 ? inferred : extracted;
    if (Object.keys(candidate).length === 0 && !await adapter.shouldStart(input)) {
      await this.stateStore.save({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        state: {
          ...state,
          status: "paused",
        },
      });
      return null;
    }
    return this.collect(input, adapter, state, candidate);
  }

  private async collect(
    input: ChatIntakeInput,
    adapter: ConfiguredSkillIntakeAdapter,
    state: IntakeState,
    preExtracted?: Record<string, unknown>,
  ): Promise<ChatIntakeResult> {
    const intake = adapter.skill.intake;
    if (!intake) {
      throw new Error(`Skill ${adapter.skill.name} is missing intake metadata.`);
    }

    const extracted = preExtracted ?? await adapter.extractFields(input, { collected: state.collected });
    const { valid, invalid } = validateExtractedFields(intake.fields, isObject(extracted) ? extracted : {});
    const collected = {
      ...state.collected,
      ...valid,
    };
    const missing = requiredMissingFields(intake.fields, collected);
    const status = missing.length > 0 || invalid.length > 0 ? "active" : "completed";
    const persistedCollected = status === "completed"
      ? scrubSensitiveCollected(intake.fields, collected)
      : collected;
    const nextState = await this.stateStore.save({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      state: {
        id: state.id,
        skillName: adapter.skill.name,
        collected: persistedCollected,
        missing: missing.map((field) => field.name),
        status,
        lastPromptedField: invalid[0]?.name ?? missing[0]?.name ?? null,
      },
    });

    if (invalid.length > 0 || missing.length > 0) {
      const answer = await adapter.composeAnswer({
        kind: invalid.length > 0 ? "invalid" : "missing",
        skill: adapter.skill,
        missing,
        invalid,
        collected,
        chat: input,
        userExpectedLocale: input.userExpectedLocale,
      });
      const trace = buildTrace(adapter.skill.name, [
        buildStage("intake_collect", "intake_collect", "Intake collect", invalid.length > 0 ? "rejected" : "applied", {
          outputs: {
            collected: Object.keys(collected),
            missing: missing.map((field) => field.name),
            invalid: invalid.map((field) => field.name),
          },
        }),
      ], invalid.length > 0 ? "intake_invalid" : "intake_missing", invalid.length > 0 ? "blocked" : "pending");

      return {
        skillName: adapter.skill.name,
        status: "active",
        display: adapter.skill.display,
        stateId: nextState.id,
        answer,
        activityTrace: trace,
        activitySummary: trace.summary!,
      };
    }

    const execution = await this.dispatchExecution(adapter, collected, input);
    const trace = buildTrace(adapter.skill.name, [
      buildStage("intake_collect", "intake_collect", "Intake collect", "applied", {
        outputs: {
          collected: Object.keys(collected),
        },
      }),
      buildStage("skill_execute", "skill_execute", "Skill execute", "applied", {
        outputs: execution.outputs,
      }),
    ], "skill_completed", "success");

    return {
      skillName: adapter.skill.name,
      status: "completed",
      display: adapter.skill.display,
      stateId: nextState.id,
      answer: execution.answer,
      activityTrace: trace,
      activitySummary: trace.summary!,
    };
  }
}
