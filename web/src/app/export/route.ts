import { connection } from "next/server";
import { env } from "@/lib/server/env";
import { isSignedIn } from "@/lib/server/homepilot";

/** Streams the service's raw model-call export (CSV) through the dashboard, so the token stays server-side. */
export async function GET() {
  await connection();
  const e = env();
  if (e.HOMEPILOT_MODE !== "live") return new Response("Export is only available on the live dashboard.", { status: 404 });
  if (!(await isSignedIn())) return new Response("Sign in first.", { status: 401 });
  const res = await fetch(`${e.HOMEPILOT_API_URL.replace(/\/+$/, "")}/api/export?format=csv`, {
    headers: { Authorization: `Bearer ${e.HOMEPILOT_API_TOKEN}` },
    cache: "no-store",
  });
  if (!res.ok || !res.body) return new Response("HomePilot did not return the export.", { status: 502 });
  return new Response(res.body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="homepilot-llm-calls.csv"',
      "Cache-Control": "no-store",
    },
  });
}
