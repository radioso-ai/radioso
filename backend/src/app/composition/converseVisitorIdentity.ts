import type { IdentityNonceRepositoryPort } from "../../db/repositories/identityNonceRepository.js";
import type { ConverseVisitorIdentityVerifier } from "../../modules/chat/contracts/index.js";
import { verifySignedIdentity } from "../../modules/context-variables/public.js";
import type { Env } from "../config/env.js";

/**
 * The agent-facing door's visitor-identity verifier. It binds the token to the converse
 * session's public session id and supplies no origin: an MCP session has no client-facing
 * bootstrap, so there is no origin to have been minted against. The issuance window, the
 * session binding, and the single-use nonce are the checks that remain.
 */
export const createConverseVisitorIdentityVerifier = (dependencies: {
  env: Pick<Env, "WORKSPACE_TOKEN_SECRET" | "WORKSPACE_TOKEN_SECRET_PREVIOUS">;
  identityNonceRepository: IdentityNonceRepositoryPort;
}): ConverseVisitorIdentityVerifier => ({
  verify: (input) => verifySignedIdentity({
    token: input.token,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    boundSessionId: input.boundSessionId,
    boundOrigin: null,
    now: Date.now(),
    secrets: [
      dependencies.env.WORKSPACE_TOKEN_SECRET,
      dependencies.env.WORKSPACE_TOKEN_SECRET_PREVIOUS,
    ].filter((secret): secret is string => Boolean(secret)),
    isNonceUsed: (nonce) => dependencies.identityNonceRepository.isUsed(nonce),
    markNonceUsed: (nonce, expiresAt) =>
      dependencies.identityNonceRepository.markUsed(nonce, input.workspaceId, new Date(expiresAt)),
  }),
});
