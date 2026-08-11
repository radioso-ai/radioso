import { ImageResponse } from 'next/og'

import { ogImage, site } from '@/lib/site'

// Raster OG card generated at build time. Social platforms do not render SVG
// og:image, and repo policy keeps logo assets raster-only, so this replaces the
// former `/radioso-lockup.svg` reference without committing a binary.
//
// This is a route handler at `/og-image.png` rather than the `opengraph-image`
// file convention on purpose: the convention emits an extensionless artifact
// (`out/opengraph-image`) and a static CDN host types responses by file
// extension, so crawlers would be served `application/octet-stream`.
export const dynamic = 'force-static'

const BACKGROUND = '#f9f9f7'
const FOREGROUND = '#142317'
const PRIMARY = '#2870bd'
const ACCENT = '#ffc720'
const MUTED = '#6a706b'

export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          backgroundColor: BACKGROUND,
          padding: '80px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div
            style={{
              width: '28px',
              height: '28px',
              borderRadius: '9999px',
              backgroundColor: PRIMARY,
              display: 'flex',
            }}
          />
          <div style={{ fontSize: '38px', fontWeight: 700, color: FOREGROUND, letterSpacing: '-0.5px' }}>
            Radioso
          </div>
          <div style={{ fontSize: '38px', color: MUTED }}>Docs</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
          <div
            style={{
              fontSize: '82px',
              lineHeight: 1.05,
              fontWeight: 700,
              color: FOREGROUND,
              letterSpacing: '-2px',
              maxWidth: '900px',
              display: 'flex',
            }}
          >
            Grounded answers you can defend.
          </div>
          <div style={{ fontSize: '34px', color: MUTED, maxWidth: '880px', display: 'flex' }}>
            {site.description}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ width: '160px', height: '10px', backgroundColor: PRIMARY, display: 'flex' }} />
          <div style={{ width: '48px', height: '10px', backgroundColor: ACCENT, display: 'flex' }} />
          <div style={{ marginLeft: 'auto', fontSize: '30px', color: MUTED }}>docs.radioso.ai</div>
        </div>
      </div>
    ),
    { width: ogImage.width, height: ogImage.height },
  )
}
