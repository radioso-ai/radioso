import type { SkillDefinition } from "@radioso/skill-contract";

import { capabilityNames } from "../../shared/domain/capabilityPolicy.js";
import { isRoutineNamedSkill } from "../../shared/domain/routineNamedSkill.js";
import { API_REQUEST_SKILLS_ADAPTER } from "./executor/apiRequestSkillExecutor.js";

export interface ApiRequestRoutineSkillRecord {
  skillName: string;
  enabled: boolean;
  invocationMode: string;
  config?: Record<string, unknown>;
}

/** A GET reads; any other method may change something on the target. */
const sendsGet = (config: Record<string, unknown> | undefined): boolean => config?.method === "GET";

const apiRequestRoutineSkillDefinition = (name: string, readOnly: boolean): SkillDefinition => ({
  name,
  displayName: name,
  description: "API request skill routed through the skill executor registry.",
  owner: "platform",
  executionClass: "interactive",
  supportedCallers: [],
  // Matches requiredCapabilitiesForKind("api_request") in agentSkillTurnSkillProvider.ts.
  requiredCapabilities: [capabilityNames.externalSkills.invoke],
  contractReferences: [],
  execution: { kind: "internal", adapter: API_REQUEST_SKILLS_ADAPTER, enqueue: false },
  diagnostics: {
    defined: true,
    shapeAware: false,
    strategyAware: false,
  },
  steps: [],
  // A GET changes nothing outside the conversation, so Test Chat and replays send it for real;
  // every other method is suppressed there like a webhook.
  ...(readOnly ? { readOnly: true } : {}),
});

/**
 * Resolves a routine tool step's `toolRef` to an API request skill. Filters on
 * `enabled && invocationMode === "routine_named"`, the filter the authoring catalog applies, so a
 * name an author can pick is a name this resolver routes. It reads each skill's method only to say
 * whether running it acts outside the conversation; the executor reads the rest. Both read the
 * skills the conversation runs (its release's), which the dispatcher hands the executor, so the
 * method judged read-only here is the method the executor sends.
 *
 * Structurally a `RoutineSkillResolver`; it does not import the routines module, which imports it.
 */
export class ApiRequestRoutineSkillResolver {
  private readonly readOnlyBySkillName: Map<string, boolean>;

  constructor(
    records: Iterable<ApiRequestRoutineSkillRecord>,
    private readonly delegate: { resolve(skillName: string): SkillDefinition | null } | null = null,
  ) {
    this.readOnlyBySkillName = new Map(
      [...records].filter(isRoutineNamedSkill).map((record) => [record.skillName, sendsGet(record.config)]),
    );
  }

  resolve(skillName: string): SkillDefinition | null {
    const readOnly = this.readOnlyBySkillName.get(skillName);
    if (readOnly !== undefined) return apiRequestRoutineSkillDefinition(skillName, readOnly);
    return this.delegate?.resolve(skillName) ?? null;
  }
}
