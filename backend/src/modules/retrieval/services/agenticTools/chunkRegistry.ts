import type { RetrievedChunk } from "../../domain/vectorSearch.js";

const DEFAULT_SNIPPET_CHARS = 240;

export interface RegisteredChunk {
  readonly chunkId: string;
  readonly documentId: string;
  readonly title: string;
  readonly snippet: string;
  readonly fullContent: string;
  readonly similarity: number;
  readonly metadata?: Record<string, unknown>;
  readonly chunkIndex?: number;
  readonly searchText?: string | null;
}

export interface ChunkRegistry {
  record(chunks: ReadonlyArray<RegisteredChunk>): void;
  resolve(chunkIds: ReadonlyArray<string>): RegisteredChunk[];
  has(chunkId: string): boolean;
}

export const buildSnippet = (chunk: { content: string; searchText?: string | null }, maxChars = DEFAULT_SNIPPET_CHARS): string => {
  const source = (chunk.searchText && chunk.searchText.trim().length > 0 ? chunk.searchText : chunk.content) ?? "";
  const normalized = source.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars).trimEnd()}…`;
};

export const fromRetrievedChunk = (chunk: RetrievedChunk, snippetChars?: number): RegisteredChunk => ({
  chunkId: chunk.chunkId,
  documentId: chunk.documentId,
  title: chunk.title,
  snippet: buildSnippet(chunk, snippetChars),
  fullContent: chunk.content,
  similarity: chunk.similarity,
  metadata: chunk.metadata,
  chunkIndex: chunk.chunkIndex,
  searchText: chunk.searchText,
});

export class InMemoryChunkRegistry implements ChunkRegistry {
  private readonly chunks = new Map<string, RegisteredChunk>();

  record(chunks: ReadonlyArray<RegisteredChunk>): void {
    for (const chunk of chunks) {
      this.chunks.set(chunk.chunkId, chunk);
    }
  }

  resolve(chunkIds: ReadonlyArray<string>): RegisteredChunk[] {
    const resolved: RegisteredChunk[] = [];
    for (const chunkId of chunkIds) {
      const chunk = this.chunks.get(chunkId);
      if (chunk) {
        resolved.push(chunk);
      }
    }
    return resolved;
  }

  has(chunkId: string): boolean {
    return this.chunks.has(chunkId);
  }
}
