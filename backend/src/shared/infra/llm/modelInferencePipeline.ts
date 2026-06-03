import type { ModelCallUsageContext } from "../../domain/modelCallUsageContext.js";
import { LLM_DEFAULTS } from "../../domain/behaviorConfig.js";
import { payloadTooLarge } from "../../domain/errors.js";
import {
  NoopUsageEventRecorder,
  type UsageEventRecorder,
  type UsageEventStatus,
} from "../../domain/usageEventRecorder.js";
import type {
  LlmProviderMetadata,
  ProviderUsage,
  TextGenerationClient,
  TextGenerationRequest,
  TextGenerationResult,
  TextGenerationStreamResult,
} from "./providerTypes.js";

export interface ModelInferenceRequest extends TextGenerationRequest {
  operation: ModelCallUsageContext;
  maxInputTokens?: number;
  validateResult?: (result: TextGenerationResult) => void;
}

export interface ModelInferencePipeline {
  readonly metadata: LlmProviderMetadata;
  complete(input: ModelInferenceRequest): Promise<TextGenerationResult>;
  stream(input: ModelInferenceRequest): TextGenerationStreamResult;
}

const estimateTokens = (bytes: number): number => Math.max(1, Math.ceil(bytes / 4));

const estimateRequestInputTokens = (request: TextGenerationRequest): number =>
  estimateTokens(Buffer.byteLength(`${request.systemPrompt ?? ""}\n${request.prompt}`, "utf8"));

const usageErrorCode = (error: unknown): string => {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  if (error instanceof Error && error.message) {
    return error.message.slice(0, 120);
  }
  return "model_call_failed";
};

const buildUsageIdempotencyKey = (
  context: ModelCallUsageContext,
  provider: string,
  model: string,
  status: UsageEventStatus,
): string => [
  "model",
  context.surface,
  context.operation,
  context.conversationId ?? `request:${context.requestId ?? "none"}`,
  context.messageId ?? "none",
  context.attemptKey,
  provider,
  model,
  status,
].join(":");

const stripOperation = (input: ModelInferenceRequest): TextGenerationRequest => {
  return {
    prompt: input.prompt,
    systemPrompt: input.systemPrompt,
    temperature: input.temperature,
    maxOutputTokens: input.maxOutputTokens,
    reasoningEffort: input.reasoningEffort,
  };
};

export class ModelInferencePipelineService implements ModelInferencePipeline {
  readonly metadata;

  constructor(
    private readonly delegate: TextGenerationClient,
    private readonly usageEventRecorder: UsageEventRecorder = new NoopUsageEventRecorder(),
  ) {
    this.metadata = delegate.metadata;
  }

  async complete(input: ModelInferenceRequest): Promise<TextGenerationResult> {
    const request = stripOperation(input);
    this.enforceInputBudget(input, request);
    let result: TextGenerationResult;
    try {
      result = await this.delegate.complete(request);
    } catch (error) {
      await this.recordUsage({
        operation: input.operation,
        request,
        outputText: "",
        status: "failed",
        error,
      });
      throw error;
    }

    try {
      input.validateResult?.(result);
    } catch (error) {
      await this.recordUsage({
        operation: input.operation,
        request,
        outputText: result.text,
        status: "failed",
        providerUsage: result.usage,
        error,
      });
      throw error;
    }

    await this.recordUsage({
      operation: input.operation,
      request,
      outputText: result.text,
      status: "succeeded",
      providerUsage: result.usage,
    });
    return result;
  }

  stream(input: ModelInferenceRequest): TextGenerationStreamResult {
    const request = stripOperation(input);
    this.enforceInputBudget(input, request);
    const result = this.delegate.stream(request);
    let outputText = "";
    const readUsage = async (): Promise<ProviderUsage | undefined> => {
      try {
        return await result.usage;
      } catch {
        return undefined;
      }
    };
    const textStream = (async function* (pipeline: ModelInferencePipelineService) {
      try {
        for await (const chunk of result.textStream) {
          outputText += chunk;
          yield chunk;
        }
        await pipeline.recordUsage({
          operation: input.operation,
          request,
          outputText,
          status: "succeeded",
          providerUsage: await readUsage(),
        });
      } catch (error) {
        await pipeline.recordUsage({
          operation: input.operation,
          request,
          outputText,
          status: "failed",
          providerUsage: await readUsage(),
          error,
        });
        throw error;
      }
    })(this);

    return { textStream, usage: result.usage };
  }

  private async recordUsage(input: {
    operation: ModelCallUsageContext;
    request: TextGenerationRequest;
    outputText: string;
    status: UsageEventStatus;
    providerUsage?: ProviderUsage;
    error?: unknown;
  }): Promise<void> {
    const inputBytes = Buffer.byteLength(`${input.request.systemPrompt ?? ""}\n${input.request.prompt}`, "utf8");
    const outputBytes = Buffer.byteLength(input.outputText, "utf8");
    const inputTokens = input.providerUsage?.inputTokens ?? estimateTokens(inputBytes);
    const outputTokens = input.providerUsage?.outputTokens ?? (outputBytes > 0 ? estimateTokens(outputBytes) : 0);
    const provider = this.delegate.metadata.provider;
    const model = this.delegate.metadata.model;

    await this.usageEventRecorder.recordModelCall({
      idempotencyKey: buildUsageIdempotencyKey(input.operation, provider, model, input.status),
      accountId: input.operation.accountId ?? null,
      workspaceId: input.operation.workspaceId,
      conversationId: input.operation.conversationId ?? null,
      messageId: input.operation.messageId ?? null,
      surface: input.operation.surface,
      operation: input.operation.operation,
      provider,
      model,
      inputTokens,
      outputTokens,
      totalTokens: input.providerUsage?.totalTokens ?? inputTokens + outputTokens,
      inputBytes,
      outputBytes,
      status: input.status,
      usageQuality: input.providerUsage?.quality ?? "estimated",
      providerRequestId: input.providerUsage?.providerRequestId ?? null,
      errorCode: input.error ? usageErrorCode(input.error) : null,
    }).catch(() => {
      // Usage accounting is observational; model results remain authoritative.
    });
  }

  private enforceInputBudget(input: ModelInferenceRequest, request: TextGenerationRequest): void {
    const maxInputTokens = input.maxInputTokens ?? LLM_DEFAULTS.textGenerationMaxInputTokens;
    const estimatedInputTokens = estimateRequestInputTokens(request);
    if (estimatedInputTokens > maxInputTokens) {
      throw payloadTooLarge("LLM prompt exceeds maximum input token budget", {
        estimatedInputTokens,
        maxInputTokens,
        surface: input.operation.surface,
        operation: input.operation.operation,
      });
    }
  }
}
