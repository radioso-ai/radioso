import type {
  ClarificationCandidate,
  ClarificationReplyMapping,
  ConversationClarifier,
  ConversationMessage,
  ConversationModelGateway,
  ClarificationReplyMapInput,
  SteeringRule,
  TurnContext,
} from "@radioso/conversation-contract";

import { renderPromptTemplate } from "./promptTemplate.js";

export const DEFAULT_CLARIFICATION_QUESTION_PROMPT = `Write one short clarifying lead-in line in {{conversationLanguage}}.

The user's request matched a few different topics. The specific options are listed
for the user immediately below your line, so do NOT write, restate, number,
translate, or invent the options yourself — that list is added separately. Write
only a single short sentence inviting the user to pick which option they mean.

Return only that one line.`;

export const DEFAULT_CLARIFICATION_REPLY_MAP_PROMPT = `Map the user's latest reply to one of the presented clarification options.

The options below are numbered in the same order they were offered to the user,
so positional references resolve against that numbering. Judge by meaning in the
conversation language.

Return "chosen" whenever the reply points to one option in any way, including a
label or paraphrase, a positional or ordinal reference (for example "the first
one", "the second one", "the last one", "number 2", "option 2") resolved against
the numbered order below, or accepting a single option that was offered.

Return "declined" only when the user explicitly rejects every option (for example
neither, none, or cancel). Return "unrelated" only when the reply changes the
subject to something none of the options cover. When the reply plausibly points
to one option, prefer "chosen" over "declined" or "unrelated".

Options:
{{options}}

Latest reply:
{{latestReply}}

Return only JSON:
{"kind":"chosen","id":"<option id>"} or {"kind":"declined"} or {"kind":"unrelated"}`;

export const DEFAULT_CLARIFICATION_OFFER_REPLY_MAP_PROMPT = `Map the user's latest reply after an answer offered alternative interpretations.

The options below are numbered in the same order they were offered to the user,
so positional references resolve against that numbering. Judge by meaning in the
conversation language.

Return "chosen" only when the reply is selection-only: it picks one offered
option without adding a new substantive question, request, task, or information
need. Selection-only replies can name an option, paraphrase its label or
description, use a positional or ordinal reference, or accept a single offered
option.

Return "unrelated" when the reply asks a new substantive question or makes a new
request, even if it names, paraphrases, or refers to one of the offered options.
The new turn should be handled normally instead of replaying the old question.

Return "declined" only when the user explicitly rejects every option.

Use only the option labels and descriptions below.

Options:
{{options}}

Latest reply:
{{latestReply}}

Return only JSON:
{"kind":"chosen","id":"<option id>"} or {"kind":"declined"} or {"kind":"unrelated"}`;

const turnMessages = (turn: TurnContext): ConversationMessage[] => [
  ...turn.history,
  { role: "user", content: turn.inputEvent.content },
];

/**
 * Appends co-composed steering (matched directives) as guidance the clarifying
 * question must follow, so a routine-activation clarification is shaped by the
 * agent's directives (tone, format, language) the same way a routine step reply
 * is. Empty when no steering applies, leaving the prompt — and every non-routine
 * clarifier caller — unchanged.
 */
const appendGuidance = (prompt: string, steering: SteeringRule[] = []): string => {
  if (steering.length === 0) {
    return prompt;
  }
  const lines = steering
    .map((rule) => (rule.condition ? `- ${rule.action} (when: ${rule.condition})` : `- ${rule.action}`))
    .join("\n");
  return `${prompt}\n\nAlso follow this guidance when phrasing the question:\n${lines}`;
};

const optionsBlock = (candidates: ClarificationCandidate[]): string =>
  candidates
    .map((candidate, index) => {
      const description = candidate.description ? `\nDescription: ${candidate.description}` : "";
      return `${index + 1}. id: ${candidate.id}\nLabel: ${candidate.label}${description}`;
    })
    .join("\n\n");

/**
 * The user-facing option list, assembled in code so the visitor always sees every
 * choice in a stable numbered order — the same order {@link DefaultClarifier.mapReply}
 * resolves positional replies ("the second one", "option 2") against. Labels and
 * descriptions are already in the conversation language; numbering and the
 * separator carry no language, so this stays multilingual without echoing ids.
 */
/**
 * A candidate is presentable only when its label is a real visitor-facing choice:
 * non-empty and not structurally degenerate (equal to its own id). Pure structural
 * check — no language vocabulary — so it holds in any conversation language. A
 * degenerate label must never render to the visitor even as belt-and-braces behind
 * the detector's own missing-label handling.
 */
const isPresentableCandidate = (candidate: ClarificationCandidate): boolean => {
  const label = candidate.label?.trim() ?? "";
  return label.length > 0 && normalizeReplyChoice(label) !== normalizeReplyChoice(candidate.id);
};

const userFacingOptionsList = (candidates: ClarificationCandidate[]): string =>
  candidates
    .filter(isPresentableCandidate)
    .map((candidate, index) => {
      const description = candidate.description ? ` — ${candidate.description}` : "";
      return `${index + 1}. ${candidate.label}${description}`;
    })
    .join("\n");

const normalizeReplyChoice = (value: string): string =>
  value.trim().replace(/\s+/g, " ").toLocaleLowerCase();

const mapExactReplyChoice = (
  reply: string,
  candidates: ClarificationCandidate[],
): ClarificationReplyMapping | null => {
  const normalizedReply = normalizeReplyChoice(reply);
  if (!normalizedReply) {
    return null;
  }

  for (const candidate of candidates) {
    if (
      normalizeReplyChoice(candidate.id) === normalizedReply ||
      normalizeReplyChoice(candidate.label) === normalizedReply
    ) {
      return { kind: "chosen", id: candidate.id };
    }
  }

  return null;
};

// ASCII digits only: ordinal words ("first", "option two", ...) stay the LLM
// mapper's job, which keeps this structural rather than an English keyword
// list. No multilingual digit-script normalization convention (e.g. for
// full-width or Eastern Arabic numerals) exists elsewhere in this codebase to
// follow, so this reads plain ASCII "0-9" only.
const ORDINAL_REPLY_PATTERN = /^[0-9]+$/;

/**
 * Resolves a bare-number reply ("2") to the candidate at that 1-based position
 * — the exact numbering {@link userFacingOptionsList} rendered to the visitor.
 * This is a fast, deterministic sibling to {@link mapExactReplyChoice} for the
 * overwhelmingly common case where the visitor just types the option number,
 * saving a model round-trip. Callers must only pass this the candidate list
 * that was actually rendered to the visitor in that order; see call site.
 *
 * Out-of-range numbers ("7" against 2 candidates) return null so the reply
 * falls through to the LLM mapper rather than being silently swallowed.
 */
const mapOrdinalReplyChoice = (
  reply: string,
  candidates: ClarificationCandidate[],
): ClarificationReplyMapping | null => {
  const trimmed = reply.trim();
  if (!ORDINAL_REPLY_PATTERN.test(trimmed)) {
    return null;
  }
  const position = Number.parseInt(trimmed, 10);
  if (position < 1 || position > candidates.length) {
    return null;
  }
  const candidate = candidates[position - 1];
  return candidate ? { kind: "chosen", id: candidate.id } : null;
};

const extractJsonObject = (raw: string): string | null => {
  const start = raw.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, index + 1);
      }
    }
  }
  return null;
};

const parseReplyMapping = (
  raw: string,
  candidateIds: Set<string>,
): ClarificationReplyMapping => {
  const json = extractJsonObject(raw);
  if (!json) {
    return { kind: "unrelated" };
  }
  try {
    const parsed = JSON.parse(json) as { kind?: unknown; id?: unknown };
    if (parsed.kind === "chosen" && typeof parsed.id === "string" && candidateIds.has(parsed.id)) {
      return { kind: "chosen", id: parsed.id };
    }
    if (parsed.kind === "declined") {
      return { kind: "declined" };
    }
    if (parsed.kind === "unrelated") {
      return { kind: "unrelated" };
    }
  } catch {
    return { kind: "unrelated" };
  }
  return { kind: "unrelated" };
};

export class DefaultClarifier implements ConversationClarifier {
  private readonly questionPromptTemplate: string;
  private readonly replyMapPromptTemplate: string;
  private readonly offerReplyMapPromptTemplate: string;

  constructor(
    private readonly modelGateway: ConversationModelGateway,
    options: {
      questionPromptTemplate?: string;
      replyMapPromptTemplate?: string;
      offerReplyMapPromptTemplate?: string;
    } = {},
  ) {
    this.questionPromptTemplate = options.questionPromptTemplate ?? DEFAULT_CLARIFICATION_QUESTION_PROMPT;
    this.replyMapPromptTemplate = options.replyMapPromptTemplate ?? DEFAULT_CLARIFICATION_REPLY_MAP_PROMPT;
    this.offerReplyMapPromptTemplate = options.offerReplyMapPromptTemplate ?? DEFAULT_CLARIFICATION_OFFER_REPLY_MAP_PROMPT;
  }

  async phraseQuestion(input: { candidates: ClarificationCandidate[]; turn: TurnContext }): Promise<string> {
    const optionsList = userFacingOptionsList(input.candidates);
    const systemPrompt = renderPromptTemplate("chat/clarification-question.md", this.questionPromptTemplate, {
      conversationLanguage: input.turn.inputEvent.locale ?? "the conversation language",
    });
    const { text } = await this.modelGateway.complete({
      messages: turnMessages(input.turn),
      systemPrompt: appendGuidance(systemPrompt, input.turn.steering),
    });
    // The model authors only the localized lead-in; the options are appended in
    // code. This makes the failure mode where the model collapses the question to a
    // single bare option label structurally impossible — every option always shows.
    const leadIn = text.trim();
    return leadIn ? `${leadIn}\n\n${optionsList}` : optionsList;
  }

  async mapReply(input: ClarificationReplyMapInput): Promise<ClarificationReplyMapping> {
    const exactChoice = mapExactReplyChoice(input.turn.inputEvent.content, input.candidates);
    if (exactChoice) {
      return exactChoice;
    }

    // Ordinal fast-path is "ask" mode only. That mode's candidates are stored in
    // the exact order rendered to the visitor as a numbered list, so position N
    // reliably means candidate N. "offer" mode never renders a code-guaranteed
    // numbered list — the model free-writes the alternative(s) into prose (see
    // chat/retrieval-sense-offer.md) and the stored candidates include the
    // already-answered top pick ahead of the offered alternatives, so a bare
    // number there cannot be trusted to mean the same thing the visitor read.
    // Positional offer replies ("the second one") stay the LLM mapper's job.
    if (input.mode !== "offer") {
      // Match against the same filtered list `userFacingOptionsList` numbers, not
      // the raw input: rendering drops non-presentable candidates before numbering,
      // so indexing the unfiltered list would resolve position N to a different
      // option than the visitor read. Filtering here keeps the numbering the kit
      // renders and the numbering it resolves derived from one expression, rather
      // than relying on a caller in another module to have pre-filtered identically.
      const ordinalChoice = mapOrdinalReplyChoice(
        input.turn.inputEvent.content,
        input.candidates.filter(isPresentableCandidate),
      );
      if (ordinalChoice) {
        return ordinalChoice;
      }
    }

    const promptName = input.mode === "offer"
      ? "chat/clarification-offer-reply-map.md"
      : "chat/clarification-reply-map.md";
    const promptTemplate = input.mode === "offer"
      ? this.offerReplyMapPromptTemplate
      : this.replyMapPromptTemplate;
    const systemPrompt = renderPromptTemplate(promptName, promptTemplate, {
      options: optionsBlock(input.candidates),
      conversationLanguage: input.turn.inputEvent.locale ?? "the conversation language",
      latestReply: input.turn.inputEvent.content,
    });
    const { text } = await this.modelGateway.complete({
      messages: turnMessages(input.turn),
      systemPrompt,
    });
    return parseReplyMapping(text, new Set(input.candidates.map((candidate) => candidate.id)));
  }
}
