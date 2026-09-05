export interface StoredDocumentObject {
  bucket: string;
  objectPath: string;
  generation?: string | null;
  sizeBytes: number;
}

export interface DocumentStorageUploadInput {
  workspaceId: string;
  documentId: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

export interface DocumentStorageReadInput {
  bucket: string;
  objectPath: string;
  generation?: string | null;
}

export type DocumentStorageDeleteInput = DocumentStorageReadInput;

export interface DocumentStoragePort {
  upload(input: DocumentStorageUploadInput): Promise<StoredDocumentObject>;
  read(input: DocumentStorageReadInput): Promise<Buffer>;
  delete(input: DocumentStorageDeleteInput): Promise<void>;
}
