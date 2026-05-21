import { createHash } from "node:crypto";

import { ClaudeTextGenerationClient } from "./claudeProvider.js";
import { GeminiTextGenerationClient } from "./geminiProvider.js";
import { OpenAITextGenerationClient } from "./openaiProvider.js";
import type { LlmCapabilityConfig, TextGenerationClient } from "./providerTypes.js";

export const createTextGenerationClient = (config: LlmCapabilityConfig): TextGenerationClient => {
  switch (config.provider) {
    case "openai":
    case "openai-compatible":
      return new OpenAITextGenerationClient(config);
    case "gemini":
      return new GeminiTextGenerationClient(config);
    case "claude":
      return new ClaudeTextGenerationClient(config);
  }
};

const hashApiKey = (apiKey: string): string =>
  createHash("sha256").update(apiKey).digest("hex").slice(0, 16);

const clientCacheKey = (config: LlmCapabilityConfig): string =>
  `${config.provider}:${config.model}:${hashApiKey(config.apiKey)}:${config.baseUrl ?? ""}`;

const DEFAULT_MAX_ENTRIES = 256;

export interface TextGenerationClientCacheOptions {
  /** Soft cap on cached client instances. Oldest entries evict first. */
  maxEntries?: number;
}

/**
 * Per-process cache keyed by (provider, model, hashed apiKey, baseUrl). The
 * apiKey is hashed (truncated SHA-256) so heap dumps and any incidental cache
 * logging cannot leak the live credential. The LRU bound caps memory growth
 * across long uptimes where credential rotations would otherwise pin orphaned
 * client instances forever.
 */
export class TextGenerationClientCache {
  private readonly clients = new Map<string, TextGenerationClient>();
  private readonly maxEntries: number;

  constructor(options: TextGenerationClientCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  getOrCreate(config: LlmCapabilityConfig): TextGenerationClient {
    const key = clientCacheKey(config);
    const existing = this.clients.get(key);
    if (existing) {
      // Map insertion order doubles as LRU order: re-insert to mark fresh.
      this.clients.delete(key);
      this.clients.set(key, existing);
      return existing;
    }
    if (this.clients.size >= this.maxEntries) {
      const oldest = this.clients.keys().next().value;
      if (oldest !== undefined) {
        this.clients.delete(oldest);
      }
    }
    const created = createTextGenerationClient(config);
    this.clients.set(key, created);
    return created;
  }

  /** Inspectable size for tests/diagnostics. */
  get size(): number {
    return this.clients.size;
  }
}
