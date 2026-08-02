import type { QualityContentPlanningWindow } from "./contracts/contentPlanningEvidence.js";
import {
  TURN_POPULATION_SOURCE,
  bindParam,
  buildTurnPopulationFilters,
} from "./turnPopulationSql.js";

/**
 * The explicit SQL seam for Content Planning consumers of Quality's canonical
 * assistant-turn population. Keeping the source and predicates here prevents
 * snapshot and member-page reads from quietly inventing a second population.
 */
export const buildQualityContentPlanningPopulationSql = (
  input: {
    workspaceId: string;
    window?: QualityContentPlanningWindow;
  },
  params: unknown[],
): { source: string; filters: string[] } => {
  const filters = buildTurnPopulationFilters({ workspaceId: input.workspaceId }, params);
  if (input.window) {
    filters.push(`m.created_at >= ${bindParam(params, input.window.from)}::timestamptz`);
    filters.push(`m.created_at < ${bindParam(params, input.window.to)}::timestamptz`);
  }
  return { source: TURN_POPULATION_SOURCE, filters };
};
