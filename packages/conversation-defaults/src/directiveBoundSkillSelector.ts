import type {
  ConversationSkillSelector,
  SelectionDecision,
  SkillSelectionConsideration,
} from "@radioso/conversation-contract";

import {
  resolveDirectiveBinding,
  type DirectiveBindingOutcome,
  type DirectiveBindingResolution,
  type DirectiveBindingSkillState,
  type SkippedDirectiveBinding,
} from "./directiveBinding.js";

/** No authored directive bound a skill this turn. */
export const NO_DIRECTIVE_BINDING_REASON = "no_directive_binding";
/** Directives did bind skills, but every binding was unusable this turn. */
export const DIRECTIVE_BINDINGS_SKIPPED_REASON = "directive_bindings_skipped";
/** A registered skill no matched directive pointed at. */
export const UNBOUND_CANDIDATE_REASON = "not_directive_bound";
/** A usable binding that lost the single-winner contest to a higher-ranked one. */
export const LOST_CONFLICT_REASON = "lost_conflict";

export interface DirectiveBoundSkillSelectorOptions {
  /**
   * Optional host supplier of per-skill availability. Kept a supplier rather than
   * a value so a long-lived selector reads current state each turn, and optional
   * so a host with no availability policy still gets registration-based binding.
   */
  agentSkillStates?: () => ReadonlyMap<string, DirectiveBindingSkillState> | undefined;
}

const bindingMetadata = (
  binding: DirectiveBindingOutcome,
  outcome: "selected" | "lost_conflict" | "skipped",
  reason: string,
): Record<string, unknown> => ({
  directiveBinding: {
    directiveName: binding.directiveName,
    skillName: binding.skillName,
    outcome,
    reason,
  },
});

const skippedBySkillName = (skipped: readonly SkippedDirectiveBinding[]): Map<string, SkippedDirectiveBinding> => {
  const bySkill = new Map<string, SkippedDirectiveBinding>();
  for (const entry of skipped) {
    if (!bySkill.has(entry.skillName)) {
      bySkill.set(entry.skillName, entry);
    }
  }
  return bySkill;
};

const considerationFor = (
  skillName: string,
  binding: DirectiveBindingResolution,
  skipped: ReadonlyMap<string, SkippedDirectiveBinding>,
): SkillSelectionConsideration => {
  if (binding.winner?.skillName === skillName) {
    const reason = `directive:${binding.winner.directiveName}`;
    return {
      skillName,
      selected: true,
      reason,
      metadata: bindingMetadata(binding.winner, "selected", "selected"),
    };
  }
  const loser = binding.losers.find((candidate) => candidate.skillName === skillName);
  if (loser) {
    return {
      skillName,
      selected: false,
      reason: LOST_CONFLICT_REASON,
      metadata: bindingMetadata(loser, "lost_conflict", LOST_CONFLICT_REASON),
    };
  }
  const skip = skipped.get(skillName);
  if (skip) {
    return {
      skillName,
      selected: false,
      reason: skip.reason,
      metadata: bindingMetadata(skip, "skipped", skip.reason),
    };
  }
  return { skillName, selected: false, reason: UNBOUND_CANDIDATE_REASON };
};

/**
 * A {@link ConversationSkillSelector} that selects the terminal skill an authored
 * directive binding points at, and nothing else. Selection here is authored policy,
 * never a model's free-form tool pick: the only thing that can claim a turn is a
 * matched directive whose `binding.skillName` names a registered, usable skill.
 * Hosts that also want a fallback (a default skill, a strategy, a model chooser)
 * compose this selector's empty decision with their own rule.
 */
export const createDirectiveBoundSkillSelector = (
  options: DirectiveBoundSkillSelectorOptions = {},
): ConversationSkillSelector => ({
  async select(input): Promise<SelectionDecision> {
    const registeredTurnSkillNames = new Set(input.skills.map((skill) => skill.name));
    const binding = resolveDirectiveBinding({
      matches: input.directives,
      registeredTurnSkillNames,
      agentSkillStates: options.agentSkillStates?.(),
    });

    const skipped = skippedBySkillName(binding.skipped);
    // A skipped binding may name a skill that is not a registered candidate at all
    // (the `skill_not_registered` case); surface it anyway so the trace explains why
    // an authored binding produced nothing.
    const unregisteredSkipped = [...skipped.keys()].filter((name) => !registeredTurnSkillNames.has(name));
    const considered = [...input.skills.map((skill) => skill.name), ...unregisteredSkipped].map((skillName) =>
      considerationFor(skillName, binding, skipped),
    );

    if (!binding.winner) {
      return {
        selected: [],
        ...(considered.length > 0 ? { considered } : {}),
        reason: binding.skipped.length > 0 ? DIRECTIVE_BINDINGS_SKIPPED_REASON : NO_DIRECTIVE_BINDING_REASON,
      };
    }

    const reason = `directive:${binding.winner.directiveName}`;
    return {
      selected: [{
        skillName: binding.winner.skillName,
        reason,
        metadata: bindingMetadata(binding.winner, "selected", "selected"),
      }],
      ...(considered.length > 0 ? { considered } : {}),
      reason,
    };
  },
});
