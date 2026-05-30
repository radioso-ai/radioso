import type { ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import { toConversationTrace, toRetrievalStagedContext } from "./conversationContractMappers.js";
import type { TurnOutcome, TurnRenderContext, TurnSkill } from "./turnOutcome.js";

/** The outcome kind a grounded/retrieval turn produces. */
export const RETRIEVAL_OUTCOME_KIND = "retrieval";

/** The skill name a grounded (retrieval) turn dispatches. */
export const RETRIEVAL_TURN_SKILL = "retrieval.answer";

/**
 * Wraps a prepared session's grounded/direct result into the generic turn outcome
 * a retrieval dispatch produces. The rich retrieval result rides on
 * `session.retrieval` (read by the retrieval renderer); the outcome carries the
 * steering set for the composer and declares its rendering kind so renderers match
 * by kind, not skill name. Pure mapping — retrieval execution already happened
 * during session prep.
 */
export const buildRetrievalTurnOutcome = (session: PreparedSession): TurnOutcome => ({
  kind: RETRIEVAL_OUTCOME_KIND,
  skillName: RETRIEVAL_TURN_SKILL,
  outcome: { status: "completed" },
  stagedContext: [toRetrievalStagedContext(session.retrieval)],
  steering: session.directiveSteering?.rules ?? [],
  trace: toConversationTrace(session.retrieval.trace),
});

export interface RetrievalTurnSkillDeps {
  /** Composes the grounded/direct answer presentation — owned by the host. */
  renderAnswer: (ctx: TurnRenderContext) => Promise<ChatPresentedAnswer>;
}

/**
 * Registers retrieval as a terminal `TurnSkill`. This is the concrete adapter that
 * is allowed to know about `session.retrieval`; the generic turn machinery
 * (`turnOutcome.ts`) and the engine adapter (`conversationEngineChatTurn.ts`) never
 * reference it. The host wires `renderAnswer` (grounded answer composition) in;
 * moving registration to composition is a follow-up once answer generation is
 * extracted from `ChatService`.
 */
export const createRetrievalTurnSkill = (deps: RetrievalTurnSkillDeps): TurnSkill => ({
  definition: { name: RETRIEVAL_TURN_SKILL, outcomeKinds: [RETRIEVAL_OUTCOME_KIND] },
  selects: () => true,
  dispatch: (session) => buildRetrievalTurnOutcome(session),
  renderer: {
    supports: (outcome) => outcome.kind === RETRIEVAL_OUTCOME_KIND,
    render: (_outcome, ctx) => deps.renderAnswer(ctx),
  },
});
