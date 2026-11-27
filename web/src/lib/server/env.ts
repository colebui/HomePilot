import { z } from "zod";

const EnvSchema = z
  .object({
    /** "live" reads the HomePilot service; "demo" serves made-up data and needs no service. */
    HOMEPILOT_MODE: z.enum(["live", "demo"]).optional(),
    HOMEPILOT_API_URL: z.url().default("http://127.0.0.1:8787"),
    /** The service's dashboard token (HOMEPILOT_API_TOKEN in the service's .env). */
    HOMEPILOT_API_TOKEN: z.string().min(16).optional(),
    /** Signs dashboard sessions. Defaults to a key derived from the API token. */
    DASHBOARD_SESSION_SECRET: z.string().min(32).optional(),
  })
  .transform((e) => ({ ...e, HOMEPILOT_MODE: e.HOMEPILOT_MODE ?? (e.HOMEPILOT_API_TOKEN ? "live" : "demo") }))
  .refine((e) => e.HOMEPILOT_MODE === "demo" || e.HOMEPILOT_API_TOKEN, {
    message: "HOMEPILOT_API_TOKEN is required when HOMEPILOT_MODE=live",
  });

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function env(): Env {
  cached ??= EnvSchema.parse(process.env);
  return cached;
}

/** For tests. */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  return EnvSchema.parse(raw);
}
