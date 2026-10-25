import { REDACTED_VALUE, redactSensitiveValues } from "@radioso/conversation-contract";

export { REDACTED_VALUE };

export type ContextVariableSnapshot = Record<string, unknown>;

export interface SnapshotEntry {
  name: string;
  value: unknown;
  sensitive?: boolean;
}

/**
 * Build the persisted/observable snapshot from resolved entries, replacing the value of any
 * entry flagged sensitive with a redaction marker. Centralizes the redaction boundary so no
 * sensitive context value reaches `metadata_json`, logs, or traces. The masking rule itself is
 * the one a sensitive routine slot shares (`redactSensitiveValues` in the conversation contract).
 */
export const redactSnapshot = (entries: readonly SnapshotEntry[]): ContextVariableSnapshot =>
  redactSensitiveValues(
    Object.fromEntries(entries.map((entry) => [entry.name, entry.value])),
    entries.filter((entry) => entry.sensitive).map((entry) => entry.name),
  );
