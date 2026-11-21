import {
  API_REQUEST_SKILLS_ADAPTER,
  apiRequestSkillConfigSchema,
  apiRequestSkillOutcomes,
} from "../../apiRequestSkills/public.js";
import type { SkillCapabilityDescriptor } from "../capabilityRegistry.js";

/**
 * Sends one HTTP request through a workspace API connection and returns the response fields the
 * author declared as outputs. Routines run it by name; its inputs are the exposed params, so the
 * static field list is empty. No settings field shows a value to the copilot: a bound param can
 * carry an account id or a key the author typed, so the copilot sees config key names only.
 */
export const apiRequestCapability: SkillCapabilityDescriptor<"api_request", "api_request"> = {
  id: "api_request",
  storedKind: "api_request",
  targetKind: "api_connection",
  enumerateTargets: async () => [],
  inputSchema: {
    source: "static",
    schema: {
      fields: [],
      required: [],
    },
  },
  settingsFields: [],
  outcomeVocabulary: apiRequestSkillOutcomes,
  supportedInvocationModes: ["routine_named"],
  defaultInvocationMode: "routine_named",
  executorAdapter: API_REQUEST_SKILLS_ADAPTER,
  configSchema: apiRequestSkillConfigSchema,
  validateConfig: (config) => apiRequestSkillConfigSchema.safeParse(config),
};
