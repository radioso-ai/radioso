export type SupportedDocumentType = "pdf" | "txt" | "md" | "docx" | "xlsx";

export interface DetectDocumentTypeInput {
  filename?: string | null;
  mimeType?: string | null;
}

export interface ParseDocumentInput extends DetectDocumentTypeInput {
  buffer: Buffer;
}

export interface ParsedDocument {
  fileType: SupportedDocumentType;
  text: string;
  markdown: string;
  sourceHints: Record<string, unknown>;
}

export class DocumentParserError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export declare const SUPPORTED_DOCUMENT_TYPES: SupportedDocumentType[];

export declare function detectDocumentType(input: DetectDocumentTypeInput): SupportedDocumentType;

export declare function parseDocument(input: ParseDocumentInput): Promise<ParsedDocument>;

/** How far reading a file's pictures goes. */
export interface DocumentImageExtractionLimits {
  /** Pictures returned, the first in document order. */
  maxImages: number;
  /** PDF: a decoded image narrower or shorter than this is left out. */
  minShortSidePx: number;
  /** PDF: images decoded, kept or not, before reading stops. */
  maxImagesExamined: number;
  /** Embedded bytes held at once, before reading stops. */
  maxTotalBytes: number;
  /** PDF: reading stops once this much time has passed. */
  timeBudgetMs: number;
  /** The clock the time budget is read from. */
  now?: () => number;
}

interface ExtractedImagePlacement {
  alt: string;
  caption: string | null;
  /** Where the picture sits, as an offset into the extraction's `text`. */
  textOffset: number;
}

/** A picture the file holds: a DOCX's image file as it is, a PDF's image decoded and wrapped as a PNG. */
export interface EmbeddedDocumentImage extends ExtractedImagePlacement {
  kind: "embedded";
  bytes: Buffer;
}

/** A picture the file names by an absolute http(s) address. */
export interface LinkedDocumentImage extends ExtractedImagePlacement {
  kind: "linked";
  url: string;
}

export type ExtractedDocumentImage = EmbeddedDocumentImage | LinkedDocumentImage;

export interface ExtractedDocumentImages {
  fileType: SupportedDocumentType;
  /** The text the offsets index: what `parseDocument` returns for the file, or its start when `truncated`. */
  text: string;
  images: ExtractedDocumentImage[];
  /** A limit stopped the reading before the end of the file. */
  truncated: boolean;
}

export interface ExtractDocumentImagesInput extends ParseDocumentInput {
  limits?: Partial<DocumentImageExtractionLimits>;
}

export declare function extractDocumentImages(input: ExtractDocumentImagesInput): Promise<ExtractedDocumentImages>;
