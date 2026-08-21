// Type declarations for the JS guard script so it can be imported from typed tests.
export const ALLOWLIST: Map<string, string>;
export function lineReadsLegacyChunkVector(line: string): boolean;
export function findLegacyChunkVectorReaders(srcDir: string): string[];
