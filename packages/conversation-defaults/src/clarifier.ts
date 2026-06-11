import type {
  ClarificationCandidate,
  ClarificationReplyMapping,
  ConversationClarifier,
  ConversationMessage,
  ConversationModelGateway,
  TurnContext,
} from "@radioso/conversation-contract";

import { renderPromptTemplate } from "./promptTemplate.js";

export const DEFAULT_CLARIFICATION_QUESTION_PROMPT = `Phrase one short clarifying question in the conversation language.

Use only these options:
{{options}}

Return only the question.`;

export const DEFAULT_CLARIFICATION_REPLY_MAP_PROMPT = `Map the user's latest reply to one clarification option.

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

const optionsBlock = (candidates: ClarificationCandidate[]): string =>
  candidates
    .map((candidate, index) => {
      const description = candidate.description ? `\nDescription: ${candidate.description}` : "";
      return `${index + 1}. id: ${candidate.id}\nLabel: ${candidate.label}${description}`;
    })
    .join("\n\n");

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

  constructor(
    private readonly modelGateway: ConversationModelGateway,
    options: {
      questionPromptTemplate?: string;
      replyMapPromptTemplate?: string;
    } = {},
  ) {
    this.questionPromptTemplate = options.questionPromptTemplate ?? DEFAULT_CLARIFICATION_QUESTION_PROMPT;
    this.replyMapPromptTemplate = options.replyMapPromptTemplate ?? DEFAULT_CLARIFICATION_REPLY_MAP_PROMPT;
  }

  async phraseQuestion(input: { candidates: ClarificationCandidate[]; turn: TurnContext }): Promise<string> {
    const systemPrompt = renderPromptTemplate("chat/clarification-question.md", this.questionPromptTemplate, {
      options: optionsBlock(input.candidates),
      conversationLanguage: input.turn.inputEvent.locale ?? "the conversation language",
      latestReply: input.turn.inputEvent.content,
    });
    const { text } = await this.modelGateway.complete({
      messages: turnMessages(input.turn),
      systemPrompt,
    });
    return text.trim();
  }

  async mapReply(input: { candidates: ClarificationCandidate[]; turn: TurnContext }): Promise<ClarificationReplyMapping> {
    const exactChoice = mapExactReplyChoice(input.turn.inputEvent.content, input.candidates);
    if (exactChoice) {
      return exactChoice;
    }

    const systemPrompt = renderPromptTemplate("chat/clarification-reply-map.md", this.replyMapPromptTemplate, {
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
