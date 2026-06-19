import { z } from "zod";

export const slackSkillOutcomes = ["enqueued", "missing_input", "failed"] as const;
export type SlackSkillOutcome = (typeof slackSkillOutcomes)[number];

export const slackSkillInputKeys = ["channelId", "text", "threadTs"] as const;
export type SlackSkillInputKey = (typeof slackSkillInputKeys)[number];

const inputKeySchema = z.enum(slackSkillInputKeys);

export const slackExposedInputSchema = z.object({
  slotBinding: z.string().min(1).optional(),
  required: z.boolean().optional(),
});

export const slackBoundInputsSchema = z.record(inputKeySchema, z.unknown());
export const slackExposedInputsSchema = z.record(inputKeySchema, slackExposedInputSchema);

export interface SlackSkillDefinitionSummary {
  id: string;
  workspaceId: string;
  agentId: string;
  installationId: string;
  skillName: string;
  boundInputs: Record<string, unknown>;
  exposedInputs: Record<string, z.infer<typeof slackExposedInputSchema>>;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}
