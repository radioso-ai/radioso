export type FeatureEdition = "oss" | "enterprise";

export interface FrontendRouteContribution {
  relativePath: string;
  packageName: string;
  exportPath: string;
  exports: string[];
  runtime?: "nodejs" | "edge";
  dynamic?: "auto" | "force-dynamic" | "force-static" | "error";
}

export interface FeatureManifest {
  id: string;
  name: string;
  edition: FeatureEdition;
  backendModuleId?: string;
  apiNamespaces?: string[];
  frontendRoutes?: FrontendRouteContribution[];
  docs?: string[];
}

export interface ManifestValidationOptions {
  existingDocs?: Set<string>;
}

export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
}

const featureIdPattern = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const routePathPattern = /^app\/.+\.(tsx|ts)$/;

export const validateFeatureManifests = (
  manifests: FeatureManifest[],
  options: ManifestValidationOptions = {},
): ManifestValidationResult => {
  const errors: string[] = [];
  const featureIds = new Set<string>();
  const frontendRoutes = new Map<string, string>();

  for (const manifest of manifests) {
    if (!featureIdPattern.test(manifest.id)) {
      errors.push(`Feature id "${manifest.id}" must be kebab-case and 3-64 characters`);
    }

    if (featureIds.has(manifest.id)) {
      errors.push(`Duplicate feature id "${manifest.id}"`);
    }
    featureIds.add(manifest.id);

    if (manifest.edition === "enterprise") {
      for (const route of manifest.frontendRoutes ?? []) {
        if (!route.packageName.startsWith("@radioso/enterprise-")) {
          errors.push(`Enterprise feature "${manifest.id}" route "${route.relativePath}" must use an Enterprise package`);
        }
      }
    }

    for (const route of manifest.frontendRoutes ?? []) {
      if (!routePathPattern.test(route.relativePath)) {
        errors.push(`Feature "${manifest.id}" route "${route.relativePath}" must be a generated app route file`);
      }
      if (route.exports.length === 0) {
        errors.push(`Feature "${manifest.id}" route "${route.relativePath}" must declare at least one export`);
      }

      const previousOwner = frontendRoutes.get(route.relativePath);
      if (previousOwner && previousOwner !== manifest.id) {
        errors.push(`Frontend route "${route.relativePath}" is owned by multiple features`);
      }
      frontendRoutes.set(route.relativePath, manifest.id);
    }

    if (options.existingDocs) {
      for (const doc of manifest.docs ?? []) {
        if (!options.existingDocs.has(doc)) {
          errors.push(`Feature "${manifest.id}" references missing doc "${doc}"`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
};

export const collectFrontendRouteContributions = (
  manifests: FeatureManifest[],
): FrontendRouteContribution[] =>
  manifests.flatMap((manifest) => manifest.frontendRoutes ?? []);
