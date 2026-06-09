import type { Directive, DirectiveCatalogRegistryPort } from "@radioso/conversation-contract";

/** Holds the registered Directive definitions. Mirrors SkillCatalogRegistry. */
export class DirectiveCatalogRegistry implements DirectiveCatalogRegistryPort {
  private readonly directives = new Map<string, Directive>();

  constructor(directives: Directive[] = []) {
    for (const directive of directives) {
      this.register(directive);
    }
  }

  register(directive: Directive): void {
    if (this.directives.has(directive.name)) {
      throw new Error(`Directive "${directive.name}" is already registered`);
    }
    this.directives.set(directive.name, directive);
  }

  list(): Directive[] {
    return [...this.directives.values()];
  }

  get(name: string): Directive | null {
    return this.directives.get(name) ?? null;
  }
}
