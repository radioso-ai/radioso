import { routineAdvisories, type RoutineAdvisoryCode } from "@radioso/routine-definition";

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
 * Only email slot KEYS enter the text below, never a collected value.
 */
const advisoryMessages: Record<RoutineAdvisoryCode, (stableStepId: string, emailSlotKeys: ReadonlyArray<string>) => string> = {
  operator_notice_reply_to_unset: (stableStepId, emailSlotKeys) =>
    `operator notice has no reply-to: ending "${stableStepId}" notifies the team with no reply-to, so a reply to it won't reach the visitor. Set replyToSlot to the email field the team should answer (${emailSlotKeys.join(", ")}), or leave it unset on purpose.`,
};

/**
 * {@link routineAdvisories}, worded for an operator. `slots` tolerates the pre-parse
 * authoring shape (where an omitted slots array defaults to `[]` only after Zod parses it),
 * so a caller holding `RoutineDefinitionDraftAuthoringInput` can pass it through unchanged.
 */
export const routineAdvisoriesWithMessages = (
  definition: Omit<RoutineAdvisoryInput, "slots"> & { readonly slots?: RoutineAdvisoryInput["slots"] | null },
): RoutineAdvisoryWithMessage[] => {
  const slots = definition.slots ?? [];
  const emailSlotKeys = slots.filter((slot) => slot.type === "email").map((slot) => slot.key);
  return routineAdvisories({ slots, terminals: definition.terminals }).map((advisory) => ({
    code: advisory.code,
    location: advisory.location,
    message: advisoryMessages[advisory.code](advisory.stableStepId, emailSlotKeys),
  }));
};
