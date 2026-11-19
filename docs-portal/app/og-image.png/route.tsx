import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ImageResponse } from 'next/og'

import { ogImage, site } from '@/lib/site'

// Raster OG card generated at build time. Social platforms do not render SVG
// og:image, so the lockup SVG is rasterized into this card rather than
// referenced directly.
//
// This is a route handler at `/og-image.png` rather than the `opengraph-image`
// file convention on purpose: the convention emits an extensionless artifact
// (`out/opengraph-image`) and a static CDN host types responses by file
// extension, so crawlers would be served `application/octet-stream`.
export const dynamic = 'force-static'

// The marketing site's social card palette (radioso.ai `scripts/generate-og.mjs`):
// cream ground, a sun-yellow wash top right, a blue wash bottom left.
const CREAM = '#f9f9f7'
const INK = '#142317'
const MUTED = '#6a706b'
const YELLOW = '#ffc720'
const BLUE = '#5096e7'
// Each wash fades to its own hue at zero alpha; fading to `transparent` (black)
// greys the middle of the card.
const YELLOW_WASH = 'rgba(255, 199, 32, 0.24) 0%, rgba(255, 199, 32, 0) 60%'
const BLUE_WASH = 'rgba(80, 150, 231, 0.2) 0%, rgba(80, 150, 231, 0) 60%'

const LOCKUP_HEIGHT = 84
const LOCKUP_WIDTH = Math.round((LOCKUP_HEIGHT * 1173) / 300)

export async function GET() {
  const lockup = await readFile(join(process.cwd(), 'public', 'radioso-lockup.svg'))
  const lockupSrc = `data:image/svg+xml;base64,${lockup.toString('base64')}`

  return new ImageResponse(
    (
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          backgroundColor: CREAM,
          padding: '72px 80px',
        }}
      >
        <Wash background={`radial-gradient(circle at 88% 10%, ${YELLOW_WASH})`} />
        <Wash background={`radial-gradient(circle at 8% 95%, ${BLUE_WASH})`} />
        <Spark x={1100} y={70} unit={9} color={YELLOW} />
        <Spark x={1050} y={520} unit={7} color={BLUE} />

        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse renders plain <img>, not next/image */}
          <img src={lockupSrc} width={LOCKUP_WIDTH} height={LOCKUP_HEIGHT} alt="Radioso" />
          <div style={{ display: 'flex', marginTop: '14px', fontSize: '40px', color: MUTED }}>Docs</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div
            style={{
              display: 'flex',
              maxWidth: '960px',
              fontSize: '72px',
              lineHeight: 1.05,
              fontWeight: 700,
              letterSpacing: '-2px',
              color: INK,
            }}
          >
            {site.tagline}
          </div>
          <div style={{ display: 'flex', maxWidth: '1000px', fontSize: '32px', lineHeight: 1.3, color: MUTED }}>
            {site.description}
          </div>
        </div>

        <div style={{ display: 'flex', fontSize: '28px', color: MUTED }}>docs.radioso.ai</div>
      </div>
    ),
    { width: ogImage.width, height: ogImage.height },
  )
}

function Wash({ background }: { background: string }) {
  return <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', display: 'flex', backgroundImage: background }} />
}

// The pixel-plus spark from the marketing site's card.
function Spark({ x, y, unit, color }: { x: number; y: number; unit: number; color: string }) {
  const bar = { position: 'absolute', backgroundColor: color, display: 'flex' } as const
  return (
    <div style={{ position: 'absolute', left: x - unit * 1.5, top: y - unit * 1.5, width: unit * 3, height: unit * 3, display: 'flex' }}>
      <div style={{ ...bar, left: 0, top: unit, width: unit * 3, height: unit }} />
      <div style={{ ...bar, left: unit, top: 0, width: unit, height: unit * 3 }} />
    </div>
  )
}
