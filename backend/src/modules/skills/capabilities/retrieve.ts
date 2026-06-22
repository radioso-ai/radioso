import { RETRIEVAL_ANSWER_ADAPTER, retrieveSkillConfigSchema } from "../../retrieval/public.js";
import type { SkillCapabilityDescriptor } from "../capabilityRegistry.js";

export const retrieveCapability: SkillCapabilityDescriptor<"retrieve", "retrieve"> = {
  id: "retrieve",
  storedKind: "retrieve",
  targetKind: "source_scope",
  enumerateTargets: async () => [
    { id: "all", label: "All sources", status: "available" },
  ],
  inputSchema: {
    source: "static",
    schema: {
      fields: ["query"],
    },
  },
  outcomeVocabulary: ["found", "empty"],
  supportedInvocationModes: ["default_answer", "routine_named", "agent_selectable"],
  executorAdapter: RETRIEVAL_ANSWER_ADAPTER,
  configSchema: retrieveSkillConfigSchema,
  validateConfig: (config) => retrieveSkillConfigSchema.safeParse(config),
};
