import { z } from "zod";

export const slackSkillOutcomes = ["enqueued", "missing_input", "failed"] as const;
export type SlackSkillOutcome = (typeof slackSkillOutcomes)[number];

export const slackSkillInputKeys = ["channelId", "text", "threadTs"] as const;
export type SlackSkillInputKey = (typeof slackSkillInputKeys)[number];

const inputKeySchema = z.enum(slackSkillInputKeys);
const skillNamePattern = /^[a-z][a-z0-9_]*$/u;
const slotBindingPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const trimmedText = (maxLength: number) => z.string().trim().min(1).max(maxLength);

const slackExposedInputSchema = z.object({
  description: trimmedText(1000).optional(),
  slotBinding: trimmedText(120).regex(slotBindingPattern).optional(),
  required: z.boolean().default(true),
}).strict();

export const slackBoundInputsSchema = z.record(inputKeySchema, z.unknown());
export const slackExposedInputsSchema = z.record(inputKeySchema, slackExposedInputSchema);

const validateSlackInputConfig = (
  value: {
    boundInputs?: Partial<Record<SlackSkillInputKey, unknown>>;
    exposedInputs?: Partial<Record<SlackSkillInputKey, unknown>>;
  },
  ctx: z.RefinementCtx,
): void => {
  const boundKeys = Object.keys(value.boundInputs ?? {});
  const exposedKeys = Object.keys(value.exposedInputs ?? {});
  const overlap = boundKeys.filter((key) => exposedKeys.includes(key));
  if (overlap.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["exposedInputs"],
      message: `bound and exposed inputs must be disjoint (overlap: ${overlap.join(", ")})`,
    });
  }
};

export const slackSkillDefinitionCreateSchema = z
  .object({
    skillName: trimmedText(120).regex(skillNamePattern),
    installationId: z.string().uuid(),
    boundInputs: slackBoundInputsSchema.default({}),
    exposedInputs: slackExposedInputsSchema.default({}),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine(validateSlackInputConfig);

export type SlackSkillDefinitionCreateInput = z.infer<typeof slackSkillDefinitionCreateSchema>;

export const slackSkillDefinitionUpdateSchema = z
  .object({
    boundInputs: slackBoundInputsSchema.optional(),
    exposedInputs: slackExposedInputsSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, { message: "At least one field must be provided" })
  .superRefine((value, ctx) => {
    if (value.boundInputs !== undefined || value.exposedInputs !== undefined) {
      validateSlackInputConfig(value, ctx);
    }
  });

export type SlackSkillDefinitionUpdateInput = z.infer<typeof slackSkillDefinitionUpdateSchema>;
export type SlackSkillExposedInput = {
  description?: string;
  slotBinding?: string;
  required?: boolean;
};

export interface SlackSkillDefinitionSummary {
  id: string;
  workspaceId: string;
  agentId: string;
  installationId: string;
  skillName: string;
  boundInputs: Record<string, unknown>;
  exposedInputs: Record<string, SlackSkillExposedInput>;
  enabled: boolean;
  outcomes?: SlackSkillOutcome[];
  createdAt: Date | string;
  updatedAt: Date | string;
}
