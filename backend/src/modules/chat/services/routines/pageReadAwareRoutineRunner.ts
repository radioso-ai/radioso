import type {
  ConversationRoutineClaim,
  ConversationRoutineResumeInput,
  ConversationRoutineRunner,
  PendingRenderableTurn,
  Routine,
} from "@radioso/conversation-contract";

import type { ChatSessionPreparer, PreparedSession } from "../chatSessionPreparer.js";
import { pageReadRoutineCandidates } from "../pageRead/pageReadRoutineCandidates.js";
import { freezePageReadOutcome } from "../pageRead/pageReadSessionOutcome.js";

/** The reply, generated whole or streamed only once `commit` has run; `commit` runs only when the reply is asked for. */
const replyAfterCommit = (reply: PendingRenderableTurn, commit: () => void): PendingRenderableTurn => {
  const stream = reply.stream?.bind(reply);
  return {
    render: async () => {
      commit();
      return reply.render();
    },
    ...(stream
      ? {
          stream: async function* () {
            commit();
            return yield* stream();
          },
        }
      : {}),
  };
};

/**
 * The provider's routine runner, bound to the page excerpt this turn may read. The capture
 * is tentative: the routine may yield the turn off-topic, so the decision is frozen on a
 * detached carrier and the routine binds against a scoped staged view. Only a turn the
 * routine keeps commits the capture to the session: a claimed turn as its reply starts being
 * generated, so a step reply written from the session (a grounded answer) reads the page the
 * routine read; a resumed turn, whose runner generates as it walks, once it has resumed.
 */
export const pageReadAwareRoutineRunner = (input: {
  session: PreparedSession;
  routines?: readonly Routine[];
  runner: ConversationRoutineRunner;
  chatSessionPreparer: Pick<ChatSessionPreparer, "stagedPageContextFor" | "applyFrozenPageReadOutcome">;
}): ConversationRoutineRunner => {
  const { session, runner, chatSessionPreparer } = input;
  const scopedToPageRead = async (runnerInput: ConversationRoutineResumeInput) => {
    const planned = session.turnPlan
      ? await session.turnPlan.resolve(null)
      : undefined;
    const routine = input.routines?.find((candidate) => candidate.id === runnerInput.state.routineId);
    const candidate = freezePageReadOutcome(
      { pageReadCapability: session.pageReadCapability },
      {
        planner: planned?.status === "planned"
          ? planned.plan.pageRead ?? null
          : null,
        routineCandidates: routine ? pageReadRoutineCandidates(routine) : [],
        directiveCandidates: [],
        fallbackRequest: session.effectiveQuery,
      },
    );
    return {
      input: {
        ...runnerInput,
        turn: {
          ...runnerInput.turn,
          stagedContext: chatSessionPreparer.stagedPageContextFor(session, candidate),
        },
      },
      commit: () => {
        session.pageReadOutcome ??= candidate;
        chatSessionPreparer.applyFrozenPageReadOutcome(session);
      },
    };
  };
  const claim = runner.claim?.bind(runner);
  return {
    resume: async (resumeInput) => {
      const scoped = await scopedToPageRead(resumeInput);
      const result = await runner.resume(scoped.input);
      if (!result.yielded) {
        scoped.commit();
      }
      return result;
    },
    ...(claim
      ? {
          claim: async (claimInput: ConversationRoutineResumeInput): Promise<ConversationRoutineClaim> => {
            const scoped = await scopedToPageRead(claimInput);
            const claimed = await claim(scoped.input);
            return claimed.kind === "claimed"
              ? { ...claimed, reply: replyAfterCommit(claimed.reply, scoped.commit) }
              : claimed;
          },
        }
      : {}),
  };
};
