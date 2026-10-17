/** Releases a body the adapter will not read, so the connection can be reused. */
export const discardBody = async (response: Response): Promise<void> => {
  await response.body?.cancel().catch(() => undefined);
};

/** A request that never got an answer: its time ran out, or the vendor could not be reached. */
export const isTimeout = (error: unknown, signal: AbortSignal): boolean =>
  signal.aborted || (error instanceof Error && error.name === "TimeoutError");

/** The body as text, or null when it is larger than `maxBytes`, declared or as it arrives. */
export const readBoundedText = async (response: Response, maxBytes: number): Promise<string | null> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await discardBody(response);
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};
