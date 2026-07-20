import {
  commitDirectiveFirings,
  emptyDirectiveFiringState,
  type DirectiveFiringState,
  type DirectiveStateStore,
} from "../../../directives/public.js";

/**
 * Turn-scoped capture-and-commit for the per-conversation directive firing
 * memory. Mirrors {@link DeferredRoutineStore}: the matcher closure reads the
 * conversation's firing state (to suppress once/cooldown re-fires) through
 * {@link load}, and records which directives fired this turn through
 * {@link capture}. The host flushes the advanced state once, at turn completion,
 * via {@link commit} — so a turn that never reaches completion leaves the memory
 * untouched and the directive is free to fire again on the retried turn.
 *
 * Constructed fresh per turn and bound to one conversation. `load` reads the
 * durable state once and caches it, so the closure may run more than once within
 * a turn (routine attempt + process turn) and still see a stable baseline.
 */
export class DeferredDirectiveStateStore {
  private baseline: DirectiveFiringState | null = null;
  private loaded = false;
  private readonly captured = new Set<string>();

  constructor(
    private readonly inner: DirectiveStateStore,
    private readonly sessionId: string,
  ) {}

  async load(): Promise<DirectiveFiringState> {
    if (!this.loaded) {
      this.baseline = await this.inner.load({ sessionId: this.sessionId });
      this.loaded = true;
    }
    return this.baseline ?? emptyDirectiveFiringState();
  }

  capture(firedNames: readonly string[]): void {
    for (const name of firedNames) {
      this.captured.add(name);
    }
  }

  capturedFiringNames(): string[] {
    return [...this.captured];
  }

  /**
   * Flush the advanced firing state. No-op when the directive subsystem never ran
   * this turn, or when there is nothing to remember and no prior state — so
   * conversations that never use a lifecycle directive never get a row.
   */
  async commit(): Promise<void> {
    if (!this.loaded) {
      return;
    }
    if (!this.baseline && this.captured.size === 0) {
      return;
    }
    const next = commitDirectiveFirings(this.baseline ?? emptyDirectiveFiringState(), [...this.captured]);
    await this.inner.save({ sessionId: this.sessionId, state: next });
  }
}
