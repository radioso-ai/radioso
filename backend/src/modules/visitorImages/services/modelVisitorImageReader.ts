import { z } from "zod";

import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import type { JsonSchemaResponseFormat } from "../../../shared/infra/llm/providerTypes.js";
import { loadPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import { errorClassOf } from "../../../shared/observability/errorClass.js";
import { VISITOR_IMAGE_LIMITS, type VisitorImageReader, type VisitorImageReading, type VisitorImageUnreadReason } from "../domain.js";

/**
 * The agent's chat model, resolved the way its turns resolve it (agent override, then workspace
 * preference, then plan or own key) and bound to one call's usage attribution, with the locale the
 * agent writes in by default. Null when the agent is gone. Composition implements it.
 */
export interface VisitorImageReadingModel {
  forAgent(input: {
    workspaceId: string;
    agentId: string;
    modelCallContext: ModelCallUsageContext;
  }): Promise<{ inference: Pick<ModelInferencePipeline, "complete">; defaultLocale: string } | null>;
}

const PROMPT = "chat/visitor-image-reading.md";
const INPUT_TAG = "visitor-image-reading-input";
const VISITOR_IMAGE_READ_OPERATION = "visitor_image.read";
/** Long enough for a vision call on a loaded provider; the photo is then unread and the turn goes on. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** A description of at most 120 words, with room for scripts that take more tokens per word. */
const MAX_OUTPUT_TOKENS = 800;

const RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  name: "visitor_image_reading",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["description"],
    properties: { description: { type: "string" } },
  },
};

const readingSchema = z.object({ description: z.string().trim().min(1) }).strict();

class InvalidReadingError extends Error {
  override readonly name = "InvalidReadingError";
}

const parseReading = (text: string): string => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidReadingError("visitor_image_reading_invalid_json");
  }
  const parsed = readingSchema.safeParse(value);
  if (!parsed.success) throw new InvalidReadingError("visitor_image_reading_invalid_shape");
  return parsed.data.description.slice(0, VISITOR_IMAGE_LIMITS.maxReadingChars);
};

const unreadReason = (error: unknown): VisitorImageUnreadReason => {
  if (error instanceof InvalidReadingError) return "invalid_result";
  if (error && typeof error === "object" && "code" in error && error.code === "image_input_unsupported") return "model_cannot_read";
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
  return "failed";
};

/**
 * One structured call per photo, at upload, on the agent's chat model: a factual description for
 * search and matching, written in the visitor's language (the agent's default when that is
 * unknown). Bounded by a timeout and failing open: any failure leaves the photo unread, which the
 * turn says rather than inventing what it showed. The call runs through the inference pipeline,
 * so its span and usage event carry `visitor_image.read`; logs carry ids and an error class only,
 * never the photo or its reading.
 */
export class ModelVisitorImageReader implements VisitorImageReader {
  constructor(private readonly deps: {
    model: VisitorImageReadingModel;
    logger: { info(fields: Record<string, unknown>, message: string): void; warn(fields: Record<string, unknown>, message: string): void };
    timeoutMs?: number;
  }) {}

  async read(input: Parameters<VisitorImageReader["read"]>[0]): Promise<VisitorImageReading> {
    const ids = { workspaceId: input.workspaceId, agentId: input.agentId, imageId: input.imageId };
    const modelCallContext: ModelCallUsageContext = {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      surface: input.surface,
      operation: VISITOR_IMAGE_READ_OPERATION,
      attemptKey: `visitor_image:${input.imageId}`,
    };
    try {
      const model = await this.deps.model.forAgent({ workspaceId: input.workspaceId, agentId: input.agentId, modelCallContext });
      if (!model) {
        this.deps.logger.warn({ ...ids, reason: "agent_not_found" }, "visitor_image_unread");
        return { kind: "unread", reason: "agent_not_found" };
      }
      const completion = await model.inference.complete({
        prompt: `${loadPromptTemplate(PROMPT)}\n\n<${INPUT_TAG}>\n${JSON.stringify({ locale: input.locale ?? model.defaultLocale })}\n</${INPUT_TAG}>`,
        images: [input.image],
        responseFormat: RESPONSE_FORMAT,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        reasoningEffort: "low",
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        operation: modelCallContext,
        validateResult: (result) => {
          parseReading(result.text);
        },
      });
      return { kind: "read", description: parseReading(completion.text) };
    } catch (error) {
      const reason = unreadReason(error);
      this.deps.logger.warn({ ...ids, reason, errorClass: errorClassOf(error) }, "visitor_image_unread");
      return { kind: "unread", reason };
    }
  }
}
