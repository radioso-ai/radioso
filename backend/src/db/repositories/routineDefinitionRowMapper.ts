import { z } from "zod";

import {
  routineConsentSchema,
  routineReentryModes,
  type RoutineApprovalOption,
  type RoutineDefinition,
  type RoutineFieldGuardOp,
  type RoutineFieldGuardUnit,
  type RoutineGuardKind,
  type RoutineReentryMode,
  type RoutineSlotType,
  type RoutineStepKind,
  type RoutineTerminalKind,
} from "../../modules/routines/public.js";
import { answerCoverageCriteriaSchema } from "../../modules/answerCoverage/public.js";

/** A `routine_definition` row as `RoutineDefinitionRepository`'s definition select reads it, children rolled up as json. */
export interface RoutineDefinitionRow {
  id: string;
  agent_id: string;
  lineage_id: string;
  name: string;
  version: number;
  enabled: boolean;
  activation_trigger_description: string;
  activation_gate_ref: string | null;
  activation_priority: number;
  activation_reentry_mode: string;
  activation_coverage_criteria: unknown;
  slots: unknown;
  steps: unknown;
  transitions: unknown;
  terminals: unknown;
  completion_export: unknown;
  exposure_enabled: boolean;
  exposure_tool_name: string | null;
  exposure_description: string | null;
  consents: unknown;
  created_at: Date;
  updated_at: Date;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const readString = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === "string" ? record[key] : "";

const readNullableString = (record: Record<string, unknown>, key: string): string | null =>
  typeof record[key] === "string" ? record[key] : null;

const readNumber = (record: Record<string, unknown>, key: string): number =>
  typeof record[key] === "number" ? record[key] : 0;

const readBoolean = (record: Record<string, unknown>, key: string): boolean =>
  typeof record[key] === "boolean" ? record[key] : false;

const readOperatorNotice = (
  terminal: Record<string, unknown>,
): NonNullable<RoutineDefinition["terminals"][number]["operatorNotice"]> => {
  const skillName = readNullableString(terminal, "operatorNoticeSkillName");
  const replyToSlot = readNullableString(terminal, "operatorNoticeReplyToSlot");
  const includeAiSummary = readBoolean(terminal, "operatorNoticeIncludeAiSummary");
  return {
    subject: readNullableString(terminal, "operatorNoticeSubject"),
    intro: readNullableString(terminal, "operatorNoticeIntro"),
    ...(skillName ? { skillName } : {}),
    ...(replyToSlot ? { replyToSlot } : {}),
    ...(includeAiSummary ? { includeAiSummary: true } : {}),
  };
};

const readMetadata = (record: Record<string, unknown>, key: string): Record<string, unknown> =>
  asRecord(record[key]);

// A field guard's comparison value is a string, number, or boolean (or absent). It rides
// in a jsonb column, so it arrives already typed — pass it through, drop anything else.
const readFieldValue = (record: Record<string, unknown>, key: string): string | number | boolean | null => {
  const value = record[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
};

const readFieldValues = (record: Record<string, unknown>, key: string): (string | number | boolean)[] | null => {
  const value = record[key];
  if (!Array.isArray(value)) {
    return null;
  }
  const primitives = value.filter((entry): entry is string | number | boolean =>
    typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
  );
  // An empty list is not a valid `in` guard (the domain enforces min(1)); surface it as
  // absent rather than a never-matching `values: []` the compiler would still spread.
  return primitives.length > 0 ? primitives : null;
};

const asArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(asRecord) : [];

// An approval step's options ride in a jsonb column. Read back the {id,label,description?}
// shape the domain expects, dropping anything malformed. Absent for non-approval steps.
const readApprovalOptions = (record: Record<string, unknown>, key: string): RoutineApprovalOption[] | null => {
  const value = record[key];
  if (!Array.isArray(value)) {
    return null;
  }
  const options = value
    .map(asRecord)
    .filter((option) => typeof option.id === "string" && typeof option.label === "string")
    .map((option) => ({
      id: option.id as string,
      label: option.label as string,
      description: typeof option.description === "string" ? option.description : null,
    }));
  return options.length > 0 ? options : null;
};

const storedConsentsSchema = z.array(routineConsentSchema);

/**
 * A routine's consents decide which sensitive slots wait for the visitor's consent, so a stored list
 * that does not parse fails the read rather than reading as fewer consents: dropping one would leave
 * its slots collected without asking. None reads back without the field, so a routine without
 * consents keeps the shape it had before the column existed and published snapshots stay unchanged.
 */
const readConsents = (row: Pick<RoutineDefinitionRow, "id" | "consents">): Pick<RoutineDefinition, "consents"> => {
  const parsed = storedConsentsSchema.safeParse(row.consents);
  if (!parsed.success) {
    throw new Error(`routine_definition_consents_invalid:${row.id}`, { cause: parsed.error });
  }
  return parsed.data.length > 0 ? { consents: parsed.data } : {};
};

const normalizeStepKind = (kind: string): RoutineStepKind =>
  kind === "fork" ? "chat" : kind as RoutineStepKind;

const normalizeGuardKind = (kind: string): RoutineGuardKind =>
  kind === "always" || kind === "fallback" ? "default" : kind as RoutineGuardKind;

export const mapRoutineDefinitionRow = (row: RoutineDefinitionRow): RoutineDefinition => ({
  id: row.id,
  agentId: row.agent_id,
  lineageId: row.lineage_id,
  name: row.name,
  version: row.version,
  enabled: row.enabled,
  activation: {
    triggerDescription: row.activation_trigger_description,
    gateRef: row.activation_gate_ref,
    priority: row.activation_priority,
    reentryMode: routineReentryModes.includes(row.activation_reentry_mode as RoutineReentryMode)
      ? (row.activation_reentry_mode as RoutineReentryMode)
      : "once_per_conversation",
    ...(answerCoverageCriteriaSchema.safeParse(row.activation_coverage_criteria).success
      ? { coverageCriteria: answerCoverageCriteriaSchema.parse(row.activation_coverage_criteria) }
      : {}),
  },
  slots: asArray(row.slots).map((slot) => ({
    stableSlotId: readString(slot, "stableSlotId"),
    key: readString(slot, "key"),
    type: readString(slot, "type") as RoutineSlotType,
    required: readBoolean(slot, "required"),
    description: readNullableString(slot, "description"),
    ordinal: readNumber(slot, "ordinal"),
    ...(readBoolean(slot, "mutable") ? { mutable: true } : {}),
    // Like `mutable`, only the non-default value is carried, so a normal slot reads back in the
    // shape it had before the column existed and published snapshots stay unchanged.
    ...(readNullableString(slot, "sensitivity") === "sensitive" ? { sensitivity: "sensitive" as const } : {}),
  })),
  steps: asArray(row.steps).map((step) => {
    // captureKey/options are only valid on approval steps; the domain rejects them on any
    // other kind, so include them only when present (NULL columns on every other step).
    const captureKey = readNullableString(step, "captureKey");
    const options = readApprovalOptions(step, "options");
    return {
      stableStepId: readString(step, "stableStepId"),
      kind: normalizeStepKind(readString(step, "kind")),
      instruction: readString(step, "instruction"),
      toolRef: readNullableString(step, "toolRef"),
      actionType: readNullableString(step, "actionType"),
      ...(captureKey !== null ? { captureKey } : {}),
      ...(options !== null ? { options } : {}),
      ordinal: readNumber(step, "ordinal"),
      metadata: readMetadata(step, "metadata"),
    };
  }),
  transitions: asArray(row.transitions).map((transition) => ({
    fromStep: readString(transition, "fromStep"),
    toRef: readString(transition, "toRef"),
    guardKind: normalizeGuardKind(readString(transition, "guardKind")),
    guardText: readNullableString(transition, "guardText"),
    outcomeStatus: readNullableString(transition, "outcomeStatus"),
    counterLimit: readNumber(transition, "counterLimit") || null,
    fieldRef: readNullableString(transition, "fieldRef"),
    fieldOp: readNullableString(transition, "fieldOp") as RoutineFieldGuardOp | null,
    fieldValue: readFieldValue(transition, "fieldValue"),
    fieldValues: readFieldValues(transition, "fieldValues"),
    fieldUnit: readNullableString(transition, "fieldUnit") as RoutineFieldGuardUnit | null,
    ordinal: readNumber(transition, "ordinal"),
  })),
  terminals: asArray(row.terminals).map((terminal) => ({
    stableStepId: readString(terminal, "stableStepId"),
    kind: readString(terminal, "kind") as RoutineTerminalKind,
    instruction: readNullableString(terminal, "instruction"),
    // Absent, not undefined, when the notice is off or names no skill or reply-to: the authoring shape
    // compares terminals as JSON (operator MCP replace_terminal), and an undefined-valued key is
    // not JSON.
    ...(readBoolean(terminal, "operatorNoticeEnabled")
      ? { operatorNotice: readOperatorNotice(terminal) }
      : {}),
    ordinal: readNumber(terminal, "ordinal"),
  })),
  completionExport: (() => {
    const exportRecord = asRecord(row.completion_export);
    return {
      enabled: readBoolean(exportRecord, "enabled"),
      triggerKinds: Array.isArray(exportRecord.triggerKinds)
        ? exportRecord.triggerKinds.filter((kind): kind is RoutineTerminalKind =>
            kind === "complete" || kind === "handoff"
          )
        : [],
      destinationRef: readString(exportRecord, "destinationRef"),
    };
  })(),
  // The block is present exactly when a tool name column is set; `exposure_enabled` alone
  // says nothing without a name to be enabled under.
  ...(row.exposure_tool_name === null ? {} : {
    exposure: {
      enabled: row.exposure_enabled,
      toolName: row.exposure_tool_name,
      description: row.exposure_description ?? "",
    },
  }),
  ...readConsents(row),
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});
