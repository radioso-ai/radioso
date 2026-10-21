/** Whether a file-system failure carries `code`, such as `EEXIST` for a file another writer made first. */
export const hasFileErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

/** Whether a file-system failure says the file or directory is not there (`ENOENT`). */
export const isMissingFile = (error: unknown): boolean => hasFileErrorCode(error, "ENOENT");
