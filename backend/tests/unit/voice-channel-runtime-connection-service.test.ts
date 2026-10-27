import { describe, expect, it, vi } from "vitest";

import {
  VoiceRuntimeConnectionError,
  VoiceVendorRequestError,
  type VoiceRuntimeAgentEnsured,
  type VoiceRuntimeBinding,
  type VoiceRuntimeConnection,
  type VoiceRuntimeProvisioner,
  type VoiceVendorCredentialReading,
} from "../../src/modules/voiceChannel/domain.js";
import { VoiceRuntimeConnectionService } from "../../src/modules/voiceChannel/services/voiceRuntimeConnectionService.js";

const workspaceId = "6c3b6f1e-6d0e-4a54-9c34-2d0a1a5e8b11";
const agentId = "7f0c2a8e-5b1d-4c47-9a1e-0d6b2f7c9e41";
const agent = { workspaceId, agentId };
const actor = { accountId: "acc-1", userId: "user-1" };
const apiKey = "xi-secret-0123456789";
const completionsBaseUrl = `https://api.example.com/api/v1/agents/${agentId}/voice/elevenlabs/v1`;

type Profile = { name: string; defaultLocale: string | null; runtime: VoiceRuntimeBinding | null };

interface Setup {
  profile?: Profile | null;
  connection?: VoiceRuntimeConnection | null;
  reading?: VoiceVendorCredentialReading;
  region?: "us" | "eu" | "in" | "sg";
  locateError?: Error;
  ensure?: (input: Parameters<VoiceRuntimeProvisioner["ensureAgent"]>[0]) => Promise<VoiceRuntimeAgentEnsured>;
  releaseError?: Error;
  /** Holds every release until it resolves. */
  releaseGate?: Promise<void>;
  activeCredentials?: string[];
  /** Credentials still active, but rotated since the vendor was handed their secret. */
  rotatedCredentials?: string[];
  completions?: boolean;
  saveError?: Error;
  /** How many saves fail with `saveError`; every one when unset. */
  saveFailures?: number;
  bindError?: Error;
  /** Another Connect or Disconnect of the agent holds its connection lock. */
  lockHeld?: boolean;
}

/** The fingerprint of the secret a credential was issued with. */
const fingerprintOf = (credentialId: string): string => `fp-${credentialId}`;

/** Every port as an in-memory fake that records what the service asked of it, in order. */
const serviceWith = (setup: Setup = {}) => {
  const steps: string[] = [];
  let profile = setup.profile === undefined ? { name: "Front desk", defaultLocale: "it", runtime: null } : setup.profile;
  let connection = setup.connection ?? null;
  /** Each active credential by id, with the fingerprint of its current secret. */
  const active = new Map<string, string>([
    ...(setup.activeCredentials ?? []).map((id) => [id, fingerprintOf(id)] as const),
    ...(setup.rotatedCredentials ?? []).map((id) => [id, `${fingerprintOf(id)}-rotated`] as const),
  ]);
  let issued = 0;
  let saveFailures = setup.saveFailures ?? Number.POSITIVE_INFINITY;
  const provisioner = {
    locateAccount: vi.fn<VoiceRuntimeProvisioner["locateAccount"]>(async () => {
      steps.push("locate");
      if (setup.locateError) throw setup.locateError;
      return { region: setup.region ?? "eu" };
    }),
    ensureAgent: vi.fn<VoiceRuntimeProvisioner["ensureAgent"]>(async (input) => {
      steps.push(`ensure:${input.vendorAgentId ?? "new"}:${input.bearer ?? "kept"}`);
      if (setup.ensure) return setup.ensure(input);
      return input.vendorAgentId === null
        ? { outcome: "created", vendorAgentId: "agent_new", primaryLocaleSupported: true }
        : { outcome: "repaired", vendorAgentId: input.vendorAgentId, primaryLocaleSupported: true };
    }),
    releaseAgent: vi.fn<VoiceRuntimeProvisioner["releaseAgent"]>(async (input) => {
      steps.push(`release:${input.vendorAgentId}`);
      await setup.releaseGate;
      if (setup.releaseError) throw setup.releaseError;
    }),
  };
  const audit = { connected: vi.fn(async () => undefined), disconnected: vi.fn(async () => undefined) };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const metrics = { incrementCounter: vi.fn() };
  /** Every step taken while the agent's connection lock was held, by the operation that held it. */
  const held: string[] = [];
  let holding = false;
  const lock = {
    run: async <T,>(_agent: { workspaceId: string; agentId: string }, work: () => Promise<T>) => {
      if (setup.lockHeld || holding) return { ran: false as const };
      holding = true;
      const before = steps.length;
      try {
        return { ran: true as const, value: await work() };
      } finally {
        holding = false;
        held.push(...steps.slice(before));
      }
    },
  };
  const service = new VoiceRuntimeConnectionService({
    lock,
    agents: { findRuntimeProfile: async () => profile },
    connections: {
      find: async () => connection,
      save: async (next) => {
        steps.push(`save:${next.vendorAgentId}:${next.channelCredential?.id ?? null}`);
        if (setup.saveError && saveFailures > 0) {
          saveFailures -= 1;
          throw setup.saveError;
        }
        connection = next;
      },
      remove: async () => {
        steps.push("remove");
        connection = null;
      },
    },
    credentials: {
      read: async () => setup.reading ?? { kind: "present", credential: { apiKey } },
      presence: async () => (setup.reading?.kind === "missing" ? "missing" : setup.reading?.kind === "unreadable" ? "unreadable" : "stored"),
    },
    provisioners: { elevenlabs: provisioner },
    channelCredentials: {
      issue: async () => {
        issued += 1;
        const credential = { id: `cred-${issued}`, fingerprint: fingerprintOf(`cred-${issued}`) };
        steps.push(`issue:${credential.id}`);
        active.set(credential.id, credential.fingerprint);
        return { credential, secret: `rk_secret_${issued}` };
      },
      admitsHeldSecret: async ({ credential }) => active.get(credential.id) === credential.fingerprint,
      revoke: async ({ credentialId }) => {
        steps.push(`revoke:${credentialId}`);
        active.delete(credentialId);
      },
    },
    binder: {
      bind: async ({ runtime }) => {
        steps.push(`bind:${runtime ? `${runtime.agentId}@${runtime.region}` : "none"}`);
        if (setup.bindError) throw setup.bindError;
        if (profile) profile = { ...profile, runtime };
      },
    },
    completionsAddress: setup.completions === false ? null : ({ agentId: id, vendor }) => `https://api.example.com/api/v1/agents/${id}/voice/${vendor}/v1`,
    audit,
    metrics,
    logger,
  });
  return {
    service,
    steps,
    held,
    provisioner,
    audit,
    logger,
    metrics,
    connectionNow: () => connection,
    profileNow: () => profile,
    /** The credentials that admit the agent's turns now, by id. */
    activeNow: () => [...active.keys()],
  };
};

const failureOf = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(() => null, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(VoiceRuntimeConnectionError);
  return (error as VoiceRuntimeConnectionError).reason;
};

const managed = (overrides: Partial<VoiceRuntimeConnection> = {}): VoiceRuntimeConnection => ({
  workspaceId,
  agentId,
  vendor: "elevenlabs",
  region: "eu",
  vendorAgentId: "agent_42",
  channelCredential: { id: "cred-old", fingerprint: fingerprintOf("cred-old") },
  ...overrides,
});
const boundTo = (vendorAgentId: string, region: VoiceRuntimeBinding["region"] = "eu"): Profile => ({
  name: "Front desk",
  defaultLocale: "it",
  runtime: { vendor: "elevenlabs", agentId: vendorAgentId, region },
});

describe("voice runtime connection: connect", () => {
  it("mints a credential, creates the vendor agent in the key's region, records it, then binds it", async () => {
    const { service, steps, provisioner, audit, connectionNow } = serviceWith();

    const status = await service.connect({ ...agent, actor });

    expect(steps).toEqual(["locate", "issue:cred-1", "ensure:new:rk_secret_1", "save:agent_new:cred-1", "bind:agent_new@eu"]);
    expect(provisioner.ensureAgent).toHaveBeenCalledWith(expect.objectContaining({
      region: "eu",
      credential: { apiKey },
      spec: { displayName: "Front desk", completionsBaseUrl, primaryLocale: "it" },
    }));
    expect(connectionNow()).toEqual(managed({ vendorAgentId: "agent_new", channelCredential: { id: "cred-1", fingerprint: fingerprintOf("cred-1") } }));
    expect(status).toEqual({
      vendor: "elevenlabs",
      state: "connected",
      region: "eu",
      vendorKey: "stored",
      connectAvailable: true,
      runtime: { vendor: "elevenlabs", agentId: "agent_new", region: "eu" },
    });
    expect(audit.connected).toHaveBeenCalledWith({
      accountId: "acc-1",
      workspaceId,
      agentId,
      vendor: "elevenlabs",
      region: "eu",
      outcome: "created",
      credential: "issued",
    });
  });

  it("repairs the agent it maintains with the credential it holds when that credential still works", async () => {
    const { service, steps, audit } = serviceWith({ connection: managed(), profile: boundTo("agent_42"), activeCredentials: ["cred-old"] });

    const status = await service.connect({ ...agent, actor });

    expect(steps).toEqual(["locate", "ensure:agent_42:kept", "save:agent_42:cred-old", "bind:agent_42@eu"]);
    expect(status.state).toBe("connected");
    expect(audit.connected).toHaveBeenCalledWith(expect.objectContaining({ outcome: "repaired", credential: "reused" }));
  });

  it("binds the agent it maintains again when a whole-block save cleared the binding", async () => {
    const { service, steps } = serviceWith({
      connection: managed(),
      profile: { name: "Front desk", defaultLocale: "it", runtime: null },
      activeCredentials: ["cred-old"],
    });

    const status = await service.connect({ ...agent, actor });

    expect(steps).toEqual(["locate", "ensure:agent_42:kept", "save:agent_42:cred-old", "bind:agent_42@eu"]);
    expect(status.runtime).toEqual({ vendor: "elevenlabs", agentId: "agent_42", region: "eu" });
  });

  it("rotates a revoked credential: the vendor agent gets a new one before the old one is revoked", async () => {
    const { service, steps, audit } = serviceWith({ connection: managed(), profile: boundTo("agent_42"), activeCredentials: [] });

    await service.connect({ ...agent, actor });

    expect(steps).toEqual(["locate", "issue:cred-1", "ensure:agent_42:rk_secret_1", "save:agent_42:cred-1", "revoke:cred-old", "bind:agent_42@eu"]);
    expect(audit.connected).toHaveBeenCalledWith(expect.objectContaining({ outcome: "repaired", credential: "issued" }));
  });

  it("rotates a credential rotated since the vendor got it: the vendor's copy no longer works, so it gets a new one and the old one is revoked", async () => {
    const { service, steps, audit, connectionNow } = serviceWith({ connection: managed(), profile: boundTo("agent_42"), rotatedCredentials: ["cred-old"] });

    await service.connect({ ...agent, actor });

    expect(steps).toEqual(["locate", "issue:cred-1", "ensure:agent_42:rk_secret_1", "save:agent_42:cred-1", "revoke:cred-old", "bind:agent_42@eu"]);
    expect(connectionNow()?.channelCredential).toEqual({ id: "cred-1", fingerprint: fingerprintOf("cred-1") });
    expect(audit.connected).toHaveBeenCalledWith(expect.objectContaining({ outcome: "repaired", credential: "issued" }));
  });

  it("mints a credential and asks again when the vendor agent it maintains is gone", async () => {
    const { service, steps } = serviceWith({
      connection: managed(),
      profile: boundTo("agent_42"),
      activeCredentials: ["cred-old"],
      ensure: async (input) => (input.bearer === null
        ? { outcome: "needs_bearer" }
        : { outcome: "created", vendorAgentId: "agent_new", primaryLocaleSupported: true }),
    });

    const status = await service.connect({ ...agent, actor });

    expect(steps).toEqual([
      "locate",
      "ensure:agent_42:kept",
      "issue:cred-1",
      "ensure:agent_42:rk_secret_1",
      "save:agent_new:cred-1",
      "revoke:cred-old",
      "bind:agent_new@eu",
    ]);
    expect(status.runtime?.agentId).toBe("agent_new");
  });

  it("creates a new vendor agent in the new region when the key now belongs to another region's account, and cuts the old one off", async () => {
    const { service, steps, logger } = serviceWith({ connection: managed({ region: "us" }), profile: boundTo("agent_42", "us"), activeCredentials: ["cred-old"], region: "eu" });

    const status = await service.connect({ ...agent, actor });

    expect(steps).toEqual(["locate", "issue:cred-1", "ensure:new:rk_secret_1", "save:agent_new:cred-1", "revoke:cred-old", "bind:agent_new@eu"]);
    expect(status.region).toBe("eu");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, agentId, vendor: "elevenlabs", previousRegion: "us", region: "eu" }),
      expect.any(String),
    );
  });

  it("revokes the credential it minted when the vendor refuses the agent, and records nothing", async () => {
    const { service, steps, audit } = serviceWith({ ensure: async () => { throw new VoiceVendorRequestError("refused", 422); } });

    expect(await failureOf(service.connect({ ...agent, actor }))).toBe("vendor_failed");
    expect(steps).toEqual(["locate", "issue:cred-1", "ensure:new:rk_secret_1", "revoke:cred-1"]);
    expect(audit.connected).not.toHaveBeenCalled();
  });

  it("releases the vendor agent it created and revokes the credential when the connection cannot be recorded", async () => {
    const { service, steps, logger } = serviceWith({ saveError: new Error("database down") });

    await expect(service.connect({ ...agent, actor })).rejects.toThrow("database down");
    expect(steps).toEqual(["locate", "issue:cred-1", "ensure:new:rk_secret_1", "save:agent_new:cred-1", "release:agent_new", "revoke:cred-1"]);
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, agentId, vendor: "elevenlabs", region: "eu", vendorAgentId: "agent_new", outcome: "created", cleanup: "vendor_agent_deleted", errorClass: "Error" },
      "Voice runtime connection could not be recorded",
    );
  });

  it("revokes the credential a repair gave the vendor agent and the one the record names when the repair cannot be recorded", async () => {
    const { service, steps, logger, connectionNow, activeNow } = serviceWith({
      connection: managed(),
      profile: boundTo("agent_42"),
      rotatedCredentials: ["cred-old"],
      saveError: new Error("database down"),
    });

    await expect(service.connect({ ...agent, actor })).rejects.toThrow("database down");

    expect(steps).toEqual(["locate", "issue:cred-1", "ensure:agent_42:rk_secret_1", "save:agent_42:cred-1", "revoke:cred-1", "revoke:cred-old"]);
    // Nothing minted is left admitting turns untracked; the record still names the old credential.
    expect(activeNow()).toEqual([]);
    expect(connectionNow()).toEqual(managed());
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, agentId, vendor: "elevenlabs", region: "eu", vendorAgentId: "agent_42", outcome: "repaired", cleanup: "credentials_revoked", errorClass: "Error" },
      "Voice runtime connection could not be recorded",
    );
  });

  it("gives the vendor agent a fresh credential on the Connect after a repair that could not be recorded", async () => {
    const { service, steps, connectionNow, activeNow } = serviceWith({
      connection: managed(),
      profile: boundTo("agent_42"),
      activeCredentials: ["cred-old"],
      ensure: async (input) => (input.bearer === null
        ? { outcome: "needs_bearer" }
        : { outcome: "repaired", vendorAgentId: "agent_42", primaryLocaleSupported: true }),
      saveError: new Error("database down"),
      saveFailures: 1,
    });
    await expect(service.connect({ ...agent, actor })).rejects.toThrow("database down");
    steps.length = 0;

    await service.connect({ ...agent, actor });

    expect(steps).toEqual(["locate", "issue:cred-2", "ensure:agent_42:rk_secret_2", "save:agent_42:cred-2", "revoke:cred-old", "bind:agent_42@eu"]);
    expect(connectionNow()?.channelCredential?.id).toBe("cred-2");
    expect(activeNow()).toEqual(["cred-2"]);
  });

  it("leaves the credentials alone when a repair that minted nothing cannot be recorded", async () => {
    const { service, steps, logger } = serviceWith({ connection: managed(), profile: boundTo("agent_42"), activeCredentials: ["cred-old"], saveError: new Error("database down") });

    await expect(service.connect({ ...agent, actor })).rejects.toThrow("database down");

    expect(steps).toEqual(["locate", "ensure:agent_42:kept", "save:agent_42:cred-old"]);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "repaired", cleanup: "none" }), "Voice runtime connection could not be recorded");
  });

  it("revokes the credential it minted for a vendor agent it created even when deleting that vendor agent also fails, so nothing is left active and untracked", async () => {
    const { service, steps, logger, activeNow } = serviceWith({
      saveError: new Error("database down"),
      releaseError: new VoiceVendorRequestError("unreachable", 503),
    });

    await expect(service.connect({ ...agent, actor })).rejects.toThrow("database down");
    expect(steps).toEqual(["locate", "issue:cred-1", "ensure:new:rk_secret_1", "save:agent_new:cred-1", "release:agent_new", "revoke:cred-1"]);
    expect(activeNow()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ vendorAgentId: "agent_new" }), "Voice runtime vendor agent left at the vendor: deleting it failed");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ vendorAgentId: "agent_new", outcome: "created", cleanup: "vendor_agent_left" }),
      "Voice runtime connection could not be recorded",
    );
  });

  it("revokes the credential it replaced as soon as the new one is recorded, before binding, so a binding that fails loses nothing", async () => {
    const { service, steps } = serviceWith({ connection: managed(), profile: boundTo("agent_42"), activeCredentials: [], bindError: new Error("agent write failed") });

    await expect(service.connect({ ...agent, actor })).rejects.toThrow("agent write failed");
    expect(steps).toEqual(["locate", "issue:cred-1", "ensure:agent_42:rk_secret_1", "save:agent_42:cred-1", "revoke:cred-old", "bind:agent_42@eu"]);
  });

  it("lets Radioso take over a runtime the operator bound by hand with a vendor agent of its own, leaving theirs alone", async () => {
    const { service, steps, provisioner } = serviceWith({ profile: boundTo("agent_theirs") });

    const status = await service.connect({ ...agent, actor });

    expect(steps).toEqual(["locate", "issue:cred-1", "ensure:new:rk_secret_1", "save:agent_new:cred-1", "bind:agent_new@eu"]);
    expect(provisioner.releaseAgent).not.toHaveBeenCalled();
    expect(status.state).toBe("connected");
  });

  it.each([
    [{ kind: "missing" } as const, "vendor_key_missing"],
    [{ kind: "unreadable" } as const, "vendor_key_unreadable"],
  ])("refuses to connect without a readable vendor key (%o)", async (reading, reason) => {
    const { service, steps } = serviceWith({ reading });

    expect(await failureOf(service.connect({ ...agent, actor }))).toBe(reason);
    expect(steps).toEqual([]);
  });

  it("refuses to connect on a deployment with no public origin the vendor can reach, before reading the key", async () => {
    const { service, steps } = serviceWith({ completions: false });

    expect(await failureOf(service.connect({ ...agent, actor }))).toBe("connection_unavailable");
    expect(steps).toEqual([]);
  });

  it.each([
    ["rejected", "vendor_key_rejected"],
    ["insufficient_permissions", "vendor_key_lacks_agents_permission"],
    ["unreachable", "vendor_unreachable"],
    ["timeout", "vendor_unreachable"],
    ["malformed_response", "vendor_failed"],
  ] as const)("names a %s key check for the operator", async (reason, failure) => {
    const { service, steps, metrics } = serviceWith({ locateError: new VoiceVendorRequestError(reason, 401) });

    expect(await failureOf(service.connect({ ...agent, actor }))).toBe(failure);
    expect(steps).toEqual(["locate"]);
    expect(metrics.incrementCounter).toHaveBeenCalledWith("voice_runtime_connection_total", expect.objectContaining({
      labels: { vendor: "elevenlabs", operation: "connect", outcome: failure },
    }));
  });

  it("refuses an agent that does not exist", async () => {
    const { service } = serviceWith({ profile: null });

    expect(await failureOf(service.connect({ ...agent, actor }))).toBe("agent_not_found");
  });

  it("logs ids and closed codes, never the key, the credential's secret or the vendor URL", async () => {
    const { service, logger } = serviceWith();

    await service.connect({ ...agent, actor });
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]);

    expect(logged).not.toContain(apiKey);
    expect(logged).not.toContain("rk_secret");
    expect(logged).not.toContain("https://");
  });

  it("warns when the vendor speaks no language of the agent's default locale", async () => {
    const { service, logger } = serviceWith({ ensure: async () => ({ outcome: "created", vendorAgentId: "agent_new", primaryLocaleSupported: false }) });

    await service.connect({ ...agent, actor });

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ agentId, defaultLocale: "it" }), expect.any(String));
  });
});

describe("voice runtime connection: status", () => {
  it.each([
    ["no runtime", null, null, "not_connected"],
    ["a runtime Radioso maintains", managed(), boundTo("agent_42"), "connected"],
    ["a runtime the operator bound by hand", null, boundTo("agent_theirs"), "connected_externally"],
    ["a runtime rebound by hand away from the one Radioso maintains", managed(), boundTo("agent_theirs"), "connected_externally"],
  ] as const)("reads %s", async (_label, connection, profile, state) => {
    const { service } = serviceWith({ connection, profile: profile ?? { name: "Front desk", defaultLocale: null, runtime: null } });

    expect((await service.status(agent)).state).toBe(state);
  });

  it("says when the key is missing and when the deployment cannot connect", async () => {
    const { service } = serviceWith({ reading: { kind: "missing" }, completions: false });

    expect(await service.status(agent)).toEqual({
      vendor: "elevenlabs",
      state: "not_connected",
      region: null,
      vendorKey: "missing",
      connectAvailable: false,
      runtime: null,
    });
  });
});

describe("voice runtime connection: disconnect", () => {
  it("deletes the vendor agent Radioso created, revokes its credential, forgets it, then unbinds", async () => {
    const { service, steps, audit, connectionNow } = serviceWith({ connection: managed(), profile: boundTo("agent_42"), activeCredentials: ["cred-old"] });

    const result = await service.disconnect({ ...agent, actor });

    expect(steps).toEqual(["release:agent_42", "revoke:cred-old", "remove", "bind:none"]);
    expect(connectionNow()).toBeNull();
    expect(result).toMatchObject({ state: "not_connected", runtime: null, vendorAgentLeft: false });
    expect(audit.disconnected).toHaveBeenCalledWith({
      accountId: "acc-1",
      workspaceId,
      agentId,
      vendor: "elevenlabs",
      region: "eu",
      released: true,
      vendorAgentLeft: false,
      cause: "operator",
    });
  });

  it("only unbinds a runtime the operator bound by hand, and never deletes a vendor agent Radioso did not create", async () => {
    const { service, steps, provisioner } = serviceWith({ profile: boundTo("agent_theirs") });

    const result = await service.disconnect({ ...agent, actor });

    expect(steps).toEqual(["bind:none"]);
    expect(provisioner.releaseAgent).not.toHaveBeenCalled();
    expect(result.vendorAgentLeft).toBe(false);
  });

  it("still unbinds and revokes when the vendor is down, and says the vendor agent was left", async () => {
    const { service, steps, logger } = serviceWith({
      connection: managed(),
      profile: boundTo("agent_42"),
      releaseError: new VoiceVendorRequestError("unreachable", 503),
    });

    const result = await service.disconnect({ ...agent, actor });

    expect(steps).toEqual(["release:agent_42", "revoke:cred-old", "remove", "bind:none"]);
    expect(result.vendorAgentLeft).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ vendorAgentId: "agent_42", reason: "unreachable" }), expect.any(String));
  });

  it("still unbinds when the key is gone, and says the vendor agent was left", async () => {
    const { service, steps } = serviceWith({ connection: managed(), profile: boundTo("agent_42"), reading: { kind: "missing" } });

    const result = await service.disconnect({ ...agent, actor });

    expect(steps).toEqual(["revoke:cred-old", "remove", "bind:none"]);
    expect(result.vendorAgentLeft).toBe(true);
  });

  it("removes the vendor agent Radioso created even when the operator has since bound another by hand", async () => {
    const { service, steps } = serviceWith({ connection: managed(), profile: boundTo("agent_theirs") });

    await service.disconnect({ ...agent, actor });

    expect(steps).toEqual(["release:agent_42", "revoke:cred-old", "remove", "bind:none"]);
  });

  it("logs and counts a Disconnect that fails, naming the agent, and lets the failure through", async () => {
    const { service, logger, metrics } = serviceWith({ connection: managed(), profile: boundTo("agent_42"), bindError: new Error("agent write failed") });

    await expect(service.disconnect({ ...agent, actor })).rejects.toThrow("agent write failed");
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, agentId, vendor: "elevenlabs", operation: "disconnect", outcome: "error", errorClass: "Error" },
      "Voice runtime disconnect failed",
    );
    expect(metrics.incrementCounter).toHaveBeenCalledWith("voice_runtime_connection_total", expect.objectContaining({
      labels: { vendor: "elevenlabs", operation: "disconnect", outcome: "error" },
    }));
  });

  it("names the failure of a Disconnect for an agent that does not exist", async () => {
    const { service, logger, metrics } = serviceWith({ profile: null });

    expect(await failureOf(service.disconnect({ ...agent, actor }))).toBe("agent_not_found");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, agentId, operation: "disconnect", outcome: "agent_not_found" }),
      "Voice runtime disconnect failed",
    );
    expect(metrics.incrementCounter).toHaveBeenCalledWith("voice_runtime_connection_total", expect.objectContaining({
      labels: { vendor: "elevenlabs", operation: "disconnect", outcome: "agent_not_found" },
    }));
  });

  it("does nothing for an agent with no runtime and no connection", async () => {
    const { service, steps, audit } = serviceWith();

    expect(await service.disconnect({ ...agent, actor })).toMatchObject({ state: "not_connected", vendorAgentLeft: false });
    expect(steps).toEqual([]);
    expect(audit.disconnected).not.toHaveBeenCalled();
  });
});

describe("voice runtime connection: following the agent", () => {
  it("sets the vendor agent's language again when the default locale of an agent it maintains changes", async () => {
    const { service, steps, provisioner } = serviceWith({ connection: managed(), profile: { ...boundTo("agent_42"), defaultLocale: "pt-BR" } });

    await service.syncPrimaryLanguage(agent);

    expect(steps).toEqual(["ensure:agent_42:kept"]);
    expect(provisioner.ensureAgent).toHaveBeenCalledWith(expect.objectContaining({ region: "eu", spec: expect.objectContaining({ primaryLocale: "pt-BR" }) }));
  });

  it.each([
    ["no connection", null, boundTo("agent_theirs")],
    ["a runtime bound by hand", managed(), boundTo("agent_theirs")],
  ])("leaves an agent with %s alone", async (_label, connection, profile) => {
    const { service, steps } = serviceWith({ connection, profile });

    await service.syncPrimaryLanguage(agent);

    expect(steps).toEqual([]);
  });

  it("never rejects, and logs a sync the vendor refused", async () => {
    const { service, logger } = serviceWith({
      connection: managed(),
      profile: boundTo("agent_42"),
      ensure: async () => { throw new VoiceVendorRequestError("unreachable", 503); },
    });

    await expect(service.syncPrimaryLanguage(agent)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ agentId, operation: "sync", outcome: "vendor_unreachable" }), expect.any(String));
  });

  it("asks for Connect again rather than minting a credential when the vendor agent is gone", async () => {
    const { service, steps, logger } = serviceWith({
      connection: managed(),
      profile: boundTo("agent_42"),
      ensure: async () => ({ outcome: "needs_bearer" }),
    });

    await service.syncPrimaryLanguage(agent);

    expect(steps).toEqual(["ensure:agent_42:kept"]);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ operation: "sync", outcome: "needs_connect" }), expect.any(String));
  });

  it("revokes the credential and forgets the connection before its agent is deleted, then deletes the vendor agent in the background", async () => {
    const { service, steps, audit, connectionNow } = serviceWith({ connection: managed(), profile: boundTo("agent_42") });

    await service.releaseForDeletedAgent(agent);

    expect(steps.slice(0, 2)).toEqual(["revoke:cred-old", "remove"]);
    expect(connectionNow()).toBeNull();
    await vi.waitFor(() => {
      expect(steps).toEqual(["revoke:cred-old", "remove", "release:agent_42"]);
      expect(audit.disconnected).toHaveBeenCalledWith(expect.objectContaining({ cause: "agent_deleted", released: true, vendorAgentLeft: false }));
    });
  });

  it("never makes the deletion wait on the vendor", async () => {
    const { service, steps } = serviceWith({ connection: managed(), profile: boundTo("agent_42"), releaseGate: new Promise<void>(() => {}) });

    await expect(service.releaseForDeletedAgent(agent)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(steps).toEqual(["revoke:cred-old", "remove", "release:agent_42"]));
  });

  it("logs and audits a vendor agent the background release left behind, and never rejects", async () => {
    const { service, audit, logger } = serviceWith({ connection: managed(), profile: boundTo("agent_42"), releaseError: new VoiceVendorRequestError("timeout") });

    await expect(service.releaseForDeletedAgent(agent)).resolves.toBeUndefined();

    await vi.waitFor(() => {
      expect(audit.disconnected).toHaveBeenCalledWith(expect.objectContaining({ cause: "agent_deleted", released: false, vendorAgentLeft: true }));
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ vendorAgentId: "agent_42", reason: "timeout" }), expect.any(String));
    });
  });
});

describe("voice runtime connection: one change at a time per agent", () => {
  it("runs Connect holding the agent's connection lock", async () => {
    const { service, steps, held } = serviceWith();

    await service.connect({ ...agent, actor });

    expect(held).toEqual(steps);
  });

  it("refuses a Connect while another Connect or Disconnect of the agent runs, touching nothing", async () => {
    const { service, steps, metrics } = serviceWith({ lockHeld: true });

    expect(await failureOf(service.connect({ ...agent, actor }))).toBe("connection_busy");
    expect(steps).toEqual([]);
    expect(metrics.incrementCounter).toHaveBeenCalledWith("voice_runtime_connection_total", expect.objectContaining({
      labels: { vendor: "elevenlabs", operation: "connect", outcome: "connection_busy" },
    }));
  });

  it("refuses a Disconnect while another change of the agent runs, touching nothing", async () => {
    const { service, steps } = serviceWith({ connection: managed(), profile: boundTo("agent_42"), lockHeld: true });

    expect(await failureOf(service.disconnect({ ...agent, actor }))).toBe("connection_busy");
    expect(steps).toEqual([]);
  });

  it("runs Disconnect holding the lock", async () => {
    const { service, steps, held } = serviceWith({ connection: managed(), profile: boundTo("agent_42") });

    await service.disconnect({ ...agent, actor });

    expect(held).toEqual(steps);
    expect(steps).toContain("release:agent_42");
  });

  it("lets two Connects started together create one vendor agent: the second is refused", async () => {
    let releaseCreate = () => {};
    const created = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const { service, steps } = serviceWith({
      ensure: async () => {
        await created;
        return { outcome: "created", vendorAgentId: "agent_new", primaryLocaleSupported: true };
      },
    });

    const first = service.connect({ ...agent, actor });
    await vi.waitFor(() => expect(steps).toContain("ensure:new:rk_secret_1"));
    const second = failureOf(service.connect({ ...agent, actor }));
    releaseCreate();

    expect(await second).toBe("connection_busy");
    expect((await first).runtime?.agentId).toBe("agent_new");
    expect(steps.filter((step) => step.startsWith("ensure:"))).toHaveLength(1);
  });

  it("skips a language sync while a Connect or Disconnect holds the agent, and logs it", async () => {
    const { service, steps, logger } = serviceWith({ connection: managed(), profile: boundTo("agent_42"), lockHeld: true });

    await expect(service.syncPrimaryLanguage(agent)).resolves.toBeUndefined();

    expect(steps).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ operation: "sync", outcome: "connection_busy" }), expect.any(String));
  });
});
