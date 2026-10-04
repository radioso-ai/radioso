// A tool call and the descriptor it validated against are routine data; the routines
// module owns their shapes and the chat module carries them through the turn unread.
export type {
  AgentToolCatalogPort,
  AgentToolDescriptor,
  RoutineInvocation,
} from "../../routines/public.js";
