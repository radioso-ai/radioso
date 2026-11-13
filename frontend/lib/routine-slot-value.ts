/**
 * A routine slot value as an editable text field shows it. Values are `unknown`: a routine holds
 * strings, numbers and booleans, a picked card for an item slot (#1763), and older structured
 * values. A card reads as its title, as everywhere a scalar is expected; any other object or list
 * is shown as JSON rather than `[object Object]`.
 */
export const formatSlotValue = (raw: unknown): string => {
  if (raw === undefined || raw === null) return ''
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const { key, title } = raw as { key?: unknown; title?: unknown }
    if (typeof key === 'string' && typeof title === 'string') return title
  }
  try {
    return JSON.stringify(raw)
  } catch {
    return ''
  }
}
