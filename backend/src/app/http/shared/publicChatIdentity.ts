import { verifySignedIdentityOutcome, type SignedIdentityOutcome } from "../../../modules/context-variables/public.js";
import type { IdentityNonceRepositoryPort } from "../../../db/repositories/identityNonceRepository.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";

interface PublicChatIdentityDependencies {
  env: { WORKSPACE_TOKEN_SECRET?: string; WORKSPACE_TOKEN_SECRET_PREVIOUS?: string };
  identityNonceRepository: Pick<IdentityNonceRepositoryPort, "isUsed" | "markUsed">;
  logger: Pick<AppLogger, "info">;
  metricsRegistry: Pick<MetricsRegistry, "incrementCounter"> | null;
}

/**
 * What a public chat message's `signedIdentity` came to. `no_origin` is the one outcome the
 * verifier does not see: a token arrived on a request that carries no page origin to bind it to.
 */
type PublicChatIdentityOutcome = SignedIdentityOutcome["outcome"] | "no_origin";

/**
 * The visitor identity a public chat message proves, or null. A token that does not verify, for
 * whatever reason, leaves the turn anonymous: it never fails the message. Each token that was sent
 * is counted by outcome, and a refusal is logged with the ids that locate the integration and the
 * outcome; the token and its claims are never recorded.
 */
export const verifyPublicChatIdentity = async (
  dependencies: PublicChatIdentityDependencies,
  input: {
    token: string | undefined;
    workspaceId: string;
    agentId: string;
    chatSessionId: string;
    sourceOrigin: string | null;
  },
) => {
  if (!input.token) {
    return null;
  }
  const record = (outcome: PublicChatIdentityOutcome) => {
    dependencies.metricsRegistry?.incrementCounter("public_chat_identity_verifications_total", {
      help: "Signed visitor identity tokens sent on public chat messages, by verification outcome.",
      labels: { outcome },
    });
    if (outcome !== "verified") {
      dependencies.logger.info(
        { workspaceId: input.workspaceId, agentId: input.agentId, outcome },
        "Public chat identity token was not accepted; the turn continues anonymously",
      );
    }
  };

  if (!input.sourceOrigin) {
    record("no_origin");
    return null;
  }

  const result = await verifySignedIdentityOutcome({
    token: input.token,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    boundSessionId: input.chatSessionId,
    boundOrigin: input.sourceOrigin,
    now: Date.now(),
    secrets: [
      dependencies.env.WORKSPACE_TOKEN_SECRET,
      dependencies.env.WORKSPACE_TOKEN_SECRET_PREVIOUS,
    ].filter((secret): secret is string => Boolean(secret)),
    isNonceUsed: (nonce) => dependencies.identityNonceRepository.isUsed(nonce),
    markNonceUsed: (nonce, expiresAt) =>
      dependencies.identityNonceRepository.markUsed(nonce, input.workspaceId, new Date(expiresAt)),
  });
  record(result.outcome);
  return result.outcome === "verified" ? result.identity : null;
};
