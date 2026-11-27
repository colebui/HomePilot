import { NextResponse, type NextRequest } from "next/server";
import { parseEnv } from "@/lib/server/env";
import { SESSION_COOKIE, sessionSecret, verifySession } from "@/lib/server/session";

/**
 * Early redirect to /login for the live dashboard. This is an optimistic check only: the data
 * layer (lib/server/homepilot.ts) verifies the session again before any data is read.
 */
export async function proxy(request: NextRequest) {
  const e = parseEnv(process.env);
  if (e.HOMEPILOT_MODE === "demo") return NextResponse.next();
  const secret = await sessionSecret({ explicit: e.DASHBOARD_SESSION_SECRET, apiToken: e.HOMEPILOT_API_TOKEN });
  if (await verifySession(secret, request.cookies.get(SESSION_COOKIE)?.value, Date.now())) return NextResponse.next();
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!login|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
