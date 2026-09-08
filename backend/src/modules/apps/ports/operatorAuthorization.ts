/** Who asked. Persisted with a lifecycle operation so a resume can re-check the same identity. */
export interface AppOperatorPrincipal {
  readonly accountId: string;
  readonly userId: string;
}

/**
 * `denied` is an answer; `indeterminate` is the absence of one. A membership lookup that
 * times out has not established that anyone lost access, so a saga must not compensate a
 * live installation on the strength of it.
 */
export type AppAuthorizationDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly outcome: "denied" | "indeterminate" };

/**
 * Re-evaluated immediately before every protected effect (FR-027a), including each
 * resumed step, rather than trusted from the request that started the operation. A
 * durable saga can outlive the membership that began it.
 */
export interface AppOperatorAuthorizationPort {
  authorizeAppAdministration(
    principal: AppOperatorPrincipal,
    workspaceId: string,
  ): Promise<AppAuthorizationDecision>;
}
