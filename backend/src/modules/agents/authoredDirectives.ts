import { z } from "zod";

import { CHAT_TURN_ROUTE, type ChatTurnRoute } from "../../shared/domain/chatTurnRoute.js";
import { defaultAnswerDirectives } from "../directives/public.js";

export const AUTHORED_DIRECTIVE_LIMITS = {
  name: 200,
  action: 4000,
  conditionDescription: 2000,
  description: 1000,
  relationshipName: 200,
  capabilityName: 200,
} as const;

export const authoredDirectiveCriticalities = ["low", "medium", "high"] as const;
export type AuthoredDirectiveCriticality = (typeof authoredDirectiveCriticalities)[number];

export const authoredDirectiveRouteValues = Object.values(CHAT_TURN_ROUTE) as [ChatTurnRoute, ...ChatTurnRoute[]];

const builtInDirectiveNames = new Set(defaultAnswerDirectives.map((directive) => directive.name));

const trimmedText = (maxLength: number) =>
  z.string()
    .trim()
    .min(1)
    .max(maxLength);

const optionalTrimmedText = (maxLength: number) =>
  z.string()
    .trim()
    .min(1)
    .max(maxLength)
    .optional()
    .nullable()
    .transform((value) => value ?? null);

const uniqueTextArray = (maxItemLength: number) =>
  z.array(trimmedText(maxItemLength))
    .optional()
    .default([])
    .transform((values) => [...new Set(values)]);

export const authoredDirectiveConditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("always"),
  }).strict(),
  z.object({
    kind: z.literal("contextual"),
    description: trimmedText(AUTHORED_DIRECTIVE_LIMITS.conditionDescription),
  }).strict(),
]);

export const authoredDirectiveInputSchema = z.object({
  name: trimmedText(AUTHORED_DIRECTIVE_LIMITS.name)
    .refine((name) => !builtInDirectiveNames.has(name), {
      message: "Directive name is reserved by a built-in directive",
    }),
  condition: authoredDirectiveConditionSchema,
  action: trimmedText(AUTHORED_DIRECTIVE_LIMITS.action),
  requiredCapabilities: uniqueTextArray(AUTHORED_DIRECTIVE_LIMITS.capabilityName),
  dependsOn: uniqueTextArray(AUTHORED_DIRECTIVE_LIMITS.relationshipName),
  excludes: uniqueTextArray(AUTHORED_DIRECTIVE_LIMITS.relationshipName),
  routes: z.array(z.enum(authoredDirectiveRouteValues)).optional().default([]).transform((values) => [...new Set(values)]),
  description: optionalTrimmedText(AUTHORED_DIRECTIVE_LIMITS.description),
  metadata: z.record(z.unknown()).optional().default({}),
}).strict();

export type AuthoredDirectiveInput = z.input<typeof authoredDirectiveInputSchema>;

export type NormalizedAuthoredDirectiveInput = z.infer<typeof authoredDirectiveInputSchema>;

export type AuthoredDirectiveCondition = NormalizedAuthoredDirectiveInput["condition"];

export interface AuthoredDirective {
  id: string;
  agentId: string;
  name: string;
  condition: AuthoredDirectiveCondition;
  action: string;
  priority: number | null;
  criticality: AuthoredDirectiveCriticality | null;
  requiredCapabilities: string[];
  dependsOn: string[];
  excludes: string[];
  routes: ChatTurnRoute[];
  description: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthoredDirectiveCapabilityValidationOk {
  ok: true;
}

export interface AuthoredDirectiveCapabilityValidationError {
  ok: false;
  unknown: string[];
}

export type AuthoredDirectiveCapabilityValidationResult =
  | AuthoredDirectiveCapabilityValidationOk
  | AuthoredDirectiveCapabilityValidationError;

export const validateAuthoredDirectiveCapabilities = (
  names: readonly string[],
  registeredCapabilityNames: ReadonlySet<string>,
): AuthoredDirectiveCapabilityValidationResult => {
  const unknown = [...new Set(names)].filter((name) => !registeredCapabilityNames.has(name));
  return unknown.length === 0 ? { ok: true } : { ok: false, unknown };
};
