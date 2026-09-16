export type { SteeringRule } from "@radioso/conversation-contract";
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
export {
  // Narrowing a steering set to an already-known coverage verdict is likewise a
  // steering operation; the engine owns the criteria semantics, the backend only
  // applies them where a generator runs after the verdict exists.
  steeringForKnownVerdict,
} from "@radioso/conversation-engine";
