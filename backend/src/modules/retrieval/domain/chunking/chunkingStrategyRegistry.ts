import type { ChunkingStrategyId, ChunkingStrategy } from "./chunkingStrategy.js";

export class ChunkingStrategyRegistry {
  private readonly strategiesById: Map<ChunkingStrategyId, ChunkingStrategy>;

  constructor(strategies: ChunkingStrategy[]) {
    this.strategiesById = new Map(strategies.map((strategy) => [strategy.id, strategy]));
  }

  get(strategyId: ChunkingStrategyId): ChunkingStrategy {
    const strategy = this.strategiesById.get(strategyId);

    if (!strategy) {
      throw new Error(`Unsupported chunking strategy: ${strategyId}`);
    }

    return strategy;
  }
}
