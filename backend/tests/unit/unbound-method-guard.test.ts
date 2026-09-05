import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import {
  findUnboundMethodReferences,
  type UnboundMethodAllowlistEntry,
} from "../../scripts/checkUnboundMethods.mjs";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const scan = (source: string, allowlist: readonly UnboundMethodAllowlistEntry[] = []) => {
  const directory = mkdtempSync(join(tmpdir(), "radioso-unbound-method-"));
  tempDirectories.push(directory);
  const sourceDirectory = join(directory, "src");
  const fileName = join(sourceDirectory, "fixture.ts");
  ts.sys.createDirectory(sourceDirectory);
  writeFileSync(fileName, source);

  const program = ts.createProgram([fileName], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
  });

  return findUnboundMethodReferences(program, { sourceDirectory, allowlist });
};

describe("unbound-method guard", () => {
  it("flags a detached method reference but accepts arrow-valued members", () => {
    const result = scan(`
      class Example {
        method(): void {}
        arrow = (): void => {};

        use(): void {
          const detached = this.method;
          const detachedByName = this["method"];
          const boundByConstruction = this.arrow;
          void detached;
          void detachedByName;
          void boundByConstruction;
        }
      }
    `);

    expect(result.findings).toMatchObject([
      { file: "src/fixture.ts", member: "method", line: 7 },
      { file: "src/fixture.ts", member: "method", line: 8 },
    ]);
    expect(result.staleAllowlistEntries).toEqual([]);
  });

  it("accepts bound uses and existence checks", () => {
    const result = scan(`
      class Example {
        method(): void {}

        use(): void {
          const bound = this.method.bind(this);
          if (!this.method || typeof this.method !== "function" || Boolean(this.method)) return;
          const value = this.method ? 1 : 0;
          const present = this.method != null;
          void bound;
          void value;
          void present;
        }
      }
    `);

    expect(result.findings).toEqual([]);
  });

  it("accepts a non-null assertion call target", () => {
    const result = scan(`
      class Example {
        method?(): void {}

        use(): void {
          this.method!();
        }
      }
    `);

    expect(result.findings).toEqual([]);
  });

  it("allows reviewed findings and reports stale allowlist entries", () => {
    const allowlist = [
      { file: "src/fixture.ts", member: "method", reason: "Fixture exercises the allowlist." },
      { file: "src/fixture.ts", member: "removed", reason: "This entry is stale." },
    ] satisfies readonly UnboundMethodAllowlistEntry[];
    const result = scan(`
      class Example {
        method(): void {}

        use(): void {
          const detached = this.method;
          void detached;
        }
      }
    `, allowlist);

    expect(result.findings).toEqual([]);
    expect(result.staleAllowlistEntries).toEqual([allowlist[1]]);
  });
});
