import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createHttpSource, HomePilotError } from "@/lib/homepilot/source";

const samples = JSON.parse(readFileSync(new URL("./fixtures/api-samples.json", import.meta.url), "utf8")) as Record<string, unknown>;
const TOKEN = "test-token-0123456789abcdef";

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {})) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("HTTP source", () => {
  it("sends the token as a Bearer header and parses responses", async () => {
    const f = fakeFetch((url) => Response.json(samples[new URL(url).pathname]));
    const hp = createHttpSource({ baseUrl: "http://127.0.0.1:8787/", token: TOKEN, fetch: f });
    const health = await hp.health();
    expect(health.timezone).toBe("America/Chicago");
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/api/health");
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init!.cache).toBe("no-store");
  });

  it("posts commands as JSON", async () => {
    const f = fakeFetch(() => Response.json(samples["POST /api/say"]));
    const out = await createHttpSource({ baseUrl: "http://127.0.0.1:8787", token: TOKEN, fetch: f }).say("tasks");
    expect(out.understoodBy).toBe("deterministic");
    const init = f.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ text: "tasks" });
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it.each([
    ["unreachable", () => Promise.reject(new TypeError("fetch failed"))],
    ["unauthorized", () => new Response("{}", { status: 401 })],
    ["http", () => new Response("{}", { status: 500 })],
    ["bad_response", () => new Response("<html>", { status: 200 })],
    ["bad_response", () => Response.json({ ok: "yes" })],
  ] as const)("reports %s failures with a typed error", async (kind, respond) => {
    const hp = createHttpSource({ baseUrl: "http://127.0.0.1:8787", token: TOKEN, fetch: fakeFetch(respond) });
    const err = await hp.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HomePilotError);
    expect((err as HomePilotError).kind).toBe(kind);
    expect((err as Error).message).not.toContain(TOKEN);
  });
});
