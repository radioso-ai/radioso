/**
 * Serializes OAuth token refreshes so that concurrent callers for the SAME
 * connection do not each spend the (often single-use, rotating) refresh token.
 * Without this, two simultaneous turns that both see an expired access token
 * each call the refresh grant; providers that rotate refresh tokens (Google,
 * Microsoft Graph) invalidate the first token when the second redeems it, so the
 * loser's refresh fails and a perfectly healthy connection is wrongly flagged
 * `needs_reauth`.
 */
export interface OauthRefreshCoordinator {
  /**
   * Run `refresh` under the given key. Concurrent calls for the same key share a
   * single in-flight execution and resolve/reject with its result.
   */
  coordinate<T>(key: string, refresh: () => Promise<T>): Promise<T>;
}

/**
 * In-process single-flight coordinator. Scope is the current process: refreshes
 * dispatched from the API process (where routine/skill execution runs) are
 * deduplicated. Cross-process concurrency (a second backend or the worker
 * refreshing the same connection in the same instant) is not serialized; that
 * window is small and the refresh failure is now treated as transient rather
 * than terminal (see the access-token resolver), so it degrades to a retry
 * instead of a spurious re-authorization.
 */
export class InProcessOauthRefreshCoordinator implements OauthRefreshCoordinator {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  coordinate<T>(key: string, refresh: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }
    // `then(refresh)` defers the call to a microtask so a synchronous throw still
    // becomes a rejection that the `finally` cleans up.
    const started = Promise.resolve().then(refresh).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, started);
    return started;
  }
}

/**
 * Shared default used by the access-token resolver when no coordinator is
 * injected. A single instance per process is required for single-flight to
 * actually dedupe across call sites (customer email + external MCP skills both
 * resolve through it).
 */
export const defaultOauthRefreshCoordinator: OauthRefreshCoordinator = new InProcessOauthRefreshCoordinator();
