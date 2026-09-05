import type { Metadata } from 'next'

import { InvitationJoinScreen } from '@/components/auth/invitation-join-screen'

export const metadata: Metadata = {
  title: 'Join account',
}

export default async function InvitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ error?: string }>
}) {
  const [{ token }, query] = await Promise.all([params, searchParams])

  return <InvitationJoinScreen token={token} error={query.error} />
}
