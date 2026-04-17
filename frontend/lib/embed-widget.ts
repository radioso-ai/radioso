import type { GeneralSettings } from '@/lib/api'

export type WebsiteEmbedLauncherPosition = 'bottom-right' | 'bottom-left'
export type WebsiteEmbedLauncherIcon = 'chat' | 'sparkles' | 'message'
export type WebsiteEmbedInitialState = 'open' | 'collapsed'
export type WebsiteEmbedSupportedLocale = 'de' | 'en' | 'es' | 'fr' | 'it' | 'pt'

export interface WebsiteEmbedSnippetOverrides {
  locale?: string | null
  initialState?: string | null
  collapsedAvatarUrl?: string | null
}

export interface WebsiteEmbedCopy {
  launcherDefaultLabel: string
  embeddedChatTitle: string
  embeddedChatUnavailableTitle: string
  embeddedChatUnavailableMessage: string
  embeddedChatLauncherRequiredMessage: string
  embeddedChatStartingMessage: string
  publicChatSubtitle: string
  publicChatEmptyTitle: string
  publicChatEmptyMessage: string
  startPrompt: string
  publicChatUnavailableTitle: string
  publicChatUnavailableMessage: string
  publicChatLoadOlderMessages: string
  publicChatSendMessageLabel: string
  publicChatNewChatLabel: string
  publicChatRateLimitRetry: (seconds: number) => string
}

export const DEFAULT_WEBSITE_EMBED_LAUNCHER_LABEL = 'Chat with us'
export const DEFAULT_WEBSITE_EMBED_LAUNCHER_ICON: WebsiteEmbedLauncherIcon = 'chat'
export const DEFAULT_WEBSITE_EMBED_LAUNCHER_POSITION: WebsiteEmbedLauncherPosition = 'bottom-right'
export const DEFAULT_WEBSITE_EMBED_SCRIPT_PATH = '/radioso-embed.js'
export const DEFAULT_WEBSITE_EMBED_INITIAL_STATE: WebsiteEmbedInitialState = 'collapsed'

const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?$/

const websiteEmbedCopyByLocale: Record<WebsiteEmbedSupportedLocale, WebsiteEmbedCopy> = {
  de: {
    launcherDefaultLabel: 'Chatte mit uns',
    embeddedChatTitle: 'Eingebetteter Radioso-Chat',
    embeddedChatUnavailableTitle: 'Eingebetteter Chat nicht verfugbar',
    embeddedChatUnavailableMessage: 'Dieser eingebettete Chat konnte auf dieser Website nicht gestartet werden.',
    embeddedChatLauncherRequiredMessage: 'Dieser eingebettete Chat muss uber das Launcher-Skript geoffnet werden.',
    embeddedChatStartingMessage: 'Eingebetteter Chat wird gestartet...',
    publicChatSubtitle: 'Stelle Fragen und erhalte KI-gestutzte Antworten',
    publicChatEmptyTitle: 'Starte ein Gesprach',
    publicChatEmptyMessage: 'Stelle eine Frage und erhalte eine KI-gestutzte Antwort.',
    startPrompt: 'Stelle eine Frage...',
    publicChatUnavailableTitle: 'Chat nicht verfugbar',
    publicChatUnavailableMessage: 'Dieser Chat-Link ist nicht mehr aktiv. Bitte kontaktiere die Workspace-Administration.',
    publicChatLoadOlderMessages: 'Altere Nachrichten laden',
    publicChatSendMessageLabel: 'Nachricht senden',
    publicChatNewChatLabel: 'Neuer Chat',
    publicChatRateLimitRetry: (seconds) => `Versuche es in ${seconds}s erneut.`,
  },
  en: {
    launcherDefaultLabel: 'Chat with us',
    embeddedChatTitle: 'Radioso embedded chat',
    embeddedChatUnavailableTitle: 'Embedded Chat Unavailable',
    embeddedChatUnavailableMessage: 'This embedded chat could not be started from this website.',
    embeddedChatLauncherRequiredMessage: 'This embedded chat must be opened from the launcher script.',
    embeddedChatStartingMessage: 'Starting embedded chat...',
    publicChatSubtitle: 'Ask questions and get AI-powered answers',
    publicChatEmptyTitle: 'Start a conversation',
    publicChatEmptyMessage: 'Ask a question and get an AI-powered answer.',
    startPrompt: 'Ask a question...',
    publicChatUnavailableTitle: 'Chat Unavailable',
    publicChatUnavailableMessage: 'This chat link is no longer active. Please contact the workspace administrator for access.',
    publicChatLoadOlderMessages: 'Load older messages',
    publicChatSendMessageLabel: 'Send message',
    publicChatNewChatLabel: 'New chat',
    publicChatRateLimitRetry: (seconds) => `Try again in ${seconds}s.`,
  },
  es: {
    launcherDefaultLabel: 'Chatea con nosotros',
    embeddedChatTitle: 'Chat incrustado de Radioso',
    embeddedChatUnavailableTitle: 'Chat incrustado no disponible',
    embeddedChatUnavailableMessage: 'No se pudo iniciar este chat incrustado desde este sitio web.',
    embeddedChatLauncherRequiredMessage: 'Este chat incrustado debe abrirse desde el script del lanzador.',
    embeddedChatStartingMessage: 'Iniciando chat incrustado...',
    publicChatSubtitle: 'Haz preguntas y recibe respuestas con IA',
    publicChatEmptyTitle: 'Empieza una conversacion',
    publicChatEmptyMessage: 'Haz una pregunta y recibe una respuesta con IA.',
    startPrompt: 'Haz una pregunta...',
    publicChatUnavailableTitle: 'Chat no disponible',
    publicChatUnavailableMessage: 'Este enlace de chat ya no esta activo. Ponte en contacto con la administracion del workspace para obtener acceso.',
    publicChatLoadOlderMessages: 'Cargar mensajes anteriores',
    publicChatSendMessageLabel: 'Enviar mensaje',
    publicChatNewChatLabel: 'Nuevo chat',
    publicChatRateLimitRetry: (seconds) => `Vuelve a intentarlo en ${seconds}s.`,
  },
  fr: {
    launcherDefaultLabel: 'Discutez avec nous',
    embeddedChatTitle: 'Chat integre Radioso',
    embeddedChatUnavailableTitle: 'Chat integre indisponible',
    embeddedChatUnavailableMessage: 'Ce chat integre na pas pu etre demarre depuis ce site.',
    embeddedChatLauncherRequiredMessage: 'Ce chat integre doit etre ouvert depuis le script du lanceur.',
    embeddedChatStartingMessage: 'Demarrage du chat integre...',
    publicChatSubtitle: 'Posez des questions et obtenez des reponses avec l IA',
    publicChatEmptyTitle: 'Commencez une conversation',
    publicChatEmptyMessage: 'Posez une question et obtenez une reponse avec l IA.',
    startPrompt: 'Posez une question...',
    publicChatUnavailableTitle: 'Chat indisponible',
    publicChatUnavailableMessage: 'Ce lien de chat nest plus actif. Contactez ladministration du workspace pour obtenir lacces.',
    publicChatLoadOlderMessages: 'Charger les anciens messages',
    publicChatSendMessageLabel: 'Envoyer le message',
    publicChatNewChatLabel: 'Nouveau chat',
    publicChatRateLimitRetry: (seconds) => `Reessayez dans ${seconds}s.`,
  },
  it: {
    launcherDefaultLabel: 'Chatta con noi',
    embeddedChatTitle: 'Chat incorporata Radioso',
    embeddedChatUnavailableTitle: 'Chat incorporata non disponibile',
    embeddedChatUnavailableMessage: 'Questa chat incorporata non puo essere avviata da questo sito.',
    embeddedChatLauncherRequiredMessage: 'Questa chat incorporata deve essere aperta dallo script del launcher.',
    embeddedChatStartingMessage: 'Avvio della chat incorporata...',
    publicChatSubtitle: 'Fai domande e ottieni risposte con l AI',
    publicChatEmptyTitle: 'Inizia una conversazione',
    publicChatEmptyMessage: 'Fai una domanda e ottieni una risposta con l AI.',
    startPrompt: 'Fai una domanda...',
    publicChatUnavailableTitle: 'Chat non disponibile',
    publicChatUnavailableMessage: 'Questo link chat non e piu attivo. Contatta lamministrazione del workspace per ottenere accesso.',
    publicChatLoadOlderMessages: 'Carica messaggi precedenti',
    publicChatSendMessageLabel: 'Invia messaggio',
    publicChatNewChatLabel: 'Nuova chat',
    publicChatRateLimitRetry: (seconds) => `Riprova tra ${seconds}s.`,
  },
  pt: {
    launcherDefaultLabel: 'Converse conosco',
    embeddedChatTitle: 'Chat incorporado do Radioso',
    embeddedChatUnavailableTitle: 'Chat incorporado indisponivel',
    embeddedChatUnavailableMessage: 'Nao foi possivel iniciar este chat incorporado neste site.',
    embeddedChatLauncherRequiredMessage: 'Este chat incorporado precisa ser aberto pelo script do launcher.',
    embeddedChatStartingMessage: 'Iniciando chat incorporado...',
    publicChatSubtitle: 'Faca perguntas e receba respostas com IA',
    publicChatEmptyTitle: 'Comece uma conversa',
    publicChatEmptyMessage: 'Faca uma pergunta e receba uma resposta com IA.',
    startPrompt: 'Faca uma pergunta...',
    publicChatUnavailableTitle: 'Chat indisponivel',
    publicChatUnavailableMessage: 'Este link de chat nao esta mais ativo. Fale com a administracao do workspace para obter acesso.',
    publicChatLoadOlderMessages: 'Carregar mensagens anteriores',
    publicChatSendMessageLabel: 'Enviar mensagem',
    publicChatNewChatLabel: 'Nova conversa',
    publicChatRateLimitRetry: (seconds) => `Tente novamente em ${seconds}s.`,
  },
}

const escapeHtmlAttribute = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')

const normalizeOrigin = (origin: string) => {
  const trimmed = origin.trim()
  if (!trimmed) {
    return null
  }

  try {
    return new URL(trimmed).origin
  } catch {
    return null
  }
}

export const parseWebsiteEmbedOrigins = (value: string) =>
  value
    .split(/\r?\n/)
    .map(normalizeOrigin)
    .filter((origin): origin is string => Boolean(origin))

export const formatWebsiteEmbedOrigins = (origins: string[]) => origins.join('\n')

export const normalizeWebsiteEmbedLocale = (value: string | null | undefined): WebsiteEmbedSupportedLocale | null => {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 35 || !LOCALE_PATTERN.test(trimmed)) {
    return null
  }

  const language = trimmed.split('-')[0]?.toLowerCase()
  if (!language) {
    return null
  }

  return language in websiteEmbedCopyByLocale ? (language as WebsiteEmbedSupportedLocale) : null
}

export const normalizeWebsiteEmbedInitialState = (value: string | null | undefined): WebsiteEmbedInitialState | null => {
  if (!value) {
    return null
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === 'open' || normalized === 'collapsed') {
    return normalized
  }

  return null
}

export const normalizeWebsiteEmbedAvatarUrl = (value: string | null | undefined): string | null => {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('//')
  ) {
    return trimmed
  }

  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

export const getWebsiteEmbedCopy = (value: string | null | undefined): WebsiteEmbedCopy => {
  const locale = normalizeWebsiteEmbedLocale(value) ?? 'en'
  return websiteEmbedCopyByLocale[locale]
}

export const resolveWebsiteEmbedScriptUrl = (scriptUrl?: string | null, baseUrl?: string) => {
  const normalizedScriptUrl = scriptUrl?.trim()
  if (normalizedScriptUrl) {
    return normalizedScriptUrl
  }

  if (baseUrl) {
    return new URL(DEFAULT_WEBSITE_EMBED_SCRIPT_PATH, baseUrl).toString()
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    return new URL(DEFAULT_WEBSITE_EMBED_SCRIPT_PATH, window.location.origin).toString()
  }

  return DEFAULT_WEBSITE_EMBED_SCRIPT_PATH
}

export const buildWebsiteEmbedSnippet = (
  settings: Pick<
    GeneralSettings,
    | 'websiteEmbedEnabled'
    | 'websiteEmbedToken'
    | 'websiteEmbedScriptUrl'
    | 'websiteEmbedAllowedOrigins'
    | 'websiteEmbedLauncherLabel'
    | 'websiteEmbedLauncherIcon'
    | 'websiteEmbedLauncherPosition'
  >,
  baseUrl?: string,
  overrides?: WebsiteEmbedSnippetOverrides,
) => {
  if (!settings.websiteEmbedEnabled || !settings.websiteEmbedToken) {
    return null
  }

  const scriptUrl = resolveWebsiteEmbedScriptUrl(settings.websiteEmbedScriptUrl, baseUrl)
  const launcherLabel = settings.websiteEmbedLauncherLabel?.trim() || DEFAULT_WEBSITE_EMBED_LAUNCHER_LABEL
  const launcherIcon = settings.websiteEmbedLauncherIcon ?? DEFAULT_WEBSITE_EMBED_LAUNCHER_ICON
  const launcherPosition = settings.websiteEmbedLauncherPosition ?? DEFAULT_WEBSITE_EMBED_LAUNCHER_POSITION
  const allowedOrigins = (settings.websiteEmbedAllowedOrigins ?? []).map(normalizeOrigin).filter((origin): origin is string => Boolean(origin))
  const originAttribute = allowedOrigins.length > 0 ? ` data-radioso-allowed-origins="${escapeHtmlAttribute(allowedOrigins.join(','))}"` : ''
  const locale = normalizeWebsiteEmbedLocale(overrides?.locale)
  const initialState = normalizeWebsiteEmbedInitialState(overrides?.initialState)
  const collapsedAvatarUrl = normalizeWebsiteEmbedAvatarUrl(overrides?.collapsedAvatarUrl)
  const localeAttribute = locale ? ` data-radioso-locale="${escapeHtmlAttribute(overrides?.locale?.trim() ?? locale)}"` : ''
  const initialStateAttribute = initialState ? ` data-radioso-initial-state="${escapeHtmlAttribute(initialState)}"` : ''
  const collapsedAvatarAttribute = collapsedAvatarUrl
    ? ` data-radioso-collapsed-avatar-url="${escapeHtmlAttribute(collapsedAvatarUrl)}"`
    : ''

  return [
    `<script`,
    `  async`,
    `  src="${escapeHtmlAttribute(scriptUrl)}"`,
    `  data-radioso-token="${escapeHtmlAttribute(settings.websiteEmbedToken)}"`,
    `  data-radioso-launcher-label="${escapeHtmlAttribute(launcherLabel)}"`,
    `  data-radioso-launcher-icon="${escapeHtmlAttribute(launcherIcon)}"`,
    `  data-radioso-launcher-position="${escapeHtmlAttribute(launcherPosition)}"${originAttribute}${localeAttribute}${initialStateAttribute}${collapsedAvatarAttribute}`,
    `></script>`,
  ].join('\n')
}
