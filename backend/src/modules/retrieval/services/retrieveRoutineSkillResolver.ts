import type { RoutineSkillResolver } from "../../routines/public.js";
import type { SkillDefinition } from "../../skills/public.js";
import { RETRIEVAL_ANSWER_ADAPTER } from "./retrievalAnswerSkillExecutor.js";

export interface RetrieveRoutineSkillRecord {
  skillName: string;
  enabled: boolean;
  invocationMode: string;
  config?: Record<string, unknown>;
}

export const retrieveRoutineSkillDefinition = (
  name: string,
  config: Record<string, unknown>,
): SkillDefinition => ({
  name,
  displayName: name,
  description: "Retrieve skill routed through the skill executor registry.",
  owner: "retrieval",
  executionClass: "interactive",
  supportedCallers: [],
  requiredCapabilities: ["retrieval.answer"],
  contractReferences: [],
  execution: { kind: "internal", adapter: RETRIEVAL_ANSWER_ADAPTER, enqueue: false },
  diagnostics: {
    defined: true,
    shapeAware: true,
    strategyAware: true,
  },
  steps: [],
  outcomes: [
    { name: "found", displayName: "Found", status: "completed", groundedAnswer: true },
    { name: "empty", displayName: "Empty", status: "completed", groundedAnswer: true },
  ],
  metadata: { retrieveConfig: config },
} as SkillDefinition);

export class RetrieveRoutineSkillResolver implements RoutineSkillResolver {
  private readonly skills = new Map<string, Record<string, unknown>>();

  constructor(
    records: Iterable<RetrieveRoutineSkillRecord>,
    private readonly delegate: RoutineSkillResolver | null = null,
  ) {
    for (const record of records) {
      if (record.enabled && record.invocationMode === "routine_named") {
        this.skills.set(record.skillName, record.config ?? {});
      }
    }
  }

  resolve(skillName: string): SkillDefinition | null {
    const config = this.skills.get(skillName);
    if (config) {
      return retrieveRoutineSkillDefinition(skillName, config);
    }
    return this.delegate?.resolve(skillName) ?? null;
  }
}
