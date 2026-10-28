// The port a host implements to give the engine its model: the one hard requirement.
import type { ConversationMessage } from "./index.js";

/** One generation request to the host's model. */
export interface ConversationModelRequest {
  messages: ConversationMessage[];
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
  /**
   * Set by a caller that reads a blank completion itself: the host hands it back as an empty
   * completion with its stop reason. Unset, a host may retry a blank or fail the call.
   */
  returnBlank?: boolean;
}

/**
 * Why the model stopped generating a completion: `output_limit` means the provider stopped at
 * the host's output cap (on a reasoning model, hidden reasoning counts toward that cap, so the
 * visible text can be short or empty), `completed` that it finished on its own, `other` any
 * other reason the provider gives, such as a content filter.
 */
export type ConversationModelStopReason = "completed" | "output_limit" | "other";

/** One completion from the host's model. */
export interface ConversationModelCompletion {
  text: string;
  /** Omitted when the host's provider gives no reason. */
  stopReason?: ConversationModelStopReason;
  metadata?: Record<string, unknown>;
}

export interface ConversationModelGateway {
  complete(input: ConversationModelRequest): Promise<ConversationModelCompletion>;
  /**
   * Generates the same request as text deltas, in order; joined, they are the text
   * `complete` would return, untrimmed. A stream that ends with nothing but whitespace is a
   * blank completion. Optional: a gateway without it is only ever asked to `complete`.
   */
  stream?(input: ConversationModelRequest): AsyncIterable<string>;
}
