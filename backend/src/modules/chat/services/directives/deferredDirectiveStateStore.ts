import {
  commitDirectiveFirings,
  emptyDirectiveFiringState,
  type DirectiveFiringState,
  type DirectiveStateStore,
} from "../../../directives/public.js";

/**
 * The firing-memory advance a turn captured and did not commit, because its reply is published
 * later, if at all: the turn the memory stood at when the turn read it, and the directives that
 * fired. Channel-neutral and serializable, so it can wait with the unpublished reply.
 */
export interface DeferredDirectiveTransition {
  readonly fromTurnSeq: number;
  readonly firedNames: readonly string[];
}

/**
 * Applies a deferred transition as the turn's own commit would have, once: only while the memory
 * still stands at the turn the transition read. Memory that has moved on, because the transition
 * was already applied or a later turn committed, is left as it is. Memory that expired meanwhile
 * restarts from the turn the transition read, as an expired conversation's memory starts afresh.
 * Returns whether it advanced the memory.
 */
export const applyDeferredDirectiveTransition = async (
  store: DirectiveStateStore,
  sessionId: string,
  transition: DeferredDirectiveTransition,
): Promise<boolean> => {
  const current = await store.load({ sessionId });
  const from = current ?? { turnSeq: transition.fromTurnSeq, firings: {} };
  if (from.turnSeq !== transition.fromTurnSeq) {
    return false;
  }
  await store.save({ sessionId, state: commitDirectiveFirings(from, transition.firedNames) });
  return true;
};

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
    const transition = this.deferredTransition();
    if (!transition) {
      return;
    }
    const next = commitDirectiveFirings(this.baseline ?? emptyDirectiveFiringState(), transition.firedNames);
    await this.inner.save({ sessionId: this.sessionId, state: next });
  }

  /**
   * The advance {@link commit} would write, held back for a turn whose reply is published later,
   * if at all; null when commit would write nothing.
   */
  deferredTransition(): DeferredDirectiveTransition | null {
    if (!this.loaded || (!this.baseline && this.captured.size === 0)) {
      return null;
    }
    return { fromTurnSeq: (this.baseline ?? emptyDirectiveFiringState()).turnSeq, firedNames: [...this.captured] };
  }
}
