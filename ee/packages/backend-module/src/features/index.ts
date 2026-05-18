import {
  collectFrontendRouteContributions,
  validateFeatureManifests,
  type FeatureManifest,
} from "../featureManifest.js";
import { answerFeedbackFeatureManifest } from "../answerFeedback/featureManifest.js";
import { humanContactFeatureManifest } from "../humanContact/featureManifest.js";
import { usageLimitsFeatureManifest } from "../usageLimits/featureManifest.js";

export const enterpriseFeatureManifests: FeatureManifest[] = [
  usageLimitsFeatureManifest,
  humanContactFeatureManifest,
  answerFeedbackFeatureManifest,
];

export const validateEnterpriseFeatureManifests = (existingDocs?: Set<string>) =>
  validateFeatureManifests(enterpriseFeatureManifests, { existingDocs });

export const enterpriseFrontendRouteContributions =
  collectFrontendRouteContributions(enterpriseFeatureManifests);
