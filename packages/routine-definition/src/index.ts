import { z } from "zod";

export const ROUTINE_DEFINITION_LIMITS = {
  name: 200,
  triggerDescription: 2000,
  gateRef: 300,
  stableId: 120,
  slotKey: 120,
  slotDescription: 1000,
  instruction: 4000,
  toolRef: 300,
  approvalOptionCount: 8,
  approvalOptionLabel: 120,
  approvalOptionDescription: 500,
  guardText: 2000,
  actionType: 300,
  destinationRef: 300,
  fieldRef: 200,
  fieldValue: 500,
} as const;

export const routineDefinitionStatuses = ["draft", "published", "superseded", "archived"] as const;
// Reentry policy for a completed routine instance within a conversation (issue #746).
// `once_per_conversation` is the safe default and preserves the historical behaviour
// (a completed instance suppresses re-activation). `semantic` is reserved for a later
// slice and currently resolves like the default at activation time.
export const routineReentryModes = ["once_per_conversation", "always", "semantic"] as const;
export const routineSlotTypes = ["text", "number", "boolean", "email", "date"] as const;
export const routineStepKinds = ["chat", "tool", "action", "approval"] as const;
export const routineGuardKinds = ["llm", "default", "slot_filled", "outcome", "counter", "field"] as const;
export const routineFieldGuardOps = ["is_true", "is_false", "equals", "not_equals", "in", "is_present", "is_absent", "gt", "gte", "lt", "lte", "older_than", "within"] as const;
export const routineFieldGuardUnits = ["days", "weeks", "months", "years"] as const;
export const routineTerminalKinds = ["complete", "handoff"] as const;
export const routineCompletionExportTriggerKinds = routineTerminalKinds;
export const routineValidationCodes = [
  "unreachable_step",
  "missing_terminal",
  "dangling_action_reference",
  "dangling_step_reference",
  "unbounded_back_edge",
  "missing_action_follow_up",
  "declared_unused_slot",
  "referenced_undeclared_slot",
  "unregistered_action_type",
  "unknown_skill",
  "action_capability_denied",
  "invalid_webhook_destination_ref",
  "unknown_webhook_destination",
  "attempt_limit_without_fallback",
  "outcome_guard_on_non_tool_step",
  "structured_guard_missing_parameter",
  "field_guard_unknown_reference",
  "field_guard_incompatible_type",
  "completion_export_missing_destination",
  "approval_step_llm_edge",
  "approval_step_no_decision_edge",
  "approval_step_unknown_option",
  "approval_step_unreachable_option",
  "unsatisfiable_required_input",
  "input_type_mismatch",
  "unknown_input_binding",
  "unknown_variable_ref",
  "unknown_context_variable",
  "variable_name_collision",
  "node_id_collision",
] as const;

export const routineIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;
const identifierPattern = routineIdentifierPattern;
const slotKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const trimmedText = (maxLength: number) =>
  z.string().trim().min(1).max(maxLength);

const optionalTrimmedText = (maxLength: number) =>
  z.string().trim().min(1).max(maxLength).optional().nullable().transform((value) => value ?? null);

const optionalStructuredParamText = (maxLength: number) =>
  z.string().trim().min(1).max(maxLength).optional().nullable();

const optionalAuthoringParamText = (maxLength: number) =>
  z.string().trim().min(1).max(maxLength).optional().nullable();

const stableIdSchema = trimmedText(ROUTINE_DEFINITION_LIMITS.stableId).regex(identifierPattern);
// captureKey lives in the slot-key namespace (no dots/dashes): approval field
// refs are built as `<captureKey>.id`, so a dotted key would be ambiguous.
const optionalCaptureKeySchema = z.string()
  .trim()
  .min(1)
  .max(ROUTINE_DEFINITION_LIMITS.slotKey)
  .regex(slotKeyPattern)
  .optional()
  .nullable();

export const routineApprovalOptionSchema = z.object({
  id: stableIdSchema,
  label: trimmedText(ROUTINE_DEFINITION_LIMITS.approvalOptionLabel),
  description: optionalAuthoringParamText(ROUTINE_DEFINITION_LIMITS.approvalOptionDescription),
}).strict();
const routineVariableNameSchema = trimmedText(ROUTINE_DEFINITION_LIMITS.slotKey).regex(slotKeyPattern);

export const routineInputBindingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("literal"),
    value: z.union([z.string(), z.number(), z.boolean()]),
  }).strict(),
  z.object({
    kind: z.literal("variableRef"),
    ref: routineVariableNameSchema,
  }).strict(),
  z.object({
    kind: z.literal("contextVariableRef"),
    contextVariable: routineVariableNameSchema,
  }).strict(),
]);

export const routineStepModeSchema = z.enum(["typed", "untyped"]);

export const routineStepMetadataSchema = z.object({
  inputBindings: z.record(routineInputBindingSchema).optional(),
  outputAssignments: z.record(routineVariableNameSchema).optional(),
  mode: routineStepModeSchema.optional(),
}).passthrough();

export const routineSlotSchema = z.object({
  stableSlotId: stableIdSchema,
  key: trimmedText(ROUTINE_DEFINITION_LIMITS.slotKey).regex(slotKeyPattern),
  type: z.enum(routineSlotTypes),
  required: z.boolean(),
  description: optionalTrimmedText(ROUTINE_DEFINITION_LIMITS.slotDescription),
  ordinal: z.number().int().min(0),
  // Whether the captured value may be corrected after the routine completes (issue #746).
  // Optional (like `description`): absent means immutable. "Absent = false" is applied at
  // the compile/persist boundary and by the column default, so existing slot literals and
  // stored rows stay immutable without a forced field everywhere.
  mutable: z.boolean().optional(),
}).strict();

export const routineStepSchema = z.object({
  stableStepId: stableIdSchema,
  kind: z.enum(routineStepKinds),
  instruction: trimmedText(ROUTINE_DEFINITION_LIMITS.instruction),
  toolRef: optionalTrimmedText(ROUTINE_DEFINITION_LIMITS.toolRef),
  actionType: optionalAuthoringParamText(ROUTINE_DEFINITION_LIMITS.actionType),
  captureKey: optionalCaptureKeySchema,
  options: z.array(routineApprovalOptionSchema).max(ROUTINE_DEFINITION_LIMITS.approvalOptionCount).optional(),
  ordinal: z.number().int().min(0),
  metadata: routineStepMetadataSchema.optional().default({}),
}).strict().superRefine((step, ctx) => {
  const hasCaptureKey = step.captureKey !== undefined && step.captureKey !== null;
  const options = step.options;
  const hasOptions = options !== undefined;
  if (step.kind === "approval") {
    if (!hasCaptureKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["captureKey"],
        message: "approval step requires captureKey",
      });
    }
    // An approval is a decision: one choice is not a decision, it's a speed bump. Require at
    // least two so a human can always decline or branch elsewhere, not just rubber-stamp.
    if (!options || options.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "approval step requires at least two options",
      });
    }
    if (step.toolRef !== undefined && step.toolRef !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolRef"],
        message: "approval step must not declare toolRef",
      });
    }
    if (step.actionType !== undefined && step.actionType !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actionType"],
        message: "approval step must not declare actionType",
      });
    }
    const optionIds = new Set<string>();
    for (const [index, option] of (step.options ?? []).entries()) {
      if (optionIds.has(option.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options", index, "id"],
          message: `approval option id "${option.id}" must be unique`,
        });
      }
      optionIds.add(option.id);
    }
    return;
  }
  if (hasCaptureKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["captureKey"],
      message: "captureKey is only valid for approval steps",
    });
  }
  if (hasOptions) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["options"],
      message: "options are only valid for approval steps",
    });
  }
});

const fieldGuardValueSchema = z.union([
  z.string().trim().min(1).max(ROUTINE_DEFINITION_LIMITS.fieldValue),
  z.number(),
  z.boolean(),
]);

export const routineTransitionSchema = z.object({
  fromStep: stableIdSchema,
  toRef: stableIdSchema,
  guardKind: z.enum(routineGuardKinds),
  guardText: optionalTrimmedText(ROUTINE_DEFINITION_LIMITS.guardText),
  outcomeStatus: optionalStructuredParamText(ROUTINE_DEFINITION_LIMITS.stableId),
  counterLimit: z.number().int().positive().optional().nullable(),
  // Field guard params (guardKind === "field"): branch deterministically on a resolved
  // value — a skill output field or a captured slot — via `fieldOp`.
  fieldRef: optionalStructuredParamText(ROUTINE_DEFINITION_LIMITS.fieldRef),
  fieldOp: z.enum(routineFieldGuardOps).optional().nullable(),
  fieldValue: fieldGuardValueSchema.optional().nullable(),
  fieldValues: z.array(fieldGuardValueSchema).min(1).optional().nullable(),
  // Duration unit for the relative-date operators ("older_than" / "within").
  fieldUnit: z.enum(routineFieldGuardUnits).optional().nullable(),
  ordinal: z.number().int().min(0),
}).strict();

export const routineTerminalSchema = z.object({
  stableStepId: stableIdSchema,
  kind: z.enum(routineTerminalKinds),
  instruction: optionalTrimmedText(ROUTINE_DEFINITION_LIMITS.instruction),
  ordinal: z.number().int().min(0),
}).strict();

export const routineCompletionExportSchema = z.object({
  enabled: z.boolean().default(false),
  triggerKinds: z.array(z.enum(routineCompletionExportTriggerKinds)).default([]),
  destinationRef: z.string().trim().max(ROUTINE_DEFINITION_LIMITS.destinationRef).default(""),
}).strict().superRefine((value, ctx) => {
  if (!value.enabled) {
    return;
  }
  if (value.triggerKinds.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["triggerKinds"],
      message: "completionExport.triggerKinds must include at least one terminal kind when enabled",
    });
  }
  if (value.destinationRef.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["destinationRef"],
      message: "completionExport.destinationRef is required when enabled",
    });
  }
});

export const routineDefinitionDraftInputSchema = z.object({
  name: trimmedText(ROUTINE_DEFINITION_LIMITS.name),
  activation: z.object({
    triggerDescription: trimmedText(ROUTINE_DEFINITION_LIMITS.triggerDescription),
    gateRef: optionalTrimmedText(ROUTINE_DEFINITION_LIMITS.gateRef),
    priority: z.number().int(),
    reentryMode: z.enum(routineReentryModes).default("once_per_conversation"),
  }).strict(),
  slots: z.array(routineSlotSchema).default([]),
  steps: z.array(routineStepSchema).min(1),
  transitions: z.array(routineTransitionSchema).default([]),
  terminals: z.array(routineTerminalSchema).min(1),
  completionExport: routineCompletionExportSchema.optional(),
}).strict();

export const routineDefinitionSchema = routineDefinitionDraftInputSchema.extend({
  id: z.string().min(1),
  agentId: z.string().min(1),
  lineageId: z.string().min(1),
  version: z.number().int().min(1),
  status: z.enum(routineDefinitionStatuses),
  createdAt: z.date(),
  updatedAt: z.date(),
}).strict();

export type RoutineReentryMode = typeof routineReentryModes[number];
export type RoutineSlotType = typeof routineSlotTypes[number];
export type RoutineStepKind = typeof routineStepKinds[number];
export type RoutineApprovalOption = z.infer<typeof routineApprovalOptionSchema>;
export type RoutineGuardKind = typeof routineGuardKinds[number];
export type RoutineFieldGuardOp = typeof routineFieldGuardOps[number];
export type RoutineFieldGuardUnit = typeof routineFieldGuardUnits[number];

/**
 * Whether a condition is decided in code (`exact`) or by the model (`judgment`).
 * Surfacing this is the determinism boundary the author must be able to see
 * (spec FR-5): everything except an `llm` guard resolves deterministically.
 */
export type RoutineGuardProvenance = "exact" | "judgment";

export const routineGuardProvenance = (guardKind: RoutineGuardKind): RoutineGuardProvenance =>
  guardKind === "llm" ? "judgment" : "exact";
export type RoutineTerminalKind = typeof routineTerminalKinds[number];
export type RoutineValidationCode = typeof routineValidationCodes[number];
export type RoutineCompletionExportTriggerKind = typeof routineCompletionExportTriggerKinds[number];
export type RoutineInputBinding = z.infer<typeof routineInputBindingSchema>;
export type RoutineStepMode = z.infer<typeof routineStepModeSchema>;
export type RoutineStepMetadata = z.infer<typeof routineStepMetadataSchema>;
export type RoutineCompletionExport = z.infer<typeof routineCompletionExportSchema>;
export type RoutineDefinitionDraftInput = z.infer<typeof routineDefinitionDraftInputSchema>;
// Pre-parse authoring shape: what callers may submit before Zod applies defaults
// (e.g. activation.reentryMode is optional here, required post-parse). Authoring
// surfaces that construct drafts by hand must target this, not the parsed type.
export type RoutineDefinitionDraftAuthoringInput = z.input<typeof routineDefinitionDraftInputSchema>;
export type RoutineDefinition = z.infer<typeof routineDefinitionSchema>;
