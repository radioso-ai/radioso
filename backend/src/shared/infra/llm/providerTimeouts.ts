export const EMBEDDING_REQUEST_TIMEOUT_MS = 60_000;

export class ProviderRequestTimeoutError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = "ProviderRequestTimeoutError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

export const isProviderRequestTimeoutError = (error: unknown): error is ProviderRequestTimeoutError =>
  error instanceof ProviderRequestTimeoutError;

export const runProviderRequestWithTimeout = async <T>(
  operation: string,
  timeoutMs: number,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const abortController = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      abortController.abort();
      reject(new ProviderRequestTimeoutError(operation, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      request(abortController.signal),
      timeoutPromise,
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};
