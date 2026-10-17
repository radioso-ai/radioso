/**
 * The voice runtimes Radioso can start a session on. One name serves every module that meets a
 * vendor: the agent's runtime binding, the workspace credential the vendor's API key is stored
 * under, and the voice channel's session starter for that vendor.
 */
export const VOICE_VENDORS = ["elevenlabs"] as const;

export type VoiceVendor = (typeof VOICE_VENDORS)[number];

/**
 * Where a voice vendor account keeps its data. The account's region decides which of the vendor's
 * hosts serves it; an account in one region is unknown to the others. `us` is the vendor's
 * default, global region.
 */
export const VOICE_VENDOR_REGIONS = ["us", "eu", "in", "sg"] as const;

export type VoiceVendorRegion = (typeof VOICE_VENDOR_REGIONS)[number];

export const DEFAULT_VOICE_VENDOR_REGION: VoiceVendorRegion = "us";

export const isVoiceVendor = (value: string): value is VoiceVendor => (VOICE_VENDORS as readonly string[]).includes(value);

export const isVoiceVendorRegion = (value: string): value is VoiceVendorRegion => (VOICE_VENDOR_REGIONS as readonly string[]).includes(value);
