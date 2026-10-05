import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { fit, Inspector, type InspectorAction } from '../src/inspector.ts';
import { UsageLedger } from '../src/usage.ts';
import { RunHistory } from '../src/runs.ts';

// Children load installed extensions from Pi's agent dir; keep tests away from the user's real one.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));

test('inspector reaches old runs, opens the selected agent, shows usage, resizes, and shuts down', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-inspector-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const usage = new UsageLedger(dir), controller = new AbortController();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir);
  for (let i = 0; i < 100; i++) children.history.records.set(`run-${i}`, { id: `run-${i}`, task: `Task ${i} ${'long title '.repeat(20)}`, cwd: dir, model: 'test', thinking: 'high',
    parentSession: 'parent', started: 1000 - i, ended: 2000, state: 'completed', guidance: [] });
  let rows = 24;
  const actions: (InspectorAction | undefined)[] = [];
  const open = (page: 'agents' | 'usage') => new Inspector({ profile: 'personal', session: 'parent', children, usage, page, rows: () => rows, redraw: () => {}, done: action => { actions.push(action); }, color: (_tone, text) => text, context: () => 123, signal: controller.signal });
  const inspector = open('agents'), usagePage = open('usage');
  try {
    inspector.handleInput('\x1b[F');
    assert.match(inspector.render(100).find(l => l.startsWith(' →')) ?? '', /Task 99/);
    assert.match(inspector.render(100).join('\n'), /Enter open/);
    inspector.handleInput('\r');
    assert.deepEqual(actions, [{ open: 'run-99' }]);
    usagePage.handleInput('\x1b[C');
    assert.match(usagePage.render(100).join('\n'), /Last hour/);
    rows = 16;
    const narrow = usagePage.render(40);
    assert.ok(narrow.length <= Math.floor(rows * 0.9));
    assert.ok(narrow.every(line => visibleWidth(line) <= 40));
    controller.abort(); usagePage.handleInput('\x1b'); assert.equal(actions.length, 2);
  } finally { inspector.dispose(); usagePage.dispose(); await children.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('unfinished persisted runs recover as interrupted with undelivered guidance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-run-history-'));
  try {
    const history = new RunHistory(dir);
    history.save({ id: 'interrupted', task: 'work', cwd: dir, model: 'test', thinking: 'high', parentSession: 'parent', started: 1, state: 'running',
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
