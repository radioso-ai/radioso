import { MAX_ERROR_MESSAGE_LENGTH, type AppError, type AppErrorCode } from "@radioso/app-contract";

/**
 * Every storage operation answers with a value or with one of the runtime
 * protocol's error codes. Throwing instead would make the gateway in front of
 * this domain guess which failures are an App's fault and which are the host's,
 * and the protocol already names that distinction.
 */
export type AppStorageResult<TValue> = { ok: true; value: TValue } | { ok: false; error: AppError };

export const storageSuccess = <TValue>(value: TValue): AppStorageResult<TValue> => ({ ok: true, value });

/**
 * A message names declarations — a collection id, a field key, an index id — and
 * never a record key or a stored value. Declarations come from a manifest an
 * operator approved; the rest is customer data, and an error is the easiest way
 * to carry it into a log.
 */
export const storageFailure = <TValue>(code: AppErrorCode, message: string): AppStorageResult<TValue> => ({
  ok: false,
  error: { code, message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH) },
});
