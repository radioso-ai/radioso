/**
 * The voice runtimes Radioso can start a session on. One name serves every module that meets a
 * vendor: the agent's runtime binding, the workspace credential the vendor's API key is stored
 * under, and the voice channel's session starter for that vendor.
 */
export const VOICE_VENDORS = ["elevenlabs"] as const;

export type VoiceVendor = (typeof VOICE_VENDORS)[number];
