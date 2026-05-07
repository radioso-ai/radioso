import type { SkillCatalogEntryDefinition } from "./domain.js";

export class SkillCatalogRegistry {
  private readonly entries = new Map<string, SkillCatalogEntryDefinition>();

  constructor(entries: SkillCatalogEntryDefinition[] = []) {
    for (const entry of entries) {
      this.register(entry);
    }
  }

  register(entry: SkillCatalogEntryDefinition): void {
    if (this.entries.has(entry.name)) {
      throw new Error(`Skill "${entry.name}" is already registered`);
    }
    this.entries.set(entry.name, entry);
  }

  list(): SkillCatalogEntryDefinition[] {
    return [...this.entries.values()];
  }

  get(name: string): SkillCatalogEntryDefinition | null {
    return this.entries.get(name) ?? null;
  }
}
