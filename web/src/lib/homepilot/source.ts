import { z } from "zod";
import {
  ActivitySchema,
  AgendaSchema,
  ApprovalsSchema,
  HealthSchema,
  InsightsSchema,
  RemindersSchema,
  SayResultSchema,
  SpendingSchema,
  TasksSchema,
  UsageReportSchema,
  type ActivityItem,
  type Agenda,
  type Approval,
  type Health,
  type Insights,
  type SayResult,
  type Spending,
  type Task,
  type UpcomingReminder,
  type UsageReport,
} from "./schemas";

const AckSchema = z.object({ id: z.string() });

/** Everything the dashboard reads from or asks of HomePilot. Live and demo data both implement it. */
export interface HomePilotSource {
  readonly mode: "live" | "demo";
  health(): Promise<Health>;
  usage(): Promise<UsageReport>;
  agenda(): Promise<Agenda>;
  tasks(): Promise<Task[]>;
  approvals(): Promise<Approval[]>;
  insights(days?: number): Promise<Insights>;
  activity(limit?: number): Promise<ActivityItem[]>;
  reminders(): Promise<UpcomingReminder[]>;
  spending(): Promise<Spending>;
  say(text: string): Promise<SayResult>;
  completeTask(id: string): Promise<void>;
  deleteExpense(id: string): Promise<void>;
}

export type HomePilotErrorKind = "unreachable" | "unauthorized" | "http" | "bad_response";

export class HomePilotError extends Error {
  constructor(
    readonly kind: HomePilotErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "HomePilotError";
  }
}

export interface HttpSourceOptions {
  /** e.g. http://127.0.0.1:8787. The service only answers on loopback. */
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Talks to the running HomePilot service. Server-only: the token is sent as a Bearer header from
 * the Next.js server and never reaches the browser.
 */
export function createHttpSource(opts: HttpSourceOptions): HomePilotSource {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 5000;

  async function request<S extends z.ZodType>(schema: S, path: string, body?: unknown): Promise<z.infer<S>> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${opts.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new HomePilotError("unreachable", `HomePilot is not reachable at ${base} (${err instanceof Error ? err.message : "network error"})`);
    }
    if (res.status === 401) throw new HomePilotError("unauthorized", "HomePilot rejected the API token", 401);
    if (!res.ok) throw new HomePilotError("http", `HomePilot answered ${res.status} for ${path}`, res.status);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new HomePilotError("bad_response", `HomePilot sent a response that is not JSON for ${path}`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new HomePilotError("bad_response", `Unexpected response shape from ${path}: ${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}`.trim());
    }
    return parsed.data;
  }

  return {
    mode: "live",
    health: () => request(HealthSchema, "/api/health"),
    usage: () => request(UsageReportSchema, "/api/usage"),
    agenda: () => request(AgendaSchema, "/api/agenda"),
    tasks: () => request(TasksSchema, "/api/tasks"),
    approvals: () => request(ApprovalsSchema, "/api/approvals"),
    insights: (days = 30) => request(InsightsSchema, `/api/insights?days=${days}`),
    activity: (limit = 50) => request(ActivitySchema, `/api/activity?limit=${limit}`),
    reminders: () => request(RemindersSchema, "/api/reminders"),
    say: (text) => request(SayResultSchema, "/api/say", { text }),
    completeTask: async (id) => {
      await request(AckSchema, "/api/tasks/complete", { id });
    },
    spending: () => request(SpendingSchema, "/api/spending"),
    deleteExpense: async (id) => {
      await request(AckSchema, "/api/expenses/delete", { id });
    },
  };
}

