import type { CheerioAPI } from "cheerio";

import { extractStructuredTextFromHtml, normalizeText, type ExtractionOptions } from "./htmlProcessing.js";

/**
 * Where an image sits in its page: `primary` is the picture the page's metadata names for itself
 * (`og:image`, `twitter:image`, a JSON-LD `image`); `inline` appears inside the main content.
 */
export type PageImageRole = "primary" | "inline";

/** An image a crawled page names. Only its address: fetching, decoding and storing belong to the caller. */
export interface PageImage {
  /** Absolute http(s) address. */
  url: string;
  role: PageImageRole;
  alt: string;
  caption: string | null;
  /** Inline only: where the image sits, as an offset into the page's extracted text; null when it could not be placed. */
  textOffset: number | null;
}

/** A page names one picture for itself; a few distinct metadata addresses leave room for one being a site banner. */
const MAX_PRIMARY_IMAGES = 3;
/** Generous on purpose: the caller drops small images after decoding and keeps fewer than this. */
const MAX_INLINE_IMAGES = 24;
const MAX_URL_LENGTH = 2048;
const MAX_ALT_LENGTH = 300;
const MAX_CAPTION_LENGTH = 500;
/** The width a srcset candidate should reach: the widest stored copy of an image. */
const PREFERRED_SOURCE_WIDTH = 640;
/** How many letters before an image place it in the text: enough to be unique, short enough to sit after one link. */
const ANCHOR_LETTERS = 32;
/** Images looked at per page; the marker alphabet holds far more, a page's content far fewer. */
const MAX_MARKED_IMAGES = 200;

const SOCIAL_IMAGE_SELECTOR = [
  "meta[property='og:image']",
  "meta[property='og:image:url']",
  "meta[property='og:image:secure_url']",
  "meta[name='twitter:image']",
  "meta[name='twitter:image:src']",
  "meta[property='twitter:image']",
].join(", ");
/** Lazy loaders keep the real address in a data attribute and a placeholder in `src`, so those are read first. */
const IMAGE_SOURCE_ATTRIBUTES = ["data-src", "data-lazy-src", "data-original", "src"] as const;
const IMAGE_SRCSET_ATTRIBUTES = ["srcset", "data-srcset"] as const;
/** schema.org types whose `image` is the site's or a person's, never the page's own picture. */
const SITE_LEVEL_SCHEMA_TYPES = new Set(["Organization", "WebSite", "Person"]);

const truncate = (value: string, max: number): string => (value.length > max ? value.slice(0, max).trimEnd() : value);

/** An absolute http(s) address that is not an SVG file, or null. SVG is markup, never stored. */
const resolveImageUrl = (value: unknown, baseUrl: string): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("data:")) return null;
  try {
    const url = new URL(trimmed, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.pathname.toLowerCase().endsWith(".svg")) return null;
    url.hash = "";
    const resolved = url.toString();
    return resolved.length <= MAX_URL_LENGTH ? resolved : null;
  } catch {
    return null;
  }
};

const primary = (url: string): PageImage => ({ url, role: "primary", alt: "", caption: null, textOffset: null });

type JsonLdNode = Record<string, unknown>;

const isNode = (value: unknown): value is JsonLdNode => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const schemaTypes = (node: JsonLdNode): string[] => {
  const type = node["@type"];
  return (Array.isArray(type) ? type : [type]).filter((entry): entry is string => typeof entry === "string");
};

/** An `image` value is a URL, an ImageObject, a reference to one in the same graph, or a list of those. */
const jsonLdImageUrl = (value: unknown, byId: ReadonlyMap<string, JsonLdNode>, depth = 0): unknown => {
  if (depth > 3) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return jsonLdImageUrl(value[0], byId, depth + 1);
  if (!isNode(value)) return null;
  const referenced = typeof value["@id"] === "string" && !value.url && !value.contentUrl ? byId.get(value["@id"]) : undefined;
  const node = referenced ?? value;
  return node.contentUrl ?? node.url ?? null;
};

/**
 * A JSON-LD block's picture of the page: the top-level entity's `image`, or in a graph the
 * `primaryImageOfPage` of any node, else the first `image` that is not the site's or a person's.
 */
const jsonLdBlockImage = (block: unknown): unknown => {
  const entities = Array.isArray(block) ? block.filter(isNode) : isNode(block) ? [block] : [];
  for (const entity of entities) {
    const graph = Array.isArray(entity["@graph"]) ? entity["@graph"].filter(isNode) : [];
    const nodes = graph.length > 0 ? graph : [entity];
    const byId = new Map(nodes.flatMap((node) => (typeof node["@id"] === "string" ? [[node["@id"], node] as const] : [])));
    const pageImage = nodes.find((node) => node.primaryImageOfPage)?.primaryImageOfPage;
    const entityImage = nodes.find((node) =>
      node.image !== undefined && !schemaTypes(node).some((type) => SITE_LEVEL_SCHEMA_TYPES.has(type)))?.image;
    const image = jsonLdImageUrl(pageImage ?? entityImage, byId);
    if (image) return image;
  }
  return null;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

/**
 * The pictures a page's metadata names for itself, in this order: Open Graph, Twitter, JSON-LD.
 * Read from the unmodified document: page-chrome removal drops the scripts JSON-LD lives in.
 */
export const extractMetadataImages = ($: CheerioAPI, baseUrl: string): PageImage[] => {
  const social = $(SOCIAL_IMAGE_SELECTOR).toArray().map((element) => $(element).attr("content"));
  const jsonLd = $("script[type='application/ld+json']").toArray()
    .map((element) => jsonLdBlockImage(parseJson($(element).text())));
  return [...social, ...jsonLd]
    .map((value) => resolveImageUrl(value, baseUrl))
    .filter((url): url is string => url !== null)
    .map(primary);
};

interface SrcsetCandidate {
  url: string;
  width: number | null;
  density: number;
}

const parseSrcset = (srcset: string): SrcsetCandidate[] =>
  srcset.split(/,\s+/).flatMap((entry) => {
    const [url, descriptor = "1x"] = entry.trim().split(/\s+/);
    if (!url) return [];
    const width = /^(\d+)w$/.exec(descriptor);
    const density = /^(\d+(?:\.\d+)?)x$/.exec(descriptor);
    return [{ url, width: width ? Number(width[1]) : null, density: density ? Number(density[1]) : 1 }];
  });

/** The smallest source at least as wide as the widest stored copy, else the widest there is. */
const pickSrcsetSource = (srcset: string): string | null => {
  const candidates = parseSrcset(srcset);
  const widths = candidates.filter((candidate): candidate is SrcsetCandidate & { width: number } => candidate.width !== null);
  if (widths.length > 0) {
    const sorted = [...widths].sort((left, right) => left.width - right.width);
    return (sorted.find((candidate) => candidate.width >= PREFERRED_SOURCE_WIDTH) ?? sorted.at(-1))?.url ?? null;
  }
  return [...candidates].sort((left, right) => right.density - left.density)[0]?.url ?? null;
};

const imageElementUrl = (attr: (name: string) => string | undefined, baseUrl: string): string | null => {
  for (const name of IMAGE_SRCSET_ATTRIBUTES) {
    const srcset = attr(name);
    const resolved = srcset ? resolveImageUrl(pickSrcsetSource(srcset), baseUrl) : null;
    if (resolved) return resolved;
  }
  for (const name of IMAGE_SOURCE_ATTRIBUTES) {
    const resolved = resolveImageUrl(attr(name), baseUrl);
    if (resolved) return resolved;
  }
  return null;
};

// An image is replaced by a marker no page text contains: private-use code points, none of them a
// letter or a digit, so the marker never shifts the letters the text is matched by.
const MARKER_EDGE = "";
const MARKER_INDEX_BASE = 0xe000;
const MARKER_PATTERN = /([-])/gu;
const marker = (index: number): string => `${MARKER_EDGE}${String.fromCharCode(MARKER_INDEX_BASE + index)}`;

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** The letters and digits of a text, with the offset just past each one: whitespace and markup differences drop out. */
const projectLetters = (text: string): { letters: string; ends: number[] } => {
  let letters = "";
  const ends: number[] = [];
  for (let index = 0; index < text.length;) {
    const character = String.fromCodePoint(text.codePointAt(index) ?? 0);
    index += character.length;
    if (LETTER_OR_DIGIT.test(character)) {
      letters += character;
      for (let unit = 0; unit < character.length; unit += 1) ends.push(index);
    }
  }
  return { letters, ends };
};

/** Punctuation closing the word an image follows (a full stop, a closing bracket) stays before the image. */
const pastTrailingPunctuation = (text: string, offset: number): number => {
  let end = offset;
  while (end < text.length && !/\s/u.test(text[end] ?? " ") && !LETTER_OR_DIGIT.test(text[end] ?? " ")) end += 1;
  return end;
};

/**
 * Places each marker of the marked text in the page text: the letters before a marker are matched
 * in the page text, at the same count when the two agree, else by their last letters, searching
 * forward from the previous image so images keep their order.
 */
const placeMarkers = (markedText: string, pageText: string): Map<number, number | null> => {
  const page = projectLetters(pageText);
  const placed = new Map<number, number | null>();
  let cursor = 0;
  let lettersBefore = "";
  let consumed = 0;
  for (const match of markedText.matchAll(MARKER_PATTERN)) {
    lettersBefore += projectLetters(markedText.slice(consumed, match.index)).letters;
    consumed = match.index + match[0].length;
    const index = (match[1]?.charCodeAt(0) ?? MARKER_INDEX_BASE) - MARKER_INDEX_BASE;
    if (lettersBefore.length === 0) {
      placed.set(index, 0);
      continue;
    }
    const tail = lettersBefore.slice(-ANCHOR_LETTERS);
    const sameCount = lettersBefore.length;
    const found = page.letters.slice(sameCount - tail.length, sameCount) === tail
      ? sameCount - tail.length
      : page.letters.indexOf(tail, cursor);
    if (found < 0) {
      placed.set(index, null);
      continue;
    }
    cursor = found;
    const end = page.ends[found + tail.length - 1];
    placed.set(index, end === undefined ? null : pastTrailingPunctuation(pageText, end));
  }
  return placed;
};

/**
 * The images inside the main content, in document order, with their alt text, their figure's
 * caption and their place in `text`. Each `<img>` is swapped for a marker and the text extracted
 * again by the same rules, so an image counts as main content exactly when the text extraction
 * keeps the spot it stood in. Mutates `$`: call it last.
 */
export const extractInlineImages = (
  $: CheerioAPI,
  input: { baseUrl: string; text: string; options?: ExtractionOptions },
): PageImage[] => {
  const found: Array<Omit<PageImage, "textOffset">> = [];
  $("img").each((_index, element) => {
    const image = $(element);
    const url = found.length < MAX_MARKED_IMAGES ? imageElementUrl((name) => image.attr(name), input.baseUrl) : null;
    if (!url) {
      image.remove();
      return;
    }
    const caption = normalizeText(image.closest("figure").find("figcaption").first().text());
    found.push({
      url,
      role: "inline",
      alt: truncate(normalizeText(image.attr("alt") ?? ""), MAX_ALT_LENGTH),
      caption: caption ? truncate(caption, MAX_CAPTION_LENGTH) : null,
    });
    image.replaceWith(marker(found.length - 1));
  });
  if (found.length === 0) return [];
  const markedText = extractStructuredTextFromHtml($.html(), input.baseUrl, input.options);
  const placed = placeMarkers(markedText, input.text);
  return [...placed.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([index, textOffset]) => {
      const image = found[index];
      return image ? [{ ...image, textOffset }] : [];
    });
};

/** Metadata images first, then inline ones, each address once and each role capped. */
export const mergePageImages = (metadata: readonly PageImage[], inline: readonly PageImage[]): PageImage[] => {
  const seen = new Set<string>();
  const firstOfEach = (images: readonly PageImage[], max: number): PageImage[] =>
    images.filter((image) => !seen.has(image.url) && seen.add(image.url)).slice(0, max);
  return [...firstOfEach(metadata, MAX_PRIMARY_IMAGES), ...firstOfEach(inline, MAX_INLINE_IMAGES)];
};
