const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?$/;

export const isValidLocaleHint = (value: string | null | undefined): value is string => {
  if (!value) {
    return false;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 35 && LOCALE_PATTERN.test(trimmed);
};

export const resolveChatLocale = (input: {
  userExpectedLocale?: string | null;
  assistantDefaultLocale?: string | null;
}): string | null => {
  if (isValidLocaleHint(input.userExpectedLocale)) {
    return input.userExpectedLocale.trim();
  }
  if (isValidLocaleHint(input.assistantDefaultLocale)) {
    return input.assistantDefaultLocale.trim();
  }

  return null;
};
