/**
 * Out-of-tree source text for the facet-quality fixture (spec 956).
 *
 * The visitor messages behind that fixture are real pre-production traffic to a
 * customer workspace. The gate never reads them — it clusters the embeddings in
 * `tests/fixtures/facet-quality/recorded.json` against the labels in
 * `questions.ts` — so the text is not committed. The record scripts do need it,
 * and read it from an operator-supplied corpus keyed by fixture id:
 *
 *     { "bok-01": "where is the calendar of courses at the center", ... }
 *
 * Default location is `.context/facet-fixture/questions.source.json`, which is
 * gitignored; override with `FACET_QUALITY_SOURCE_TEXT`. Recording from a clean
 * clone therefore requires the operator to supply the corpus out of band.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SOURCE_TEXT_ENV = "FACET_QUALITY_SOURCE_TEXT";
export const FACETS_SIDECAR_ENV = "FACET_QUALITY_FACETS_SIDECAR";

const defaultPath = (fileName: string): string =>
  fileURLToPath(new URL(`../../../.context/facet-fixture/${fileName}`, import.meta.url));

const readIdMap = (path: string, what: string): Map<string, string> => {
  if (!existsSync(path)) {
    throw new Error(
      `No facet-quality ${what} at ${path}. This corpus is deliberately not committed; ` +
        `point ${SOURCE_TEXT_ENV} at your local copy.`,
    );
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  return new Map(Object.entries(parsed));
};

/** Question text for `ids`, in the order given. Throws if the corpus is missing any id. */
export const loadSourceText = (ids: readonly string[]): string[] => {
  const path = process.env[SOURCE_TEXT_ENV] ?? defaultPath("questions.source.json");
  const byId = readIdMap(path, "source corpus");
  return ids.map((id) => {
    const text = byId.get(id);
    if (text === undefined) {
      throw new Error(`Source corpus at ${path} has no question for ${id}`);
    }
    return text;
  });
};

const sidecarPath = (): string => process.env[FACETS_SIDECAR_ENV] ?? defaultPath("facets.recorded.json");

/** Extracted facets for `ids`, in the order given. Throws if the sidecar is missing any id. */
export const loadRecordedFacets = (ids: readonly string[], explicitPath?: string): string[] => {
  const path = explicitPath ?? sidecarPath();
  const byId = readIdMap(path, "facet sidecar");
  return ids.map((id) => {
    const facet = byId.get(id);
    if (facet === undefined) {
      throw new Error(`Facet sidecar at ${path} has no facet for ${id}`);
    }
    return facet;
  });
};

/**
 * Persists extracted facets outside the committed recording so `--reuse` can skip
 * re-paying for extraction. Facets are model-written summaries of the source text
 * and carry the same customer detail, so they stay out of the repository too.
 */
export const writeRecordedFacets = (ids: readonly string[], facets: readonly string[]): string => {
  const path = sidecarPath();
  const byId = Object.fromEntries(ids.map((id, index) => [id, facets[index]]));
  writeFileSync(path, `${JSON.stringify(byId, null, 2)}\n`, "utf8");
  return path;
};
