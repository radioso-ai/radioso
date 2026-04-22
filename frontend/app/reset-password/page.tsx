import { ResetPasswordScreen } from '@/components/auth/reset-password-screen'

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const params = await searchParams

  return <ResetPasswordScreen token={params.token} />
}
