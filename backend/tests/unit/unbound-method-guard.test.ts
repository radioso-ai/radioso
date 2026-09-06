import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

const scan = (
  source: string,
  options: {
    allowlist?: readonly UnboundMethodAllowlistEntry[];
    workspacePackage?: { name: string; declaration: string };
  } = {},
) => {
  const directory = mkdtempSync(join(tmpdir(), "radioso-unbound-method-"));
  tempDirectories.push(directory);
  const sourceDirectory = join(directory, "src");
  const fileName = join(sourceDirectory, "fixture.ts");
  mkdirSync(sourceDirectory, { recursive: true });
  writeFileSync(fileName, source);
  if (options.workspacePackage) {
    const packageDirectory = join(directory, "packages", "first-party");
    const declarationFile = join(packageDirectory, "index.d.ts");
    const packageLink = join(directory, "node_modules", options.workspacePackage.name);
    mkdirSync(packageDirectory, { recursive: true });
    mkdirSync(dirname(packageLink), { recursive: true });
    writeFileSync(declarationFile, options.workspacePackage.declaration);
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: options.workspacePackage.name,
      type: "module",
      exports: "./index.d.ts",
    }));
    symlinkSync(packageDirectory, packageLink, "dir");
  }

  const program = ts.createProgram([fileName], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
  });

  return findUnboundMethodReferences(program, {
    sourceDirectory,
    repositoryDirectory: directory,
    allowlist: options.allowlist ?? [],
  });
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

  it("flags value-producing logical fallbacks", () => {
    const result = scan(`
      class Example {
        method(): void {}

        use(fallback: () => void): void {
          const throughAnd = this.method && fallback;
          const throughOr = this.method || fallback;
          const throughNullish = this.method ?? fallback;
          void throughAnd;
          void throughOr;
          void throughNullish;
        }
      }
    `);

    expect(result.findings).toHaveLength(3);
    expect(result.findings.every((finding) => finding.member === "method")).toBe(true);
  });

  it("flags a method declared by a first-party workspace package", () => {
    const result = scan(`
      import type { FirstPartyPort } from "@fixture/first-party";

      declare const port: FirstPartyPort;
      const detached = port.method;
      void detached;
    `, {
      workspacePackage: {
        name: "@fixture/first-party",
        declaration: "export interface FirstPartyPort { method(): void; arrow: () => void; }",
      },
    });

    expect(result.findings).toMatchObject([{ file: "src/fixture.ts", member: "method" }]);
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
      {
        file: "src/fixture.ts",
        member: "method",
        receiver: "primary",
        reason: "Fixture exercises the allowlist.",
      },
      {
        file: "src/fixture.ts",
        member: "removed",
        receiver: "primary",
        reason: "This entry is stale.",
      },
    ] satisfies readonly UnboundMethodAllowlistEntry[];
    const result = scan(`
      class Example {
        method(): void {}
      }

      declare const primary: Example;
      declare const secondary: Example;
      const firstDetached = primary.method;
      const secondDetached = secondary.method;
      void firstDetached;
      void secondDetached;
    `, { allowlist });

    expect(result.findings).toMatchObject([{ member: "method", receiver: "secondary" }]);
    expect(result.staleAllowlistEntries).toEqual([allowlist[1]]);
  });
});
