import { load } from "cheerio";

const HTML_ENTITY_LOOKUP: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
  Auml: "Ä",
  auml: "ä",
  Ouml: "Ö",
  ouml: "ö",
  Otilde: "Õ",
  otilde: "õ",
  Uuml: "Ü",
  uuml: "ü"
};

const isValidCodePoint = (value: number) =>
  Number.isInteger(value) && value >= 0 && value <= 0x10ffff;

export const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    if (entity.startsWith("#")) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    return HTML_ENTITY_LOOKUP[entity] ?? match;
  });

export const normalizeText = (value: string): string =>
  decodeEntities(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n\n(?=- )/g, "\n")
    .trim();

export const stripTags = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const firstContentfulMatch = (html: string, pattern: RegExp): string | null => {
  pattern.lastIndex = 0;
  for (const match of html.matchAll(pattern)) {
    const content = match[match.length - 1] ?? "";
    if (normalizeText(stripTags(content))) {
      return content;
    }
  }
  return null;
};

export const extractMainContentHtml = (html: string): string => {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  return firstContentfulMatch(cleaned, /<main\b[^>]*>([\s\S]*?)<\/main>/gi) ??
    firstContentfulMatch(cleaned, /<article\b[^>]*>([\s\S]*?)<\/article>/gi) ??
    firstContentfulMatch(
      cleaned,
      /<([a-z][\w:-]*)\b(?=[^>]*\brole\s*=\s*["']main["'])[^>]*>([\s\S]*?)<\/\1>/gi
    ) ??
    cleaned.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ??
    cleaned;
};

const renderBlockquote = (html: string): string => {
  const text = stripTags(html);
  if (!text) return "";
  return `\n\n${text
    .split(/\n+/)
    .map((line) => `> ${line.trim()}`)
    .join("\n")}\n\n`;
};

export type ExtractionOptions = {
  preserveContentLinks?: boolean;
};

const DEFAULT_EXTRACTION_BASE_URL = "http://localhost/";

const resolveExtractionArguments = (
  baseUrlOrOptions?: string | ExtractionOptions,
  options: ExtractionOptions = {}
): { baseUrl: string; options: ExtractionOptions } => {
  if (typeof baseUrlOrOptions === "string") {
    return { baseUrl: baseUrlOrOptions, options };
  }
  return {
    baseUrl: DEFAULT_EXTRACTION_BASE_URL,
    options: baseUrlOrOptions ?? options
  };
};

const resolveTextContentUrl = (value: string | undefined, baseUrl: string): string | null => {
  const trimmed = decodeEntities(value ?? "").trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  try {
    const parsed = new URL(trimmed, baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

const escapeMarkdownLinkText = (value: string): string =>
  value.replace(/([\\[\]])/g, "\\$1");

const withoutTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value.slice(0, -1) : value;

const normalizeYouTubeEmbedUrl = (url: URL): string | null => {
  const host = url.hostname.replace(/^www\./, "").replace(/^m\./, "");
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") {
    return null;
  }
  const [embedSegment, videoId] = url.pathname.split("/").filter(Boolean);
  if (embedSegment !== "embed" || !videoId) {
    return null;
  }
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
};

const isKnownEmbeddedMediaUrl = (url: URL): boolean => {
  const host = url.hostname.replace(/^www\./, "").replace(/^player\./, "");
  return host === "youtube.com" ||
    host === "youtube-nocookie.com" ||
    host === "youtu.be" ||
    host === "vimeo.com";
};

const normalizeEmbeddedMediaUrl = (value: string | undefined, baseUrl: string): string | null => {
  const resolved = resolveTextContentUrl(value, baseUrl);
  if (!resolved) {
    return null;
  }
  const parsed = new URL(resolved);
  const youtubeUrl = normalizeYouTubeEmbedUrl(parsed);
  if (youtubeUrl) {
    return youtubeUrl;
  }
  return isKnownEmbeddedMediaUrl(parsed) ? parsed.toString() : null;
};

const isShareOrTrackingUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (
      host === "facebook.com" ||
      host === "twitter.com" ||
      host === "x.com" ||
      host === "linkedin.com" ||
      host === "pinterest.com"
    ) {
      return true;
    }
    return [...parsed.searchParams.keys()].some((key) => /^utm_|^(?:fbclid|gclid)$/i.test(key));
  } catch {
    return false;
  }
};

const renderContentUrls = (html: string, baseUrl: string, options: ExtractionOptions = {}): string => {
  const preserveContentLinks = options.preserveContentLinks ?? true;
  const $ = load(html);
  $("iframe").each((_index, element) => {
    const frame = $(element);
    const mediaUrl =
      normalizeEmbeddedMediaUrl(frame.attr("data-lazy-src"), baseUrl) ??
      normalizeEmbeddedMediaUrl(frame.attr("data-src"), baseUrl) ??
      normalizeEmbeddedMediaUrl(frame.attr("src"), baseUrl);
    if (mediaUrl && preserveContentLinks) {
      frame.replaceWith(`\n\n<p>Video: ${mediaUrl}</p>\n\n`);
      return;
    }
    frame.remove();
  });
  $("a[href]").each((_index, element) => {
    const anchor = $(element);
    const url = resolveTextContentUrl(anchor.attr("href"), baseUrl);
    const label = normalizeText(anchor.text());
    if (!url) {
      anchor.replaceWith(label);
      return;
    }
    if (!preserveContentLinks || isShareOrTrackingUrl(url)) {
      anchor.replaceWith(label);
      return;
    }
    if (!label || withoutTrailingSlash(label) === withoutTrailingSlash(url)) {
      anchor.replaceWith(url);
      return;
    }
    anchor.replaceWith(`[${escapeMarkdownLinkText(label)}](${url})`);
  });
  return $.html();
};

export const formatHtmlAsMarkdown = (
  html: string,
  baseUrlOrOptions?: string | ExtractionOptions,
  extractionOptions: ExtractionOptions = {}
): string => {
  const { baseUrl, options } = resolveExtractionArguments(baseUrlOrOptions, extractionOptions);
  return renderContentUrls(html, baseUrl, options)
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, p1) => `\n\n\`\`\`\n${stripTags(p1)}\n\`\`\`\n\n`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, p1) => `\`${stripTags(p1)}\``)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, p1) => `\n\n${"#".repeat(Number(level))} ${stripTags(p1)}\n\n`)
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, p1) => renderBlockquote(p1))
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_m, p1) => `\n\n${stripTags(p1)}\n\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, p1) => `\n- ${stripTags(p1)}`)
    .replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_m, p1) => `\n| ${stripTags(p1)} |`)
    .replace(/<hr\b[^>]*>/gi, "\n\n---\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(address|article|aside|details|dialog|div|dl|fieldset|figcaption|figure|footer|form|header|main|nav|ol|section|table|tbody|tfoot|thead|ul)\b[^>]*>/gi, "\n\n")
    .replace(/<\/(dd|dt)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

export const extractStructuredTextFromHtml = (
  html: string,
  baseUrlOrOptions?: string | ExtractionOptions,
  extractionOptions: ExtractionOptions = {}
): string => {
  const { baseUrl, options } = resolveExtractionArguments(baseUrlOrOptions, extractionOptions);
  return normalizeText(
    formatHtmlAsMarkdown(extractMainContentHtml(html), baseUrl, options)
  );
};

export const hasPrimaryContentContainer = (html: string): boolean =>
  /<(main|article)\b/i.test(html) || /\brole\s*=\s*["']main["']/i.test(html);

const LOW_CONFIDENCE_TEXT_LENGTH = 120;
const FALLBACK_TEXT_MIN_LENGTH = 300;

export const extractStructuredTextWithFallback = (input: {
  cleanedHtml: string;
  originalHtml: string;
  baseUrl?: string;
  options?: ExtractionOptions;
}): string => {
  const baseUrl = input.baseUrl ?? DEFAULT_EXTRACTION_BASE_URL;
  const cleanedText = extractStructuredTextFromHtml(input.cleanedHtml, baseUrl, input.options);
  if (!hasPrimaryContentContainer(input.originalHtml)) {
    return cleanedText;
  }
  const originalText = extractStructuredTextFromHtml(input.originalHtml, baseUrl, input.options);
  if (
    cleanedText &&
    (
      cleanedText.length >= LOW_CONFIDENCE_TEXT_LENGTH ||
      originalText.length < FALLBACK_TEXT_MIN_LENGTH ||
      originalText.length <= cleanedText.length * 3
    )
  ) {
    return cleanedText;
  }
  return originalText || cleanedText;
};
