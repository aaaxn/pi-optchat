import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { Inspector } from '../src/inspector.ts';
import { emptyUsage, UsageLedger } from '../src/usage.ts';
import { RunHistory } from '../src/runs.ts';

test('inspector reaches old runs, preserves selection on return, scrolls transcripts, resizes, and shuts down', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-inspector-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const usage = new UsageLedger(dir), controller = new AbortController();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir);
  const session = SessionManager.create(dir, join(dir, 'runs'));
  session.appendMessage({ role: 'user', content: 'MEMORY VIEW MUST NOT APPEAR\n\nYour task:\nHistorical task', timestamp: 1 });
  session.appendMessage({ role: 'assistant', api: 'anthropic-messages', provider: 'test', model: 'test', stopReason: 'stop', timestamp: 2, usage: emptyUsage(),
    content: [{ type: 'thinking', thinking: 'hidden reasoning' }, { type: 'text', text: Array.from({ length: 100 }, (_, i) => `Transcript line ${i}`).join('\n') }] });
  for (let i = 0; i < 100; i++) children.history.records.set(`run-${i}`, { id: `run-${i}`, task: `Task ${i} ${'long title '.repeat(20)}`, cwd: dir, model: 'test', thinking: 'high',
    parentSession: 'parent', sessionFile: session.getSessionFile(), started: 1000 - i, ended: 2000, state: 'completed', guidance: [] });
  let rows = 24, finished = 0;
  const inspector = new Inspector({ profile: 'personal', session: 'parent', children, usage, page: 'agents', rows: () => rows, redraw: () => {}, done: () => { finished++; }, color: (_tone, text) => text, context: () => 123, signal: controller.signal });
  try {
    inspector.handleInput('\x1b[F');
    assert.match(inspector.render(100).find(l => l.startsWith('→')) ?? '', /Task 99/);
    inspector.handleInput('\r');
    assert.match(inspector.render(100).join('\n'), /Transcript line 99/);
    inspector.handleInput('\x1b[H');
    assert.doesNotMatch(inspector.render(100).join('\n'), /MEMORY VIEW MUST NOT APPEAR|hidden reasoning/);
    inspector.handleInput('\x1b[6~');
    assert.match(inspector.render(100).join('\n'), /scroll paused/);
    inspector.handleInput('f');
    assert.match(inspector.render(100).join('\n'), /Transcript line 99/);
    inspector.handleInput('\x1b');
    assert.match(inspector.render(100).find(l => l.startsWith('→')) ?? '', /Task 99/);
    inspector.handleInput('\t'); inspector.handleInput('\x1b[C');
    assert.match(inspector.render(100).join('\n'), /Last hour/);
    rows = 16;
    const narrow = inspector.render(40);
    assert.ok(narrow.length <= Math.floor(rows * 0.9));
    assert.ok(narrow.every(line => visibleWidth(line) <= 40));
    controller.abort(); inspector.handleInput('\x1b'); assert.equal(finished, 1);
  } finally { inspector.dispose(); await children.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); }
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
