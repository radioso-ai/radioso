/** Who asked. Persisted with a lifecycle operation so a resume can re-check the same identity. */
export interface AppOperatorPrincipal {
  readonly accountId: string;
  readonly userId: string;
}

/**
 * Re-evaluated immediately before every protected effect (FR-027a), including each
 * resumed step, rather than trusted from the request that started the operation. A
 * durable saga can outlive the membership that began it.
 */
export interface AppOperatorAuthorizationPort {
  /** Throws when this principal may not administer Apps in this workspace right now. */
  requireAppAdministration(principal: AppOperatorPrincipal, workspaceId: string): Promise<void>;
}
