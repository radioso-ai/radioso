(function () {
  const SCRIPT_PATH = '/radioso-embed.js'
  const DEFAULT_LABEL = 'Chat with us'
  const DEFAULT_POSITION = 'bottom-right'
  const DEFAULT_ICON = 'chat'
  const DEFAULT_INITIAL_STATE = 'collapsed'
  const READY_MESSAGE = 'radioso:embed:ready'
  const SESSION_MESSAGE = 'radioso:embed:session'
  const ERROR_MESSAGE = 'radioso:embed:error'
  const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?$/

  const copyByLocale = {
    de: {
      launcherDefaultLabel: 'Chatte mit uns',
      iframeTitle: 'Eingebetteter Radioso-Chat',
    },
    en: {
      launcherDefaultLabel: 'Chat with us',
      iframeTitle: 'Radioso embedded chat',
    },
    es: {
      launcherDefaultLabel: 'Chatea con nosotros',
      iframeTitle: 'Chat incrustado de Radioso',
    },
    fr: {
      launcherDefaultLabel: 'Discutez avec nous',
      iframeTitle: 'Chat integre Radioso',
    },
    it: {
      launcherDefaultLabel: 'Chatta con noi',
      iframeTitle: 'Chat incorporata Radioso',
    },
    pt: {
      launcherDefaultLabel: 'Converse conosco',
      iframeTitle: 'Chat incorporado do Radioso',
    },
  }

  const iconMarkup = {
    chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 5.5A3.5 3.5 0 0 1 7.5 2h9A3.5 3.5 0 0 1 20 5.5v7A3.5 3.5 0 0 1 16.5 16H10l-4.5 4v-4.2A3.5 3.5 0 0 1 4 12.5z"/></svg>',
    sparkles: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13.5 2.5 15 7l4.5 1.5L15 10l-1.5 4.5L12 10 7.5 8.5 12 7zM5 13l1.2 3.8L10 18l-3.8 1.2L5 23l-1.2-3.8L0 18l3.8-1.2zM17 13l1.3 4.2L22.5 18l-4.2 1.3L17 23l-1.3-3.7L11.5 18l4.2-1.3z"/></svg>',
    message: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 4.5A2.5 2.5 0 0 1 6.5 2h11A2.5 2.5 0 0 1 20 4.5v9A2.5 2.5 0 0 1 17.5 16H9l-5 4v-4.1A2.5 2.5 0 0 1 4 13.5z"/></svg>',
  }

  const getScriptElement = () => {
    const current = document.currentScript
    if (current && current.tagName === 'SCRIPT') {
      return current
    }

    return Array.from(document.scripts).find((script) => script.dataset && script.dataset.radiosoToken) ?? null
  }

  const getScriptUrl = (script) => {
    try {
      return new URL(script?.src || SCRIPT_PATH, window.location.href)
    } catch {
      return new URL(SCRIPT_PATH, window.location.href)
    }
  }

  const normalizeLocale = (value) => {
    if (!value) {
      return null
    }

    const trimmed = value.trim()
    if (!trimmed || trimmed.length > 35 || !LOCALE_PATTERN.test(trimmed)) {
      return null
    }

    const language = trimmed.split('-')[0].toLowerCase()
    return Object.prototype.hasOwnProperty.call(copyByLocale, language) ? language : null
  }

  const getCopy = (locale) => copyByLocale[locale] ?? copyByLocale.en

  const normalizeInitialState = (value) => {
    if (!value) {
      return null
    }

    const normalized = value.trim().toLowerCase()
    return normalized === 'open' || normalized === 'collapsed' ? normalized : null
  }

  const resolveAvatarUrl = (value) => {
    if (!value) {
      return null
    }

    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }

    try {
      const url = new URL(trimmed, window.location.href)
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
    } catch {
      return null
    }
  }

  const createPanel = () => {
    const panel = document.createElement('div')
    panel.setAttribute('aria-hidden', 'true')
    panel.style.position = 'absolute'
    panel.style.width = 'min(420px, calc(100vw - 1.5rem))'
    panel.style.height = 'min(640px, calc(100vh - 6rem))'
    panel.style.maxHeight = 'calc(100vh - 6rem)'
    panel.style.borderRadius = '24px'
    panel.style.overflow = 'hidden'
    panel.style.boxShadow = '0 24px 60px rgba(15, 23, 42, 0.28)'
    panel.style.background = 'hsl(0 0% 100%)'
    panel.style.border = '1px solid rgba(148, 163, 184, 0.35)'
    panel.style.display = 'none'

    return panel
  }

  const createIframe = (scriptUrl, token, locale) => {
    const iframe = document.createElement('iframe')
    iframe.title = getCopy(locale).iframeTitle
    iframe.loading = 'lazy'
    iframe.referrerPolicy = 'no-referrer-when-downgrade'
    iframe.allow = 'clipboard-read; clipboard-write'
    iframe.style.border = '0'
    iframe.style.width = '100%'
    iframe.style.height = '100%'
    const iframeUrl = new URL(`/embed/${encodeURIComponent(token)}`, scriptUrl)
    if (locale) {
      iframeUrl.searchParams.set('locale', locale)
    }
    iframe.src = iframeUrl.toString()
    return iframe
  }

  const bootstrapEmbeddedSession = async (scriptUrl, token, options) => {
    const body =
      options && typeof options.resumeAnonymousSessionId === 'string'
        ? JSON.stringify({ anonymousSessionId: options.resumeAnonymousSessionId })
        : undefined
    const response = await fetch(new URL(`/api/embed/session/${encodeURIComponent(token)}`, scriptUrl).toString(), {
      method: 'POST',
      mode: 'cors',
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body,
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.publicChatToken || !payload?.embedSessionToken) {
      throw new Error(payload?.error?.message || 'Embedded chat could not be started from this website.')
    }

    return payload
  }

  const setIconMarkup = (container, icon) => {
    container.innerHTML = iconMarkup[icon] ?? iconMarkup[DEFAULT_ICON]
    const svg = container.querySelector('svg')
    if (svg) {
      svg.setAttribute('width', '18')
      svg.setAttribute('height', '18')
    }
  }

  const createButton = (label, icon, avatarUrl) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('aria-label', label)

    const iconContainer = document.createElement('span')
    iconContainer.setAttribute('aria-hidden', 'true')
    iconContainer.style.display = 'inline-flex'
    iconContainer.style.alignItems = 'center'
    iconContainer.style.justifyContent = 'center'
    iconContainer.style.width = '1.75rem'
    iconContainer.style.height = '1.75rem'
    iconContainer.style.overflow = 'hidden'
    iconContainer.style.borderRadius = '9999px'
    iconContainer.style.flexShrink = '0'
    iconContainer.style.background = 'rgba(248, 250, 252, 0.14)'

    if (avatarUrl) {
      const image = document.createElement('img')
      image.alt = ''
      image.src = avatarUrl
      image.referrerPolicy = 'no-referrer'
      image.style.width = '100%'
      image.style.height = '100%'
      image.style.objectFit = 'cover'
      image.style.display = 'block'
      image.addEventListener(
        'error',
        () => {
          iconContainer.innerHTML = ''
          setIconMarkup(iconContainer, icon)
        },
        { once: true },
      )
      iconContainer.appendChild(image)
    } else {
      setIconMarkup(iconContainer, icon)
    }

    const labelNode = document.createElement('span')
    labelNode.textContent = label
    button.appendChild(iconContainer)
    button.appendChild(labelNode)
    button.style.all = 'unset'
    button.style.boxSizing = 'border-box'
    button.style.display = 'inline-flex'
    button.style.alignItems = 'center'
    button.style.gap = '0.625rem'
    button.style.padding = '0.875rem 1rem'
    button.style.borderRadius = '9999px'
    button.style.cursor = 'pointer'
    button.style.background = 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)'
    button.style.color = '#f8fafc'
    button.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif'
    button.style.fontSize = '14px'
    button.style.fontWeight = '600'
    button.style.lineHeight = '1'
    button.style.boxShadow = '0 12px 30px rgba(15, 23, 42, 0.25)'
    button.style.transition = 'transform 140ms ease, box-shadow 140ms ease, opacity 140ms ease'
    button.style.userSelect = 'none'
    button.addEventListener('mouseenter', () => {
      button.style.transform = 'translateY(-1px)'
      button.style.boxShadow = '0 16px 34px rgba(15, 23, 42, 0.32)'
    })
    button.addEventListener('mouseleave', () => {
      button.style.transform = 'translateY(0)'
      button.style.boxShadow = '0 12px 30px rgba(15, 23, 42, 0.25)'
    })
    return button
  }

  const init = () => {
    const script = getScriptElement()
    if (!script) {
      return
    }

    const token = script.dataset.radiosoToken
    if (!token) {
      return
    }

    if (window.__radiosoEmbedMounted) {
      return
    }
    window.__radiosoEmbedMounted = true

    const scriptUrl = getScriptUrl(script)
    const locale = normalizeLocale(script.dataset.radiosoLocale)
    const copy = getCopy(locale)
    const rawLabel = script.dataset.radiosoLauncherLabel
    const label =
      rawLabel && rawLabel.trim() && rawLabel.trim() !== DEFAULT_LABEL ? rawLabel.trim() : copy.launcherDefaultLabel
    const icon = script.dataset.radiosoLauncherIcon || DEFAULT_ICON
    const position = script.dataset.radiosoLauncherPosition || DEFAULT_POSITION
    const initialState = normalizeInitialState(script.dataset.radiosoInitialState) || DEFAULT_INITIAL_STATE
    const avatarUrl = resolveAvatarUrl(script.dataset.radiosoCollapsedAvatarUrl)

    const host = document.createElement('div')
    host.style.position = 'fixed'
    host.style.zIndex = '2147483647'
    host.style.bottom = '24px'
    host.style.right = '24px'
    host.style.left = 'auto'
    host.style.display = 'flex'
    host.style.flexDirection = 'column'
    host.style.alignItems = 'flex-end'
    host.style.gap = '12px'

    if (position === 'bottom-left') {
      host.style.left = '24px'
      host.style.right = 'auto'
      host.style.alignItems = 'flex-start'
    }

    const panel = createPanel()
    panel.style.bottom = '72px'
    panel.style.right = '0'
    panel.style.left = 'auto'

    if (position === 'bottom-left') {
      panel.style.left = '0'
      panel.style.right = 'auto'
    }

    const button = createButton(label, icon, avatarUrl)
    let isOpen = initialState === 'open'
    let bootstrapPromise = null
    let iframe = null

    const ensureIframe = () => {
      if (iframe) {
        return iframe
      }

      iframe = createIframe(scriptUrl, token, locale)
      panel.appendChild(iframe)
      return iframe
    }

    const destroyIframe = () => {
      if (!iframe) {
        return
      }

      iframe.remove()
      iframe = null
      bootstrapPromise = null
    }

    const handleIframeMessage = (event) => {
      if (event.source !== (iframe && iframe.contentWindow)) {
        return
      }

      if (!event.data || typeof event.data !== 'object' || event.data.type !== READY_MESSAGE) {
        return
      }

      const resumeAnonymousSessionId =
        typeof event.data.resumeAnonymousSessionId === 'string' ? event.data.resumeAnonymousSessionId : null

      if (!bootstrapPromise) {
        const activeIframe = iframe
        const activeContentWindow = activeIframe && activeIframe.contentWindow

        bootstrapPromise = bootstrapEmbeddedSession(scriptUrl, token, { resumeAnonymousSessionId })
          .then((session) => {
            if (!activeContentWindow || iframe !== activeIframe) {
              return
            }

            activeContentWindow.postMessage({ type: SESSION_MESSAGE, session }, scriptUrl.origin)
          })
          .catch((error) => {
            if (!activeContentWindow || iframe !== activeIframe) {
              return
            }

            activeContentWindow.postMessage(
              {
                type: ERROR_MESSAGE,
                message: error instanceof Error ? error.message : 'Embedded chat could not be started from this website.',
              },
              scriptUrl.origin,
            )
          })
          .finally(() => {
            if (iframe === activeIframe) {
              bootstrapPromise = null
            }
          })
      }
    }

    const updatePanelVisibility = () => {
      panel.style.display = isOpen ? 'block' : 'none'
      panel.setAttribute('aria-hidden', isOpen ? 'false' : 'true')
      button.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
    }

    button.addEventListener('click', () => {
      isOpen = !isOpen
      if (isOpen) {
        ensureIframe()
      } else {
        destroyIframe()
      }
      updatePanelVisibility()
    })

    if (isOpen) {
      ensureIframe()
    }

    host.appendChild(panel)
    host.appendChild(button)
    window.addEventListener('message', handleIframeMessage)
    updatePanelVisibility()
    document.body.appendChild(host)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true })
  } else {
    init()
  }
})()
