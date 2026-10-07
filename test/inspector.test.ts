import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry, ModelRuntime, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth, type Component } from '@earendil-works/pi-tui';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { fit, Inspector, short, type InspectorAction } from '../src/inspector.ts';
import { UsageLedger } from '../src/usage.ts';
import { RunHistory } from '../src/runs.ts';
import { mountNavigation } from '../src/navigation.ts';

// Children load installed extensions from Pi's agent dir; keep tests away from the user's real one.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));

test('inspector reaches old runs, opens the selected agent, shows usage, resizes, and shuts down', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-inspector-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const usage = new UsageLedger(dir), controller = new AbortController();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir);
  for (let i = 0; i < 100; i++) children.history.records.set(`run-${i}`, { id: `run-${i}`, task: `Task ${i} ${'long title '.repeat(20)}`, cwd: dir, model: 'test', thinking: 'high',
    parentSession: 'parent', depth: 1, started: 1000 - i, ended: 2000, state: 'completed', guidance: [] });
  const spend = (role: 'main' | 'compactor', model: string, cost: number, provider?: string) => usage.add({ date: new Date().toISOString(), role, model, provider, session: 'parent',
    usage: { input: 0, output: 164_000, cacheRead: 900, cacheWrite: 100, totalTokens: 165_000, cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost } } });
  spend('main', 'claude-opus-5-5', 20.5, 'anthropic'); spend('main', 'evil\n\x1b[2Jmodel', 0); spend('compactor', 'claude-sonnet-5-5', 60, 'anthropic'); spend('compactor', 'claude-sonnet-5-5', 3.35);
  let rows = 24;
  const actions: (InspectorAction | undefined)[] = [];
  const open = (page: 'agents' | 'usage') => new Inspector({ profile: 'personal', session: 'parent', children, usage, memory, page, rows: () => rows, redraw: () => {}, done: action => { actions.push(action); }, color: (_tone, text) => text, context: () => 123, signal: controller.signal });
  const inspector = open('agents'), usagePage = open('usage');
  try {
    inspector.handleInput('\x1b[F');
    assert.match(inspector.render(100).find(l => l.startsWith(' →')) ?? '', /Task 99/);
    assert.match(inspector.render(100).join('\n'), /Enter open/);
    inspector.handleInput('\r');
    assert.deepEqual(actions, [{ open: 'run-99' }]);
    const table = usagePage.render(100).filter(l => /main|compactor/.test(l));
    // A provider-less older record shares its model's row; costs line up on the right.
    assert.deepEqual(table.map(l => l.trim().split(/\s+/)), [['main', 'claude-opus-5-5', '$20.50', '24%', '164k', '90%'], ['compactor', 'claude-sonnet-5-5', '$63.35', '76%', '328k', '90%']]);
    assert.equal(table[0].indexOf('$20.50') + 6, table[1].indexOf('$63.35') + 6);
    // A model name read from disk can't break the table or send terminal codes.
    assert.ok(usagePage.render(100).some(l => /evil \[2Jmodel +\$0\.00/.test(l)));
    assert.ok(usagePage.render(100).every(l => !l.includes('\x1b')));
    assert.doesNotMatch(usagePage.render(40).join('\n'), /claude-/);
    usagePage.handleInput('\x1b[C');
    assert.match(usagePage.render(100).join('\n'), /\[Last.hour\]/);
    rows = 16;
    const narrow = usagePage.render(40);
    assert.ok(narrow.length <= Math.floor(rows * 0.9));
    assert.ok(narrow.every(line => visibleWidth(line) <= 40));
    controller.abort(); usagePage.handleInput('\x1b'); assert.equal(actions.length, 2);
  } finally { inspector.dispose(); usagePage.dispose(); await children.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Tab cycles Agents, Usage and Activity; Activity is a memory gauge with an agent count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-activity-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir);
  let progress: ReturnType<Memory['progress']> = { done: 0, total: 0, retryIn: undefined };
  const fake = { root: memory.root, size: 97_400, budget: 128_000, lastError: undefined as string | undefined, progress: () => progress, onChange: () => () => {} };
  for (let i = 0; i < 3; i++) memory.append('user', `message ${i}`);
  const inspector = new Inspector({ profile: 'personal', session: 'parent', children, usage: new UsageLedger(dir), memory: fake, page: 'agents',
    rows: () => 40, redraw: () => {}, done: () => {}, color: (_tone, text) => text, context: () => undefined });
  const title = () => inspector.render(100)[1].trim().split(/\s{2,}/)[0];
  const page = () => inspector.render(100).slice(3, -3).map(l => l.trim()).filter(Boolean);
  try {
    assert.equal(title(), 'OptChat · personal · Agents');
    inspector.handleInput('\t'); assert.equal(title(), 'OptChat · personal · Usage');
    inspector.handleInput('\t'); assert.equal(title(), 'OptChat · personal · Activity');
    assert.deepEqual(page(), ['Memory · 3 messages · view 97 KB / 128 KB', 'Settled', 'Agents · 0 running']);
    progress = { done: 12, total: 40, retryIn: 7_000 }; fake.lastError = '429 rate_limit_error';
    children.history.records.set('run', { id: 'run', task: 'review', cwd: dir, model: 'test', thinking: 'high', parentSession: 'parent', depth: 1, started: Date.now(), state: 'running', guidance: [] });
    assert.deepEqual(page(), ['Memory · 3 messages · view 97 KB / 128 KB', 'Catching up · 12 of 40 summaries  ███░░░░░░░', '429 rate_limit_error · retry in 7s',
      'Agents · 1 running']);
    children.history.records.set('paused', { id: 'paused', task: 'wait', cwd: dir, model: 'test', thinking: 'high', parentSession: 'parent', depth: 1, started: Date.now(), state: 'paused', guidance: [] });
    assert.equal(page().at(-1), 'Agents · 1 running · 1 interrupted', 'an interrupted agent is neither running nor finished');
    inspector.handleInput('\t'); assert.equal(title(), 'OptChat · personal · Agents');
  } finally { inspector.dispose(); await children.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the Activity bar item shows a dot only while summaries or agents are at work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-bar-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir);
  let total = 0, widget: Component | undefined;
  const fake = { progress: () => ({ done: 0, total, retryIn: undefined }), onChange: () => () => {} };
  const ctx = { ui: { getEditorComponent: () => () => undefined, setWidget: (_key: string, factory?: (tui: unknown, theme: unknown) => Component) => { widget = factory?.({ requestRender() {} }, { fg: (_tone: string, text: string) => text }); } } };
  const unmount = mountNavigation(ctx as unknown as ExtensionContext, children, fake, 'f6', () => {});
  const bar = () => widget?.render(120).join('') ?? '';
  try {
    assert.doesNotMatch(bar(), /●/);
    total = 5; assert.match(bar(), /Usage {3}● Activity/);
    total = 0; children.history.records.set('run', { id: 'run', task: 'review', cwd: dir, model: 'test', thinking: 'high', parentSession: 'parent', depth: 1, started: Date.now(), state: 'paused', guidance: [] });
    assert.match(bar(), /Agents: 0 running · 1 interrupted · 0 saved/);
    assert.doesNotMatch(bar(), /●/, 'an agent waiting for the user is not at work');
    children.history.records.get('run')!.state = 'running';
    assert.match(bar(), /● Activity/);
  } finally { unmount(); await children.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('unfinished persisted runs recover as interrupted with undelivered guidance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-run-history-'));
  try {
    const history = new RunHistory(dir);
    history.save({ id: 'interrupted', task: 'work', cwd: dir, model: 'test', thinking: 'high', parentSession: 'parent', depth: 1, started: 1, state: 'running',
      guidance: [{ text: 'additional task', date: 2, state: 'queued' }] });
    const restored = new RunHistory(dir).records.get('interrupted');
    assert.equal(restored?.state, 'interrupted');
    assert.equal(restored?.guidance[0].state, 'undelivered');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('agent titles shorten at a word boundary with an ellipsis', () => {
  assert.equal(fit('Read-only review of PR #7 in jonaslsaa/pi-optchat', 30), 'Read-only review of PR #7 in…');
  assert.equal(fit('github.com/jonaslsaa/pi-optchat/pull/7', 12), 'github.com/…');
  assert.equal(fit('review #6', 30), 'review #6');
});

test('short numbers move up a unit instead of showing 1000', () => {
  assert.deepEqual([999, 999.6, 12_345, 164_000, 999_499, 999_500, 999_500_000, 2_400_000].map(short), ['999', '1k', '12.3k', '164k', '999k', '1M', '1B', '2.4M']);
});
