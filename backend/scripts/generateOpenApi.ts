import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";

import { createOpenApiDocument } from "../src/app/http/openapi/openApiDocument.js";

const rootDir = path.resolve(new URL("..", import.meta.url).pathname);
const jsonPath = path.join(rootDir, "openapi.json");
const yamlPath = path.join(rootDir, "openapi.yaml");
const openApiDocument = createOpenApiDocument();

await mkdir(rootDir, { recursive: true });
await writeFile(jsonPath, JSON.stringify(openApiDocument, null, 2) + "\n", "utf8");
await writeFile(yamlPath, stringify(openApiDocument, { lineWidth: 0 }).replace(/\n*$/, "\n"), "utf8");
