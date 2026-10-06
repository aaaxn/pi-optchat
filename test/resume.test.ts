import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, type AgentSession } from '@earendil-works/pi-coding-agent';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { emptyUsage } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';
import { fakeProvider, fakeRuntime, makeChildren } from './fakes.ts';

async function until(condition: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}

/**
 * A synthetic model whose replies show what the child remembers: its first reply is "<task> first report";
 * later replies quote that first reply, so they prove the earlier conversation is back in context.
 * "resume <id>" makes it call tell on that child. Tasks starting with "hold" or "boss" wait for a release on their first turn.
 */
async function setup(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const releases = new Map<string, () => void>();
  const hooks: { beforeSession?: () => Promise<void>; opened?: (session: AgentSession) => void } = {};
  const runtime = await fakeRuntime(dir, fakeProvider((model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const task = textContent(context.messages.find(m => m.role === 'user')?.content).split('Your task:\n').at(-1) ?? '';
    const answers = context.messages.filter(m => m.role === 'assistant');
    const last = context.messages.at(-1), lastText = textContent(last && 'content' in last ? last.content : '');
    const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: '' }], api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
    if (last?.role === 'user' && lastText.startsWith('resume ')) {
      message.content = [{ type: 'toolCall', id: `call-${answers.length}`, name: 'tell', arguments: { id: lastText.slice(7), message: `${task} wants more` } }];
      message.stopReason = 'toolUse';
    } else message.content = [{ type: 'text', text: last?.role === 'toolResult' ? `asked: ${lastText}`
      : answers.length === 0 ? `${task} first report` : `${task} resumed after "${textContent(answers[0].content)}" heard: ${lastText}` }];
    void (async () => {
      stream.push({ type: 'start', partial: message });
      if (answers.length === 0 && /^(hold|boss)/.test(task)) await new Promise<void>(resolve => {
        releases.set(task, resolve); options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        if (options?.signal?.aborted) resolve();
      });
      if (options?.signal?.aborted) { message.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: message }); }
      else stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
      stream.end();
    })();
    return stream;
  }));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const reports: string[] = [], warnings: string[] = [];
  const make = (parentSession: string) => makeChildren({ memory, runtime, dir, report: async text => { reports.push(text); }, warn: text => warnings.push(text), parentSession, createSession: async options => {
      await hooks.beforeSession?.();
      const created = await createAgentSession({ ...options, modelRuntime: runtime });
      hooks.opened?.(created.session);
      return created;
    } });
  const cleanup = async (...all: Children[]) => {
    for (const release of releases.values()) release();
    for (const children of all) await children.close();
    await memory.close(); rmSync(dir, { recursive: true, force: true });
  };
  return { dir, releases, hooks, reports, warnings, make, cleanup };
}

const users = (children: Children, id: string) => children.messages(id).filter(m => m.role === 'user').map(m => textContent(m.content));

test('tell resumes a finished child with its earlier conversation, also from an earlier Pi session', async () => {
  const { dir, reports, warnings, make, cleanup } = await setup('optchat-resume-');
  const children = make('first-session');
  let later: Children | undefined;
  try {
    const [id] = await children.spawn([{ task: 'remember' }], dir);
    await until(() => !children.active);
    assert.deepEqual(reports, [`[${id}] remember first report`]);
    const before = structuredClone(children.history.records.get(id)!);

    assert.match(await children.tell(id, 'one more thing'), new RegExp(`^${id} had finished, so I resumed it`));
    const resumed = children.live(id);
    assert.ok(resumed, 'the resumed child is running again and takes a slot');
    assert.ok(children.ids.includes(id));
    assert.equal(children.history.records.get(id)?.state, 'running');
    await until(() => !children.active);
    assert.equal(reports[1], `[${id}] remember resumed after "remember first report" heard: one more thing`);
    const after = children.history.records.get(id)!;
    assert.equal(after.state, 'completed');
    assert.equal(after.report, 'remember resumed after "remember first report" heard: one more thing');
    for (const key of ['id', 'task', 'cwd', 'model', 'sessionFile'] as const) assert.equal(after[key], before[key]);
    assert.deepEqual(after.guidance.map(g => [g.text, g.state, g.from]), [['one more thing', 'delivered', 'manager']]);
    assert.equal(users(children, id).length, 2, 'one transcript holds both runs');
    assert.match(readFileSync(after.sessionFile!, 'utf8'), /one more thing/);

    // A new Pi session only has the run record and transcript on disk.
    await children.close();
    later = make('second-session');
    assert.equal(later.history.records.get(id)?.state, 'completed');
    await later.tell(id, 'and once more');
    await until(() => !later!.active);
    assert.equal(reports[2], `[${id}] remember resumed after "remember first report" heard: and once more`);
    assert.equal(later.history.records.get(id)?.parentSession, 'second-session', 'usage of the new turns belongs to the session that resumed it');
    assert.deepEqual(users(later, id).slice(1), ['one more thing', 'and once more']);
    assert.deepEqual(warnings, []);
  } finally { await cleanup(children, ...(later ? [later] : [])); }
});

test('resuming refuses missing or broken transcripts and a full profile', async () => {
  const { dir, releases, make, cleanup } = await setup('optchat-resume-errors-');
  const children = make('session');
  try {
    await assert.rejects(children.tell('nobody', 'hello'), /No running subagent nobody/);

    const [gone, broken, full] = await children.spawn([{ task: 'gone' }, { task: 'broken' }, { task: 'full' }], dir);
    await until(() => !children.active);
    await assert.rejects(children.tell(full, '   '), /Message is empty/);
    rmSync(children.history.records.get(gone)!.sessionFile!);
    await assert.rejects(children.tell(gone, 'hello'), /transcript of .* is missing or unreadable.*Spawn a fresh subagent/);
    writeFileSync(children.history.records.get(broken)!.sessionFile!, 'not a session\n');
    await assert.rejects(children.tell(broken, 'hello'), /missing or unreadable/);
    assert.equal(readFileSync(children.history.records.get(broken)!.sessionFile!, 'utf8'), 'not a session\n', 'a refused resume does not touch the transcript');
    assert.equal(children.history.records.get(broken)?.state, 'completed', 'a refused resume leaves the record alone');

    await children.spawn(Array.from({ length: 8 }, (_, i) => ({ task: `hold ${i}` })), dir);
    await until(() => releases.size === 8);
    await assert.rejects(children.tell(full, 'hello'), /at most 8 active agents/);
    assert.equal(children.live(full), undefined);
    assert.equal(children.history.records.get(full)?.state, 'completed');
    for (const release of releases.values()) release();
    await until(() => !children.active);
    await children.tell(full, 'now there is room');
    await until(() => !children.active);
    assert.equal(children.history.records.get(full)?.report, 'full resumed after "full first report" heard: now there is room');
  } finally { await cleanup(children); }
});

test('a child resumed while the profile closes does not start', async () => {
  const { dir, hooks, make, cleanup } = await setup('optchat-resume-cancel-');
  const children = make('session');
  try {
    // The profile closes while the child's session is being opened: the child must not start.
    const [solo] = await children.spawn([{ task: 'solo' }], dir);
    await until(() => !children.active);
    let opening!: () => void, opened!: () => void;
    const started = new Promise<void>(resolve => { opening = resolve; });
    hooks.beforeSession = () => { opening(); return new Promise<void>(resolve => { opened = resolve; }); };
    let disposed = 0;
    hooks.opened = session => { const dispose = session.dispose.bind(session); session.dispose = () => { disposed++; dispose(); }; };
    const resume = children.tell(solo, 'more');
    await started;
    const closing = children.close();
    hooks.beforeSession = undefined; opened();
    await assert.rejects(resume, /Profile is closing/);
    await closing;
    assert.equal(children.live(solo), undefined);
    assert.equal(children.history.records.get(solo)?.state, 'completed');
    assert.equal(users(children, solo).length, 1, 'the cancelled child never got the message');
    assert.equal(disposed, 1, 'the opened session is closed');
  } finally { await cleanup(children); }
});

test('a resume being opened holds its slot and refuses a second resume of the same child', async () => {
  const { dir, hooks, reports, make, cleanup } = await setup('optchat-resume-race-');
  const children = make('session');
  try {
    const [solo] = await children.spawn([{ task: 'solo' }], dir);
    await until(() => !children.active);
    let opening!: () => void, opened!: () => void;
    const started = new Promise<void>(resolve => { opening = resolve; });
    // Only the first open blocks, so a second resume that slips past the guard would go ahead and fail the test.
    hooks.beforeSession = () => { hooks.beforeSession = undefined; opening(); return new Promise<void>(resolve => { opened = resolve; }); };
    const resume = children.tell(solo, 'more');
    await started;
    await assert.rejects(children.tell(solo, 'again'), /still finishing/, 'a second resume waits for the first');
    await assert.rejects(children.spawn(Array.from({ length: 8 }, (_, i) => ({ task: `extra ${i}` })), dir), /at most 8 active agents/, 'the opening resume holds a slot');
    opened();
    assert.match(await resume, /had finished, so I resumed it/);
    await until(() => !children.active);
    assert.equal(reports.at(-1), `[${solo}] solo resumed after "solo first report" heard: more`);
  } finally { await cleanup(children); }
});

test('a resume whose record cannot be saved leaves the child finished and resumable', async () => {
  const { dir, hooks, reports, make, cleanup } = await setup('optchat-resume-save-');
  const children = make('session');
  try {
    // Saving the resumed record fails: nothing changes, the session is closed, and a later resume works.
    const [solo] = await children.spawn([{ task: 'solo' }], dir);
    await until(() => !children.active);
    const save = children.history.save.bind(children.history);
    children.history.save = () => { throw new Error('disk full'); };
    let disposed = 0;
    hooks.opened = session => { const dispose = session.dispose.bind(session); session.dispose = () => { disposed++; dispose(); }; };
    await assert.rejects(children.tell(solo, 'more'), /disk full/);
    children.history.save = save; hooks.opened = undefined;
    assert.equal(disposed, 1, 'the opened session is closed');
    assert.equal(children.live(solo), undefined);
    const record = children.history.records.get(solo)!;
    assert.equal(record.state, 'completed');
    assert.equal(typeof record.ended, 'number');
    assert.deepEqual(record.guidance, []);
    assert.equal(children.active, false, 'the slot is free again');
    await children.tell(solo, 'after recovery');
    await until(() => !children.active);
    assert.equal(reports.at(-1), `[${solo}] solo resumed after "solo first report" heard: after recovery`);
  } finally { await cleanup(children); }
});
