'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'

import {
  BeaconFrontendProductAnalyticsSink,
  createFrontendProductAnalyticsEmitter,
  sanitizePageViewPathname,
} from '@/lib/product-analytics'
import { API_BASE } from '@/lib/api-client'

type FrontendProductAnalyticsEmitter = ReturnType<typeof createFrontendProductAnalyticsEmitter>

const pageViewSource = (pathname: string) => (
  (pathname === '/embed-frame' || pathname.startsWith('/embed/')) ? 'embed' : 'frontend'
)

export function ProductAnalyticsProvider() {
  const pathname = usePathname()
  const sanitizedPathname = useMemo(() => sanitizePageViewPathname(pathname), [pathname])
  const [emitter] = useState<FrontendProductAnalyticsEmitter>(() => createFrontendProductAnalyticsEmitter({
    sinks: [
      new BeaconFrontendProductAnalyticsSink({
        endpoint: `${API_BASE}/observability/product-analytics`,
      }),
    ],
  }))
  const lastTrackedPageRef = useRef<string | null>(null)

  useEffect(() => {
    if (lastTrackedPageRef.current === sanitizedPathname) {
      return
    }

    lastTrackedPageRef.current = sanitizedPathname

    void emitter.track({
      eventName: 'frontend.page_view',
      properties: {
        path: sanitizedPathname,
      },
      source: pageViewSource(sanitizedPathname),
    })
  }, [emitter, sanitizedPathname])

  return null
}
