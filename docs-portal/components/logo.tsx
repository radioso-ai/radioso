import Image from 'next/image'

export function Logo() {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.75rem',
        fontWeight: 650,
        letterSpacing: '-0.02em',
      }}
    >
      <Image alt="Radioso" src="/radioso-icon.svg" width={28} height={28} priority />
      <span>Radioso Docs</span>
    </span>
  )
}
