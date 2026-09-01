import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);

export const cleanBuildOutput = async (distRoot = path.join(process.cwd(), "dist")) => {
  await rm(distRoot, { recursive: true, force: true });
};

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await cleanBuildOutput();
}
