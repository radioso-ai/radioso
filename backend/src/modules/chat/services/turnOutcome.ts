import type { TurnOutcome } from "@radioso/conversation-contract";

import type { ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import { toConversationTrace, toRetrievalStagedContext } from "./conversationContractMappers.js";

/**
 * The generic, per-turn result the assistant composes its reply from — the
 * currency of the capability-neutral spine (068). It carries which skill the
 * turn dispatched, that skill's control-envelope `SkillOutcome`, and the steering
 * set (authored Directives + skill-emitted guidance) the composer applies.
 *
 * Retrieval is one source among many: a retrieval turn's rich result rides on
 * the outcome's `metadata` (via the retrieval module's `readRetrievalResult`),
 * read by the retrieval renderer; a non-retrieval skill's `answer`/`outputs` are
 * read by the generic renderer. The loop never branches on a specific skill.
 */
export type { TurnOutcome } from "@radioso/conversation-contract";

/** The outcome kind a grounded/retrieval turn produces. */
export const RETRIEVAL_OUTCOME_KIND = "retrieval";

// The skill name a grounded (retrieval) turn dispatches; the retrieval renderer
// claims outcomes under this kind, while a non-retrieval skill's outcome falls
// through to the generic renderer.
export const RETRIEVAL_TURN_SKILL = "retrieval.answer";

/**
 * Wraps a prepared session's grounded/direct result into the generic turn
 * outcome a retrieval dispatch produces. The rich retrieval result rides on
 * `session.retrieval` (read by the retrieval renderer); the outcome carries the
 * steering set for the composer and declares its rendering kind so renderers
 * match by kind, not skill name. Pure mapping — retrieval execution already
 * happened during session prep.
 */
export const buildRetrievalTurnOutcome = (session: PreparedSession): TurnOutcome => ({
  kind: RETRIEVAL_OUTCOME_KIND,
  skillName: RETRIEVAL_TURN_SKILL,
  outcome: { status: "completed" },
  stagedContext: [toRetrievalStagedContext(session.retrieval)],
  steering: session.directiveSteering?.rules ?? [],
  trace: toConversationTrace(session.retrieval.trace),
});

/** Turn-scoped inputs a renderer needs beyond the outcome itself. */
export interface TurnRenderContext {
  session: PreparedSession;
  query: string;
  userExpectedLocale?: string | null;
  accountId?: string;
}

/**
 * Composes a `ChatPresentedAnswer` from a turn outcome. Renderers are selected by
 * what the outcome *is* (its kind/capability), never by skill name — so a new
 * skill plugs in by being renderable, not by a branch in the loop.
 */
export interface TurnOutcomeRenderer {
  supports(outcome: TurnOutcome): boolean;
  render(outcome: TurnOutcome, ctx: TurnRenderContext): Promise<ChatPresentedAnswer>;
}

/**
 * Ordered renderer registry: the first renderer that `supports` the outcome wins.
 * Composition orders specific renderers (e.g. retrieval) before the generic
 * fallback. The loop holds the registry, not the renderers.
 */
export class TurnOutcomeRendererRegistry {
  constructor(private readonly renderers: TurnOutcomeRenderer[]) {}

  resolve(outcome: TurnOutcome): TurnOutcomeRenderer {
    const renderer = this.renderers.find((candidate) => candidate.supports(outcome));
    if (!renderer) {
      throw new Error(`No turn-outcome renderer supports the outcome for skill "${outcome.skillName}"`);
    }
    return renderer;
  }
}

/**
 * Renders any settled skill outcome by surfacing its model-visible `answer`
 * through the presentation. The fallback renderer for non-retrieval skills; it
 * `supports` every outcome, so it is registered last. It emits no hard-coded
 * conversational copy — the `answer` it renders is the skill's own LLM/canned
 * output.
 */
export class GenericTurnOutcomeRenderer implements TurnOutcomeRenderer {
  supports(): boolean {
    return true;
  }

  async render(outcome: TurnOutcome, _ctx: TurnRenderContext): Promise<ChatPresentedAnswer> {
    return {
      answer: outcome.outcome.answer ?? "",
      skillName: outcome.skillName,
      skillOutcome: outcome.outcome.status,
      skillStatus: outcome.outcome.status,
    };
  }
}
