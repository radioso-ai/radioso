import type { FeatureManifest } from "../featureManifest.js";

export const answerFeedbackFeatureManifest: FeatureManifest = {
  id: "enterprise-answer-feedback",
  name: "Enterprise Answer Feedback",
  edition: "enterprise",
  backendModuleId: "radioso-enterprise-answer-feedback",
  apiNamespaces: ["/api/v1/ee/answer-feedback"],
  docs: ["ee/readme.md"],
};
