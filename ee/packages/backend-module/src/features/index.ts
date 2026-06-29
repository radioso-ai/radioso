import {
  collectFrontendRouteContributions,
  validateFeatureManifests,
  type FeatureManifest,
} from "../featureManifest.js";
import { usageLimitsFeatureManifest } from "../usageLimits/featureManifest.js";
import { staffConsoleFeatureManifest } from "../staffConsole/featureManifest.js";

export const enterpriseFeatureManifests: FeatureManifest[] = [
  usageLimitsFeatureManifest,
  staffConsoleFeatureManifest,
];

export const validateEnterpriseFeatureManifests = (existingDocs?: Set<string>) =>
  validateFeatureManifests(enterpriseFeatureManifests, { existingDocs });

export const enterpriseFrontendRouteContributions =
  collectFrontendRouteContributions(enterpriseFeatureManifests);
