export type ConversationTurnStage =
  | "waiting"
  | "preparing"
  | "routing"
  | "rendering"
  | "persisting";

/**
 * How a newer turn on the same conversation cuts this one off.
 *
 * - `until_emission` (the default): a newer turn cancels this one only until it starts emitting its
 *   reply; after that the newer turn waits. A cancelled turn keeps its user message.
 * - `latest_input_wins`: for a channel whose newer request revises or overtakes the input in flight
 *   (a voice runtime re-sending a revised transcript, a caller speaking over the reply). A newer
 *   `latest_input_wins` turn cancels this one even after it started emitting, and a turn cancelled
 *   before it emitted anything leaves no user message behind, because the newer request replaces it.
 */
export type ConversationTurnSupersession = "until_emission" | "latest_input_wins";
