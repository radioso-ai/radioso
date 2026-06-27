export type ContextVariableSnapshot = Record<string, unknown>;

export interface SnapshotEntry {
  name: string;
  value: unknown;
  sensitive?: boolean;
}

export const REDACTED_VALUE = "[redacted]";

/**
 * Build the persisted/observable snapshot from resolved entries, replacing the value of any
 * entry flagged sensitive with a redaction marker. Centralizes the redaction boundary so no
 * sensitive context value reaches `metadata_json`, logs, or traces.
 */
export const redactSnapshot = (entries: readonly SnapshotEntry[]): ContextVariableSnapshot =>
  Object.fromEntries(
    entries.map((entry) => [entry.name, entry.sensitive ? REDACTED_VALUE : entry.value]),
  );
