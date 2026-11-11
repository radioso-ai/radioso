import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import type { AgentBudgets, AgenticCapabilityRunner } from "../../../shared/agent-runtime/index.js";
import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { WorkspaceSetupStep } from "../../../db/repositories/workspaceSetupStateRepository.js";
import type { CopilotWorkspaceRouteKeyResolver } from "../contracts.js";
import { workspaceSetupContextBlock, type CopilotSetupGuidancePort, type WorkspaceSetupGuidance } from "../context/workspaceSetup.js";
import { buildCopilotSetupStepLink } from "../dashboardLinks.js";
import { buildCopilotSystemPrompt } from "../turnPrompt.js";

/** What Ray offers once setup is over: work its existing `propose_*` tools already do. */
export const copilotOpenEndedIntents = ["crawl_more", "tighten_tone", "draft_routine"] as const;
type CopilotOpenEndedIntent = (typeof copilotOpenEndedIntents)[number];

type CopilotEmptySuggestion =
  /** A step the operator completes on a dashboard surface; the chip navigates there. */
  | { readonly kind: "setup_step"; readonly step: WorkspaceSetupStep; readonly text: string; readonly href: string }
  /** A request the operator can send Ray; the chip fills the composer. */
  | { readonly kind: "prompt"; readonly intent: CopilotOpenEndedIntent; readonly text: string };

/**
 * `greeting` is null when there is no copy to show: the operator may not read setup state, or the
 * model could not write it. The caller then shows no claim at all rather than a canned one.
 */
interface CopilotEmptyState {
  readonly phase: "setup" | "open";
  readonly greeting: string | null;
  readonly suggestions: ReadonlyArray<CopilotEmptySuggestion>;
}

interface EmptyStateServiceDeps {
  readonly capabilityRunner: Pick<AgenticCapabilityRunner, "runStreaming">;
  readonly prompt: string;
  readonly workspaceRouteKeyResolver: CopilotWorkspaceRouteKeyResolver;
  readonly setup: CopilotSetupGuidancePort;
  readonly logger?: { warn(fields: Record<string, unknown>, message: string): void };
  readonly now?: () => Date;
}

/** One short reply and no tools; a model that has not answered in 20 seconds is not going to. */
const EMPTY_STATE_BUDGET: AgentBudgets = { maxSteps: 2, maxToolResultTokens: 1_000, maxWallTimeMs: 20_000 };
/** The state a copy was written for only changes when setup does, so a day-old copy is still true. */
const COPY_TTL_MS = 6 * 60 * 60 * 1_000;
/** A model that failed is asked again soon, but not on every panel open. */
const FAILURE_TTL_MS = 60 * 1_000;
const CACHE_LIMIT = 256;

const writtenCopySchema = z.object({
  greeting: z.string().trim().min(1).max(400),
  suggestions: z.array(z.object({ id: z.string(), text: z.string().trim().min(1).max(160) })).max(8),
});

interface WrittenCopy {
  readonly greeting: string;
  readonly textById: ReadonlyMap<string, string>;
}

type Offer =
  | { readonly kind: "step"; readonly id: WorkspaceSetupStep }
  | { readonly kind: "intent"; readonly id: CopilotOpenEndedIntent };

const offersFor = (guidance: WorkspaceSetupGuidance): ReadonlyArray<Offer> =>
  guidance.phase === "setup"
    ? guidance.nextSteps.map((id) => ({ kind: "step" as const, id }))
    : copilotOpenEndedIntents.map((id) => ({ kind: "intent" as const, id }));

/** The model may wrap its JSON in a fence or a sentence; the object is whatever sits between the outermost braces. */
const parseWrittenCopy = (reply: string): WrittenCopy | null => {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = writtenCopySchema.safeParse(raw);
  if (!parsed.success) return null;
  const textById = new Map<string, string>();
  for (const suggestion of parsed.data.suggestions) if (!textById.has(suggestion.id)) textById.set(suggestion.id, suggestion.text);
  return { greeting: parsed.data.greeting, textById };
};

/**
 * Writes the greeting and suggestion chips Ray's empty panel shows, from the workspace's setup
 * state. The structure is decided here, deterministically: which steps may be offered, and where
 * each one is completed. The model writes only the words, in the operator's language, and can
 * choose among the offers but never add to them.
 */
export class CopilotEmptyStateService {
  private readonly copies = new Map<string, { readonly copy: WrittenCopy | null; readonly expiresAt: number }>();
  private readonly pending = new Map<string, Promise<WrittenCopy | null>>();

  constructor(private readonly deps: EmptyStateServiceDeps) {}

  async get(input: { workspaceId: string; permissions: ReadonlySet<string>; locale: string | null }): Promise<CopilotEmptyState> {
    const guidance = await this.deps.setup.guidance(input);
    if (guidance === null) return { phase: "open", greeting: null, suggestions: [] };
    const workspaceKey = await this.deps.workspaceRouteKeyResolver.resolveWorkspaceKey(input.workspaceId);
    const offers = offersFor(guidance);
    const copy = await this.copyFor({ workspaceId: input.workspaceId, workspaceKey, locale: input.locale, guidance, offers });
    if (copy === null) return { phase: guidance.phase, greeting: null, suggestions: [] };

    const suggestions: CopilotEmptySuggestion[] = [];
    for (const offer of offers) {
      const text = copy.textById.get(offer.id);
      if (text === undefined) continue;
      if (offer.kind === "intent") {
        suggestions.push({ kind: "prompt", intent: offer.id, text });
        continue;
      }
      const href = buildCopilotSetupStepLink(workspaceKey, offer.id);
      if (href !== null) suggestions.push({ kind: "setup_step", step: offer.id, text, href });
    }
    return { phase: guidance.phase, greeting: copy.greeting, suggestions };
  }

  private now(): number {
    return (this.deps.now ?? (() => new Date()))().getTime();
  }

  private async copyFor(input: { workspaceId: string; workspaceKey: string; locale: string | null; guidance: WorkspaceSetupGuidance; offers: ReadonlyArray<Offer> }): Promise<WrittenCopy | null> {
    const key = createHash("sha256")
      .update(JSON.stringify({ workspaceId: input.workspaceId, locale: input.locale, state: this.stateFor(input.guidance), offers: input.offers }))
      .digest("hex");
    const cached = this.copies.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.copy;
    const pending = this.pending.get(key);
    if (pending) return pending;

    const writing = this.write(input).then((copy) => {
      this.remember(key, copy);
      return copy;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, writing);
    return writing;
  }

  private stateFor(guidance: WorkspaceSetupGuidance) {
    return { phase: guidance.phase, firstConversationHappened: guidance.firstConversationHappened, steps: guidance.steps };
  }

  private remember(key: string, copy: WrittenCopy | null): void {
    this.copies.delete(key);
    this.copies.set(key, { copy, expiresAt: this.now() + (copy === null ? FAILURE_TTL_MS : COPY_TTL_MS) });
    for (const oldest of this.copies.keys()) {
      if (this.copies.size <= CACHE_LIMIT) break;
      this.copies.delete(oldest);
    }
  }

  private async write(input: { workspaceId: string; workspaceKey: string; locale: string | null; guidance: WorkspaceSetupGuidance; offers: ReadonlyArray<Offer> }): Promise<WrittenCopy | null> {
    const block = workspaceSetupContextBlock(input.guidance, input.workspaceKey);
    const request = {
      systemPrompt: buildCopilotSystemPrompt(this.deps.prompt, input.workspaceKey, block ? [block] : []),
      userMessage: renderPromptTemplate("copilot/empty-state.md", {
        language_instruction: input.locale ? `Write in the language of locale ${input.locale}.` : "Write in the language the operator most likely reads; if you cannot tell, use English.",
        state_json: JSON.stringify(this.stateFor(input.guidance)),
        offers_json: JSON.stringify(input.offers),
      }),
      usageContext: { workspaceId: input.workspaceId, requestId: randomUUID(), surface: "operator_copilot", attemptKey: "copilot_empty_state" },
      requireFinalMessage: true,
    };
    let reply: string | null;
    try {
      reply = (await this.deps.capabilityRunner.runStreaming(request, [], EMPTY_STATE_BUDGET).result).finalMessage;
    } catch (error) {
      this.unavailable(input.workspaceId, "model_failed", error);
      return null;
    }
    const copy = reply === null ? null : parseWrittenCopy(reply);
    if (copy === null) this.unavailable(input.workspaceId, "unparseable_reply");
    return copy;
  }

  /** Ids and a reason only: the reply is model output about a customer's workspace and stays out of the log. */
  private unavailable(workspaceId: string, reason: "model_failed" | "unparseable_reply", error?: unknown): void {
    this.deps.logger?.warn({ workspaceId, reason, ...(error === undefined ? {} : { err: error }) }, "operator_copilot_empty_state_unavailable");
  }
}
