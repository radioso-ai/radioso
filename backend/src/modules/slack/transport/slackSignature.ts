import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Slack signs every request (Events API and Interactivity) with the same HMAC-SHA256 scheme
 * and replay window, so the verifier lives in the shared Slack module rather than inside one
 * transport adapter. Both the connector events webhook and the operator interactivity router
 * depend on this single implementation via `slack/public`.
 */
export const SLACK_SIGNATURE_REPLAY_WINDOW_SECONDS = 5 * 60;

export const isValidSlackSignature = (input: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  signingSecret: string;
  nowMs?: number;
}): boolean => {
  const signature = input.signatureHeader;
  const timestamp = input.timestampHeader;
  if (!signature?.startsWith("v0=") || !timestamp) {
    return false;
  }
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > SLACK_SIGNATURE_REPLAY_WINDOW_SECONDS) {
    return false;
  }
  const base = `v0:${timestamp}:${input.rawBody.toString("utf8")}`;
  const expected = `v0=${createHmac("sha256", input.signingSecret).update(base).digest("hex")}`;
  if (signature.length !== expected.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
};
