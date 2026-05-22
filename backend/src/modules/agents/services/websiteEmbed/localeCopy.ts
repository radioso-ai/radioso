/**
 * Built-in translations of the visitor-facing copy used by the website embed
 * widget. Previously lived inline in `radioso-embed.js` (~14KB shipped to
 * every visitor of every embed-using site, mostly unused since each visitor
 * only ever needs one locale). Now lives server-side: the embed-config
 * endpoint reads the visitor's Accept-Language header, picks the best match,
 * and serves only that pack to the launcher.
 *
 * Operator-supplied per-locale text packs and expert overrides still win over
 * these defaults — they're merged on top in the launcher script.
 */

export type WebsiteEmbedCopyPack = Record<string, string>;

export const BUILT_IN_LOCALE_COPY: Record<string, WebsiteEmbedCopyPack> = {
  es: {
    launcherDefaultLabel: "Chatea con nosotros",
    embeddedChatTitle: "Chat embebido de Radioso",
    proactiveGreetingTeaser: "¡Hola! ¿En qué puedo ayudarte?",
    embeddedChatUnavailableTitle: "Chat no disponible",
    embeddedChatUnavailableMessage: "No se pudo iniciar este chat desde este sitio web.",
    embeddedChatLauncherRequiredMessage: "Este chat debe abrirse desde el script del botón.",
    embeddedChatStartingMessage: "Invocando a {name}...",
    publicChatEmptyTitle: "Inicia una conversación",
    publicChatEmptyMessage: "Haz una pregunta y obtén una respuesta con IA.",
    startPrompt: "Haz una pregunta...",
    publicChatUnavailableTitle: "Chat no disponible",
    publicChatUnavailableMessage:
      "Este enlace de chat ya no está activo. Contacta al administrador del espacio de trabajo para obtener acceso.",
    publicChatLoadOlderMessages: "Cargar mensajes anteriores",
    publicChatSendMessageLabel: "Enviar mensaje",
    publicChatContactHumanLabel: "Hablar con una persona",
    publicChatContactHumanMessage: "Quiero hablar con una persona.",
    publicChatNewChatLabel: "Borrar chat",
    publicChatCollapseLabel: "Contraer chat",
    publicChatDisclaimerTemplate: "{name} usa IA y puede cometer errores.",
    publicChatRateLimitRetryTemplate: "Inténtalo de nuevo en {seconds}s.",
  },
  fr: {
    launcherDefaultLabel: "Discutez avec nous",
    embeddedChatTitle: "Chat intégré Radioso",
    proactiveGreetingTeaser: "Bonjour ! Comment puis-je vous aider ?",
    embeddedChatUnavailableTitle: "Chat indisponible",
    embeddedChatUnavailableMessage: "Ce chat n'a pas pu être lancé depuis ce site web.",
    embeddedChatLauncherRequiredMessage: "Ce chat doit être ouvert depuis le script du bouton.",
    embeddedChatStartingMessage: "Connexion à {name}...",
    publicChatEmptyTitle: "Commencer une conversation",
    publicChatEmptyMessage: "Posez une question et obtenez une réponse alimentée par l'IA.",
    startPrompt: "Posez une question...",
    publicChatUnavailableTitle: "Chat indisponible",
    publicChatUnavailableMessage:
      "Ce lien de chat n'est plus actif. Veuillez contacter l'administrateur de l'espace de travail.",
    publicChatLoadOlderMessages: "Charger les messages précédents",
    publicChatSendMessageLabel: "Envoyer le message",
    publicChatContactHumanLabel: "Parler à une personne",
    publicChatContactHumanMessage: "Je souhaite parler à une personne.",
    publicChatNewChatLabel: "Effacer le chat",
    publicChatCollapseLabel: "Réduire le chat",
    publicChatDisclaimerTemplate: "{name} utilise l'IA et peut faire des erreurs.",
    publicChatRateLimitRetryTemplate: "Réessayez dans {seconds} s.",
  },
  de: {
    launcherDefaultLabel: "Mit uns chatten",
    embeddedChatTitle: "Eingebetteter Radioso-Chat",
    proactiveGreetingTeaser: "Hallo! Wie kann ich helfen?",
    embeddedChatUnavailableTitle: "Chat nicht verfügbar",
    embeddedChatUnavailableMessage: "Dieser Chat konnte von dieser Website nicht gestartet werden.",
    embeddedChatLauncherRequiredMessage: "Dieser Chat muss über das Schaltflächen-Skript geöffnet werden.",
    embeddedChatStartingMessage: "Verbinde mit {name}...",
    publicChatEmptyTitle: "Gespräch beginnen",
    publicChatEmptyMessage: "Stellen Sie eine Frage und erhalten Sie eine KI-Antwort.",
    startPrompt: "Frage stellen...",
    publicChatUnavailableTitle: "Chat nicht verfügbar",
    publicChatUnavailableMessage:
      "Dieser Chat-Link ist nicht mehr aktiv. Bitte wenden Sie sich an den Arbeitsbereichsadministrator.",
    publicChatLoadOlderMessages: "Ältere Nachrichten laden",
    publicChatSendMessageLabel: "Nachricht senden",
    publicChatContactHumanLabel: "Mit einem Menschen sprechen",
    publicChatContactHumanMessage: "Ich möchte mit einem Menschen sprechen.",
    publicChatNewChatLabel: "Chat löschen",
    publicChatCollapseLabel: "Chat einklappen",
    publicChatDisclaimerTemplate: "{name} verwendet KI und kann Fehler machen.",
    publicChatRateLimitRetryTemplate: "Erneut versuchen in {seconds} s.",
  },
  it: {
    launcherDefaultLabel: "Chatta con noi",
    embeddedChatTitle: "Chat integrata Radioso",
    proactiveGreetingTeaser: "Ciao! Come posso aiutarti?",
    embeddedChatUnavailableTitle: "Chat non disponibile",
    embeddedChatUnavailableMessage: "Impossibile avviare questa chat da questo sito web.",
    embeddedChatLauncherRequiredMessage: "Questa chat deve essere aperta dallo script del pulsante.",
    embeddedChatStartingMessage: "Connessione a {name}...",
    publicChatEmptyTitle: "Inizia una conversazione",
    publicChatEmptyMessage: "Fai una domanda e ottieni una risposta basata sull'IA.",
    startPrompt: "Fai una domanda...",
    publicChatUnavailableTitle: "Chat non disponibile",
    publicChatUnavailableMessage:
      "Questo link non è più attivo. Contatta l'amministratore dello spazio di lavoro per accedere.",
    publicChatLoadOlderMessages: "Carica messaggi precedenti",
    publicChatSendMessageLabel: "Invia messaggio",
    publicChatContactHumanLabel: "Parlare con una persona",
    publicChatContactHumanMessage: "Vorrei parlare con una persona.",
    publicChatNewChatLabel: "Cancella chat",
    publicChatCollapseLabel: "Riduci chat",
    publicChatDisclaimerTemplate: "{name} utilizza l'IA e può commettere errori.",
    publicChatRateLimitRetryTemplate: "Riprova tra {seconds} s.",
  },
  pt: {
    launcherDefaultLabel: "Fale conosco",
    embeddedChatTitle: "Chat incorporado Radioso",
    proactiveGreetingTeaser: "Olá! Como posso ajudar?",
    embeddedChatUnavailableTitle: "Chat indisponível",
    embeddedChatUnavailableMessage: "Não foi possível iniciar este chat a partir deste site.",
    embeddedChatLauncherRequiredMessage: "Este chat deve ser aberto pelo script do botão.",
    embeddedChatStartingMessage: "Conectando a {name}...",
    publicChatEmptyTitle: "Iniciar uma conversa",
    publicChatEmptyMessage: "Faça uma pergunta e receba uma resposta com IA.",
    startPrompt: "Faça uma pergunta...",
    publicChatUnavailableTitle: "Chat indisponível",
    publicChatUnavailableMessage:
      "Este link de chat não está mais ativo. Entre em contato com o administrador do espaço de trabalho.",
    publicChatLoadOlderMessages: "Carregar mensagens anteriores",
    publicChatSendMessageLabel: "Enviar mensagem",
    publicChatContactHumanLabel: "Falar com uma pessoa",
    publicChatContactHumanMessage: "Quero falar com uma pessoa.",
    publicChatNewChatLabel: "Limpar chat",
    publicChatCollapseLabel: "Recolher chat",
    publicChatDisclaimerTemplate: "{name} usa IA e pode cometer erros.",
    publicChatRateLimitRetryTemplate: "Tente novamente em {seconds}s.",
  },
  nl: {
    launcherDefaultLabel: "Chat met ons",
    embeddedChatTitle: "Radioso ingesloten chat",
    proactiveGreetingTeaser: "Hallo! Hoe kan ik helpen?",
    embeddedChatUnavailableTitle: "Chat niet beschikbaar",
    embeddedChatUnavailableMessage: "Deze chat kon niet worden gestart vanaf deze website.",
    embeddedChatLauncherRequiredMessage: "Deze chat moet worden geopend via het knopscript.",
    embeddedChatStartingMessage: "Verbinding maken met {name}...",
    publicChatEmptyTitle: "Een gesprek starten",
    publicChatEmptyMessage: "Stel een vraag en krijg een AI-antwoord.",
    startPrompt: "Stel een vraag...",
    publicChatUnavailableTitle: "Chat niet beschikbaar",
    publicChatUnavailableMessage:
      "Deze chatlink is niet meer actief. Neem contact op met de werkruimtebeheerder voor toegang.",
    publicChatLoadOlderMessages: "Oudere berichten laden",
    publicChatSendMessageLabel: "Bericht verzenden",
    publicChatContactHumanLabel: "Met een medewerker praten",
    publicChatContactHumanMessage: "Ik wil met een medewerker praten.",
    publicChatNewChatLabel: "Chat wissen",
    publicChatCollapseLabel: "Chat inklappen",
    publicChatDisclaimerTemplate: "{name} gebruikt AI en kan fouten maken.",
    publicChatRateLimitRetryTemplate: "Probeer het opnieuw over {seconds}s.",
  },
  pl: {
    launcherDefaultLabel: "Porozmawiaj z nami",
    embeddedChatTitle: "Osadzony czat Radioso",
    proactiveGreetingTeaser: "Cześć! Jak mogę pomóc?",
    embeddedChatUnavailableTitle: "Czat niedostępny",
    embeddedChatUnavailableMessage: "Nie można uruchomić tego czatu z tej witryny.",
    embeddedChatLauncherRequiredMessage: "Ten czat musi zostać otwarty ze skryptu przycisku.",
    embeddedChatStartingMessage: "Łączenie z {name}...",
    publicChatEmptyTitle: "Rozpocznij rozmowę",
    publicChatEmptyMessage: "Zadaj pytanie i uzyskaj odpowiedź z AI.",
    startPrompt: "Zadaj pytanie...",
    publicChatUnavailableTitle: "Czat niedostępny",
    publicChatUnavailableMessage:
      "Ten link do czatu nie jest już aktywny. Skontaktuj się z administratorem obszaru roboczego.",
    publicChatLoadOlderMessages: "Załaduj starsze wiadomości",
    publicChatSendMessageLabel: "Wyślij wiadomość",
    publicChatContactHumanLabel: "Porozmawiaj z człowiekiem",
    publicChatContactHumanMessage: "Chcę porozmawiać z człowiekiem.",
    publicChatNewChatLabel: "Wyczyść czat",
    publicChatCollapseLabel: "Zwiń czat",
    publicChatDisclaimerTemplate: "{name} korzysta z AI i może popełniać błędy.",
    publicChatRateLimitRetryTemplate: "Spróbuj ponownie za {seconds}s.",
  },
  zh: {
    launcherDefaultLabel: "与我们聊天",
    embeddedChatTitle: "Radioso 嵌入式聊天",
    proactiveGreetingTeaser: "你好！我能帮你什么？",
    embeddedChatUnavailableTitle: "聊天不可用",
    embeddedChatUnavailableMessage: "无法从该网站启动此聊天。",
    embeddedChatLauncherRequiredMessage: "必须通过按钮脚本打开此聊天。",
    embeddedChatStartingMessage: "正在召唤 {name}...",
    publicChatEmptyTitle: "开始对话",
    publicChatEmptyMessage: "提出问题，获取 AI 答案。",
    startPrompt: "提出问题...",
    publicChatUnavailableTitle: "聊天不可用",
    publicChatUnavailableMessage: "此聊天链接已失效。请联系工作区管理员获取访问权限。",
    publicChatLoadOlderMessages: "加载更早的消息",
    publicChatSendMessageLabel: "发送消息",
    publicChatContactHumanLabel: "联系人工客服",
    publicChatContactHumanMessage: "我想联系人工客服。",
    publicChatNewChatLabel: "清除聊天",
    publicChatCollapseLabel: "收起聊天",
    publicChatDisclaimerTemplate: "{name} 使用 AI，可能会出错。",
    publicChatRateLimitRetryTemplate: "请在 {seconds} 秒后重试。",
  },
  ja: {
    launcherDefaultLabel: "チャットでお問い合わせ",
    embeddedChatTitle: "Radioso 埋め込みチャット",
    proactiveGreetingTeaser: "こんにちは!どのようにお手伝いできますか?",
    embeddedChatUnavailableTitle: "チャットを利用できません",
    embeddedChatUnavailableMessage: "このサイトからチャットを開始できませんでした。",
    embeddedChatLauncherRequiredMessage: "このチャットはボタンのスクリプトから開く必要があります。",
    embeddedChatStartingMessage: "{name} に接続中...",
    publicChatEmptyTitle: "会話を始める",
    publicChatEmptyMessage: "質問してAIの回答を受け取りましょう。",
    startPrompt: "質問を入力...",
    publicChatUnavailableTitle: "チャットを利用できません",
    publicChatUnavailableMessage:
      "このチャットリンクは無効です。ワークスペース管理者にお問い合わせください。",
    publicChatLoadOlderMessages: "以前のメッセージを読み込む",
    publicChatSendMessageLabel: "メッセージを送信",
    publicChatContactHumanLabel: "担当者に相談する",
    publicChatContactHumanMessage: "担当者に相談したいです。",
    publicChatNewChatLabel: "チャットをクリア",
    publicChatCollapseLabel: "チャットを閉じる",
    publicChatDisclaimerTemplate: "{name} は AI を使用しており、間違える可能性があります。",
    publicChatRateLimitRetryTemplate: "{seconds} 秒後に再試行してください。",
  },
  ru: {
    launcherDefaultLabel: "Напишите нам",
    embeddedChatTitle: "Встроенный чат Radioso",
    proactiveGreetingTeaser: "Привет! Чем могу помочь?",
    embeddedChatUnavailableTitle: "Чат недоступен",
    embeddedChatUnavailableMessage: "Не удалось запустить этот чат с этого сайта.",
    embeddedChatLauncherRequiredMessage: "Этот чат должен открываться скриптом кнопки.",
    embeddedChatStartingMessage: "Подключение к {name}...",
    publicChatEmptyTitle: "Начать разговор",
    publicChatEmptyMessage: "Задайте вопрос и получите ответ ИИ.",
    startPrompt: "Задайте вопрос...",
    publicChatUnavailableTitle: "Чат недоступен",
    publicChatUnavailableMessage:
      "Эта ссылка на чат больше не активна. Свяжитесь с администратором рабочей области для доступа.",
    publicChatLoadOlderMessages: "Загрузить старые сообщения",
    publicChatSendMessageLabel: "Отправить сообщение",
    publicChatContactHumanLabel: "Поговорить с человеком",
    publicChatContactHumanMessage: "Я хочу поговорить с человеком.",
    publicChatNewChatLabel: "Очистить чат",
    publicChatCollapseLabel: "Свернуть чат",
    publicChatDisclaimerTemplate: "{name} использует ИИ и может ошибаться.",
    publicChatRateLimitRetryTemplate: "Повторите через {seconds} с.",
  },
};

const ACCEPT_LANGUAGE_ENTRY = /^([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)(?:;q=([0-9.]+))?$/;

const parseAcceptLanguage = (header: string): string[] => {
  return header
    .split(",")
    .map((part) => part.trim())
    .map((part) => {
      const match = ACCEPT_LANGUAGE_ENTRY.exec(part);
      if (!match) return null;
      const tag = match[1];
      const quality = match[2] ? Number.parseFloat(match[2]) : 1;
      return Number.isFinite(quality) ? { tag, quality } : null;
    })
    .filter((entry): entry is { tag: string; quality: number } => entry !== null && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality)
    .map((entry) => entry.tag.toLowerCase().replace("_", "-"));
};

/**
 * Pick the best built-in locale pack for the visitor's Accept-Language header.
 * Returns `null` when no header is provided or no pack matches — the launcher
 * falls back to its English baseline in that case.
 */
export const resolveCopyForAcceptLanguage = (
  acceptLanguage: string | undefined | null,
): { locale: string; pack: WebsiteEmbedCopyPack } | null => {
  if (!acceptLanguage) return null;
  for (const tag of parseAcceptLanguage(acceptLanguage)) {
    const exact = BUILT_IN_LOCALE_COPY[tag];
    if (exact) return { locale: tag, pack: exact };
    const base = tag.split("-")[0];
    if (base) {
      const baseMatch = BUILT_IN_LOCALE_COPY[base];
      if (baseMatch) return { locale: base, pack: baseMatch };
    }
  }
  return null;
};
