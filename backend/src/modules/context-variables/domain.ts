import type { ContextVariableSurfacing } from "./contextResolutionService.js";

export type ContextVariableValueType = "string" | "json";
export type ContextVariableTrustTier = "unverified" | "signed";
export type ContextVariableSensitivity = "normal" | "sensitive";
export type ContextVariableSource = "pushed" | "browser" | "resolver" | "request";
export type ContextVariableScopeType = "session" | "customer" | "agent" | "workspace";

export interface ContextVariable {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  valueType: ContextVariableValueType;
  trustTier: ContextVariableTrustTier;
  sensitivity: ContextVariableSensitivity;
  defaultSurfacing: ContextVariableSurfacing;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentContextVariableEnablement {
  id: string;
  agentId: string;
  variableId: string;
  source: ContextVariableSource;
  resolverSkillId: string | null;
  maxAgeSeconds: number | null;
  resolverTimeoutMs: number | null;
  surfacing: ContextVariableSurfacing;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  variable?: ContextVariable;
}

export interface ContextVariableScope {
  type: ContextVariableScopeType;
  id: string;
}

export interface ContextVariableValue {
  id: string;
  workspaceId: string;
  variableId: string;
  scope: ContextVariableScope;
  data: unknown;
  lastModified: Date;
}

/**
 * Names in this namespace belong to Radioso, not to a workspace. Facts Radioso establishes about a
 * turn are rendered into the same match record as operator-defined variables, and the directive
 * prompts are told they may be relied on — so a workspace variable here would put its value, which
 * can be supplied by the host page at `trustTier: "unverified"`, inside that trust.
 */
export const RESERVED_CONTEXT_VARIABLE_PREFIX = "radioso_";

export const isReservedContextVariableName = (name: string): boolean =>
  name.trim().toLowerCase().startsWith(RESERVED_CONTEXT_VARIABLE_PREFIX);
