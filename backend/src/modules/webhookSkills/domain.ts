import { z } from "zod";

const trimmedText = (maxLength: number) => z.string().trim().min(1).max(maxLength);
const skillNamePattern = /^[a-z][a-z0-9_]*$/u;
const payloadKeyPattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;
const slotBindingPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const blockedPayloadKeys = new Set(["__proto__", "constructor", "prototype"]);

export const webhookSkillOutcomes = [
  "delivered",
  "missing_input",
  "destination_not_found",
  "failed",
] as const;
export type WebhookSkillOutcome = (typeof webhookSkillOutcomes)[number];

const payloadKeySchema = z.string().refine(
  (key) => payloadKeyPattern.test(key) && !blockedPayloadKeys.has(key),
  "payload key is not supported",
);

export const webhookSkillExposedPayloadSchema = z
  .object({
    description: trimmedText(1000).optional(),
    slotBinding: trimmedText(120).regex(slotBindingPattern).optional(),
    required: z.boolean().default(true),
  })
  .strict();

export const webhookSkillBoundPayloadSchema = z.record(payloadKeySchema, z.unknown());
export const webhookSkillExposedPayloadMapSchema = z.record(payloadKeySchema, webhookSkillExposedPayloadSchema);

const validateWebhookPayloadConfig = (
  value: {
    boundPayload?: Record<string, unknown>;
    exposedPayload?: Record<string, unknown>;
  },
  ctx: z.RefinementCtx,
): void => {
  const boundKeys = Object.keys(value.boundPayload ?? {});
  const exposedKeys = Object.keys(value.exposedPayload ?? {});
  const overlap = boundKeys.filter((key) => exposedKeys.includes(key));
  if (overlap.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["exposedPayload"],
      message: `bound and exposed payload fields must be disjoint (overlap: ${overlap.join(", ")})`,
    });
  }
};

export const webhookSkillDefinitionCreateSchema = z
  .object({
    skillName: trimmedText(120).regex(skillNamePattern),
    destinationId: z.string().uuid(),
    boundPayload: webhookSkillBoundPayloadSchema.default({}),
    exposedPayload: webhookSkillExposedPayloadMapSchema.default({}),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine(validateWebhookPayloadConfig);

export type WebhookSkillDefinitionCreateInput = z.infer<typeof webhookSkillDefinitionCreateSchema>;

export const webhookSkillDefinitionUpdateSchema = z
  .object({
    boundPayload: webhookSkillBoundPayloadSchema.optional(),
    exposedPayload: webhookSkillExposedPayloadMapSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, { message: "At least one field must be provided" })
  .superRefine((value, ctx) => {
    if (value.boundPayload !== undefined || value.exposedPayload !== undefined) {
      validateWebhookPayloadConfig(value, ctx);
    }
  });

export type WebhookSkillDefinitionUpdateInput = z.infer<typeof webhookSkillDefinitionUpdateSchema>;

export interface WebhookSkillDefinitionSummary {
  id: string;
  workspaceId: string;
  agentId: string;
  destinationId: string;
  skillName: string;
  boundPayload: Record<string, unknown>;
  exposedPayload: Record<string, z.infer<typeof webhookSkillExposedPayloadSchema>>;
  enabled: boolean;
  outcomes: WebhookSkillOutcome[];
  createdAt: string;
  updatedAt: string;
}
