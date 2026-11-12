import { revisionTakesPhotos, type VisitorImageRevisionSwitch } from "../visitorImages/contracts/revisionSwitch.js";

/**
 * The photo switch a revision may hold (`visitorImagesEnabled` on the snapshot). The agent's own
 * setting is the draft's value and publishing freezes it into the release. Whether a revision takes
 * photos is `revisionTakesPhotos`: a revision that holds no switch takes none.
 */

/** Whether two revisions agree on taking photos. */
export const sameVisitorImagesSwitch = (left: VisitorImageRevisionSwitch, right: VisitorImageRevisionSwitch): boolean =>
  revisionTakesPhotos(left) === revisionTakesPhotos(right);

/** Whether publishing a candidate changes whether photos are taken, against its base release (none, for a first release). */
export const visitorImagesSwitchChanged = (base: VisitorImageRevisionSwitch | null, candidate: VisitorImageRevisionSwitch): boolean =>
  !sameVisitorImagesSwitch(base ?? {}, candidate);
