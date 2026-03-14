export const chunkingStrategyIds = ["fixed_window", "structured_semantic"] as const;

export type ChunkingStrategyId = (typeof chunkingStrategyIds)[number];

export interface ChunkOutput {
  chunkIndex: number;
  content: string;
  startOffset: number;
  endOffset: number;
}

export interface ChunkingRequest {
  title: string;
  content: string;
}

export interface ChunkingStrategy {
  readonly id: ChunkingStrategyId;
  chunk(request: ChunkingRequest): Promise<ChunkOutput[]>;
}

export const normalizeMarkdown = (content: string): string => content.trim();
