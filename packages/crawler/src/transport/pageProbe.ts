import { RobotsTxtFile } from "crawlee";
import type { ValidateNavigationUrl } from "./crawler.js";
import { fetchFollowingRedirects, fetchText, toOriginScopeUrl } from "./pageFetchTransport.js";

/**
 * What a site answered for one page: the status at the end of its redirects and the address that
 * answered, or `unreachable` when the site could not be asked (a network error, a timeout, a hop
 * the navigation guard or robots.txt refused).
 */
export type PageProbeResult =
  | { kind: "answered"; status: number; url: string }
  | { kind: "unreachable" };

type ProbePagesOptions = {
  /** How many pages are asked about at once. Defaults to {@link DEFAULT_PROBE_CONCURRENCY}. */
  concurrency?: number;
  userAgent?: string;
  validateNavigationUrl?: ValidateNavigationUrl;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

const DEFAULT_PROBE_CONCURRENCY = 4;
const PROBE_TIMEOUT_MS = 10_000;

class DisallowedByRobotsError extends Error {}

/**
 * Asks a site what it answers for each page now, in the order given, through the same fetch a
 * crawl uses: every hop passes the navigation guard and the site's robots.txt, which is read once
 * per site. Only the status line is read; the page itself is not.
 */
export const probePages = async (urls: readonly string[], options: ProbePagesOptions): Promise<PageProbeResult[]> => {
  const robotsBySite = new Map<string, Promise<RobotsTxtFile | null>>();
  const robotsFor = (url: string, signal: AbortSignal): Promise<RobotsTxtFile | null> => {
    const robotsUrl = new URL(toOriginScopeUrl(url));
    robotsUrl.pathname = "/robots.txt";
    const key = robotsUrl.toString();
    let robots = robotsBySite.get(key);
    if (!robots) {
      robots = fetchText(key, { signal, userAgent: options.userAgent, validateNavigationUrl: options.validateNavigationUrl, fetchImpl: options.fetchImpl })
        // As a crawl does, a site whose robots.txt does not answer allows every page.
        .then((answer) => (answer.ok ? RobotsTxtFile.from(key, answer.body) : null));
      robotsBySite.set(key, robots);
    }
    return robots;
  };

  const probe = async (url: string): Promise<PageProbeResult> => {
    const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      signal.throwIfAborted();
      const answered = await fetchFollowingRedirects(url, {
        signal,
        userAgent: options.userAgent,
        validateNavigationUrl: options.validateNavigationUrl,
        fetchImpl: options.fetchImpl,
        beforeRequest: async (hop) => {
          const robots = await robotsFor(hop, signal);
          if (robots && !robots.isAllowed(hop, options.userAgent ?? "*")) {
            throw new DisallowedByRobotsError();
          }
        },
      });
      await answered.response.body?.cancel().catch(() => undefined);
      return { kind: "answered", status: answered.response.status, url: answered.url };
    } catch {
      return { kind: "unreachable" };
    }
  };

  const results: PageProbeResult[] = new Array(urls.length);
  let next = 0;
  const askInTurn = async (): Promise<void> => {
    while (next < urls.length) {
      const index = next;
      next += 1;
      results[index] = await probe(urls[index]);
    }
  };
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_PROBE_CONCURRENCY, urls.length));
  await Promise.all(Array.from({ length: concurrency }, askInTurn));
  return results;
};
