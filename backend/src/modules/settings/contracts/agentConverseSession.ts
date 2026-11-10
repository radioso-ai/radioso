import type { AuthenticatedPrincipal } from "../../account/public.js";
import type { AgentSourceChannel } from "../../../shared/domain/conversationSource.js";

/**
 * Who issued a converse session, and therefore what has to still hold for it to keep
 * working. A grant session is bound to one credential version; a walk-in session is bound
 * to the agent's current public id and its walk-in switch, so rotating the id or closing
 * the door ends every live walk-in session on its next request with nothing to sweep.
 */
export type AgentConverseOrigin =
  | { kind: "grant"; grantId: string; grantVersion: string }
  | { kind: "walk_in"; publicId: string };

/**
 * The agent doors whose callers are admitted by a walk-in public id or a converse grant: MCP
 * converse, which holds a signed session token, and A2A, which holds none (see
 * {@link AgentConversePrincipalPort}). The REST agent channel authenticates per request with its
 * own credential and never holds a converse principal.
 */
export type AgentConverseChannel = Extract<AgentSourceChannel, "mcp" | "a2a">;

export interface AgentConversePrincipal {
  workspaceId: string;
  agentId: string;
  publicSessionId: string;
  origin: AgentConverseOrigin;
  sourceChannel: AgentConverseChannel;
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

/**
 * What a door without session tokens keeps in a context of its own and hands back on every later
 * call: the conversation, the origin it was opened under, and when the opening lapses. Settings
 * persists none of it, so the holder must keep it tamper-proof (sealed, not merely encoded).
 */
export interface AgentConverseOpening {
  workspaceId: string;
  agentId: string;
  publicSessionId: string;
  origin: AgentConverseOrigin;
  /** A walk-in opening's absolute end, the walk-in session lifetime; null for a grant, which lasts as long as its version. */
  expiresAt: string | null;
}

/**
 * Why an opening or a later call was refused. `code` is the vocabulary the MCP exchange and the
 * origin verifier already speak (`walk_in_unavailable`, `invalid_converse_grant`, `grant_rotated`,
 * `walk_in_revoked`, …) plus `opening_expired`. It carries no message text: a door maps the code
 * to its own protocol's error.
 */
export interface AgentConverseRefusal {
  /** 401: nothing valid was presented; 403: it was recognised, and no longer admits the caller. */
  statusCode: 401 | 403;
  code: string;
}

export type AgentConversePrincipalOpeningResult =
  | { ok: true; opening: AgentConverseOpening; principal: AgentConversePrincipal }
  | { ok: false; refusal: AgentConverseRefusal };

export type AgentConversePrincipalVerification =
  | { ok: true; principal: AgentConversePrincipal }
  | { ok: false; refusal: AgentConverseRefusal };

/** The credential a caller presented beside a held opening, if any: a grant's launch token. */
export interface AgentConversePresentedCredential {
  launchToken?: string;
}

/**
 * Converse principals for a door that holds no session token. `open` applies the MCP exchange's
 * origin checks and always opens a fresh conversation, for a grant too: each caller-held context is
 * its own conversation, rather than the one a grant version pins for MCP. `verify` re-admits an
 * opening through the same {@link AgentConverseOriginVerifier} MCP sessions use, so rotating the
 * public id, closing the walk-in door, or rotating or revoking the grant ends every context on its
 * next call, with nothing to sweep. An opening continues only under the origin that opened it: a
 * grant opening needs that same grant presented again (`origin_mismatch` for another one,
 * `converse_grant_required` for none), and a walk-in opening presented with a credential is
 * `origin_mismatch`. Verifying opens nothing. The port is bound to one channel when composed.
 */
export interface AgentConversePrincipalPort {
  open(input: AgentConverseSessionExchangeInput): Promise<AgentConversePrincipalOpeningResult>;
  verify(
    opening: AgentConverseOpening,
    presented?: AgentConversePresentedCredential,
  ): Promise<AgentConversePrincipalVerification>;
}
