import type { VoiceSessionStartResult } from "../../../modules/voiceChannel/public.js";

/**
 * A started voice session as a page receives it, from the website embed's start or Test Chat's: the
 * vendor's signed URL (a bearer credential, so the response is never cached), the session key and
 * what the call opens with. Never the vendor key.
 */
export const presentStartedVoiceSession = (result: Extract<VoiceSessionStartResult, { kind: "started" }>) => ({
  vendor: result.vendor,
  signedUrl: result.signedUrl,
  sessionKey: result.sessionKey,
  locale: result.locale,
  ...(result.expiresAt ? { expiresAt: result.expiresAt.toISOString() } : {}),
  ...(result.recordingNotice ? { recordingNotice: result.recordingNotice } : {}),
  ...(result.firstMessage ? { firstMessage: result.firstMessage } : {}),
  ...(result.vendorLanguage ? { vendorLanguage: result.vendorLanguage } : {}),
});
