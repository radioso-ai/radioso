import { randomUUID } from "node:crypto";

import type { AccessGrantService } from "../../accessGrants/public.js";
import type {
  AgentConverseAgentLookupPort,
  AgentConverseChannel,
  AgentConverseOpening,
  AgentConverseOriginVerifier,
  AgentConversePresentedCredential,
  AgentConversePrincipalOpeningResult,
  AgentConversePrincipalPort,
  AgentConversePrincipalVerification,
  AgentConverseRefusal,
  AgentConverseSessionExchangeInput,
  AgentConverseWalkInIssuerPort,
  AgentConverseWalkInObserver,
} from "../contracts/agentConverseSession.js";
import { agentConversePrincipal } from "../domain/agentConversePrincipal.js";
import { converseSessionExpiresAt } from "../domain/publicChatSession.js";
import { openGrantExchangeOrigin, openWalkInExchangeOrigin } from "./converseExchangeOrigins.js";

/** A refusal raised inside the shared origin checks, caught here and returned as a value. */
class ConverseOpeningRefused extends Error {
  constructor(readonly refusal: AgentConverseRefusal) {
    super(refusal.code);
    this.name = "ConverseOpeningRefused";
  }
}

// The checks speak HTTP status codes; only 401 and 403 are ever raised by them.
const refuse = (statusCode: number, code: string): Error =>
  new ConverseOpeningRefused({ statusCode: statusCode === 401 ? 401 : 403, code });

const refused = (refusal: AgentConverseRefusal) => ({ ok: false as const, refusal });

/**
 * Issues converse principals for one door that holds no session token (A2A): the same origin checks
 * as the MCP exchange admit an opening, and the same origin verifier re-admits every later call.
 * Nothing is stored and no token is signed; the door seals the opening into its own context.
 *
 * It writes no exchange audit: the door's per-turn converse audit names the door, the grant, and the
 * conversation on every turn, and a walk-in opening is counted by the walk-in observer exactly as an
 * MCP walk-in exchange is.
 */
export class AgentConversePrincipalIssuer implements AgentConversePrincipalPort {
  constructor(
    private readonly dependencies: {
      channel: AgentConverseChannel;
      accessGrantService: Pick<
        AccessGrantService,
        "resolveConverseGrant" | "resolvePublicLaunchGrant" | "evaluate" | "recordAuthFailure"
      >;
      agentLookup: AgentConverseAgentLookupPort;
      originVerifier: AgentConverseOriginVerifier;
      walkInIssuer: AgentConverseWalkInIssuerPort;
      walkInObserver?: AgentConverseWalkInObserver;
    },
  ) {}

  async open(input: AgentConverseSessionExchangeInput): Promise<AgentConversePrincipalOpeningResult> {
    try {
      const issued = "publicId" in input
        ? await openWalkInExchangeOrigin(
          { walkInIssuer: this.dependencies.walkInIssuer, observer: this.dependencies.walkInObserver, refuse },
          { publicId: input.publicId, sourceDigest: input.sourceDigest },
        )
        : await openGrantExchangeOrigin(
          {
            accessGrantService: this.dependencies.accessGrantService,
            agentLookup: this.dependencies.agentLookup,
            // Each caller-held context is its own conversation, never the one a grant version pins.
            publicSessionIdFor: async () => randomUUID(),
            refuse,
          },
          { launchToken: input.launchToken, client: input.client },
        );
      const opening: AgentConverseOpening = {
        workspaceId: issued.workspaceId,
        agentId: issued.agentId,
        publicSessionId: issued.publicSessionId,
        origin: issued.origin,
        expiresAt: issued.origin.kind === "walk_in" ? converseSessionExpiresAt() : null,
      };
      return { ok: true, opening, principal: agentConversePrincipal(opening, this.dependencies.channel) };
    } catch (error) {
      if (error instanceof ConverseOpeningRefused) {
        return refused(error.refusal);
      }
      throw error;
    }
  }

  async verify(
    opening: AgentConverseOpening,
    presented: AgentConversePresentedCredential = {},
  ): Promise<AgentConversePrincipalVerification> {
    // Written so an unreadable expiry counts as lapsed rather than as forever.
    if (opening.expiresAt !== null && !(Date.parse(opening.expiresAt) > Date.now())) {
      return refused({ statusCode: 401, code: "opening_expired" });
    }
    const presentedRefusal = await this.refusePresentedCredential(opening, presented);
    if (presentedRefusal) {
      return refused(presentedRefusal);
    }
    const revalidation = await this.dependencies.originVerifier.revalidate({
      origin: opening.origin,
      workspaceId: opening.workspaceId,
      agentId: opening.agentId,
    });
    if (!revalidation.ok) {
      return refused({ statusCode: revalidation.statusCode, code: revalidation.code });
    }
    return { ok: true, principal: agentConversePrincipal(opening, this.dependencies.channel) };
  }

  /**
   * A context continues only under the origin that opened it. A grant opening needs the caller to
   * present that same grant again, resolved by its token and compared by id (the origin verifier
   * then re-checks the grant itself); a walk-in opening is held by whoever holds it, so a caller
   * presenting a credential with one is presenting a different origin.
   */
  private async refusePresentedCredential(
    opening: AgentConverseOpening,
    presented: AgentConversePresentedCredential,
  ): Promise<AgentConverseRefusal | null> {
    if (opening.origin.kind === "walk_in") {
      return presented.launchToken ? { statusCode: 403, code: "origin_mismatch" } : null;
    }
    if (!presented.launchToken) {
      return { statusCode: 401, code: "converse_grant_required" };
    }
    const grant = await this.dependencies.accessGrantService.resolveConverseGrant(presented.launchToken);
    if (!grant) {
      return { statusCode: 401, code: "invalid_converse_grant" };
    }
    return grant.id === opening.origin.grantId ? null : { statusCode: 403, code: "origin_mismatch" };
  }
}
