import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPathCandidates = () => {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));

  return [
    join(currentDirectory, "../../../public/radioso-embed.js"),
    join(
      process.cwd(),
      "node_modules/@radioso/enterprise-embed-widget/public/radioso-embed.js",
    ),
  ];
};

const readScript = async () => {
  const errors: unknown[] = [];

  for (const scriptPath of scriptPathCandidates()) {
    try {
      return await readFile(scriptPath, "utf8");
    } catch (error) {
      errors.push(error);
    }
  }

  throw errors.at(-1) ?? new Error("Unable to read enterprise embed script");
};

export const dynamic = "force-static";
export const runtime = "nodejs";

export async function GET() {
  const script = await readScript();
  return new Response(script, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
