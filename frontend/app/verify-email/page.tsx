import { VerifyEmailScreen } from '@/components/auth/verify-email-screen'

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const params = await searchParams

  return <VerifyEmailScreen token={params.token} />
}
