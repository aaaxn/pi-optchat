import { join } from 'node:path';
import { atomicWrite } from './profiles.ts';
import { type Memory } from './memory.ts';

// One self-contained, read-only HTML snapshot of a profile's memory.
export function exportBrowser(memory: Memory, profile: string, directory = memory.directory) {
  const data = JSON.stringify({
    profile, budget: memory.budget, size: memory.size, view: memory.view,
    root: memory.root.map(({ i, kind, text, date, origin }) => ({ i, kind, text, date, ...(origin ? { origin: { source: origin.source, title: origin.title } } : {}) })),
    tree: [...memory.tree.values()].map(({ l, i, text }) => ({ l, i, text })),
  }).replace(/</g, '\\u003c');
  const path = join(directory, 'memory.html'); atomicWrite(path, PAGE.replace('__DATA__', () => data)); return path;
}

// Client code avoids backticks and template placeholders so it can live in String.raw.
const PAGE = String.raw`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OptChat memory</title>
<style>
:root{--bg:#f7f3ea;--paper:#fffdf8;--ink:#2a2723;--muted:#6b6357;--rule:#e4dccd;--accent:#7d5630;--bar:#d5c7ad;--you:#3f6380;--talk:#2a2723;--work:#4c6a41;--tool:#6b6357;--note:#80601f;--hl:#f6e7c1}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:780px;margin:0 auto;padding:64px 28px 160px}
h1{font:400 36px/1.15 "Iowan Old Style",Charter,Georgia,serif;margin:0 0 4px}
h1 small{font-size:18px;color:var(--muted);margin-left:10px}
.lede{color:var(--muted);margin:0 0 4px}
.explain{font-size:14px;color:var(--muted);margin:16px 0 0;max-width:620px}
.shape{display:flex;align-items:flex-end;gap:1px;height:84px;margin:36px 0 6px}
.shape.dense{gap:0}
.shape button{flex:1 1 0;min-width:0;border:0;padding:0;background:var(--bar);border-radius:1px;cursor:pointer}
.shape button:hover,.shape button:focus-visible{background:var(--accent);outline:none}
.axis{display:flex;justify-content:space-between;font-size:12px;color:var(--muted)}
nav{display:flex;gap:28px;margin:48px 0 8px;border-bottom:1px solid var(--rule)}
nav button{background:none;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;padding:0 0 10px;font:inherit;color:var(--muted);cursor:pointer}
nav button.on{color:var(--ink);border-color:var(--ink)}
h2.day{font-size:12px;font-weight:600;line-height:1;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:44px 0 0;padding-bottom:10px;border-bottom:1px solid var(--rule)}
.block,.msg{padding:18px 0;border-bottom:1px solid var(--rule)}
.children .block,.children .msg{border-bottom:0;padding:12px 0}
.meta,.who{font-size:13px;color:var(--muted)}
.who b{font-weight:600;letter-spacing:.04em;text-transform:uppercase;font-size:11.5px}
.msg.you .who b{color:var(--you)}.msg.talk .who b{color:var(--talk)}.msg.work .who b{color:var(--work)}.msg.tool .who b{color:var(--tool)}.msg.note .who b{color:var(--note)}
.summary{margin:6px 0 8px}
.pending{color:var(--muted);font-style:italic}
.text{margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere}
.clamp{display:-webkit-box;-webkit-line-clamp:7;-webkit-box-orient:vertical;overflow:hidden}
.children{margin:4px 0 0 2px;padding-left:20px;border-left:1px solid var(--rule)}
button.link{background:none;border:0;padding:0;font:inherit;font-size:14px;color:var(--accent);cursor:pointer}
button.link:hover{text-decoration:underline}
.target{background:var(--hl);box-shadow:-12px 0 0 var(--hl),12px 0 0 var(--hl)}
input[type=search]{width:100%;margin:24px 0 8px;padding:12px 16px;font:inherit;border:1px solid var(--rule);border-radius:10px;background:var(--paper);color:var(--ink);outline:none}
input[type=search]:focus{border-color:var(--bar)}
.count{font-size:14px;color:var(--muted);margin:0 0 8px}
mark{background:var(--hl);color:inherit;border-radius:2px;padding:0 1px}
.path{margin-top:10px;font-size:13px;color:var(--muted)}
.path .steps{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:6px}
.path .steps button{font:inherit;font-size:12px;padding:2px 9px;border:1px solid var(--rule);border-radius:99px;background:var(--paper);color:var(--ink);cursor:pointer}
.path .steps button.on{border-color:var(--accent);color:var(--accent)}
.peek{margin:8px 0 0;padding:10px 14px;background:var(--paper);border:1px solid var(--rule);border-radius:8px;font-size:14px;color:var(--ink)}
.empty{color:var(--muted);margin-top:40px}
</style>
<div class="wrap">
<header><h1>Memory <small id="profile"></small></h1><p class="lede" id="lede"></p>
<p class="explain">Recent messages are kept one by one. Older ones are folded into summaries of 2, 4, 8 or more messages, so the whole history fits in what the model reads each turn. Open a summary to see the two halves it was made from, down to the original messages.</p>
<div class="shape" id="shape"></div><div class="axis"><span id="from"></span><span>Each bar is one block the model sees. Taller bars fold more messages.</span><span>now</span></div></header>
<nav><button id="tab-view" class="on">What the model sees</button><button id="tab-search">Search</button></nav>
<main id="view"></main>
<main id="search" hidden><input type="search" id="q" placeholder="Search every message" autocomplete="off"><p class="count" id="count"></p><div id="hits"></div></main>
</div>
<script type="application/json" id="data">__DATA__</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const nodes = new Map(D.tree.map(n => [n.l + ':' + n.i, n]));
const $ = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const first = p => p.i * 2 ** p.l, count = p => 2 ** p.l;
const year = new Date().getFullYear();
const day = d => d.toLocaleDateString(undefined, Object.assign({ weekday: 'short', day: 'numeric', month: 'short' }, d.getFullYear() !== year ? { year: 'numeric' } : {}));
const time = d => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const times = D.root.map(e => new Date(e.date).getTime()), at = i => new Date(times[i]);
// Imported history is not always in date order, so a range shows its earliest and latest message.
function when(a, b) {
  let lo = times[a], hi = times[a];
  for (let k = a + 1; k <= b; k++) { lo = Math.min(lo, times[k]); hi = Math.max(hi, times[k]); }
  const x = new Date(lo), y = new Date(hi);
  if (lo === hi) return day(x) + ', ' + time(x);
  return x.toDateString() === y.toDateString() ? day(x) + ', ' + time(x) + '–' + time(y) : day(x) + ' ' + time(x) + ' – ' + day(y) + ' ' + time(y);
}
const SOURCE = { claude: 'Claude Code', 'claude-memory': 'Claude Code memory', codex: 'Codex', chatgpt: 'ChatGPT' };
// Imported text starts with a "[Historical …]" line for the model; the meta line already says it.
const body = e => { const j = e.origin && e.text.startsWith('[Historical ') ? e.text.indexOf(']\n') : -1; return j < 0 ? e.text : e.text.slice(j + 2); };
const short = (s, n) => { s = s.replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function who(e) {
  if (e.kind === 'user') return /^\[[0-9a-f]{6,}\] /.test(e.text) ? ['Subagent', 'work', 'subagent report'] : ['You', 'you', 'from you'];
  if (e.kind === 'talk') return ['OptChat', 'talk', 'reply'];
  if (e.kind === 'tool') return ['Tool call', 'tool', 'tool step'];
  if (e.kind === 'echo') return ['Tool result', 'tool', 'tool step'];
  return ['Note', 'note', 'note'];
}
function mix(a, b) {
  const c = new Map();
  for (let k = a; k < b; k++) { const w = who(D.root[k])[2]; c.set(w, (c.get(w) || 0) + 1); }
  return [...c].map(([w, n]) => n.toLocaleString() + ' ' + (n === 1 || w === 'from you' ? w : w === 'reply' ? 'replies' : w + 's')).join(', ');
}
function head(e) {
  const [label] = who(e), h = $('div', 'who');
  h.append($('b', null, label), ' · ' + when(e.i, e.i));
  if (e.origin) h.append(' · imported from ' + SOURCE[e.origin.source] + (e.origin.title ? ': ' + short(e.origin.title, 60) : ''));
  return h;
}
function message(e) {
  const text = body(e), el = $('div', 'msg ' + who(e)[1]), t = $('div', 'text clamp', text);
  el.dataset.k = '0:' + e.i; el.append(head(e), t);
  if (text.length > 600 || text.split('\n').length > 7) {
    const b = $('button', 'link', 'Show all');
    b.onclick = () => { b.textContent = t.classList.toggle('clamp') ? 'Show all' : 'Show less'; };
    el.append(b);
  } else t.classList.remove('clamp');
  return el;
}
// The model sees a large message as its shortened node, so the view shows that and keeps the original one click away.
function leaf(p) {
  const e = D.root[p.i], n = nodes.get('0:' + p.i);
  if (!n || n.text === e.text) return message(e);
  const el = $('article', 'block'), kids = $('div', 'children'), b = $('button', 'link', 'Show the original');
  el.dataset.k = '0:' + p.i; kids.hidden = true;
  el.append($('div', 'meta', who(e)[0] + ' · ' + when(p.i, p.i) + ' · shortened for the model'), $('p', 'summary', n.text), b, kids);
  b.onclick = () => { if (!kids.childElementCount) kids.append(message(e)); kids.hidden = !kids.hidden; b.textContent = kids.hidden ? 'Show the original' : 'Close'; };
  return el;
}
function block(p) {
  if (p.l === 0) return message(D.root[p.i]);
  const a = first(p), n = nodes.get(p.l + ':' + p.i), el = $('article', 'block');
  el.dataset.k = p.l + ':' + p.i;
  el.append($('div', 'meta', when(a, a + count(p) - 1) + ' · ' + count(p).toLocaleString() + ' messages: ' + mix(a, a + count(p))));
  el.append(n ? $('p', 'summary', n.text) : $('p', 'summary pending', 'Not summarized yet.'));
  const b = $('button', 'link', 'Open the two halves'), kids = $('div', 'children');
  kids.hidden = true; b.onclick = () => open(el); el.append(b, kids);
  return el;
}
function open(el, force) {
  const [l, i] = el.dataset.k.split(':').map(Number), kids = el.querySelector(':scope > .children'), b = el.querySelector(':scope > button.link');
  if (!kids.childElementCount) kids.append(block({ l: l - 1, i: 2 * i }), block({ l: l - 1, i: 2 * i + 1 }));
  kids.hidden = force === undefined ? !kids.hidden : !force;
  b.textContent = kids.hidden ? 'Open the two halves' : 'Close';
  return kids;
}
const view = document.getElementById('view'), search = document.getElementById('search');
function show(tab) {
  view.hidden = tab !== 'view'; search.hidden = tab !== 'search';
  document.getElementById('tab-view').classList.toggle('on', tab === 'view');
  document.getElementById('tab-search').classList.toggle('on', tab === 'search');
  if (tab === 'search') document.getElementById('q').focus();
}
document.getElementById('tab-view').onclick = () => show('view');
document.getElementById('tab-search').onclick = () => show('search');
function target(el) { document.querySelectorAll('.target').forEach(x => x.classList.remove('target')); el.classList.add('target'); el.scrollIntoView({ block: 'center' }); }
const holder = m => D.view.find(p => first(p) <= m && m < first(p) + count(p));
function reveal(m) {
  show('view');
  const p = holder(m); let el = view.querySelector('[data-k="' + p.l + ':' + p.i + '"]');
  for (let k = p.l; k > 0; k--) el = open(el, true).querySelector(':scope > [data-k="' + (k - 1) + ':' + Math.floor(m / 2 ** (k - 1)) + '"]');
  if (el.matches('article')) { const b = el.querySelector(':scope > button.link'); if (b.textContent !== 'Close') b.click(); el = el.querySelector('.children > .msg'); }
  target(el);
}

document.getElementById('profile').textContent = D.profile;
if (!D.root.length) { document.getElementById('lede').textContent = 'No messages yet.'; document.querySelector('.shape').remove(); document.querySelector('.axis').remove(); }
else {
  const kb = n => Math.round(n / 1000).toLocaleString() + ' KB';
  document.getElementById('lede').textContent = D.root.length.toLocaleString() + ' messages since ' + day(at(0)) + '. The model sees them as ' + D.view.length.toLocaleString() + ' blocks, using ' + kb(D.size) + ' of its ' + kb(D.budget) + ' memory view.';
  document.getElementById('from').textContent = day(at(0));
  const shape = document.getElementById('shape'), top = Math.max(1, ...D.view.map(p => p.l));
  shape.classList.toggle('dense', D.view.length > 250);
  for (const p of D.view) {
    const s = $('button'), a = first(p);
    s.style.height = (6 + 78 * p.l / top) + 'px';
    s.title = when(a, a + count(p) - 1) + ' · ' + count(p).toLocaleString() + (count(p) === 1 ? ' message' : ' messages');
    s.onclick = () => { show('view'); target(view.querySelector('[data-k="' + p.l + ':' + p.i + '"]')); };
    s.setAttribute('aria-label', s.title);
    shape.append(s);
  }
  let last = '';
  for (const p of D.view) {
    const d = at(first(p));
    if (d.toDateString() !== last) { view.append($('h2', 'day', day(d))); last = d.toDateString(); }
    view.append(p.l ? block(p) : leaf(p));
  }
}

const q = document.getElementById('q'), hits = document.getElementById('hits'), counter = document.getElementById('count');
const lower = D.root.map(e => body(e).toLowerCase());
function snippet(text, j, len) {
  const a = Math.max(0, j - 140), b = Math.min(text.length, j + len + 220), el = $('div', 'text');
  el.append((a ? '…' : '') + text.slice(a, j), $('mark', null, text.slice(j, j + len)), text.slice(j + len, b) + (b < text.length ? '…' : ''));
  return el;
}
function path(m) {
  const p = holder(m), wrap = $('div', 'path'), steps = $('div', 'steps'), peek = $('div', 'peek');
  wrap.append(p.l ? 'The model sees this inside a ' + count(p).toLocaleString() + '-message summary. Each step is one zoom:' : 'The model sees this message on its own.');
  const go = $('button', 'link', 'Show in memory'); go.onclick = () => reveal(m);
  if (!p.l) { wrap.append(' ', go); return wrap; }
  peek.hidden = true; go.style.marginLeft = '8px';
  for (let k = p.l; k >= 0; k--) {
    const i = Math.floor(m / 2 ** k), b = $('button', null, k ? (2 ** k).toLocaleString() + ' messages' : 'this message');
    b.onclick = () => {
      const on = !b.classList.contains('on'); steps.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.toggle('on', on); peek.hidden = !on;
      peek.textContent = (nodes.get(k + ':' + i) || { text: 'Not summarized yet.' }).text;
    };
    steps.append(b);
    if (k) steps.append('›');
  }
  steps.append(go);
  wrap.append(steps, peek);
  return wrap;
}
let timer;
q.oninput = () => { clearTimeout(timer); timer = setTimeout(find, 120); };
function find() {
  const s = q.value.trim().toLowerCase();
  hits.replaceChildren(); counter.textContent = '';
  if (s.length < 2) return;
  const found = [];
  for (let i = D.root.length - 1; i >= 0; i--) { const j = lower[i].indexOf(s); if (j >= 0) found.push([i, j]); }
  // Imported history is appended after native messages and may be out of date order, so sort by time.
  found.sort((x, y) => times[y[0]] - times[x[0]] || y[0] - x[0]);
  counter.textContent = found.length ? found.length.toLocaleString() + (found.length === 1 ? ' message' : ' messages') + ', newest first' + (found.length > 100 ? ' (showing 100)' : '') : 'No messages match.';
  for (const [i, j] of found.slice(0, 100)) {
    const e = D.root[i], el = $('div', 'msg ' + who(e)[1]);
    el.append(head(e), snippet(body(e), j, s.length), path(i));
    hits.append(el);
  }
}
</script></html>`;
