import type { DirectiveMatch } from "@radioso/conversation-contract";

import { directiveMatchConfidence, directiveMatchPriority } from "../../directives/public.js";

export type DirectiveBindingSkipReason =
  | "skill_not_registered"
  | "skill_not_enabled"
  | "skill_not_turn_capable"
  | "skill_capability_denied";

export interface DirectiveBindingOutcome {
  directiveName: string;
  skillName: string;
}

export interface SkippedDirectiveBinding extends DirectiveBindingOutcome {
  reason: DirectiveBindingSkipReason;
}

export interface DirectiveBindingResolution {
  winner?: DirectiveBindingOutcome;
  losers: DirectiveBindingOutcome[];
  skipped: SkippedDirectiveBinding[];
}

export interface DirectiveBindingSkillState {
  enabled: boolean;
  turnCapable: boolean;
  /** This binding is consumed as an answer-loop staged tool, not terminal selection. */
  stagingCapable: boolean;
  /** The workspace capability policy denies a capability this skill requires. */
  capabilityDenied?: boolean;
}

export interface ResolveDirectiveBindingInput {
  matches: readonly DirectiveMatch[];
  registeredTurnSkillNames: ReadonlySet<string>;
  agentSkillStates?: ReadonlyMap<string, DirectiveBindingSkillState>;
}

// Binding picks a single turn-claiming winner: authored priority dominates, matcher
// confidence breaks priority ties, then name for a stable order. (The steering bound
// blends the same primitives multiplicatively instead — different policy, shared
// primitives; see directiveMatchRanking.)
const compareBoundMatches = (left: DirectiveMatch, right: DirectiveMatch): number => {
  const priority = directiveMatchPriority(right) - directiveMatchPriority(left);
  if (priority !== 0) {
    return priority;
  }
  const confidence = directiveMatchConfidence(right) - directiveMatchConfidence(left);
  if (confidence !== 0) {
    return confidence;
  }
  return left.directive.name.localeCompare(right.directive.name);
};

const skipReason = (
  skillName: string,
  registeredTurnSkillNames: ReadonlySet<string>,
  agentSkillStates?: ReadonlyMap<string, DirectiveBindingSkillState>,
): DirectiveBindingSkipReason | null => {
  const state = agentSkillStates?.get(skillName);
  if (state && !state.enabled) {
    return "skill_not_enabled";
  }
  if (state && !state.turnCapable) {
    return "skill_not_turn_capable";
  }
  if (state?.capabilityDenied) {
    return "skill_capability_denied";
  }
  if (!registeredTurnSkillNames.has(skillName)) {
    return "skill_not_registered";
  }
  return null;
};

export const resolveDirectiveBinding = (input: ResolveDirectiveBindingInput): DirectiveBindingResolution => {
  const boundMatches = input.matches
    .filter((match) => {
      const binding = match.directive.binding;
      if (binding?.kind !== "skill") {
        return false;
      }
      const state = input.agentSkillStates?.get(binding.skillName);
      return !(state?.enabled && state.stagingCapable && !state.turnCapable);
    })
    .sort(compareBoundMatches);

  const resolution: DirectiveBindingResolution = {
    winner: undefined,
    losers: [],
    skipped: [],
  };

  for (const match of boundMatches) {
    const binding = match.directive.binding;
    if (!binding || binding.kind !== "skill") {
      continue;
    }
    const outcome: DirectiveBindingOutcome = {
      directiveName: match.directive.name,
      skillName: binding.skillName,
    };
    const reason = skipReason(binding.skillName, input.registeredTurnSkillNames, input.agentSkillStates);
    if (reason) {
      resolution.skipped.push({ ...outcome, reason });
      continue;
    }
    if (!resolution.winner) {
      resolution.winner = outcome;
      continue;
    }
    if (resolution.winner.skillName !== outcome.skillName) {
      resolution.losers.push(outcome);
    }
  }

  return resolution;
};
