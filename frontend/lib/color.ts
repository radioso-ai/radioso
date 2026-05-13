export type Rgb = { r: number; g: number; b: number }

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const normalizeHex = (hex: string): string | null => {
  const trimmed = hex.trim().replace(/^#/, '')
  if (trimmed.length === 3) {
    return trimmed
      .split('')
      .map((char) => char + char)
      .join('')
      .toLowerCase()
  }
  if (trimmed.length === 6) {
    return trimmed.toLowerCase()
  }
  return null
}

export const parseHex = (hex: string): Rgb | null => {
  const normalized = normalizeHex(hex)
  if (!normalized || !/^[0-9a-f]{6}$/.test(normalized)) {
    return null
  }
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  }
}

export const rgbToHex = ({ r, g, b }: Rgb): string => {
  const toHex = (component: number) =>
    clamp(Math.round(component), 0, 255).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

export const mixHex = (a: string, b: string, weight: number): string => {
  const aRgb = parseHex(a)
  const bRgb = parseHex(b)
  if (!aRgb || !bRgb) {
    return a
  }
  const w = clamp(weight, 0, 1)
  return rgbToHex({
    r: aRgb.r * (1 - w) + bRgb.r * w,
    g: aRgb.g * (1 - w) + bRgb.g * w,
    b: aRgb.b * (1 - w) + bRgb.b * w,
  })
}

export const mixHexRgba = (a: string, b: string, weight: number, alpha: number): string => {
  const aRgb = parseHex(a)
  const bRgb = parseHex(b)
  if (!aRgb || !bRgb) {
    return a
  }
  const w = clamp(weight, 0, 1)
  const r = Math.round(aRgb.r * (1 - w) + bRgb.r * w)
  const g = Math.round(aRgb.g * (1 - w) + bRgb.g * w)
  const blue = Math.round(aRgb.b * (1 - w) + bRgb.b * w)
  return `rgba(${r}, ${g}, ${blue}, ${clamp(alpha, 0, 1)})`
}

const channelLuminance = (channel: number) => {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export const relativeLuminance = (hex: string): number => {
  const rgb = parseHex(hex)
  if (!rgb) return 0
  return (
    0.2126 * channelLuminance(rgb.r) +
    0.7152 * channelLuminance(rgb.g) +
    0.0722 * channelLuminance(rgb.b)
  )
}

export const contrastRatio = (a: string, b: string): number => {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

export const pickForeground = (
  background: string,
  options: { light?: string; dark?: string } = {},
): string => {
  const light = options.light ?? '#ffffff'
  const dark = options.dark ?? '#0f172a'
  return contrastRatio(background, light) >= contrastRatio(background, dark) ? light : dark
}

export const isLightHex = (hex: string): boolean => relativeLuminance(hex) >= 0.5
