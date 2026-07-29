import type { SkillCatalogService } from "../../skills/public.js";
import type {
  QualityOutcomeCatalogEntry,
  QualityOutcomeCatalogPort,
} from "../domain/qualitySignals.js";

/**
 * Adapts the skill catalog to the narrow outcome view quality signals need.
 *
 * Entries the capability policy marks `forbidden` are kept: they are still listed, and a
 * turn that already ran under a since-revoked capability is still a turn that belongs in
 * the denominator. Filtering them here would make grounded rates jump the moment an
 * operator changes a plan.
 */
export class SkillCatalogOutcomeSource implements QualityOutcomeCatalogPort {
  constructor(private readonly skillCatalog: SkillCatalogService) {}

  async listOutcomeCatalog(workspaceId: string): Promise<readonly QualityOutcomeCatalogEntry[]> {
    const catalog = await this.skillCatalog.list({ workspaceId });
    return catalog.skills.map((skill) => ({
      name: skill.name,
      outcomes: skill.outcomes?.map((outcome) => ({
        name: outcome.name,
        groundedAnswer: outcome.groundedAnswer,
      })),
    }));
  }
}
