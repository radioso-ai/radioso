import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../../../src", import.meta.url));
const CIPHER_MODULE = "shared/infra/crypto/fieldEncryption.ts";

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });

describe("the credential write format", () => {
  // Phase one writes only the form the previous release reads (FIELD_ENCRYPTION_WRITE_FORMAT). A
  // production caller of encryptFieldAs could write keyed values that release cannot read, breaking
  // rolling deploys and rollbacks, so only the cipher module and tests may name it.
  it("is chosen only by fieldEncryption.ts: no other source file calls encryptFieldAs", () => {
    const callers = sourceFiles(SRC)
      .map((path) => relative(SRC, path).split("\\").join("/"))
      .filter((path) => path !== CIPHER_MODULE)
      .filter((path) => readFileSync(join(SRC, path), "utf8").includes("encryptFieldAs"));

    expect(callers).toEqual([]);
  });
});
