import { ResetPasswordScreen } from "./reset-password-screen.js";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const params = await searchParams;

  return <ResetPasswordScreen token={params.token} />;
}
