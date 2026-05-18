import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-static";
export const runtime = "nodejs";

export async function GET() {
  const script = await readFile(join(process.cwd(), "lib/radioso-embed-launcher.js"), "utf8");
  return new Response(script, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
