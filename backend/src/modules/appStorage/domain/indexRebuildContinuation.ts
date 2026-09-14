/**
 * What a bounded rebuild hands back when its batch budget runs out before the
 * index converges, and what a later call presents to keep the same rebuild
 * moving instead of rescanning the collection from its first key.
 *
 * It names the run rather than any progress summary of it: the generation
 * identifies which marker it belongs to, the pass says which of the rebuild's
 * two sweeps was interrupted, and `after` is that sweep's own cursor. Nothing
 * here is a stored value — a caller that inspects the token learns only where
 * the scan stopped, never what it found there.
 */
export interface AppStorageIndexRebuildContinuation {
  workspaceId: string;
  installationId: string;
  collectionId: string;
  indexId: string;
  generation: number;
  /** Which of the rebuild's two sweeps `after` belongs to. */
  pass: "first" | "convergence";
  after: string | null;
  /** The collection's next version when the rebuild began — the convergence sweep's own filter. */
  startVersion: number;
}

const isRebuildPass = (value: unknown): value is AppStorageIndexRebuildContinuation["pass"] =>
  value === "first" || value === "convergence";

const isContinuation = (value: unknown): value is AppStorageIndexRebuildContinuation => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.workspaceId === "string" &&
    typeof candidate.installationId === "string" &&
    typeof candidate.collectionId === "string" &&
    typeof candidate.indexId === "string" &&
    typeof candidate.generation === "number" &&
    Number.isInteger(candidate.generation) &&
    isRebuildPass(candidate.pass) &&
    (candidate.after === null || typeof candidate.after === "string") &&
    typeof candidate.startVersion === "number" &&
    Number.isInteger(candidate.startVersion)
  );
};

/**
 * Opaque to callers by convention rather than by construction. Encoding it as
 * readable JSON underneath keeps a rebuild that is stuck diagnosable from the
 * token itself; a caller is not meant to build or read one, only pass it back.
 */
export const encodeIndexRebuildContinuation = (
  continuation: AppStorageIndexRebuildContinuation,
): string => Buffer.from(JSON.stringify(continuation), "utf8").toString("base64url");

/**
 * Never throws. A token a caller mangled, one built for a different rebuild,
 * and one naming a generation the marker has since moved past are the same
 * thing from here: none of them can be honored, and the caller's cue in every
 * case is to start the rebuild over.
 */
export const decodeIndexRebuildContinuation = (
  token: string,
): AppStorageIndexRebuildContinuation | null => {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    return isContinuation(decoded) ? decoded : null;
  } catch {
    return null;
  }
};
