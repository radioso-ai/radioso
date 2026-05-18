import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const manifestModulePaths = [
  "ee/packages/auth-frontend/feature-manifest.mjs",
  "ee/packages/agent-wizard-frontend/feature-manifest.mjs",
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

export const collectFrontendComponentContributions = (manifests) =>
  manifests.flatMap((manifest) => manifest.frontendComponents ?? []);

export const collectFrontendAgentCreationActionContributions = (manifests) =>
  manifests.flatMap((manifest) => manifest.frontendAgentCreationActions ?? []);

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
      const relativePath = route?.relativePath;
      const routeLabel = typeof relativePath === "string" && relativePath.length > 0
        ? relativePath
        : "<missing>";
      const packageName = route?.packageName;
      const exportPath = route?.exportPath;

      if (typeof relativePath !== "string" || relativePath.length === 0 || !relativePath.startsWith("app/") || !/\.(ts|tsx)$/.test(relativePath)) {
        errors.push(`Feature "${manifest.id}" route "${routeLabel}" must be a generated app route file`);
      }
      if (typeof packageName !== "string" || packageName.length === 0) {
        errors.push(`Feature "${manifest.id}" route "${routeLabel}" must declare packageName`);
      } else if (!packageName.startsWith("@radioso/enterprise-")) {
        errors.push(`Feature "${manifest.id}" route "${routeLabel}" must use an Enterprise package`);
      }
      if (typeof exportPath !== "string" || exportPath.length === 0) {
        errors.push(`Feature "${manifest.id}" route "${routeLabel}" must declare exportPath`);
      }
      if (!Array.isArray(route.exports) || route.exports.length === 0) {
        errors.push(`Feature "${manifest.id}" route "${routeLabel}" must declare at least one export`);
      }
      const exportedPaths = typeof packageName === "string" && typeof exportPath === "string"
        ? packageExports.get(packageName)
        : undefined;
      if (exportedPaths && !exportedPaths.has(`./${exportPath}`)) {
        errors.push(`Feature "${manifest.id}" route "${routeLabel}" references missing package export "${packageName}/${exportPath}"`);
      }
      if (typeof relativePath === "string" && routes.has(relativePath)) {
        errors.push(`Frontend route "${relativePath}" is owned by multiple features`);
      }
      if (typeof relativePath === "string") {
        routes.set(relativePath, manifest.id);
      }
    }

    for (const action of manifest.frontendAgentCreationActions ?? []) {
      const actionLabel = typeof action?.id === "string" && action.id.length > 0
        ? action.id
        : "<missing>";
      if (typeof action?.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(action.id)) {
        errors.push(`Feature "${manifest.id}" agent creation action "${actionLabel}" must declare a kebab-case id`);
      }
      if (typeof action?.label !== "string" || action.label.length === 0) {
        errors.push(`Feature "${manifest.id}" agent creation action "${actionLabel}" must declare label`);
      }
      if (action?.icon !== "globe") {
        errors.push(`Feature "${manifest.id}" agent creation action "${actionLabel}" must use a supported icon`);
      }
      const kind = typeof action?.kind === "string" ? action.kind : "route";
      if (kind === "route") {
        if (typeof action?.hrefTemplate !== "string" || !action.hrefTemplate.startsWith("/")) {
          errors.push(`Feature "${manifest.id}" agent creation action "${actionLabel}" must declare a root-relative hrefTemplate`);
        }
      } else if (kind !== "wizard-dialog") {
        errors.push(`Feature "${manifest.id}" agent creation action "${actionLabel}" has unsupported kind "${kind}"`);
      }
    }

    for (const component of manifest.frontendComponents ?? []) {
      const componentLabel = typeof component?.relativePath === "string" && component.relativePath.length > 0
        ? component.relativePath
        : "<missing>";
      if (typeof component?.relativePath !== "string" || !component.relativePath.startsWith("lib/") || !/\.(ts|tsx)$/.test(component.relativePath)) {
        errors.push(`Feature "${manifest.id}" component "${componentLabel}" must be a generated lib file`);
      }
      if (typeof component?.packageName !== "string" || !component.packageName.startsWith("@radioso/enterprise-")) {
        errors.push(`Feature "${manifest.id}" component "${componentLabel}" must use an Enterprise package`);
      }
      if (typeof component?.exportPath !== "string" || component.exportPath.length === 0) {
        errors.push(`Feature "${manifest.id}" component "${componentLabel}" must declare exportPath`);
      }
      if (!Array.isArray(component?.exports) || component.exports.length === 0) {
        errors.push(`Feature "${manifest.id}" component "${componentLabel}" must declare at least one export`);
      }
      const exportedPaths = typeof component?.packageName === "string" && typeof component?.exportPath === "string"
        ? packageExports.get(component.packageName)
        : undefined;
      if (exportedPaths && !exportedPaths.has(`./${component.exportPath}`)) {
        errors.push(`Feature "${manifest.id}" component "${componentLabel}" references missing package export "${component.packageName}/${component.exportPath}"`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
};

const readEnterprisePackageExports = async () => {
  const exportsByPackage = new Map();
  for (const packageJsonPath of [
    "ee/packages/auth-frontend/package.json",
    "ee/packages/agent-wizard-frontend/package.json",
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
