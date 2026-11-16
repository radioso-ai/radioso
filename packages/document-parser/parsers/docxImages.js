import { createHash } from "node:crypto";

import { loadDependency } from "./loadDependency.js";
import { enforceOfficeZipLimits } from "./officeZipLimits.js";

const mammoth = loadDependency("mammoth");

/**
 * Word's built-in caption style. Its id is `Caption` in an English document; a localized Word may
 * give it another id, but the style's own name stays the built-in `caption`.
 */
const CAPTION_STYLE_ID = "Caption";
const CAPTION_STYLE_NAME = "caption";

const isCaptionParagraph = (paragraph) =>
  paragraph.styleId === CAPTION_STYLE_ID || paragraph.styleName?.toLowerCase() === CAPTION_STYLE_NAME;

/** HTML conversion is a side effect of reading the document tree: it never reads an image's bytes. */
const skipImageBytes = mammoth.images.imgElement(async () => ({ src: "" }));

/**
 * Walks the document tree mammoth reads, building the same raw text `extractRawText` returns
 * (each paragraph's text followed by a blank line, a tab as a tab) and noting, in document order,
 * every image with the offset where it sits in that text and the paragraph it sits in.
 */
const readDocumentTree = (document) => {
  let text = "";
  const paragraphs = [];
  const images = [];
  const visit = (element, paragraph) => {
    if (element.type === "text") {
      text += element.value;
      return;
    }
    if (element.type === "tab") {
      text += "\t";
      return;
    }
    if (element.type === "image") {
      images.push({ element, offset: text.length, paragraph });
    }
    const own = element.type === "paragraph"
      ? { start: text.length, end: text.length, caption: isCaptionParagraph(element), index: paragraphs.length }
      : paragraph;
    if (own !== paragraph) paragraphs.push(own);
    for (const child of element.children ?? []) visit(child, own);
    if (own !== paragraph) {
      own.end = text.length;
      text += "\n\n";
    }
  };
  visit(document, null);
  return { text, paragraphs, images };
};

/**
 * An image's caption is the paragraph next to the image's own when that paragraph has Word's
 * caption style: the one after it (where Word inserts a figure's caption), else the one before it
 * when no earlier image took it.
 */
const captionFor = (image, paragraphs, text, claimed) => {
  if (!image.paragraph) return null;
  const candidates = [paragraphs[image.paragraph.index + 1], paragraphs[image.paragraph.index - 1]];
  for (const candidate of candidates) {
    if (!candidate?.caption || claimed.has(candidate.index)) continue;
    const caption = text.slice(candidate.start, candidate.end).trim();
    if (!caption) continue;
    claimed.add(candidate.index);
    return caption;
  }
  return null;
};

/**
 * The images a DOCX embeds in its body (`word/media`, through each drawing's relationship), in
 * document order, each once: its bytes as the file holds them, its alt text (`wp:docPr` `descr`,
 * else `title`), its caption, and the raw-text offset where it sits. The archive passes the same
 * limits as text extraction before anything is read. An image whose bytes cannot be read is left
 * out.
 */
export const extractDocxImages = async ({ buffer, limits }) => {
  enforceOfficeZipLimits(buffer);

  let tree = null;
  await mammoth.convertToHtml({ buffer }, {
    convertImage: skipImageBytes,
    transformDocument: (document) => {
      tree = readDocumentTree(document);
      return document;
    },
  });
  if (!tree) return { text: "", images: [], truncated: false };

  const images = [];
  const seen = new Set();
  const claimed = new Set();
  let totalBytes = 0;
  let truncated = false;
  for (const image of tree.images) {
    if (images.length >= limits.maxImages) {
      truncated = true;
      break;
    }
    let bytes;
    try {
      bytes = Buffer.from(await image.element.readAsBuffer());
    } catch {
      continue;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (seen.has(digest)) continue;
    seen.add(digest);
    if (totalBytes + bytes.length > limits.maxTotalBytes) {
      truncated = true;
      break;
    }
    totalBytes += bytes.length;
    images.push({
      kind: "embedded",
      bytes,
      alt: image.element.altText ?? "",
      caption: captionFor(image, tree.paragraphs, tree.text, claimed),
      offset: image.offset,
    });
  }
  return { text: tree.text, images, truncated };
};
