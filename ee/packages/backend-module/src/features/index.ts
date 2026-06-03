import {
  collectFrontendRouteContributions,
  validateFeatureManifests,
  type FeatureManifest,
} from "../featureManifest.js";
import { usageLimitsFeatureManifest } from "../usageLimits/featureManifest.js";

export const enterpriseFeatureManifests: FeatureManifest[] = [
  usageLimitsFeatureManifest,
];

export const validateEnterpriseFeatureManifests = (existingDocs?: Set<string>) =>
  validateFeatureManifests(enterpriseFeatureManifests, { existingDocs });

export const enterpriseFrontendRouteContributions =
  collectFrontendRouteContributions(enterpriseFeatureManifests);
