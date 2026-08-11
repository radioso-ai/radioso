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

export const routineIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;
const identifierPattern = routineIdentifierPattern;
const slotKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const trimmedText = (maxLength: number) =>
  z.string().trim().min(1).max(maxLength);

const editingText = (maxLength: number) =>
  z.string().trim().max(maxLength);

const editingOptionalText = (maxLength: number) =>
  z.string().trim().max(maxLength).optional().nullable().transform((value) => value ?? null);

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

const routineApprovalOptionSharedFields = {
  id: stableIdSchema,
};

const routineApprovalOptionSchemaFor = <TDescription extends z.ZodTypeAny, TLabel extends z.ZodTypeAny>(
  description: TDescription,
  label: TLabel,
) => z.object({
  ...routineApprovalOptionSharedFields,
  label,
  description,
}).strict();

export const routineApprovalOptionSchema = routineApprovalOptionSchemaFor(
  optionalAuthoringParamText(ROUTINE_DEFINITION_LIMITS.approvalOptionDescription),
  trimmedText(ROUTINE_DEFINITION_LIMITS.approvalOptionLabel),
);

const routineApprovalOptionEditingSchema = routineApprovalOptionSchemaFor(
  editingOptionalText(ROUTINE_DEFINITION_LIMITS.approvalOptionDescription),
  editingText(ROUTINE_DEFINITION_LIMITS.approvalOptionLabel),
);
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

const routineSlotSharedFields = {
  stableSlotId: stableIdSchema,
  key: trimmedText(ROUTINE_DEFINITION_LIMITS.slotKey).regex(slotKeyPattern),
  type: z.enum(routineSlotTypes),
  required: z.boolean(),
};

const routineSlotSchemaFor = <TDescription extends z.ZodTypeAny>(description: TDescription) => z.object({
  ...routineSlotSharedFields,
  description,
  ordinal: z.number().int().min(0),
  // Whether the captured value may be corrected after the routine completes (issue #746).
  // Optional (like `description`): absent means immutable. "Absent = false" is applied at
  // the compile/persist boundary and by the column default, so existing slot literals and
  // stored rows stay immutable without a forced field everywhere.
  mutable: z.boolean().optional(),
}).strict();

export const routineSlotSchema = routineSlotSchemaFor(
  optionalTrimmedText(ROUTINE_DEFINITION_LIMITS.slotDescription),
);

const routineSlotEditingSchema = routineSlotSchemaFor(
  editingOptionalText(ROUTINE_DEFINITION_LIMITS.slotDescription),
);

const routineStepSharedFields = {
  stableStepId: stableIdSchema,
  kind: z.enum(routineStepKinds),
  toolRef: optionalTrimmedText(ROUTINE_DEFINITION_LIMITS.toolRef),
  actionType: optionalAuthoringParamText(ROUTINE_DEFINITION_LIMITS.actionType),
  captureKey: optionalCaptureKeySchema,
  ordinal: z.number().int().min(0),
  metadata: routineStepMetadataSchema.optional().default({}),
};

const routineStepSchemaFor = <
  TInstruction extends z.ZodTypeAny,
  TOptions extends z.ZodTypeAny,
>(instruction: TInstruction, options: TOptions) => z.object({
  ...routineStepSharedFields,
  instruction,
  options,
}).strict();

export const routineStepSchema = routineStepSchemaFor(
  trimmedText(ROUTINE_DEFINITION_LIMITS.instruction),
  z.array(routineApprovalOptionSchema).max(ROUTINE_DEFINITION_LIMITS.approvalOptionCount).optional(),
).superRefine((step, ctx) => {
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

const routineStepEditingSchema = routineStepSchemaFor(
  editingText(ROUTINE_DEFINITION_LIMITS.instruction),
  z.array(routineApprovalOptionEditingSchema).max(ROUTINE_DEFINITION_LIMITS.approvalOptionCount).optional(),
);

const fieldGuardValueSchema = z.union([
  z.string().trim().min(1).max(ROUTINE_DEFINITION_LIMITS.fieldValue),
  z.number(),
  z.boolean(),
]);

const routineTransitionSharedFields = {
  fromStep: stableIdSchema,
  toRef: stableIdSchema,
  guardKind: z.enum(routineGuardKinds),
};

const routineTransitionSchemaFor = <
  TGuardText extends z.ZodTypeAny,
  TOutcomeStatus extends z.ZodTypeAny,
>(guardText: TGuardText, outcomeStatus: TOutcomeStatus) => z.object({
  ...routineTransitionSharedFields,
  guardText,
  outcomeStatus,
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

export const routineTransitionSchema = routineTransitionSchemaFor(
  optionalTrimmedText(ROUTINE_DEFINITION_LIMITS.guardText),
  optionalStructuredParamText(ROUTINE_DEFINITION_LIMITS.stableId),
);

const routineTransitionEditingSchema = routineTransitionSchemaFor(
  editingOptionalText(ROUTINE_DEFINITION_LIMITS.guardText),
  editingOptionalText(ROUTINE_DEFINITION_LIMITS.stableId),
);

const routineTerminalSharedFields = {
  stableStepId: stableIdSchema,
  kind: z.enum(routineTerminalKinds),
};

const routineTerminalSchemaFor = <TInstruction extends z.ZodTypeAny>(instruction: TInstruction) => z.object({
  ...routineTerminalSharedFields,
  instruction,
  ordinal: z.number().int().min(0),
}).strict();

export const routineTerminalSchema = routineTerminalSchemaFor(
  optionalTrimmedText(ROUTINE_DEFINITION_LIMITS.instruction),
);

const routineTerminalEditingSchema = routineTerminalSchemaFor(
  editingOptionalText(ROUTINE_DEFINITION_LIMITS.instruction),
);

const routineCompletionExportFields = {
  enabled: z.boolean().default(false),
  triggerKinds: z.array(z.enum(routineCompletionExportTriggerKinds)).default([]),
  destinationRef: z.string().trim().max(ROUTINE_DEFINITION_LIMITS.destinationRef).default(""),
};

const createRoutineCompletionExportSchema = () => z.object(routineCompletionExportFields).strict();

export const routineCompletionExportSchema = createRoutineCompletionExportSchema().superRefine((value, ctx) => {
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

const routineDefinitionDraftSchema = <
  TName extends z.ZodTypeAny,
  TTriggerDescription extends z.ZodTypeAny,
  TSlots extends z.ZodTypeAny,
  TSteps extends z.ZodTypeAny,
  TTransitions extends z.ZodTypeAny,
  TTerminals extends z.ZodTypeAny,
  TCompletionExport extends z.ZodTypeAny,
>(
  name: TName,
  triggerDescription: TTriggerDescription,
  slots: TSlots,
  steps: TSteps,
  transitions: TTransitions,
  terminals: TTerminals,
  completionExport: TCompletionExport,
) => z.object({
  name,
  activation: z.object({
    triggerDescription,
    gateRef: optionalTrimmedText(ROUTINE_DEFINITION_LIMITS.gateRef),
    priority: z.number().int(),
    reentryMode: z.enum(routineReentryModes).default("once_per_conversation"),
  }).strict(),
  slots,
  steps,
  transitions,
  terminals,
  completionExport,
}).strict();

// Fields added to the persistence draft schema must be classified as strict or
// lenient here so editing surfaces can represent every valid mid-edit state.
export const routineDefinitionDraftInputSchema = routineDefinitionDraftSchema(
  trimmedText(ROUTINE_DEFINITION_LIMITS.name),
  trimmedText(ROUTINE_DEFINITION_LIMITS.triggerDescription),
  z.array(routineSlotSchema).default([]),
  z.array(routineStepSchema).min(1),
  z.array(routineTransitionSchema).default([]),
  z.array(routineTerminalSchema).min(1),
  routineCompletionExportSchema.optional(),
);

/** The editing superset of a draft — what an authoring surface may hold mid-edit. */
export const routineDefinitionDraftEditingInputSchema = routineDefinitionDraftSchema(
  editingText(ROUTINE_DEFINITION_LIMITS.name),
  editingText(ROUTINE_DEFINITION_LIMITS.triggerDescription),
  z.array(routineSlotEditingSchema).default([]),
  z.array(routineStepEditingSchema).default([]),
  z.array(routineTransitionEditingSchema).default([]),
  z.array(routineTerminalEditingSchema).default([]),
  createRoutineCompletionExportSchema().optional(),
);

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
export type RoutineDefinitionDraftEditingInput = z.infer<typeof routineDefinitionDraftEditingInputSchema>;
export type RoutineDefinitionDraftEditingAuthoringInput = z.input<typeof routineDefinitionDraftEditingInputSchema>;
export type RoutineDefinition = z.infer<typeof routineDefinitionSchema>;
