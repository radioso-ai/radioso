// Routine skill argument resolution is generic (literal / routine variable / turn
// context variable) and is owned by the shared conversation defaults package, so the
// backend and standalone kit hosts resolve authored bindings identically. This module
// stays as the routines-module entry point backend callers already import.
export { resolveSkillArguments } from "@radioso/conversation-defaults";
