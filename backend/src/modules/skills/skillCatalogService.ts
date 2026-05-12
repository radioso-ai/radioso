import type { CapabilityPolicy } from "../../shared/domain/capabilityPolicy.js";
import type { SkillCatalogEntry, SkillCatalogEntryDefinition, SkillCatalogResponse } from "./domain.js";
import type { SkillCatalogRegistry } from "./skillCatalogRegistry.js";

export interface SkillCatalogContext {
  workspaceId: string;
  accountId?: string;
  userId?: string;
}

export class SkillCatalogService {
  private readonly capabilityPolicy: CapabilityPolicy;
  private readonly registry: SkillCatalogRegistry;

  constructor(input: {
    capabilityPolicy: CapabilityPolicy;
    registry: SkillCatalogRegistry;
  }) {
    this.capabilityPolicy = input.capabilityPolicy;
    this.registry = input.registry;
  }

  async list(context: SkillCatalogContext): Promise<SkillCatalogResponse> {
    const skills = await Promise.all(
      this.registry.list().map((entry) => this.toCatalogEntry(entry, context)),
    );
    return { skills };
  }

  async get(name: string, context: SkillCatalogContext): Promise<SkillCatalogEntry | null> {
    const entry = this.registry.get(name);
    if (!entry) {
      return null;
    }
    return this.toCatalogEntry(entry, context);
  }

  private async toCatalogEntry(
    entry: SkillCatalogEntryDefinition,
    context: SkillCatalogContext,
  ): Promise<SkillCatalogEntry> {
    const availability = entry.availability ?? { state: "available" as const };
    if (availability.state !== "available") {
      return { ...this.stripInternalFields(entry), availability };
    }

    if (entry.availabilityCheck !== "capability_policy") {
      return { ...this.stripInternalFields(entry), availability };
    }

    for (const capability of entry.requiredCapabilities) {
      const decision = await this.capabilityPolicy.can({
        capability,
        workspaceId: context.workspaceId,
        accountId: context.accountId,
        subjectId: context.userId,
      });
      if (!decision.allowed) {
        return {
          ...this.stripInternalFields(entry),
          availability: {
            state: "forbidden",
            reason: decision.reason ?? "capability_denied",
          },
        };
      }
    }

    return { ...this.stripInternalFields(entry), availability };
  }

  private stripInternalFields(entry: SkillCatalogEntryDefinition): Omit<SkillCatalogEntryDefinition, "availabilityCheck"> {
    const {
      availabilityCheck: _availabilityCheck,
      generatedContract: _generatedContract,
      ...catalogEntry
    } = entry;
    return {
      ...catalogEntry,
      diagnostics: {
        ...entry.diagnostics,
        strategyAware: entry.diagnostics.strategyAware ?? entry.diagnostics.shapeAware,
      },
      steps: entry.steps?.map((step) => ({
        name: step.name,
        kind: step.kind,
      })),
      shapes: entry.shapes?.map((shape) => ({
        name: shape.name,
        displayName: shape.displayName,
        description: shape.description,
      })),
    };
  }
}
