import { randomUUID } from "node:crypto";

import type { ModelCallUsageContext } from "../../shared/domain/modelCallUsageContext.js";
import { normalizeLocaleTag } from "../../shared/domain/locale.js";
import { renderPromptTemplate } from "../../shared/infra/prompts/promptLoader.js";

export interface AgentWizardAgentServicePort {
  create(workspaceId: string, input: {
    name: string;
    customInstruction?: string;
    greetingInstruction?: string;
    retrievalEnabled?: boolean;
  }): Promise<{ id: string; name: string }>;
  update(workspaceId: string, agentId: string, input: Record<string, unknown>): Promise<{ id: string }>;
}

export interface AgentWizardDocumentStoragePort {
  upload(input: {
    workspaceId: string;
    documentId: string;
    filename: string;
    mimeType: string;
    buffer: Buffer;
  }): Promise<{ bucket: string; objectPath: string; generation?: string | null; sizeBytes: number }>;
}

export interface AgentWizardWebsiteCrawlerPort {
  enqueue(input: {
    accountId?: string | null;
    workspaceId: string;
    url: string;
    limit: number;
  }): Promise<{ jobId: string; sourceId: string | null }>;
}

export interface AgentWizardTextGenerationPort {
  complete(input: {
    operation: ModelCallUsageContext;
    prompt: string;
    systemPrompt?: string;
    temperature?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }): Promise<string>;
}

export type AgentWizardUrlPolicy = (url: string) => Promise<void>;

export interface AgentWizardCrawlerLimits {
  defaultLimit: number;
  maxLimit: number;
}

export interface WizardAnalysisResult {
  suggestedName: string;
  suggestedCustomInstruction: string;
  suggestedGreetingMessage: string;
  suggestedChunkingStrategy: {
    strategy: "fixed_window" | "structured_semantic";
    reasoning: string;
  };
  screenshotBase64: string | null;
  screenshotUnavailableReason: string | null;
  faviconUrl: string | null;
  pagesAnalyzed: Array<{ url: string; title: string | null }>;
  sourceUrl: string;
  suggestedLocale: string | null;
  suggestedPrivacyPolicyUrl: string | null;
  suggestedContactEmail: string | null;
}

export interface WizardCreateInput {
  websiteUrl: string;
  name: string;
  customInstruction?: string;
  greetingInstruction?: string;
  chunkingStrategy?: "fixed_window" | "structured_semantic";
  faviconUrl?: string | null;
  assistantDefaultLocale?: string | null;
  privacyPolicyUrl?: string | null;
  contactEmail?: string | null;
}

export interface WizardCreateResult {
  agentId: string;
  crawlJobId: string | null;
}

export interface CrawlerPort {
  fetchPageWithScreenshot(
    url: string,
    options?: {
      signal?: AbortSignal;
      validateNavigationUrl?: (url: string) => Promise<void> | void;
    },
  ): Promise<{
    url: string;
    title: string | null;
    text: string;
    links: string[];
    screenshot: Uint8Array | null;
    faviconUrl: string | null;
  }>;
  crawlSite(
    params: {
      baseUrl: string;
      pageLimit: number;
      seedPendingUrls?: string[];
      includeBaseUrl?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<Array<{
    url: string;
    title: string | null;
    text: string;
    status: string;
    links?: string[];
    httpStatus?: number | null;
    error?: string | null;
  }>>;
  isBrowserTransportAvailable(): Promise<boolean>;
}

export type AgentWizardErrorCode =
  | "site_unreachable"
  | "authentication_required"
  | "analysis_timeout"
  | "content_too_sparse"
  | "analysis_not_found"
  | "llm_unavailable"
  | "rate_limited"
  | "cancelled"
  | "invalid_url";

export class AgentWizardError extends Error {
  constructor(
    readonly code: AgentWizardErrorCode,
    message: string,
    readonly statusCode = 422,
  ) {
    super(message);
    this.name = "AgentWizardError";
  }
}

export interface AgentWizardProgressEvent {
  type: "progress";
  step: "crawling" | "analyzing" | "generating" | "complete";
  page?: number;
  total?: number;
  url?: string;
  title?: string | null;
}

interface AgentWizardDependencies {
  textGenerationClient: AgentWizardTextGenerationPort;
  agentService: AgentWizardAgentServicePort;
  documentStorage: AgentWizardDocumentStoragePort;
  websiteCrawlJobService: AgentWizardWebsiteCrawlerPort;
  crawlerProvider: CrawlerPort;
  assertPublicWebsiteUrl: AgentWizardUrlPolicy;
  crawlerLimits: AgentWizardCrawlerLimits;
  auditService: {
    record(input: {
      accountId?: string | null;
      workspaceId?: string | null;
      eventType: string;
      eventStatus: "success" | "failure";
      metadata?: Record<string, unknown>;
    }): Promise<void>;
  };
  fetchImpl?: typeof fetch;
}

const MAX_CONTENT_LENGTH = 30_000;
const MAX_ANALYSIS_PAGES = 10;
const MAX_CANDIDATE_LINKS = 80;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const selectKeyPageUrls = (links: string[], baseUrl: string, limit: number): string[] => {
  const baseOrigin = new URL(baseUrl).origin;
  const candidates = links
    .filter((link) => {
      try {
        return new URL(link).origin === baseOrigin;
      } catch {
        return false;
      }
    })
    .map((link, index) => {
      const parsed = new URL(link);
      return {
        url: parsed.toString(),
        depth: parsed.pathname.split("/").filter(Boolean).length,
        length: parsed.pathname.length,
        index,
      };
    })
    .sort((a, b) => a.depth - b.depth || a.length - b.length || a.index - b.index);

  const seen = new Set<string>();
  const selected: string[] = [];
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    const normalized = candidate.url.replace(/\/$/, "");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    selected.push(candidate.url);
  }
  return selected;
};

const MIN_MEANINGFUL_CONTENT_LENGTH = 120;

const isAbortError = (error: unknown) =>
  error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));

const classifyFetchError = (error: unknown): AgentWizardError => {
  if (error instanceof AgentWizardError) {
    return error;
  }

  const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === "number"
    ? (error as { statusCode: number }).statusCode
    : typeof (error as { status?: unknown })?.status === "number"
      ? (error as { status: number }).status
      : undefined;
  const code = typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code
    : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = `${code} ${message}`.toLowerCase();

  if (statusCode === 401 || statusCode === 403 || normalized.includes("401") || normalized.includes("403")) {
    return new AgentWizardError(
      "authentication_required",
      "The website requires authentication before we can analyze it.",
    );
  }

  if (isAbortError(error) || normalized.includes("timeout") || normalized.includes("timed out")) {
    return new AgentWizardError(
      "analysis_timeout",
      "Website analysis timed out. Try again, or reduce the amount of content to analyze.",
      504,
    );
  }

  if (
    normalized.includes("enotfound") ||
    normalized.includes("econnrefused") ||
    normalized.includes("econnreset") ||
    normalized.includes("network") ||
    normalized.includes("could not fetch")
  ) {
    return new AgentWizardError(
      "site_unreachable",
      "We could not reach that website. Check the URL and make sure it is publicly accessible.",
    );
  }

  return new AgentWizardError(
    "site_unreachable",
    "We could not reach that website. Check the URL and make sure it is publicly accessible.",
  );
};

const createAnalysisSignal = (
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
) => {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const abortFromParent = () => controller.abort();
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  if (parentSignal?.aborted) {
    controller.abort();
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    cleanup() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
};

// Strip characters that could be used to escape prompt structure when a
// URL is interpolated outside the <untrusted_crawled_content> fence.
// Valid HTTP URLs don't contain raw "<" or ">" — Node's URL constructor
// percent-encodes them — but only the parsed form is safe. Be defensive
// and strip them again at the prompt boundary.
const sanitizeUrlForPrompt = (url: string): string =>
  url.replace(/[<>"]/g, "");

const buildAnalysisPrompt = (
  websiteUrl: string,
  pageCount: number,
  content: string,
  candidateLinks: string[],
): string => {
  return renderPromptTemplate("agent-wizard/analyze-website.md", {
    website_url: sanitizeUrlForPrompt(websiteUrl),
    page_count: String(pageCount),
    website_content: content,
    candidate_links: candidateLinks.map(sanitizeUrlForPrompt).join("\n"),
  });
};

const normalizeComparableUrl = (url: string): string | null => {
  try {
    return new URL(url).toString();
  } catch {
    return null;
  }
};

const collectCandidateLinks = (
  pages: Array<{ links?: string[] }>,
  baseUrl: string,
): string[] => {
  const baseOrigin = new URL(baseUrl).origin;
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const page of pages) {
    for (const rawLink of page.links ?? []) {
      if (selected.length >= MAX_CANDIDATE_LINKS) return selected;
      let parsed: URL;
      try {
        parsed = new URL(rawLink, baseUrl);
      } catch {
        continue;
      }
      if (parsed.origin !== baseOrigin) continue;
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      const normalized = parsed.toString();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      selected.push(normalized);
    }
  }
  return selected;
};

const normalizeOptionalLocale = (value: unknown): string | null => {
  try {
    return normalizeLocaleTag(value, "language");
  } catch {
    return null;
  }
};

const normalizeOptionalEmail = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 320 || !EMAIL_PATTERN.test(trimmed)) return null;
  return trimmed;
};

interface LlmAnalysisResponse {
  agentName: string;
  customInstruction: string;
  greetingMessage: string;
  contentType: string;
  chunkingStrategy: string;
  chunkingRationale: string;
  language?: string | null;
  privacyPolicyUrl?: string | null;
  contactEmail?: string | null;
}

const parseLlmResponse = (raw: string): LlmAnalysisResponse | null => {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned);
    if (
      typeof parsed.agentName === "string" &&
      typeof parsed.customInstruction === "string" &&
      typeof parsed.greetingMessage === "string" &&
      typeof parsed.chunkingStrategy === "string"
    ) {
      return parsed as LlmAnalysisResponse;
    }
    return null;
  } catch {
    return null;
  }
};

export class AgentWizardService {
  constructor(private readonly dependencies: AgentWizardDependencies) {}

  async analyzeWebsite(input: {
    url: string;
    workspaceId: string;
    accountId?: string | null;
    signal?: AbortSignal;
    timeoutMs?: number;
    onProgress?: (event: AgentWizardProgressEvent) => void;
  }): Promise<WizardAnalysisResult> {
    await this.assertSafeUrl(input.url);

    const crawler = this.dependencies.crawlerProvider;
    const analysisSignal = createAnalysisSignal(input.signal, input.timeoutMs ?? 90_000);
    const analysisRunId = randomUUID();

    const throwIfAborted = () => {
      if (!analysisSignal.signal.aborted) return;
      throw new AgentWizardError(
        analysisSignal.timedOut ? "analysis_timeout" : "cancelled",
        analysisSignal.timedOut
          ? "Website analysis timed out. Try again, or reduce the amount of content to analyze."
          : "Website analysis was cancelled.",
        analysisSignal.timedOut ? 504 : 499,
      );
    };

    try {
      let homepage: {
        url: string;
        title: string | null;
        text: string;
        links: string[];
        screenshot: Uint8Array | null;
        faviconUrl: string | null;
      };
      let screenshotUnavailableReason: string | null = null;

      throwIfAborted();
      input.onProgress?.({ type: "progress", step: "crawling", page: 1, total: MAX_ANALYSIS_PAGES, url: input.url });

      const browserAvailable = await crawler.isBrowserTransportAvailable();
      if (browserAvailable) {
        try {
          homepage = await crawler.fetchPageWithScreenshot(input.url, {
            signal: analysisSignal.signal,
            // Validate every navigation URL before the browser hits the wire,
            // so a redirect to localhost / RFC1918 / cloud metadata is aborted
            // before any request reaches the target.
            validateNavigationUrl: (hopUrl: string) => this.assertSafeUrl(hopUrl),
          });
        } catch (error) {
          throwIfAborted();
          // Don't fall back for terminal classifications (auth-required,
          // SSRF policy, abort). HTTP would either repeat the same failure
          // or be wrong (e.g. authentication_required → "site_unreachable").
          if (error instanceof AgentWizardError) {
            throw error;
          }
          const classified = classifyFetchError(error);
          if (classified.code === "authentication_required" || classified.code === "invalid_url") {
            throw classified;
          }
          // Browser was available but navigation failed at runtime (timeout,
          // network error, etc.). Fall back to HTTP so a single page-load
          // failure doesn't kill the whole wizard.
          screenshotUnavailableReason = "browser_navigation_failed";
          homepage = await this.fetchHomepageViaHttp(crawler, input.url, analysisSignal.signal, error);
        }
      } else {
        screenshotUnavailableReason = "browser_unavailable";
        homepage = await this.fetchHomepageViaHttp(crawler, input.url, analysisSignal.signal, null);
      }
      // Re-validate the loaded URL: page.goto follows redirects, and a public
      // input URL can redirect to localhost / RFC1918 / cloud metadata.
      // Re-running the public-host policy on the final URL closes that gap.
      if (homepage.url !== input.url) {
        await this.assertSafeUrl(homepage.url);
      }
      input.onProgress?.({ type: "progress", step: "crawling", page: 1, total: MAX_ANALYSIS_PAGES, url: homepage.url, title: homepage.title });

      // Use the loaded URL as the scope for link selection and follow-up
      // crawling. Common www-prefix redirects (e.g. example.com → www.example.com)
      // would otherwise drop every link on the loaded page because they don't
      // match the input origin, leaving the wizard to analyze a single page.
      const baseForFollowUp = homepage.url;
      const keyPageUrls = selectKeyPageUrls(
        homepage.links,
        baseForFollowUp,
        MAX_ANALYSIS_PAGES - 1,
      );

      let additionalPages: Array<{
        url: string;
        title: string | null;
        text: string;
        status: string;
        links?: string[];
      }> = [];
      try {
        additionalPages = keyPageUrls.length > 0
          ? await crawler.crawlSite({
              baseUrl: baseForFollowUp,
              pageLimit: keyPageUrls.length,
              seedPendingUrls: keyPageUrls,
              includeBaseUrl: false,
              signal: analysisSignal.signal,
            })
          : [];
      } catch {
        throwIfAborted();
        additionalPages = [];
      }
      additionalPages.forEach((page, index) => {
        if (page.status === "success") {
          input.onProgress?.({
            type: "progress",
            step: "crawling",
            page: index + 2,
            total: Math.min(MAX_ANALYSIS_PAGES, keyPageUrls.length + 1),
            url: page.url,
            title: page.title,
          });
        }
      });
      throwIfAborted();

      const allPages = [
        { url: homepage.url, title: homepage.title, text: homepage.text, links: homepage.links },
        ...additionalPages
          .filter((p: { status: string; text: string }) => p.status === "success" && p.text)
          .map((p: { url: string; title: string | null; text: string; links?: string[] }) => ({
            url: p.url,
            title: p.title,
            text: p.text,
            links: p.links,
          })),
      ];

      let combinedContent = "";
      for (const page of allPages) {
        const header = `\n\n--- Page: ${page.url} ---\n`;
        const remaining = MAX_CONTENT_LENGTH - combinedContent.length - header.length;
        if (remaining <= 0) break;
        combinedContent += header + page.text.slice(0, remaining);
      }

      if (combinedContent.trim().length < MIN_MEANINGFUL_CONTENT_LENGTH) {
        throw new AgentWizardError(
          "content_too_sparse",
          "We could not find enough public content on that website. Upload documents instead, or try a URL with more visible content.",
        );
      }

      input.onProgress?.({ type: "progress", step: "analyzing" });
      const candidateLinks = collectCandidateLinks([
        { links: homepage.links },
        ...additionalPages.map((page) => ({ links: page.links })),
      ], baseForFollowUp);
      const prompt = buildAnalysisPrompt(input.url, allPages.length, combinedContent.trim(), candidateLinks);
      input.onProgress?.({ type: "progress", step: "generating" });
      let analysis = await this.callLlm(prompt, analysisSignal.signal, {
        accountId: input.accountId ?? null,
        workspaceId: input.workspaceId,
        requestId: analysisRunId,
        surface: "agent_wizard",
        operation: "analyze_website",
        attemptKey: "primary",
      });
      throwIfAborted();
      if (!analysis) {
        analysis = await this.callLlm(prompt + "\n\nIMPORTANT: You must return valid JSON only.", analysisSignal.signal, {
          accountId: input.accountId ?? null,
          workspaceId: input.workspaceId,
          requestId: analysisRunId,
          surface: "agent_wizard",
          operation: "analyze_website",
          attemptKey: "json_retry",
        });
        throwIfAborted();
      }
      if (!analysis) {
        throw new AgentWizardError(
          "llm_unavailable",
          "We crawled the website, but could not generate assistant settings. Try again in a few minutes.",
          503,
        );
      }
      const result = analysis;

      const screenshotBase64 = homepage.screenshot
        ? Buffer.from(homepage.screenshot).toString("base64")
        : null;

      const chunkingStrategy = result.chunkingStrategy === "fixed_window" ? "fixed_window" as const : "structured_semantic" as const;
      const suggestedLocale = normalizeOptionalLocale(result.language);
      const suggestedPrivacyPolicyUrl = await this.validateSuggestedPrivacyPolicyUrl(
        result.privacyPolicyUrl,
        candidateLinks,
      );
      const suggestedContactEmail = normalizeOptionalEmail(result.contactEmail);

      await this.dependencies.auditService.record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: "agent_wizard.analyze_website",
        eventStatus: "success",
        metadata: {
          url: input.url,
          pagesAnalyzed: allPages.length,
          suggestedStrategy: chunkingStrategy,
          detectedLocale: suggestedLocale !== null,
          detectedPrivacyPolicy: suggestedPrivacyPolicyUrl !== null,
          detectedContactEmail: suggestedContactEmail !== null,
        },
      }).catch(() => {});

      const resultPayload = {
        suggestedName: result.agentName.slice(0, 200),
        suggestedCustomInstruction: result.customInstruction.slice(0, 2000),
        suggestedGreetingMessage: result.greetingMessage.slice(0, 200),
        suggestedChunkingStrategy: {
          strategy: chunkingStrategy,
          reasoning: result.chunkingRationale ?? "",
        },
        screenshotBase64,
        screenshotUnavailableReason,
        faviconUrl: homepage.faviconUrl,
        pagesAnalyzed: allPages.map((p) => ({ url: p.url, title: p.title })),
        sourceUrl: input.url,
        suggestedLocale,
        suggestedPrivacyPolicyUrl,
        suggestedContactEmail,
      };
      input.onProgress?.({ type: "progress", step: "complete" });
      return resultPayload;
    } finally {
      analysisSignal.cleanup();
    }
  }

  async createAgentFromWizard(input: {
    workspaceId: string;
    accountId?: string | null;
    config: WizardCreateInput;
    signal?: AbortSignal;
  }): Promise<WizardCreateResult> {
    if (input.config.websiteUrl) {
      await this.assertSafeUrl(input.config.websiteUrl);
    }
    if (input.config.faviconUrl) {
      await this.assertSafeUrl(input.config.faviconUrl);
    }
    if (input.config.privacyPolicyUrl) {
      await this.assertSafeUrl(input.config.privacyPolicyUrl);
    }

    const agent = await this.dependencies.agentService.create(input.workspaceId, {
      name: input.config.name,
      customInstruction: input.config.customInstruction,
      greetingInstruction: input.config.greetingInstruction,
      retrievalEnabled: true,
    });

    const updatePayload: Record<string, unknown> = {};
    if (input.config.faviconUrl) {
      const logo = await this.uploadFaviconAsLogo(input.workspaceId, agent.id, input.config.faviconUrl, input.signal).catch(() => null);
      if (logo) {
        updatePayload.logo = logo;
      }
    }
    const normalizedLocale = normalizeOptionalLocale(input.config.assistantDefaultLocale);
    if (normalizedLocale) {
      updatePayload.assistantDefaultLocale = normalizedLocale;
    }
    if (input.config.privacyPolicyUrl) {
      updatePayload.branding = {
        hidePoweredBy: false,
        privacyPolicyUrl: new URL(input.config.privacyPolicyUrl).toString(),
      };
    }
    const contactEmail = normalizeOptionalEmail(input.config.contactEmail);
    if (contactEmail) {
      updatePayload.contactRequestDelivery = {
        recipientEmails: [contactEmail],
        webhook: null,
      };
    }
    if (Object.keys(updatePayload).length > 0) {
      await this.dependencies.agentService.update(input.workspaceId, agent.id, updatePayload);
    }

    // The LLM-suggested chunking strategy is captured in the audit event
    // below but NOT applied to the workspace's IngestionSettings here.
    // chunkingStrategy is workspace-scoped, so writing it would silently
    // change retrieval behavior for every other agent and every previously
    // ingested document in this workspace — based on the content of a
    // single new site. The user can pick up the suggestion explicitly from
    // the agent settings page if they want it applied.

    let crawlJobId: string | null = null;
    if (input.config.websiteUrl) {
      const { defaultLimit, maxLimit } = this.dependencies.crawlerLimits;
      const limit = Math.max(1, Math.min(defaultLimit, maxLimit));
      const crawlResult = await this.dependencies.websiteCrawlJobService.enqueue({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        url: input.config.websiteUrl,
        limit,
      });
      crawlJobId = crawlResult.jobId;
    }

    await this.dependencies.auditService.record({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "agent_wizard.create_agent",
      eventStatus: "success",
      metadata: {
        agentId: agent.id,
        agentName: input.config.name,
        websiteUrl: input.config.websiteUrl,
        chunkingStrategy: input.config.chunkingStrategy,
        crawlJobId,
        appliedLocale: normalizedLocale !== null,
        appliedPrivacyPolicy: Boolean(input.config.privacyPolicyUrl),
        appliedContactEmail: contactEmail !== null,
      },
    }).catch(() => {});

    return { agentId: agent.id, crawlJobId };
  }

  private async fetchHomepageViaHttp(
    crawler: CrawlerPort,
    url: string,
    signal: AbortSignal,
    upstreamError: unknown,
  ): Promise<{
    url: string;
    title: string | null;
    text: string;
    links: string[];
    screenshot: Uint8Array | null;
    faviconUrl: string | null;
  }> {
    const httpPages = await crawler.crawlSite({
      baseUrl: url,
      pageLimit: 1,
      includeBaseUrl: true,
      signal,
    });
    const first = httpPages[0];
    if (!first || first.status !== "success") {
      // Pass full failure metadata (httpStatus + error message) to the
      // classifier so a 401/403/429 from the HTTP path surfaces as
      // authentication_required instead of generic site_unreachable.
      const failureSignal = first
        ? { httpStatus: first.httpStatus ?? undefined, status: first.httpStatus, message: first.error ?? `HTTP fetch ${first.status}` }
        : upstreamError ?? new Error("HTTP fetch failed");
      throw classifyFetchError(failureSignal);
    }
    return {
      url: first.url,
      title: first.title,
      text: first.text,
      links: (first as { links?: string[] }).links ?? [],
      screenshot: null,
      faviconUrl: null,
    };
  }

  private async assertSafeUrl(value: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new AgentWizardError("invalid_url", "URL must be valid", 400);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new AgentWizardError("invalid_url", "URL must use http or https", 400);
    }
    try {
      await this.dependencies.assertPublicWebsiteUrl(parsed.toString());
    } catch (error) {
      const message = error instanceof Error ? error.message : "URL must resolve to a publicly routable host";
      throw new AgentWizardError("invalid_url", message, 400);
    }
  }

  private async callLlm(
    prompt: string,
    signal: AbortSignal,
    operation: ModelCallUsageContext,
  ): Promise<LlmAnalysisResponse | null> {
    try {
      const raw = await this.dependencies.textGenerationClient.complete({
        operation,
        prompt,
        temperature: 0,
        maxOutputTokens: 1024,
        signal,
      });
      return parseLlmResponse(raw);
    } catch {
      return null;
    }
  }

  private async validateSuggestedPrivacyPolicyUrl(
    value: unknown,
    candidateLinks: string[],
  ): Promise<string | null> {
    if (typeof value !== "string") return null;
    const normalized = normalizeComparableUrl(value.trim());
    if (!normalized) return null;
    const candidateSet = new Set(candidateLinks.map(normalizeComparableUrl).filter((url): url is string => Boolean(url)));
    if (!candidateSet.has(normalized)) return null;
    try {
      await this.assertSafeUrl(normalized);
      return normalized;
    } catch {
      return null;
    }
  }

  private async uploadFaviconAsLogo(
    workspaceId: string,
    agentId: string,
    faviconUrl: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    // Favicon hosts often redirect (CDNs, default /favicon.ico). We can't
    // use redirect:"follow" because the browser would issue a request to a
    // private host on a redirect before we get a chance to validate. Instead,
    // walk the redirect chain manually: validate each URL before fetching,
    // and bail silently on policy failures (favicon is optional).
    const fetchFn = this.dependencies.fetchImpl ?? fetch;
    const MAX_HOPS = 5;
    let currentUrl = faviconUrl;
    let response: Response | null = null;
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      try {
        await this.assertSafeUrl(currentUrl);
      } catch {
        return null;
      }
      const timeoutSignal = AbortSignal.timeout(10_000);
      response = await fetchFn(currentUrl, {
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return null;
        try {
          currentUrl = new URL(location, currentUrl).toString();
        } catch {
          return null;
        }
        continue;
      }
      break;
    }
    if (!response || !response.ok) return null;

    const contentType = response.headers.get("content-type") ?? "image/png";
    const allowedTypes = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/x-icon", "image/vnd.microsoft.icon"];
    if (!allowedTypes.some((t) => contentType.startsWith(t))) return null;

    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > 1_048_576) return null;

    const extension = contentType.includes("png") ? "png"
      : contentType.includes("jpeg") ? "jpg"
      : contentType.includes("webp") ? "webp"
      : contentType.includes("gif") ? "gif"
      : "ico";

    const uploadResult = await this.dependencies.documentStorage.upload({
      workspaceId,
      documentId: `assistant-logo-${agentId}-${crypto.randomUUID()}`,
      filename: `favicon.${extension}`,
      mimeType: contentType,
      buffer: Buffer.from(buffer),
    });

    return {
      bucket: uploadResult.bucket,
      objectPath: uploadResult.objectPath,
      generation: uploadResult.generation ?? null,
      mimeType: contentType,
      filename: `favicon.${extension}`,
      sizeBytes: uploadResult.sizeBytes,
    };
  }
}
