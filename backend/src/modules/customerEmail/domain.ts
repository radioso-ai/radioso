import { z } from "zod";

const trimmedText = (maxLength: number) => z.string().trim().min(1).max(maxLength);
const optionalTrimmedText = (maxLength: number) =>
  z.preprocess((value) => (value === "" ? null : value), z.string().trim().min(1).max(maxLength).nullable().optional());

export const customerEmailConnectionStatuses = ["authorized", "disabled", "needs_reauth", "error"] as const;
export type CustomerEmailConnectionStatus = (typeof customerEmailConnectionStatuses)[number];

export const customerEmailHealthStatuses = ["ok", "failed", "unknown"] as const;
export type CustomerEmailHealthStatus = (typeof customerEmailHealthStatuses)[number];

export const customerEmailConnectionCreateSchema = z
  .object({
    oauthConnectionId: z.string().uuid(),
    displayName: trimmedText(160),
    senderEmail: z.string().trim().email().max(320),
    senderName: optionalTrimmedText(160),
    replyToEmail: optionalTrimmedText(320).pipe(z.string().email().max(320).nullable().optional()),
  })
  .strict();

export type CustomerEmailConnectionCreateInput = z.infer<typeof customerEmailConnectionCreateSchema>;

export const customerEmailConnectionUpdateSchema = z
  .object({
    displayName: trimmedText(160).optional(),
    senderEmail: z.string().trim().email().max(320).optional(),
    senderName: optionalTrimmedText(160),
    replyToEmail: optionalTrimmedText(320).pipe(z.string().email().max(320).nullable().optional()),
    disabled: z.boolean().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, { message: "At least one field must be provided" });

export type CustomerEmailConnectionUpdateInput = z.infer<typeof customerEmailConnectionUpdateSchema>;

export interface CustomerEmailConnectionSummary {
  id: string;
  workspaceId: string;
  oauthConnectionId: string;
  provider: string;
  displayName: string;
  senderEmail: string;
  senderName: string | null;
  replyToEmail: string | null;
  status: CustomerEmailConnectionStatus;
  lastHealthStatus: CustomerEmailHealthStatus | null;
  lastHealthCheckedAt: string | null;
  lastErrorCode: string | null;
  updatedAt: string;
}

export const customerEmailSkillModes = ["draft", "send"] as const;
export type CustomerEmailSkillMode = (typeof customerEmailSkillModes)[number];

export const customerEmailSkillOutcomes = [
  "drafted",
  "sent",
  "missing_input",
  "disabled_connection",
  "needs_reauth",
  "provider_rejected",
  "failed",
] as const;
export type CustomerEmailSkillOutcome = (typeof customerEmailSkillOutcomes)[number];

export const customerEmailSkillInputKeys = ["to", "cc", "subject", "bodyText", "bodyHtml", "replyTo"] as const;
export type CustomerEmailSkillInputKey = (typeof customerEmailSkillInputKeys)[number];

export const requiredCustomerEmailSkillInputs = ["to", "subject"] as const;

const skillNamePattern = /^[a-z][a-z0-9_]*$/u;
const slotBindingPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const allowedInputKeySet = new Set<string>(customerEmailSkillInputKeys);
const blockedInputKeys = new Set(["__proto__", "constructor", "prototype"]);

export const customerEmailExposedInputSchema = z
  .object({
    description: trimmedText(1000).optional(),
    slotBinding: trimmedText(120).regex(slotBindingPattern).optional(),
  })
  .strict();

const inputKeySchema = z.string().refine(
  (key) => allowedInputKeySet.has(key) && !blockedInputKeys.has(key),
  "input key is not supported",
);

export const customerEmailBoundInputsSchema = z.record(inputKeySchema, z.unknown());
export const customerEmailExposedInputsSchema = z.record(inputKeySchema, customerEmailExposedInputSchema);

const validateEmailSkillInputs = (
  value: {
    boundInputs?: Record<string, unknown>;
    exposedInputs?: Record<string, unknown>;
  },
  ctx: z.RefinementCtx,
): void => {
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
};

export const customerEmailSkillDefinitionCreateSchema = z
  .object({
    skillName: trimmedText(120).regex(skillNamePattern),
    connectionId: z.string().uuid(),
    mode: z.enum(customerEmailSkillModes).default("draft"),
    boundInputs: customerEmailBoundInputsSchema.default({}),
    exposedInputs: customerEmailExposedInputsSchema.default({}),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine(validateEmailSkillInputs);

export type CustomerEmailSkillDefinitionCreateInput = z.infer<typeof customerEmailSkillDefinitionCreateSchema>;

export const customerEmailSkillDefinitionUpdateSchema = z
  .object({
    mode: z.enum(customerEmailSkillModes).optional(),
    boundInputs: customerEmailBoundInputsSchema.optional(),
    exposedInputs: customerEmailExposedInputsSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, { message: "At least one field must be provided" })
  .superRefine((value, ctx) => {
    if (value.boundInputs !== undefined || value.exposedInputs !== undefined) {
      validateEmailSkillInputs(value, ctx);
    }
  });

export type CustomerEmailSkillDefinitionUpdateInput = z.infer<typeof customerEmailSkillDefinitionUpdateSchema>;

export interface CustomerEmailSkillDefinitionSummary {
  id: string;
  workspaceId: string;
  agentId: string;
  connectionId: string;
  skillName: string;
  mode: CustomerEmailSkillMode;
  boundInputs: Record<string, unknown>;
  exposedInputs: Record<string, z.infer<typeof customerEmailExposedInputSchema>>;
  enabled: boolean;
  outcomes: CustomerEmailSkillOutcome[];
  createdAt: string;
  updatedAt: string;
}

export const emailSkillActivityQuerySchema = z
  .object({
    agentId: z.string().uuid().optional(),
    connectionId: z.string().uuid().optional(),
    skillDefinitionId: z.string().uuid().optional(),
    outcome: z.enum(customerEmailSkillOutcomes).optional(),
    createdFrom: z.string().datetime().optional(),
    createdTo: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export interface EmailSkillRecipientSummary {
  toCount: number;
  ccCount: number;
  domains: string[];
  redactedRecipients: string[];
}

export interface EmailSkillActivitySummary {
  id: string;
  workspaceId: string;
  agentId: string;
  routineId: string | null;
  conversationId: string | null;
  skillDefinitionId: string;
  connectionId: string;
  skillName: string;
  mode: CustomerEmailSkillMode;
  outcome: CustomerEmailSkillOutcome;
  recipientSummary: EmailSkillRecipientSummary;
  providerMessageId: string | null;
  errorCode: string | null;
  createdAt: string;
}
