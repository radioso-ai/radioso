/**
 * Shared portability primitives for the agent-config export/import bundle.
 *
 * Extracted so both `agentConfig.ts` and per-feature config projections (e.g.
 * external skills) can render the same `secret`/`ref` placeholders without a
 * circular import.
 */

export type AgentConfigPortability = "portable" | "ref" | "secret";

export type AgentConfigRefKind =
  | "documentSource"
  | "storageBucket"
  | "storageObjectPath"
  | "storageGeneration"
  | "websiteEmbedAllowedOrigin"
  | "mcpConnection";

export interface AgentConfigSecretPlaceholder {
  __redacted: "secret";
}

export interface AgentConfigRefPlaceholder {
  __ref: AgentConfigRefKind;
  /**
   * Optional within-bundle linkage key for refs that must be re-bound to another
   * exported entity on import (e.g. a skill -> its MCP connection). Never a
   * database id. Positional refs (document sources, storage objects) omit it.
   */
  key?: string;
}

export const secretPlaceholder = (): AgentConfigSecretPlaceholder => ({ __redacted: "secret" });

export const refPlaceholder = (kind: AgentConfigRefKind, key?: string): AgentConfigRefPlaceholder =>
  key === undefined ? { __ref: kind } : { __ref: kind, key };
