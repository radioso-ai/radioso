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
  guardText: 2000,
  actionType: 300,
} as const;

export const routineDefinitionStatuses = ["draft", "published"] as const;
export const routineSlotTypes = ["text", "number", "boolean", "email", "date"] as const;
export const routineStepKinds = ["chat", "tool", "fork", "action"] as const;
export const routineGuardKinds = ["llm", "always", "fallback", "slot_filled", "outcome", "counter"] as const;
export const routineTerminalKinds = ["complete", "handoff"] as const;

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;
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

export const routineSlotSchema = z.object({
  stableSlotId: stableIdSchema,
  key: trimmedText(ROUTINE_DEFINITION_LIMITS.slotKey).regex(slotKeyPattern),
  type: z.enum(routineSlotTypes),
  required: z.boolean(),
  description: optionalTrimmedText(ROUTINE_DEFINITION_LIMITS.slotDescription),
  ordinal: z.number().int().min(0),
}).strict();

export const routineStepSchema = z.object({
  stableStepId: stableIdSchema,
  kind: z.enum(routineStepKinds),
  instruction: trimmedText(ROUTINE_DEFINITION_LIMITS.instruction),
  toolRef: optionalTrimmedText(ROUTINE_DEFINITION_LIMITS.toolRef),
  actionType: optionalAuthoringParamText(ROUTINE_DEFINITION_LIMITS.actionType),
  ordinal: z.number().int().min(0),
  metadata: z.record(z.unknown()).optional().default({}),
}).strict();

export const routineTransitionSchema = z.object({
  fromStep: stableIdSchema,
  toRef: stableIdSchema,
  guardKind: z.enum(routineGuardKinds),
  guardText: optionalTrimmedText(ROUTINE_DEFINITION_LIMITS.guardText),
  outcomeStatus: optionalStructuredParamText(ROUTINE_DEFINITION_LIMITS.stableId),
  counterLimit: z.number().int().positive().optional().nullable(),
  ordinal: z.number().int().min(0),
}).strict();

export const routineTerminalSchema = z.object({
  stableStepId: stableIdSchema,
  kind: z.enum(routineTerminalKinds),
  instruction: optionalTrimmedText(ROUTINE_DEFINITION_LIMITS.instruction),
  ordinal: z.number().int().min(0),
}).strict();

export const routineDefinitionDraftInputSchema = z.object({
  name: trimmedText(ROUTINE_DEFINITION_LIMITS.name),
  activation: z.object({
    triggerDescription: trimmedText(ROUTINE_DEFINITION_LIMITS.triggerDescription),
    gateRef: optionalTrimmedText(ROUTINE_DEFINITION_LIMITS.gateRef),
    priority: z.number().int(),
  }).strict(),
  slots: z.array(routineSlotSchema).default([]),
  steps: z.array(routineStepSchema).min(1),
  transitions: z.array(routineTransitionSchema).default([]),
  terminals: z.array(routineTerminalSchema).min(1),
}).strict();

export const routineDefinitionSchema = routineDefinitionDraftInputSchema.extend({
  id: z.string().min(1),
  agentId: z.string().min(1),
  version: z.number().int().min(1),
  status: z.enum(routineDefinitionStatuses),
  createdAt: z.date(),
  updatedAt: z.date(),
}).strict();

export type RoutineSlotType = typeof routineSlotTypes[number];
export type RoutineStepKind = typeof routineStepKinds[number];
export type RoutineGuardKind = typeof routineGuardKinds[number];
export type RoutineTerminalKind = typeof routineTerminalKinds[number];
export type RoutineDefinitionDraftInput = z.infer<typeof routineDefinitionDraftInputSchema>;
export type RoutineDefinition = z.infer<typeof routineDefinitionSchema>;
