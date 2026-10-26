import { isVoiceVendor, isVoiceVendorRegion } from "../../../shared/domain/voiceVendor.js";
import { currentTimestamp } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type { VoiceRuntimeConnection, VoiceRuntimeConnectionStore } from "../domain.js";

/**
 * `agent_voice_runtime_connections`: the vendor agent Radioso maintains for each agent, scoped to
 * the agent's workspace. A row naming a vendor or region this version does not know reads as no
 * connection, so the next Connect replaces it.
 */
export class VoiceRuntimeConnectionRepository implements VoiceRuntimeConnectionStore {
  constructor(private readonly db: Db) {}

  async find(agent: { workspaceId: string; agentId: string }): Promise<VoiceRuntimeConnection | null> {
    const row = await this.db
      .selectFrom("agent_voice_runtime_connections")
      .select(["vendor", "region", "vendor_agent_id", "channel_credential_id"])
      .where("agent_id", "=", agent.agentId)
      .where("workspace_id", "=", agent.workspaceId)
      .executeTakeFirst();
    if (!row || !isVoiceVendor(row.vendor) || !isVoiceVendorRegion(row.region)) return null;
    return {
      workspaceId: agent.workspaceId,
      agentId: agent.agentId,
      vendor: row.vendor,
      region: row.region,
      vendorAgentId: row.vendor_agent_id,
      channelCredentialId: row.channel_credential_id,
    };
  }

  async save(connection: VoiceRuntimeConnection): Promise<void> {
    const values = {
      vendor: connection.vendor,
      region: connection.region,
      vendor_agent_id: connection.vendorAgentId,
      channel_credential_id: connection.channelCredentialId,
    };
    await this.db
      .insertInto("agent_voice_runtime_connections")
      .values({ agent_id: connection.agentId, workspace_id: connection.workspaceId, ...values })
      .onConflict((oc) =>
        oc.column("agent_id")
          .doUpdateSet({ ...values, updated_at: currentTimestamp() })
          .where("agent_voice_runtime_connections.workspace_id", "=", connection.workspaceId),
      )
      .execute();
  }

  async remove(agent: { workspaceId: string; agentId: string }): Promise<void> {
    await this.db
      .deleteFrom("agent_voice_runtime_connections")
      .where("agent_id", "=", agent.agentId)
      .where("workspace_id", "=", agent.workspaceId)
      .execute();
  }
}
