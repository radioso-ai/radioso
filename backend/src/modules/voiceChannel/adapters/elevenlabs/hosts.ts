import type { VoiceVendorRegion } from "../../../../shared/domain/voiceVendor.js";

/**
 * The ElevenLabs host that serves an account in each data residency region, as ElevenLabs
 * documents them. Every request for an account goes to its region's host: the session start, the
 * check of a reported conversation, and the call's recording, which the vendor keeps in that region.
 */
export const ELEVENLABS_API_HOST_OF_REGION: Readonly<Record<VoiceVendorRegion, string>> = {
  us: "api.elevenlabs.io",
  eu: "api.eu.residency.elevenlabs.io",
  in: "api.in.residency.elevenlabs.io",
  sg: "api.sg.residency.elevenlabs.io",
};
