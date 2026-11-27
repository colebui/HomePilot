import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { App } from '../app.js';
import { exportLlmCalls } from '../telemetry/report.js';
import { DASHBOARD_HTML } from './dashboard.js';
import { buildActivity, buildInsights, upcomingReminders } from './insights.js';

const COOKIE = 'homepilot_session';
const MAX_BODY = 16 * 1024;

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function send(res: ServerResponse, status: number, body: string, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    ...extra,
  });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown): void => send(res, status, JSON.stringify(data));

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Local-only dashboard and API.
 * - Binds to 127.0.0.1 (see listen()); never exposed to the network.
 * - Every route except /healthz needs the token (Bearer header, or a session cookie set by
 *   visiting /?token=...). There are no unauthenticated admin endpoints.
 * - Host and Origin are checked to block DNS-rebinding and cross-site requests.
 * - Responses never include secrets, prompt text or message bodies from third parties.
 */
export function createApiServer(app: App, opts: { token: string; port: number }): Server {
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);

  const authed = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ') && safeEqual(header.slice(7), opts.token)) return true;
    const cookie = (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${COOKIE}=`));
    return cookie ? safeEqual(decodeURIComponent(cookie.slice(COOKIE.length + 1)), opts.token) : false;
  };

  return createServer((req, res) => {
    void (async () => {
      try {
        if (!req.headers.host || !allowedHosts.has(req.headers.host)) return json(res, 403, { error: 'forbidden host' });
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        const method = req.method ?? 'GET';

        if (url.pathname === '/healthz') return json(res, 200, { ok: true });

        // First visit: /?token=... sets an HttpOnly cookie, then redirects to drop the token from the URL.
        const qToken = url.searchParams.get('token');
        if (method === 'GET' && url.pathname === '/' && qToken) {
          if (!safeEqual(qToken, opts.token)) return json(res, 401, { error: 'unauthorized' });
          return send(res, 302, '', 'text/plain', {
            Location: '/',
            'Set-Cookie': `${COOKIE}=${encodeURIComponent(opts.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
          });
        }

        if (!authed(req)) return json(res, 401, { error: 'unauthorized' });

        if (method === 'POST') {
          const origin = req.headers.origin;
          if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return json(res, 403, { error: 'forbidden origin' });
          if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'expected application/json' });
          const raw = await readBody(req);
          const body = (raw ? JSON.parse(raw) : {}) as { text?: unknown; id?: unknown };

          if (url.pathname === '/api/say') {
            if (typeof body.text !== 'string' || !body.text.trim()) return json(res, 400, { error: 'text is required' });
            const out = await app.handleMessage({ sender: 'local-cli', channel: 'dashboard', text: body.text });
            return json(res, 200, out);
          }
          if (url.pathname === '/api/pause' || url.pathname === '/api/resume') {
            const out = await app.handleMessage({ sender: 'local-cli', channel: 'dashboard', text: url.pathname.endsWith('pause') ? 'pause' : 'resume' });
            return json(res, 200, out);
          }
          if (url.pathname === '/api/tasks/complete') {
            if (typeof body.id !== 'string' || !app.tasks.get(body.id)) return json(res, 404, { error: 'task not found' });
            const task = app.completeTask(body.id, 'dashboard');
            return json(res, 200, { id: task.id, state: task.state });
          }
          if (url.pathname === '/api/expenses/delete') {
            const gone = typeof body.id === 'string' ? app.expenses.remove(body.id) : undefined;
            if (!gone) return json(res, 404, { error: 'expense not found' });
            app.events.record({ kind: 'expense.removed', actor: 'dashboard', subjectType: 'expense', subjectId: gone.id, data: { amountUsd: gone.amountUsd } });
            return json(res, 200, { id: gone.id, deleted: true });
          }
          if (url.pathname === '/api/tick') return json(res, 200, await app.tick());
          return json(res, 404, { error: 'not found' });
        }

        if (method !== 'GET') return json(res, 405, { error: 'method not allowed' });

        switch (url.pathname) {
          case '/':
            return send(res, 200, DASHBOARD_HTML, 'text/html; charset=utf-8');
          case '/api/health':
            return json(res, 200, app.health());
          case '/api/usage':
            return json(res, 200, app.usageReport());
          case '/api/agenda':
            return json(res, 200, app.agenda());
          case '/api/tasks':
            return json(res, 200, app.tasks.list({ states: ['open', 'snoozed'] }));
          case '/api/outbox':
            return json(res, 200, app.notifier.list({ limit: 30 }));
          case '/api/jobs':
            return json(res, 200, { stats: app.scheduler.stats(), pending: app.scheduler.list({ states: ['pending', 'running', 'dead'], limit: 50 }) });
          case '/api/approvals':
            return json(res, 200, app.approvals.list(30).map(({ args: _args, ...rest }) => rest));
          case '/api/insights':
            return json(res, 200, buildInsights(app.db, app.clock.now(), app.config.timezone, { days: Number(url.searchParams.get('days') ?? 30) || 30 }));
          case '/api/activity':
            return json(res, 200, buildActivity(app.db, { limit: Number(url.searchParams.get('limit') ?? 50) || 50 }));
          case '/api/reminders':
            return json(res, 200, upcomingReminders(app.db, { limit: Number(url.searchParams.get('limit') ?? 20) || 20 }));
          case '/api/spending':
            return json(res, 200, {
              budgetUsd: app.config.spending.monthlyBudgetUsd,
              summary: app.expenses.summary(app.config.timezone),
              recent: app.expenses.list({ limit: Number(url.searchParams.get('limit') ?? 25) || 25 }),
            });
          case '/api/events':
            return json(res, 200, app.events.list({ limit: 100 }));
          case '/api/workflow': {
            // Drill-down: counts, models, costs and outcomes for one workflow. No content.
            const id = url.searchParams.get('id') ?? '';
            return json(res, 200, {
              workflow: app.db.get('SELECT * FROM workflow_runs WHERE correlation_id = ?', id) ?? null,
              calls: app.db.all(
                `SELECT ts, model, via, task_class, input_tokens, output_tokens, cached_tokens, cost_usd, cost_kind,
                        latency_ms, attempt, is_fallback, outcome, error_category, baseline_cost_usd
                 FROM llm_calls WHERE correlation_id = ? ORDER BY ts`,
                id,
              ),
              events: app.events.list({ correlationId: id, limit: 50 }),
            });
          }
          case '/api/export': {
            const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';
            return send(res, 200, exportLlmCalls(app.db, format), format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8', {
              'Content-Disposition': `attachment; filename="homepilot-llm-calls.${format}"`,
            });
          }
          default:
            return json(res, 404, { error: 'not found' });
        }
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : 'bad request' });
      }
    })();
  });
}

export function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback only. Do not change this to 0.0.0.0.
    server.listen(port, '127.0.0.1', () => resolve());
  });
}
