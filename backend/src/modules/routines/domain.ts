export * from "@radioso/routine-definition";
// Resolving an authored input binding (literal / routine variable / turn context
// variable) into skill arguments is shared with every host that embeds the
// conversation engine, so it is owned by conversation-defaults and enters the
// backend through this barrel rather than per call site.
export { resolveSkillArguments } from "@radioso/conversation-defaults";
