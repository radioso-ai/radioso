#!/usr/bin/env -S node --experimental-strip-types
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_SECTION, MDX_SECTION, README_SECTION, WEBSITE_SECTION, buildDocuments } from "./import/buildDocuments.ts";
import { syncDocuments } from "./import/sync.ts";
import { createRadiosoDocsClient } from "./radioso/client.ts";
import {
  buildWebsitePageDocuments,
  parseWebsitePageSpec,
  websitePageExternalId,
  type WebsitePageSpec,
} from "./website/buildWebsitePageDocuments.ts";

interface CliOptions {
  dryRun: boolean;
  prune: boolean;
  includeMdx: boolean;
  includeApi: boolean;
  includeReadme: boolean;
  websitePages: WebsitePageSpec[];
}

function parseArgs(argv: string[]): CliOptions {
  const flags = new Set(argv);
  return {
    dryRun: flags.has("--dry-run"),
    prune: flags.has("--prune"),
    includeMdx: !flags.has("--no-mdx"),
    includeApi: !flags.has("--no-api"),
    includeReadme: !flags.has("--no-readme"),
    websitePages: argv.flatMap((arg, index) =>
      arg === "--website-page" ? [parseWebsitePageSpec(argv[index + 1] ?? "")] : [],
    ),
  };
}

function repoRoot(): string {
  // packages/radioso-docs-importer/src/cli.ts -> repo root is three levels up.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const citationBase = (process.env.CITATION_BASE_URL ?? "https://docs.radioso.ai").replace(/\/+$/, "");
  const repoSourceBase = (process.env.REPO_SOURCE_BASE_URL ?? "https://github.com/radioso-ai/radioso/blob/main").replace(
    /\/+$/,
    "",
  );

  const documents = await buildDocuments({
    contentDir: path.join(root, "docs-portal", "content"),
    openApiPath: path.join(root, "backend", "openapi.json"),
    repoRoot: root,
    citationBase,
    repoSourceBase,
    includeMdx: options.includeMdx,
    includeApi: options.includeApi,
    includeReadme: options.includeReadme,
  });

  documents.push(...(await buildWebsitePageDocuments(options.websitePages, citationBase)));

  console.log(`Built ${documents.length} document(s) (citation base: ${citationBase}).`);
  for (const document of documents) {
    console.log(`  - ${document.externalDocumentId} -> ${document.source.url}`);
  }

  if (options.dryRun) {
    console.log("Dry run: no documents were uploaded.");
    return;
  }

  const baseUrl = requireEnv("RADIOSO_BASE_URL");
  const apiToken = requireEnv("RADIOSO_API_TOKEN");
  const client = createRadiosoDocsClient({ baseUrl, apiToken });

  // Prune only the sections this run actually imported, so a partial import
  // (--no-mdx / --no-api) cannot delete the source set it skipped.
  const pruneSections = new Set<string>();
  if (options.includeMdx) {
    pruneSections.add(MDX_SECTION);
  }
  if (options.includeApi) {
    pruneSections.add(API_SECTION);
  }
  if (options.includeReadme) {
    pruneSections.add(README_SECTION);
  }

  if (options.websitePages.length > 0) {
    pruneSections.add(WEBSITE_SECTION);
  }

  const report = await syncDocuments(
    client,
    documents,
    {
      prune: options.prune,
      pruneSections,
      supersede: options.websitePages.map((page) => ({
        citationUrl: page.citationUrl,
        keepExternalDocumentId: websitePageExternalId(page.citationUrl),
      })),
    },
    (message) => console.log(message),
  );
  console.log(`Done: upserted ${report.upserted}, pruned ${report.pruned}, pruned sources ${report.prunedSourceIds.length}.`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
