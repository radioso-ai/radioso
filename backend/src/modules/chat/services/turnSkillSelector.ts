import type { SelectionDecision } from "@radioso/conversation-contract";

import type { PreparedSession } from "./chatSessionPreparer.js";
import type { TurnSkill } from "./turnOutcome.js";
import type { TurnSelectionStrategy } from "./turnSelectionStrategy.js";
import type { AgentSkillInvocationMode } from "../../agentSkills/domain.js";

/** The terminal skill that claims a turn, with the engine-shaped decision behind it. */
export interface TurnSkillSelection {
  skill: TurnSkill;
  decision: SelectionDecision;
}

export const filterAutonomousTurnSkills = (
  candidates: Array<{ skill: TurnSkill; invocationMode: AgentSkillInvocationMode }>,
): TurnSkill[] =>
  candidates
    .filter((candidate) => candidate.invocationMode === "agent_selectable")
    .map((candidate) => candidate.skill);

/**
 * The single seam that decides which registered terminal skill claims a prepared
 * turn. The conversation engine consumes it through its `ConversationSkillSelector`
 * port (the `select` decision, which feeds the engine trace); the host's
 * non-streaming and streaming paths consume the resolved skill directly via
 * `resolveSkill`. Streaming can't run the engine yet (`processTurnStream` is
 * deferred, #507), so it shares this one rule instead of re-deriving its own
 * `turnSkills.find(...)` — streamed and non-streamed turns therefore select
 * identically.
 *
 * The {@link TurnSelectionStrategy} is the *path* layer (intake vs. terminal) and
 * stays a separate concern here: it only informs the decision's `reason`, never
 * which terminal skill is chosen. The terminal skill is whichever one `selects` the
 * prepared session (first match wins; the first registered skill is the fallback).
 */
export class ChatTurnSkillSelector {
  constructor(
    private readonly turnSkills: TurnSkill[],
    private readonly selectionStrategy: TurnSelectionStrategy,
  ) {}

  /** The terminal skill that claims this prepared turn. */
  resolveSkill(session: PreparedSession): TurnSkill {
    const skill = this.turnSkills.find((candidate) => candidate.selects(session)) ?? this.turnSkills[0];
    if (!skill) {
      throw new Error("chat_no_turn_skill_registered");
    }
    return skill;
  }

  /** Resolves the terminal skill and the engine-shaped decision that selected it. */
  select(session: PreparedSession): TurnSkillSelection {
    const skill = this.resolveSkill(session);
    const candidates = this.selectionStrategy.select({
      session,
      directives: session.directiveSteering?.matches ?? [],
    });
    return {
      skill,
      decision: {
        selected: [{ skillName: skill.definition.name, reason: "turn_selection_strategy" }],
        reason: candidates.length > 0 ? `candidates:${candidates.join(",")}` : "turn_selection_strategy",
      },
    };
  }
}
