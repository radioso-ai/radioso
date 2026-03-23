import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const parserRequire = createRequire(import.meta.url);

const isMissingModuleError = (error, packageName) =>
  error instanceof Error &&
  "code" in error &&
  error.code === "MODULE_NOT_FOUND" &&
  error.message.includes(`'${packageName}'`);

const candidateRequirePaths = () => {
  const candidates = new Set();
  const addPackageJsonPath = (startDir) => {
    let current = resolve(startDir);

    while (true) {
      const packageJsonPath = resolve(current, "package.json");
      if (existsSync(packageJsonPath)) {
        candidates.add(packageJsonPath);
      }

      const parent = dirname(current);
      if (parent === current) {
        break;
      }

      current = parent;
    }
  };

  addPackageJsonPath(dirname(fileURLToPath(import.meta.url)));

  if (process.argv[1]) {
    addPackageJsonPath(dirname(process.argv[1]));
  }

  addPackageJsonPath(process.cwd());

  return [...candidates];
};

export const loadDependency = (packageName) => {
  try {
    return parserRequire(packageName);
  } catch (error) {
    if (!isMissingModuleError(error, packageName)) {
      throw error;
    }
  }

  for (const packageJsonPath of candidateRequirePaths()) {
    try {
      return createRequire(packageJsonPath)(packageName);
    } catch (error) {
      if (!isMissingModuleError(error, packageName)) {
        throw error;
      }
    }
  }

  throw new Error(`Unable to resolve parser dependency '${packageName}'`);
};
