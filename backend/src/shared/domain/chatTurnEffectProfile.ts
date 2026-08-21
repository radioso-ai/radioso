/** Cross-module turn policy. `probe` may compute diagnostics but cannot invoke live effects. */
export type ChatTurnEffectProfile = "live" | "probe";
