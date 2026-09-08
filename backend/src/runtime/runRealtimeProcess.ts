export type RealtimeProcessSignal = "SIGINT" | "SIGTERM";

export interface RealtimeProcessSignalPort {
  once(name: RealtimeProcessSignal, listener: () => void): void;
}

export interface RealtimeProcessRuntime {
  shutdown(reason?: string): Promise<void>;
}

/** Installs the startup abort fence before constructing any runtime resource. */
export const runRealtimeProcess = async <T extends RealtimeProcessRuntime>(input: {
  process: RealtimeProcessSignalPort;
  start(signal: AbortSignal): Promise<T>;
}): Promise<T> => {
  const startup = new AbortController();
  // forward-declared: onSignal reads this via closure before the assignment below runs, but the
  // signal listeners registered just after can only fire on a later tick, once `start` (and thus
  // the assignment) has already completed — so this is not a use-before-init.
  // eslint-disable-next-line prefer-const -- assigned once below; see comment above
  let runtime: T | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let shutdownReason: RealtimeProcessSignal | undefined;

  const onSignal = (reason: RealtimeProcessSignal): void => {
    if (shutdownReason) return;
    shutdownReason = reason;
    startup.abort();
    if (runtime) shutdownPromise = runtime.shutdown(reason);
  };
  input.process.once("SIGINT", () => onSignal("SIGINT"));
  input.process.once("SIGTERM", () => onSignal("SIGTERM"));

  runtime = await input.start(startup.signal);
  if (shutdownReason) shutdownPromise ??= runtime.shutdown(shutdownReason);
  if (shutdownPromise) await shutdownPromise;
  return runtime;
};
