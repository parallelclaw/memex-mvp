/**
 * Shared HTML templates for the memex web dashboard.
 *
 * Design: tagged template literals with auto-escaping. No template engine,
 * no JSX, no build step. Match the brand of memex.parallelclaw.ai exactly
 * (ParallelClaw mint palette, Inter font, glass cards, mascot SVG).
 *
 * Public API:
 *   • esc(str)          — HTML-escape a string. Use everywhere user data
 *                          is interpolated (chat content, titles, paths).
 *   • html(strings, ...) — tagged template. Auto-escapes any
 *                          ${interpolation} that comes from user input.
 *                          Wrap pre-trusted HTML in `raw()` to bypass.
 *   • raw(s)            — opt-out of escaping (use for icons, server-built
 *                          subtrees, etc).
 *   • renderPage(opts)  — wraps body in <!DOCTYPE html> + head + nav.
 *                          opts: {title, active, body, status}
 */

const HTML_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
}

const RAW = Symbol('raw');
export function raw(s) { return { [RAW]: true, value: String(s ?? '') }; }

export function html(strings, ...values) {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) {
      const v = values[i];
      if (v == null) continue;
      if (Array.isArray(v)) {
        // Arrays of html(...) results — flatten
        for (const item of v) {
          if (item && typeof item === 'object' && item[RAW]) out += item.value;
          else out += esc(item);
        }
      } else if (typeof v === 'object' && v[RAW]) {
        out += v.value;
      } else {
        out += esc(v);
      }
    }
  }
  return raw(out);
}

// ----- Mascot SVG (same as landing nav) -----
const MASCOT_SVG = `
<svg class="brand-svg" viewBox="0 0 180 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="memex-claw-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#6ee7b7"/>
      <stop offset="100%" stop-color="#60a5fa"/>
    </linearGradient>
    <linearGradient id="memex-bolt-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fef08a"/>
      <stop offset="50%" stop-color="#fbbf24"/>
      <stop offset="100%" stop-color="#f59e0b"/>
    </linearGradient>
    <filter id="memex-bolt-glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <g transform="translate(10,5)">
    <path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z" fill="url(#memex-claw-grad)"/>
    <path d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z" fill="url(#memex-claw-grad)"/>
    <path d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z" fill="url(#memex-claw-grad)"/>
    <path d="M45 15 Q35 5 30 8" stroke="url(#memex-claw-grad)" stroke-width="2" stroke-linecap="round" fill="none"/>
    <path d="M75 15 Q85 5 90 8" stroke="url(#memex-claw-grad)" stroke-width="2" stroke-linecap="round" fill="none"/>
    <circle cx="45" cy="35" r="6" fill="#0d1016"/>
    <circle cx="75" cy="35" r="6" fill="#0d1016"/>
    <circle cx="46" cy="34" r="2" fill="#6ee7b7"/>
    <circle cx="76" cy="34" r="2" fill="#6ee7b7"/>
  </g>
  <path d="M130 5 L108 55 L128 55 L100 115 L152 55 L130 55 L158 5 L130 5Z" fill="url(#memex-bolt-grad)" filter="url(#memex-bolt-glow)" transform="rotate(-8 130 60)"/>
</svg>`;

// ----- Top nav with active-page hint -----
function renderNav(active) {
  const items = [
    { id: 'dashboard', label: 'Dashboard', href: '/' },
    { id: 'conversations', label: 'Conversations', href: '/conversations' },
    { id: 'pending', label: 'Pending', href: '/pending' },
    { id: 'settings', label: 'Settings', href: '/settings' },
  ];
  const links = items.map((i) => {
    const cls = active === i.id ? 'nav-link active' : 'nav-link';
    return `<a href="${i.href}" class="${cls}">${esc(i.label)}</a>`;
  }).join('\n');

  return `
<nav class="topbar">
  <div class="topbar-inner">
    <a href="/" class="brand">
      ${MASCOT_SVG}
      <span class="brand-wordmark">me<span class="accent">mex</span></span>
    </a>
    <div class="nav-links">
      ${links}
    </div>
  </div>
</nav>`;
}

// ----- Sync status pill (for header) -----
function renderStatusPill(status) {
  if (!status) return '';
  const { running, lastCaptureMs } = status;
  let icon, label, cls;
  if (running) {
    icon = '🟢';
    cls = 'status-pill ok';
    const ago = formatAgo(lastCaptureMs);
    label = `daemon · ${ago}`;
  } else {
    icon = '🔴';
    cls = 'status-pill stale';
    label = 'daemon stopped';
  }
  return `<span class="${cls}">${icon} ${esc(label)}</span>`;
}

function formatAgo(ms) {
  if (!ms || ms < 0) return 'unknown';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ----- Full page wrapper -----
export function renderPage(opts) {
  const { title = 'memex', active = '', body, status } = opts;
  const bodyHtml = body && typeof body === 'object' && body[RAW] ? body.value : esc(body || '');
  const statusHtml = renderStatusPill(status);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · memex</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/style.css">
<script src="https://unpkg.com/htmx.org@2.0.3" defer></script>
</head>
<body>
${renderNav(active)}
<header class="page-header">
  <div class="page-header-inner">
    <h1 class="page-title">${esc(title)}</h1>
    ${statusHtml}
  </div>
</header>
<main class="main">
  ${bodyHtml}
</main>
<footer class="footer">
  <span>memex · local-first AI memory</span>
  <span>· <a href="https://memex.parallelclaw.ai" target="_blank" rel="noopener">site</a></span>
  <span>· <a href="https://github.com/parallelclaw/memex-mvp" target="_blank" rel="noopener">github</a></span>
</footer>
</body>
</html>`;
}

// ----- Small reusable bits -----

export function renderCard({ label, body, className = '' }) {
  return html`
<section class="card ${raw(className)}">
  ${label ? html`<div class="card-label">${label}</div>` : null}
  <div class="card-body">${body}</div>
</section>`;
}

export function renderStat({ value, label }) {
  return html`
<div class="stat">
  <div class="stat-value">${value}</div>
  <div class="stat-label">${label}</div>
</div>`;
}

export function renderBubble({ who, when, text, side = 'left' }) {
  const cls = side === 'right' ? 'chat-bubble user' : 'chat-bubble ai';
  return html`
<div class="${raw(cls)}">
  <span class="chat-who">${who}${when ? raw(' · ' + esc(when)) : null}</span>
  <p>${text}</p>
</div>`;
}

export function fmtDate(ts) {
  if (!ts || ts === 0) return '?';
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function fmtDateTime(ts) {
  if (!ts || ts === 0) return '?';
  return new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

export function fmtNum(n) {
  if (n == null) return '?';
  return Number(n).toLocaleString('en-US');
}

export function fmtBytes(n) {
  if (n == null || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
