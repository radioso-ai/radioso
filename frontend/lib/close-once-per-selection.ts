/**
 * Guards a "close" action so it runs at most once per distinct, non-null selection key — even
 * when two independent signals (a user action and a background poll) both decide the same open
 * item should close before either one's state update has re-rendered the owning component. A
 * close that is still pending when the other signal arrives for the *same* item stays suppressed;
 * reopening that same id later still gets its own close.
 *
 * Pure and React-free so the state machine is testable on its own; a caller holds one
 * {@link CloseOnceGuard} in a ref and calls {@link admitSelection} every render, then
 * {@link admitClose} from the close handler itself.
 */
export interface CloseOnceGuard {
  readonly previousKey: string | null
  readonly closed: boolean
}

export const initialCloseOnceGuard: CloseOnceGuard = { previousKey: null, closed: false }

/**
 * Advances the guard to the current render's open key (null when nothing is open). Resets
 * `closed` only when a *new*, non-null key appears — not merely when the key clears to null — so
 * a close pending for the item that just cleared isn't un-suppressed by that same clearing, while
 * a later, different open (including the same id reopened after clearing) starts un-closed again.
 */
export const admitSelection = (guard: CloseOnceGuard, key: string | null): CloseOnceGuard => {
  if (key === guard.previousKey) {
    return guard
  }
  return { previousKey: key, closed: key === null ? guard.closed : false }
}

/** Marks the guard closed if it wasn't already; `shouldClose` is false for every call after the first. */
export const admitClose = (guard: CloseOnceGuard): { guard: CloseOnceGuard; shouldClose: boolean } =>
  guard.closed ? { guard, shouldClose: false } : { guard: { ...guard, closed: true }, shouldClose: true }
