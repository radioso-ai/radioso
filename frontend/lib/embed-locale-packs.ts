import type { WebsiteEmbedCopy, WebsiteEmbedCopyOverrides } from '@/lib/embed-widget'

// Built-in visitor-facing translations, typed and reusable across every embed
// surface. The standalone launcher (`radioso-embed-launcher.js`) keeps its own
// inline copy of these packs because it is served raw and cannot import a
// module; `tests/unit/embed-locale-parity.test.ts` asserts the two stay in
// sync, so this module is the single source of truth and the launcher mirrors
// it. English is the baseline (`DEFAULT_WEBSITE_EMBED_COPY`) and intentionally
// absent here. `proactiveGreetingTeaser` is launcher-only (the widget teaser
// bubble) and is not part of the in-frame copy contract.
export type EmbedLocalePack = WebsiteEmbedCopyOverrides & { proactiveGreetingTeaser?: string }

// Keys every locale pack must translate. Mirrors the in-frame copy contract
// except `publicChatSubtitle`, which is operator branding (blank by default)
// and has no universal translation.
export const TRANSLATABLE_COPY_KEYS = [
  'launcherDefaultLabel',
  'embeddedChatTitle',
  'embeddedChatUnavailableTitle',
  'embeddedChatUnavailableMessage',
  'embeddedChatLauncherRequiredMessage',
  'embeddedChatStartingMessage',
  'publicChatEmptyTitle',
  'publicChatEmptyMessage',
  'startPrompt',
  'publicChatUnavailableTitle',
  'publicChatUnavailableMessage',
  'publicChatLoadOlderMessages',
  'publicChatSendMessageLabel',
  'publicChatContactHumanLabel',
  'publicChatContactHumanMessage',
  'publicChatNewChatLabel',
  'publicChatCollapseLabel',
  'publicChatOpenFullScreenLabel',
  'publicChatOpenNewTabLabel',
  'publicChatDisclaimerTemplate',
  'publicChatRateLimitRetryTemplate',
  'publicChatMessageFailedMessage',
  'skillReceiptSubmittedLabel',
  'skillReceiptFailedLabel',
] as const satisfies readonly (keyof WebsiteEmbedCopy)[]

export const BUILT_IN_EMBED_LOCALE_PACKS: Record<string, EmbedLocalePack> = {
  es: {
    launcherDefaultLabel: 'Chatea con nosotros',
    embeddedChatTitle: 'Chat embebido de Radioso',
    proactiveGreetingTeaser: '¡Hola! ¿En qué puedo ayudarte?',
    embeddedChatUnavailableTitle: 'Chat no disponible',
    embeddedChatUnavailableMessage: 'No se pudo iniciar este chat desde este sitio web.',
    embeddedChatLauncherRequiredMessage: 'Este chat debe abrirse desde el script del botón.',
    embeddedChatStartingMessage: 'Invocando a {name}...',
    publicChatEmptyTitle: 'Inicia una conversación',
    publicChatEmptyMessage: 'Dime en qué puedo ayudarte.',
    startPrompt: 'Haz una pregunta...',
    publicChatUnavailableTitle: 'Chat no disponible',
    publicChatUnavailableMessage:
      'Este enlace de chat ya no está activo. Contacta al administrador del espacio de trabajo para obtener acceso.',
    publicChatLoadOlderMessages: 'Cargar mensajes anteriores',
    publicChatSendMessageLabel: 'Enviar mensaje',
    publicChatContactHumanLabel: 'Hablar con una persona',
    publicChatContactHumanMessage: 'Quiero hablar con una persona.',
    publicChatNewChatLabel: 'Borrar chat',
    publicChatCollapseLabel: 'Contraer chat',
    publicChatOpenFullScreenLabel: 'Abrir en pantalla completa',
    publicChatOpenNewTabLabel: 'Abrir en una pestaña nueva',
    publicChatDisclaimerTemplate: '{name} usa IA y puede cometer errores.',
    publicChatRateLimitRetryTemplate: 'Inténtalo de nuevo en {seconds}s.',
    publicChatMessageFailedMessage: 'Lo sentimos, algo ha salido mal. Inténtalo de nuevo.',
    skillReceiptSubmittedLabel: 'Enviado',
    skillReceiptFailedLabel: 'No se pudo enviar',
  },
  fr: {
    launcherDefaultLabel: 'Discutez avec nous',
    embeddedChatTitle: 'Chat intégré Radioso',
    proactiveGreetingTeaser: 'Bonjour ! Comment puis-je vous aider ?',
    embeddedChatUnavailableTitle: 'Chat indisponible',
    embeddedChatUnavailableMessage: "Ce chat n'a pas pu être lancé depuis ce site web.",
    embeddedChatLauncherRequiredMessage: 'Ce chat doit être ouvert depuis le script du bouton.',
    embeddedChatStartingMessage: 'Connexion à {name}...',
    publicChatEmptyTitle: 'Commencer une conversation',
    publicChatEmptyMessage: 'Dites-moi comment je peux vous aider.',
    startPrompt: 'Posez une question...',
    publicChatUnavailableTitle: 'Chat indisponible',
    publicChatUnavailableMessage:
      "Ce lien de chat n'est plus actif. Veuillez contacter l'administrateur de l'espace de travail.",
    publicChatLoadOlderMessages: 'Charger les messages précédents',
    publicChatSendMessageLabel: 'Envoyer le message',
    publicChatContactHumanLabel: 'Parler à une personne',
    publicChatContactHumanMessage: 'Je souhaite parler à une personne.',
    publicChatNewChatLabel: 'Effacer le chat',
    publicChatCollapseLabel: 'Réduire le chat',
    publicChatOpenFullScreenLabel: 'Ouvrir en plein écran',
    publicChatOpenNewTabLabel: 'Ouvrir dans un nouvel onglet',
    publicChatDisclaimerTemplate: "{name} utilise l'IA et peut faire des erreurs.",
    publicChatRateLimitRetryTemplate: 'Réessayez dans {seconds} s.',
    publicChatMessageFailedMessage: 'Désolé, une erreur est survenue. Veuillez réessayer.',
    skillReceiptSubmittedLabel: 'Envoyé',
    skillReceiptFailedLabel: "Échec de l'envoi",
  },
  de: {
    launcherDefaultLabel: 'Mit uns chatten',
    embeddedChatTitle: 'Eingebetteter Radioso-Chat',
    proactiveGreetingTeaser: 'Hallo! Wie kann ich helfen?',
    embeddedChatUnavailableTitle: 'Chat nicht verfügbar',
    embeddedChatUnavailableMessage: 'Dieser Chat konnte von dieser Website nicht gestartet werden.',
    embeddedChatLauncherRequiredMessage: 'Dieser Chat muss über das Schaltflächen-Skript geöffnet werden.',
    embeddedChatStartingMessage: 'Verbinde mit {name}...',
    publicChatEmptyTitle: 'Gespräch beginnen',
    publicChatEmptyMessage: 'Sagen Sie mir, wie ich Ihnen helfen kann.',
    startPrompt: 'Frage stellen...',
    publicChatUnavailableTitle: 'Chat nicht verfügbar',
    publicChatUnavailableMessage:
      'Dieser Chat-Link ist nicht mehr aktiv. Bitte wenden Sie sich an den Arbeitsbereichsadministrator.',
    publicChatLoadOlderMessages: 'Ältere Nachrichten laden',
    publicChatSendMessageLabel: 'Nachricht senden',
    publicChatContactHumanLabel: 'Mit einem Menschen sprechen',
    publicChatContactHumanMessage: 'Ich möchte mit einem Menschen sprechen.',
    publicChatNewChatLabel: 'Chat löschen',
    publicChatCollapseLabel: 'Chat einklappen',
    publicChatOpenFullScreenLabel: 'Im Vollbild öffnen',
    publicChatOpenNewTabLabel: 'In neuem Tab öffnen',
    publicChatDisclaimerTemplate: '{name} verwendet KI und kann Fehler machen.',
    publicChatRateLimitRetryTemplate: 'Erneut versuchen in {seconds} s.',
    publicChatMessageFailedMessage: 'Entschuldigung, etwas ist schiefgelaufen. Bitte versuchen Sie es erneut.',
    skillReceiptSubmittedLabel: 'Gesendet',
    skillReceiptFailedLabel: 'Senden fehlgeschlagen',
  },
  it: {
    launcherDefaultLabel: 'Chatta con noi',
    embeddedChatTitle: 'Chat integrata Radioso',
    proactiveGreetingTeaser: 'Ciao! Come posso aiutarti?',
    embeddedChatUnavailableTitle: 'Chat non disponibile',
    embeddedChatUnavailableMessage: 'Impossibile avviare questa chat da questo sito web.',
    embeddedChatLauncherRequiredMessage: 'Questa chat deve essere aperta dallo script del pulsante.',
    embeddedChatStartingMessage: 'Connessione a {name}...',
    publicChatEmptyTitle: 'Inizia una conversazione',
    publicChatEmptyMessage: 'Dimmi come posso aiutarti.',
    startPrompt: 'Fai una domanda...',
    publicChatUnavailableTitle: 'Chat non disponibile',
    publicChatUnavailableMessage:
      "Questo link non è più attivo. Contatta l'amministratore dello spazio di lavoro per accedere.",
    publicChatLoadOlderMessages: 'Carica messaggi precedenti',
    publicChatSendMessageLabel: 'Invia messaggio',
    publicChatContactHumanLabel: 'Parlare con una persona',
    publicChatContactHumanMessage: 'Vorrei parlare con una persona.',
    publicChatNewChatLabel: 'Cancella chat',
    publicChatCollapseLabel: 'Riduci chat',
    publicChatOpenFullScreenLabel: 'Apri a schermo intero',
    publicChatOpenNewTabLabel: 'Apri in una nuova scheda',
    publicChatDisclaimerTemplate: "{name} utilizza l'IA e può commettere errori.",
    publicChatRateLimitRetryTemplate: 'Riprova tra {seconds} s.',
    publicChatMessageFailedMessage: 'Spiacenti, qualcosa è andato storto. Riprova.',
    skillReceiptSubmittedLabel: 'Inviato',
    skillReceiptFailedLabel: 'Invio non riuscito',
  },
  pt: {
    launcherDefaultLabel: 'Fale conosco',
    embeddedChatTitle: 'Chat incorporado Radioso',
    proactiveGreetingTeaser: 'Olá! Como posso ajudar?',
    embeddedChatUnavailableTitle: 'Chat indisponível',
    embeddedChatUnavailableMessage: 'Não foi possível iniciar este chat a partir deste site.',
    embeddedChatLauncherRequiredMessage: 'Este chat deve ser aberto pelo script do botão.',
    embeddedChatStartingMessage: 'Conectando a {name}...',
    publicChatEmptyTitle: 'Iniciar uma conversa',
    publicChatEmptyMessage: 'Diga-me como posso ajudar.',
    startPrompt: 'Faça uma pergunta...',
    publicChatUnavailableTitle: 'Chat indisponível',
    publicChatUnavailableMessage:
      'Este link de chat não está mais ativo. Entre em contato com o administrador do espaço de trabalho.',
    publicChatLoadOlderMessages: 'Carregar mensagens anteriores',
    publicChatSendMessageLabel: 'Enviar mensagem',
    publicChatContactHumanLabel: 'Falar com uma pessoa',
    publicChatContactHumanMessage: 'Quero falar com uma pessoa.',
    publicChatNewChatLabel: 'Limpar chat',
    publicChatCollapseLabel: 'Recolher chat',
    publicChatOpenFullScreenLabel: 'Abrir em tela cheia',
    publicChatOpenNewTabLabel: 'Abrir em nova aba',
    publicChatDisclaimerTemplate: '{name} usa IA e pode cometer erros.',
    publicChatRateLimitRetryTemplate: 'Tente novamente em {seconds}s.',
    publicChatMessageFailedMessage: 'Desculpe, algo correu mal. Tente novamente.',
    skillReceiptSubmittedLabel: 'Enviado',
    skillReceiptFailedLabel: 'Falha ao enviar',
  },
  nl: {
    launcherDefaultLabel: 'Chat met ons',
    embeddedChatTitle: 'Radioso ingesloten chat',
    proactiveGreetingTeaser: 'Hallo! Hoe kan ik helpen?',
    embeddedChatUnavailableTitle: 'Chat niet beschikbaar',
    embeddedChatUnavailableMessage: 'Deze chat kon niet worden gestart vanaf deze website.',
    embeddedChatLauncherRequiredMessage: 'Deze chat moet worden geopend via het knopscript.',
    embeddedChatStartingMessage: 'Verbinding maken met {name}...',
    publicChatEmptyTitle: 'Een gesprek starten',
    publicChatEmptyMessage: 'Vertel me waarmee ik je kan helpen.',
    startPrompt: 'Stel een vraag...',
    publicChatUnavailableTitle: 'Chat niet beschikbaar',
    publicChatUnavailableMessage:
      'Deze chatlink is niet meer actief. Neem contact op met de werkruimtebeheerder voor toegang.',
    publicChatLoadOlderMessages: 'Oudere berichten laden',
    publicChatSendMessageLabel: 'Bericht verzenden',
    publicChatContactHumanLabel: 'Met een medewerker praten',
    publicChatContactHumanMessage: 'Ik wil met een medewerker praten.',
    publicChatNewChatLabel: 'Chat wissen',
    publicChatCollapseLabel: 'Chat inklappen',
    publicChatOpenFullScreenLabel: 'Volledig scherm openen',
    publicChatOpenNewTabLabel: 'Openen in nieuw tabblad',
    publicChatDisclaimerTemplate: '{name} gebruikt AI en kan fouten maken.',
    publicChatRateLimitRetryTemplate: 'Probeer het opnieuw over {seconds}s.',
    publicChatMessageFailedMessage: 'Sorry, er is iets misgegaan. Probeer het opnieuw.',
    skillReceiptSubmittedLabel: 'Verzonden',
    skillReceiptFailedLabel: 'Verzenden mislukt',
  },
  pl: {
    launcherDefaultLabel: 'Porozmawiaj z nami',
    embeddedChatTitle: 'Osadzony czat Radioso',
    proactiveGreetingTeaser: 'Cześć! Jak mogę pomóc?',
    embeddedChatUnavailableTitle: 'Czat niedostępny',
    embeddedChatUnavailableMessage: 'Nie można uruchomić tego czatu z tej witryny.',
    embeddedChatLauncherRequiredMessage: 'Ten czat musi zostać otwarty ze skryptu przycisku.',
    embeddedChatStartingMessage: 'Łączenie z {name}...',
    publicChatEmptyTitle: 'Rozpocznij rozmowę',
    publicChatEmptyMessage: 'Powiedz, jak mogę pomóc.',
    startPrompt: 'Zadaj pytanie...',
    publicChatUnavailableTitle: 'Czat niedostępny',
    publicChatUnavailableMessage:
      'Ten link do czatu nie jest już aktywny. Skontaktuj się z administratorem obszaru roboczego.',
    publicChatLoadOlderMessages: 'Załaduj starsze wiadomości',
    publicChatSendMessageLabel: 'Wyślij wiadomość',
    publicChatContactHumanLabel: 'Porozmawiaj z człowiekiem',
    publicChatContactHumanMessage: 'Chcę porozmawiać z człowiekiem.',
    publicChatNewChatLabel: 'Wyczyść czat',
    publicChatCollapseLabel: 'Zwiń czat',
    publicChatOpenFullScreenLabel: 'Otwórz na pełnym ekranie',
    publicChatOpenNewTabLabel: 'Otwórz w nowej karcie',
    publicChatDisclaimerTemplate: '{name} korzysta z AI i może popełniać błędy.',
    publicChatRateLimitRetryTemplate: 'Spróbuj ponownie za {seconds}s.',
    publicChatMessageFailedMessage: 'Przepraszamy, coś poszło nie tak. Spróbuj ponownie.',
    skillReceiptSubmittedLabel: 'Wysłano',
    skillReceiptFailedLabel: 'Nie udało się wysłać',
  },
  zh: {
    launcherDefaultLabel: '与我们聊天',
    embeddedChatTitle: 'Radioso 嵌入式聊天',
    proactiveGreetingTeaser: '你好！我能帮你什么？',
    embeddedChatUnavailableTitle: '聊天不可用',
    embeddedChatUnavailableMessage: '无法从该网站启动此聊天。',
    embeddedChatLauncherRequiredMessage: '必须通过按钮脚本打开此聊天。',
    embeddedChatStartingMessage: '正在召唤 {name}...',
    publicChatEmptyTitle: '开始对话',
    publicChatEmptyMessage: '告诉我可以为您做些什么。',
    startPrompt: '提出问题...',
    publicChatUnavailableTitle: '聊天不可用',
    publicChatUnavailableMessage: '此聊天链接已失效。请联系工作区管理员获取访问权限。',
    publicChatLoadOlderMessages: '加载更早的消息',
    publicChatSendMessageLabel: '发送消息',
    publicChatContactHumanLabel: '联系人工客服',
    publicChatContactHumanMessage: '我想联系人工客服。',
    publicChatNewChatLabel: '清除聊天',
    publicChatCollapseLabel: '收起聊天',
    publicChatOpenFullScreenLabel: '全屏打开',
    publicChatOpenNewTabLabel: '在新标签页中打开',
    publicChatDisclaimerTemplate: '{name} 使用 AI，可能会出错。',
    publicChatRateLimitRetryTemplate: '请在 {seconds} 秒后重试。',
    publicChatMessageFailedMessage: '抱歉，出了点问题。请重试。',
    skillReceiptSubmittedLabel: '已提交',
    skillReceiptFailedLabel: '无法提交',
  },
  ja: {
    launcherDefaultLabel: 'チャットでお問い合わせ',
    embeddedChatTitle: 'Radioso 埋め込みチャット',
    proactiveGreetingTeaser: 'こんにちは!どのようにお手伝いできますか?',
    embeddedChatUnavailableTitle: 'チャットを利用できません',
    embeddedChatUnavailableMessage: 'このサイトからチャットを開始できませんでした。',
    embeddedChatLauncherRequiredMessage: 'このチャットはボタンのスクリプトから開く必要があります。',
    embeddedChatStartingMessage: '{name} に接続中...',
    publicChatEmptyTitle: '会話を始める',
    publicChatEmptyMessage: 'ご用件をお聞かせください。',
    startPrompt: '質問を入力...',
    publicChatUnavailableTitle: 'チャットを利用できません',
    publicChatUnavailableMessage:
      'このチャットリンクは無効です。ワークスペース管理者にお問い合わせください。',
    publicChatLoadOlderMessages: '以前のメッセージを読み込む',
    publicChatSendMessageLabel: 'メッセージを送信',
    publicChatContactHumanLabel: '担当者に相談する',
    publicChatContactHumanMessage: '担当者に相談したいです。',
    publicChatNewChatLabel: 'チャットをクリア',
    publicChatCollapseLabel: 'チャットを閉じる',
    publicChatOpenFullScreenLabel: '全画面で開く',
    publicChatOpenNewTabLabel: '新しいタブで開く',
    publicChatDisclaimerTemplate: '{name} は AI を使用しており、間違える可能性があります。',
    publicChatRateLimitRetryTemplate: '{seconds} 秒後に再試行してください。',
    publicChatMessageFailedMessage: '申し訳ありません。問題が発生しました。もう一度お試しください。',
    skillReceiptSubmittedLabel: '送信しました',
    skillReceiptFailedLabel: '送信できませんでした',
  },
  ru: {
    launcherDefaultLabel: 'Напишите нам',
    embeddedChatTitle: 'Встроенный чат Radioso',
    proactiveGreetingTeaser: 'Привет! Чем могу помочь?',
    embeddedChatUnavailableTitle: 'Чат недоступен',
    embeddedChatUnavailableMessage: 'Не удалось запустить этот чат с этого сайта.',
    embeddedChatLauncherRequiredMessage: 'Этот чат должен открываться скриптом кнопки.',
    embeddedChatStartingMessage: 'Подключение к {name}...',
    publicChatEmptyTitle: 'Начать разговор',
    publicChatEmptyMessage: 'Расскажите, чем я могу помочь.',
    startPrompt: 'Задайте вопрос...',
    publicChatUnavailableTitle: 'Чат недоступен',
    publicChatUnavailableMessage:
      'Эта ссылка на чат больше не активна. Свяжитесь с администратором рабочей области для доступа.',
    publicChatLoadOlderMessages: 'Загрузить старые сообщения',
    publicChatSendMessageLabel: 'Отправить сообщение',
    publicChatContactHumanLabel: 'Поговорить с человеком',
    publicChatContactHumanMessage: 'Я хочу поговорить с человеком.',
    publicChatNewChatLabel: 'Очистить чат',
    publicChatCollapseLabel: 'Свернуть чат',
    publicChatOpenFullScreenLabel: 'Открыть во весь экран',
    publicChatOpenNewTabLabel: 'Открыть в новой вкладке',
    publicChatDisclaimerTemplate: '{name} использует ИИ и может ошибаться.',
    publicChatRateLimitRetryTemplate: 'Повторите через {seconds} с.',
    publicChatMessageFailedMessage: 'Извините, что-то пошло не так. Попробуйте ещё раз.',
    skillReceiptSubmittedLabel: 'Отправлено',
    skillReceiptFailedLabel: 'Не удалось отправить',
  },
}

const normalizeLocale = (value: string | null | undefined) =>
  typeof value === 'string' ? value.trim().toLowerCase().replace('_', '-') : ''

// Resolve the best built-in locale key for an ordered list of visitor language
// candidates (most-preferred first), matching the launcher's exact-then-base
// fallback (e.g. `fr-CA` -> `fr`). English is the untranslated baseline: once a
// visitor's English preference outranks every pack we stop and return null so we
// never localize an English-preferring visitor into a lower-priority language
// they merely tolerate. Returns null when English is preferred or nothing matches.
export const pickBuiltInEmbedLocale = (candidates: readonly (string | null | undefined)[]): string | null => {
  for (const candidate of candidates) {
    const normalized = normalizeLocale(candidate)
    if (!normalized) {
      continue
    }
    if (BUILT_IN_EMBED_LOCALE_PACKS[normalized]) {
      return normalized
    }
    const base = normalized.split('-')[0]
    if (base && BUILT_IN_EMBED_LOCALE_PACKS[base]) {
      return base
    }
    if (base === 'en') {
      return null
    }
  }
  return null
}

// Built-in copy overrides for the best-matching visitor locale. Strips the
// launcher-only `proactiveGreetingTeaser` so the result is a pure in-frame copy
// overrides object. Empty when no candidate matches (English baseline applies).
export const resolveBuiltInEmbedCopy = (
  candidates: readonly (string | null | undefined)[],
): WebsiteEmbedCopyOverrides => {
  const locale = pickBuiltInEmbedLocale(candidates)
  if (!locale) {
    return {}
  }
  const copy: EmbedLocalePack = { ...BUILT_IN_EMBED_LOCALE_PACKS[locale] }
  delete copy.proactiveGreetingTeaser
  return copy
}

// Parse an HTTP `Accept-Language` header into an ordered list of language tags,
// most-preferred first. Entries with `q=0` (or a malformed q) mean "not
// acceptable" and are dropped so a rejected language is never selected.
export const parseAcceptLanguageLocales = (header: string | null | undefined): string[] => {
  if (!header) {
    return []
  }
  return header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';')
      const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
      const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0 }
    })
    .filter((entry) => entry.tag && entry.tag !== '*' && entry.q > 0)
    .sort((a, b) => b.q - a.q)
    .map((entry) => entry.tag)
}
