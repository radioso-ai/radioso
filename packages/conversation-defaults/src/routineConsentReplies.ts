// What a visitor's own words say about a consent they were just shown (#1544), and what the agent
// says before showing it again when they said neither yes nor no. The model judges meaning in any
// language; nothing here reads the words. Buttons, channels and records are the host's.
import type {
  ConversationMessage,
  ConversationModelGateway,
  RoutineConsentReading,
  TurnContext,
} from "@radioso/conversation-contract";

import {
  DEFAULT_ROUTINE_CONSENT_REPLY_PROMPT,
  DEFAULT_ROUTINE_CONSENT_UNCLEAR_ANSWER_PROMPT,
} from "./generated/defaultPrompts.js";
import { renderPromptTemplate } from "./promptTemplate.js";

/** The consent text a visitor was shown: the operator's wording and the two choice labels, verbatim. */
export interface RoutineConsentWordingText {
  body: string;
  agreeLabel: string;
  declineLabel: string;
}

interface ConsentReplyInput {
  turn: TurnContext;
  wording: RoutineConsentWordingText;
}

// Only the latest message answers the consent just shown; nothing said before it can grant it.
const latestMessage = (turn: TurnContext): ConversationMessage[] => [{ role: "user", content: turn.inputEvent.content }];

const wordingVariables = (wording: RoutineConsentWordingText): Record<string, string> => ({
  body: wording.body,
  agree_label: wording.agreeLabel,
  decline_label: wording.declineLabel,
});

const READINGS: ReadonlySet<string> = new Set<RoutineConsentReading>(["granted", "declined", "unclear"]);

const isReading = (value: unknown): value is RoutineConsentReading => typeof value === "string" && READINGS.has(value);

const parseReading = (raw: string): RoutineConsentReading => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "decision" in parsed && isReading(parsed.decision)) {
      return parsed.decision;
    }
  } catch {
    // fall through to the safe default
  }
  return "unclear";
};

/**
 * Reads a visitor's typed reply to a consent shown to them as `granted`, `declined` or `unclear`.
 * Only an unambiguous agreement to the wording shown is `granted`; any output the model returns
 * that is not exactly one of the three reads as `unclear`, never as a decision.
 */
export class RoutineConsentReplyReader {
  private readonly promptTemplate: string;

  constructor(
    private readonly modelGateway: ConversationModelGateway,
    options: { promptTemplate?: string } = {},
  ) {
    this.promptTemplate = options.promptTemplate ?? DEFAULT_ROUTINE_CONSENT_REPLY_PROMPT;
  }

  async read(input: ConsentReplyInput): Promise<RoutineConsentReading> {
    const { text } = await this.modelGateway.complete({
      messages: latestMessage(input.turn),
      systemPrompt: renderPromptTemplate("chat/routine-consent-reply.md", this.promptTemplate, wordingVariables(input.wording)),
      metadata: { routineConsentReply: true, agentId: input.turn.agent.id },
    });
    return parseReading(text);
  }
}

/**
 * Writes what comes before a consent shown again after an unclear reply: an answer taken only
 * from the wording shown. The host shows the wording and its choices verbatim after it; this
 * answer never restates them and never says anything was agreed.
 */
export class RoutineConsentUnclearAnswerer {
  private readonly promptTemplate: string;

  constructor(
    private readonly modelGateway: ConversationModelGateway,
    options: { promptTemplate?: string } = {},
  ) {
    this.promptTemplate = options.promptTemplate ?? DEFAULT_ROUTINE_CONSENT_UNCLEAR_ANSWER_PROMPT;
  }

  async answer(input: ConsentReplyInput): Promise<string> {
    const { text } = await this.modelGateway.complete({
      messages: latestMessage(input.turn),
      systemPrompt: renderPromptTemplate(
        "chat/routine-consent-unclear-answer.md",
        this.promptTemplate,
        wordingVariables(input.wording),
      ),
      metadata: { routineConsentUnclearAnswer: true, agentId: input.turn.agent.id },
    });
    return text.trim();
  }
}
