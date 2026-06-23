import { z } from "zod";

import {
  EXTERNAL_SKILLS_ADAPTER,
  boundParamsSchema,
  exposedParamsSchema,
} from "../../externalSkills/public.js";
import type { SkillCapabilityDescriptor } from "../capabilityRegistry.js";

const outcomeName = z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9_]*$/u);

const mcpToolConfigSchema = z
  .object({
    toolName: z.string().trim().min(1).max(200),
    boundParams: boundParamsSchema.default({}),
    exposedParams: exposedParamsSchema.default({}),
    declaredOutcomes: z.array(outcomeName).nullable().optional(),
    outcomeMap: z.record(outcomeName).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const boundKeys = Object.keys(value.boundParams ?? {});
    const exposedKeys = Object.keys(value.exposedParams ?? {});
    const overlap = boundKeys.filter((key) => exposedKeys.includes(key));
    if (overlap.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exposedParams"],
        message: `bound and exposed params must be disjoint (overlap: ${overlap.join(", ")})`,
      });
    }
  });

export const mcpToolCapability: SkillCapabilityDescriptor<"mcp_tool", "external_mcp"> = {
  id: "mcp_tool",
  storedKind: "external_mcp",
  targetKind: "mcp_connection",
  enumerateTargets: async () => [],
  inputSchema: { source: "discovered" },
  settingsFields: [],
  outcomeVocabulary: ["completed", "failed"],
  supportedInvocationModes: ["routine_named", "agent_selectable"],
  defaultInvocationMode: "routine_named",
  executorAdapter: EXTERNAL_SKILLS_ADAPTER,
  configSchema: mcpToolConfigSchema,
  validateConfig: (config) => mcpToolConfigSchema.safeParse(config),
};
