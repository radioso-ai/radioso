import type { Metadata } from 'next'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = {
  title: 'Authorize Radioso MCP',
  referrer: 'no-referrer',
}

export default function OperatorMcpConsentLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children
}

