import { z } from "zod";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { ReplyInterruption } from "../contracts/interruption.js";
import type { OperatorReplySpeech } from "../contracts/operatorReplySpeech.js";
import { storedReplyBlockSchema, type ReplyBlock, type ReplyImageUrls } from "../contracts/replyBlocks.js";
import { presentReplyBlocks } from "./replyBlocks/replyBlockBuilder.js";
import type { ChatCitation } from "../contracts/answerTypes.js";
import { skillDisplayMetadataSchema, type SkillDisplayMetadata } from "../../skills/public.js";
import type { ChatSuggestion } from "../types/chatResponses.js";

/** What a message row carries beside its text, on every read of it, public reads included. */
export interface StoredMessageFields {
  /** On an assistant reply the caller spoke over: how much of it they heard, in spoken characters. */
  interruption?: ReplyInterruption;
  /** On a teammate's reply to a caller: pending until a turn of the call speaks it, then spoken. */
  speech?: OperatorReplySpeech;
  /** The reply blocks an assistant reply showed, as the visitor saw them. */
  blocks?: ReplyBlock[];
}

const storedReplyBlocksSchema = z.array(storedReplyBlockSchema).min(1);

/**
 * A reply's blocks, read from the message row they were stored on rather than the audit stream,
 * so they replay whatever the audit retention. Blocks the row does not hold in the stored shape
 * are left out. Image addresses are built now, from the image ids the row keeps.
 */
const replyBlockFields = (message: MessageRecord, imageUrls: ReplyImageUrls | null): Pick<StoredMessageFields, "blocks"> => {
  if (!imageUrls || message.role !== "assistant") {
    return {};
  }
  const parsed = storedReplyBlocksSchema.safeParse((message.metadata as { blocks?: unknown } | undefined)?.blocks);
  return parsed.success ? { blocks: presentReplyBlocks(parsed.data, imageUrls) } : {};
};

/** The voice markers and reply blocks a message carries. */
export const storedMessageFields = (message: MessageRecord, imageUrls: ReplyImageUrls | null): StoredMessageFields => ({
  ...(message.interruption ? { interruption: message.interruption } : {}),
  ...(message.speech ? { speech: message.speech } : {}),
  ...replyBlockFields(message, imageUrls),
});

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const normalizeSuggestionCitation = (value: unknown): ChatCitation | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as { documentId?: unknown; chunkId?: unknown; title?: unknown };
  if (
    typeof candidate.documentId !== "string" ||
    typeof candidate.chunkId !== "string" ||
    typeof candidate.title !== "string"
  ) {
    return undefined;
  }

  return {
    documentId: candidate.documentId,
    chunkId: candidate.chunkId,
    title: candidate.title,
  };
};

const normalizeSuggestionKind = (value: unknown): ChatSuggestion["kind"] | null => {
  // Legacy rows persisted before `kind` was required defaulted to deeper suggestions.
  if (value === undefined) {
    return "deeper";
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeSuggestionAction = (
  value: unknown,
): NonNullable<ChatSuggestion["action"]> | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as { kind?: unknown; intent?: unknown };
  if (candidate.kind === "ask_followup") {
    return { kind: "ask_followup" };
  }
  if (candidate.kind !== "start_intent") {
    return undefined;
  }
  if (!candidate.intent || typeof candidate.intent !== "object") {
    return undefined;
  }
  const intentCandidate = candidate.intent as { skillName?: unknown; intentName?: unknown; display?: unknown };
  if (typeof intentCandidate.skillName !== "string" || intentCandidate.skillName.trim().length === 0) {
    return undefined;
  }
  const intent: { skillName: string; intentName?: string; display?: SkillDisplayMetadata } = {
    skillName: intentCandidate.skillName.trim(),
  };
  if (typeof intentCandidate.intentName === "string" && intentCandidate.intentName.trim().length > 0) {
    intent.intentName = intentCandidate.intentName.trim();
  }
  const display = skillDisplayMetadataSchema.safeParse(intentCandidate.display);
  if (display.success) {
    intent.display = display.data;
  }
  return { kind: "start_intent", intent };
};

export const normalizeChatSuggestion = (value: unknown): ChatSuggestion | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as {
    id?: unknown;
    text?: unknown;
    kind?: unknown;
    citation?: unknown;
    action?: unknown;
  };
  if (typeof candidate.text !== "string") {
    return null;
  }

  const text = normalizeWhitespace(candidate.text);
  if (!text) {
    return null;
  }

  const kind = normalizeSuggestionKind(candidate.kind);
  if (!kind) {
    return null;
  }

  const citation = normalizeSuggestionCitation(candidate.citation);
  const action = normalizeSuggestionAction(candidate.action);

  const result: ChatSuggestion = { text, kind };
  if (typeof candidate.id === "string" && candidate.id.trim().length > 0) {
    result.id = candidate.id;
  }
  if (citation) {
    result.citation = citation;
  }
  if (action) {
    result.action = action;
  }
  return result;
};

/**
 * A normal turn's suggestions live on its `chat.answer` audit event, keyed by
 * `assistantMessageId` (`buildArtifactsIndex`); a promoted bootstrap greeting has no
 * such turn event (spec 1150 Slice A: `chatSessionPreparer.promoteBootstrapGreeting`
 * writes an ordinary message row, not a turn). Its chips, when present, are on the
 * message's own metadata instead — this is the fallback read for that one case.
 */
export const messageMetadataSuggestions = (message: MessageRecord): ChatSuggestion[] | undefined => {
  const raw = (message.metadata as { suggestions?: unknown } | undefined)?.suggestions;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const normalized = raw.flatMap((suggestion) => {
    const result = normalizeChatSuggestion(suggestion);
    return result ? [result] : [];
  });
  return normalized.length > 0 ? normalized : undefined;
};
