import { z } from "zod";

import {
  webhookSkillBoundPayloadSchema,
  webhookSkillExposedPayloadMapSchema,
  webhookSkillOutcomes,
} from "../../webhookSkills/domain.js";
import { WEBHOOK_SKILLS_ADAPTER } from "../../webhookSkills/executor/webhookSkillExecutor.js";
import type { SkillCapabilityDescriptor } from "../capabilityRegistry.js";

const webhookConfigSchema = z
  .object({
    boundPayload: webhookSkillBoundPayloadSchema.default({}),
    exposedPayload: webhookSkillExposedPayloadMapSchema.default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
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
  });

export const webhookCallCapability: SkillCapabilityDescriptor<"webhook_call", "webhook"> = {
  id: "webhook_call",
  storedKind: "webhook",
  targetKind: "webhook_destination",
  enumerateTargets: async () => [],
  inputSchema: {
    source: "static",
    schema: {
      fields: ["payload"],
    },
  },
  outcomeVocabulary: webhookSkillOutcomes,
  supportedInvocationModes: ["routine_named", "agent_selectable"],
  executorAdapter: WEBHOOK_SKILLS_ADAPTER,
  configSchema: webhookConfigSchema,
  validateConfig: (config) => webhookConfigSchema.safeParse(config),
};
