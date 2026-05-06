import { VerifyEmailScreen } from "./verify-email-screen.js";

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const params = await searchParams;

  return <VerifyEmailScreen token={params.token} />;
}
