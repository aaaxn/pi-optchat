import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type ToolResultMessage, type UserMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { Inbox } from '../src/inbox.ts';
import { isView, Memory, type Compressor } from '../src/memory.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { COMPACT } from '../src/prompts.ts';
import { REPORT_TYPE } from '../src/transcript.ts';
import { NEEDS_PROFILE, Turn, type TurnContext } from '../src/turn.ts';
import { emptyUsage } from '../src/usage.ts';
import { fakeProvider, fakeRuntime } from './fakes.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const user = (text: string): UserMessage => ({ role: 'user', content: text, timestamp: 1 });
const answer = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => ({
  role: 'assistant', content, timestamp: 2, stopReason, api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: emptyUsage(),
});
const report = (text: string): AgentMessage => ({ role: 'custom', customType: REPORT_TYPE, content: text, display: true, timestamp: 3 });
const noImport = () => false;
const LONG = 'a decision worth keeping '.repeat(40);

async function fixture(compress: Compressor = async input => input.source.slice(0, 100)) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-turn-'));
  const memory = new Memory(dir, compress, () => {});
  const inbox = new Inbox(dir);
  const turn = new Turn(() => ({ memory, inbox, dir }));
  const notices: string[] = [], working: (string | undefined)[] = [];
  let aborts = 0;
  const controller = new AbortController();
  const ctx: TurnContext = { signal: controller.signal, abort: () => { aborts++; }, ui: { notify: text => { notices.push(text); }, setWorkingMessage: text => { working.push(text); } } };
  return { dir, memory, inbox, turn, ctx, notices, working, controller, aborts: () => aborts,
    file: (name: string): unknown => JSON.parse(readFileSync(join(dir, name), 'utf8')),
    kinds: () => memory.root.map(e => e.kind),
    async done() { await memory.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const text = (message: AgentMessage | undefined) => JSON.stringify(message && 'content' in message ? message.content : null);
const sent = (messages: AgentMessage[]) => (messages.find(m => m.role === 'user') as UserMessage).content as { type: 'text'; text: string }[];

test('a turn waits until every view line is a summary, then sends the view (checklist 3)', async () => {
  const release: { run?: () => void } = {};
  const gate = new Promise<void>(resolve => { release.run = resolve; });
  const f = await fixture(async () => { await gate; return 'SUMMARY OF THE EARLIER MESSAGE'; });
  try {
    f.memory.append('user', LONG);
    f.turn.start(); f.turn.prompt = 'system prompt';
    f.turn.messageEnd(user('Now?'), f.ctx);
    let answered = false;
    const pending = f.turn.context([], f.ctx, noImport).then(messages => { answered = true; return messages; });
    await sleep(50);
    assert.equal(answered, false, 'no context while a view line is unsummarized');
    assert.deepEqual(f.working, ['Waiting for OptChat summaries…']);
    release.run?.();
    const messages = await pending;
    assert.deepEqual(f.working, ['Waiting for OptChat summaries…', undefined]);
    assert.ok(f.memory.ready);
    const sentText = text(messages[1]);
    assert.match(sentText, /SUMMARY OF THE EARLIER MESSAGE/);
    assert.doesNotMatch(sentText, /a decision worth keeping/);
  } finally { release.run?.(); await f.done(); }
});

test('an aborted wait for summaries clears the working message and refuses the turn (B4-F)', async () => {
  const f = await fixture((_input, signal) => new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('closed')))));
  try {
    f.memory.append('user', LONG);
    f.turn.start();
    f.turn.messageEnd(user('Now?'), f.ctx);
    const pending = f.turn.context([], f.ctx, noImport);
    await sleep(20);
    f.controller.abort();
    const messages = await pending;
    assert.deepEqual(f.working, ['Waiting for OptChat summaries…', undefined], 'the message is cleared although the wait threw');
    assert.deepEqual(messages.map(m => m.role), ['system']);
    assert.equal(f.aborts(), 1);
    assert.deepEqual(f.notices, ['Memory wait cancelled.']);
  } finally { await f.done(); }
});

test('the context holds the view and the current run only, and the view stays fixed during the run (checklist 11)', async () => {
  const f = await fixture();
  try {
    f.memory.append('user', 'Older question'); f.memory.append('talk', 'Older answer');
    const history: AgentMessage[] = [user('Older question'), answer([{ type: 'text', text: 'Older answer' }]),
      { role: 'toolResult', toolCallId: 'old', toolName: 'read', content: [{ type: 'text', text: 'OLD TOOL OUTPUT' }], isError: false, timestamp: 1 }];
    f.turn.start(); f.turn.prompt = 'system prompt';
    const current = user('Current question');
    f.turn.messageEnd(current, f.ctx);
    const first = await f.turn.context([...history, current], f.ctx, noImport);
    assert.deepEqual(first.map(m => m.role), ['system', 'user']);
    const [view, question] = sent(first);
    assert.ok(isView(view.text));
    assert.match(view.text, /Older question/);
    assert.equal(question.text, 'Current question');
    assert.doesNotMatch(JSON.stringify(first), /OLD TOOL OUTPUT/);

    const call = answer([{ type: 'toolCall', id: 'z', name: 'zoom', arguments: { id: 0, n: 1 } }], 'toolUse');
    const result: ToolResultMessage = { role: 'toolResult', toolCallId: 'z', toolName: 'zoom', content: [{ type: 'text', text: 'ZOOMED' }], isError: false, timestamp: 4 };
    f.turn.messageEnd(call, f.ctx); f.turn.messageEnd(result, f.ctx);
    const second = await f.turn.context([...history, current, call, result], f.ctx, noImport);
    assert.deepEqual(second.map(m => m.role), ['system', 'user', 'assistant', 'toolResult']);
    assert.deepEqual(second[1], first[1], 'entries logged during the run do not change the view');
    assert.equal(f.working.length, 2, 'the view was settled once, not on every call');
  } finally { await f.done(); }
});

test('the new input is logged after the view snapshot, and later messages as they end', async () => {
  const f = await fixture();
  try {
    f.memory.append('talk', 'An earlier reply.');
    f.turn.start();
    f.turn.messageEnd(user('Hi there'), f.ctx);
    assert.deepEqual(f.kinds(), ['talk'], 'the input waits for the snapshot');
    const messages = await f.turn.context([], f.ctx, noImport);
    assert.deepEqual(f.kinds(), ['talk', 'user']);
    assert.match(sent(messages)[0].text, /An earlier reply/);
    assert.doesNotMatch(sent(messages)[0].text, /Hi there/, 'the view excludes the new input');

    f.turn.messageEnd(answer([{ type: 'thinking', thinking: 'PRIVATE' }, { type: 'text', text: 'Checking.' }, { type: 'toolCall', id: 'z', name: 'zoom', arguments: { id: 0, n: 1 } }], 'toolUse'), f.ctx);
    f.turn.messageEnd({ role: 'toolResult', toolCallId: 'z', toolName: 'zoom', content: [{ type: 'text', text: '0+0|talk' }], isError: false, timestamp: 4 }, f.ctx);
    f.turn.messageEnd(answer([{ type: 'text', text: 'Broken.' }], 'error'), f.ctx);
    assert.deepEqual(f.kinds(), ['talk', 'user', 'talk', 'tool', 'echo', 'talk', 'echo']);
    assert.deepEqual(f.memory.root.map(e => e.text).slice(2), ['Checking.', 'zoom {"id":0,"n":1}', 'zoom: 0+0|talk', 'Broken.', 'Agent error: No further details']);
    assert.ok(!JSON.stringify(f.memory.root).includes('PRIVATE'), 'thoughts are never logged');
  } finally { await f.done(); }
});

test('typed input is claimed from the inbox and acknowledged once it is logged', async () => {
  const f = await fixture();
  try {
    const typed = f.inbox.record('typed question');
    const withImage = f.inbox.record('look at this');
    f.turn.start();
    f.turn.messageEnd(user('typed question'), f.ctx);
    assert.equal((f.file('pending-inputs.json') as unknown[]).length, 2, 'the journal keeps the input until the log has it');
    await f.turn.context([], f.ctx, noImport);
    assert.equal(f.memory.root[0].receipt, typed);
    f.turn.messageEnd(answer([{ type: 'text', text: 'Done.' }]), f.ctx);

    f.turn.start();
    f.turn.messageEnd(user('look at this\n\n[Image: original 4000x3000, displayed at 2000x1500. Multiply coordinates by 2.00 to map to original image.]'), f.ctx);
    await f.turn.context([], f.ctx, noImport);
    assert.equal(f.memory.root.at(-1)?.receipt, withImage, "Pi's image note does not hide the typed input");

    f.turn.start();
    f.turn.messageEnd(user('sent by an extension'), f.ctx);
    await f.turn.context([], f.ctx, noImport);
    assert.ok(f.memory.root.at(-1)?.receipt, 'an input the inbox never saw is journaled and claimed too');
    assert.deepEqual(f.file('pending-inputs.json'), []);
    assert.deepEqual(f.kinds(), ['user', 'talk', 'user', 'user']);
  } finally { await f.done(); }
});

test('a report is journaled when it arrives, logged once as a user message, and dropped from the journal', async () => {
  const f = await fixture();
  try {
    f.turn.addReport('[0a1b2c3d] first report');
    f.turn.addReport('[4e5f6a7b] second report');
    assert.deepEqual(f.file('pending-reports.json'), ['[0a1b2c3d] first report', '[4e5f6a7b] second report']);
    assert.equal(f.turn.pendingReports.length, 2);

    f.turn.start();
    f.turn.messageEnd(report('[0a1b2c3d] first report'), f.ctx);
    assert.equal((f.memory.root.length), 0);
    await f.turn.context([], f.ctx, noImport);
    assert.equal(f.memory.root[0].kind, 'user');
    assert.equal(f.memory.root[0].text, '[0a1b2c3d] first report');
    assert.match(f.memory.root[0].receipt ?? '', /^report:/);
    assert.deepEqual(f.file('pending-reports.json'), ['[4e5f6a7b] second report']);
    assert.ok(!existsSync(join(f.dir, 'pending-inputs.json')), 'a report never enters the input journal');

    const crashed = new Turn(() => ({ memory: f.memory, inbox: f.inbox, dir: f.dir }));
    writeFileSync(join(f.dir, 'pending-reports.json'), JSON.stringify(['[0a1b2c3d] first report', '[4e5f6a7b] second report']));
    crashed.restore(Turn.journal(f.dir), f.dir, f.memory);
    assert.deepEqual(crashed.pendingReports, ['[4e5f6a7b] second report'], 'a report the log already has is not delivered again');
    assert.deepEqual(f.file('pending-reports.json'), ['[4e5f6a7b] second report']);

    writeFileSync(join(f.dir, 'pending-reports.json'), '{"not":"a list"}');
    assert.throws(() => Turn.journal(f.dir), /Invalid pending report journal/);
  } finally { await f.done(); }
});

test('reset clears the run, the prompt and working; a new run keeps the prompt and working; fault and reports survive both', async () => {
  const f = await fixture();
  try {
    f.turn.addReport('[0a1b2c3d] queued');
    f.turn.start(); f.turn.prompt = 'system prompt'; f.turn.agentStart();
    f.turn.messageEnd(user('First'), f.ctx);
    await f.turn.context([], f.ctx, noImport);
    f.turn.start();
    assert.equal(f.turn.prompt, 'system prompt'); assert.equal(f.turn.working, true);
    f.turn.messageEnd(user('Second'), f.ctx);
    const second = await f.turn.context([], f.ctx, noImport);
    assert.deepEqual(second.map(m => m.role), ['system', 'user'], 'a new run starts empty');
    assert.equal(sent(second)[1].text, 'Second');
    assert.match(text(second[0]), /system prompt/);

    f.turn.fail(new Error('disk full'), f.ctx);
    f.turn.reset();
    assert.equal(f.turn.prompt, ''); assert.equal(f.turn.working, false);
    assert.equal(f.turn.fault, 'disk full'); assert.deepEqual(f.turn.pendingReports, ['[0a1b2c3d] queued']);
    const before = f.memory.root.length;
    f.turn.messageEnd(user('Ignored'), f.ctx);
    f.turn.flush();
    assert.equal(f.memory.root.length, before, 'no run is open after reset');
    f.turn.startIfIdle();
    f.turn.messageEnd(user('Taken'), f.ctx);
    assert.deepEqual((await f.turn.context([], f.ctx, noImport)).map(m => m.role), ['system'], 'the fault outlives a reset');
    assert.equal(f.notices.at(-1), 'disk full');
    f.turn.restore(['[0a1b2c3d] queued'], f.dir, f.memory);
    assert.equal(f.turn.fault, undefined, 'opening a profile clears the fault');
    assert.deepEqual((await f.turn.context([], f.ctx, noImport)).map(m => m.role), ['system', 'user']);
  } finally { await f.done(); }
});

test('startIfIdle opens a run only when a profile is open and no run has started', async () => {
  const f = await fixture();
  try {
    const alone = new Turn(() => undefined);
    alone.startIfIdle();
    assert.equal(alone.messageEnd(user('No profile'), f.ctx), undefined);
    f.turn.startIfIdle();
    f.turn.messageEnd(user('One'), f.ctx);
    f.turn.startIfIdle();
    f.turn.messageEnd(user('Two'), f.ctx);
    const messages = await f.turn.context([], f.ctx, noImport);
    assert.equal(messages.filter(m => m.role === 'user').length, 2, 'the second call did not discard the first message');
    f.turn.settled(f.ctx);
    f.turn.messageEnd(user('Ignored until a run starts'), f.ctx);
    f.turn.startIfIdle();
    f.turn.messageEnd(user('Three'), f.ctx);
    assert.deepEqual(sent(await f.turn.context([], f.ctx, noImport)).map(part => part.text).slice(1), ['Three']);
    assert.deepEqual(f.kinds(), ['user', 'user', 'user']);
  } finally { await f.done(); }
});

test('a failed write sets the fault, aborts, and every later context is refused until a profile opens', async () => {
  const f = await fixture();
  try {
    f.turn.start();
    f.turn.messageEnd(user('Hello'), f.ctx);
    await f.turn.context([], f.ctx, noImport);
    await f.memory.close();
    f.turn.messageEnd(answer([{ type: 'text', text: 'Reply.' }]), f.ctx);
    assert.equal(f.aborts(), 1);
    assert.equal(f.turn.fault, 'Memory is closed.');
    assert.deepEqual(f.notices, ['Memory is closed.']);

    const refused = await f.turn.context([], f.ctx, noImport);
    assert.deepEqual(refused, [{ role: 'system', content: 'OptChat context unavailable. Stop.', timestamp: 0 }]);
    assert.equal(f.aborts(), 2);
    assert.equal(f.notices.at(-1), 'Memory is closed.');
  } finally { await f.done(); }
});

test('the context is refused without a profile and while an import runs', async () => {
  const f = await fixture();
  try {
    const none = new Turn(() => undefined);
    assert.deepEqual((await none.context([], f.ctx, noImport)).map(m => m.role), ['system']);
    assert.deepEqual(f.notices, [NEEDS_PROFILE]);
    f.turn.start(); f.turn.messageEnd(user('Hi'), f.ctx);
    assert.deepEqual((await f.turn.context([], f.ctx, dir => dir === f.dir)).map(m => m.role), ['system']);
    assert.equal(f.notices.at(-1), 'Profile is unavailable while importing.');
    assert.equal(f.aborts(), 2);
    assert.equal(f.memory.root.length, 1, 'the refused turn still logs what it received');
  } finally { await f.done(); }
});

test('Escape while Pi waits for summaries leaves no stale working message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-turn-pi-'));
  const oldHome = process.env.OPTCHAT_HOME; process.env.OPTCHAT_HOME = dir;
  const messages: (string | undefined)[] = [];
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  const watchdog = setTimeout(() => { void session?.abort(); }, 15_000);
  try {
    createProfile('fixture');
    const config = loadConfig(profilePath('fixture'));
    saveConfig(profilePath('fixture'), { ...config, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    const runtime = await fakeRuntime(dir, fakeProvider((model, context: Context, options) => {
      const reply: AssistantMessage = { ...answer([{ type: 'text', text: 'Done.' }]), api: model.api, provider: model.provider, model: model.id };
      const stream = createAssistantMessageEventStream();
      if (context.messages.some(m => m.role === 'system' && m.content === COMPACT)) {
        stream.push({ type: 'start', partial: reply });
        options?.signal?.addEventListener('abort', () => { stream.push({ type: 'error', reason: 'aborted', error: { ...reply, stopReason: 'aborted' } }); stream.end(); });
      } else queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(); });
      return stream;
    }, { model: 'fixture' }), 'fixture');
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.create(dir, join(dir, 'sessions'));
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom'] })).session;
    const ui = { ...session.extensionRunner.getUIContext(), setTitle: () => {}, setWorkingMessage: (message?: string) => { messages.push(message); } } as ExtensionUIContext;
    await session.bindExtensions({ uiContext: ui });
    await session.prompt(LONG + LONG); await session.agent.waitForIdle();
    const second = session.prompt('second');
    for (let wait = 0; wait < 300 && messages.filter(Boolean).length < 2; wait++) await sleep(10);
    assert.equal(messages.filter(Boolean).length, 2, 'the second turn is waiting for summaries');
    await session.abort(); await Promise.allSettled([second]); await session.agent.waitForIdle();
    assert.equal(messages.at(-1), undefined, `the working message was left as ${JSON.stringify(messages.at(-1))}`);
  } finally {
    clearTimeout(watchdog);
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
