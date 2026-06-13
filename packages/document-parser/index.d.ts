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
