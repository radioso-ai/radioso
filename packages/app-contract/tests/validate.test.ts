import { describe, expect, it } from "vitest";

import {
  releaseAValidationPolicy,
  validateManifest,
  type AppManifest,
  type ManifestValidationIssue,
  type ManifestValidationPolicy,
} from "../src/index.js";

const baseManifest = {
  manifestSchemaVersion: 1,
  app: {
    id: "ai.radioso.example",
    name: "Example",
    description: "An example App used to exercise cross-reference validation.",
    publisher: { id: "ai.radioso", name: "Radioso" },
  },
  version: "1.0.0",
  radiosoCompatibility: ">=1.0.0",
  artifact: {
    digest: `sha256:${"0".repeat(64)}`,
    mediaType: "application/vnd.radioso.app.node-bundle.v1+tar",
    entrypoint: "dist/main.js",
  },
  permissions: ["documents.ingest", "documents.delete", "storage.read", "storage.write", "egress.fetch"],
  configuration: {
    fields: [
      { key: "site_url", type: "url", label: "Site URL", required: true },
      { key: "poll_interval_sec", type: "number", label: "Polling interval", required: false, default: 0 },
    ],
  },
  connections: {
    slots: [
      {
        id: "site_credentials",
        kind: "secret_fields",
        displayName: "Site credentials",
        fields: [
          { key: "wp_username", label: "Username", sensitive: false, required: true },
          { key: "wp_application_password", label: "Application password", sensitive: true, required: true },
        ],
      },
      { id: "webhook_secret", kind: "generated_secret", displayName: "Webhook secret" },
    ],
  },
  destinations: [
    {
      id: "site",
      host: { kind: "configuration", field: "site_url" },
      protocols: ["https"],
      purpose: "Read published content from the configured site.",
      dataClasses: ["document_content"],
      connectionSlot: "site_credentials",
    },
  ],
  storageCollections: [
    {
      id: "sync_state",
      scope: "installation",
      schemaVersion: 1,
      compatibleReaderVersions: [1],
      recordSchema: {
        fields: [
          { key: "cursor", type: "string", required: true },
          { key: "updated_at", type: "timestamp", required: true },
          { key: "notes", type: "json", required: false },
        ],
      },
      indexes: [{ id: "by_updated_at", field: "updated_at" }],
      quotas: { maxRecords: 1000, maxRecordBytes: 16384 },
      retention: { kind: "none" },
      allowedOperations: ["get", "put", "delete", "query_by_index"],
    },
  ],
  contributions: [
    {
      id: "site_content",
      kind: "document_source",
      displayName: "Site content",
      description: "Site content published into the workspace.",
      permissions: ["documents.ingest", "documents.delete"],
      egressDestinations: [],
      deadlineMs: 60_000,
      availability: "required",
      externalIdNamespace: "example_post",
      syncModes: ["push", "poll", "backfill"],
      contentFormats: ["html"],
      indexedFieldKeys: [],
      backfill: { checkpointCollection: "sync_state" },
    },
    {
      id: "content_push",
      kind: "external_webhook_handler",
      displayName: "Content push",
      description: "Accepts signed pushes from the site.",
      permissions: ["documents.ingest", "documents.delete"],
      egressDestinations: [],
      deadlineMs: 30_000,
      availability: "required",
      authentication: {
        kind: "hmac_sha256",
        secretConnectionSlot: "webhook_secret",
        signatureHeader: "X-Radioso-Signature",
        signaturePrefix: "sha256=",
      },
      maxBodyBytes: 2_097_152,
      replayWindowSeconds: 300,
    },
    {
      id: "content_poll",
      kind: "scheduled_task",
      displayName: "Content poll",
      description: "Polls the site for changes.",
      permissions: ["documents.ingest", "storage.read", "storage.write", "egress.fetch"],
      egressDestinations: ["site"],
      deadlineMs: 600_000,
      availability: "optional",
      schedule: { kind: "interval_from_configuration", field: "poll_interval_sec", minSeconds: 60 },
      overlapPolicy: "skip",
      maxDurationSeconds: 600,
      retry: { maxAttempts: 5, backoff: { kind: "exponential", baseSeconds: 30, maxSeconds: 900 } },
      checkpointCollection: "sync_state",
    },
  ],
  resourceProfile: { memoryMb: 256, cpuMillis: 1000, maxConcurrentInvocations: 4, scratchMb: 64 },
  conformanceFixtures: [],
};

type MutableManifest = Record<string, unknown>;

const issuesFor = (
  mutate: (manifest: MutableManifest) => void,
  policy: ManifestValidationPolicy = releaseAValidationPolicy,
): ManifestValidationIssue[] => {
  const candidate = structuredClone(baseManifest) as MutableManifest;
  mutate(candidate);
  const result = validateManifest(candidate, policy);
  if (result.ok) return [];
  return result.issues;
};

const contributionsOf = (manifest: MutableManifest): Record<string, unknown>[] =>
  manifest["contributions"] as Record<string, unknown>[];

describe("validateManifest", () => {
  it("accepts a manifest that satisfies every rule and returns the parsed manifest", () => {
    const result = validateManifest(structuredClone(baseManifest), releaseAValidationPolicy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manifest: AppManifest = result.manifest;
    expect(manifest.app.id).toBe("ai.radioso.example");
    expect(manifest.contributions).toHaveLength(3);
  });

  it("reports zod failures under the schema code with a dot and bracket path", () => {
    const issues = issuesFor((manifest) => {
      manifest["manifestSchemaVersion"] = 2;
      contributionsOf(manifest)[1]["maxBodyBytes"] = -1;
    });
    expect(issues.every((issue) => issue.code === "schema")).toBe(true);
    expect(issues.map((issue) => issue.path)).toContain("manifestSchemaVersion");
    expect(issues.map((issue) => issue.path)).toContain("contributions[1].maxBodyBytes");
  });

  it("reports duplicate ids per family", () => {
    const issues = issuesFor((manifest) => {
      const contributions = contributionsOf(manifest);
      contributions.push(structuredClone(contributions[0]));
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: "duplicate_id", path: "contributions[3].id" }),
    ]);
  });

  it("rejects a reserved contribution kind under a policy that excludes it", () => {
    const issues = issuesFor((manifest) => {
      contributionsOf(manifest).push({
        id: "answer_tool",
        kind: "tool",
        displayName: "Answer tool",
        description: "Reserved kind.",
        permissions: [],
        egressDestinations: [],
        deadlineMs: 10_000,
        availability: "optional",
      });
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: "unsupported_contribution_kind", path: "contributions[3].kind" }),
    ]);
  });

  it("rejects a connection kind the policy does not support", () => {
    const issues = issuesFor((manifest) => {
      const connections = manifest["connections"] as { slots: Record<string, unknown>[] };
      connections.slots.push({
        id: "site_oauth",
        kind: "oauth2",
        displayName: "Site OAuth",
        authorizationUrl: "https://example.com/authorize",
        tokenUrl: "https://example.com/token",
        scopes: ["read"],
      });
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: "unsupported_connection_kind", path: "connections.slots[2].kind" }),
    ]);
  });

  it("rejects a manifest permission the policy does not support", () => {
    const narrowPolicy: ManifestValidationPolicy = {
      ...releaseAValidationPolicy,
      supportedPermissions: ["documents.ingest", "documents.delete", "storage.read", "storage.write"],
    };
    const issues = issuesFor(() => undefined, narrowPolicy);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: "unsupported_permission", path: "permissions[4]" }),
    );
  });

  it("rejects a contribution permission the manifest does not declare", () => {
    const issues = issuesFor((manifest) => {
      manifest["permissions"] = ["documents.ingest", "documents.delete", "storage.read", "storage.write"];
      contributionsOf(manifest)[2]["egressDestinations"] = [];
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: "permission_not_declared", path: "contributions[2].permissions[3]" }),
    ]);
  });

  it("rejects an egress destination that no destination declares", () => {
    const issues = issuesFor((manifest) => {
      contributionsOf(manifest)[2]["egressDestinations"] = ["other_site"];
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: "unknown_destination", path: "contributions[2].egressDestinations[0]" }),
    ]);
  });

  it("rejects a webhook secret slot that no slot declares", () => {
    const issues = issuesFor((manifest) => {
      const authentication = contributionsOf(manifest)[1]["authentication"] as Record<string, unknown>;
      authentication["secretConnectionSlot"] = "missing_slot";
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "unknown_connection_slot",
        path: "contributions[1].authentication.secretConnectionSlot",
      }),
    ]);
  });

  it("rejects a webhook secret slot that cannot hold a signing secret", () => {
    const issues = issuesFor((manifest) => {
      const connections = manifest["connections"] as { slots: Record<string, unknown>[] };
      connections.slots[1] = {
        id: "webhook_secret",
        kind: "oauth2",
        displayName: "Webhook secret",
        authorizationUrl: "https://example.com/authorize",
        tokenUrl: "https://example.com/token",
        scopes: ["read"],
      };
    });
    expect(issues.map((issue) => issue.code)).toContain("invalid_webhook_secret_slot");
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "invalid_webhook_secret_slot",
        path: "contributions[1].authentication.secretConnectionSlot",
      }),
    );
  });

  it("rejects a checkpoint collection that no collection declares", () => {
    const issues = issuesFor((manifest) => {
      contributionsOf(manifest)[2]["checkpointCollection"] = "missing_collection";
      (contributionsOf(manifest)[0]["backfill"] as Record<string, unknown>)["checkpointCollection"] = "also_missing";
    });
    expect(issues.map((issue) => issue.path)).toEqual([
      "contributions[0].backfill.checkpointCollection",
      "contributions[2].checkpointCollection",
    ]);
    expect(issues.every((issue) => issue.code === "unknown_collection")).toBe(true);
  });

  it("rejects a connection_slot configuration field that no slot declares", () => {
    const issues = issuesFor((manifest) => {
      const configuration = manifest["configuration"] as { fields: Record<string, unknown>[] };
      configuration.fields.push({
        key: "credentials",
        type: "connection_slot",
        label: "Credentials",
        required: false,
        connectionSlot: "missing_slot",
      });
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "unknown_connection_slot",
        path: "configuration.fields[2].connectionSlot",
      }),
    ]);
  });

  it("rejects a destination bound to a configuration field that does not exist", () => {
    const issues = issuesFor((manifest) => {
      const destinations = manifest["destinations"] as Record<string, unknown>[];
      destinations[0]["host"] = { kind: "configuration", field: "missing_field" };
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: "unknown_configuration_field", path: "destinations[0].host.field" }),
    ]);
  });

  it("rejects a destination bound to a configuration field that is not a url field", () => {
    const issues = issuesFor((manifest) => {
      const destinations = manifest["destinations"] as Record<string, unknown>[];
      destinations[0]["host"] = { kind: "configuration", field: "poll_interval_sec" };
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: "destination_host_field_not_url", path: "destinations[0].host.field" }),
    ]);
  });

  it("rejects a destination connection slot that no slot declares", () => {
    const issues = issuesFor((manifest) => {
      (manifest["destinations"] as Record<string, unknown>[])[0]["connectionSlot"] = "missing_slot";
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: "unknown_connection_slot", path: "destinations[0].connectionSlot" }),
    ]);
  });

  it("rejects an interval read from a configuration field that does not exist", () => {
    const issues = issuesFor((manifest) => {
      const schedule = contributionsOf(manifest)[2]["schedule"] as Record<string, unknown>;
      schedule["field"] = "missing_field";
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: "unknown_configuration_field", path: "contributions[2].schedule.field" }),
    ]);
  });

  it("rejects an interval read from a configuration field that is not a number", () => {
    const issues = issuesFor((manifest) => {
      const schedule = contributionsOf(manifest)[2]["schedule"] as Record<string, unknown>;
      schedule["field"] = "site_url";
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: "interval_field_not_number", path: "contributions[2].schedule.field" }),
    ]);
  });

  it("rejects an index on a field the record schema does not declare", () => {
    const issues = issuesFor((manifest) => {
      const collections = manifest["storageCollections"] as Record<string, unknown>[];
      (collections[0]["indexes"] as Record<string, unknown>[])[0]["field"] = "missing_field";
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: "unknown_index_field", path: "storageCollections[0].indexes[0].field" }),
    ]);
  });

  it("rejects an index on a field that is not scalar", () => {
    const issues = issuesFor((manifest) => {
      const collections = manifest["storageCollections"] as Record<string, unknown>[];
      (collections[0]["indexes"] as Record<string, unknown>[])[0]["field"] = "notes";
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: "non_scalar_index_field", path: "storageCollections[0].indexes[0].field" }),
    ]);
  });

  it("collects every cross-reference failure rather than stopping at the first", () => {
    const issues = issuesFor((manifest) => {
      contributionsOf(manifest)[2]["egressDestinations"] = ["other_site"];
      contributionsOf(manifest)[2]["checkpointCollection"] = "missing_collection";
      (manifest["destinations"] as Record<string, unknown>[])[0]["connectionSlot"] = "missing_slot";
    });
    expect(issues.map((issue) => issue.code).sort()).toEqual([
      "unknown_collection",
      "unknown_connection_slot",
      "unknown_destination",
    ]);
  });
});
