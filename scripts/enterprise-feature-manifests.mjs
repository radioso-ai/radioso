import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const manifestModulePaths = [
  "ee/packages/auth-frontend/feature-manifest.mjs",
  "ee/packages/embed-widget/feature-manifest.mjs",
];

export const loadEnterpriseFeatureManifests = async () => {
  const manifests = [];
  for (const relativePath of manifestModulePaths) {
    const moduleUrl = new URL(`../${relativePath}`, import.meta.url);
    const loaded = await import(moduleUrl.href);
    manifests.push(loaded.featureManifest);
  }
  return manifests;
};

export const collectFrontendRouteContributions = (manifests) =>
  manifests.flatMap((manifest) => manifest.frontendRoutes ?? []);

export const collectGeneratedDirectories = (routes) => {
  const directories = new Set();
  for (const route of routes) {
    const parts = route.relativePath.split("/");
    const minimumDirectoryDepth = parts[1] === "api" ? 3 : 2;
    for (let index = parts.length - 1; index >= minimumDirectoryDepth; index -= 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return [...directories].sort((a, b) => b.length - a.length);
};

export const validateFeatureManifests = async (manifests, options = {}) => {
  const errors = [];
  const featureIds = new Set();
  const routes = new Map();
  const existingDocs = options.existingDocs ?? await findExistingDocs();
  const packageExports = options.packageExports ?? await readEnterprisePackageExports();

  for (const manifest of manifests) {
    if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(manifest.id)) {
      errors.push(`Feature id "${manifest.id}" must be kebab-case and 3-64 characters`);
    }
    if (featureIds.has(manifest.id)) {
      errors.push(`Duplicate feature id "${manifest.id}"`);
    }
    featureIds.add(manifest.id);

    for (const doc of manifest.docs ?? []) {
      if (!existingDocs.has(doc)) {
        errors.push(`Feature "${manifest.id}" references missing doc "${doc}"`);
      }
    }

    for (const route of manifest.frontendRoutes ?? []) {
      if (!route.relativePath.startsWith("app/") || !/\.(ts|tsx)$/.test(route.relativePath)) {
        errors.push(`Feature "${manifest.id}" route "${route.relativePath}" must be a generated app route file`);
      }
      if (!route.packageName?.startsWith("@radioso/enterprise-")) {
        errors.push(`Feature "${manifest.id}" route "${route.relativePath}" must use an Enterprise package`);
      }
      if (!Array.isArray(route.exports) || route.exports.length === 0) {
        errors.push(`Feature "${manifest.id}" route "${route.relativePath}" must declare at least one export`);
      }
      const exportedPaths = packageExports.get(route.packageName);
      if (exportedPaths && !exportedPaths.has(`./${route.exportPath}`)) {
        errors.push(`Feature "${manifest.id}" route "${route.relativePath}" references missing package export "${route.packageName}/${route.exportPath}"`);
      }
      if (routes.has(route.relativePath)) {
        errors.push(`Frontend route "${route.relativePath}" is owned by multiple features`);
      }
      routes.set(route.relativePath, manifest.id);
    }
  }

  return { valid: errors.length === 0, errors };
};

const readEnterprisePackageExports = async () => {
  const exportsByPackage = new Map();
  for (const packageJsonPath of [
    "ee/packages/auth-frontend/package.json",
    "ee/packages/embed-widget/package.json",
  ]) {
    try {
      const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, packageJsonPath), "utf8"));
      exportsByPackage.set(packageJson.name, new Set(Object.keys(packageJson.exports ?? {})));
    } catch {
      // Missing package metadata is ignored here. Build/install commands report
      // absent Enterprise packages in contexts that need them.
    }
  }
  return exportsByPackage;
};

const findExistingDocs = async () => {
  const docs = new Set();
  for (const relativePath of [
    "ee/readme.md",
    "readme.md",
    "docs-portal/content/quickstarts/website-embed.mdx",
  ]) {
    try {
      await fs.access(path.join(repoRoot, relativePath));
      docs.add(relativePath);
    } catch {
      // Missing docs are reported by validation when referenced.
    }
  }
  return docs;
};
