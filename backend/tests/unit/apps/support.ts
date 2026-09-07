import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { appManifestSchema, type AppManifest } from "@radioso/app-contract";

const fixturePath = fileURLToPath(
  new URL("../../../../packages/app-contract/fixtures/reference/wordpress.manifest.json", import.meta.url),
);

/** The reference manifest every Apps test uses as its sample release. */
export const wordpressManifestDocument = (): Record<string, unknown> =>
  JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;

export const wordpressManifest = (): AppManifest => appManifestSchema.parse(wordpressManifestDocument());

/** Both digests the reference manifest references, as a built-in registry would vouch for them. */
export const wordpressArtifactCatalogue = (): ReadonlySet<string> => {
  const manifest = wordpressManifest();
  return new Set([
    manifest.artifact.digest,
    ...(manifest.companionAssets ?? []).map((asset) => asset.digest),
  ]);
};
