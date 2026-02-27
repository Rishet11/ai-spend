#!/usr/bin/env node

const { execSync, spawnSync } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");

const PORT = (() => {
  const i = process.argv.indexOf("--port");
  return i !== -1 ? parseInt(process.argv[i + 1]) : 4321;
})();

const DB_PATH = path.join(os.homedir(), ".codex", "state_5.sqlite");

function q(sql) {
  try {
    const r = spawnSync("sqlite3", ["-json", DB_PATH, sql], { encoding: "utf8" });
    if (r.error) throw r.error;
    const out = r.stdout.trim();
    return out ? JSON.parse(out) : [];
  } catch (e) {
    return [];
  }
}

function getData() {
  const threads = q(`
    SELECT id, title, first_user_message, tokens_used, created_at, model_provider
    FROM threads
    ORDER BY tokens_used DESC
  `);

  const total = threads.reduce((s, t) => s + (t.tokens_used || 0), 0);

  const dayMap = {};
  threads.forEach((t) => {
    const d = new Date(t.created_at * 1000).toISOString().split("T")[0];
    dayMap[d] = (dayMap[d] || 0) + (t.tokens_used || 0);
  });
  const days = Object.entries(dayMap)
    .map(([date, tokens]) => ({ date, tokens }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const modelMap = {};
  threads.forEach((t) => {
    const m = t.model_provider || "unknown";
    modelMap[m] = (modelMap[m] || 0) + (t.tokens_used || 0);
  });

  return { threads, total, days, models: modelMap };
}

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function cost(tokens) {
  return ((tokens / 1e6) * 15).toFixed(2);
}

function html(data) {
  const { threads, total, days, models } = data;
  const maxDay = days.length ? Math.max(...days.map((d) => d.tokens)) : 1;
  const avgTokens = threads.length ? Math.round(total / threads.length) : 0;

  const modelList = Object.entries(models)
    .sort((a, b) => b[1] - a[1])
    .map(([m, t]) => {
      const pct = ((t / total) * 100).toFixed(1);
      return `<div class="model-row">
        <span class="model-name">${m}</span>
        <div class="model-bar-wrap"><div class="model-bar" style="width:${pct}%"></div></div>
        <span class="model-pct">${pct}%</span>
        <span class="model-tokens">${fmt(t)}</span>
      </div>`;
    }).join("");

  const dayChart = days.slice(-30).map((d) => {
    const h = Math.max(2, Math.round((d.tokens / maxDay) * 100));
    const label = d.date.slice(5);
    return `<div class="bar-col">
      <div class="bar-inner" style="height:${h}%;" title="${d.date}: ${fmt(d.tokens)} tokens"></div>
      <span class="bar-label">${label}</span>
    </div>`;
  }).join("");

  const rows = threads.map((t, i) => {
    const raw = t.title || t.first_user_message || "Untitled";
    const title = raw.length > 70 ? raw.slice(0, 70) + "…" : raw;
    const date = new Date(t.created_at * 1000).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric",
    });
    const pct = total ? ((t.tokens_used / total) * 100).toFixed(1) : 0;
    return `<tr>
      <td class="col-title" title="${raw.replace(/"/g, "&quot;")}">${title}</td>
      <td class="col-date">${date}</td>
      <td class="col-tok">${fmt(t.tokens_used || 0)}</td>
      <td class="col-bar">
        <div class="mini-bar-wrap"><div class="mini-bar" style="width:${pct}%"></div></div>
        <span>${pct}%</span>
      </td>
      <td class="col-cost">$${cost(t.tokens_used || 0)}</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>codex-spend</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #0a0a0a;
  --card: #111;
  --card2: #141414;
  --border: #1f1f1f;
  --border2: #282828;
  --text: #f0f0f0;
  --sub: #777;
  --muted: #444;
  --green: #22c55e;
  --green-glow: rgba(34,197,94,0.15);
  --orange: #f97316;
  --blue: #3b82f6;
  --purple: #a855f7;
  --mono: 'JetBrains Mono', monospace;
  --sans: 'Inter', sans-serif;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.6;
  min-height: 100vh;
}

.page {
  max-width: 1000px;
  margin: 0 auto;
  padding: 48px 28px 100px;
}

/* ── Header ── */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 40px;
}

.logo {
  display: flex;
  align-items: center;
  gap: 12px;
}

.logo-badge {
  width: 36px; height: 36px;
  background: var(--green);
  border-radius: 9px;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px;
  flex-shrink: 0;
  box-shadow: 0 0 20px var(--green-glow);
}

.logo-name {
  font-family: var(--mono);
  font-size: 16px;
  font-weight: 500;
  color: var(--text);
  letter-spacing: -0.02em;
}

.logo-name em {
  color: var(--green);
  font-style: normal;
}

.logo-sub {
  font-size: 11px;
  color: var(--sub);
  margin-top: 1px;
  font-family: var(--mono);
}

.refresh-btn {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 12px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
  text-decoration: none;
}

.refresh-btn:hover { color: var(--text); border-color: var(--border2); }

/* ── Stats row ── */
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 32px;
}

@media (max-width: 680px) { .stats { grid-template-columns: repeat(2, 1fr); } }

.stat {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 22px 18px;
}

.stat-label {
  font-size: 11px;
  color: var(--sub);
  font-family: var(--mono);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 10px;
}

.stat-val {
  font-family: var(--mono);
  font-size: 28px;
  font-weight: 500;
  line-height: 1;
  letter-spacing: -0.02em;
}

.stat-val.c-green  { color: var(--green); }
.stat-val.c-orange { color: var(--orange); }
.stat-val.c-blue   { color: var(--blue); }
.stat-val.c-purple { color: var(--purple); }

.stat-hint {
  margin-top: 6px;
  font-size: 11px;
  color: var(--muted);
  font-family: var(--mono);
}

/* ── Section ── */
.section { margin-bottom: 28px; }

.section-label {
  font-size: 11px;
  font-family: var(--mono);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sub);
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.section-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}

/* ── Chart ── */
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}

.chart-inner {
  padding: 24px 20px 16px;
}

.chart-bars {
  display: flex;
  align-items: flex-end;
  gap: 5px;
  height: 100px;
}

.bar-col {
  flex: 1;
  min-width: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
}

.bar-spacer { flex: 1; display: flex; align-items: flex-end; width: 100%; }

.bar-inner {
  width: 100%;
  background: var(--green);
  opacity: 0.65;
  border-radius: 3px 3px 0 0;
  transition: opacity 0.15s;
  cursor: default;
  min-height: 2px;
}

.bar-inner:hover { opacity: 1; }

.bar-label {
  font-family: var(--mono);
  font-size: 8px;
  color: var(--muted);
  margin-top: 6px;
  white-space: nowrap;
  writing-mode: vertical-rl;
  transform: rotate(180deg);
}

/* ── Models ── */
.model-inner {
  padding: 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.model-row {
  display: grid;
  grid-template-columns: 90px 1fr 46px 60px;
  align-items: center;
  gap: 12px;
}

.model-name {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--sub);
  text-transform: capitalize;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-bar-wrap {
  height: 5px;
  background: var(--border2);
  border-radius: 3px;
  overflow: hidden;
}

.model-bar {
  height: 100%;
  background: var(--green);
  border-radius: 3px;
  opacity: 0.65;
}

.model-pct {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  text-align: right;
}

.model-tokens {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 500;
  color: var(--green);
  text-align: right;
}

/* ── Table ── */
table { width: 100%; border-collapse: collapse; }

thead tr { border-bottom: 1px solid var(--border); }

th {
  padding: 11px 16px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  text-align: left;
  font-weight: 400;
  background: var(--card2);
}

tbody tr {
  border-bottom: 1px solid var(--border);
  transition: background 0.1s;
}

tbody tr:last-child { border-bottom: none; }
tbody tr:hover { background: rgba(255,255,255,0.02); }

td { padding: 12px 16px; vertical-align: middle; }

.col-title {
  font-size: 13px;
  color: var(--text);
  max-width: 300px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 400;
}

.col-date {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--sub);
  white-space: nowrap;
}

.col-tok {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 500;
  color: var(--green);
  white-space: nowrap;
}

.col-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  min-width: 110px;
}

.mini-bar-wrap {
  flex: 1;
  height: 4px;
  background: var(--border2);
  border-radius: 2px;
  overflow: hidden;
}

.mini-bar {
  height: 100%;
  background: var(--green);
  opacity: 0.55;
  border-radius: 2px;
}

.col-cost {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--orange);
  white-space: nowrap;
}

/* ── Footer ── */
.footer {
  margin-top: 48px;
  padding-top: 20px;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}

.footer-badge {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 3px 8px;
  color: var(--green);
}

/* ── Animations ── */
@keyframes up {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: none; }
}

.stat { animation: up 0.3s ease both; }
.stat:nth-child(1){animation-delay:.05s}
.stat:nth-child(2){animation-delay:.09s}
.stat:nth-child(3){animation-delay:.13s}
.stat:nth-child(4){animation-delay:.17s}
.card { animation: up 0.3s 0.2s ease both; opacity: 0; }
.card + .card { animation-delay: 0.25s; }
</style>
</head>
<body>
<div class="page">

  <div class="header">
    <div class="logo">
      <div class="logo-badge">💸</div>
      <div>
        <div class="logo-name">codex<em>-spend</em></div>
        <div class="logo-sub">~/.codex/state_5.sqlite · local only</div>
      </div>
    </div>
    <a class="refresh-btn" href="/">↺ refresh</a>
  </div>

  <div class="stats">
    <div class="stat">
      <div class="stat-label">Total Tokens</div>
      <div class="stat-val c-green">${fmt(total)}</div>
      <div class="stat-hint">${total.toLocaleString()}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Est. API Cost</div>
      <div class="stat-val c-orange">$${cost(total)}</div>
      <div class="stat-hint">blended $15/1M</div>
    </div>
    <div class="stat">
      <div class="stat-label">Conversations</div>
      <div class="stat-val c-blue">${threads.length}</div>
      <div class="stat-hint">total threads</div>
    </div>
    <div class="stat">
      <div class="stat-label">Avg / Chat</div>
      <div class="stat-val c-purple">${fmt(avgTokens)}</div>
      <div class="stat-hint">tokens each</div>
    </div>
  </div>

  ${days.length > 1 ? `
  <div class="section">
    <div class="section-label">Daily Usage</div>
    <div class="card">
      <div class="chart-inner">
        <div class="chart-bars">${dayChart}</div>
      </div>
    </div>
  </div>` : ""}

  ${Object.keys(models).length > 0 ? `
  <div class="section">
    <div class="section-label">By Provider</div>
    <div class="card">
      <div class="model-inner">${modelList}</div>
    </div>
  </div>` : ""}

  <div class="section">
    <div class="section-label">Conversations — ranked by token usage</div>
    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Conversation</th>
            <th>Date</th>
            <th>Tokens</th>
            <th>Share</th>
            <th>~Cost</th>
          </tr>
        </thead>
        <tbody>
          ${rows || `<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--muted);font-family:var(--mono);font-size:12px">No conversations found.</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>

  <div class="footer">
    <span>all data stays local — no network requests</span>
    <span class="footer-badge">v1.0.0</span>
  </div>

</div>
</body>
</html>`;
}

// Checks
const check = spawnSync("sqlite3", ["--version"], { encoding: "utf8" });
if (check.error) {
  console.error("\n  ✗  sqlite3 not found.\n\n     brew install sqlite3\n");
  process.exit(1);
}
if (!fs.existsSync(DB_PATH)) {
  console.error(`\n  ✗  Database not found: ${DB_PATH}\n`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (req.url === "/api") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(getData()));
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html(getData()));
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  💸 codex-spend\n`);
  console.log(`  ➜  Dashboard  ${url}`);
  console.log(`  ➜  Database   ${DB_PATH}\n`);
  console.log(`  Ctrl+C to stop\n`);
  if (!process.argv.includes("--no-open")) {
    try { execSync(`open "${url}"`); } catch {
      try { execSync(`xdg-open "${url}"`); } catch {}
    }
  }
});
