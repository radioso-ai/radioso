(function () {
  const SCRIPT_PATH = '/radioso-embed.js'
  const DEFAULT_LABEL = 'Chat with us'
  const DEFAULT_POSITION = 'bottom-right'
  const DEFAULT_ICON = 'chat'
  const DEFAULT_INITIAL_STATE = 'collapsed'
  const READY_MESSAGE = 'radioso:embed:ready'
  const SESSION_MESSAGE = 'radioso:embed:session'
  const ERROR_MESSAGE = 'radioso:embed:error'
  const defaultCopy = {
    launcherDefaultLabel: 'Chat with us',
    iframeTitle: 'Radioso embedded chat',
  }

  const defaultTheme = {
    launcherBackground: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
    launcherForeground: '#f8fafc',
    launcherBorder: 'rgba(15, 23, 42, 0.16)',
    launcherShadow: '0 18px 40px rgba(15, 23, 42, 0.24)',
    panelBackground: '#ffffff',
    panelForeground: '#0f172a',
    panelBorder: 'rgba(148, 163, 184, 0.35)',
    panelShadow: '0 24px 60px rgba(15, 23, 42, 0.28)',
    accent: '#0f172a',
    accentForeground: '#f8fafc',
    mutedBackground: '#f8fafc',
    mutedForeground: '#64748b',
    inputBackground: '#ffffff',
    inputForeground: '#0f172a',
    inputBorder: '#cbd5e1',
    inputPlaceholder: '#94a3b8',
    assistantBubbleBackground: '#ffffff',
    assistantBubbleForeground: '#0f172a',
    userBubbleBackground: '#0f172a',
    userBubbleForeground: '#f8fafc',
  }

  const copyOverrideKeys = [
    'launcherDefaultLabel',
    'embeddedChatTitle',
    'embeddedChatUnavailableTitle',
    'embeddedChatUnavailableMessage',
    'embeddedChatLauncherRequiredMessage',
    'embeddedChatStartingMessage',
    'publicChatSubtitle',
    'publicChatEmptyTitle',
    'publicChatEmptyMessage',
    'startPrompt',
    'publicChatUnavailableTitle',
    'publicChatUnavailableMessage',
    'publicChatLoadOlderMessages',
    'publicChatSendMessageLabel',
    'publicChatNewChatLabel',
    'publicChatRateLimitRetryTemplate',
  ]

  const themeOverrideKeys = [
    'launcherBackground',
    'launcherForeground',
    'launcherBorder',
    'launcherShadow',
    'panelBackground',
    'panelForeground',
    'panelBorder',
    'panelShadow',
    'accent',
    'accentForeground',
    'mutedBackground',
    'mutedForeground',
    'inputBackground',
    'inputForeground',
    'inputBorder',
    'inputPlaceholder',
    'assistantBubbleBackground',
    'assistantBubbleForeground',
    'userBubbleBackground',
    'userBubbleForeground',
  ]

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

  const parseJsonOverrides = (value) => {
    if (!value || typeof value !== 'string') {
      return null
    }

    try {
      return JSON.parse(value.trim())
    } catch {
      return null
    }
  }

  const sanitizeOverrides = (input, keys, maxLength) => {
    if (!input || typeof input !== 'object') {
      return {}
    }

    const next = {}
    for (const key of keys) {
      const value = input[key]
      if (typeof value !== 'string') {
        continue
      }
      const trimmed = value.trim()
      if (!trimmed || trimmed.length > maxLength) {
        continue
      }
      next[key] = trimmed
    }
    return next
  }

  const getCopy = (overrides) => {
    const next = { ...defaultCopy }
    if (overrides && typeof overrides === 'object') {
      if (overrides.launcherDefaultLabel) {
        next.launcherDefaultLabel = overrides.launcherDefaultLabel
      }
      if (overrides.embeddedChatTitle) {
        next.iframeTitle = overrides.embeddedChatTitle
      }
    }
    return next
  }

  const setIconMarkup = (container, icon) => {
    container.innerHTML = iconMarkup[icon] ?? iconMarkup[DEFAULT_ICON]
    const svg = container.querySelector('svg')
    if (svg) {
      svg.setAttribute('width', '18')
      svg.setAttribute('height', '18')
    }
  }

  const createPanel = (theme) => {
    const panel = document.createElement('div')
    panel.setAttribute('aria-hidden', 'true')
    panel.style.width = 'min(440px, calc(100vw - 2rem))'
    panel.style.height = '100%'
    panel.style.maxHeight = 'calc(100vh - 2rem)'
    panel.style.borderRadius = '28px'
    panel.style.overflow = 'hidden'
    panel.style.boxShadow = theme.panelShadow
    panel.style.background = theme.panelBackground
    panel.style.border = `1px solid ${theme.panelBorder}`
    panel.style.display = 'none'
    panel.style.pointerEvents = 'auto'
    return panel
  }

  const createIframe = (scriptUrl, token, options) => {
    const iframe = document.createElement('iframe')
    iframe.title = options.copy.iframeTitle
    iframe.loading = 'lazy'
    iframe.referrerPolicy = 'no-referrer-when-downgrade'
    iframe.allow = 'clipboard-read; clipboard-write'
    iframe.style.border = '0'
    iframe.style.width = '100%'
    iframe.style.height = '100%'
    iframe.style.background = options.theme.panelBackground

    const iframeUrl = new URL(`/embed/${encodeURIComponent(token)}`, scriptUrl)
    if (options.avatarUrl) {
      iframeUrl.searchParams.set('avatar', options.avatarUrl)
    }
    if (Object.keys(options.copyOverrides).length > 0) {
      iframeUrl.searchParams.set('copy', JSON.stringify(options.copyOverrides))
    }
    if (Object.keys(options.themeOverrides).length > 0) {
      iframeUrl.searchParams.set('theme', JSON.stringify(options.themeOverrides))
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

  const createButton = (label, icon, avatarUrl, theme) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('aria-label', label)

    const iconContainer = document.createElement('span')
    iconContainer.setAttribute('aria-hidden', 'true')
    iconContainer.style.display = 'inline-flex'
    iconContainer.style.alignItems = 'center'
    iconContainer.style.justifyContent = 'center'
    iconContainer.style.width = '2rem'
    iconContainer.style.height = '2rem'
    iconContainer.style.overflow = 'hidden'
    iconContainer.style.borderRadius = '9999px'
    iconContainer.style.flexShrink = '0'
    iconContainer.style.background = theme.mutedBackground
    iconContainer.style.color = theme.accent

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
    button.style.gap = '0.75rem'
    button.style.padding = '0.875rem 1rem'
    button.style.borderRadius = '18px'
    button.style.cursor = 'pointer'
    button.style.background = theme.launcherBackground
    button.style.color = theme.launcherForeground
    button.style.border = `1px solid ${theme.launcherBorder}`
    button.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif'
    button.style.fontSize = '14px'
    button.style.fontWeight = '600'
    button.style.lineHeight = '1'
    button.style.boxShadow = theme.launcherShadow
    button.style.transition = 'transform 140ms ease, opacity 140ms ease'
    button.style.userSelect = 'none'
    button.style.pointerEvents = 'auto'
    button.addEventListener('mouseenter', () => {
      button.style.transform = 'translateY(-1px)'
    })
    button.addEventListener('mouseleave', () => {
      button.style.transform = 'translateY(0)'
    })
    return button
  }

  const init = () => {
    const script = getScriptElement()
    if (!script) {
      return
    }

    const token = script.dataset.radiosoToken
    if (!token || window.__radiosoEmbedMounted) {
      return
    }
    window.__radiosoEmbedMounted = true

    const scriptUrl = getScriptUrl(script)
    const copyOverrides = sanitizeOverrides(parseJsonOverrides(script.dataset.radiosoCopy), copyOverrideKeys, 280)
    const themeOverrides = sanitizeOverrides(parseJsonOverrides(script.dataset.radiosoTheme), themeOverrideKeys, 160)
    const copy = getCopy(copyOverrides)
    const theme = { ...defaultTheme, ...themeOverrides }
    const rawLabel = script.dataset.radiosoLauncherLabel
    const label =
      rawLabel && rawLabel.trim() && rawLabel.trim() !== DEFAULT_LABEL ? rawLabel.trim() : copy.launcherDefaultLabel
    const icon = script.dataset.radiosoLauncherIcon || DEFAULT_ICON
    const position = script.dataset.radiosoLauncherPosition || DEFAULT_POSITION
    const initialState = normalizeInitialState(script.dataset.radiosoInitialState) || DEFAULT_INITIAL_STATE
    const avatarUrl = resolveAvatarUrl(
      script.dataset.radiosoAvatarUrl || script.dataset.radiosoCollapsedAvatarUrl,
    )

    const host = document.createElement('div')
    host.style.position = 'fixed'
    host.style.zIndex = '2147483647'
    host.style.top = '16px'
    host.style.bottom = '16px'
    host.style.right = '16px'
    host.style.left = 'auto'
    host.style.display = 'flex'
    host.style.flexDirection = 'column'
    host.style.alignItems = 'flex-end'
    host.style.justifyContent = 'flex-end'
    host.style.gap = '12px'
    host.style.pointerEvents = 'none'
    host.style.maxWidth = 'calc(100vw - 2rem)'

    if (position === 'bottom-left') {
      host.style.left = '16px'
      host.style.right = 'auto'
      host.style.alignItems = 'flex-start'
    }

    const panel = createPanel(theme)
    const button = createButton(label, icon, avatarUrl, theme)

    let isOpen = initialState === 'open'
    let bootstrapPromise = null
    let iframe = null

    const ensureIframe = () => {
      if (iframe) {
        return iframe
      }

      iframe = createIframe(scriptUrl, token, {
        avatarUrl,
        copy,
        copyOverrides,
        theme,
        themeOverrides,
      })
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
      button.style.opacity = isOpen ? '0.94' : '1'
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
