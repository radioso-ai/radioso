import type { AuthenticatedPrincipal } from "../../account/public.js";

/**
 * Who issued a converse session, and therefore what has to still hold for it to keep
 * working. A grant session is bound to one credential version; a walk-in session is bound
 * to the agent's current public id and its walk-in switch, so rotating the id or closing
 * the door ends every live walk-in session on its next request with nothing to sweep.
 */
export type AgentConverseOrigin =
  | { kind: "grant"; grantId: string; grantVersion: string }
  | { kind: "walk_in"; publicId: string };

export interface AgentConversePrincipal {
  workspaceId: string;
  agentId: string;
  publicSessionId: string;
  origin: AgentConverseOrigin;
  sourceChannel: "mcp";
  sourceOrigin: null;
  authPrincipal: AuthenticatedPrincipal;
}

export interface AgentConverseSessionExchangeResult extends AgentConversePrincipal {
  sessionToken: string;
  expiresAt: string;
  agent: {
    id: string;
    name: string;
  };
}

/** Caller facts the HTTP edge already resolved, carried into the exchange for audit and telemetry. */
interface AgentConverseSessionExchangeContext {
  client?: { name?: string; version?: string };
  /** Opaque digest of the calling source; never an address, never a public id. */
  sourceDigest?: string;
}

/** Exactly one issuer per exchange: a minted credential, or an agent's public id. */
export type AgentConverseSessionExchangeInput =
  | (AgentConverseSessionExchangeContext & { launchToken: string })
  | (AgentConverseSessionExchangeContext & { publicId: string });

/** The session claims an origin has to still agree with, re-read on every request. */
export interface AgentConverseOriginContext {
  origin: AgentConverseOrigin;
  workspaceId: string;
  agentId: string;
}

export type AgentConverseOriginRevalidation =
  | { ok: true }
  | { ok: false; statusCode: 401 | 403; code: string; message: string };

/**
 * One port, one call site: `validate` re-checks an origin without knowing which kinds
 * exist. Adapters own their own refusal codes and their own audit trail.
 */
export interface AgentConverseOriginVerifier {
  revalidate(input: AgentConverseOriginContext): Promise<AgentConverseOriginRevalidation>;
}

export type AgentConverseWalkInOpening =
  | { ok: true; workspaceId: string; agentId: string; agentName: string }
  /** `disabled` and `unknown` are told apart for telemetry only; callers see one refusal. */
  | { ok: false; reason: "disabled" | "unknown" };

/** Resolves an agent's public id into a walk-in target, or refuses it. */
export interface AgentConverseWalkInIssuerPort {
  open(publicId: string): Promise<AgentConverseWalkInOpening>;
}

/** Counts walk-in exchange outcomes. Never sees a public id. */
export interface AgentConverseWalkInObserver {
  record(input: {
    outcome: "issued" | "disabled" | "throttled" | "unknown";
    agentId?: string | null;
    sourceDigest?: string | null;
  }): void;
}

/** The converse session flow only needs the bound agent's public identity. */
export interface AgentConverseAgentLookupPort {
  findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<{
    id: string;
    name: string;
  } | null>;
}

/**
 * Persists the conversation identity derived from one active MCP credential
 * version. The exchange service owns the mapping's meaning; storage only
 * provides an atomic get-or-create operation.
 *
 * Walk-in sessions never reach this: the table is keyed by a grant, and a walk-in
 * exchange is meant to open a fresh conversation every time.
 */
export interface AgentConverseSessionMappingPort {
  resolvePublicSessionId(input: {
    grantId: string;
    grantVersion: string;
    proposedPublicSessionId: string;
  }): Promise<string>;
}

/** What the MCP converse HTTP surface needs from the session service. */
export interface AgentConverseSessionPort {
  exchange(input: AgentConverseSessionExchangeInput): Promise<AgentConverseSessionExchangeResult>;
  validate(sessionToken: string | undefined): Promise<AgentConversePrincipal>;
  recordSuccessfulUse(principal: Pick<AgentConversePrincipal, "origin">): void;
  permissions(): string[];
}
