import type { ChatActionSuggestionProvider } from "./chatActionSuggestionProvider.js";

export class ChatActionSuggestionRegistry {
  private readonly providers = new Map<string, ChatActionSuggestionProvider>();

  constructor(providers: ChatActionSuggestionProvider[] = []) {
    for (const provider of providers) {
      this.register(provider);
    }
  }

  register(provider: ChatActionSuggestionProvider): void {
    if (this.providers.has(provider.name)) {
      throw new Error(`Chat action suggestion provider "${provider.name}" is already registered`);
    }
    this.providers.set(provider.name, provider);
  }

  list(): ChatActionSuggestionProvider[] {
    return [...this.providers.values()];
  }
}
