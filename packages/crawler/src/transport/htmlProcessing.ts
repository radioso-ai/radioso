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

export const extractMainContentHtml = (html: string): string => {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  const main = cleaned.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (main) return main;

  const article = cleaned.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
  if (article) return article;

  return cleaned.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? cleaned;
};

export const stripTags = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const renderBlockquote = (html: string): string => {
  const text = stripTags(html);
  if (!text) return "";
  return `\n\n${text
    .split(/\n+/)
    .map((line) => `> ${line.trim()}`)
    .join("\n")}\n\n`;
};

export const formatHtmlAsMarkdown = (html: string): string =>
  html
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

export const extractStructuredTextFromHtml = (html: string): string =>
  normalizeText(
    formatHtmlAsMarkdown(extractMainContentHtml(html))
  );

export const hasPrimaryContentContainer = (html: string): boolean =>
  /<(main|article)\b/i.test(html) || /\brole\s*=\s*["']main["']/i.test(html);

const LOW_CONFIDENCE_TEXT_LENGTH = 120;
const FALLBACK_TEXT_MIN_LENGTH = 300;

export const extractStructuredTextWithFallback = (input: {
  cleanedHtml: string;
  originalHtml: string;
}): string => {
  const cleanedText = extractStructuredTextFromHtml(input.cleanedHtml);
  if (!hasPrimaryContentContainer(input.originalHtml)) {
    return cleanedText;
  }
  const originalText = extractStructuredTextFromHtml(input.originalHtml);
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
