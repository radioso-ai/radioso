export const HUMAN_CONTACT_REQUEST_TRIGGER_REASON = 'The user asked to contact a person.'

const HUMAN_CONTACT_REQUEST_PATTERNS = [
  /\b(?:can|could|may)?\s*i\s+(?:talk|speak|chat)\s+(?:to|with)\s+(?:(?:a|an)\s+)?(?:human|person|agent|representative|someone)\b/i,
  /\bi\s+(?:want|need|would like)\s+to\s+(?:talk|speak|chat)\s+(?:to|with)\s+(?:(?:a|an)\s+)?(?:human|person|agent|representative|someone)\b/i,
  /\b(?:talk|speak|chat)\s+(?:to|with)\s+(?:(?:a|an)\s+)?(?:human|person|agent|representative|someone)\b/i,
  /\b(?:contact|connect|reach)\s+(?:me\s+)?(?:to|with)?\s*(?:(?:a|an)\s+)?(?:human|person|agent|representative|support|someone)\b/i,
  /\b(?:human|person|agent|representative)\s+(?:support|help|please)\b/i,
]

export function isHumanContactRequest(value: string) {
  const normalizedValue = value.trim()
  if (!normalizedValue || normalizedValue.length > 240) {
    return false
  }

  return HUMAN_CONTACT_REQUEST_PATTERNS.some((pattern) => pattern.test(normalizedValue))
}
