import type { EvidenceItemImages } from "../../../retrieval/public.js";

/** At most this many images are offered to the model on one turn. */
const LEDGER_MAX_HANDLES = 24;

/** The longest alt text or caption a prompt line quotes, in characters. */
const QUOTED_TEXT_MAX_LENGTH = 120;

/** One image offered this turn, under the short handle the prompt shows it by. */
export interface LedgerEntry {
  handle: string;
  imageId: string;
  role: "primary" | "inline";
  alt: string;
  caption: string | null;
  width: number;
  height: number;
  /** The `Result N` the image belongs to. */
  resultNumber: number;
  documentId: string;
  documentTitle: string;
  /** The document's http(s) address, when it has one. */
  sourceUrl?: string;
}

/**
 * Alt text and captions are document content, so the model reads them as data: control
 * characters become spaces, quotes are escaped, and the text is cut short, so a caption can
 * never leave its quoted line.
 */
const quotedText = (value: string): string => {
  const singleLine = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const capped = Array.from(singleLine).slice(0, QUOTED_TEXT_MAX_LENGTH).join("").trim();
  return capped.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
};

/**
 * A primary image is named "main picture", the term `answer-present-head.md` defines, so the model
 * can tell a Result's own picture, such as a product's cover, from one inside its page.
 */
const describeEntry = (entry: LedgerEntry): string => {
  const label = entry.role === "primary" ? `[${entry.handle}] main picture` : `[${entry.handle}]`;
  const text = quotedText(entry.caption?.trim() || entry.alt);
  return text ? `${label} "${text}"` : label;
};

/**
 * The images a turn's evidence carries, each under a handle (`m1`, `m2`, …) the answer prompt
 * shows and the model picks by. Handles follow the evidence order; an image whose bytes already
 * have a handle this turn gets none. The ledger lives for one turn and is never stored: only the
 * blocks built from it are.
 */
export class TurnImageLedger {
  private readonly byHandle: ReadonlyMap<string, LedgerEntry>;

  private constructor(private readonly entries: readonly LedgerEntry[]) {
    this.byHandle = new Map(entries.map((entry) => [entry.handle, entry]));
  }

  static fromEvidence(items: readonly EvidenceItemImages[]): TurnImageLedger {
    const seenBytes = new Set<string>();
    const entries: LedgerEntry[] = [];
    for (const item of items) {
      for (const image of item.images) {
        if (entries.length >= LEDGER_MAX_HANDLES || seenBytes.has(image.sha256)) {
          continue;
        }
        seenBytes.add(image.sha256);
        entries.push({
          handle: `m${entries.length + 1}`,
          imageId: image.imageId,
          role: image.role,
          alt: image.alt,
          caption: image.caption,
          width: image.width,
          height: image.height,
          resultNumber: item.resultNumber,
          documentId: item.documentId,
          documentTitle: item.documentTitle,
          ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
        });
      }
    }
    return new TurnImageLedger(entries);
  }

  get size(): number {
    return this.entries.length;
  }

  entry(handle: string): LedgerEntry | undefined {
    return this.byHandle.get(handle);
  }

  /** One line per Result that carries images: `Result 3: [m7] main picture · [m8] "Gentians…"`. */
  promptLines(): string[] {
    const byResult = new Map<number, LedgerEntry[]>();
    for (const entry of this.entries) {
      byResult.set(entry.resultNumber, [...(byResult.get(entry.resultNumber) ?? []), entry]);
    }
    return [...byResult.entries()].map(([resultNumber, entries]) =>
      `Result ${resultNumber}: ${entries.map(describeEntry).join(" · ")}`);
  }
}
