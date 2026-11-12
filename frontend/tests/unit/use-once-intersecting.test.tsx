/* @vitest-environment jsdom */

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { useOnceIntersecting } from '@/lib/use-once-intersecting'

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

interface FakeObserver {
  options: IntersectionObserverInit | undefined
  observed: Element[]
  disconnected: boolean
  report(isIntersecting: boolean): void
}

const observers: FakeObserver[] = []

const installObserver = () => {
  class Fake {
    private readonly fake: FakeObserver
    constructor(private readonly callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.fake = {
        options,
        observed: [],
        disconnected: false,
        report: (isIntersecting) => this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver),
      }
      observers.push(this.fake)
    }
    observe(element: Element) { this.fake.observed.push(element) }
    disconnect() { this.fake.disconnected = true }
  }
  vi.stubGlobal('IntersectionObserver', Fake)
}

const reports: boolean[] = []
const seenNow = () => reports.at(-1) ?? false

function Probe() {
  const [ref, seen] = useOnceIntersecting<HTMLDivElement>()
  useEffect(() => {
    reports.push(seen)
  })
  return <div ref={ref} />
}

describe('waiting for an element to be on screen', () => {
  let mounted: { root: Root; container: HTMLDivElement } | null = null

  const mount = () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => root.render(<Probe />))
    mounted = { root, container }
  }

  beforeEach(() => {
    observers.length = 0
    reports.length = 0
  })

  afterEach(() => {
    if (mounted) {
      act(() => mounted?.root.unmount())
      mounted.container.remove()
    }
    mounted = null
    vi.unstubAllGlobals()
  })

  it('has not seen the element until the browser says it intersects the viewport', () => {
    installObserver()
    mount()

    expect(seenNow()).toBe(false)
    expect(observers).toHaveLength(1)
    expect(observers[0].observed).toHaveLength(1)

    act(() => observers[0].report(false))
    expect(seenNow()).toBe(false)

    act(() => observers[0].report(true))
    expect(seenNow()).toBe(true)
  })

  it('watches the viewport itself, with no margin around it that would count an element a screen away as seen', () => {
    installObserver()
    mount()

    expect(observers[0].options?.rootMargin ?? '0px').toBe('0px')
    expect(observers[0].options?.root ?? null).toBeNull()
  })

  it('stops watching once it has seen the element, and stays seen', () => {
    installObserver()
    mount()

    act(() => observers[0].report(true))

    expect(observers[0].disconnected).toBe(true)
    expect(seenNow()).toBe(true)
  })

  it('stops watching when the element goes away first', () => {
    installObserver()
    mount()

    act(() => mounted?.root.unmount())
    mounted = null

    expect(observers[0].disconnected).toBe(true)
  })

  it('counts the element as seen at once where the browser cannot tell', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    mount()

    expect(seenNow()).toBe(true)
  })
})
