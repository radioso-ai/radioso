/**
 * About how much of a reply the caller heard before speaking over it, as a whole percentage. The
 * share is rounded down and stays below 100 while any of the reply went unheard, so a cut reply
 * never reads as fully heard. Undefined when nothing was spoken, so there is no share to state.
 */
export const heardPercent = (heardCharacterCount: number, spokenCharacterCount: number): number | undefined => {
  if (spokenCharacterCount <= 0) {
    return undefined
  }
  if (heardCharacterCount >= spokenCharacterCount) {
    return 100
  }
  return Math.min(99, Math.max(0, Math.floor((heardCharacterCount / spokenCharacterCount) * 100)))
}
