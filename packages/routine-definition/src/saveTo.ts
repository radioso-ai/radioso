import { z } from "zod";

/**
 * Where a slot keeps its value once the routine ends (#1884): `conversation` for this conversation,
 * `person` for the person the conversation is with, when it has a verified one.
 */
export const routineSlotSaveScopes = ["conversation", "person"] as const;

/**
 * A slot's save target: the attribute (context variable) its value is written to when the routine
 * reaches an ending, and the scope. Picked by the author; nothing infers it from the slot's key or
 * type. This package learns the shape only: the attribute's existence, type and trust are checked
 * where the agent's attributes are known.
 */
export const routineSlotSaveToSchemaFor = <TName extends z.ZodTypeAny>(contextVariable: TName) => z.object({
  contextVariable,
  scope: z.enum(routineSlotSaveScopes),
}).strict();

export type RoutineSlotSaveScope = typeof routineSlotSaveScopes[number];
