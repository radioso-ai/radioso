import type { Db } from "../../shared/infra/kysely/types.js";
import type { AgentConverseSessionMappingPort } from "../../modules/settings/contracts/agentConverseSession.js";

/** PostgreSQL implementation of the credential-version to conversation identity mapping. */
export class AgentConverseSessionMappingRepository implements AgentConverseSessionMappingPort {
  constructor(private readonly db: Db) {}

  async resolvePublicSessionId(input: {
    grantId: string;
    grantVersion: string;
    proposedPublicSessionId: string;
  }): Promise<string> {
    const row = await this.db
      .insertInto("agent_converse_session_mappings")
      .values({
        grant_id: input.grantId,
        grant_version: input.grantVersion,
        public_session_id: input.proposedPublicSessionId,
      })
      .onConflict((oc) => oc.columns(["grant_id", "grant_version"]).doUpdateSet((eb) => ({
        grant_version: eb.ref("excluded.grant_version"),
      })))
      .returning("public_session_id")
      .executeTakeFirstOrThrow();

    return row.public_session_id;
  }
}
