import { readEmbedLauncherScript } from "@/lib/embed-launcher-script";

export const dynamic = "force-static";
export const runtime = "nodejs";

export async function GET() {
  const script = await readEmbedLauncherScript();
  return new Response(script, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
