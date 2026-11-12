/**
 * A revision's photo switch, as an agent revision snapshot holds it (`visitorImagesEnabled`). The
 * agent's setting is the draft's value and publishing freezes it; a Test Chat test names the switch
 * of the revisions it runs, and every live channel follows the published revision's.
 */
export interface VisitorImageRevisionSwitch {
  readonly visitorImagesEnabled?: boolean;
}

/**
 * Whether a revision takes photos: only one that turns them on. A revision that holds no switch,
 * or no revision at all (an agent never published), takes none.
 */
export const revisionTakesPhotos = (revision: VisitorImageRevisionSwitch | null | undefined): boolean =>
  revision?.visitorImagesEnabled === true;
