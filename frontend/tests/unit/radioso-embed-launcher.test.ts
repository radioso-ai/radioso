import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

class FakeElement {
  readonly tagName: string
  readonly dataset: Record<string, string> = {}
  readonly style: Record<string, string | ((name: string, value: string) => void)>
  readonly children: FakeElement[] = []
  readonly eventListeners = new Map<string, Array<(event: unknown) => void>>()
  attributes = new Map<string, string>()
  contentWindow: object
  parentNode: FakeElement | null = null
  textContent = ''
  innerHTML = ''
  src = ''
  title = ''
  type = ''
  className = ''
  loading = ''
  referrerPolicy = ''
  allow = ''
  draggable = true

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase()
    this.contentWindow = {}
    this.style = {
      setProperty: (name: string, value: string) => {
        this.style[name] = value
      },
    }
  }

  appendChild(child: FakeElement) {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  insertBefore(child: FakeElement, before: FakeElement | null) {
    child.parentNode = this
    const index = before ? this.children.indexOf(before) : -1
    if (index >= 0) {
      this.children.splice(index, 0, child)
    } else {
      this.children.push(child)
    }
    return child
  }

  removeChild(child: FakeElement) {
    const index = this.children.indexOf(child)
    if (index >= 0) {
      this.children.splice(index, 1)
      child.parentNode = null
    }
    return child
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null
  }

  addEventListener(eventName: string, handler: (event: unknown) => void) {
    const handlers = this.eventListeners.get(eventName) ?? []
    handlers.push(handler)
    this.eventListeners.set(eventName, handlers)
  }

  dispatchEvent(eventName: string, event: Record<string, unknown> = {}) {
    for (const handler of this.eventListeners.get(eventName) ?? []) {
      handler({
        target: this,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        ...event,
      })
    }
  }

  setPointerCapture() {
    // Pointer capture is not relevant to the fake DOM, but the launcher checks for it.
  }

  releasePointerCapture() {
    // Pointer capture is not relevant to the fake DOM, but the launcher checks for it.
  }

  querySelector(selector: string): FakeElement | null {
    if (selector === 'svg' && this.innerHTML.includes('<svg')) {
      return new FakeElement('svg')
    }

    const matches = (element: FakeElement) => {
      if (selector.startsWith('.')) {
        return element.className.split(/\s+/).includes(selector.slice(1))
      }

      const dataAttribute = selector.match(/^\[data-([a-z0-9-]+)="([^"]+)"\]$/i)
      if (dataAttribute) {
        const key = dataAttribute[1].replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
        return element.dataset[key] === dataAttribute[2]
      }

      return element.tagName.toLowerCase() === selector.toLowerCase()
    }

    const visit = (element: FakeElement): FakeElement | null => {
      if (matches(element)) {
        return element
      }

      for (const child of element.children) {
        const found = visit(child)
        if (found) {
          return found
        }
      }

      return null
    }

    return visit(this)
  }
}

const collectElements = (element: FakeElement, predicate: (element: FakeElement) => boolean): FakeElement[] => [
  ...(predicate(element) ? [element] : []),
  ...element.children.flatMap((child) => collectElements(child, predicate)),
]

describe('radioso embed launcher', () => {
  it('honors documented data attributes when mounting the iframe', async () => {
    const launcherSource = await readFile(join(process.cwd(), 'lib/radioso-embed-launcher.js'), 'utf8')
    const script = new FakeElement('script')
    script.src = 'https://app.example.com/radioso-embed.js'
    script.dataset.radiosoToken = 'embed-token'
    script.dataset.radiosoLauncherLabel = 'Ask us'
    script.dataset.radiosoLauncherIcon = 'message'
    script.dataset.radiosoLauncherPosition = 'bottom-left'
    script.dataset.radiosoDisplayMode = 'panel'
    script.dataset.radiosoInitialState = 'open'
    script.dataset.radiosoCopy = JSON.stringify({ publicChatEmptyTitle: 'Bonjour' })
    script.dataset.radiosoTheme = JSON.stringify({ accent: '#123456' })

    const head = new FakeElement('head')
    const body = new FakeElement('body')
    const document = {
      readyState: 'complete',
      currentScript: script,
      scripts: [script],
      head,
      body,
      documentElement: { clientWidth: 1024, clientHeight: 768, lang: 'en' },
      title: 'Host page',
      createElement: (tagName: string) => new FakeElement(tagName),
      getElementById: () => null,
      addEventListener: vi.fn(),
    }
    const sessionStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    }
    const fetch = vi.fn<(input: unknown, init?: RequestInit) => Promise<unknown>>(async () => ({
      ok: true,
      json: async () => ({
        launcherLabel: 'Server label',
        launcherPosition: 'bottom-right',
        theme: {
          brand: '#0f172a',
          brandText: '#f8fafc',
          surface: '#ffffff',
          text: '#0f172a',
        },
        copy: {},
        expertOverrides: {
          displayMode: 'bubble',
          initialState: 'collapsed',
        },
        proactiveGreetingEnabled: false,
      }),
    }))
    const window = {
      location: { href: 'https://host.example.com/page', origin: 'https://host.example.com' },
      navigator: { languages: ['en-US'], language: 'en-US' },
      sessionStorage,
      matchMedia: vi.fn(() => ({ matches: false })),
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener: vi.fn(),
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0)
        return 1
      },
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
      visualViewport: null,
    }

    vm.runInNewContext(launcherSource, {
      document,
      window,
      fetch,
      URL,
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
      requestAnimationFrame: window.requestAnimationFrame,
    })
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve()
    }

    const iframes = collectElements(body, (element) => element.tagName === 'IFRAME')
    expect(iframes).toHaveLength(1)
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', mode: 'cors' })
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('cache')

    const iframeUrl = new URL(iframes[0].src)
    expect(iframeUrl.origin).toBe('https://app.example.com')
    expect(iframeUrl.pathname).toBe('/embed-frame')
    expect(iframeUrl.searchParams.get('displayMode')).toBe('panel')
    expect(JSON.parse(iframeUrl.searchParams.get('copy') ?? '{}')).toMatchObject({
      publicChatEmptyTitle: 'Bonjour',
    })
    expect(JSON.parse(iframeUrl.searchParams.get('theme') ?? '{}')).toMatchObject({
      accent: '#123456',
    })

    const button = collectElements(body, (element) => element.tagName === 'BUTTON')[0]
    expect(button.getAttribute('aria-label')).toBe('Ask us')
    expect(button.style.right).toBe('0')
    expect(button.style.left).toBeUndefined()
  })

  it('resolves built-in locale copy client-side from the visitor language', async () => {
    const launcherSource = await readFile(join(process.cwd(), 'lib/radioso-embed-launcher.js'), 'utf8')
    const script = new FakeElement('script')
    script.src = 'https://app.example.com/radioso-embed.js'
    script.dataset.radiosoToken = 'embed-token'
    script.dataset.radiosoInitialState = 'open' // mount the iframe eagerly so we can read its copy param

    const head = new FakeElement('head')
    const body = new FakeElement('body')
    const document = {
      readyState: 'complete',
      currentScript: script,
      scripts: [script],
      head,
      body,
      documentElement: { clientWidth: 1024, clientHeight: 768, lang: 'fr' },
      title: 'Host page',
      createElement: (tagName: string) => new FakeElement(tagName),
      getElementById: () => null,
      addEventListener: vi.fn(),
    }
    const sessionStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    }
    // Config carries no operator copy packs and is Accept-Language-independent;
    // the launcher must still localize from its bundled built-in packs.
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        launcherLabel: 'Server label',
        launcherPosition: 'bottom-right',
        theme: { brand: '#0f172a', brandText: '#f8fafc', surface: '#ffffff', text: '#0f172a' },
        copy: {},
        expertOverrides: {},
        proactiveGreetingEnabled: false,
      }),
    }))
    const window = {
      location: { href: 'https://host.example.com/page', origin: 'https://host.example.com' },
      navigator: { languages: ['fr-FR'], language: 'fr-FR' },
      sessionStorage,
      matchMedia: vi.fn(() => ({ matches: false })),
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener: vi.fn(),
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0)
        return 1
      },
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
      visualViewport: null,
    }

    vm.runInNewContext(launcherSource, {
      document,
      window,
      fetch,
      URL,
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
      requestAnimationFrame: window.requestAnimationFrame,
    })
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve()
    }

    const iframe = collectElements(body, (element) => element.tagName === 'IFRAME')[0]
    expect(iframe).toBeDefined()
    expect(JSON.parse(new URL(iframe.src).searchParams.get('copy') ?? '{}')).toMatchObject({
      publicChatEmptyTitle: 'Commencer une conversation',
      // Keys the launcher whitelist used to strip before forwarding to the iframe.
      publicChatContactHumanLabel: 'Parler à une personne',
      skillReceiptSubmittedLabel: 'Envoyé',
    })
  })

  it('keeps English-preferring visitors on the English baseline', async () => {
    const launcherSource = await readFile(join(process.cwd(), 'lib/radioso-embed-launcher.js'), 'utf8')
    const script = new FakeElement('script')
    script.src = 'https://app.example.com/radioso-embed.js'
    script.dataset.radiosoToken = 'embed-token'
    script.dataset.radiosoInitialState = 'open'

    const head = new FakeElement('head')
    const body = new FakeElement('body')
    const document = {
      readyState: 'complete',
      currentScript: script,
      scripts: [script],
      head,
      body,
      documentElement: { clientWidth: 1024, clientHeight: 768, lang: 'en' },
      title: 'Host page',
      createElement: (tagName: string) => new FakeElement(tagName),
      getElementById: () => null,
      addEventListener: vi.fn(),
    }
    const sessionStorage = { getItem: vi.fn(() => null), setItem: vi.fn() }
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        launcherLabel: 'Server label',
        launcherPosition: 'bottom-right',
        theme: { brand: '#0f172a', brandText: '#f8fafc', surface: '#ffffff', text: '#0f172a' },
        copy: {},
        expertOverrides: {},
        proactiveGreetingEnabled: false,
      }),
    }))
    const window = {
      location: { href: 'https://host.example.com/page', origin: 'https://host.example.com' },
      // English is preferred over French: the launcher must not localize into French.
      navigator: { languages: ['en-US', 'fr-FR'], language: 'en-US' },
      sessionStorage,
      matchMedia: vi.fn(() => ({ matches: false })),
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener: vi.fn(),
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0)
        return 1
      },
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
      visualViewport: null,
    }

    vm.runInNewContext(launcherSource, {
      document,
      window,
      fetch,
      URL,
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
      requestAnimationFrame: window.requestAnimationFrame,
    })
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve()
    }

    const iframe = collectElements(body, (element) => element.tagName === 'IFRAME')[0]
    expect(iframe).toBeDefined()
    // No built-in pack is forwarded, so the iframe falls back to English defaults
    // rather than the lower-priority French pack.
    expect(new URL(iframe.src).searchParams.get('copy')).toBeNull()
  })

  it('keeps an explicitly empty server launcher label icon-only', async () => {
    const launcherSource = await readFile(join(process.cwd(), 'lib/radioso-embed-launcher.js'), 'utf8')
    const script = new FakeElement('script')
    script.src = 'https://app.example.com/radioso-embed.js'
    script.dataset.radiosoToken = 'embed-token'

    const head = new FakeElement('head')
    const body = new FakeElement('body')
    const document = {
      readyState: 'complete',
      currentScript: script,
      scripts: [script],
      head,
      body,
      documentElement: { clientWidth: 1024, clientHeight: 768, lang: 'en' },
      title: 'Host page',
      createElement: (tagName: string) => new FakeElement(tagName),
      getElementById: () => null,
      addEventListener: vi.fn(),
    }
    const sessionStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    }
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        launcherLabel: '',
        launcherPosition: 'bottom-right',
        theme: {
          brand: '#0f172a',
          brandText: '#f8fafc',
          surface: '#ffffff',
          text: '#0f172a',
        },
        copy: {
          default: {
            launcherDefaultLabel: 'Claudio',
          },
        },
        expertOverrides: {},
        proactiveGreetingEnabled: false,
      }),
    }))
    const window = {
      location: { href: 'https://host.example.com/page', origin: 'https://host.example.com' },
      navigator: { languages: ['en-US'], language: 'en-US' },
      sessionStorage,
      matchMedia: vi.fn(() => ({ matches: false })),
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener: vi.fn(),
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0)
        return 1
      },
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
      visualViewport: null,
    }

    vm.runInNewContext(launcherSource, {
      document,
      window,
      fetch,
      URL,
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
      requestAnimationFrame: window.requestAnimationFrame,
    })
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve()
    }

    const button = collectElements(body, (element) => element.tagName === 'BUTTON')[0]
    expect(button.children).toHaveLength(2)
    expect(button.children.some((child) => child.textContent === 'Claudio')).toBe(false)
    expect(button.querySelector('[data-radioso-launcher-avatar="true"]')?.style.width).toBe('3rem')
  })

  it('lets the collapsed bubble drag with a comet trail without opening chat', async () => {
    const launcherSource = await readFile(join(process.cwd(), 'lib/radioso-embed-launcher.js'), 'utf8')
    const script = new FakeElement('script')
    script.src = 'https://app.example.com/radioso-embed.js'
    script.dataset.radiosoToken = 'embed-token'

    const head = new FakeElement('head')
    const body = new FakeElement('body')
    const document = {
      readyState: 'complete',
      currentScript: script,
      scripts: [script],
      head,
      body,
      documentElement: { clientWidth: 1024, clientHeight: 768, lang: 'en' },
      title: 'Host page',
      createElement: (tagName: string) => new FakeElement(tagName),
      getElementById: () => null,
      addEventListener: vi.fn(),
    }
    const sessionStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    }
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        launcherLabel: 'Chat with us',
        launcherPosition: 'bottom-right',
        theme: {
          brand: '#0f172a',
          brandText: '#f8fafc',
          surface: '#ffffff',
          text: '#0f172a',
        },
        copy: {},
        expertOverrides: {},
        proactiveGreetingEnabled: false,
      }),
    }))
    const scheduledTimers: Array<() => void> = []
    const clearedTimers = new Set<number>()
    const setTimeout = vi.fn((callback: () => void) => {
      const timerId = scheduledTimers.length
      scheduledTimers.push(callback)
      return timerId
    })
    const clearTimeout = vi.fn((timerId: number) => {
      clearedTimers.add(timerId)
    })
    const window = {
      location: { href: 'https://host.example.com/page', origin: 'https://host.example.com' },
      navigator: { languages: ['en-US'], language: 'en-US' },
      sessionStorage,
      matchMedia: vi.fn(() => ({ matches: false })),
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0)
        return 1
      },
      setTimeout,
      clearTimeout,
      visualViewport: null,
    }

    vm.runInNewContext(launcherSource, {
      document,
      window,
      fetch,
      URL,
      setTimeout,
      clearTimeout,
      requestAnimationFrame: window.requestAnimationFrame,
    })
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve()
    }

    const button = collectElements(body, (element) => element.tagName === 'BUTTON')[0]
    const avatar = button.querySelector('[data-radioso-launcher-avatar="true"]')
    const avatarImage = collectElements(button, (element) => element.tagName === 'IMG')[0]
    expect(avatar?.style.pointerEvents).toBe('none')
    expect(avatarImage.draggable).toBe(false)

    button.dispatchEvent('pointerdown', { pointerId: 1, button: 0, isPrimary: true, clientX: 960, clientY: 710 })
    button.dispatchEvent('pointermove', { pointerId: 1, clientX: 820, clientY: 610 })
    expect(button.style.transform).toBe('translate3d(-140px, -100px, 0) rotate(-4.9deg)')

    button.dispatchEvent('pointerup', { pointerId: 1, clientX: 820, clientY: 610 })

    expect(button.style.transform).toBe('translate3d(0px, 0px, 0) rotate(0deg)')
    expect(collectElements(body, (element) => element.className === 'radioso-comet-square').length).toBeGreaterThan(10)

    button.dispatchEvent('pointerdown', { pointerId: 2, button: 0, isPrimary: true, clientX: 960, clientY: 710 })
    expect(clearTimeout.mock.calls.length).toBeGreaterThanOrEqual(9)

    for (const [timerId, callback] of [...scheduledTimers].entries()) {
      if (!clearedTimers.has(timerId)) {
        callback()
      }
    }
    button.dispatchEvent('click')
    // The bubble was dragged, so the click is suppressed and the widget stays
    // closed. The iframe is pre-mounted now, so its presence no longer signals
    // "opened" — assert the closed state directly.
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps an over-dragged bubble inside the viewport and returns it on window release', async () => {
    const launcherSource = await readFile(join(process.cwd(), 'lib/radioso-embed-launcher.js'), 'utf8')
    const script = new FakeElement('script')
    script.src = 'https://app.example.com/radioso-embed.js'
    script.dataset.radiosoToken = 'embed-token'

    const head = new FakeElement('head')
    const body = new FakeElement('body')
    const document = {
      readyState: 'complete',
      currentScript: script,
      scripts: [script],
      head,
      body,
      documentElement: { clientWidth: 1024, clientHeight: 768, lang: 'en' },
      title: 'Host page',
      createElement: (tagName: string) => new FakeElement(tagName),
      getElementById: () => null,
      addEventListener: vi.fn(),
    }
    const sessionStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    }
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        launcherLabel: 'Chat with us',
        launcherPosition: 'bottom-right',
        theme: {
          brand: '#0f172a',
          brandText: '#f8fafc',
          surface: '#ffffff',
          text: '#0f172a',
        },
        copy: {},
        expertOverrides: {},
        proactiveGreetingEnabled: false,
      }),
    }))
    const setTimeout = vi.fn()
    const window = {
      location: { href: 'https://host.example.com/page', origin: 'https://host.example.com' },
      navigator: { languages: ['en-US'], language: 'en-US' },
      sessionStorage,
      matchMedia: vi.fn(() => ({ matches: false })),
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0)
        return 1
      },
      setTimeout,
      clearTimeout: vi.fn(),
      visualViewport: null,
    }

    vm.runInNewContext(launcherSource, {
      document,
      window,
      fetch,
      URL,
      setTimeout,
      clearTimeout: vi.fn(),
      requestAnimationFrame: window.requestAnimationFrame,
    })
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve()
    }

    const button = collectElements(body, (element) => element.tagName === 'BUTTON')[0] as FakeElement & {
      getBoundingClientRect: () => {
        left: number
        right: number
        top: number
        bottom: number
        width: number
        height: number
      }
    }
    button.getBoundingClientRect = () => ({
      left: 900,
      right: 1010,
      top: 690,
      bottom: 750,
      width: 110,
      height: 60,
    })

    button.dispatchEvent('pointerdown', { pointerId: 1, button: 0, isPrimary: true, clientX: 960, clientY: 710 })
    button.dispatchEvent('pointermove', { pointerId: 1, clientX: 2000, clientY: 1200 })

    expect(button.style.transform).toBe('translate3d(6px, 10px, 0) rotate(0.21deg)')

    const windowPointerUp = window.addEventListener.mock.calls.find(([eventName]) => eventName === 'pointerup')?.[1] as
      | ((event: unknown) => void)
      | undefined
    expect(windowPointerUp).toBeDefined()
    windowPointerUp?.({ pointerId: 1, clientX: 2000, clientY: 1200, preventDefault: vi.fn() })

    expect(button.style.transform).toBe('translate3d(0px, 0px, 0) rotate(0deg)')
    const removedWindowListeners = window.removeEventListener.mock.calls.map(([eventName]) => eventName)
    expect(removedWindowListeners).toEqual(expect.arrayContaining(['pointerup', 'pointercancel', 'blur']))
    // Dragging never opens the widget. The iframe is pre-mounted now, so assert
    // the closed state rather than the absence of an iframe.
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('toggles the mounted embed fullscreen state on iframe request', async () => {
    const launcherSource = await readFile(join(process.cwd(), 'lib/radioso-embed-launcher.js'), 'utf8')
    const script = new FakeElement('script')
    script.src = 'https://app.example.com/radioso-embed.js'
    script.dataset.radiosoToken = 'embed-token'
    script.dataset.radiosoInitialState = 'open'

    const head = new FakeElement('head')
    const body = new FakeElement('body')
    const document = {
      readyState: 'complete',
      currentScript: script,
      scripts: [script],
      head,
      body,
      documentElement: { clientWidth: 1024, clientHeight: 768, lang: 'en' },
      title: 'Host page',
      createElement: (tagName: string) => new FakeElement(tagName),
      getElementById: () => null,
      addEventListener: vi.fn(),
    }
    const sessionStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    }
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        launcherLabel: 'Chat with us',
        launcherPosition: 'bottom-right',
        theme: {
          brand: '#0f172a',
          brandText: '#f8fafc',
          surface: '#ffffff',
          text: '#0f172a',
        },
        copy: {},
        expertOverrides: {},
        proactiveGreetingEnabled: false,
      }),
    }))
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const window = {
      location: { href: 'https://host.example.com/page', origin: 'https://host.example.com' },
      navigator: { languages: ['en-US'], language: 'en-US' },
      sessionStorage,
      matchMedia: vi.fn(() => ({ matches: false })),
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      requestAnimationFrame,
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
      visualViewport: null,
    }

    vm.runInNewContext(launcherSource, {
      document,
      window,
      fetch,
      URL,
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
      requestAnimationFrame: window.requestAnimationFrame,
    })
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve()
    }

    const iframe = collectElements(body, (element) => element.tagName === 'IFRAME')[0]
    expect(iframe).toBeDefined()

    requestAnimationFrame.mockClear()
    const messageHandlers = window.addEventListener.mock.calls
      .filter(([eventName]) => eventName === 'message')
      .map(([, handler]) => handler as (event: unknown) => void)
    for (const handler of messageHandlers) {
      handler({
        source: iframe.contentWindow,
        origin: 'https://app.example.com',
        data: { type: 'radioso:embed:fullscreen' },
      })
    }

    const host = body.children[0]
    const panel = iframe.parentNode
    expect(host.style.width).toBe('1024px')
    expect(host.style.height).toBe('768px')
    expect(host.style.maxWidth).toBe('none')
    expect(panel?.style.width).toBe('100%')
    expect(panel?.style.borderRadius).toBe('0')
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2)

    requestAnimationFrame.mockClear()
    for (const handler of messageHandlers) {
      handler({
        source: iframe.contentWindow,
        origin: 'https://app.example.com',
        data: { type: 'radioso:embed:fullscreen' },
      })
    }

    expect(host.style.width).toBe('')
    expect(host.style.height).toBe('')
    expect(host.style.maxWidth).toBe('calc(100vw - 2rem)')
    expect(panel?.style.width).toBe('min(560px, calc(100vw - 2rem))')
    expect(panel?.style.borderRadius).toBe('28px')
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2)
  })

  it.each([
    {
      bodyText: '',
      expectedCapability: {
        available: true,
        mode: 'metadata',
        supportedOperations: ['metadata'],
      },
      name: 'empty page body',
    },
    {
      bodyText: 'Visible refund policy',
      expectedCapability: {
        available: true,
        mode: 'content',
        supportedOperations: ['metadata', 'lookup', 'summarize'],
      },
      name: 'non-empty page body',
    },
  ])('pre-mounts the iframe and advertises the captured capability for $name', async ({
    bodyText,
    expectedCapability,
  }) => {
    const launcherSource = await readFile(join(process.cwd(), 'lib/radioso-embed-launcher.js'), 'utf8')
    const script = new FakeElement('script')
    script.src = 'https://app.example.com/radioso-embed.js'
    script.dataset.radiosoToken = 'embed-token'
    script.dataset.radiosoPageContext = 'content'

    const head = new FakeElement('head')
    const body = new FakeElement('body')
    body.textContent = bodyText
    const document = {
      readyState: 'complete',
      currentScript: script,
      scripts: [script],
      head,
      body,
      documentElement: { clientWidth: 1024, clientHeight: 768, lang: 'en' },
      title: 'Host page',
      createElement: (tagName: string) => new FakeElement(tagName),
      getElementById: () => null,
      addEventListener: vi.fn(),
    }
    const sessionStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }
    const sessionUrl = (url: unknown) => String(url).includes('/api/embed/session/')
    const fetch = vi.fn(async (url: unknown) => {
      if (sessionUrl(url)) {
        return {
          ok: true,
          json: async () => ({
            publicChatToken: 'public-chat-token',
            publicSessionToken: 'public-session-token',
            publicSessionId: 'public-session-id',
            resumeToken: 'resume-token',
            resumeExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            workspaceName: 'Acme',
          }),
        }
      }
      return {
        ok: true,
        json: async () => ({
          launcherLabel: 'Chat with us',
          launcherPosition: 'bottom-right',
          theme: { brand: '#0f172a', brandText: '#f8fafc', surface: '#ffffff', text: '#0f172a' },
          copy: {},
          expertOverrides: {},
          proactiveGreetingEnabled: false,
        }),
      }
    })
    const window = {
      location: { href: 'https://host.example.com/page', origin: 'https://host.example.com' },
      navigator: { languages: ['en-US'], language: 'en-US' },
      sessionStorage,
      matchMedia: vi.fn(() => ({ matches: false })),
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0)
        return 1
      },
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
      visualViewport: null,
    }

    vm.runInNewContext(launcherSource, {
      document,
      window,
      fetch,
      URL,
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
      requestAnimationFrame: window.requestAnimationFrame,
    })
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve()
    }

    // The iframe is pre-mounted at load, before any interaction.
    const iframe = collectElements(body, (element) => element.tagName === 'IFRAME')[0]
    expect(iframe).toBeDefined()
    expect(iframe.loading).toBe('eager')
    const postMessage = vi.fn()
    iframe.contentWindow = { postMessage }

    const messageHandlers = window.addEventListener.mock.calls
      .filter(([eventName]) => eventName === 'message')
      .map(([, handler]) => handler as (event: unknown) => void)
    const dispatchFromFrame = (data: unknown) => {
      for (const handler of messageHandlers) {
        handler({ source: iframe.contentWindow, origin: 'https://app.example.com', data })
      }
    }

    // The frame boots and pings READY while the widget is still closed — this
    // must NOT trigger a session bootstrap.
    dispatchFromFrame({ type: 'radioso:embed:ready' })
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve()
    }
    expect(fetch.mock.calls.some(([url]) => sessionUrl(url))).toBe(false)
    expect(postMessage).not.toHaveBeenCalled()

    // Opening the widget triggers the deferred bootstrap: PREPARE, then session.
    const button = collectElements(body, (element) => element.tagName === 'BUTTON')[0]
    button.dispatchEvent('click')

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'radioso:embed:preparing' }),
      'https://app.example.com',
    )
    expect(fetch.mock.calls.some(([url]) => sessionUrl(url))).toBe(true)

    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve()
    }
    const sessionMessage = postMessage.mock.calls.find(
      ([message]) => message.type === 'radioso:embed:session',
    )?.[0]
    expect(sessionMessage).toMatchObject({
      type: 'radioso:embed:session',
      clientContextCapabilities: {
        'page.read': expectedCapability,
      },
    })
    if (bodyText) {
      expect(sessionMessage.pageContext.content).toBe(bodyText)
    } else {
      expect(sessionMessage.pageContext).not.toHaveProperty('content')
    }
  })

})
