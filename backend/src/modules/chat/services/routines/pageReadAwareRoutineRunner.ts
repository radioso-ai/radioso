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

/** The reply, with `after` run once it has been generated, whole or streamed — never when generating it failed. */
const replyThen = (reply: PendingRenderableTurn, after: () => void): PendingRenderableTurn => {
  const stream = reply.stream?.bind(reply);
  return {
    render: async () => {
      const turn = await reply.render();
      after();
      return turn;
    },
    ...(stream
      ? {
          stream: async function* () {
            const turn = yield* stream();
            after();
            return turn;
          },
        }
      : {}),
  };
};

/**
 * The provider's routine runner, bound to the page excerpt this turn may read. The capture
 * is tentative: the routine may yield the turn off-topic, so the decision is frozen on a
 * detached carrier and the routine binds against a scoped staged view. Only a turn the
 * routine keeps commits the capture to the session, once its reply has been generated.
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
              ? { ...claimed, reply: replyThen(claimed.reply, scoped.commit) }
              : claimed;
          },
        }
      : {}),
  };
};
