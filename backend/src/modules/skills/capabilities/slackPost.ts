import { z } from "zod";

import {
  SLACK_SKILLS_ADAPTER,
  slackBoundInputsSchema,
  slackExposedInputsSchema,
  slackSkillInputKeys,
  slackSkillOutcomes,
} from "../../slackSkills/public.js";
import type { SkillCapabilityDescriptor } from "../capabilityRegistry.js";

const slackConfigSchema = z
  .object({
    boundInputs: slackBoundInputsSchema.default({}),
    exposedInputs: slackExposedInputsSchema.default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
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
  });

export const slackPostCapability: SkillCapabilityDescriptor<"slack_post", "slack"> = {
  id: "slack_post",
  storedKind: "slack",
  targetKind: "slack_installation",
  enumerateTargets: async () => [],
  inputSchema: {
    source: "static",
    schema: {
      fields: [...slackSkillInputKeys],
    },
  },
  settingsFields: [],
  outcomeVocabulary: slackSkillOutcomes,
  supportedInvocationModes: ["routine_named", "agent_selectable"],
  executorAdapter: SLACK_SKILLS_ADAPTER,
  configSchema: slackConfigSchema,
  validateConfig: (config) => slackConfigSchema.safeParse(config),
};
