/**
 * The photo switch a revision may hold (`visitorImagesEnabled` on the snapshot). The agent's own
 * setting is the draft's value and publishing freezes it into the release; a release frozen
 * before the switch was part of one holds none and follows the agent's setting.
 */
interface VisitorImagesSwitch {
  visitorImagesEnabled?: boolean;
}

/** Whether a revision takes photos: its own switch, or the agent's setting for one that holds none. */
export const revisionVisitorImagesEnabled = (snapshot: VisitorImagesSwitch, agentSetting: boolean): boolean =>
  snapshot.visitorImagesEnabled ?? agentSetting;

/**
 * Whether two revisions' photo switches agree. A switch a revision does not hold is the agent's
 * setting, which a draft always holds, so it agrees with whatever the other side holds.
 */
export const sameVisitorImagesSwitch = (left: VisitorImagesSwitch, right: VisitorImagesSwitch): boolean =>
  left.visitorImagesEnabled === undefined || right.visitorImagesEnabled === undefined || left.visitorImagesEnabled === right.visitorImagesEnabled;

/** Whether publishing a candidate changes the photo switch of its base release: any switch, for a first release. */
export const visitorImagesSwitchChanged = (base: VisitorImagesSwitch | null, candidate: VisitorImagesSwitch): boolean =>
  candidate.visitorImagesEnabled !== undefined && (base === null || !sameVisitorImagesSwitch(base, candidate));
