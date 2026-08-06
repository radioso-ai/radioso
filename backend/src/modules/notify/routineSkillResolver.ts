import type { RoutineSkillResolver } from "../routines/public.js";
import type { SkillDefinition } from "../skills/public.js";
import { NOTIFY_SKILLS_ADAPTER } from "./notifyExecutor.js";

export interface NotifyRoutineSkillRecord {
  skillName: string;
  enabled: boolean;
  invocationMode: string;
}

export const notifyRoutineSkillDefinition = (name: string): SkillDefinition => ({
  name,
  displayName: name,
  description: "Notify skill routed through the skill executor registry.",
  owner: "platform",
  executionClass: "interactive",
  supportedCallers: [],
  // Matches requiredCapabilitiesForKind("notify") in agentSkillTurnSkillProvider.ts:
  // notify has no required capability whether it is dispatched as a turn skill or a
  // routine tool step, so the two invocation paths agree on the same policy.
  requiredCapabilities: [],
  contractReferences: [],
  execution: { kind: "internal", adapter: NOTIFY_SKILLS_ADAPTER, enqueue: false },
  diagnostics: {
    defined: true,
    shapeAware: false,
    strategyAware: false,
  },
  steps: [],
});

/**
 * Resolves a routine tool step's `toolRef` to a notify skill's execution
 * descriptor. Filters on `enabled && invocationMode === "routine_named"` —
 * the same filter `SkillAuthoringCatalogService` applies when it lists notify
 * skills for routine authoring (`skillAuthoringCatalog.ts`), so a name the
 * catalog offers an author is always a name this resolver can route, and vice
 * versa. Modelled on `RetrieveRoutineSkillResolver`, the other resolver that
 * mirrors the catalog's own filter rather than accepting any enabled row.
 */
export class NotifyRoutineSkillResolver implements RoutineSkillResolver {
  private readonly skillNames: Set<string>;

  constructor(
    records: Iterable<NotifyRoutineSkillRecord>,
    private readonly delegate: RoutineSkillResolver | null = null,
  ) {
    this.skillNames = new Set(
      [...records]
        .filter((record) => record.enabled && record.invocationMode === "routine_named")
        .map((record) => record.skillName),
    );
  }

  resolve(skillName: string): SkillDefinition | null {
    if (this.skillNames.has(skillName)) return notifyRoutineSkillDefinition(skillName);
    return this.delegate?.resolve(skillName) ?? null;
  }
}
