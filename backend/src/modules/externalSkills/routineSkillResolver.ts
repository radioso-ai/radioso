import type { RoutineSkillResolver } from "../routines/public.js";
import type { SkillDefinition } from "../skills/public.js";
import { capabilityNames } from "../../shared/domain/capabilityPolicy.js";
import { EXTERNAL_SKILLS_ADAPTER } from "./executor/mcpSkillExecutor.js";

export const externalSkillRoutineDefinition = (name: string): SkillDefinition => ({
  name,
  displayName: name,
  description: "External skill routed through the skill executor registry.",
  owner: "mcp",
  executionClass: "interactive",
  supportedCallers: [],
  requiredCapabilities: [capabilityNames.externalSkills.invoke],
  contractReferences: [],
  execution: { kind: "internal", adapter: EXTERNAL_SKILLS_ADAPTER, enqueue: false },
  diagnostics: {
    defined: true,
    shapeAware: false,
    strategyAware: false,
  },
  steps: [],
});

/**
 * Resolves routine skill names to the external-skills executor descriptor.
 * This is only the routing half; McpSkillExecutor enforces per-agent existence
 * and enabled-state checks, failing closed for non-authored skill names.
 */
export class ExternalSkillRoutineSkillResolver implements RoutineSkillResolver {
  resolve(skillName: string): SkillDefinition {
    return externalSkillRoutineDefinition(skillName);
  }
}
