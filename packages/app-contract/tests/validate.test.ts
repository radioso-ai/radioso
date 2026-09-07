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
  runtimeProtocolVersion: 1,
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
      dataClasses: ["document_content", "credentials"],
      credentials: {
        slot: "site_credentials",
        application: {
          mode: "http_basic",
          usernameField: "wp_username",
          passwordField: "wp_application_password",
        },
        required: false,
      },
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
      inputSchemaVersion: 1,
      outputSchemaVersion: 1,
      requiredConnectionSlots: [],
      externalIdNamespace: "example_post",
      syncModes: ["push", "poll", "backfill"],
      contentFormats: ["html"],
      indexedFields: { policy: "declared", keys: [] },
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
      inputSchemaVersion: 1,
      outputSchemaVersion: 1,
      requiredConnectionSlots: ["webhook_secret"],
      documentSources: ["site_content"],
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
      inputSchemaVersion: 1,
      outputSchemaVersion: 1,
      requiredConnectionSlots: ["site_credentials"],
      documentSources: ["site_content"],
      schedule: {
        kind: "interval_from_configuration",
        field: "poll_interval_sec",
        minSeconds: 60,
        maxSeconds: 86_400,
        disabledValue: 0,
      },
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
        inputSchemaVersion: 1,
        outputSchemaVersion: 1,
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
      contributionsOf(manifest)[1]["requiredConnectionSlots"] = ["missing_slot"];
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "unknown_connection_slot",
        path: "contributions[1].requiredConnectionSlots[0]",
      }),
      expect.objectContaining({
        code: "unknown_connection_slot",
        path: "contributions[1].authentication.secretConnectionSlot",
      }),
    ]);
  });

  it("rejects a handler that verifies deliveries against a slot it never asks the operator to bind", () => {
    const issues = issuesFor((manifest) => {
      contributionsOf(manifest)[1]["requiredConnectionSlots"] = [];
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "webhook_secret_not_required",
        path: "contributions[1].requiredConnectionSlots",
      }),
    ]);
  });

  it("rejects a contribution that reaches a destination whose credential is mandatory without requiring the slot", () => {
    const issues = issuesFor((manifest) => {
      const destinations = manifest["destinations"] as Record<string, unknown>[];
      (destinations[0]["credentials"] as Record<string, unknown>)["required"] = true;
      contributionsOf(manifest)[2]["requiredConnectionSlots"] = [];
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "destination_credentials_not_required",
        path: "contributions[2].requiredConnectionSlots",
      }),
    ]);
  });

  it("rejects a credential built from a connection field an operator may leave empty", () => {
    const issues = issuesFor((manifest) => {
      const connections = manifest["connections"] as { slots: Record<string, unknown>[] };
      const fields = connections.slots[0]["fields"] as Record<string, unknown>[];
      fields[1]["required"] = false;
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "credential_field_not_required",
        path: "destinations[0].credentials.application.passwordField",
      }),
    ]);
  });

  it("rejects a secret credential half stored as a field the dashboard may show again", () => {
    const issues = issuesFor((manifest) => {
      const connections = manifest["connections"] as { slots: Record<string, unknown>[] };
      const fields = connections.slots[0]["fields"] as Record<string, unknown>[];
      fields[1]["sensitive"] = false;
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "credential_field_not_sensitive",
        path: "destinations[0].credentials.application.passwordField",
      }),
    ]);
  });

  it("admits a non-secret credential half that the dashboard may show again", () => {
    expect(issuesFor(() => undefined)).toEqual([]);
  });

  it("rejects a destination that sends a credential without disclosing that it does", () => {
    const issues = issuesFor((manifest) => {
      const destinations = manifest["destinations"] as Record<string, unknown>[];
      destinations[0]["dataClasses"] = ["document_content"];
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "missing_credentials_data_class",
        path: "destinations[0].dataClasses",
      }),
    ]);
  });

  it("rejects a schedule whose field cannot hold the value that disables it", () => {
    const issues = issuesFor((manifest) => {
      const fields = (manifest["configuration"] as { fields: Record<string, unknown>[] }).fields;
      fields[1]["min"] = 60;
      fields[1]["default"] = 60;
      const schedule = contributionsOf(manifest)[2]["schedule"] as Record<string, unknown>;
      schedule["disabledValue"] = 0;
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "disabled_value_outside_field_range",
        path: "contributions[2].schedule.disabledValue",
      }),
    ]);
  });

  it("rejects a schedule whose field admits no value inside the interval range", () => {
    const issues = issuesFor((manifest) => {
      const fields = (manifest["configuration"] as { fields: Record<string, unknown>[] }).fields;
      fields[1]["max"] = 30;
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "schedule_range_unreachable",
        path: "contributions[2].schedule.minSeconds",
      }),
    ]);
  });

  it("rejects a schedule whose field starts above the interval ceiling", () => {
    const issues = issuesFor((manifest) => {
      const fields = (manifest["configuration"] as { fields: Record<string, unknown>[] }).fields;
      fields[1]["min"] = 100_000;
      fields[1]["default"] = 100_000;
      const schedule = contributionsOf(manifest)[2]["schedule"] as Record<string, unknown>;
      schedule["maxSeconds"] = 3_600;
    });
    // The field is now out of reach of the interval range, out of reach of the
    // sentinel, and defaulted to a value the schedule cannot read. All three are
    // true of this manifest, and admission reports all three.
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "schedule_range_unreachable",
        path: "contributions[2].schedule.minSeconds",
      }),
    );
    expect(issues.map((issue) => issue.code).sort()).toEqual([
      "disabled_value_outside_field_range",
      "schedule_default_invalid",
      "schedule_range_unreachable",
    ]);
  });

  it("rejects a required scheduled task that also declares a value turning it off", () => {
    const issues = issuesFor((manifest) => {
      const poll = contributionsOf(manifest)[2];
      poll["availability"] = "required";
      (poll["schedule"] as Record<string, unknown>)["disabledValue"] = 0;
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "required_schedule_cannot_disable",
        path: "contributions[2].schedule.disabledValue",
      }),
    ]);
  });

  it("rejects two destinations built from one field that share no protocol", () => {
    const issues = issuesFor((manifest) => {
      const destinations = manifest["destinations"] as Record<string, unknown>[];
      const second = structuredClone(destinations[0]);
      second["id"] = "site_plain";
      second["protocols"] = ["http"];
      destinations.push(second);
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "destination_protocols_incompatible",
        path: "destinations[1].protocols",
      }),
    ]);
  });

  it("admits two destinations built from one field that overlap on a protocol", () => {
    const issues = issuesFor((manifest) => {
      const destinations = manifest["destinations"] as Record<string, unknown>[];
      const second = structuredClone(destinations[0]);
      second["id"] = "site_media";
      second["protocols"] = ["https", "http"];
      destinations.push(second);
    });
    expect(issues).toEqual([]);
  });

  it("names no pair when three destinations leave nothing common to all", () => {
    const issues = issuesFor((manifest) => {
      const destinations = manifest["destinations"] as Record<string, unknown>[];
      destinations[0]["protocols"] = ["https", "http"];
      const plain = structuredClone(destinations[0]);
      plain["id"] = "site_plain";
      plain["protocols"] = ["http"];
      const secure = structuredClone(destinations[0]);
      secure["id"] = "site_secure";
      secure["protocols"] = ["https"];
      destinations.push(plain, secure);
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "destination_protocols_incompatible",
        path: "destinations[2].protocols",
        message: "Destinations bound to field site_url have no protocol common to all",
      }),
    ]);
  });

  it("rejects two destinations built from one field that agree on a protocol and on no port", () => {
    const issues = issuesFor((manifest) => {
      const destinations = manifest["destinations"] as Record<string, unknown>[];
      destinations[0]["ports"] = [443];
      const second = structuredClone(destinations[0]);
      second["id"] = "site_alternate";
      second["ports"] = [8443];
      destinations.push(second);
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "destination_ports_incompatible",
        path: "destinations[1].ports",
      }),
    ]);
  });

  it("rejects an explicit port beside a destination that reaches its protocol's default only", () => {
    const issues = issuesFor((manifest) => {
      const destinations = manifest["destinations"] as Record<string, unknown>[];
      const second = structuredClone(destinations[0]);
      second["id"] = "site_alternate";
      second["ports"] = [8443];
      destinations.push(second);
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "destination_ports_incompatible",
        path: "destinations[1].ports",
      }),
    ]);
  });

  it("rejects an explicit port list with nothing in it, whichever host the destination declares", () => {
    const configurationBound = issuesFor((manifest) => {
      const destinations = manifest["destinations"] as Record<string, unknown>[];
      destinations[0]["ports"] = [];
    });
    expect(configurationBound).toEqual([
      expect.objectContaining({ code: "schema", path: "destinations[0].ports" }),
    ]);

    const patternBound = issuesFor((manifest) => {
      const destinations = manifest["destinations"] as Record<string, unknown>[];
      destinations[0]["host"] = { kind: "pattern", pattern: "api.example.com" };
      destinations[0]["ports"] = [];
    });
    expect(patternBound).toEqual([
      expect.objectContaining({ code: "schema", path: "destinations[0].ports" }),
    ]);
  });

  it("holds a url field's default to the destinations built from it", () => {
    const issues = issuesFor((manifest) => {
      const fields = (manifest["configuration"] as { fields: Record<string, unknown>[] }).fields;
      fields[0]["required"] = false;
      fields[0]["default"] = "https://example.com:8443";
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "url_default_invalid",
        path: "configuration.fields[0].default",
        message: expect.stringContaining("url_port_not_declared") as unknown as string,
      }),
    ]);
  });

  it("reports a default that carries userinfo, a query, or a protocol the destination never declared", () => {
    const withDefault = (value: string): ManifestValidationIssue[] =>
      issuesFor((manifest) => {
        const fields = (manifest["configuration"] as { fields: Record<string, unknown>[] }).fields;
        fields[0]["required"] = false;
        fields[0]["default"] = value;
      });
    expect(withDefault("https://admin:hunter2@example.com").map((issue) => issue.message)).toEqual([
      expect.stringContaining("url_carries_userinfo"),
    ]);
    expect(withDefault("https://example.com/wordpress?preview=1").map((issue) => issue.message)).toEqual([
      expect.stringContaining("url_carries_query_or_fragment"),
    ]);
    expect(withDefault("http://example.com").map((issue) => issue.message)).toEqual([
      expect.stringContaining("url_protocol_not_declared"),
    ]);
  });

  it("admits a url field default that every destination built from it can reach", () => {
    expect(
      issuesFor((manifest) => {
        const fields = (manifest["configuration"] as { fields: Record<string, unknown>[] }).fields;
        fields[0]["required"] = false;
        fields[0]["default"] = "https://example.com/wordpress";
      }),
    ).toEqual([]);
    expect(
      issuesFor((manifest) => {
        const fields = (manifest["configuration"] as { fields: Record<string, unknown>[] }).fields;
        fields[0]["required"] = false;
        fields[0]["default"] = "https://example.com:8443";
        (manifest["destinations"] as Record<string, unknown>[])[0]["ports"] = [8443];
      }),
    ).toEqual([]);
  });

  it("admits two destinations built from one field that overlap on a port", () => {
    const issues = issuesFor((manifest) => {
      const destinations = manifest["destinations"] as Record<string, unknown>[];
      destinations[0]["ports"] = [443, 8443];
      const second = structuredClone(destinations[0]);
      second["id"] = "site_alternate";
      second["ports"] = [8443];
      destinations.push(second);
    });
    expect(issues).toEqual([]);
  });

  it("rejects a schedule whose field an installation could leave empty", () => {
    const issues = issuesFor((manifest) => {
      const fields = (manifest["configuration"] as { fields: Record<string, unknown>[] }).fields;
      delete fields[1]["default"];
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "schedule_field_may_be_absent",
        path: "contributions[2].schedule.field",
      }),
    ]);
  });

  it("admits a schedule whose field is required, because an installation always holds one", () => {
    const issues = issuesFor((manifest) => {
      const fields = (manifest["configuration"] as { fields: Record<string, unknown>[] }).fields;
      delete fields[1]["default"];
      fields[1]["required"] = true;
    });
    expect(issues).toEqual([]);
  });

  it("rejects a default the schedule that reads it would refuse", () => {
    const issues = issuesFor((manifest) => {
      const fields = (manifest["configuration"] as { fields: Record<string, unknown>[] }).fields;
      fields[1]["default"] = 30;
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "schedule_default_invalid",
        path: "contributions[2].schedule.field",
      }),
    ]);
  });

  it("rejects a field range that overlaps the interval range but holds no whole second in it", () => {
    const issues = issuesFor((manifest) => {
      const fields = (manifest["configuration"] as { fields: Record<string, unknown>[] }).fields;
      fields[1]["min"] = 60.1;
      fields[1]["max"] = 60.9;
      fields[1]["default"] = 60.5;
      const schedule = contributionsOf(manifest)[2]["schedule"] as Record<string, unknown>;
      schedule["minSeconds"] = 60;
      schedule["maxSeconds"] = 61;
      delete schedule["disabledValue"];
    });
    expect(issues.map((issue) => issue.code)).toContain("schedule_range_unreachable");
  });

  it("makes every schedule reading one field mean the same thing by the value it holds", () => {
    const issues = issuesFor((manifest) => {
      const fields = (manifest["configuration"] as { fields: Record<string, unknown>[] }).fields;
      fields[1]["default"] = 300;
      const contributions = contributionsOf(manifest);
      delete (contributions[2]["schedule"] as Record<string, unknown>)["disabledValue"];
      const second = structuredClone(contributions[2]);
      second["id"] = "content_poll_media";
      (second["schedule"] as Record<string, unknown>)["disabledValue"] = 0;
      contributions.push(second);
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "shared_schedule_sentinel_mismatch",
        path: "contributions[3].schedule.disabledValue",
      }),
    ]);
  });

  it("rejects two schedules on one field whose active ranges never meet", () => {
    const issues = issuesFor((manifest) => {
      const contributions = contributionsOf(manifest);
      const first = contributions[2]["schedule"] as Record<string, unknown>;
      first["minSeconds"] = 60;
      first["maxSeconds"] = 100;
      const second = structuredClone(contributions[2]);
      second["id"] = "content_poll_media";
      const schedule = second["schedule"] as Record<string, unknown>;
      schedule["minSeconds"] = 200;
      schedule["maxSeconds"] = 300;
      contributions.push(second);
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "shared_schedule_ranges_disjoint",
        path: "contributions[3].schedule.minSeconds",
      }),
    ]);
  });

  it("admits two schedules on one field whose active ranges overlap", () => {
    const issues = issuesFor((manifest) => {
      const contributions = contributionsOf(manifest);
      const second = structuredClone(contributions[2]);
      second["id"] = "content_poll_media";
      const schedule = second["schedule"] as Record<string, unknown>;
      schedule["minSeconds"] = 120;
      contributions.push(second);
    });
    expect(issues).toEqual([]);
  });

  it("makes a webhook handler name the field of a multi-field slot that signs deliveries", () => {
    const useSecretFields = (manifest: MutableManifest, secretField?: string): void => {
      const authentication = contributionsOf(manifest)[1]["authentication"] as Record<string, unknown>;
      authentication["secretConnectionSlot"] = "site_credentials";
      if (secretField !== undefined) authentication["secretField"] = secretField;
      contributionsOf(manifest)[1]["requiredConnectionSlots"] = ["site_credentials"];
    };
    expect(issuesFor((manifest) => useSecretFields(manifest))).toEqual([
      expect.objectContaining({
        code: "webhook_secret_field_required",
        path: "contributions[1].authentication.secretField",
      }),
    ]);
    expect(issuesFor((manifest) => useSecretFields(manifest, "missing_field"))).toEqual([
      expect.objectContaining({
        code: "unknown_connection_field",
        path: "contributions[1].authentication.secretField",
      }),
    ]);
    expect(issuesFor((manifest) => useSecretFields(manifest, "wp_username"))).toEqual([
      expect.objectContaining({
        code: "credential_field_not_sensitive",
        path: "contributions[1].authentication.secretField",
      }),
    ]);
    expect(issuesFor((manifest) => useSecretFields(manifest, "wp_application_password"))).toEqual([]);
  });

  it("rejects a signing field an operator may leave empty", () => {
    const issues = issuesFor((manifest) => {
      const connections = manifest["connections"] as { slots: Record<string, unknown>[] };
      const fields = connections.slots[0]["fields"] as Record<string, unknown>[];
      fields[1]["required"] = false;
      const authentication = contributionsOf(manifest)[1]["authentication"] as Record<string, unknown>;
      authentication["secretConnectionSlot"] = "site_credentials";
      authentication["secretField"] = "wp_application_password";
      contributionsOf(manifest)[1]["requiredConnectionSlots"] = ["site_credentials"];
    });
    expect(issues.map((issue) => [issue.code, issue.path])).toEqual([
      ["credential_field_not_required", "destinations[0].credentials.application.passwordField"],
      ["credential_field_not_required", "contributions[1].authentication.secretField"],
    ]);
  });

  it("rejects a signing field named beside a slot that holds exactly one value", () => {
    const issues = issuesFor((manifest) => {
      const authentication = contributionsOf(manifest)[1]["authentication"] as Record<string, unknown>;
      authentication["secretField"] = "wp_application_password";
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "webhook_secret_field_not_allowed",
        path: "contributions[1].authentication.secretField",
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

  it("rejects a destination credential slot that no slot declares", () => {
    const issues = issuesFor((manifest) => {
      const destinations = manifest["destinations"] as Record<string, unknown>[];
      (destinations[0]["credentials"] as Record<string, unknown>)["slot"] = "missing_slot";
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: "unknown_connection_slot", path: "destinations[0].credentials.slot" }),
    ]);
  });

  it("rejects a destination credential bound to a slot that holds no fields to build a request from", () => {
    const issues = issuesFor((manifest) => {
      const destinations = manifest["destinations"] as Record<string, unknown>[];
      (destinations[0]["credentials"] as Record<string, unknown>)["slot"] = "webhook_secret";
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "invalid_destination_credential_slot",
        path: "destinations[0].credentials.slot",
      }),
    ]);
  });

  it("rejects a credential application naming a field the slot does not hold", () => {
    const issues = issuesFor((manifest) => {
      const destinations = manifest["destinations"] as Record<string, unknown>[];
      (destinations[0]["credentials"] as Record<string, unknown>)["application"] = {
        mode: "http_basic",
        usernameField: "wp_username",
        passwordField: "missing_field",
      };
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "unknown_connection_field",
        path: "destinations[0].credentials.application.passwordField",
      }),
    ]);
  });

  it("resolves every credential application mode against the slot it names", () => {
    expect(
      issuesFor((manifest) => {
        const destinations = manifest["destinations"] as Record<string, unknown>[];
        (destinations[0]["credentials"] as Record<string, unknown>)["application"] = {
          mode: "bearer",
          tokenField: "wp_application_password",
        };
      }),
    ).toEqual([]);
    expect(
      issuesFor((manifest) => {
        const destinations = manifest["destinations"] as Record<string, unknown>[];
        (destinations[0]["credentials"] as Record<string, unknown>)["application"] = {
          mode: "header",
          header: "X-Api-Key",
          valueField: "missing_field",
        };
      }),
    ).toEqual([
      expect.objectContaining({
        code: "unknown_connection_field",
        path: "destinations[0].credentials.application.valueField",
      }),
    ]);
  });

  it("rejects a required connection slot that no slot declares", () => {
    const issues = issuesFor((manifest) => {
      contributionsOf(manifest)[2]["requiredConnectionSlots"] = ["missing_slot"];
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "unknown_connection_slot",
        path: "contributions[2].requiredConnectionSlots[0]",
      }),
    ]);
  });

  it("rejects a handler that writes documents and names no source to write through", () => {
    const issues = issuesFor((manifest) => {
      contributionsOf(manifest)[1]["documentSources"] = [];
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: "missing_document_source", path: "contributions[1].documentSources" }),
    ]);
  });

  it("admits an empty source list on a handler that writes no documents", () => {
    const issues = issuesFor((manifest) => {
      const handler = contributionsOf(manifest)[1];
      handler["documentSources"] = [];
      handler["permissions"] = [];
    });
    expect(issues).toEqual([]);
  });

  it("rejects a document source named twice by one handler", () => {
    const issues = issuesFor((manifest) => {
      contributionsOf(manifest)[1]["documentSources"] = ["site_content", "site_content"];
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: "duplicate_id", path: "contributions[1].documentSources[1]" }),
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
      const destinations = manifest["destinations"] as Record<string, unknown>[];
      (destinations[0]["credentials"] as Record<string, unknown>)["slot"] = "missing_slot";
    });
    expect(issues.map((issue) => issue.code).sort()).toEqual([
      "unknown_collection",
      "unknown_connection_slot",
      "unknown_destination",
    ]);
  });
  it("reports duplicate secret-field keys inside one connection slot", () => {
    const issues = issuesFor((manifest) => {
      const connections = manifest["connections"] as { slots: Record<string, unknown>[] };
      const fields = connections.slots[0]["fields"] as Record<string, unknown>[];
      fields.push(structuredClone(fields[0]));
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: "duplicate_id", path: "connections.slots[0].fields[2].key" }),
    ]);
  });

  it("reports duplicate record-field keys and duplicate index ids inside one collection", () => {
    const issues = issuesFor((manifest) => {
      const collections = manifest["storageCollections"] as Record<string, unknown>[];
      const fields = collections[0]["recordSchema"] as { fields: Record<string, unknown>[] };
      fields.fields.push(structuredClone(fields.fields[0]));
      const indexes = collections[0]["indexes"] as Record<string, unknown>[];
      indexes.push({ id: "by_updated_at", field: "cursor" });
    });
    expect(issues.map((issue) => [issue.code, issue.path])).toEqual([
      ["duplicate_id", "storageCollections[0].indexes[1].id"],
      ["duplicate_id", "storageCollections[0].recordSchema.fields[3].key"],
    ]);
  });

  it("rejects a conformance fixture naming a contribution the manifest does not declare", () => {
    const issues = issuesFor((manifest) => {
      manifest["conformanceFixtures"] = [
        {
          id: "push_published",
          contributionId: "missing_handler",
          description: "Replays a published push.",
          path: "fixtures/push-published.json",
        },
      ];
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "unknown_contribution",
        path: "conformanceFixtures[0].contributionId",
      }),
    ]);
  });

  it("rejects a document source reference that no contribution declares", () => {
    const issues = issuesFor((manifest) => {
      contributionsOf(manifest)[1]["documentSources"] = ["missing_source"];
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "unknown_document_source",
        path: "contributions[1].documentSources[0]",
      }),
    ]);
  });

  it("rejects a document source reference that names a contribution which is not a source", () => {
    const issues = issuesFor((manifest) => {
      contributionsOf(manifest)[2]["documentSources"] = ["content_push"];
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: "not_a_document_source",
        path: "contributions[2].documentSources[0]",
      }),
    ]);
  });

  it("admits a disabled value below the interval floor, because it means no schedule at all", () => {
    const issues = issuesFor((manifest) => {
      const schedule = contributionsOf(manifest)[2]["schedule"] as Record<string, unknown>;
      schedule["disabledValue"] = 0;
    });
    expect(issues).toEqual([]);
  });

  it("rejects a disabled value that an operator could pick as a working interval", () => {
    const issues = issuesFor((manifest) => {
      const schedule = contributionsOf(manifest)[2]["schedule"] as Record<string, unknown>;
      schedule["disabledValue"] = 300;
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: "schema", path: "contributions[2].schedule.disabledValue" }),
    ]);
  });

  it("caps a declared record size at the size the wire carries", () => {
    const issues = issuesFor((manifest) => {
      const collections = manifest["storageCollections"] as Record<string, unknown>[];
      collections[0]["quotas"] = { maxRecords: 100, maxRecordBytes: 200_000 };
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: "schema", path: "storageCollections[0].quotas.maxRecordBytes" }),
    ]);
  });

  it("rejects an undeclared key rather than dropping it from a signed declaration", () => {
    const issues = issuesFor((manifest) => {
      (manifest["storageCollections"] as Record<string, unknown>[])[0]["physicalTable"] = "customer_data";
      (manifest["destinations"] as Record<string, unknown>[])[0]["allowPrivateNetwork"] = true;
    });
    expect(issues.map((issue) => [issue.code, issue.path])).toEqual([
      ["schema", "destinations[0]"],
      ["schema", "storageCollections[0]"],
    ]);
  });
});
