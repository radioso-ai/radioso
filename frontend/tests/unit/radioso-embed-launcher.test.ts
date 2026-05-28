import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

class FakeElement {
  readonly tagName: string
  readonly dataset: Record<string, string> = {}
  readonly style: Record<string, string | ((name: string, value: string) => void)>
  readonly children: FakeElement[] = []
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

  addEventListener() {
    // The launcher registers browser events; the regression only needs mounted DOM state.
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
    const fetch = vi.fn(async () => ({
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

})
