/**
 * Extension point that lets out-of-tree packages (notably the EE bundle) plug
 * additional kinds of agent surface settings into the agent record without OSS
 * knowing their schema. A surface is "a way visitors talk to the assistant":
 * authenticated chat and anonymous chat are core; website embed, future
 * messaging channels, etc. are registered here.
 *
 * Phase 1: only the scaffolding. No extensions are registered by OSS itself —
 * registration happens during composition by whichever distribution is built.
 */

export interface AgentSurfaceExtension<TSettings = unknown> {
  /**
   * Unique key under `surface_settings` JSONB on the agents row. Two
   * extensions cannot share a key. Keys are camelCase by convention
   * (e.g. "websiteEmbed").
   */
  readonly key: string;

  /** Settings shape returned when no value has been saved for an agent. */
  defaults(): TSettings;

  /**
   * Validate and normalize external input from API requests. Should throw a
   * `badRequest` (`shared/domain/errors`) on invalid input.
   */
  normalize(input: unknown): TSettings;

  /**
   * Convert a typed settings object into a JSONB-safe representation.
   * The result must be JSON.stringify-able with no class instances.
   */
  serialize(settings: TSettings): unknown;

  /**
   * Parse the stored JSONB representation back into typed settings.
   * Should be tolerant of legacy keys (return defaults() for unknown shapes).
   */
  parse(raw: unknown): TSettings;

}

export class AgentSurfaceExtensionRegistry {
  private readonly extensions = new Map<string, AgentSurfaceExtension>();

  /**
   * Register an extension. Called during composition. Throws if the key has
   * already been registered to surface duplicate plugin configurations early.
   */
  register<TSettings>(extension: AgentSurfaceExtension<TSettings>): void {
    if (this.extensions.has(extension.key)) {
      throw new Error(`Agent surface extension "${extension.key}" is already registered.`);
    }
    this.extensions.set(extension.key, extension);
  }

  get(key: string): AgentSurfaceExtension | undefined {
    return this.extensions.get(key);
  }

  has(key: string): boolean {
    return this.extensions.has(key);
  }

  list(): AgentSurfaceExtension[] {
    return Array.from(this.extensions.values());
  }
}
