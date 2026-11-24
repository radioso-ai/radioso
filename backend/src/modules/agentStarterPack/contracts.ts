import { z } from "zod";

import { authoredDirectiveInputSchema, authoredDirectiveSurfaceValues } from "../agents/public.js";
import { defaultAnswerDirectives } from "../directives/public.js";
import {
  routineDefinitionDraftInputSchema,
  routineValidationResultSchema,
  type RoutineDefinitionDraftInput,
  type RoutineValidationResult,
} from "../routines/public.js";

const STARTER_PACK_LIMITS = {
  purpose: 4_000,
  minDirectives: 1,
  maxDirectives: 6,
  name: 200,
  conditionDescription: 2_000,
  action: 4_000,
  // Kept within the routine draft-assist service's own prose limit, so the procedure can be
  // handed to it unchanged when the pack is turned into a routine definition.
  procedure: 20_000,
} as const;

const reservedDirectiveNames = new Set(defaultAnswerDirectives.map((directive) => directive.name));

const trimmed = (max: number) => z.string().trim().min(1).max(max);

/** The operator's free-text description of what the agent is for, in any language. */
export const starterPackPurposeSchema = trimmed(STARTER_PACK_LIMITS.purpose);

/**
 * One drafted directive: a subset of the authored-directive input contract
 * (`authoredDirectiveInputSchema`), so an accepted draft can be created unchanged by
 * `AuthoredDirectiveService.create`. Model output, not a request: keys outside the subset are
 * dropped rather than refused, at every level.
 */
const starterPackDirectiveDraftSchema = z.object({
  name: trimmed(STARTER_PACK_LIMITS.name).refine((name) => !reservedDirectiveNames.has(name), {
    message: "Directive name is reserved by a built-in directive",
  }),
  condition: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("always") }),
    z.object({
      kind: z.literal("contextual"),
      description: trimmed(STARTER_PACK_LIMITS.conditionDescription),
    }),
  ]),
  action: trimmed(STARTER_PACK_LIMITS.action),
  tags: z.array(trimmed(STARTER_PACK_LIMITS.name)).optional(),
  surfaces: z.array(z.enum(authoredDirectiveSurfaceValues)).optional(),
});

/**
 * The single routine a pack proposes. `procedure` is prose, the input the existing routine
 * draft-assist service turns into a validated routine definition.
 */
const starterPackRoutineDraftSchema = z.object({
  name: trimmed(STARTER_PACK_LIMITS.name),
  procedure: trimmed(STARTER_PACK_LIMITS.procedure),
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
      && directives.length < STARTER_PACK_LIMITS.maxDirectives
      && !directives.some((kept) => kept.name === directive.data.name)
    ) {
      directives.push(directive.data);
    }
  }
  if (directives.length < STARTER_PACK_LIMITS.minDirectives) {
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

const itemKeySchema = z.string().trim().min(1).max(64);

/**
 * One item the user selected from a draft, possibly edited. Validated against the same contracts
 * the directive and routine authoring endpoints use, so apply accepts nothing those would refuse.
 */
const starterPackApplyItemSchema = z.discriminatedUnion("kind", [
  z.object({
    itemKey: itemKeySchema,
    kind: z.literal("directive"),
    // `routes` is internal; the public directive endpoints omit it the same way.
    directive: authoredDirectiveInputSchema.omit({ routes: true }),
  }).strict(),
  z.object({
    itemKey: itemKeySchema,
    kind: z.literal("routine"),
    routine: routineDefinitionDraftInputSchema,
  }).strict(),
]);

/** Body of `POST /api/v1/agents/:agentId/starter-pack/apply`: only the items the user selected. */
export const starterPackApplyRequestSchema = z.object({
  /** Client-chosen key for this apply. Retrying with the same key returns the first result. */
  idempotencyKey: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/u, {
    message: "Use letters, digits, '.', '_', ':' or '-'",
  }),
  items: z.array(starterPackApplyItemSchema).min(1).max(STARTER_PACK_LIMITS.maxDirectives + 1),
}).strict().superRefine((request, context) => {
  const directives = request.items.filter((item) => item.kind === "directive");
  const routines = request.items.filter((item) => item.kind === "routine");
  if (routines.length > 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "A starter pack has at most one routine" });
  }
  if (directives.length > STARTER_PACK_LIMITS.maxDirectives) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["items"],
      message: `A starter pack has at most ${STARTER_PACK_LIMITS.maxDirectives} directives`,
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
