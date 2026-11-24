import { z } from "zod";

import { authoredDirectiveInputSchema, authoredDirectiveSurfaceValues } from "../agents/public.js";
import {
  routineDefinitionDraftInputSchema,
  routineValidationResultSchema,
  type RoutineDefinitionDraftInput,
  type RoutineValidationResult,
} from "../routines/public.js";

/** A pack's own limits. Every directive and routine field limit is the owning contract's. */
export const STARTER_PACK_MAX_DIRECTIVES = 6;
const STARTER_PACK_LIMITS = {
  purpose: 4_000,
  // Kept within the routine draft-assist service's own prose limit, so the procedure can be
  // handed to it unchanged when the pack is turned into a routine definition.
  procedure: 20_000,
} as const;

const nonEmpty = () => z.string().trim().min(1);

/** The operator's free-text description of what the agent is for, in any language. */
export const starterPackPurposeSchema = nonEmpty().max(STARTER_PACK_LIMITS.purpose);

/**
 * A directive as apply accepts it: the authored-directive contract the directive create endpoint
 * uses, without the internal `routes`, which the public directive endpoints omit the same way.
 */
const starterPackDirectiveInputSchema = authoredDirectiveInputSchema.omit({ routes: true });

/**
 * The fields a drafted directive may carry: a subset of the authored-directive contract. Model
 * output, not a request: keys outside the subset are dropped rather than refused, at every level.
 * Limits and the built-in-name rule are not repeated here; every kept directive must also pass
 * `starterPackDirectiveInputSchema`, so a draft never suggests a directive apply would refuse.
 */
const starterPackDirectiveDraftSchema = z.object({
  name: nonEmpty(),
  condition: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("always") }),
    z.object({ kind: z.literal("contextual"), description: nonEmpty() }),
  ]),
  action: nonEmpty(),
  tags: z.array(nonEmpty()).optional(),
  surfaces: z.array(z.enum(authoredDirectiveSurfaceValues)).optional(),
});

/**
 * The single routine a pack proposes. `procedure` is prose, the input the existing routine
 * draft-assist service turns into a validated routine definition. The name is checked as the
 * routine create contract checks it.
 */
const starterPackRoutineDraftSchema = z.object({
  name: routineDefinitionDraftInputSchema.shape.name,
  procedure: nonEmpty().max(STARTER_PACK_LIMITS.procedure),
});

/** The model's answer before its directives are read one by one. */
const starterPackDraftModelOutputSchema = z.object({
  directives: z.array(z.unknown()),
  routine: starterPackRoutineDraftSchema,
});

export type StarterPackDirectiveDraft = z.infer<typeof starterPackDirectiveDraftSchema>;

interface StarterPackDraftModelOutput {
  directives: StarterPackDirectiveDraft[];
  routine: z.infer<typeof starterPackRoutineDraftSchema>;
}

/**
 * Reads the model's answer one directive at a time, so one bad suggestion costs only itself.
 * Unknown keys are ignored; a directive that is invalid, takes a reserved name, or repeats an
 * earlier name is dropped; directives past the maximum are cut. Null only when the routine is
 * missing or invalid, or no directive is left.
 */
export const parseStarterPackDraftModelOutput = (
  value: unknown,
): { draft: StarterPackDraftModelOutput; droppedDirectiveCount: number } | null => {
  const output = starterPackDraftModelOutputSchema.safeParse(value);
  if (!output.success) {
    return null;
  }
  const directives: StarterPackDirectiveDraft[] = [];
  for (const candidate of output.data.directives) {
    const directive = starterPackDirectiveDraftSchema.safeParse(candidate);
    if (
      directive.success
      && starterPackDirectiveInputSchema.safeParse(directive.data).success
      && directives.length < STARTER_PACK_MAX_DIRECTIVES
      && !directives.some((kept) => kept.name === directive.data.name)
    ) {
      directives.push(directive.data);
    }
  }
  if (directives.length === 0) {
    return null;
  }
  return {
    draft: { directives, routine: output.data.routine },
    droppedDirectiveCount: output.data.directives.length - directives.length,
  };
};

export interface StarterPackDraft extends StarterPackDraftModelOutput {
  /** The detected language label (for example "German"), or null when detection gave no usable answer. */
  outputLanguage: string | null;
}

/** Body of `POST /api/v1/agents/:agentId/starter-pack/draft`. */
export const starterPackDraftRequestSchema = z.object({
  purpose: starterPackPurposeSchema,
}).strict();

/**
 * Set when a suggestion's name is already taken on the agent. Applying a pack that includes it is
 * refused with 409 `starter_pack_name_conflict`; nothing existing is ever overwritten.
 */
export type StarterPackItemConflict = "name_exists" | null;

export type StarterPackDraftItem =
  | {
    itemKey: string;
    kind: "directive";
    directive: StarterPackDirectiveDraft;
    conflict: StarterPackItemConflict;
  }
  | {
    itemKey: string;
    kind: "routine";
    /** A routine definition draft, as the routine authoring endpoints accept it. */
    routine: RoutineDefinitionDraftInput;
    /** The plain-language procedure the routine definition was drafted from. */
    procedure: string;
    validation: RoutineValidationResult;
    conflict: StarterPackItemConflict;
  };

/**
 * Response of the draft endpoint: reviewable suggestions, nothing saved. `items` always holds
 * exactly one routine item.
 */
export interface StarterPackDraftResponse {
  outputLanguage: string | null;
  items: StarterPackDraftItem[];
}

export const starterPackItemKeySchema = z.string().trim().min(1).max(64);

/** Client-chosen key for an apply. Retrying with the same key returns the first result. */
export const starterPackIdempotencyKeySchema = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/u, {
  message: "Use letters, digits, '.', '_', ':' or '-'",
});

/** At most the maximum number of directives plus the one routine. */
export const STARTER_PACK_MAX_APPLY_ITEMS = STARTER_PACK_MAX_DIRECTIVES + 1;

/**
 * One item the user selected from a draft, possibly edited. Validated against the same contracts
 * the directive and routine authoring endpoints use, so apply accepts nothing those would refuse.
 */
const starterPackApplyItemSchema = z.discriminatedUnion("kind", [
  z.object({
    itemKey: starterPackItemKeySchema,
    kind: z.literal("directive"),
    directive: starterPackDirectiveInputSchema,
  }).strict(),
  z.object({
    itemKey: starterPackItemKeySchema,
    kind: z.literal("routine"),
    routine: routineDefinitionDraftInputSchema,
  }).strict(),
]);

/** Body of `POST /api/v1/agents/:agentId/starter-pack/apply`: only the items the user selected. */
export const starterPackApplyRequestSchema = z.object({
  idempotencyKey: starterPackIdempotencyKeySchema,
  items: z.array(starterPackApplyItemSchema).min(1).max(STARTER_PACK_MAX_APPLY_ITEMS),
}).strict().superRefine((request, context) => {
  const directives = request.items.filter((item) => item.kind === "directive");
  const routines = request.items.filter((item) => item.kind === "routine");
  if (routines.length > 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "A starter pack has at most one routine" });
  }
  if (directives.length > STARTER_PACK_MAX_DIRECTIVES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["items"],
      message: `A starter pack has at most ${STARTER_PACK_MAX_DIRECTIVES} directives`,
    });
  }
  const itemKeys = request.items.map((item) => item.itemKey);
  if (new Set(itemKeys).size !== itemKeys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "Item keys must be unique" });
  }
  const directiveNames = directives.map((item) => item.directive.name);
  if (new Set(directiveNames).size !== directiveNames.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "Directive names must be unique" });
  }
});

export type StarterPackApplyRequest = z.infer<typeof starterPackApplyRequestSchema>;
export type StarterPackApplyItem = StarterPackApplyRequest["items"][number];

/** The directive coherence verdict, as `AuthoredDirectiveService` reports it. Advisory: it never blocks a save. */
const starterPackCoherenceVerdictSchema = z.object({
  coherent: z.boolean(),
  conflicts: z.array(z.object({
    directiveId: z.string().optional(),
    directiveName: z.string(),
    reason: z.string(),
  }).strict()),
  rationale: z.string(),
}).strict();

export const starterPackAppliedDirectiveSchema = z.object({
  itemKey: z.string(),
  kind: z.literal("directive"),
  id: z.string(),
  name: z.string(),
  coherence: starterPackCoherenceVerdictSchema,
}).strict();

export const starterPackAppliedRoutineSchema = z.object({
  itemKey: z.string(),
  kind: z.literal("routine"),
  id: z.string(),
  name: z.string(),
  /** The created routine's validation, in the shape the routine authoring endpoints return it. */
  validation: routineValidationResultSchema,
}).strict();

/** A created item, as stored with the idempotency record and returned on every replay. */
const starterPackAppliedItemSchema = z.discriminatedUnion("kind", [
  starterPackAppliedDirectiveSchema,
  starterPackAppliedRoutineSchema,
]);

export const starterPackApplyResultSchema = z.object({
  applyId: z.string(),
  items: z.array(starterPackAppliedItemSchema),
}).strict();

export type StarterPackAppliedItem = z.infer<typeof starterPackAppliedItemSchema>;
export type StarterPackCoherenceVerdict = z.infer<typeof starterPackCoherenceVerdictSchema>;
export type StarterPackApplyResult = z.infer<typeof starterPackApplyResultSchema>;

export interface StarterPackApplyResponse extends StarterPackApplyResult {
  /** True when this request repeated an earlier one with the same key and nothing new was created. */
  replayed: boolean;
}
