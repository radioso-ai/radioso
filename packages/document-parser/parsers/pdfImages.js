import { createHash } from "node:crypto";

import { loadDependency } from "./loadDependency.js";
import { encodePng } from "./pngEncode.js";

/** The pdf.js build `pdf-parse` reads text with: the same parser, so page text joins the same way. */
const pdfjs = loadDependency("pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js");

/**
 * An image declaring more pixels than this is dropped by pdf.js before it is decoded, so a
 * decompression bomb never allocates. A 300 dpi scan of a full page fits.
 */
const MAX_IMAGE_PIXELS = 12_000_000;
/** An image covering this share of its page is the page itself: a scan, under the text layer OCR added. */
const PAGE_COVERING_SHARE = 0.9;
/** An image painted on this many pages is the document's letterhead or logo, not a picture of its content. */
const REPEATED_ON_PAGES = 3;
/** pdf.js `ImageKind`: how a decoded image's pixels are laid out. */
const PIXEL_LAYOUTS = { 1: "gray1", 2: "rgb8", 3: "rgba8" };
/** Text rendering mode 3 draws nothing: the invisible text OCR lays over a scanned page. */
const INVISIBLE_TEXT = 3;

// pdf.js reads its settings from one process-wide object, which `pdf-parse` shares. No worker
// thread: pdf.js runs in this process, as it does for `pdf-parse`. Nothing is rendered, so no font
// is attached and no font program is compiled into a function.
const settings = pdfjs.PDFJS;
settings.disableWorker = true;
settings.disableFontFace = true;
settings.isEvalSupported = false;
settings.maxImageSize = MAX_IMAGE_PIXELS;
settings.verbosity = settings.VERBOSITY_LEVELS.errors;

class BudgetSpent extends Error {}

/** Settles with `promise`, or rejects with `BudgetSpent` once the deadline passes. */
const beforeDeadline = (promise, deadline, now) => {
  const remaining = deadline - now();
  if (remaining <= 0) return Promise.reject(new BudgetSpent());
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new BudgetSpent()), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
};

/** A page's text as `pdf-parse` renders it: items on one line run together, a new line starts a new row. */
const renderPageText = (textContent) => {
  let lastY;
  let text = "";
  for (const item of textContent.items) {
    if (lastY == item.transform[5] || !lastY) text += item.str;
    else text += `\n${item.str}`;
    lastY = item.transform[5];
  }
  return text;
};

const multiply = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/**
 * The images a page paints, each once, with the share of the page it covers (the unit square under
 * the transform in force), and whether the page draws invisible text. Stencil masks and inline
 * images (tiny by construction) are not images of the page's content and are not listed.
 */
const readPagePaints = (operatorList, pageArea) => {
  const { OPS } = pdfjs;
  const paints = new Map();
  let invisibleText = false;
  let transform = [1, 0, 0, 1, 0, 0];
  const saved = [];
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const args = operatorList.argsArray[index];
    switch (operatorList.fnArray[index]) {
      case OPS.save:
        saved.push(transform);
        break;
      case OPS.restore:
        transform = saved.pop() ?? transform;
        break;
      case OPS.transform:
        transform = multiply(transform, args);
        break;
      case OPS.paintFormXObjectBegin:
        saved.push(transform);
        if (Array.isArray(args?.[0]) && args[0].length === 6) transform = multiply(transform, args[0]);
        break;
      case OPS.paintFormXObjectEnd:
        transform = saved.pop() ?? transform;
        break;
      case OPS.setTextRenderingMode:
        invisibleText ||= args?.[0] === INVISIBLE_TEXT;
        break;
      case OPS.paintImageXObject: {
        const [objId] = args;
        const share = pageArea > 0 ? Math.abs(transform[0] * transform[3] - transform[1] * transform[2]) / pageArea : 0;
        paints.set(objId, Math.max(paints.get(objId) ?? 0, share));
        break;
      }
      default:
        break;
    }
  }
  return { paints, invisibleText };
};

const decodedImage = (page, objId) => new Promise((resolve) => {
  page.objs.get(objId, resolve);
});

/** A failure that is not the budget running out leaves the step's result empty, as `pdf-parse` leaves a page's text. */
const orElse = (fallback) => (error) => {
  if (error instanceof BudgetSpent) throw error;
  return fallback;
};

/**
 * The raster images a PDF's pages paint, read through pdf.js, each decoded to pixels and handed on
 * as a PNG, anchored to the offset where its page's text starts. Bounded: an image above the pixel
 * cap is never decoded, at most `maxImagesExamined` are decoded, at most `maxImages` are kept, and
 * reading stops when the time budget or the byte budget is spent. Images under `minShortSidePx`,
 * stencil masks, an OCR'd page's scan and an image repeated on many pages are left out.
 */
export const extractPdfImages = async ({ buffer, limits }) => {
  const now = limits.now ?? Date.now;
  const deadline = now() + limits.timeBudgetMs;
  // `none`: pdf.js decodes every image itself, JPEG included, rather than handing it to a browser.
  // A copy with its own memory: pdf.js reads past a small Buffer's view into the pool it shares.
  const loading = pdfjs.getDocument({ data: new Uint8Array(buffer), nativeImageDecoderSupport: "none" });
  const document = await beforeDeadline(loading.promise, deadline, now).catch(async (error) => {
    await loading.destroy();
    if (error instanceof BudgetSpent) return null;
    throw error;
  });
  if (!document) return { text: "", images: [], truncated: true };

  let text = "";
  const found = new Map();
  let examined = 0;
  let totalBytes = 0;
  let truncated = false;
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      if (found.size >= limits.maxImages || examined >= limits.maxImagesExamined) {
        truncated = true;
        break;
      }
      text += "\n\n";
      const pageStart = text.length;
      const page = await beforeDeadline(document.getPage(pageNumber), deadline, now).catch(orElse(null));
      if (!page) continue;
      try {
        text += await beforeDeadline(
          page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false }).then(renderPageText),
          deadline,
          now,
        ).catch(orElse(""));
        const operatorList = await beforeDeadline(page.getOperatorList(), deadline, now).catch(orElse(null));
        if (!operatorList) continue;
        const [left, bottom, right, top] = page.view;
        const { paints, invisibleText } = readPagePaints(operatorList, Math.abs((right - left) * (top - bottom)));
        for (const [objId, share] of paints) {
          if (examined >= limits.maxImagesExamined) break;
          examined += 1;
          const image = await beforeDeadline(decodedImage(page, objId), deadline, now);
          if (!image?.data || Math.min(image.width, image.height) < limits.minShortSidePx) continue;
          if (invisibleText && share >= PAGE_COVERING_SHARE) continue;
          const png = await encodePng({ width: image.width, height: image.height, layout: PIXEL_LAYOUTS[image.kind], pixels: image.data });
          if (!png) continue;
          const digest = createHash("sha256").update(png).digest("hex");
          const known = found.get(digest);
          if (known) {
            known.pages += 1;
            continue;
          }
          if (found.size >= limits.maxImages || totalBytes + png.length > limits.maxTotalBytes) {
            truncated = true;
            break;
          }
          totalBytes += png.length;
          found.set(digest, { bytes: png, offset: pageStart, pages: 1 });
        }
      } finally {
        page.cleanup();
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetSpent)) throw error;
    truncated = true;
  } finally {
    await document.destroy();
  }

  const images = [...found.values()]
    .filter((image) => image.pages < REPEATED_ON_PAGES)
    .map((image) => ({ kind: "embedded", bytes: image.bytes, alt: "", caption: null, offset: image.offset }));
  return { text, images, truncated };
};
