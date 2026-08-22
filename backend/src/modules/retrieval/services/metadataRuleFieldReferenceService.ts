import { collectMetadataRuleFieldKeys } from "../domain/metadataRuleFieldReferences.js";

/**
 * Narrow consumer-owned port: everything this needs from the skill store is the
 * stored config of every skill in a workspace. It deliberately does not know
 * skill kinds — only retrieve configs carry `metadataRules`, and a config that
 * lacks them contributes nothing.
 */
export interface WorkspaceSkillConfigSource {
  listByWorkspace(workspaceId: string): Promise<readonly { config?: Record<string, unknown> }[]>;
}

/** Which declared field keys any agent's retrieval rules currently depend on. */
export interface MetadataRuleFieldReferencePort {
  listReferencedFieldKeys(workspaceId: string): Promise<string[]>;
}

export class MetadataRuleFieldReferenceService implements MetadataRuleFieldReferencePort {
  constructor(private readonly skills: WorkspaceSkillConfigSource) {}

  async listReferencedFieldKeys(workspaceId: string): Promise<string[]> {
    const skills = await this.skills.listByWorkspace(workspaceId);
    const keys = new Set<string>();
    for (const skill of skills) {
      for (const key of collectMetadataRuleFieldKeys(skill.config)) {
        keys.add(key);
      }
    }
    return [...keys].sort((left, right) => left.localeCompare(right));
  }
}
