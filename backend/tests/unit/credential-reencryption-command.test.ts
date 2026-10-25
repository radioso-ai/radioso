import { describe, expect, it } from "vitest";

import {
  parseCredentialReencryptionArgs,
  runCredentialReencryptionCommand,
  type EncryptedFieldStorePort,
} from "../../src/app/cli/credentialReencryptionCommand.js";
import type {
  EncryptedFieldLocation,
  EncryptedFieldRow,
} from "../../src/db/repositories/encryptedFieldRepository.js";
import {
  decryptField,
  encryptField,
  encryptFieldAs,
  FIELD_ENCRYPTION_WRITE_FORMAT,
  fieldEncryptionKeyId,
  openEncryptedField,
} from "../../src/shared/infra/crypto/fieldEncryption.js";

const CURRENT_KEY = Buffer.alloc(32, 0x01).toString("base64");
const PREVIOUS_KEY = Buffer.alloc(32, 0x02).toString("base64");
const REMOVED_KEY = Buffer.alloc(32, 0x03).toString("base64");
const KEYS = { current: CURRENT_KEY, previous: [PREVIOUS_KEY] };
const CURRENT_ID = fieldEncryptionKeyId(CURRENT_KEY);
const PREVIOUS_ID = fieldEncryptionKeyId(PREVIOUS_KEY);
const REMOVED_ID = fieldEncryptionKeyId(REMOVED_KEY);

const SECRETS = "workspace_webhook_destinations.secret_ciphertext";
const CONNECTORS = "connector_configs.config_data";

const TEXT_LOCATION: EncryptedFieldLocation = {
  label: SECRETS,
  table: "workspace_webhook_destinations",
  keyColumns: ["id"],
  column: "secret_ciphertext",
  shape: "text",
};
const JSON_LOCATION: EncryptedFieldLocation = {
  label: CONNECTORS,
  table: "connector_configs",
  keyColumns: ["id"],
  column: "config_data",
  shape: "json_object_values",
};

/**
 * Written so the tests hold whichever stored form production writes: "done" means under the current
 * key in the write format, and the other form is something the command re-encrypts.
 */
const OTHER_FORMAT = FIELD_ENCRYPTION_WRITE_FORMAT === "keyed" ? "unkeyed" : "keyed";
const OTHER_FORMAT_LABEL = OTHER_FORMAT === "keyed" ? "written with a key id" : "written without a key id";
const encryptInOtherFormat = (plaintext: string, keyBase64: string): string =>
  encryptFieldAs(OTHER_FORMAT, plaintext, keyBase64);
const encryptKeyed = (plaintext: string, keyBase64: string): string => encryptFieldAs("keyed", plaintext, keyBase64);
const encryptUnkeyed = (plaintext: string, keyBase64: string): string =>
  encryptFieldAs("unkeyed", plaintext, keyBase64);
const CURRENT_IN_WRITE_FORMAT = { keyId: CURRENT_ID, format: FIELD_ENCRYPTION_WRITE_FORMAT };

const compareKeys = (left: readonly string[], right: readonly string[]): number => {
  for (let index = 0; index < left.length; index += 1) {
    const order = left[index].localeCompare(right[index]);
    if (order !== 0) return order;
  }
  return 0;
};

/** Rows per location label, read in key order the way the Postgres store pages them. */
class InMemoryEncryptedFieldStore implements EncryptedFieldStorePort {
  readonly rows = new Map<string, EncryptedFieldRow[]>();
  readonly reads: Array<{ label: string; limit: number }> = [];
  /** Runs inside a compare-and-swap before it compares: a concurrent edit landing mid-run. */
  beforeSwap: ((label: string, key: readonly string[]) => void) | null = null;

  seed(label: string, rows: EncryptedFieldRow[]): void {
    this.rows.set(label, [...rows].sort((left, right) => compareKeys(left.key, right.key)));
  }

  value(label: string, key: readonly string[]): string | undefined {
    return this.rows.get(label)?.find((row) => compareKeys(row.key, key) === 0)?.value;
  }

  set(label: string, key: readonly string[], value: string): void {
    const row = this.rows.get(label)?.find((candidate) => compareKeys(candidate.key, key) === 0);
    if (row) row.value = value;
  }

  async readBatch(location: EncryptedFieldLocation, after: readonly string[] | null, limit: number) {
    this.reads.push({ label: location.label, limit });
    return (this.rows.get(location.label) ?? [])
      .filter((row) => after === null || compareKeys(row.key, after) > 0)
      .slice(0, limit)
      .map((row) => ({ key: [...row.key], value: row.value }));
  }

  async compareAndSwap(location: EncryptedFieldLocation, key: readonly string[], expected: string, next: string) {
    this.beforeSwap?.(location.label, key);
    if (this.value(location.label, key) !== expected) return false;
    this.set(location.label, key, next);
    return true;
  }
}

const setup = (
  locations: EncryptedFieldLocation[] = [TEXT_LOCATION, JSON_LOCATION],
  batchSize?: number,
  keys: { current: string; previous: string[] } = KEYS,
) => {
  const store = new InMemoryEncryptedFieldStore();
  const lines: string[] = [];
  const run = (argv: string[]) =>
    runCredentialReencryptionCommand(parseCredentialReencryptionArgs(argv), {
      keys,
      locations,
      store,
      print: (line) => lines.push(line),
      ...(batchSize ? { batchSize } : {}),
    });
  const output = () => lines.join("\n");
  return { store, lines, run, output };
};

describe("parsing the credential re-encryption arguments", () => {
  it("is a dry run unless told to apply", () => {
    expect(parseCredentialReencryptionArgs([])).toEqual({ apply: false });
    // `pnpm run <script> -- <args>` forwards the separator.
    expect(parseCredentialReencryptionArgs(["--"])).toEqual({ apply: false });
    expect(parseCredentialReencryptionArgs(["--apply"])).toEqual({ apply: true });
  });

  it("rejects anything else with the usage", () => {
    expect(() => parseCredentialReencryptionArgs(["--force"])).toThrow(/Unknown argument --force\. Usage:/);
  });
});

describe("re-encrypting stored credentials", () => {
  it("reports, as a dry run, how many values each key holds per location and changes nothing", async () => {
    const { store, run, output, lines } = setup();
    const seeded: EncryptedFieldRow[] = [
      { key: ["a"], value: encryptField("current-in-place", CURRENT_KEY) },
      { key: ["b"], value: encryptInOtherFormat("current-other-form", CURRENT_KEY) },
      { key: ["c"], value: encryptField("previous-in-write-form", PREVIOUS_KEY) },
      { key: ["d"], value: encryptInOtherFormat("previous-other-form", PREVIOUS_KEY) },
    ];
    store.seed(SECRETS, seeded.map((row) => ({ ...row })));

    const { exitCode } = await run([]);

    expect(exitCode).toBe(0);
    expect(lines).toEqual([
      `Current key: ${CURRENT_ID}. Previous keys: ${PREVIOUS_ID}.`,
      SECRETS,
      `  current key ${CURRENT_ID}: 1`,
      `  current key ${CURRENT_ID}, ${OTHER_FORMAT_LABEL}: 1 to re-encrypt`,
      `  previous key ${PREVIOUS_ID}: 2 to re-encrypt`,
      CONNECTORS,
      "  no encrypted values",
      "To re-encrypt: 3. Unreadable: 0.",
      "Dry run: nothing was changed. Run again with --apply to re-encrypt these values under the current key.",
    ]);
    expect(store.rows.get(SECRETS)).toEqual(seeded);
    expect(output()).not.toContain("previous-in-write-form");
  });

  it("moves every value onto the current key with --apply, and a second run finds nothing left", async () => {
    const { store, run, lines } = setup();
    const untouched = encryptField("already-current", CURRENT_KEY);
    store.seed(SECRETS, [
      { key: ["a"], value: untouched },
      { key: ["b"], value: encryptInOtherFormat("current-other-form", CURRENT_KEY) },
      { key: ["c"], value: encryptKeyed("previous-keyed", PREVIOUS_KEY) },
      { key: ["d"], value: encryptUnkeyed("previous-unkeyed", PREVIOUS_KEY) },
    ]);

    const applied = await run(["--apply"]);

    expect(applied.exitCode).toBe(0);
    expect(lines.at(-1)).toBe(`Re-encrypted 3 values under the current key ${CURRENT_ID}.`);
    expect(store.value(SECRETS, ["a"])).toBe(untouched);
    for (const [key, plaintext] of [["b", "current-other-form"], ["c", "previous-keyed"], ["d", "previous-unkeyed"]] as const) {
      const opened = openEncryptedField(store.value(SECRETS, [key])!, CURRENT_KEY);
      expect(opened).toEqual({ plaintext, ...CURRENT_IN_WRITE_FORMAT });
    }

    lines.length = 0;
    const again = await run([]);
    expect(again.exitCode).toBe(0);
    expect(lines).toContain(`  current key ${CURRENT_ID}: 4`);
    expect(lines).toContain("To re-encrypt: 0. Unreadable: 0.");
  });

  it("leaves a value an operator changed during the run, and says so", async () => {
    const { store, run, lines } = setup();
    store.seed(SECRETS, [
      { key: ["a"], value: encryptField("old-secret", PREVIOUS_KEY) },
      { key: ["b"], value: encryptField("other-secret", PREVIOUS_KEY) },
    ]);
    const edited = encryptField("rotated-by-operator", CURRENT_KEY);
    store.beforeSwap = (label, key) => {
      if (label === SECRETS && key[0] === "a") store.set(SECRETS, ["a"], edited);
    };

    const { exitCode } = await run(["--apply"]);

    expect(exitCode).toBe(0);
    expect(store.value(SECRETS, ["a"])).toBe(edited);
    expect(decryptField(store.value(SECRETS, ["b"])!, CURRENT_KEY)).toBe("other-secret");
    expect(lines.slice(-2)).toEqual([
      `Re-encrypted 1 value under the current key ${CURRENT_ID}.`,
      "1 value changed while the command ran and was left as it is. Run the dry run again to check it.",
    ]);
  });

  it("counts values no configured key decrypts, leaves them alone, and exits non-zero", async () => {
    const { store, run, lines, output } = setup();
    const orphaned = encryptKeyed("orphaned", REMOVED_KEY);
    const unkeyedOrphan = encryptUnkeyed("unkeyed-orphan", REMOVED_KEY);
    store.seed(SECRETS, [
      { key: ["a"], value: orphaned },
      { key: ["b"], value: unkeyedOrphan },
      { key: ["c"], value: "stored-in-plaintext" },
      { key: ["d"], value: encryptInOtherFormat("readable", PREVIOUS_KEY) },
    ]);

    const { exitCode } = await run(["--apply"]);

    expect(exitCode).toBe(1);
    expect(lines).toContain(`  unreadable, encrypted under key ${REMOVED_ID}, which is not configured: 1`);
    expect(lines).toContain("  unreadable, no configured key decrypts it: 2");
    expect(lines).toContain("To re-encrypt: 1. Unreadable: 3.");
    expect(store.value(SECRETS, ["a"])).toBe(orphaned);
    expect(store.value(SECRETS, ["b"])).toBe(unkeyedOrphan);
    expect(store.value(SECRETS, ["c"])).toBe("stored-in-plaintext");
    expect(decryptField(store.value(SECRETS, ["d"])!, CURRENT_KEY)).toBe("readable");
    expect(lines.at(-1)).toBe(
      "3 values could not be decrypted and were left as they are. Add the key that encrypted them to " +
        "CONNECTOR_ENCRYPTION_PREVIOUS_KEYS and run again, or re-enter those credentials.",
    );
    expect(output()).not.toContain("stored-in-plaintext");
  });

  it("re-encrypts the encrypted values inside a JSON object and keeps its other fields", async () => {
    const { store, run, lines } = setup();
    const config = {
      site_url: "https://example.com",
      api_token: encryptUnkeyed("wp-token", PREVIOUS_KEY),
      webhook_secret: encryptField("generated", CURRENT_KEY),
      stale_secret: encryptKeyed("from-a-removed-key", REMOVED_KEY),
      retries: 3,
    };
    store.seed(CONNECTORS, [{ key: ["connector-1"], value: JSON.stringify(config) }]);

    const { exitCode } = await run(["--apply"]);

    expect(exitCode).toBe(1);
    expect(lines).toEqual(expect.arrayContaining([
      CONNECTORS,
      `  current key ${CURRENT_ID}: 1`,
      `  previous key ${PREVIOUS_ID}: 1 to re-encrypt`,
      `  unreadable, encrypted under key ${REMOVED_ID}, which is not configured: 1`,
    ]));
    const stored = JSON.parse(store.value(CONNECTORS, ["connector-1"])!) as Record<string, unknown>;
    expect(stored.site_url).toBe("https://example.com");
    expect(stored.retries).toBe(3);
    expect(stored.webhook_secret).toBe(config.webhook_secret);
    expect(stored.stale_secret).toBe(config.stale_secret);
    expect(openEncryptedField(stored.api_token as string, CURRENT_KEY))
      .toEqual({ plaintext: "wp-token", ...CURRENT_IN_WRITE_FORMAT });
  });

  it("reads each location in batches until it is exhausted", async () => {
    const { store, run, lines } = setup([TEXT_LOCATION], 2);
    store.seed(SECRETS, ["a", "b", "c", "d", "e"].map((key) => ({ key: [key], value: encryptField(key, PREVIOUS_KEY) })));

    await run(["--apply"]);

    expect(store.reads).toEqual([
      { label: SECRETS, limit: 2 },
      { label: SECRETS, limit: 2 },
      { label: SECRETS, limit: 2 },
    ]);
    expect(lines.at(-1)).toBe(`Re-encrypted 5 values under the current key ${CURRENT_ID}.`);
  });

  it("warns, without failing, when no previous key is configured to tell a replaced key from a lost one", async () => {
    const { store, run, lines } = setup([TEXT_LOCATION], undefined, { current: CURRENT_KEY, previous: [] });
    store.seed(SECRETS, [{ key: ["a"], value: encryptField("current", CURRENT_KEY) }]);

    const { exitCode } = await run([]);

    expect(exitCode).toBe(0);
    expect(lines.slice(0, 2)).toEqual([
      `Current key: ${CURRENT_ID}. Previous keys: none.`,
      "Warning: no previous keys are configured. A value under a replaced key counts as unreadable, and a " +
        "connector secret under one is not counted at all. To confirm a rotation, run with the replaced key " +
        "still in CONNECTOR_ENCRYPTION_PREVIOUS_KEYS.",
    ]);
  });

  it("never prints a key or a stored value", async () => {
    const { store, run, output } = setup();
    const ciphertext = encryptField("super-secret-value", PREVIOUS_KEY);
    store.seed(SECRETS, [{ key: ["a"], value: ciphertext }]);

    await run([]);
    await run(["--apply"]);

    for (const forbidden of [CURRENT_KEY, PREVIOUS_KEY, "super-secret-value", ciphertext]) {
      expect(output()).not.toContain(forbidden);
    }
  });
});
