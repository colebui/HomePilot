/**
 * Minimal local dashboard: one static page that reads the JSON API.
 * Deliberately not React yet: Phase 1 only needs basic usage and health reporting.
 * All dynamic text is inserted with textContent, never innerHTML.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HomePilot</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#16181d; --muted:#5d6470; --line:#e3e6ea; --accent:#2457d6; --warn:#a15c00; --bad:#b3261e; --ok:#1c7c3c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111317; --card:#1a1d23; --text:#e8eaee; --muted:#9aa2ad; --line:#2a2e36; --accent:#8fb0ff; --warn:#f0b35a; --bad:#ff8a80; --ok:#7ad69a; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:1040px; margin:0 auto; padding:20px 16px 48px; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:14px; margin:0 0 10px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  .sub { color:var(--muted); margin:0 0 16px; }
  .grid { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); margin-bottom:12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; overflow-x:auto; }
  .big { font-size:24px; font-weight:650; font-variant-numeric:tabular-nums; }
  .muted { color:var(--muted); font-size:13px; } .warn { color:var(--warn); } .bad { color:var(--bad); } .ok { color:var(--ok); }
  table { width:100%; border-collapse:collapse; font-size:13px; font-variant-numeric:tabular-nums; }
  th,td { text-align:left; padding:5px 8px 5px 0; border-bottom:1px solid var(--line); white-space:nowrap; } th { color:var(--muted); font-weight:600; }
  td.wrap { white-space:normal; }
  .banner { border:1px solid var(--warn); color:var(--warn); border-radius:10px; padding:10px 14px; margin-bottom:12px; display:none; }
  form { display:flex; gap:8px; } input[type=text] { flex:1; padding:9px 10px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--text); font:inherit; }
  button { padding:9px 14px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:#fff; font:inherit; cursor:pointer; }
  button.ghost { background:transparent; color:var(--accent); }
  ul { margin:0; padding-left:18px; } li { margin:3px 0; }
  pre { white-space:pre-wrap; margin:10px 0 0; font:13px/1.4 ui-monospace,Menlo,Consolas,monospace; }
</style>
</head>
<body>
<main>
  <h1>HomePilot</h1>
  <p class="sub" id="sub">Loading…</p>
  <div class="banner" id="sim">This page includes SIMULATED data from the offline mock model. Simulated cost was never billed.</div>

  <div class="grid">
    <div class="card"><h2>Status</h2><div class="big" id="status">…</div><div class="muted" id="statusDetail"></div></div>
    <div class="card"><h2>Spend this month</h2><div class="big" id="spend">…</div><div class="muted" id="spendDetail"></div></div>
    <div class="card"><h2>Budget</h2><div class="big" id="budget">…</div><div class="muted" id="budgetDetail"></div></div>
    <div class="card"><h2>Workflows</h2><div class="big" id="wf">…</div><div class="muted" id="wfDetail"></div></div>
  </div>

  <div class="card" style="margin-bottom:12px">
    <h2>Send a command</h2>
    <form id="say"><input type="text" id="text" placeholder='e.g. remind me to call the dentist tomorrow at 10am' autocomplete="off"><button>Send</button>
      <button type="button" class="ghost" id="pause">Pause</button></form>
    <pre id="reply"></pre>
  </div>

  <div class="card" style="margin-bottom:12px"><h2>Claude-only comparison (hypothetical)</h2>
    <div id="baseline"></div><ul class="muted" id="caveats"></ul></div>

  <div class="grid">
    <div class="card"><h2>By model</h2><table id="byModel"></table></div>
    <div class="card"><h2>By feature</h2><table id="byFeature"></table></div>
  </div>
  <div class="grid">
    <div class="card"><h2>Open tasks</h2><table id="tasks"></table></div>
    <div class="card"><h2>Outbox (latest)</h2><table id="outbox"></table></div>
  </div>
  <div class="card"><h2>Price assumptions (USD per million tokens)</h2><table id="prices"></table>
    <p class="muted">Export raw call data: <a href="/api/export?format=csv">CSV</a> · <a href="/api/export?format=json">JSON</a></p></div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const usd = (n) => (n !== 0 && Math.abs(n) < 0.01 ? '$' + n.toFixed(6) : '$' + n.toFixed(2));
const get = (p) => fetch(p, { credentials: 'same-origin' }).then((r) => { if (!r.ok) throw new Error(p + ' ' + r.status); return r.json(); });
function table(el, head, rows) {
  el.replaceChildren();
  const tr = el.insertRow(); head.forEach((h) => { const th = document.createElement('th'); th.textContent = h; tr.appendChild(th); });
  if (!rows.length) { const r = el.insertRow(); const c = r.insertCell(); c.colSpan = head.length; c.textContent = 'Nothing yet'; c.className = 'muted'; }
  rows.forEach((cells) => { const r = el.insertRow(); cells.forEach((v, i) => { const c = r.insertCell(); c.textContent = String(v); if (i === 0) c.className = 'wrap'; }); });
}
let paused = false;
async function load() {
  try {
    const [h, u, tasks, outbox] = await Promise.all([get('/api/health'), get('/api/usage'), get('/api/tasks'), get('/api/outbox')]);
    paused = h.paused;
    $('sub').textContent = h.timezone + ' · ' + (h.dryRun ? 'dry-run mode' : 'LIVE mode') + ' · model provider: ' + h.modelProvider.name + ' · calendar: ' + (h.calendar.connected ? h.calendar.name : 'not connected');
    $('status').textContent = h.paused ? 'Paused' : h.ok ? 'OK' : 'Degraded';
    $('status').className = 'big ' + (h.paused ? 'warn' : h.ok ? 'ok' : 'bad');
    $('statusDetail').textContent = h.problems.length ? h.problems.join('; ') : h.openTasks + ' open tasks · ' + h.jobs.pending + ' jobs waiting · ' + h.pendingApprovals + ' approvals pending';
    $('pause').textContent = h.paused ? 'Resume' : 'Pause';
    const m = u.spend.thisMonth, real = m.providerReportedUsd + m.estimatedUsd;
    $('spend').textContent = usd(real);
    $('spendDetail').textContent = 'provider-reported ' + usd(m.providerReportedUsd) + ' · estimated ' + usd(m.estimatedUsd) + (m.simulatedUsd ? ' · simulated ' + usd(m.simulatedUsd) : '') + ' · today ' + usd(u.spend.today.providerReportedUsd + u.spend.today.estimatedUsd) + ' · 7 days ' + usd(u.spend.last7Days.providerReportedUsd + u.spend.last7Days.estimatedUsd);
    $('budget').textContent = u.budget.usedFraction === null ? 'no limit' : (u.budget.usedFraction * 100).toFixed(1) + '%';
    $('budgetDetail').textContent = usd(u.budget.usedUsd) + ' of ' + usd(u.budget.monthlyUsd) + ' · alerts at ' + u.budget.thresholds.map((t) => Math.round(t.at * 100) + '%' + (t.crossed ? ' (crossed)' : '')).join(', ');
    $('wf').textContent = u.workflows.succeeded + ' / ' + u.workflows.total;
    $('wfDetail').textContent = 'succeeded / total · ' + u.workflows.deterministic + ' used no model · failure rate ' + (u.workflows.failureRate === null ? 'n/a' : (u.workflows.failureRate * 100).toFixed(1) + '%') + ' · calls ' + u.calls.total + ' (retries ' + u.calls.retries + ', fallbacks ' + u.calls.fallbacks + ', avg ' + (u.calls.avgLatencyMs ?? 'n/a') + ' ms) · cost per success ' + (u.workflows.costPerSuccessfulWorkflowUsd === null ? 'n/a' : usd(u.workflows.costPerSuccessfulWorkflowUsd));
    $('sim').style.display = u.containsSimulatedData ? 'block' : 'none';
    const b = u.baseline;
    $('baseline').textContent = b.basis === 'no calls yet' ? 'No model calls yet.' : 'Baseline ' + b.model + ' (prices as of ' + b.priceDate + ', basis: ' + b.basis + '): hypothetical ' + usd(b.hypotheticalClaudeOnlyUsd) + ' vs actual ' + usd(b.actualUsd) + ' = difference ' + usd(b.differenceUsd) + (b.differencePct === null ? '' : ' (' + b.differencePct.toFixed(1) + '%)');
    $('caveats').replaceChildren(...b.caveats.map((c) => { const li = document.createElement('li'); li.textContent = c; return li; }));
    const g = (r) => [r.key, r.calls, r.inputTokens, r.outputTokens, r.cachedTokens, r.realCostUsd ? usd(r.realCostUsd) : r.simulatedCostUsd ? usd(r.simulatedCostUsd) + ' sim' : '$0.00'];
    table($('byModel'), ['Model', 'Calls', 'In', 'Out', 'Cached', 'Cost'], u.byModel.map(g));
    table($('byFeature'), ['Feature', 'Calls', 'In', 'Out', 'Cached', 'Cost'], u.byFeature.map(g));
    const when = (s) => (s ? new Date(s).toLocaleString() : '');
    table($('tasks'), ['Task', 'State', 'Due'], tasks.map((t) => [t.title, t.state, when(t.dueAt || t.windowEnd)]));
    table($('outbox'), ['Message', 'Kind', 'State'], outbox.slice(0, 8).map((n) => [n.body, n.kind + (n.dryRun ? ' (dry-run)' : ''), n.state]));
    table($('prices'), ['Model', 'In', 'Out', 'Cache read', 'Source', 'As of'], u.priceAssumptions.map((p) => [p.model, p.inputPerMTok, p.outputPerMTok, p.cacheReadPerMTok ?? 'unknown', p.source, p.asOf]));
  } catch (e) { $('sub').textContent = 'Could not load: ' + e.message; }
}
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}
$('say').addEventListener('submit', async (e) => { e.preventDefault(); const text = $('text').value.trim(); if (!text) return; const out = await post('/api/say', { text }); $('reply').textContent = out.reply || out.error || '(no reply)'; $('text').value = ''; load(); });
$('pause').addEventListener('click', async () => { const out = await post(paused ? '/api/resume' : '/api/pause'); $('reply').textContent = out.reply || ''; load(); });
load(); setInterval(load, 15000);
</script>
</body>
</html>`;
