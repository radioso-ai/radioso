import type { VoiceVendor, VoiceVendorRegion } from "../../shared/domain/voiceVendor.js";

import type { AgentVoiceSettings } from "../agents/public.js";

/**
 * What the agent's Voice card and the website widget's calls switch ask of an agent's voice
 * runtime connection: where it stands, Connect, Disconnect and the voice channel switch, and the
 * closed ways each can fail. The ports Connect runs on stay in `domain.ts`.
 */

/** The agent's runtime binding as its `voice` block stores it. */
export type VoiceRuntimeBinding = NonNullable<AgentVoiceSettings["runtime"]>;

/**
 * Whether the workspace stores a key for a vendor, without decrypting it: `unreadable` is a key
 * stored while the backend has no master key to decrypt it with.
 */
export type VoiceVendorCredentialPresence = "stored" | "missing" | "unreadable";

/** Who connected or disconnected the runtime, for the credential's lifecycle record and the audit trail. */
export interface VoiceRuntimeConnectionActor {
  accountId: string | null;
  userId: string | null;
}

/**
 * Where an agent's voice runtime stands. `connected`: the binding is a vendor agent Radioso created
 * and maintains. `connected_externally`: the binding names a vendor agent set up outside Radioso.
 */
export const VOICE_RUNTIME_CONNECTION_STATES = ["not_connected", "connected", "connected_externally"] as const;

export type VoiceRuntimeConnectionState = (typeof VOICE_RUNTIME_CONNECTION_STATES)[number];

/**
 * An agent's voice runtime as the Voice card shows it. `region` is the bound vendor account's.
 * `vendorKey` is the presence of the workspace's key for `vendor`. `connectAvailable` is false
 * when the deployment has no public origin a vendor can reach. `runtime` and `enabled` are the
 * agent's binding and voice channel switch as stored, so a dashboard form can carry them on its
 * next save.
 */
export interface VoiceRuntimeConnectionStatus {
  vendor: VoiceVendor;
  state: VoiceRuntimeConnectionState;
  region: VoiceVendorRegion | null;
  vendorKey: VoiceVendorCredentialPresence;
  connectAvailable: boolean;
  runtime: VoiceRuntimeBinding | null;
  enabled: boolean;
}

/** The status after a disconnect, and whether the vendor agent Radioso created may still be at the vendor. */
export type VoiceRuntimeDisconnection = VoiceRuntimeConnectionStatus & { vendorAgentLeft: boolean };

/**
 * Why a Connect or Disconnect did not finish, as closed codes the HTTP layer maps to its answers.
 * `connection_busy`: another change of the agent's connection was running, so this one ran nothing.
 */
export const VOICE_RUNTIME_CONNECTION_FAILURES = [
  "agent_not_found",
  "connection_busy",
  "connection_unavailable",
  "vendor_key_missing",
  "vendor_key_unreadable",
  "vendor_key_rejected",
  "vendor_key_lacks_agents_permission",
  "vendor_unreachable",
  "vendor_failed",
] as const;

export type VoiceRuntimeConnectionFailure = (typeof VOICE_RUNTIME_CONNECTION_FAILURES)[number];

export class VoiceRuntimeConnectionError extends Error {
  constructor(readonly reason: VoiceRuntimeConnectionFailure) {
    super(`Voice runtime connection failed: ${reason}`);
    this.name = new.target.name;
  }
}

/** What the agent's Voice card asks of its runtime connection. */
export interface VoiceRuntimeConnectionPort {
  status(agent: { workspaceId: string; agentId: string }): Promise<VoiceRuntimeConnectionStatus>;
  /** Creates or repairs the vendor agent and binds it. Rejects with `VoiceRuntimeConnectionError`. */
  connect(input: { workspaceId: string; agentId: string; actor: VoiceRuntimeConnectionActor }): Promise<VoiceRuntimeConnectionStatus>;
  /**
   * Unbinds the runtime, and removes the vendor agent when Radioso created it. Rejects with
   * `VoiceRuntimeConnectionError` only for an agent that does not exist, or while another change of
   * its connection runs.
   */
  disconnect(input: { workspaceId: string; agentId: string; actor: VoiceRuntimeConnectionActor }): Promise<VoiceRuntimeDisconnection>;
  /**
   * The agent's voice channel switch. On connects first, as Connect does, when no runtime is bound;
   * off keeps the runtime and its vendor agent. Rejects with `VoiceRuntimeConnectionError`.
   */
  switchChannel(input: {
    workspaceId: string;
    agentId: string;
    actor: VoiceRuntimeConnectionActor;
    enabled: boolean;
  }): Promise<VoiceRuntimeConnectionStatus>;
}
