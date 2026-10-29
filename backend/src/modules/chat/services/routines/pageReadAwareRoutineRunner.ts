import type {
  ConversationRoutineClaim,
  ConversationRoutineResumeInput,
  ConversationRoutineRunner,
  PendingRenderableTurn,
  Routine,
} from "@radioso/conversation-contract";

import type { ChatSessionPreparer, PreparedSession } from "../chatSessionPreparer.js";
import { pageReadRoutineCandidates, stepReadsPageContext } from "../pageRead/pageReadRoutineCandidates.js";
import { freezePageReadOutcome } from "../pageRead/pageReadSessionOutcome.js";

/** The reply, with `commit` run once it has been generated, whole or streamed — never when generating it failed. */
const replyThenCommit = (reply: PendingRenderableTurn, commit: () => unknown): PendingRenderableTurn => {
  const stream = reply.stream?.bind(reply);
  return {
    render: async () => {
      const turn = await reply.render();
      commit();
      return turn;
    },
    ...(stream
      ? {
          stream: async function* () {
            const turn = yield* stream();
            commit();
            return turn;
          },
        }
      : {}),
  };
};

/**
 * The reply, generated whole or streamed only once `commit` has run; `commit` runs only when the
 * reply is asked for, and what it changed is undone (`undo`) unless the reply is generated in
 * full, so a reply that fails or is abandoned leaves the session as the claim found it.
 */
const replyAfterCommit = (reply: PendingRenderableTurn, commit: () => () => void): PendingRenderableTurn => {
  const stream = reply.stream?.bind(reply);
  return {
    render: async () => {
      const undo = commit();
      try {
        return await reply.render();
      } catch (error) {
        undo();
        throw error;
      }
    },
    ...(stream
      ? {
          stream: async function* () {
            const undo = commit();
            let generated = false;
            try {
              const turn = yield* stream();
              generated = true;
              return turn;
            } finally {
              if (!generated) {
                undo();
              }
            }
          },
        }
      : {}),
  };
};

/**
 * The provider's routine runner, bound to the page excerpt this turn may read. The capture
 * is tentative: the routine may yield the turn off-topic, so the decision is frozen on a
 * detached carrier and the routine binds against a scoped staged view. Only a turn the
 * routine keeps commits the capture to the session. When the step the claimed reply renders
 * reads the page, the commit comes as that reply starts, so a reply written from the session
 * (a grounded answer) reads the page its step references. Any other reply is written from the
 * session as the routine found it, and the capture is committed once it has been generated —
 * as it is for a resumed turn, whose runner generates as it walks.
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
      routine,
      input: {
        ...runnerInput,
        turn: {
          ...runnerInput.turn,
          stagedContext: chatSessionPreparer.stagedPageContextFor(session, candidate),
        },
      },
      /** Commits the capture to the session; returns what puts the session back. */
      commit: () => {
        const { pageReadOutcome, resolvedContext, stagedContext } = session;
        session.pageReadOutcome ??= candidate;
        chatSessionPreparer.applyFrozenPageReadOutcome(session);
        return () => {
          Object.assign(session, { pageReadOutcome, resolvedContext, stagedContext });
        };
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
            if (claimed.kind !== "claimed") {
              return claimed;
            }
            const renderedStepId = claimed.effects.trace?.landedStepId ?? claimed.effects.nextState?.path.at(-1);
            const renderedStep = scoped.routine?.steps.find((step) => step.id === renderedStepId);
            return {
              ...claimed,
              reply: renderedStep && stepReadsPageContext(renderedStep)
                ? replyAfterCommit(claimed.reply, scoped.commit)
                : replyThenCommit(claimed.reply, scoped.commit),
            };
          },
        }
      : {}),
  };
};
