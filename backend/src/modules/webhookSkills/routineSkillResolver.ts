import { capabilityNames } from "../../shared/domain/capabilityPolicy.js";
import type { RoutineSkillResolver } from "../routines/public.js";
import type { SkillDefinition } from "../skills/public.js";
import { WEBHOOK_SKILLS_ADAPTER } from "./executor/webhookSkillExecutor.js";

export const webhookRoutineSkillDefinition = (name: string): SkillDefinition => ({
  name,
  displayName: name,
  description: "Webhook skill routed through the skill executor registry.",
  owner: "platform",
  executionClass: "interactive",
  supportedCallers: [],
  requiredCapabilities: [capabilityNames.externalSkills.invoke],
  contractReferences: [],
  execution: { kind: "internal", adapter: WEBHOOK_SKILLS_ADAPTER, enqueue: false },
  diagnostics: {
    defined: true,
    shapeAware: false,
    strategyAware: false,
  },
  steps: [],
});

export class WebhookRoutineSkillResolver implements RoutineSkillResolver {
  private readonly skillNames: Set<string>;

  constructor(skillNames: Iterable<string>, private readonly delegate: RoutineSkillResolver | null = null) {
    this.skillNames = new Set(skillNames);
  }

  resolve(skillName: string): SkillDefinition | null {
    if (this.skillNames.has(skillName)) return webhookRoutineSkillDefinition(skillName);
    return this.delegate?.resolve(skillName) ?? null;
  }
}
