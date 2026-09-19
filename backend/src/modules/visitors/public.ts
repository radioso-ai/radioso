/**
 * Public entry point for the visitors module. Other modules (chat) must import
 * from here, never from internal files, per the module-boundary lint.
 */
export type { VisitorResolverPort } from "./services/visitorResolver.js";
