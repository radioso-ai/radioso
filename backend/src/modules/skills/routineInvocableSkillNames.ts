import type { AgentSkillKind, AgentSkillRepositoryPort, AgentSkillSpine } from "../agentSkills/public.js";

/**
 * The agent-skill kinds a routine step may invoke **by name** without the authoring
 * catalog listing them.
 *
 * Each of these three kinds has a routine skill resolver keyed on a flat list of the
 * agent's *enabled* skill names, with no invocation-mode filter
 * (`WebhookRoutineSkillResolver`, `CustomerEmailRoutineSkillResolver`,
 * `SlackRoutineSkillResolver`). The authoring catalog, by contrast, offers only
 * `routine_named` skills — so an enabled `agent_selectable` webhook or Slack skill is
 * routable at runtime and absent from the catalog. That difference is the entire reason
 * this supplement exists.
 *
 * Three kinds are deliberately absent, and each exclusion is the direction that keeps
 * validation from accepting a name runtime will not route:
 *
 * - **`retrieve` and `notify`.** `RetrieveRoutineSkillResolver` and
 *   `NotifyRoutineSkillResolver` each apply their own
 *   `enabled && invocationMode === "routine_named"` filter — exactly the filter the
 *   authoring catalog already applies for that kind. Listing either kind here would
 *   widen validation past runtime, admitting an `agent_selectable` retrieve or notify
 *   skill that no routine step can actually dispatch.
 * - **`external_mcp`.** It has no name-keyed routine resolver. External MCP skills
 *   reach the catalog through their own enabled-only source, and the tail
 *   `ExternalSkillRoutineSkillResolver` resolves *any* string, deferring the real
 *   allow-list to the executor. A resolver that accepts everything states nothing about
 *   what is legal, so it must not be mirrored into a validation allow-list.
 */
export const routineNameDispatchedSkillKinds = ["webhook", "customer_email", "slack"] as const;

export type RoutineNameDispatchedSkillKind = (typeof routineNameDispatchedSkillKinds)[number];

/** Skill names grouped by kind, one list per runtime resolver in the chain. */
export type RoutineInvocableSkillNamesByKind = Readonly<Record<RoutineNameDispatchedSkillKind, readonly string[]>>;

export interface RoutineInvocableSkillNamesContext {
  readonly workspaceId: string;
  readonly agentId: string;
}

/**
 * The skill names a routine may invoke beyond those the authoring catalog lists.
 *
 * Two shapes over **one** derivation, because the two consumers genuinely need different
 * shapes and the thing that must not diverge is the rule, not the return type:
 *
 * - `listForAgent` — one flat set, for routine publish validation and design-time config
 *   analysis, which ask "is this name legal?".
 * - `listByKindForAgent` — grouped, for the runtime resolver chain, where each resolver
 *   mints a kind-specific skill definition and therefore needs its own list.
 */
export interface RoutineInvocableSkillNames {
  listForAgent(context: RoutineInvocableSkillNamesContext): Promise<readonly string[]>;
  listByKindForAgent(context: RoutineInvocableSkillNamesContext): Promise<RoutineInvocableSkillNamesByKind>;
}

const dispatchedKinds = new Set<string>(routineNameDispatchedSkillKinds);

const isNameDispatched = (skill: AgentSkillSpine): boolean =>
  skill.enabled && dispatchedKinds.has(skill.kind);

/**
 * Derives the supplement from the shared `agent_skills` spine.
 *
 * One read rather than one per kind: webhook, customer-email and Slack skill
 * repositories are all `where kind = ...` selects over `agent_skills` with no joins, so
 * reading the spine once reproduces all three lists exactly while removing the chance
 * that three call sites drift apart.
 */
export class RoutineInvocableSkillNamesService implements RoutineInvocableSkillNames {
  constructor(private readonly sources: { agentSkills: Pick<AgentSkillRepositoryPort, "listByAgent"> }) {}

  async listForAgent(context: RoutineInvocableSkillNamesContext): Promise<readonly string[]> {
    const skills = await this.sources.agentSkills.listByAgent(context.workspaceId, context.agentId);
    return skills.filter(isNameDispatched).map((skill) => skill.skillName);
  }

  async listByKindForAgent(context: RoutineInvocableSkillNamesContext): Promise<RoutineInvocableSkillNamesByKind> {
    const skills = await this.sources.agentSkills.listByAgent(context.workspaceId, context.agentId);
    const byKind: Record<RoutineNameDispatchedSkillKind, string[]> = {
      webhook: [],
      customer_email: [],
      slack: [],
    };
    for (const skill of skills) {
      if (isNameDispatched(skill)) {
        byKind[skill.kind as RoutineNameDispatchedSkillKind].push(skill.skillName);
      }
    }
    return byKind;
  }
}

/** Compile-time proof that every dispatched kind is a real agent-skill kind. */
const _dispatchedKindsAreAgentSkillKinds: readonly AgentSkillKind[] = routineNameDispatchedSkillKinds;
void _dispatchedKindsAreAgentSkillKinds;
