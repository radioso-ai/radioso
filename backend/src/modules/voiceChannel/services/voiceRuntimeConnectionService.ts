import { VOICE_VENDORS, type VoiceVendor, type VoiceVendorRegion } from "../../../shared/domain/voiceVendor.js";
import { errorClassOf } from "../../../shared/observability/errorClass.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import {
  VoiceRuntimeConnectionError,
  VoiceVendorRequestError,
  type VoiceRuntimeAgentEnsured,
  type VoiceRuntimeAgentProfileSource,
  type VoiceRuntimeAgentSpec,
  type VoiceRuntimeBinder,
  type VoiceRuntimeBinding,
  type VoiceRuntimeChannelCredentials,
  type VoiceRuntimeCompletionsAddress,
  type VoiceRuntimeConnection,
  type VoiceRuntimeConnectionActor,
  type VoiceRuntimeConnectionAudit,
  type VoiceRuntimeConnectionFailure,
  type VoiceRuntimeConnectionPort,
  type VoiceRuntimeConnectionStatus,
  type VoiceRuntimeConnectionStore,
  type VoiceRuntimeDisconnection,
  type VoiceRuntimeProvisioner,
  type VoiceVendorCredential,
  type VoiceVendorCredentialReader,
} from "../domain.js";

/** The vendor Radioso connects. There is one; a second makes connect name which. */
const CONNECT_VENDOR: VoiceVendor = VOICE_VENDORS[0];

const FAILURE_OF_VENDOR_REASON: Readonly<Record<VoiceVendorRequestError["reason"], VoiceRuntimeConnectionFailure>> = {
  rejected: "vendor_key_rejected",
  insufficient_permissions: "vendor_key_lacks_agents_permission",
  refused: "vendor_failed",
  unreachable: "vendor_unreachable",
  timeout: "vendor_unreachable",
  malformed_response: "vendor_failed",
};

type ConnectionOperation = "connect" | "disconnect" | "sync" | "agent_deleted";
type ConnectionOutcome =
  | "created"
  | "repaired"
  | "released"
  | "unbound"
  | "vendor_agent_left"
  | "synced"
  | "needs_connect"
  | "error"
  | VoiceRuntimeConnectionFailure;

interface VoiceRuntimeConnectionServiceDependencies {
  agents: VoiceRuntimeAgentProfileSource;
  connections: VoiceRuntimeConnectionStore;
  credentials: VoiceVendorCredentialReader;
  provisioners: Readonly<Record<VoiceVendor, VoiceRuntimeProvisioner>>;
  channelCredentials: VoiceRuntimeChannelCredentials;
  binder: VoiceRuntimeBinder;
  /** Null when the deployment has no public origin a vendor can reach: nothing can be connected. */
  completionsAddress: VoiceRuntimeCompletionsAddress | null;
  audit: VoiceRuntimeConnectionAudit;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  logger: Pick<AppLogger, "info" | "warn">;
}

type AgentRef = { workspaceId: string; agentId: string };

/** The binding names the vendor agent Radioso created and keeps for this agent. */
const isMaintained = (runtime: VoiceRuntimeBinding | null, connection: VoiceRuntimeConnection | null): boolean =>
  runtime !== null && connection !== null && runtime.vendor === connection.vendor && runtime.agentId === connection.vendorAgentId;

const failureOf = (error: unknown): VoiceRuntimeConnectionFailure | null => {
  if (error instanceof VoiceRuntimeConnectionError) return error.reason;
  if (error instanceof VoiceVendorRequestError) return FAILURE_OF_VENDOR_REASON[error.reason];
  return null;
};

const vendorErrorFields = (error: unknown) => ({
  errorClass: errorClassOf(error),
  ...(error instanceof VoiceVendorRequestError ? { reason: error.reason } : {}),
  ...(error instanceof VoiceVendorRequestError && error.vendorStatus !== undefined ? { vendorStatus: error.vendorStatus } : {}),
});

/**
 * Connects an agent's voice channel to a vendor agent Radioso creates and maintains on the
 * workspace's own vendor account: the operator stores the vendor's key and presses Connect, and
 * never meets the vendor agent's id, its LLM URL, its secrets or the account's region.
 *
 * Connecting finds the key's region, keeps the REST credential the vendor agent carries (reused
 * while it works, else a new one), creates or repairs the vendor agent, records the connection,
 * revokes a credential it replaced, and binds the agent's `voice.runtime` to it. A credential goes
 * only once no vendor agent holds it: one minted for a vendor call that failed, or for an agent this
 * attempt created and deleted again because it could not be recorded. Pressing Connect again repairs: the
 * vendor agent's settings, a binding a save cleared, a credential that was revoked. A key that now
 * belongs to another region's account gets a new vendor agent there; the old one is out of the
 * key's reach and its credential is revoked.
 *
 * Disconnecting deletes the vendor agent Radioso created and its credential, and unbinds. A runtime
 * the operator bound by hand is only unbound: Radioso never deletes a vendor agent it did not create.
 */
export class VoiceRuntimeConnectionService implements VoiceRuntimeConnectionPort {
  constructor(private readonly dependencies: VoiceRuntimeConnectionServiceDependencies) {}

  async status(agent: AgentRef): Promise<VoiceRuntimeConnectionStatus> {
    const profile = await this.requireProfile(agent);
    const connection = await this.dependencies.connections.find(agent);
    return this.statusOf(agent.workspaceId, profile.runtime, connection);
  }

  async connect(input: AgentRef & { actor: VoiceRuntimeConnectionActor }): Promise<VoiceRuntimeConnectionStatus> {
    const { workspaceId, agentId, actor } = input;
    let vendor: VoiceVendor = CONNECT_VENDOR;
    try {
      const completionsAddress = this.dependencies.completionsAddress;
      if (!completionsAddress) throw new VoiceRuntimeConnectionError("connection_unavailable");
      const profile = await this.requireProfile(input);
      vendor = profile.runtime?.vendor ?? CONNECT_VENDOR;
      const credential = await this.requireCredential(workspaceId, vendor);
      const provisioner = this.dependencies.provisioners[vendor];
      const { region } = await provisioner.locateAccount({ credential });

      const stored = await this.dependencies.connections.find(input);
      const previous = stored?.vendor === vendor ? stored : null;
      if (previous && previous.region !== region) {
        this.dependencies.logger.warn(
          { workspaceId, agentId, vendor, previousRegion: previous.region, region, vendorAgentId: previous.vendorAgentId },
          "Voice runtime key belongs to another region now; creating a vendor agent there and leaving the old one",
        );
      }
      const kept = previous && previous.region === region ? previous : null;
      const reusable = kept?.channelCredentialId
        ? await this.dependencies.channelCredentials.isActive({ workspaceId, agentId, credentialId: kept.channelCredentialId })
        : false;
      const spec: VoiceRuntimeAgentSpec = {
        displayName: profile.name,
        completionsBaseUrl: completionsAddress({ agentId, vendor }),
        primaryLocale: profile.defaultLocale,
      };

      const { ensured, minted } = await this.ensureAgent({ ...input, provisioner, region, credential, spec, kept, reusable });
      const channelCredentialId = minted?.credentialId ?? kept?.channelCredentialId ?? null;
      const connection: VoiceRuntimeConnection = { workspaceId, agentId, vendor, region, vendorAgentId: ensured.vendorAgentId, channelCredentialId };
      try {
        await this.dependencies.connections.save(connection);
      } catch (error) {
        // The vendor agent now holds the minted credential, so it stays unless that agent goes:
        // only an agent this attempt created, and could delete again, gives it up.
        const released = ensured.outcome === "created" && await this.releaseQuietly(connection, credential);
        if (minted && released) await this.revokeQuietly({ ...input, credentialId: minted.credentialId });
        throw error;
      }
      // The saved row makes the minted credential the connection's, so the one it replaced goes
      // now: a binding that fails below would otherwise lose its id with it still active.
      const replaced = previous?.channelCredentialId;
      if (minted && replaced && replaced !== minted.credentialId) await this.revokeQuietly({ ...input, credentialId: replaced });
      const runtime: VoiceRuntimeBinding = { vendor, agentId: ensured.vendorAgentId, region };
      await this.dependencies.binder.bind({ workspaceId, agentId, runtime });

      if (!ensured.primaryLocaleSupported) {
        this.dependencies.logger.warn(
          { workspaceId, agentId, vendor, defaultLocale: profile.defaultLocale },
          "Voice runtime vendor speaks no language of the agent's default locale; calls start in English",
        );
      }
      await this.dependencies.audit.connected({
        accountId: actor.accountId,
        workspaceId,
        agentId,
        vendor,
        region,
        outcome: ensured.outcome,
        credential: minted ? "issued" : "reused",
      });
      this.dependencies.logger.info(
        { workspaceId, agentId, vendor, region, operation: "connect", outcome: ensured.outcome, credential: minted ? "issued" : "reused" },
        "Voice runtime connected",
      );
      this.record(vendor, "connect", ensured.outcome);
      return this.statusOf(workspaceId, runtime, connection);
    } catch (error) {
      const failure = failureOf(error);
      this.dependencies.logger.warn(
        { workspaceId, agentId, vendor, operation: "connect", outcome: failure ?? "error", ...vendorErrorFields(error) },
        "Voice runtime connect failed",
      );
      this.record(vendor, "connect", failure ?? "error");
      throw failure && !(error instanceof VoiceRuntimeConnectionError) ? new VoiceRuntimeConnectionError(failure) : error;
    }
  }

  async disconnect(input: AgentRef & { actor: VoiceRuntimeConnectionActor }): Promise<VoiceRuntimeDisconnection> {
    const { workspaceId, agentId, actor } = input;
    const profile = await this.requireProfile(input);
    const connection = await this.dependencies.connections.find(input);
    const vendor = profile.runtime?.vendor ?? connection?.vendor ?? CONNECT_VENDOR;
    if (!connection && !profile.runtime) return { ...await this.statusOf(workspaceId, null, null), vendorAgentLeft: false };

    const released = connection ? await this.forget(connection, actor) : false;
    const vendorAgentLeft = connection !== null && !released;
    if (profile.runtime) await this.dependencies.binder.bind({ workspaceId, agentId, runtime: null });
    await this.dependencies.audit.disconnected({
      accountId: actor.accountId,
      workspaceId,
      agentId,
      vendor,
      region: connection?.region ?? profile.runtime?.region ?? null,
      released,
      vendorAgentLeft,
      cause: "operator",
    });
    const outcome: ConnectionOutcome = vendorAgentLeft ? "vendor_agent_left" : released ? "released" : "unbound";
    this.dependencies.logger.info({ workspaceId, agentId, vendor, operation: "disconnect", outcome }, "Voice runtime disconnected");
    this.record(vendor, "disconnect", outcome);
    return { ...await this.statusOf(workspaceId, null, null), vendor, vendorAgentLeft };
  }

  /**
   * Sets the vendor agent Radioso maintains up again after the agent's default locale changed, so
   * calls start in the new language. Never rejects: a sync that fails is logged and counted, and
   * Connect repairs it. It mints nothing: a vendor agent that is gone needs Connect.
   */
  async syncPrimaryLanguage(agent: AgentRef): Promise<void> {
    const { workspaceId, agentId } = agent;
    let vendor: VoiceVendor = CONNECT_VENDOR;
    const warn = (outcome: ConnectionOutcome, fields: Record<string, unknown> = {}) => {
      this.dependencies.logger.warn({ workspaceId, agentId, vendor, operation: "sync", outcome, ...fields }, "Voice runtime language sync failed");
      this.record(vendor, "sync", outcome);
    };
    try {
      const connection = await this.dependencies.connections.find(agent);
      if (!connection) return;
      vendor = connection.vendor;
      const profile = await this.dependencies.agents.findRuntimeProfile(agent);
      if (!profile || !isMaintained(profile.runtime, connection)) return;
      const completionsAddress = this.dependencies.completionsAddress;
      if (!completionsAddress) return warn("connection_unavailable");
      const reading = await this.dependencies.credentials.read({ workspaceId, vendor });
      if (reading.kind !== "present") return warn(reading.kind === "missing" ? "vendor_key_missing" : "vendor_key_unreadable");
      const ensured = await this.dependencies.provisioners[vendor].ensureAgent({
        region: connection.region,
        credential: reading.credential,
        spec: { displayName: profile.name, completionsBaseUrl: completionsAddress({ agentId, vendor }), primaryLocale: profile.defaultLocale },
        vendorAgentId: connection.vendorAgentId,
        bearer: null,
      });
      if (ensured.outcome === "needs_bearer") return warn("needs_connect");
      this.dependencies.logger.info({ workspaceId, agentId, vendor, operation: "sync", outcome: "synced" }, "Voice runtime language synced");
      this.record(vendor, "sync", "synced");
    } catch (error) {
      warn(failureOf(error) ?? "error", vendorErrorFields(error));
    }
  }

  /**
   * Deletes the vendor agent Radioso created for an agent about to be deleted, and revokes its
   * credential, so neither outlives the agent. Never rejects: the deletion goes on whatever happens
   * here, and a vendor agent left behind is logged.
   */
  async releaseForDeletedAgent(agent: AgentRef): Promise<void> {
    const { workspaceId, agentId } = agent;
    try {
      const connection = await this.dependencies.connections.find(agent);
      if (!connection) return;
      const released = await this.forget(connection, { accountId: null, userId: null });
      await this.dependencies.audit.disconnected({
        accountId: null,
        workspaceId,
        agentId,
        vendor: connection.vendor,
        region: connection.region,
        released,
        vendorAgentLeft: !released,
        cause: "agent_deleted",
      });
      this.record(connection.vendor, "agent_deleted", released ? "released" : "vendor_agent_left");
    } catch (error) {
      this.dependencies.logger.warn(
        { workspaceId, agentId, operation: "agent_deleted", outcome: "error", errorClass: errorClassOf(error) },
        "Voice runtime release before agent deletion failed",
      );
      this.record(CONNECT_VENDOR, "agent_deleted", "error");
    }
  }

  /**
   * Creates or repairs the vendor agent with the credential it should carry: the kept one while it
   * works, else one minted here. A credential minted for a vendor call that fails is revoked again:
   * no vendor agent holds it.
   */
  private async ensureAgent(input: AgentRef & {
    actor: VoiceRuntimeConnectionActor;
    provisioner: VoiceRuntimeProvisioner;
    region: VoiceVendorRegion;
    credential: VoiceVendorCredential;
    spec: VoiceRuntimeAgentSpec;
    kept: VoiceRuntimeConnection | null;
    reusable: boolean;
  }): Promise<{ ensured: Extract<VoiceRuntimeAgentEnsured, { vendorAgentId: string }>; minted: { credentialId: string } | null }> {
    const { provisioner, region, credential, spec, kept } = input;
    const issued: { credential: { credentialId: string; secret: string } | null } = { credential: null };
    const mint = async (): Promise<string> => {
      issued.credential = await this.dependencies.channelCredentials.issue({ workspaceId: input.workspaceId, agentId: input.agentId, actor: input.actor });
      return issued.credential.secret;
    };
    try {
      let ensured = kept
        ? await provisioner.ensureAgent({ region, credential, spec, vendorAgentId: kept.vendorAgentId, bearer: input.reusable ? null : await mint() })
        : await provisioner.ensureAgent({ region, credential, spec, vendorAgentId: null, bearer: await mint() });
      if (ensured.outcome === "needs_bearer" && kept && !issued.credential) {
        ensured = await provisioner.ensureAgent({ region, credential, spec, vendorAgentId: kept.vendorAgentId, bearer: await mint() });
      }
      if (ensured.outcome === "needs_bearer") throw new VoiceRuntimeConnectionError("vendor_failed");
      return { ensured, minted: issued.credential ? { credentialId: issued.credential.credentialId } : null };
    } catch (error) {
      if (issued.credential) await this.revokeQuietly({ ...input, credentialId: issued.credential.credentialId });
      throw error;
    }
  }

  /**
   * Releases the connection's vendor agent, revokes its credential and drops the record. True when
   * the vendor agent is gone; false when it may still be there (no key to ask with, or the vendor
   * did not delete it), which is logged.
   */
  private async forget(connection: VoiceRuntimeConnection, actor: VoiceRuntimeConnectionActor): Promise<boolean> {
    const { workspaceId, agentId, vendor } = connection;
    const reading = await this.dependencies.credentials.read({ workspaceId, vendor }).catch(() => ({ kind: "unreadable" as const }));
    let released = false;
    if (reading.kind === "present") {
      released = await this.releaseQuietly(connection, reading.credential);
    } else {
      this.dependencies.logger.warn(
        { workspaceId, agentId, vendor, region: connection.region, vendorAgentId: connection.vendorAgentId, credential: reading.kind },
        "Voice runtime vendor agent left at the vendor: no key to delete it with",
      );
    }
    if (connection.channelCredentialId) await this.revokeQuietly({ workspaceId, agentId, actor, credentialId: connection.channelCredentialId });
    await this.dependencies.connections.remove(connection);
    return released;
  }

  private async releaseQuietly(connection: VoiceRuntimeConnection, credential: VoiceVendorCredential): Promise<boolean> {
    const { workspaceId, agentId, vendor, region, vendorAgentId } = connection;
    try {
      await this.dependencies.provisioners[vendor].releaseAgent({ region, credential, vendorAgentId });
      return true;
    } catch (error) {
      this.dependencies.logger.warn(
        { workspaceId, agentId, vendor, region, vendorAgentId, ...vendorErrorFields(error) },
        "Voice runtime vendor agent left at the vendor: deleting it failed",
      );
      return false;
    }
  }

  /** A credential that cannot be revoked now is logged; it admits only this agent's turns. */
  private async revokeQuietly(input: AgentRef & { actor: VoiceRuntimeConnectionActor; credentialId: string }): Promise<void> {
    try {
      await this.dependencies.channelCredentials.revoke({ credentialId: input.credentialId, actor: input.actor });
    } catch (error) {
      this.dependencies.logger.warn(
        { workspaceId: input.workspaceId, agentId: input.agentId, credentialId: input.credentialId, errorClass: errorClassOf(error) },
        "Voice runtime credential could not be revoked",
      );
    }
  }

  private async requireProfile(agent: AgentRef) {
    const profile = await this.dependencies.agents.findRuntimeProfile(agent);
    if (!profile) throw new VoiceRuntimeConnectionError("agent_not_found");
    return profile;
  }

  private async requireCredential(workspaceId: string, vendor: VoiceVendor): Promise<VoiceVendorCredential> {
    const reading = await this.dependencies.credentials.read({ workspaceId, vendor });
    if (reading.kind === "missing") throw new VoiceRuntimeConnectionError("vendor_key_missing");
    if (reading.kind === "unreadable") throw new VoiceRuntimeConnectionError("vendor_key_unreadable");
    return reading.credential;
  }

  private async statusOf(
    workspaceId: string,
    runtime: VoiceRuntimeBinding | null,
    connection: VoiceRuntimeConnection | null,
  ): Promise<VoiceRuntimeConnectionStatus> {
    const vendor = runtime?.vendor ?? connection?.vendor ?? CONNECT_VENDOR;
    const vendorKey = await this.dependencies.credentials.presence({ workspaceId, vendor });
    return {
      vendor,
      state: runtime === null ? "not_connected" : isMaintained(runtime, connection) ? "connected" : "connected_externally",
      region: runtime?.region ?? null,
      vendorKey,
      connectAvailable: this.dependencies.completionsAddress !== null,
      runtime,
    };
  }

  /** Labels are closed values: the vendor, the operation and how it ended. */
  private record(vendor: VoiceVendor, operation: ConnectionOperation, outcome: ConnectionOutcome): void {
    this.dependencies.metrics?.incrementCounter("voice_runtime_connection_total", {
      help: "Voice runtime connection operations, by vendor, operation and how each ended",
      labels: { vendor, operation, outcome },
    });
  }
}
