// Holds the backend's admitted embed-config answers for a short while, so the
// page views of a host site don't each reach the backend. The launcher fetches
// the config on every page view; without this, each one costs backend reads,
// a rate-limit write, and a grant touch.
//
// Keyed by token and requesting origin, because the backend admits origins per
// agent. Only admitted answers are kept: a refusal can be specific to who asked
// (a rate limit, say), so it is never replayed to anyone else.

type CachedEmbedConfig = {
  body: string
  contentType: string
}

type EmbedConfigCacheOptions = {
  ttlMs: number
  maxEntries: number
  now?: () => number
}

type CacheEntry = CachedEmbedConfig & { expiresAt: number }

type EmbedConfigCache = {
  get(token: string, origin: string | null): CachedEmbedConfig | null
  set(token: string, origin: string | null, config: CachedEmbedConfig): void
}

const cacheKey = (token: string, origin: string | null) => JSON.stringify([token, origin])

export const createEmbedConfigCache = ({ ttlMs, maxEntries, now = Date.now }: EmbedConfigCacheOptions): EmbedConfigCache => {
  const entries = new Map<string, CacheEntry>()

  return {
    get(token, origin) {
      const key = cacheKey(token, origin)
      const entry = entries.get(key)
      if (!entry) {
        return null
      }
      if (entry.expiresAt <= now()) {
        entries.delete(key)
        return null
      }
      return { body: entry.body, contentType: entry.contentType }
    },
    set(token, origin, config) {
      const key = cacheKey(token, origin)
      entries.delete(key)
      // Map keeps insertion order, so the first key is the oldest answer.
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) {
          break
        }
        entries.delete(oldest)
      }
      entries.set(key, { ...config, expiresAt: now() + ttlMs })
    },
  }
}
