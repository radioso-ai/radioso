import { routineAdvisories, type RoutineAdvisory, type RoutineAdvisoryCode, type RoutineSkillInputKeys } from "@radioso/routine-definition";

type RoutineAdvisoryInput = Parameters<typeof routineAdvisories>[0];

/**
 * An advisory, worded, as every caller outside this module sees it. No `stableStepId`: `location`
 * already carries it (`step:<id>.operatorNotice.replyToSlot`), the same way a validation
 * diagnostic's `location` is the only identifier it exposes.
 */
interface RoutineAdvisoryWithMessage {
  readonly code: RoutineAdvisoryCode;
  readonly location: string;
  readonly message: string;
}

/**
 * The one statement of each advisory's operator-facing wording, kept apart from
 * validator.ts's blocking-diagnostic messages: an advisory never blocks compile,
 * validation, or publish, and sharing a message table would risk a future diagnostic
 * reusing advisory wording by accident.
 *
 * Only slot KEYS and skill names enter the text below, never a collected value.
 */
const advisoryMessages: Record<RoutineAdvisoryCode, (advisory: RoutineAdvisory, replyToCandidates: ReadonlyArray<string>) => string> = {
  operator_notice_reply_to_unset: (advisory, replyToCandidates) =>
    `operator notice has no reply-to: ending "${advisory.stableStepId}" notifies the team with no reply-to, so a reply to it won't reach the visitor. Set replyToSlot to the email field the team should answer (${replyToCandidates.join(", ")}), or leave it unset on purpose.`,
  sensitive_slot_unbound_skill_input: (advisory) =>
    `sensitive field sent masked: step "${advisory.stableStepId}" runs ${advisory.skillName ?? "its skill"} with no input bindings, so its input "${advisory.slotKey ?? ""}" receives the sensitive field as [redacted]. Bind that input to @${advisory.slotKey ?? ""} on the step to send the value, or leave it masked on purpose.`,
};

/**
 * {@link routineAdvisories}, worded for an operator. `slots` tolerates the pre-parse
 * authoring shape (where an omitted slots array defaults to `[]` only after Zod parses it),
 * so a caller holding `RoutineDefinitionDraftAuthoringInput` can pass it through unchanged.
 * `skillInputKeys` comes from the agent's skill catalog; without it the advisories that compare
 * a step against its skill are left out.
 */
export const routineAdvisoriesWithMessages = (
  definition: Omit<RoutineAdvisoryInput, "slots"> & { readonly slots?: RoutineAdvisoryInput["slots"] | null },
  options: { readonly skillInputKeys?: RoutineSkillInputKeys } = {},
): RoutineAdvisoryWithMessage[] => {
  const slots = definition.slots ?? [];
  // A sensitive address never leaves the conversation, so it is never suggested as a reply-to.
  const replyToCandidates = slots.filter((slot) => slot.type === "email" && slot.sensitivity !== "sensitive").map((slot) => slot.key);
  return routineAdvisories({ slots, steps: definition.steps, terminals: definition.terminals }, options).map((advisory) => ({
    code: advisory.code,
    location: advisory.location,
    message: advisoryMessages[advisory.code](advisory, replyToCandidates),
  }));
};
