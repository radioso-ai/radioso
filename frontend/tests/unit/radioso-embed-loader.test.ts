import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

import { describe, expect, it } from 'vitest'

class FakeElement {
  children: FakeElement[] = []
  dataset: Record<string, string> = {}
  parentNode: FakeElement | null = null
  style: Record<string, string> = {}
  attributes: Record<string, string> = {}
  eventListeners = new Map<string, Array<() => void>>()
  innerHTML = ''
  textContent = ''
  type = ''
  title = ''
  src = ''
  alt = ''
  referrerPolicy = ''
  loading = ''
  allow = ''
  contentWindow?: object

  constructor(readonly tagName: string) {}

  appendChild(child: FakeElement) {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  remove() {
    if (!this.parentNode) {
      return
    }

    this.parentNode.children = this.parentNode.children.filter((child) => child !== this)
    this.parentNode = null
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null
  }

  addEventListener(type: string, listener: () => void) {
    const listeners = this.eventListeners.get(type) ?? []
    listeners.push(listener)
    this.eventListeners.set(type, listeners)
  }

  querySelector(selector: string) {
    if (selector !== 'svg' || !this.innerHTML.includes('<svg')) {
      return null
    }

    return new FakeElement('SVG')
  }

  click() {
    for (const listener of this.eventListeners.get('click') ?? []) {
      listener()
    }
  }
}

const findElements = (element: FakeElement, tagName: string): FakeElement[] => {
  const matches = element.tagName === tagName ? [element] : []
  return matches.concat(element.children.flatMap((child) => findElements(child, tagName)))
}

const loadEmbedScript = () => {
  const scriptPath = path.resolve(process.cwd(), 'public/radioso-embed.js')
  const source = fs.readFileSync(scriptPath, 'utf8')
  const scriptElement = new FakeElement('SCRIPT')
  scriptElement.dataset.radiosoToken = 'embed-token'
  scriptElement.src = 'https://app.example.com/radioso-embed.js'
  const windowListeners = new Map<string, Array<(event: unknown) => void>>()

  const body = new FakeElement('BODY')
  const document = {
    body,
    currentScript: scriptElement,
    documentElement: { clientWidth: 1200, clientHeight: 900 },
    readyState: 'complete',
    scripts: [scriptElement],
    createElement: (tagName: string) => {
      const element = new FakeElement(tagName.toUpperCase())
      if (tagName.toLowerCase() === 'iframe') {
        element.contentWindow = {}
      }
      return element
    },
    addEventListener: () => {},
  }
  const window = {
    document,
    innerHeight: 900,
    innerWidth: 1200,
    location: { href: 'https://site.example/page' },
    parent: null as unknown,
    __radiosoEmbedMounted: undefined,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const listeners = windowListeners.get(type) ?? []
      listeners.push(listener)
      windowListeners.set(type, listeners)
    },
    clearInterval: () => {},
    clearTimeout: () => {},
    setInterval: () => 1,
    setTimeout: () => 1,
    dispatchEvent: (type: string, event: unknown) => {
      for (const listener of windowListeners.get(type) ?? []) {
        listener(event)
      }
    },
  }
  window.parent = window

  vm.runInNewContext(source, {
    Array,
    URL,
    document,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    window,
  })

  return { body, window }
}

describe('radioso embed loader', () => {
  it('keeps the bubble iframe mounted while collapsed so chat state survives reopen', () => {
    const { body, window } = loadEmbedScript()
    const button = findElements(body, 'BUTTON')[0]
    expect(button).toBeTruthy()

    button.click()
    const firstIframe = findElements(body, 'IFRAME')[0]
    expect(firstIframe).toBeTruthy()

    button.click()
    expect(findElements(body, 'IFRAME')[0]).toBe(firstIframe)

    button.click()
    expect(findElements(body, 'IFRAME')[0]).toBe(firstIframe)

    window.dispatchEvent('message', {
      source: firstIframe.contentWindow,
      data: { type: 'radioso:embed:collapse' },
    })
    expect(findElements(body, 'IFRAME')[0]).toBe(firstIframe)
  })
})
