import Link from 'next/link'

import type { UsageLimitNotice as UsageLimitNoticeData } from '@/lib/usage-limit-error'

/**
 * Inline content for a usage-limit dead end: the plan-limit sentence plus a link to the
 * workspace's usage tab. Renders bare content, not a wrapper, so each call site keeps its own
 * alert element and styling and only swaps in richer content where a bare message stood before.
 */
export function UsageLimitNotice({ notice, href }: { notice: UsageLimitNoticeData; href: string }) {
  return (
    <>
      {notice.message} <Link href={href} className="underline">Review plan and usage</Link>
    </>
  )
}
