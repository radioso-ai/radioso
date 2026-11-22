import { buildWebsiteExternalDocumentId, wasRedacted } from "./pageUrls.js";

/**
 * What a site answered for one page: the status at the end of its redirects and the address that
 * answered, or `unreachable` when it could not be asked (a network error, a timeout, or a hop the
 * navigation guard or robots.txt refused).
 */
export type WebsitePageAnswer =
  | { kind: "answered"; status: number; url: string }
  | { kind: "unreachable" };

/** Asks a site what it answers for pages now, through the crawler's guarded fetch. */
export interface WebsitePageProbe {
  /** One answer per address, in the order given. */
  probePages(urls: readonly string[], options: { signal?: AbortSignal }): Promise<WebsitePageAnswer[]>;
}

/** Whether the site said a page a crawl did not find is gone, still there, or neither. */
type PageVerdict = "gone" | "alive" | "unknown";

/**
 * The most missing pages one crawl asks the site about. When more are missing, it removes none:
 * that many is past what one crawl verifies in its time, and the next crawl decides again.
 */
export const MAX_VERIFIED_MISSING_PAGES = 200;

/** How long one crawl spends asking about missing pages. A page with no answer by then is unknown. */
const MISSING_PAGE_VERIFICATION_TIMEOUT_MS = 90_000;

/**
 * What the site's answer says about a page a crawl did not find. Gone when the site answers 404 or
 * 410, or sends the page to a different page that answers; alive when the page itself answers. Any
 * other answer (a server error, a refusal, a redirect that never lands, no answer) proves nothing.
 */
export const judgePageAnswer = (input: {
  websiteBaseUrl: string;
  externalDocumentId: string;
  answer: WebsitePageAnswer;
}): PageVerdict => {
  const { answer } = input;
  if (answer.kind !== "answered") return "unknown";
  if (answer.status === 404 || answer.status === 410) return "gone";
  if (answer.status < 200 || answer.status >= 300) return "unknown";
  const answeredId = pageIdOf(input.websiteBaseUrl, answer.url);
  if (!answeredId) return "unknown";
  return answeredId === input.externalDocumentId ? "alive" : "gone";
};

/**
 * The address to ask the site about a missing page at: the one it was published under, when that
 * address names the page's own id and nothing was redacted from it. A redacted address is not the
 * page's real one, so an answer for it says nothing about the page.
 */
export const fetchablePageUrl = (input: {
  websiteBaseUrl: string;
  externalDocumentId: string;
  pageUrl: string | null;
}): string | null => {
  if (!input.pageUrl || wasRedacted(input.pageUrl)) return null;
  return pageIdOf(input.websiteBaseUrl, input.pageUrl) === input.externalDocumentId ? input.pageUrl : null;
};

/** The missing pages a crawl removes: only the ones the site said are gone. */
export const decideVerifiedRemoval = (pages: ReadonlyArray<{ documentId: string; verdict: PageVerdict }>): {
  removeDocumentIds: string[];
  gone: number;
  alive: number;
  unknown: number;
} => {
  const removeDocumentIds = pages.filter((page) => page.verdict === "gone").map((page) => page.documentId);
  const alive = pages.filter((page) => page.verdict === "alive").length;
  return { removeDocumentIds, gone: removeDocumentIds.length, alive, unknown: pages.length - removeDocumentIds.length - alive };
};

/**
 * Asks the site about each page a crawl would remove and judges its answer. A page with no address
 * to ask at, or asked about when there is no probe, when asking fails, or after the crawl stops, is
 * unknown.
 */
export const verifyMissingPages = async (
  probe: WebsitePageProbe | undefined,
  input: {
    websiteBaseUrl: string;
    pages: ReadonlyArray<{ documentId: string; externalDocumentId: string; pageUrl: string | null }>;
    signal?: AbortSignal;
  },
): Promise<Array<{ documentId: string; verdict: PageVerdict }>> => {
  const asked = input.pages.flatMap((page) => {
    const url = fetchablePageUrl({ websiteBaseUrl: input.websiteBaseUrl, ...page });
    return url ? [{ page, url }] : [];
  });
  const answers = await askSite(probe, asked.map((entry) => entry.url), input.signal);
  const verdicts = new Map(asked.map((entry, index) => {
    const answer = answers[index] ?? { kind: "unreachable" as const };
    return [entry.page.documentId, judgePageAnswer({ websiteBaseUrl: input.websiteBaseUrl, externalDocumentId: entry.page.externalDocumentId, answer })];
  }));
  return input.pages.map((page) => ({ documentId: page.documentId, verdict: verdicts.get(page.documentId) ?? "unknown" }));
};

const askSite = async (probe: WebsitePageProbe | undefined, urls: string[], signal: AbortSignal | undefined): Promise<WebsitePageAnswer[]> => {
  if (!probe || urls.length === 0) return [];
  const timeout = AbortSignal.timeout(MISSING_PAGE_VERIFICATION_TIMEOUT_MS);
  try {
    return await probe.probePages(urls, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch {
    return [];
  }
};

const pageIdOf = (websiteBaseUrl: string, pageUrl: string): string | null => {
  try {
    return buildWebsiteExternalDocumentId({ websiteBaseUrl, pageUrl });
  } catch {
    return null;
  }
};
