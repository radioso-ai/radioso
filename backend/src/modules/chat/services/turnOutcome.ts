import type { SkillDefinition, TurnOutcome } from "@radioso/conversation-contract";

import type { ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import type { PlannedEnvelopeSuggestion } from "./groundedAnswerEnvelope.js";

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

/**
 * How the host should source this turn's question suggestions after the stream —
 * the second role the old `noContextPresentation` conflated with the presentation
 * override. Keeping it separate lets a skill own a *final presentation* (including
 * its own grounded-miss reconcile) without also dictating where suggestions come
 * from, the exact coupling that made grounded-miss un-movable before.
 *
 * - `presentation`: the skill already settled this turn's question suggestions onto
 *   `finalPresentation` (assistant-voice replies); the host uses them as-is.
 * - `assistant`: the host expands the model's planned envelope suggestions against
 *   the answer (retrieval — both cited answers and grounded misses).
 */
export type TurnStreamSuggestions =
  | { mode: "presentation" }
  | { mode: "assistant"; planned: PlannedEnvelopeSuggestion[] };

/**
 * The settled result of streaming a turn's answer — what the host needs to finalize
 * (persist, suggest) after the chunks have been yielded. The skill owns generating,
 * streaming, AND fully reconciling the answer (its grounded-miss / blank fallbacks
 * included), surfacing the finished presentation here; the host stays
 * capability-neutral and only persists, re-emits any non-streamed remainder, and
 * sources suggestions per {@link TurnStreamSuggestions}.
 */
export interface TurnStreamResult {
  /** The skill's fully reconciled presentation (incl. any grounded-miss swap). */
  finalPresentation: ChatPresentedAnswer;
  /** How the host sources this turn's question suggestions after the stream. */
  suggestions: TurnStreamSuggestions;
  hasStreamedAnswer: boolean;
  streamedAnswer: string;
}

export const getUnstreamedFinalAnswerRemainder = (result: TurnStreamResult): string => {
  if (!result.hasStreamedAnswer) {
    return result.finalPresentation.answer;
  }
  if (result.finalPresentation.answer && result.finalPresentation.answer.startsWith(result.streamedAnswer)) {
    return result.finalPresentation.answer.slice(result.streamedAnswer.length);
  }
  return "";
};

/**
 * A registered terminal turn capability: its public `definition` (what the
 * selector and engine see), how it `dispatch`es into a `TurnOutcome`, and how that
 * outcome `renderer`s. Concrete skills (e.g. retrieval) live outside this module
 * and are registered by the host, so the turn machinery stays capability-neutral
 * and only ever expects skill-shaped input — it names no specific skill.
 */
export interface TurnSkill {
  definition: SkillDefinition;
  /** Whether this skill is the terminal answer for the prepared turn. */
  selects(session: PreparedSession): boolean;
  /** Produces the turn outcome; a concrete skill may read the session's capabilities. */
  dispatch(session: PreparedSession): Promise<TurnOutcome> | TurnOutcome;
  /** Renders this skill's outcome into a chat presentation (non-streaming path). */
  renderer: TurnOutcomeRenderer;
  /** Streams this skill's answer (when it supports streaming): yields chunk text, returns the raw result. */
  streamRender?(ctx: TurnRenderContext): AsyncGenerator<string, TurnStreamResult>;
}

/**
 * Builds the renderer registry for a set of registered turn skills, with the
 * generic renderer as the always-last fallback. The loop composes through this
 * registry, never branching on a specific skill.
 */
export const buildTurnRendererRegistry = (skills: TurnSkill[]): TurnOutcomeRendererRegistry =>
  new TurnOutcomeRendererRegistry([...skills.map((skill) => skill.renderer), new GenericTurnOutcomeRenderer()]);
