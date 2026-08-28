import { z } from "zod";

import {
  CUSTOMER_EMAIL_SKILLS_ADAPTER,
  customerEmailBoundInputsSchema,
  customerEmailExposedInputsSchema,
  customerEmailSkillModes,
  customerEmailSkillOutcomes,
  requiredCustomerEmailSkillInputs,
} from "../../customerEmail/public.js";
import type { SkillCapabilityDescriptor } from "../capabilityRegistry.js";

const DEFAULT_EMAIL_SKILL_MODE = "draft";

const emailConfigSchema = z
  .object({
    mode: z.enum(customerEmailSkillModes).default(DEFAULT_EMAIL_SKILL_MODE),
    boundInputs: customerEmailBoundInputsSchema.default({}),
    exposedInputs: customerEmailExposedInputsSchema.default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    const boundKeys = Object.keys(value.boundInputs ?? {});
    const exposedKeys = Object.keys(value.exposedInputs ?? {});
    const allKeys = new Set([...boundKeys, ...exposedKeys]);
    const overlap = boundKeys.filter((key) => exposedKeys.includes(key));
    if (overlap.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exposedInputs"],
        message: `bound and exposed inputs must be disjoint (overlap: ${overlap.join(", ")})`,
      });
    }
    for (const required of requiredCustomerEmailSkillInputs) {
      if (!allKeys.has(required)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["boundInputs"],
          message: `${required} must be bound or exposed`,
        });
      }
    }
    if (!allKeys.has("bodyText") && !allKeys.has("bodyHtml")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["boundInputs"],
        message: "bodyText or bodyHtml must be bound or exposed",
      });
    }
  });

export const emailCapability: SkillCapabilityDescriptor<"email", "customer_email"> = {
  id: "email",
  storedKind: "customer_email",
  targetKind: "customer_email_connection",
  enumerateTargets: async () => [],
  inputSchema: {
    source: "static",
    schema: {
      fields: ["to", "cc", "subject", "bodyText", "bodyHtml", "replyTo"],
      // The body is a one-of (bodyText OR bodyHtml) enforced by configSchema's
      // superRefine, so neither is unconditionally required here — forcing
      // bodyText would block a valid bodyHtml-only email skill in the form.
      required: [...requiredCustomerEmailSkillInputs],
    },
  },
  settingsFields: [
    {
      key: "mode",
      label: "Mode",
      type: "select",
      defaultValue: DEFAULT_EMAIL_SKILL_MODE,
      options: [
        { value: "draft", label: "Draft" },
        { value: "send", label: "Send" },
      ],
      help: "Choose whether the skill drafts an email or sends it directly.",
      showValueToCopilot: true,
    },
  ],
  outcomeVocabulary: customerEmailSkillOutcomes,
  supportedInvocationModes: ["routine_named", "agent_selectable"],
  defaultInvocationMode: "routine_named",
  executorAdapter: CUSTOMER_EMAIL_SKILLS_ADAPTER,
  configSchema: emailConfigSchema,
  validateConfig: (config) => emailConfigSchema.safeParse(config),
};
