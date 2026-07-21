import type { SelectionDecision } from "@radioso/conversation-contract";
import type { SkillSelectionConsideration } from "@radioso/conversation-contract";

import type { PreparedSession } from "./chatSessionPreparer.js";
import type { TurnSkill } from "./turnOutcome.js";
import type { TurnSelectionStrategy } from "./turnSelectionStrategy.js";
import type { AgentSkillInvocationMode } from "../../agentSkills/public.js";
import {
  resolveDirectiveBinding,
  type DirectiveBindingResolution,
  type DirectiveBindingSkillState,
  type DirectiveBindingOutcome,
  type SkippedDirectiveBinding,
} from "./directiveBindingResolution.js";

/** The terminal skill that claims a turn, with the engine-shaped decision behind it. */
export interface TurnSkillSelection {
  skill: TurnSkill;
  decision: SelectionDecision;
}

export interface ChatTurnSkillSelectorOptions {
  agentSkillStates?: ReadonlyMap<string, DirectiveBindingSkillState>;
  logger?: {
    warn(payload: Record<string, unknown>, message: string): void;
  };
  forceSkillName?: () => string | null | undefined;
}

const selectedBindingMetadata = (binding: DirectiveBindingOutcome) => ({
  directiveBinding: {
    directiveName: binding.directiveName,
    skillName: binding.skillName,
    outcome: "selected",
    reason: "selected",
  },
});

const loserBindingMetadata = (binding: DirectiveBindingOutcome) => ({
  directiveBinding: {
    directiveName: binding.directiveName,
    skillName: binding.skillName,
    outcome: "lost_conflict",
    reason: "lost_conflict",
  },
});

const skippedBindingMetadata = (binding: SkippedDirectiveBinding) => ({
  directiveBinding: {
    directiveName: binding.directiveName,
    skillName: binding.skillName,
    outcome: "skipped",
    reason: binding.reason,
  },
});

const bindingConsiderations = (binding: DirectiveBindingResolution): SkillSelectionConsideration[] => [
  ...(binding.winner
    ? [{
        skillName: binding.winner.skillName,
        selected: true,
        reason: `directive:${binding.winner.directiveName}`,
        metadata: selectedBindingMetadata(binding.winner),
      }]
    : []),
  ...binding.losers.map((loser) => ({
    skillName: loser.skillName,
    selected: false,
    reason: "lost_conflict",
    metadata: loserBindingMetadata(loser),
  })),
  ...binding.skipped.map((skipped) => ({
    skillName: skipped.skillName,
    selected: false,
    reason: skipped.reason,
    metadata: skippedBindingMetadata(skipped),
  })),
];

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
    private readonly options: ChatTurnSkillSelectorOptions = {},
  ) {}

  private resolveBinding(session: PreparedSession): DirectiveBindingResolution {
    const binding = resolveDirectiveBinding({
      matches: session.directiveSteering?.matches ?? [],
      registeredTurnSkillNames: new Set(this.turnSkills.map((skill) => skill.definition.name)),
      agentSkillStates: this.options.agentSkillStates,
    });
    for (const skipped of binding.skipped) {
      this.options.logger?.warn(
        {
          event: "directive_binding_skipped",
          workspaceId: session.agent?.workspaceId,
          agentId: session.agent?.id,
          conversationId: session.conversation?.id,
          directiveName: skipped.directiveName,
          skillName: skipped.skillName,
          reason: skipped.reason,
        },
        "Directive skill binding skipped",
      );
    }
    return binding;
  }

  private resolveDefaultSkill(session: PreparedSession): TurnSkill {
    const skill = this.turnSkills.find((candidate) => candidate.selects(session)) ?? this.turnSkills[0];
    if (!skill) {
      throw new Error("chat_no_turn_skill_registered");
    }
    return skill;
  }

  private resolveForcedSkill(): TurnSkill | null {
    const forcedSkillName = this.options.forceSkillName?.();
    if (!forcedSkillName) {
      return null;
    }
    const skill = this.turnSkills.find((candidate) => candidate.definition.name === forcedSkillName);
    if (!skill) {
      throw new Error("chat_forced_turn_skill_not_registered");
    }
    return skill;
  }

  /** The terminal skill that claims this prepared turn. */
  resolveSkill(session: PreparedSession): TurnSkill {
    const forced = this.resolveForcedSkill();
    if (forced) {
      return forced;
    }
    const binding = this.resolveBinding(session);
    const skill = binding.winner
      ? this.turnSkills.find((candidate) => candidate.definition.name === binding.winner?.skillName)
      : this.resolveDefaultSkill(session);
    if (!skill) {
      throw new Error("chat_no_turn_skill_registered");
    }
    return skill;
  }

  /** Resolves the terminal skill and the engine-shaped decision that selected it. */
  select(session: PreparedSession): TurnSkillSelection {
    const forced = this.resolveForcedSkill();
    if (forced) {
      return {
        skill: forced,
        decision: {
          selected: [{ skillName: forced.definition.name, reason: "forced_turn_skill" }],
          reason: "forced_turn_skill",
        },
      };
    }
    const binding = this.resolveBinding(session);
    const skill = binding.winner
      ? this.turnSkills.find((candidate) => candidate.definition.name === binding.winner?.skillName)
      : this.resolveDefaultSkill(session);
    if (!skill) {
      throw new Error("chat_no_turn_skill_registered");
    }
    const candidates = this.selectionStrategy.select({
      session,
      directives: session.directiveSteering?.matches ?? [],
    });
    const reason = binding.winner ? `directive:${binding.winner.directiveName}` : undefined;
    const considerations = bindingConsiderations(binding);
    return {
      skill,
      decision: {
        selected: [{
          skillName: skill.definition.name,
          reason: reason ?? "turn_selection_strategy",
          ...(binding.winner ? { metadata: selectedBindingMetadata(binding.winner) } : {}),
        }],
        ...(considerations.length > 0 ? { considered: considerations } : {}),
        reason: reason ?? (candidates.length > 0 ? `candidates:${candidates.join(",")}` : "turn_selection_strategy"),
      },
    };
  }
}
