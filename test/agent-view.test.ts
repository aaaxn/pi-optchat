import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime, SessionManager, initTheme } from '@earendil-works/pi-coding-agent';
import { TuiMainScreen, visibleWidth, type Terminal, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { AgentView, TranscriptView, hideImagesUnderOverlays } from '../src/agent-view.ts';
import { textContent } from '../src/transcript.ts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { emptyUsage } from '../src/usage.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));
initTheme('dark', false);

class OffscreenTerminal implements Terminal {
  start() {} stop() {} async drainInput() {} write(_data: string) {}
  get columns() { return 100; } get rows() { return 30; } get kittyProtocolActive() { return false; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
const plain = (lines: string[]) => lines.join('\n').replace(/\x1b\[[0-9;:]*[A-Za-z]|\x1b[\]_][^\x07\x1b]*(\x07|\x1b\\)/g, '');

test('agent view shows the child conversation like the main chat, fills the screen, and Esc returns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-agent-view-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir);
  const session = SessionManager.create(dir, join(dir, 'runs'));
  const assistant = { api: 'anthropic-messages', provider: 'test', model: 'test', usage: emptyUsage() } as const;
  session.appendMessage({ role: 'user', content: 'MEMORY VIEW MUST NOT APPEAR\n\nYour task:\nCount the files', timestamp: 1 });
  session.appendMessage({ role: 'assistant', ...assistant, stopReason: 'toolUse', timestamp: 2,
    content: [{ type: 'thinking', thinking: 'hidden reasoning' }, { type: 'text', text: 'Listing them now.' }, { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls | wc -l' } }] });
  session.appendMessage({ role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: 'TOOL_OUTPUT_42' }], isError: false, timestamp: 3 });
  session.appendMessage({ role: 'assistant', ...assistant, stopReason: 'stop', timestamp: 4, content: [{ type: 'text', text: 'There are **42** files.' }] });
  children.history.records.set('child-1', { id: 'child-1', task: 'Count the files', cwd: dir, model: 'anthropic/claude-test', thinking: 'high',
    parentSession: 'parent', depth: 1, sessionFile: session.getSessionFile(), started: 1000, ended: 61_000, state: 'completed', guidance: [] });
  const tui = new TuiMainScreen(new OffscreenTerminal());
  let rows = 30, closed = 0;
  const view = new AgentView({ id: 'child-1', children, tui, rows: () => rows, redraw: () => {}, done: () => { closed++; }, color: (_tone, text) => text });
  try {
    const lines = view.render(100), text = plain(lines);
    assert.equal(lines.length, 30, 'fills the screen so the main chat is hidden');
    assert.ok(lines.every(line => visibleWidth(line) <= 100));
    assert.match(lines[0], /child-1 {2}Count the files .*completed · 1m 0s · claude-test/);
    assert.match(text, /\$ ls \| wc -l/, "bash calls use Pi's own renderer");
    assert.match(text, /TOOL_OUTPUT_42/);
    assert.match(text, /There are 42 files\./);
    assert.match(text, /Esc back to main/);
    assert.doesNotMatch(text, /MEMORY VIEW MUST NOT APPEAR|hidden reasoning|Ctrl\+X/);
    assert.ok(text.indexOf('Count the files', text.indexOf('\n')) < text.indexOf('Listing them now.'), 'the task opens the conversation');
    rows = 12;
    assert.equal(view.render(40).length, 12);
    view.handleInput('\x1b[5~');
    assert.match(plain(view.render(40)), /PgDn newer/);
    view.handleInput('x'); // Finished agents take no input.
    view.handleInput('\x1b');
    assert.equal(closed, 1);
  } finally { view.dispose(); await children.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

const wheel = (delta: number): TuiMouseEvent => ({ type: 'wheel', button: 'none', x: 0, y: 0, screenX: 0, screenY: 0, width: 40, height: 12, shift: false, alt: false, ctrl: false, wheelDelta: delta });
const assistant = { api: 'anthropic-messages', provider: 'test', model: 'test', usage: emptyUsage() } as const;
async function until(condition: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}

test('agent view labels guidance from the main agent and child reports, keeps the controls, and scrolls with the wheel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-agent-view-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir);
  const session = SessionManager.create(dir, join(dir, 'runs'));
  session.appendMessage({ role: 'user', content: 'Your task:\nCheck it', timestamp: 1 });
  for (let i = 0; i < 20; i++) session.appendMessage({ role: 'assistant', ...assistant, stopReason: 'stop', timestamp: 2, content: [{ type: 'text', text: `line ${i}` }] });
  session.appendMessage({ role: 'user', content: 'Use the cache.', timestamp: 3 });
  session.appendMessage({ role: 'user', content: '[1a2b3c4d] Child found 3 more.', timestamp: 4 });
  session.appendMessage({ role: 'user', content: 'Thanks, done?', timestamp: 5 });
  session.appendMessage({ role: 'assistant', ...assistant, stopReason: 'stop', timestamp: 6, content: [{ type: 'text', text: 'Done.' }] });
  const guidance = [{ text: 'Use the cache.', date: 3, state: 'delivered' as const, from: 'manager' as const }, { text: 'Thanks, done?', date: 5, state: 'delivered' as const, from: 'user' as const },
    ...Array.from({ length: 15 }, (_, i) => ({ text: `lost ${i}`, date: 7, state: 'undelivered' as const, from: 'user' as const }))];
  children.history.records.set('child-2', { id: 'child-2', task: 'Check it', cwd: dir, model: 'anthropic/claude-test', thinking: 'high',
    parentSession: 'parent', depth: 1, sessionFile: session.getSessionFile(), started: 1000, ended: 2000, state: 'completed', guidance });
  const tui = new TuiMainScreen(new OffscreenTerminal());
  let rows = 200;
  const view = new AgentView({ id: 'child-2', children, tui, rows: () => rows, redraw: () => {}, done: () => {}, color: (_tone, text) => text });
  try {
    const all = plain(view.render(60)).split('\n');
    const at = (needle: string) => all.findIndex(line => line.includes(needle));
    assert.match(all[at('Use the cache.') - 2], /\[main agent\]/, "the main agent's guidance is labelled");
    assert.match(all[at('Child found 3 more.') - 2], /\[agent report\]/);
    assert.doesNotMatch(all.slice(at('Thanks, done?') - 3, at('Thanks, done?')).join(' '), /\[/, "the user's own words look typed");
    rows = 20;
    const lines = plain(view.render(60)).split('\n');
    assert.equal(lines.length, 20);
    assert.match(lines[19], /Esc back to main/, 'pending guidance never pushes the footer off screen');
    assert.match(lines.join('\n'), /\+12 more not yet delivered[^]*Not delivered: lost 14/);
    view.handleMouse(wheel(-3));
    assert.match(plain(view.render(60)), /↑ 3 lines up/);
    view.handleMouse(wheel(5));
    assert.doesNotMatch(plain(view.render(60)), /lines up/);
    rows = 3;
    assert.deepEqual(view.render(60).length, 3, 'tiny terminals get exactly their rows');
  } finally { view.dispose(); await children.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('running tools show their real elapsed time, finished ones how long they took', () => {
  const tui = new TuiMainScreen(new OffscreenTerminal());
  const started = Date.now() - 65_000;
  const call: AgentMessage = { role: 'assistant', ...assistant, stopReason: 'toolUse', timestamp: started,
    content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'make' } }] };
  const result: AgentMessage = { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'built' }], isError: false, timestamp: started + 70_000 };
  const task: AgentMessage = { role: 'user', content: 'Build', timestamp: started };
  const view = new TranscriptView(tui, process.cwd());
  const draw = (parts: { render(width: number): string[] }[]) => plain(parts.flatMap(p => p.render(80)));
  const running = new Map([['t1', { started, output: { content: [{ type: 'text', text: 'compiling' }] } }]]);
  assert.match(draw(view.build('Build', [task, call], undefined, running)), /Elapsed 1m 5s/, 'not from when the view opened');
  assert.match(draw(view.build('Build', [task, call, result])), /Took 1m 10s/);
  assert.doesNotMatch(draw(new TranscriptView(tui, process.cwd()).build('Build', [task, call, result])), /Took/, 'unknown start shows no time rather than a wrong one');
});

test('agent view drives a running agent: streaming, guidance from the input, drafts, editing a queued message, interrupting, and a two-press stop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-agent-live-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: `Working on ${textContent(context.messages.find(m => m.role === 'user')?.content).split('Your task:\n').at(-1)}` }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      void (async () => {
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: textContent(message.content), partial: message });
        await new Promise<void>(resolve => { options?.signal?.addEventListener('abort', () => resolve(), { once: true }); if (options?.signal?.aborted) resolve(); });
        message.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: message }); stream.end();
      })();
      return stream;
    },
  });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async () => {}, () => {}, dir, { createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  const tui = new TuiMainScreen(new OffscreenTerminal());
  let closed = 0;
  const [id] = await children.spawn([{ task: 'live-task' }], dir);
  const view = new AgentView({ id, children, tui, rows: () => 30, redraw: () => {}, done: () => { closed++; }, color: (_tone, text) => text });
  const text = () => plain(view.render(100));
  try {
    await until(() => !!children.live(id)?.streaming);
    assert.match(text(), /Working on live-task/);
    assert.match(text().split('\n')[0], /writing/);
    for (const key of 'draft') view.handleInput(key);
    assert.match(text(), /Esc clear/);
    view.handleInput('\x1b');
    assert.equal(closed, 0, 'Esc clears a draft before it leaves');
    assert.match(text(), /Esc back to main · Ctrl\+C interrupt · Ctrl\+X stop/);
    for (const key of 'Please include tests.') view.handleInput(key);
    view.handleInput('\r');
    await until(() => children.history.records.get(id)?.guidance.length === 1);
    assert.deepEqual(children.history.records.get(id)?.guidance.map(g => [g.text, g.from]), [['Please include tests.', 'user']]);
    await children.tell(id, 'Main agent note.');
    assert.match(text(), /Queued \(main agent\): Main agent note\./);
    assert.match(text(), /↑ edit queued/);
    view.handleInput('\x1b[A');
    assert.match(text(), /│? *Please include tests\.[^]*Esc clear/, 'Up pulls the queued message back into the input');
    assert.deepEqual(children.history.records.get(id)?.guidance.map(g => g.text), ['Main agent note.']);
    view.handleInput('\x03');
    assert.equal(closed, 0, 'Ctrl+C first clears the pulled-back draft, which drops it');
    assert.doesNotMatch(text(), /Please include tests\./);
    view.handleInput('\x03');
    await until(() => children.history.records.get(id)?.guidance[0].state === 'delivered');
    await until(() => children.messages(id).some(m => m.role === 'user' && textContent(m.content) === 'Interrupted by the user:\n\nMain agent note.'));
    assert.equal(children.history.records.get(id)?.state, 'running', 'an interrupt with a queued message keeps the agent going');
    view.handleInput('\x03');
    await until(() => children.history.records.get(id)?.state === 'paused');
    assert.equal(closed, 0, 'with nothing queued it only pauses; the view stays');
    assert.match(text().split('\n')[0], /interrupted · waiting for you/);
    assert.doesNotMatch(text(), /Ctrl\+C interrupt/);
    for (const key of 'Go on.') view.handleInput(key);
    view.handleInput('\r');
    await until(() => children.history.records.get(id)?.state === 'running');
    assert.equal(children.history.records.get(id)?.guidance.at(-1)?.text, 'Go on.');
    view.handleInput('\x18');
    assert.match(text(), /Press Ctrl\+X again/);
    assert.equal(children.history.records.get(id)?.state, 'running', 'one press only asks');
    view.handleInput('\x18');
    await until(() => children.history.records.get(id)?.state === 'stopped');
    assert.match(text(), /Ended \(stopped\)/);
    view.handleInput('\x1b');
    assert.equal(closed, 1);
  } finally { view.dispose(); await children.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('main-chat images are hidden under the agent view and come back after', async () => {
  let written = '';
  const terminal = new (class extends OffscreenTerminal { override write(data: string) { written += data; } })();
  const tui = new TuiMainScreen(terminal);
  const image = '\x1b_Ga=T,f=100,q=2;IMAGE_BYTES\x1b\\';
  tui.addChild({ render: () => ['main chat', image], invalidate() {} });
  const frame = async () => { written = ''; tui.requestRender(true); await new Promise(resolve => setImmediate(resolve)); return written; };
  const overlay = tui.showOverlay({ render: width => Array.from({ length: 30 }, () => 'V'.repeat(width)), invalidate() {} }, { width: '100%', maxHeight: '100%', row: 0, col: 0 });
  const restore = hideImagesUnderOverlays(tui);
  try {
    const covered = await frame();
    assert.doesNotMatch(covered, /IMAGE_BYTES/);
    assert.equal(covered.match(/V{100}/g)?.length, 30, 'every row shows the view');
  } finally { restore(); }
  overlay.hide();
  assert.match(await frame(), /IMAGE_BYTES/);
  tui.stop();
});
