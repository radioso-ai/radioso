/**
 * Application-wiring entry point for the visitors module. `VisitorRepository`
 * lives beside the other Kysely repositories (`db/repositories/visitorRepository.ts`),
 * matching `ConversationRepository`; re-exported here so composition never reaches
 * past this module's boundary to wire the domain service.
 */
export { VisitorRepository } from "../../db/repositories/visitorRepository.js";
export { VisitorResolver } from "./services/visitorResolver.js";
