export type RedisAdmissionScriptReply = {
  ok: boolean;
  leaseId?: string;
  reason?: string;
  retryAfterMs?: number;
  expiresAtMs?: number;
  serverTimeMs?: number;
  processedCount?: number;
  hasMore?: boolean;
};

type AdmissionOperation =
  | "admission.acquire"
  | "admission.renew"
  | "admission.release"
  | "admission.sweep"
  | "admission.reconnect";

const isAdmissionOperation = (name: string): name is AdmissionOperation =>
  name === "admission.acquire"
  || name === "admission.renew"
  || name === "admission.release"
  || name === "admission.sweep"
  || name === "admission.reconnect";

const isLeaseOperation = (name: AdmissionOperation): boolean =>
  name === "admission.acquire" || name === "admission.renew" || name === "admission.release";

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isProcessedCount = (value: unknown): value is number =>
  isFiniteNumber(value) && Number.isInteger(value) && value >= 0;

const objectReply = (name: AdmissionOperation, value: Record<string, unknown>): RedisAdmissionScriptReply | undefined => {
  const allowedKeys = new Set([
    "ok", "reason", "retryAfterMs", "expiresAtMs", "serverTimeMs", "processedCount", "hasMore", "leaseId",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return undefined;
  if (typeof value.ok !== "boolean" || typeof value.reason !== "string") return undefined;
  if (value.leaseId !== undefined && typeof value.leaseId !== "string") return undefined;

  if (!value.ok) {
    if (!isFiniteNumber(value.retryAfterMs)) return undefined;
    if (value.serverTimeMs !== undefined || value.expiresAtMs !== undefined || value.processedCount !== undefined || value.leaseId !== undefined) return undefined;
    if (value.reason === "cleanup_backlog") {
      if (typeof value.hasMore !== "boolean") return undefined;
    } else if (value.hasMore !== undefined) return undefined;
    return {
      ok: false,
      reason: value.reason,
      retryAfterMs: value.retryAfterMs,
      hasMore: value.hasMore as boolean | undefined,
    };
  }

  if (!isFiniteNumber(value.serverTimeMs) || value.retryAfterMs !== undefined) return undefined;
  if (value.processedCount !== undefined && !isProcessedCount(value.processedCount)) return undefined;
  if (isLeaseOperation(name)) {
    if (!isFiniteNumber(value.expiresAtMs) || typeof value.hasMore !== "boolean") return undefined;
  } else if (name === "admission.sweep") {
    if (value.expiresAtMs !== undefined || typeof value.hasMore !== "boolean" || value.leaseId !== undefined) return undefined;
  } else if (value.expiresAtMs !== undefined || value.processedCount !== undefined || value.hasMore !== undefined || value.leaseId !== undefined) return undefined;

  return {
    ok: true,
    reason: value.reason,
    serverTimeMs: value.serverTimeMs,
    expiresAtMs: value.expiresAtMs as number | undefined,
    processedCount: value.processedCount as number | undefined,
    hasMore: value.hasMore as boolean | undefined,
    leaseId: value.leaseId as string | undefined,
  };
};

/** Decodes node-redis RESP arrays without coupling the controller to Redis types. */
export const decodeRedisAdmissionReply = (name: string, value: unknown): RedisAdmissionScriptReply | undefined => {
  if (!isAdmissionOperation(name)) return undefined;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return objectReply(name, value as Record<string, unknown>);
  }
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const [ok, reason, timingValue, expiresAtMs] = value;
  if ((ok !== 0 && ok !== 1) || typeof reason !== "string") return undefined;
  const succeeded = ok === 1;
  const expectedLength = succeeded
    ? name === "admission.sweep" ? 5 : name === "admission.reconnect" ? 3 : 6
    : reason === "cleanup_backlog" ? 4 : 3;
  if (value.length !== expectedLength) return undefined;
  if (typeof timingValue !== "number" || !Number.isFinite(timingValue)) return undefined;
  if (succeeded && isLeaseOperation(name) && !isFiniteNumber(expiresAtMs)) return undefined;
  const processedIndex = succeeded
    ? name === "admission.sweep" ? 3 : isLeaseOperation(name) ? 4 : undefined
    : undefined;
  const processedValue = processedIndex === undefined ? undefined : value[processedIndex];
  if (processedIndex !== undefined && !isProcessedCount(processedValue)) return undefined;
  const hasMoreIndex = name === "admission.sweep"
    ? 4
    : succeeded && (name === "admission.acquire" || name === "admission.renew" || name === "admission.release") && value.length === 6
      ? 5
      : !succeeded && reason === "cleanup_backlog" && value.length === 4
        ? 3
        : undefined;
  const hasMoreValue = hasMoreIndex === undefined ? undefined : value[hasMoreIndex];
  if ((name === "admission.sweep" || (succeeded && name !== "admission.reconnect")) && (hasMoreValue !== 0 && hasMoreValue !== 1)) return undefined;
  return {
    ok: succeeded,
    reason,
    retryAfterMs: !succeeded && typeof timingValue === "number" ? timingValue : undefined,
    serverTimeMs: succeeded && typeof timingValue === "number" ? timingValue : undefined,
    expiresAtMs: typeof expiresAtMs === "number" ? expiresAtMs : undefined,
    processedCount: typeof processedValue === "number" ? processedValue : undefined,
    hasMore: typeof hasMoreValue === "number" ? hasMoreValue === 1 : undefined,
  };
};
