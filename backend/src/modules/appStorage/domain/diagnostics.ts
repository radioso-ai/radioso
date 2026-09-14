/**
 * The safe facts an exception carries, and nothing else.
 *
 * A driver error's own `message`, and a pg error's `detail` and `hint`, exist
 * to tell an operator what went wrong in prose — which routinely means
 * quoting the value, the key, or the row that caused it. That is exactly what
 * a storage failure must never put in a log, so none of those three fields is
 * read here. What is left still names the failure: the exception's own class,
 * the SQLSTATE a pg error reports as `code`, the constraint it names when
 * there is one, and a stack pointing at where in this module the call was
 * made — identifiers and shape, never content.
 */
export interface AppStorageExceptionDiagnostics {
  exceptionClass: string;
  sqlState: string | null;
  constraint: string | null;
  stack: string | null;
}

const stringField = (error: unknown, key: string): string | null => {
  if (typeof error !== "object" || error === null) return null;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
};

/**
 * Never throws, and never reads a field that could carry a stored value. A
 * throw that is not an `Error` — a string, a plain object — is named by its
 * `typeof` rather than left blank, because that is itself a fact worth a log:
 * something in this module threw a value the rest of it does not expect.
 */
/**
 * The frames only. A stack's first line repeats the message, and a driver
 * message can quote the value that failed to parse or to fit — the one thing
 * this record must never carry.
 */
const framesOf = (error: Error): string | null => {
  if (error.stack === undefined) return null;
  const frames = error.stack.split("\n").filter((line) => line.trimStart().startsWith("at "));
  return frames.length === 0 ? null : frames.join("\n");
};

export const extractExceptionDiagnostics = (error: unknown): AppStorageExceptionDiagnostics => ({
  exceptionClass: error instanceof Error ? error.constructor.name : typeof error,
  sqlState: stringField(error, "code"),
  constraint: stringField(error, "constraint"),
  stack: error instanceof Error ? framesOf(error) : null,
});
