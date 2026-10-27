export type CruiseResult = {
  modules: Array<{ source: string; dependencies: Array<{ resolved: string }> }>;
};

export type ModuleEdge = { from: string; to: string };

export type CyclicModuleEdge = { key: string; closedBy: string[] };

export type RatchetedViolations = Record<string, string[]>;

export type ArchitectureBaseline = {
  moduleCycleEdges: string[];
  violations: RatchetedViolations;
};

export type RatchetEntry = { kind: string; key: string; closedBy?: string[] };

export type DirectionRule = { name: string; from: RegExp; to: RegExp; remedy: string };

export const DIRECTION_RULES: readonly DirectionRule[];

export function moduleEdgesFrom(cruiseResult: CruiseResult): ModuleEdge[];

export function findCyclicModuleEdges(edges: readonly ModuleEdge[]): CyclicModuleEdge[];

export function directionViolationsFrom(cruiseResult: CruiseResult): RatchetedViolations;

export function evaluateArchitectureRatchet(input: {
  cyclicEdges: readonly CyclicModuleEdge[];
  violations: RatchetedViolations;
  baseline: ArchitectureBaseline;
}): { added: RatchetEntry[]; stale: RatchetEntry[] };

export function updateArchitectureBaseline(input: {
  cyclicEdges: readonly CyclicModuleEdge[];
  violations: RatchetedViolations;
  baseline: ArchitectureBaseline;
  allowGrowth: boolean;
}): { baseline: ArchitectureBaseline; refused: RatchetEntry[] };
