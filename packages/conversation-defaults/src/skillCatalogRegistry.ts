import type { NamedSkillCatalogEntry } from "./skillTypes.js";

export class SkillCatalogRegistry<Entry extends NamedSkillCatalogEntry = NamedSkillCatalogEntry> {
  private readonly entries = new Map<string, Entry>();

  constructor(entries: Entry[] = []) {
    for (const entry of entries) {
      this.register(entry);
    }
  }

  register(entry: Entry): void {
    if (this.entries.has(entry.name)) {
      throw new Error(`Skill "${entry.name}" is already registered`);
    }
    this.entries.set(entry.name, entry);
  }

  list(): Entry[] {
    return [...this.entries.values()];
  }

  get(name: string): Entry | null {
    return this.entries.get(name) ?? null;
  }
}
