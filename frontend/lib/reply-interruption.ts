/**
 * About how much of a reply the caller heard before speaking over it, as a whole percentage from 0
 * to 100. Undefined when nothing was spoken, so there is no share to state.
 */
export const heardPercent = (heardCharacterCount: number, spokenCharacterCount: number): number | undefined =>
  spokenCharacterCount > 0
    ? Math.min(100, Math.max(0, Math.round((heardCharacterCount / spokenCharacterCount) * 100)))
    : undefined
