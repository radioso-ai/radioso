export type {
  SteeringLifespan,
  SteeringRule,
  SteeringSource,
} from "@radioso/conversation-contract";
export {
  addressesSurface,
  appendSteeringRules,
  effectiveSurfaces,
  orderSteeringRules,
  renderSteeringRules,
  resolveRenderSurfaces,
  // Narrowing a steering set to one generation surface is a steering operation, so it
  // enters the backend through this sanctioned barrel rather than a second one.
  steeringForSurface,
  type RenderSteeringRulesOptions,
} from "@radioso/conversation-defaults";
