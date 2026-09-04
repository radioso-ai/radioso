import { z } from "zod";

import { NOTIFY_SKILLS_ADAPTER } from "../../notify/public.js";
import type { SkillCapabilityDescriptor } from "../capabilityRegistry.js";

const emailSchema = z.string().trim().email().max(320);

const notifyDeliverySchema = z.object({
  recipientEmails: z.array(emailSchema).max(25).default([]),
  webhook: z.union([
    z.object({ url: z.string().trim().url().max(2048) }).strict(),
    z.null(),
  ]).default(null),
}).strict();

export const notifyConfigSchema = z.object({
  delivery: notifyDeliverySchema,
  exposedInputs: z.object({
    message: z.boolean().default(true),
    email: z.boolean().optional(),
  }).strict().default({ message: true }),
}).strict();

export const notifyCapability: SkillCapabilityDescriptor<"notify", "notify"> = {
  id: "notify",
  storedKind: "notify",
  targetKind: "notify_delivery",
  requiresTarget: false,
  enumerateTargets: async () => [],
  inputSchema: {
    source: "static",
    schema: { fields: ["message", "email"], required: ["message"] },
  },
  // Neither field below sets `showValueToCopilot`, and neither should: a webhook URL routinely
  // carries a signed token or capability URL in its query string, and recipient emails are
  // personal data. The operator copilot reader (agent_skills) names both keys to Ray but must
  // never read their values into model context. For the same reason, neither field sets
  // `portable`: an agent-export bundle must never carry a webhook URL or a recipient's email
  // address to another workspace.
  settingsFields: [
    {
      key: "delivery.recipientEmails",
      label: "Recipient emails",
      type: "string_list",
      help: "Email destinations that receive this notification.",
      group: "Delivery",
    },
    {
      key: "delivery.webhook.url",
      label: "Webhook URL",
      type: "text",
      help: "Optional HTTPS endpoint that receives this notification.",
      group: "Delivery",
    },
  ],
  outcomeVocabulary: ["delivered", "failed"],
  supportedInvocationModes: ["routine_named", "agent_selectable"],
  defaultInvocationMode: "routine_named",
  executorAdapter: NOTIFY_SKILLS_ADAPTER,
  configSchema: notifyConfigSchema,
  validateConfig: (config) => notifyConfigSchema.safeParse(config),
};
