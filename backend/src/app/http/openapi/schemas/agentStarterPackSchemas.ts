import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import {
  starterPackAppliedDirectiveSchema,
  starterPackAppliedRoutineSchema,
  starterPackDraftRequestSchema,
} from "../../../../modules/agentStarterPack/public.js";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

/**
 * The starter pack items reuse the directive and routine authoring schemas, so a suggestion is
 * documented as exactly what the directive and routine create endpoints accept. Must run after
 * `registerAgentSchemas`, which registers those.
 */
export const registerAgentStarterPackSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const itemKey = z.string().min(1).max(64).openapi({ description: "Identifies the suggestion within one draft; send it back unchanged when applying." });
  const conflict = z.enum(["name_exists"]).nullable().openapi({
    description: "name_exists when the agent already has a directive or routine with this name. Applying a pack that includes it is refused with 409 starter_pack_name_conflict; nothing existing is ever overwritten.",
  });

  schemas.StarterPackDraftRequestSchema = registry.register("StarterPackDraftRequest", starterPackDraftRequestSchema.openapi({
    description: "The agent's purpose in plain language, in any language. The suggestions are written in the language it is detected to be in.",
  }));

  schemas.StarterPackDraftResponseSchema = registry.register("StarterPackDraftResponse", z.object({
    outputLanguage: z.string().nullable().openapi({ description: "The detected language label, such as German, or null when it could not be detected and the suggestions mirror the purpose's language." }),
    items: z.array(z.union([
      z.object({
        itemKey,
        kind: z.literal("directive"),
        directive: schemas.AuthoredDirectiveCreateRequestSchema,
        conflict,
      }),
      z.object({
        itemKey,
        kind: z.literal("routine"),
        routine: schemas.RoutineDefinitionCreateRequestSchema,
        procedure: z.string().openapi({ description: "The plain-language procedure the routine definition was drafted from." }),
        validation: schemas.RoutineValidationResultSchema,
        conflict,
      }),
    ])).openapi({ description: "One to six directives and exactly one routine. Nothing is saved." }),
  }));

  schemas.StarterPackApplyRequestSchema = registry.register("StarterPackApplyRequest", z.object({
    idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/u).openapi({
      description: "Client-chosen key for this apply. Sending the same key with the same items returns the first result instead of creating anything again; the same key with different items is refused.",
    }),
    items: z.array(z.union([
      z.object({ itemKey, kind: z.literal("directive"), directive: schemas.AuthoredDirectiveCreateRequestSchema }).strict(),
      z.object({ itemKey, kind: z.literal("routine"), routine: schemas.RoutineDefinitionCreateRequestSchema }).strict(),
    ])).min(1).max(7).openapi({
      description: "Only the items the user selected, possibly edited: at most six directives and one routine, with unique item keys and directive names.",
    }),
  }).strict());

  // Each created directive carries its coherence verdict: whether it can be followed together with
  // the agent's other directives, the built-ins, and the pack's earlier directives. It is advisory
  // and never blocks the apply; a verdict whose check could not run says so in its rationale. The
  // routine item carries its validation as the routine authoring endpoints report it.
  schemas.StarterPackApplyResponseSchema = registry.register("StarterPackApplyResponse", z.object({
    applyId: z.string(),
    items: z.array(z.union([
      starterPackAppliedDirectiveSchema,
      starterPackAppliedRoutineSchema.extend({ validation: schemas.RoutineValidationResultSchema }),
    ])),
    replayed: z.boolean().openapi({ description: "True when this request repeated an earlier one with the same key; nothing new was created." }),
  }).strict().openapi({
    description: "Created items with their ids. Each directive item includes its advisory coherence verdict; a conflict's directiveId names the directive it conflicts with, including one created by the same apply. The routine item includes its validation, as the routine create endpoint returns it: a routine that is not ok is saved, and publishing the agent's draft is refused until it is fixed or disabled.",
  }));
};
