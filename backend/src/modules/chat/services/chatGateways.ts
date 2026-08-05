import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import type { ChatGateway, ChatGatewayInput } from "../contracts/chatGateway.js";
import { BlankChatAnswerError } from "./chatAnswerErrors.js";

export class ModelChatGateway implements ChatGateway {
  constructor(private readonly inference: ModelInferencePipeline) {}

  private generation(input: ChatGatewayInput) {
    return {
      maxOutputTokens: input.generation?.maxOutputTokens ?? CHAT_BEHAVIOR.answer.maxOutputTokens,
      reasoningEffort: input.generation?.reasoningEffort ?? CHAT_BEHAVIOR.answer.reasoningEffort,
      responseFormat: input.generation?.responseFormat,
    };
  }

  async answer(input: ChatGatewayInput): Promise<string> {
    const generation = this.generation(input);
    const result = await this.inference.complete({
      operation: input.usageContext,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      maxOutputTokens: generation.maxOutputTokens,
      reasoningEffort: generation.reasoningEffort,
      responseFormat: generation.responseFormat,
      signal: input.signal,
      validateResult(result) {
        if (!result.text?.trim()) {
          throw new BlankChatAnswerError();
        }
      },
    });
    return result.text;
  }

  async *streamAnswer(input: ChatGatewayInput): AsyncIterable<string> {
    const generation = this.generation(input);
    const { textStream } = this.inference.stream({
      operation: input.usageContext,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      maxOutputTokens: generation.maxOutputTokens,
      reasoningEffort: generation.reasoningEffort,
      responseFormat: generation.responseFormat,
      signal: input.signal,
    });
    for await (const chunk of textStream) {
      if (chunk.length > 0) {
        yield chunk;
      }
    }
  }
}

export class OpenAIChatGateway extends ModelChatGateway {}
