import { parseCredentialReencryptionArgs, runCredentialReencryptionCommand } from "./app/cli/credentialReencryptionCommand.js";
import { connectorEncryptionKeys, getEnv } from "./app/config/env.js";
import { ENCRYPTED_FIELD_LOCATIONS, EncryptedFieldRepository } from "./db/repositories/encryptedFieldRepository.js";
import { loadEnvFileIfPresent } from "./runtime/loadEnv.js";
import { Database } from "./shared/infra/database.js";

/**
 * Moves stored credentials onto `CONNECTOR_ENCRYPTION_KEY` after a key rotation. Without `--apply` it
 * reports how many values each configured key holds in every encrypted column, and changes nothing.
 * With `--apply` it re-encrypts each readable value that is not already keyed under the current key,
 * row by row, and never overwrites a credential edited since it was read. It runs with the backend's
 * environment: the database, `CONNECTOR_ENCRYPTION_KEY`, and `CONNECTOR_ENCRYPTION_PREVIOUS_KEYS`.
 *
 *   node ./dist/src/credentialReencryption.js            # dry run: counts per key id
 *   node ./dist/src/credentialReencryption.js --apply    # re-encrypt onto the current key
 *
 * From a checkout, `pnpm --dir backend run credentials:reencrypt` takes the same arguments. It exits
 * 1 while any stored value cannot be decrypted with a configured key. The rotation procedure is in
 * docs-portal/content/operators/self-hosting-operations.mdx.
 */

/** Ends a one-off run (a Cloud Run job) even if a client library left a handle open after the work. */
const EXIT_GRACE_MS = 10_000;

const main = async (): Promise<number> => {
  const command = parseCredentialReencryptionArgs(process.argv.slice(2));
  loadEnvFileIfPresent();
  const env = getEnv();
  const keys = connectorEncryptionKeys(env);
  if (!keys) {
    process.stderr.write("CONNECTOR_ENCRYPTION_KEY is not set, so there is no key to re-encrypt credentials under.\n");
    return 1;
  }
  const database = new Database(env.DATABASE_URL, { applicationName: "radioso-credential-reencryption", poolMax: 2 });
  try {
    const { exitCode } = await runCredentialReencryptionCommand(command, {
      keys,
      locations: ENCRYPTED_FIELD_LOCATIONS,
      store: new EncryptedFieldRepository(database.kysely),
      print: (line) => process.stdout.write(`${line}\n`),
    });
    return exitCode;
  } finally {
    await database.close();
  }
};

const finish = (exitCode: number): void => {
  process.exitCode = exitCode;
  // Unref'd, so a process with nothing left to do exits at once and its output drains first.
  setTimeout(() => process.exit(exitCode), EXIT_GRACE_MS).unref();
};

main().then(finish, (error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Credential re-encryption failed"}\n`);
  finish(1);
});
