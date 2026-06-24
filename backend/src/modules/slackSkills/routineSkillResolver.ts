import { capabilityNames } from "../../shared/domain/capabilityPolicy.js";
import type { RoutineSkillResolver } from "../routines/public.js";
import type { SkillDefinition } from "../skills/public.js";
import { SLACK_SKILLS_ADAPTER } from "./executor/slackEscalationExecutor.js";

export const slackRoutineSkillDefinition = (name: string): SkillDefinition => ({
  name,
  displayName: name,
  description: "Slack skill routed through the skill executor registry.",
  owner: "platform",
  executionClass: "interactive",
  supportedCallers: [],
  requiredCapabilities: [capabilityNames.externalSkills.invoke],
  contractReferences: [],
  execution: { kind: "internal", adapter: SLACK_SKILLS_ADAPTER, enqueue: false },
  diagnostics: {
    defined: true,
    shapeAware: false,
    strategyAware: false,
  },
  steps: [],
});

export class SlackRoutineSkillResolver implements RoutineSkillResolver {
  private readonly skillNames: Set<string>;

  constructor(skillNames: Iterable<string>, private readonly delegate: RoutineSkillResolver | null = null) {
    this.skillNames = new Set(skillNames);
  }

  resolve(skillName: string): SkillDefinition | null {
    if (this.skillNames.has(skillName)) return slackRoutineSkillDefinition(skillName);
    return this.delegate?.resolve(skillName) ?? null;
  }
}
