import type { AnswerSchemaExtension } from "../../../../shared/domain/answerSideChannel.js";
import type { JsonSchemaResponseFormat } from "../../../../shared/infra/llm/providerTypes.js";
import { StructuredAnswerFieldReader } from "../structuredAnswerFieldReader.js";

/**
 * The structured form of an assistant-voice reply that offers the `present` head: the extension's
 * `beforeAnswer` fields, then `answer`, then the extension's other fields. Providers write keys in
 * schema order, so the model decides what to present before it writes the reply around it.
 */
export const presentReplyResponseFormat = (extension: AnswerSchemaExtension): JsonSchemaResponseFormat => ({
  type: "json_schema",
  name: "assistant_reply_with_present",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...(extension.beforeAnswer?.properties ?? {}),
      answer: { type: "string", description: "The reply the user reads." },
      ...extension.properties,
    },
    required: [...(extension.beforeAnswer?.required ?? []), "answer", ...extension.required],
  },
});

/** The reply's text, and the fields beside it for the offer to read. */
interface PresentReplyEnvelope {
  answer: string;
  extras: Record<string, unknown> | undefined;
}

/**
 * Reads the structured reply. One that does not parse keeps whatever of `answer` can be read from
 * it and no other field, so a malformed reply can cost the turn its cards but never its text.
 */
export const readPresentReplyEnvelope = (raw: string): PresentReplyEnvelope => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const { answer, ...extras } = parsed as Record<string, unknown>;
      if (typeof answer === "string") {
        return { answer: answer.trim(), extras };
      }
    }
  } catch {
    // Not the envelope; read the answer field as far as it goes.
  }
  const reader = new StructuredAnswerFieldReader();
  reader.push(raw);
  return { answer: reader.answer.trim(), extras: undefined };
};
