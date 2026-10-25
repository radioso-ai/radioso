import type { EncryptedFieldLocation, EncryptedFieldRow } from "../../db/repositories/encryptedFieldRepository.js";
import {
  decryptField,
  encryptField,
  FieldDecryptionError,
  fieldEncryptionKeyId,
  openEncryptedField,
  type FieldEncryptionKeyRing,
  type OpenedEncryptedField,
} from "../../shared/infra/crypto/fieldEncryption.js";

/** Every run reports; only `apply` writes. */
interface CredentialReencryptionCommand {
  apply: boolean;
}

const USAGE = "Usage: credentialReencryption [--apply]";
const DEFAULT_BATCH_SIZE = 100;

export const parseCredentialReencryptionArgs = (argv: readonly string[]): CredentialReencryptionCommand => {
  let apply = false;
  for (const argument of argv) {
    if (argument === "--") continue;
    if (argument !== "--apply") throw new Error(`Unknown argument ${argument}. ${USAGE}`);
    apply = true;
  }
  return { apply };
};

export interface EncryptedFieldStorePort {
  readBatch(location: EncryptedFieldLocation, after: readonly string[] | null, limit: number): Promise<EncryptedFieldRow[]>;
  compareAndSwap(location: EncryptedFieldLocation, key: readonly string[], expected: string, next: string): Promise<boolean>;
}

interface CredentialReencryptionDependencies {
  keys: FieldEncryptionKeyRing;
  locations: readonly EncryptedFieldLocation[];
  store: EncryptedFieldStorePort;
  print: (line: string) => void;
  batchSize?: number;
}

type ValueReading =
  | ({ kind: "readable" } & OpenedEncryptedField)
  | { kind: "unreadable"; unknownKeyId: string | null }
  | { kind: "not_encrypted" };

/** The ciphertexts one stored value holds, and the value rebuilt with some of them replaced. */
interface StoredCell {
  ciphertexts: string[];
  rebuild(replacements: ReadonlyMap<string, string>): string;
}

interface LocationTally {
  readable: Map<string, { keyed: number; unkeyed: number }>;
  unknownKeys: Map<string, number>;
  unauthenticated: number;
}

interface RunTotals {
  toReencrypt: number;
  unreadable: number;
  reencrypted: number;
  changedDuringRun: number;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

const textCell = (value: string): StoredCell => ({
  ciphertexts: [value],
  rebuild: (replacements) => replacements.get(value) ?? value,
});

/** Connector configs: every string field is a candidate, and only those that decrypt are secrets. */
const jsonObjectCell = (value: string): StoredCell => {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ciphertexts: [], rebuild: () => value };
  }
  const fields = Object.entries(parsed as Record<string, unknown>);
  return {
    ciphertexts: fields.flatMap(([, field]) => (typeof field === "string" ? [field] : [])),
    rebuild: (replacements) =>
      JSON.stringify(Object.fromEntries(fields.map(([name, field]) => [
        name,
        typeof field === "string" ? (replacements.get(field) ?? field) : field,
      ]))),
  };
};

const cellOf = (location: EncryptedFieldLocation, value: string): StoredCell =>
  location.shape === "text" ? textCell(value) : jsonObjectCell(value);

/**
 * A text column holds only ciphertext, so anything that fails to open is unreadable. A JSON field
 * that fails is a plain setting unless it names a key id, which only ciphertext does.
 */
const readValue = (value: string, location: EncryptedFieldLocation, keys: FieldEncryptionKeyRing): ValueReading => {
  try {
    return { kind: "readable", ...openEncryptedField(value, keys) };
  } catch (error) {
    if (!(error instanceof FieldDecryptionError)) throw error;
    if (location.shape === "json_object_values" && error.keyId === null) return { kind: "not_encrypted" };
    return { kind: "unreadable", unknownKeyId: error.reason === "unknown_key" ? error.keyId : null };
  }
};

const emptyTally = (): LocationTally => ({ readable: new Map(), unknownKeys: new Map(), unauthenticated: 0 });

const record = (tally: LocationTally, reading: ValueReading): void => {
  if (reading.kind === "readable") {
    const counts = tally.readable.get(reading.keyId) ?? { keyed: 0, unkeyed: 0 };
    counts[reading.format] += 1;
    tally.readable.set(reading.keyId, counts);
  } else if (reading.kind === "unreadable" && reading.unknownKeyId) {
    tally.unknownKeys.set(reading.unknownKeyId, (tally.unknownKeys.get(reading.unknownKeyId) ?? 0) + 1);
  } else if (reading.kind === "unreadable") {
    tally.unauthenticated += 1;
  }
};

/** Re-encrypts under the current key, and refuses to hand back anything that does not read back. */
const reencrypt = (plaintext: string, keys: FieldEncryptionKeyRing): string => {
  const next = encryptField(plaintext, keys);
  if (decryptField(next, keys.current) !== plaintext) {
    throw new Error("A re-encrypted value did not decrypt back to its plaintext");
  }
  return next;
};

const tallyLines = (tally: LocationTally, currentId: string, previousIds: readonly string[]): string[] => {
  const lines: string[] = [];
  for (const keyId of new Set([currentId, ...previousIds, ...tally.readable.keys()])) {
    const counts = tally.readable.get(keyId);
    if (!counts) continue;
    const role = keyId === currentId ? "current" : "previous";
    if (counts.keyed > 0) {
      lines.push(`  ${role} key ${keyId}: ${counts.keyed}${role === "current" ? "" : " to re-encrypt"}`);
    }
    if (counts.unkeyed > 0) lines.push(`  ${role} key ${keyId}, written without a key id: ${counts.unkeyed} to re-encrypt`);
  }
  for (const [keyId, count] of tally.unknownKeys) {
    lines.push(`  unreadable, encrypted under key ${keyId}, which is not configured: ${count}`);
  }
  if (tally.unauthenticated > 0) lines.push(`  unreadable, no configured key decrypts it: ${tally.unauthenticated}`);
  return lines.length > 0 ? lines : ["  no encrypted values"];
};

const outcomeLines = (command: CredentialReencryptionCommand, totals: RunTotals, currentId: string): string[] => {
  const lines = [`To re-encrypt: ${totals.toReencrypt}. Unreadable: ${totals.unreadable}.`];
  if (!command.apply) {
    lines.push("Dry run: nothing was changed. Run again with --apply to re-encrypt these values under the current key.");
  } else {
    lines.push(`Re-encrypted ${plural(totals.reencrypted, "value", "values")} under the current key ${currentId}.`);
    if (totals.changedDuringRun > 0) {
      const one = totals.changedDuringRun === 1;
      lines.push(
        `${plural(totals.changedDuringRun, "value", "values")} changed while the command ran and ` +
          `${one ? "was left as it is" : "were left as they are"}. Run the dry run again to check ${one ? "it" : "them"}.`,
      );
    }
  }
  if (totals.unreadable > 0) {
    const one = totals.unreadable === 1;
    lines.push(
      `${plural(totals.unreadable, "value", "values")} could not be decrypted and ` +
        `${one ? "was left as it is" : "were left as they are"}. Add the key that encrypted ${one ? "it" : "them"} to ` +
        `CONNECTOR_ENCRYPTION_PREVIOUS_KEYS and run again, or re-enter ${one ? "that credential" : "those credentials"}.`,
    );
  }
  return lines;
};

/**
 * Reports, per encrypted location, how many values each configured key holds, and with `apply`
 * re-encrypts every readable value that is not already keyed under the current key. Prints counts
 * and key ids only, never a value or a key. Exits 1 while any value cannot be decrypted.
 */
export const runCredentialReencryptionCommand = async (
  command: CredentialReencryptionCommand,
  deps: CredentialReencryptionDependencies,
): Promise<{ exitCode: number }> => {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const currentId = fieldEncryptionKeyId(deps.keys.current);
  const previousIds = deps.keys.previous.map((key) => fieldEncryptionKeyId(key));
  const totals: RunTotals = { toReencrypt: 0, unreadable: 0, reencrypted: 0, changedDuringRun: 0 };
  deps.print(`Current key: ${currentId}. Previous keys: ${previousIds.length > 0 ? previousIds.join(", ") : "none"}.`);

  for (const location of deps.locations) {
    const tally = emptyTally();
    let after: readonly string[] | null = null;
    for (;;) {
      const rows = await deps.store.readBatch(location, after, batchSize);
      for (const row of rows) {
        const cell = cellOf(location, row.value);
        const replacements = new Map<string, string>();
        for (const ciphertext of cell.ciphertexts) {
          const reading = readValue(ciphertext, location, deps.keys);
          record(tally, reading);
          if (reading.kind === "unreadable") totals.unreadable += 1;
          if (reading.kind !== "readable" || (reading.format === "keyed" && reading.keyId === currentId)) continue;
          totals.toReencrypt += 1;
          if (command.apply) replacements.set(ciphertext, reencrypt(reading.plaintext, deps.keys));
        }
        if (replacements.size === 0) continue;
        const written = await deps.store.compareAndSwap(location, row.key, row.value, cell.rebuild(replacements));
        if (written) totals.reencrypted += replacements.size;
        else totals.changedDuringRun += replacements.size;
      }
      const last = rows.at(-1);
      if (rows.length < batchSize || !last) break;
      after = last.key;
    }
    deps.print(location.label);
    for (const line of tallyLines(tally, currentId, previousIds)) deps.print(line);
  }

  for (const line of outcomeLines(command, totals, currentId)) deps.print(line);
  return { exitCode: totals.unreadable > 0 ? 1 : 0 };
};
