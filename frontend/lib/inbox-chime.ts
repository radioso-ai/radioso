/**
 * A soft, short (~0.2s) arrival chime for new inbox items, built from the Web
 * Audio API rather than an audio asset file: one oscillator with a brief
 * attack/decay gain envelope.
 *
 * Browsers that block audio before a user gesture reject `AudioContext`
 * construction or `start()`; that rejection — and any other runtime failure,
 * such as this environment lacking `AudioContext` entirely — is swallowed. A
 * missed chime is not worth surfacing as an error.
 */
export const playInboxChime = (): void => {
  try {
    const AudioContextCtor = window.AudioContext
      ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) {
      return
    }

    const context = new AudioContextCtor()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = 880
    const now = context.currentTime
    const duration = 0.2
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(0.12, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(now)
    oscillator.stop(now + duration + 0.02)
    oscillator.onended = () => {
      void context.close().catch(() => {})
    }
  } catch {
    // Autoplay policy rejection or missing Web Audio API support.
  }
}
