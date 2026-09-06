import type { Env } from "./env.js";

/**
 * What the running image says it is.
 *
 * A release names a commit, and a deploy stamps that name onto the image it ships, so two
 * stacks running different releases cannot report the same identity. `/health` is where an
 * operator reads it back.
 */
type BuildIdentity = {
  version: string;
  commit: string;
};

export const readBuildIdentity = (
  env: Pick<Env, "RADIOSO_RELEASE" | "RADIOSO_COMMIT">,
): BuildIdentity => ({
  version: env.RADIOSO_RELEASE,
  commit: env.RADIOSO_COMMIT,
});
