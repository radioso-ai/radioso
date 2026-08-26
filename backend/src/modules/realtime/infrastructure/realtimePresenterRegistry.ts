import type { SsePresenterRegistration, SsePresenterReservation } from "../http/ssePresenter.js";

/** Bounded by the runtime connection cap; owns no HTTP or presenter semantics. */
export class RealtimePresenterRegistry {
  private readonly active = new Set<SsePresenterRegistration>();
  private readonly shutdownController = new AbortController();
  private closePromise: Promise<void> | undefined;

  constructor(private readonly maxPresenters: number) {
    if (maxPresenters <= 0) throw new Error("realtime presenter capacity must be positive");
  }

  get shutdownSignal(): AbortSignal {
    return this.shutdownController.signal;
  }

  reserve(): SsePresenterReservation {
    let registration: SsePresenterRegistration | undefined;
    let resolveRegistration!: (value: SsePresenterRegistration) => void;
    let pendingAbort = false;
    let pendingDestroy = false;
    let bound = false;
    const registrationReady = new Promise<SsePresenterRegistration>((resolve) => {
      resolveRegistration = resolve;
    });
    const tracked = this.track({
      promise: registrationReady.then((value) => value.promise),
      abortPreflight: () => {
        pendingAbort = true;
        registration?.abortPreflight();
      },
      forceDestroy: () => {
        pendingDestroy = true;
        registration?.forceDestroy();
      },
    });
    const bind = (value: SsePresenterRegistration): void => {
      if (bound) return;
      bound = true;
      registration = value;
      if (pendingAbort) value.abortPreflight();
      if (pendingDestroy) value.forceDestroy();
      resolveRegistration(value);
    };
    return {
      track: (value) => {
        bind(value);
        return tracked;
      },
      release: () => bind({
        promise: Promise.resolve(),
        abortPreflight: () => undefined,
        forceDestroy: () => undefined,
      }),
    };
  }

  track(registration: SsePresenterRegistration): Promise<void> {
    if (this.shutdownController.signal.aborted) throw new Error("realtime presenter registry is closed");
    if (this.active.size >= this.maxPresenters) throw new Error("realtime presenter capacity exceeded");
    this.active.add(registration);
    return registration.promise.finally(() => { this.active.delete(registration); });
  }

  abortPreflight(): void {
    for (const registration of this.active) registration.abortPreflight();
  }

  closeAll(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.shutdownController.abort();
    this.closePromise = Promise.allSettled([...this.active].map((registration) => registration.promise)).then(() => undefined);
    return this.closePromise;
  }

  forceDestroy(): void {
    for (const registration of this.active) registration.forceDestroy();
  }
}
