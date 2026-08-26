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
