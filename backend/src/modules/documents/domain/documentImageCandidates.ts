import type { DocumentImageCandidate, PlacedDocumentImage } from "../contracts/documentImages.js";

/** A document names one picture for itself; a few addresses leave room for one being a site banner. */
const MAX_PRIMARY_IMAGES = 3;
/** More than capture keeps, because capture drops small images only once it has decoded them. */
const MAX_INLINE_IMAGES = 24;
/** The `document_images.source_url` bound. */
const MAX_SOURCE_URL_LENGTH = 2048;
const MAX_ALT_LENGTH = 300;
const MAX_CAPTION_LENGTH = 500;
/** How many letters before an image place it: enough to be unique, few enough to survive a cropped line. */
const ANCHOR_LETTERS = 32;

const CONTROL_CHARACTERS = /\p{Cc}+/gu;

const cleanText = (value: unknown, max: number): string =>
  typeof value === "string"
    ? value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim().slice(0, max).trimEnd()
    : "";

/** An absolute http(s) address within the column's bound that is not an SVG file, or null. */
const acceptedSourceUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > MAX_SOURCE_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.pathname.toLowerCase().endsWith(".svg") ? null : value;
  } catch {
    return null;
  }
};

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** The letters and digits of a text, with the offset just past each: whitespace and markup differences drop out. */
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

/** Punctuation closing the word an image follows stays before the image. */
const pastTrailingPunctuation = (text: string, offset: number): number => {
  let end = offset;
  while (end < text.length && !/\s/u.test(text[end] ?? " ") && !LETTER_OR_DIGIT.test(text[end] ?? " ")) end += 1;
  return end;
};

/**
 * Where an offset into the ingested content falls in the stored text, which ingestion may have
 * normalised or cropped: the letters before it are found in the stored text, at the same count when
 * the two agree, else by their last letters. Null when the passage is not there.
 */
const placeInStoredText = (content: string, offset: number, storedText: string): number | null => {
  if (!Number.isInteger(offset) || offset < 0 || offset > content.length) return null;
  if (content === storedText) return offset;
  const before = projectLetters(content.slice(0, offset)).letters;
  if (before.length === 0) return 0;
  const stored = projectLetters(storedText);
  const tail = before.slice(-ANCHOR_LETTERS);
  const found = stored.letters.slice(before.length - tail.length, before.length) === tail
    ? before.length - tail.length
    : stored.letters.indexOf(tail);
  const end = found < 0 ? undefined : stored.ends[found + tail.length - 1];
  return end === undefined ? null : pastTrailingPunctuation(storedText, end);
};

/**
 * The images a document keeps from what its source named: valid addresses only, each once,
 * metadata images first, both kinds capped, alt text and captions cleaned, and each inline image's
 * offset moved from the ingested content into the stored text the chunks are cut from.
 */
export const placeDocumentImages = (input: {
  candidates: readonly DocumentImageCandidate[];
  content: string;
  storedText: string;
}): PlacedDocumentImage[] => {
  const seen = new Set<string>();
  // Sources are typed, but a crawler provider's pages arrive as data: an entry that is not an object is dropped.
  const accepted = input.candidates.flatMap((candidate: DocumentImageCandidate | null | undefined) => {
    if (!candidate || typeof candidate !== "object") return [];
    const sourceUrl = acceptedSourceUrl(candidate.sourceUrl);
    if (!sourceUrl || seen.has(sourceUrl) || (candidate.role !== "primary" && candidate.role !== "inline")) return [];
    seen.add(sourceUrl);
    return [{ ...candidate, sourceUrl }];
  });
  const primary = accepted.filter((candidate) => candidate.role === "primary").slice(0, MAX_PRIMARY_IMAGES);
  const inline = accepted.filter((candidate) => candidate.role === "inline").slice(0, MAX_INLINE_IMAGES);
  return [...primary, ...inline].map((candidate, position) => {
    const caption = cleanText(candidate.caption, MAX_CAPTION_LENGTH);
    return {
      sourceUrl: candidate.sourceUrl,
      role: candidate.role,
      alt: cleanText(candidate.alt, MAX_ALT_LENGTH),
      caption: caption || null,
      position,
      textOffset: candidate.role === "inline" && typeof candidate.textOffset === "number"
        ? placeInStoredText(input.content, candidate.textOffset, input.storedText)
        : null,
    };
  });
};
