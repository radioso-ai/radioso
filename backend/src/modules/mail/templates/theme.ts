/**
 * The email palette and type stacks, kept apart from the layout so the brand can move without
 * touching markup. Values mirror the product tokens in `frontend/app/globals.css` and
 * `docs-portal/app/globals.css`.
 */

export const emailTheme = {
  color: {
    /** Marketing `--primary`. The app's lighter #5096E7 measures 3.06:1 on white and fails AA. */
    brand: "#2870BD",
    accent: "#FFC720",
    ink: "#142317",
    mutedInk: "#6A706B",
    canvas: "#F9F9F7",
    card: "#FFFFFF",
    border: "#D4D8D4",
    onBrand: "#F9F9F7",
    darkCanvas: "#10151D",
    darkCard: "#181D26",
    darkBorder: "#252A33",
    darkInk: "#F9F9F7",
    darkMutedInk: "#A8A8A8",
  },
  font: {
    /** Fraunces is a webfont and will not load in a mail client; this is its declared fallback. */
    display: "Georgia, 'Times New Roman', Times, serif",
    body: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  },
  /** The docs text column, and a width every mail client renders without horizontal scroll. */
  contentWidthPx: 600,
  logo: {
    /** Served from `frontend/public`, so these resolve against APP_BASE_URL. */
    lightPath: "/radioso-lockup-email.png",
    darkPath: "/radioso-lockup-email-dark.png",
    /** Rendered at 3x (396x101) so the mark stays crisp when a client scales it. */
    widthPx: 132,
    heightPx: 34,
  },
  divider: "#E8EAE8",
} as const;
