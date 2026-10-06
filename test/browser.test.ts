import './support.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from '../src/memory.ts';
import { exportBrowser } from '../src/browser.ts';

test('memory browser embeds escaped data and a script that compiles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-browser-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  try {
    memory.append('user', 'Hello </script><img src=x onerror=alert(1)> $& $1');
    memory.append('talk', 'Reply\nwith lines');
    const html = readFileSync(exportBrowser(memory, 'test'), 'utf8');
    const [, json] = html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/) ?? [];
    assert.ok(json && !json.includes('<'));
    const data: unknown = JSON.parse(json);
    assert.ok(typeof data === 'object' && data !== null && 'root' in data && Array.isArray(data.root));
    assert.deepEqual('sources' in data && data.sources, { claude: 'Claude Code', 'claude-memory': 'Claude Code memory', codex: 'Codex', chatgpt: 'ChatGPT' }, 'every import source has a label from its adapter');
    assert.equal(data.root[0].text, 'Hello </script><img src=x onerror=alert(1)> $& $1');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    assert.doesNotThrow(() => new Function(scripts[0][1]));
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

class El {
  textContent = ''; className = ''; hidden = false; title = ''; dataset: Record<string, string> = {}; style: Record<string, string> = {}; children: (El | string)[] = [];
  classList = { toggle: () => false, remove: () => {}, add: () => {}, contains: () => false };
  append(...nodes: (El | string)[]) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; }
  setAttribute() {}
  get text(): string { return this.textContent + this.children.map(child => typeof child === 'string' ? child : child.text).join(''); }
}

test('the memory page names an imported message\'s source with the label from the adapter table', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-browser-'));
  mkdirSync(join(dir, 'main'));
  const origins = [['claude', 'Claude Code'], ['claude-memory', 'Claude Code memory'], ['codex', 'Codex'], ['chatgpt', 'ChatGPT']] as const;
  writeFileSync(join(dir, 'main/2026-01-02.jsonl'), origins.map(([source], i) => JSON.stringify({ i, kind: 'user', text: `[Historical ${source}]\nbody ${i}`, date: '2026-01-02T12:00:00.000Z',
    origin: { source, conversation: `c${i}`, message: `m${i}`, title: `title of ${source}` } })).join('\n') + '\n');
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  try {
    const html = readFileSync(exportBrowser(memory, 'test'), 'utf8');
    const elements = new Map<string, El>();
    const element = (id: string) => elements.get(id) ?? elements.set(id, new El()).get(id)!;
    element('data').textContent = html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/)?.[1] ?? '';
    new Function('document', [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1])({ getElementById: element, createElement: () => new El(), querySelector: () => new El(), querySelectorAll: () => [] });
    const page = element('view').text;
    for (const [source, label] of origins) assert.ok(page.includes(` · imported from ${label}: title of ${source}`), `the page shows ${label} for a ${source} message`);
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});
