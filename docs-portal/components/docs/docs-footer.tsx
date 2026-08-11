import Image from 'next/image'
import Link from 'next/link'

import { externalLinks } from '@/components/docs/site-links'

type FooterLink = { label: string; href: string; internal?: boolean }

const productLinks: FooterLink[] = [
  { label: 'The platform', href: externalLinks.platform },
  { label: 'Quick start', href: '/quickstarts/run-locally', internal: true },
  { label: 'Radioso for Slack', href: externalLinks.slack },
  { label: 'Licensing', href: externalLinks.licensing },
  { label: 'FAQ', href: externalLinks.faq },
]

const resourceLinks: FooterLink[] = [
  { label: 'Documentation', href: '/', internal: true },
  { label: 'API reference', href: '/api-reference', internal: true },
  { label: 'Blog', href: externalLinks.blog },
  { label: 'GitHub', href: externalLinks.github },
  { label: 'Contact', href: externalLinks.contact },
]

const linkClass =
  'text-sm text-muted-foreground transition-colors hover:text-foreground rounded outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

function FooterColumn({ title, links }: { title: string; links: FooterLink[] }) {
  return (
    <div>
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-foreground/70">
        {title}
      </h2>
      <ul className="space-y-2">
        {links.map((link) => (
          <li key={link.label}>
            {link.internal ? (
              <Link href={link.href} className={linkClass}>
                {link.label}
              </Link>
            ) : (
              <a
                href={link.href}
                className={linkClass}
                {...(link.href.startsWith('http') ? { target: '_blank', rel: 'noreferrer' } : null)}
              >
                {link.label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function DocsFooter() {
  return (
    <footer className="mt-auto border-t border-border/70 bg-card/40">
      {/* Extra bottom padding on narrow screens keeps the legal links clear of
          the fixed chat launcher. */}
      <div className="mx-auto w-full max-w-6xl px-5 pb-24 pt-12 sm:px-8 sm:pb-12">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <a
              href={externalLinks.marketing}
              className="inline-flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-foreground text-background">
                <Image
                  src="/radioso-icon.svg"
                  alt=""
                  width={20}
                  height={20}
                  className="h-5 w-5"
                />
              </span>
              <span className="font-display text-base font-semibold tracking-tight">Radioso</span>
            </a>
            <p className="font-display mt-4 max-w-xs text-lg leading-snug text-muted-foreground">
              Your voice in the conversation.
            </p>
          </div>

          <FooterColumn title="Product" links={productLinks} />
          <FooterColumn title="Resources" links={resourceLinks} />
        </div>

        <div className="mt-10 flex flex-col gap-3 border-t border-border/70 pt-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>&copy; 2026 Radioso</p>
          <nav aria-label="Legal" className="flex items-center gap-5">
            <a href={externalLinks.privacy} className={linkClass} target="_blank" rel="noreferrer">
              Privacy Policy
            </a>
            <a href={externalLinks.terms} className={linkClass} target="_blank" rel="noreferrer">
              Terms of Service
            </a>
          </nav>
        </div>
      </div>
    </footer>
  )
}
