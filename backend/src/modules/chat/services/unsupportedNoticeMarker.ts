export const UNSUPPORTED_NOTICE_MARKER = "<<UNSUPPORTED>>";

export const hasUnsupportedNoticeMarker = (value: string | undefined): boolean =>
  (value ?? "").includes(UNSUPPORTED_NOTICE_MARKER);

export const stripUnsupportedNoticeMarker = (value: string): string =>
  value.split(UNSUPPORTED_NOTICE_MARKER).join("");
