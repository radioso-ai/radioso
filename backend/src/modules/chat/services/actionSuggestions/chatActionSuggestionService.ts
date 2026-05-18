import type { ChatSuggestion } from "../../types/chatResponses.js";
import type { ChatActionSuggestionRegistry } from "./chatActionSuggestionRegistry.js";
import type { ChatActionSuggestionContext } from "./chatActionSuggestionProvider.js";

export interface ChatActionSuggestionServiceOptions {
  /**
   * Maximum number of action chips returned per turn. When more providers
   * return a suggestion than the cap allows, the providers registered first win.
   */
  maxSuggestionsPerTurn?: number;
  onError?: (providerName: string, error: unknown) => void;
}

const DEFAULT_MAX_PER_TURN = 1;

export class ChatActionSuggestionService {
  private readonly maxSuggestionsPerTurn: number;
  private readonly onError?: (providerName: string, error: unknown) => void;

  constructor(
    private readonly registry: ChatActionSuggestionRegistry,
    options: ChatActionSuggestionServiceOptions = {},
  ) {
    this.maxSuggestionsPerTurn = options.maxSuggestionsPerTurn ?? DEFAULT_MAX_PER_TURN;
    this.onError = options.onError;
  }

  async evaluate(context: ChatActionSuggestionContext): Promise<ChatSuggestion[]> {
    const providers = this.registry.list();
    if (providers.length === 0) {
      return [];
    }

    const settled = await Promise.all(
      providers.map(async (provider) => {
        try {
          const suggestion = await provider.evaluate(context);
          return { providerName: provider.name, suggestion };
        } catch (error) {
          this.onError?.(provider.name, error);
          return { providerName: provider.name, suggestion: null };
        }
      }),
    );

    const seenKinds = new Set<string>();
    const result: ChatSuggestion[] = [];
    for (const { suggestion } of settled) {
      if (!suggestion) {
        continue;
      }
      if (seenKinds.has(suggestion.kind)) {
        continue;
      }
      seenKinds.add(suggestion.kind);
      result.push(suggestion);
      if (result.length >= this.maxSuggestionsPerTurn) {
        break;
      }
    }
    return result;
  }
}
