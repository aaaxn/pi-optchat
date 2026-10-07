import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children, STEERABLE, taskDirectory } from '../src/agents.ts';
import type { Settings } from '../src/settings.ts';
import { Memory } from '../src/memory.ts';
import { RunHistory } from '../src/runs.ts';
import { emptyUsage, UsageLedger } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';

/** These tests cover delegation below the first level, which profiles opt into with Subagent levels. */
const nested = () => ({ subagentLevels: 3, maxAgents: 8 });
/** The same, with each child reporting as soon as it finishes instead of with the rest of its spawn. */
const each = () => ({ ...nested(), groupReports: false });

// Children load installed extensions from Pi's agent dir; keep tests away from the user's real one.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));

async function until(condition: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}

test('with Group subagent reports off, real SDK children stream, deliver independently, acknowledge steering, stop, and retain profile-local history/usage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-agents-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const usage = new UsageLedger(dir), reports: string[] = [], warnings: string[] = [];
  const releases = new Map<string, () => void>();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const initial = textContent(context.messages.find(m => m.role === 'user')?.content);
      const task = initial.split('Your task:\n').at(-1) ?? '';
      const guided = context.messages.some(m => m.role === 'user' && textContent(m.content) === 'Please include tests.');
      const report = context.messages.findLast(m => m.role === 'user' && textContent(m.content).startsWith('['));
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: report ? `${task} incorporated: ${textContent(report.content)}` : guided ? 'Guidance received.' : `Working on ${task}` }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop',
        usage: { ...emptyUsage(), input: 100, output: 10, cacheRead: 50, totalTokens: 160, cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 } } };
      void (async () => {
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: textContent(message.content), partial: message });
        if (!guided && !report) await new Promise<void>(resolve => {
          const release = () => { options?.signal?.removeEventListener('abort', release); resolve(); };
          releases.set(task, release); options?.signal?.addEventListener('abort', release, { once: true });
          if (options?.signal?.aborted) release();
        });
        if (options?.signal?.aborted) { message.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: message }); }
        else stream.push({ type: 'done', reason: 'stop', message });
        stream.end();
      })();
      return stream;
    },
  });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async text => { reports.push(text); }, text => warnings.push(text), dir,
    { settings: each, usage, parentSession: 'parent-session', createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  try {
    const [slow, fast, stopped] = await children.spawn([{ task: 'slow' }, { task: 'fast' }, { task: 'stop-me' }], dir);
    await until(() => releases.size === 3);
    await until(() => !!children.live(slow)?.streaming);
    assert.ok(JSON.stringify(children.messages(slow)).includes('Working on slow'));
    await children.tell(slow, 'Please include tests.');
    assert.equal(children.history.records.get(slow)?.guidance[0].state, 'queued');
    releases.get('fast')!();
    await until(() => reports.length === 1);
    assert.match(reports[0], new RegExp(`^\\[${fast}\\]`));
    assert.equal(children.history.records.get(slow)?.state, 'running', 'fast must report before slow finishes');
    await children.tell(stopped, 'This should remain undelivered.');
    await children.stop(stopped);
    await until(() => children.history.records.get(stopped)?.state === 'stopped');
    assert.equal(children.history.records.get(stopped)?.guidance[0].state, 'undelivered');
    releases.get('slow')!();
    await until(() => !children.active);
    assert.equal(reports.length, 3);
    assert.equal(children.history.records.get(slow)?.guidance[0].state, 'delivered');
    assert.match(children.history.records.get(slow)?.report ?? '', /Guidance received/);
    assert.ok(usage.select('This session', 'parent-session').length >= 3);
    const before = usage.entries.length;
    const restored = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '', async () => {}, text => warnings.push(text), dir, { settings: nested, usage, parentSession: 'new-parent' });
    assert.equal(usage.entries.length, before, 'reloading saved children must not double count usage');
    assert.ok(restored.messages(slow).some(m => m.role === 'user' && textContent(m.content) === 'Please include tests.'));
    assert.equal(restored.history.records.get(fast)?.state, 'completed');
    assert.equal(new RunHistory(join(dir, 'other-profile')).list().length, 0);
    await restored.close();

    const [root] = await children.spawn([{ task: 'tree-root' }], dir);
    await until(() => releases.has('tree-root'));
    const [grandchild] = await children.spawn([{ task: 'grandchild' }], dir, undefined, root);
    const [great] = await children.spawn([{ task: 'great-grandchild' }], dir, undefined, grandchild);
    await until(() => releases.has('great-grandchild'));
    assert.equal(children.history.records.get(great)?.depth, 3);
    assert.ok(children.live(root)?.session.getActiveToolNames().includes('spawn'));
    assert.ok(!children.live(great)?.session.getActiveToolNames().includes('spawn'));
    await assert.rejects(children.spawn([{ task: 'too-deep' }], dir, undefined, great), /depth limit/);
    await assert.rejects(children.spawn(Array.from({ length: 6 }, () => ({ task: 'too-many' })), dir), /8 active agents/);
    releases.get('tree-root')!(); releases.get('grandchild')!();
    await until(() => children.history.records.get(root)?.state === 'waiting' && children.history.records.get(grandchild)?.state === 'waiting');
    await children.tell(root, 'Please include tests.', 'user');
    await until(() => children.history.records.get(root)?.guidance[0].state === 'delivered');
    assert.equal(children.history.records.get(great)?.state, 'running', 'guidance must wake an idle parent before its descendant completes');
    assert.ok(memory.root.some(entry => entry.kind === 'user' && entry.text.includes(`Direct guidance to subagent [${root}]`)));
    releases.get('great-grandchild')!();
    await until(() => !children.active);
    assert.equal(reports.length, 4, 'descendants report only to their immediate parent, not directly to the manager');
    assert.match(reports[3], /tree-root incorporated: .*grandchild incorporated: .*great-grandchild/);
    const tree = children.history.list().map(r => r.id), rootIndex = tree.indexOf(root);
    assert.deepEqual(tree.slice(rootIndex, rootIndex + 3), [root, grandchild, great]);

    const [stopRoot] = await children.spawn([{ task: 'stop-root' }], dir);
    const [stopChild] = await children.spawn([{ task: 'stop-child' }], dir, undefined, stopRoot);
    const [stopLeaf] = await children.spawn([{ task: 'stop-leaf' }], dir, undefined, stopChild);
    await until(() => releases.has('stop-leaf'));
    await children.stop(stopRoot);
    await until(() => !children.active);
    for (const id of [stopRoot, stopChild, stopLeaf]) assert.equal(children.history.records.get(id)?.state, 'stopped');
    assert.deepEqual(warnings, []);
  } finally { for (const release of releases.values()) release(); await children.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('one spawn\'s reports arrive together once its last child finishes, also to a parent subagent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-group-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const reports: string[] = [], counts: (number | undefined)[] = [], held: string[][] = [], releases = new Map<string, () => void>();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const task = textContent(context.messages.find(m => m.role === 'user')?.content).split('Your task:\n').at(-1) ?? '';
      const last = context.messages.at(-1), first = !context.messages.some(m => m.role === 'assistant');
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: first ? `${task} done` : `${task} heard: ${textContent(last && 'content' in last ? last.content : '')}` }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      void (async () => {
        // Each first turn waits for the test to release it (or for a stop).
        if (first) await new Promise<void>(resolve => {
          releases.set(task, resolve); options?.signal?.addEventListener('abort', () => resolve(), { once: true });
          if (options?.signal?.aborted) resolve();
        });
        stream.push({ type: 'done', reason: 'stop', message }); stream.end();
      })();
      return stream;
    },
  });
  // No groupReports given: grouping is the default. The first spawn's sessions turn it off while they open.
  const settings: Partial<Settings> = nested();
  let opening = () => { settings.groupReports = false; };
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async (text, options) => { reports.push(text); counts.push(options?.count); }, () => {}, dir, { settings: () => settings, hold: (_batch, texts) => held.push(texts), createSession: options => {
      opening(); opening = () => {};
      return createAgentSession({ ...options, modelRuntime: runtime });
    } });
  const state = (id: string) => children.history.records.get(id)?.state;
  try {
    const answer = await children.start([{ task: 'a' }, { task: 'b' }, { task: 'stopped' }], dir);
    delete settings.groupReports;
    await until(() => releases.size === 3);
    assert.match(answer, /arrive together/, 'the answer describes the mode the spawn started with');
    const [a, b, stopped] = /^Started: (.+?)\./.exec(answer)![1].split(', ');
    await children.stop(stopped);
    releases.get('a')!();
    await until(() => state(a) === 'completed' && state(stopped) === 'stopped');
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(reports, [], 'nothing is delivered while a sibling still runs');
    assert.deepEqual(held.at(-1), [`[${a}] a done`, `[${stopped}] stopped done`], 'finished reports are journaled at once, so a crash cannot lose them');
    releases.get('b')!();
    await until(() => !children.active);
    assert.deepEqual(reports, [`[${a}] a done\n\n[${b}] b done\n\n[${stopped}] stopped done`], 'one message, in spawn order');
    assert.deepEqual(counts, [3]);
    assert.deepEqual(held.at(-1), [], 'delivered, the held reports leave the journal');
    const journaled = held.length;

    const [boss] = await children.spawn([{ task: 'boss' }], dir);
    const [x, y] = await children.spawn([{ task: 'x' }, { task: 'y' }], dir, undefined, boss);
    await until(() => releases.has('boss') && releases.has('x') && releases.has('y'));
    releases.get('boss')!();
    await until(() => state(boss) === 'waiting');
    releases.get('x')!();
    await until(() => state(x) === 'completed');
    releases.get('y')!();
    await until(() => !children.active);
    assert.equal(reports.at(-1), `[${boss}] boss heard: [${x}] x done\n\n[${y}] y done`, 'the parent is woken once, with both reports');
    assert.equal(held.length, journaled, 'a parent subagent holds its children\'s reports itself; they would not outlive it');
  } finally { for (const release of releases.values()) release(); await children.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('children get the main agent\'s extensions, AGENTS.md files and skills, but never another copy of OptChat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-extensions-'));
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? '';
  const tool = (name: string) => `export default (pi) => pi.registerTool({ name: '${name}', label: '${name}', description: '${name}', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [], details: {} }) });\n`;
  mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  writeFileSync(join(agentDir, 'extensions', 'web.js'), tool('installed_web'));
  const copy = join(dir, 'optchat-copy');
  mkdirSync(join(copy, 'src'), { recursive: true });
  writeFileSync(join(copy, 'package.json'), JSON.stringify({ name: 'pi-optchat', type: 'module', pi: { extensions: ['./src/index.js'] } }));
  writeFileSync(join(copy, 'src', 'index.js'), tool('optchat_copy'));
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [copy] }));
  writeFileSync(join(dir, 'AGENTS.md'), 'REPO_RULES');
  writeFileSync(join(agentDir, 'AGENTS.md'), 'GLOBAL_RULES');
  mkdirSync(join(agentDir, 'skills', 'demo-skill'), { recursive: true });
  writeFileSync(join(agentDir, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: Demo skill.\n---\nBody');
  let system = '';
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple: (model, context) => {
      const head = context.messages.find(m => m.role === 'system');
      system = Object.values(head && 'sections' in head ? head.sections ?? {} : {}).join('\n');
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: model.api, model: model.id, provider: model.provider, stopReason: 'stop', timestamp: Date.now(), usage: emptyUsage() };
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  const children = new Children(new Memory(dir, async input => input.source.slice(0, 100), () => {}), new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => 'PROFILE_RULES',
    async () => {}, () => {}, dir, { settings: nested, createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  try {
    const [id] = await children.spawn([{ task: 'inspect tools' }], dir);
    const names = children.live(id)?.session.getAllTools().map(t => t.name) ?? [];
    assert.ok(names.includes('installed_web'), 'installed extensions reach the child');
    assert.ok(!names.includes('optchat_copy'), 'OptChat must not load inside its own children');
    await until(() => !children.active);
    assert.ok(system.includes('demo-skill'), 'skills are listed like in the main agent');
    assert.ok(system.includes(STEERABLE), 'children are told not to block steering with long commands');
    const order = ['GLOBAL_RULES', 'REPO_RULES', 'PROFILE_RULES'].map(rule => system.lastIndexOf(rule));
    assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), 'global, then repo AGENTS.md, then profile instructions last');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(join(agentDir, 'settings.json'), { force: true }); rmSync(join(agentDir, 'AGENTS.md'), { force: true }); rmSync(join(agentDir, 'extensions'), { recursive: true, force: true }); rmSync(join(agentDir, 'skills'), { recursive: true, force: true }); }
});

test('children can message their parent mid-run: the main agent, an idle parent, or a busy one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-tell-parent-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const reports: string[] = [], warnings: string[] = [], releases = new Map<string, () => void>();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const task = textContent(context.messages.find(m => m.role === 'user')?.content).split('Your task:\n').at(-1) ?? '';
      const last = context.messages.at(-1), lastText = textContent(last && 'content' in last ? last.content : '');
      const first = context.messages.filter(m => m.role === 'assistant').length === 0;
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: last?.role === 'toolResult' ? 'asked' : first ? `${task} working` : `${task} heard: ${lastText}` }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      if (first && task.startsWith('asker')) {
        message.content = [{ type: 'toolCall', id: `ask-${task}`, name: 'tell_parent', arguments: { message: `question from ${task}` } }];
        message.stopReason = 'toolUse';
      }
      void (async () => {
        stream.push({ type: 'start', partial: message });
        // Hold each child's first turn; also hold asker-idle after its tell_parent call, so the test can
        // prove the waiting parent hears the message while that child is still running.
        const gate = first ? task : last?.role === 'toolResult' && task === 'asker-idle' ? 'asker-idle-after-ask' : undefined;
        if (gate) await new Promise<void>(resolve => {
          releases.set(gate, resolve); options?.signal?.addEventListener('abort', () => resolve(), { once: true });
          if (options?.signal?.aborted) resolve();
        });
        stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
        stream.end();
      })();
      return stream;
    },
  });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async text => { reports.push(text); }, text => warnings.push(text), dir, { settings: nested, createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  const heard = (id: string, from: string) => children.messages(id).some(m => m.role === 'assistant' && textContent(m.content).includes(`heard: [${from}] Message from subagent (still running): question from`));
  try {
    // Top-level child: the message reaches the main agent before the final report.
    const [top] = await children.spawn([{ task: 'asker-top' }], dir);
    await until(() => releases.has('asker-top'));
    assert.ok(children.live(top)?.session.getActiveToolNames().includes('tell_parent'));
    releases.get('asker-top')!();
    await until(() => !children.active);
    assert.deepEqual(reports, [`[${top}] Message from subagent (still running): question from asker-top`, `[${top}] asked`]);

    // Idle parent (waiting on its child) is woken by the message.
    const [idle] = await children.spawn([{ task: 'boss-idle' }], dir);
    const [idleChild] = await children.spawn([{ task: 'asker-idle' }], dir, undefined, idle);
    await until(() => releases.has('boss-idle') && releases.has('asker-idle'));
    releases.get('boss-idle')!();
    await until(() => children.history.records.get(idle)?.state === 'waiting');
    releases.get('asker-idle')!();
    await until(() => heard(idle, idleChild));
    assert.equal(children.history.records.get(idleChild)?.state, 'running', 'the waiting parent was woken mid-run, not by the child finishing');
    assert.ok(releases.has('asker-idle-after-ask'));
    releases.get('asker-idle-after-ask')!();
    await until(() => !children.active);
    assert.equal(reports.length, 3, 'nested messages stay with the parent, not the main agent');

    // Busy parent gets the message as steering at its next tool boundary.
    const [busy] = await children.spawn([{ task: 'boss-busy' }], dir);
    const [busyChild] = await children.spawn([{ task: 'asker-busy' }], dir, undefined, busy);
    await until(() => releases.has('boss-busy') && releases.has('asker-busy'));
    releases.get('asker-busy')!();
    await until(() => children.history.records.get(busyChild)?.state !== 'running');
    releases.get('boss-busy')!();
    await until(() => !children.active);
    assert.ok(heard(busy, busyChild), 'busy parent sees the message after its current turn');
    assert.equal(reports.length, 4);
    assert.deepEqual(warnings, []);
  } finally { for (const release of releases.values()) release(); await children.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a child that fails to clean up still reports, is disposed, and frees its slot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-cleanup-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const reports: string[] = [], warnings: string[] = [], releases = new Map<string, () => void>();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const task = textContent(context.messages.find(m => m.role === 'user')?.content).split('Your task:\n').at(-1) ?? '';
      const last = context.messages.at(-1);
      const first = context.messages.filter(m => m.role === 'assistant').length === 0;
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: first ? `${task} done` : `${task} heard: ${textContent(last && 'content' in last ? last.content : '')}` }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      void (async () => {
        stream.push({ type: 'start', partial: message });
        // Hold each first turn so the test can break the child's cleanup before it finishes.
        if (first) await new Promise<void>(resolve => {
          releases.set(task, resolve); options?.signal?.addEventListener('abort', () => resolve(), { once: true });
          if (options?.signal?.aborted) resolve();
        });
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end();
      })();
      return stream;
    },
  });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async text => { reports.push(text); }, text => warnings.push(text), dir, { settings: each, createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  const breakDispose = (id: string) => {
    const session = children.live(id)!.session, dispose = session.dispose.bind(session);
    session.dispose = () => { dispose(); throw new Error('dispose failed'); };
  };
  try {
    // A throwing session_shutdown hook must not skip dispose; a throwing dispose must not drop the report.
    const [hook, disposal] = await children.spawn([{ task: 'hook' }, { task: 'disposal' }], dir);
    await until(() => releases.has('hook') && releases.has('disposal'));
    const hookSession = children.live(hook)!.session, dispose = hookSession.dispose.bind(hookSession);
    let disposed = false;
    const emit = hookSession.extensionRunner.emit.bind(hookSession.extensionRunner);
    hookSession.extensionRunner.emit = (async (event: Parameters<typeof emit>[0]) => {
      if (event.type === 'session_shutdown') throw new Error('shutdown hook failed');
      return emit(event);
    }) as typeof emit;
    hookSession.dispose = () => { disposed = true; dispose(); };
    breakDispose(disposal);
    releases.get('hook')!(); releases.get('disposal')!();
    await until(() => !children.active);
    assert.ok(disposed, 'the child is disposed even when its shutdown hook throws');
    assert.deepEqual(reports.toSorted(), [`[${disposal}] disposal done`, `[${hook}] hook done`].toSorted());
    for (const id of [hook, disposal]) assert.equal(children.history.records.get(id)?.state, 'completed');
    assert.equal(children.live(disposal), undefined, 'a failed dispose still frees the agent slot');

    // A nested child whose dispose throws still reaches its waiting parent, which then finishes.
    const [boss] = await children.spawn([{ task: 'boss' }], dir);
    const [worker] = await children.spawn([{ task: 'worker' }], dir, undefined, boss);
    await until(() => releases.has('boss') && releases.has('worker'));
    breakDispose(worker);
    releases.get('boss')!();
    await until(() => children.history.records.get(boss)?.state === 'waiting');
    releases.get('worker')!();
    await until(() => !children.active);
    assert.equal(reports.at(-1), `[${boss}] boss heard: [${worker}] worker done`);
    assert.equal(children.history.records.get(boss)?.state, 'completed');
    assert.deepEqual(warnings.toSorted(), [
      'Subagent cleanup failed: Error: dispose failed', 'Subagent cleanup failed: Error: dispose failed', 'Subagent cleanup failed: Error: shutdown hook failed',
    ]);
  } finally { for (const release of releases.values()) release(); await children.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a batch that fails mid-launch rolls back every launched child even when their cleanup throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-rollback-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const warnings: string[] = [], disposed: string[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple() { throw new Error('rolled-back children never run'); },
  });
  // The first two sessions launch with a dispose that throws; the third cannot be created.
  let created = 0;
  const createSession: typeof createAgentSession = async options => {
    if (++created % 3 === 0) throw new Error('session store unavailable');
    const made = await createAgentSession({ ...options, modelRuntime: runtime });
    const label = `session ${created}`, dispose = made.session.dispose.bind(made.session);
    made.session.dispose = () => { dispose(); disposed.push(label); throw new Error(`${label} dispose failed`); };
    return made;
  };
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async () => {}, text => warnings.push(text), dir, { settings: nested, createSession });
  try {
    await assert.rejects(children.spawn([{ task: 'one' }, { task: 'two' }, { task: 'three' }], dir), /session store unavailable/);
    assert.deepEqual(disposed, ['session 1', 'session 2'], 'a throwing dispose does not skip the remaining children');
    const records = [...children.history.records.values()];
    assert.deepEqual(records.map(r => r.task).toSorted(), ['one', 'two']);
    for (const record of records) {
      assert.equal(record.state, 'failed');
      assert.match(record.report ?? '', /^Launch failed: Error: session store unavailable/);
      assert.equal(children.live(record.id), undefined, 'a rolled-back child is no longer running');
    }
    assert.equal(children.active, false);
    assert.deepEqual(warnings, ['Subagent cleanup failed: Error: session 1 dispose failed', 'Subagent cleanup failed: Error: session 2 dispose failed']);
    // All slots are free again: a full batch is refused for its own launch error, not the profile limit.
    created = 2;
    await assert.rejects(children.spawn(Array.from({ length: 8 }, (_, i) => ({ task: `again ${i}` })), dir), /session store unavailable/);
  } finally { await children.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a child stopped before its first request ends stopped without running its task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-early-stop-'));
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  const asked: string[] = [];
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple: (model, context) => {
      asked.push(textContent(context.messages.at(-1)?.content ?? '').split('Your task:\n').at(-1) ?? '');
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: model.api, model: model.id, provider: model.provider, stopReason: 'stop', timestamp: Date.now(), usage: emptyUsage() };
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  const memory = new Memory(join(dir, 'profile'), async input => input.source.slice(0, 100), () => {});
  // The first child is stopped while its sibling is still being created, before either has been prompted.
  let children: Children | undefined, created = 0;
  children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async () => {}, () => {}, join(dir, 'profile'), { createSession: async options => {
      if (++created === 2) await children!.stop([...children!.history.records.values()].find(r => r.task === 'first')!.id);
      return createAgentSession({ ...options, modelRuntime: runtime });
    } });
  try {
    await children.spawn([{ task: 'first' }, { task: 'second' }], dir);
    await until(() => !children!.active);
    const records = [...children.history.records.values()];
    assert.equal(records.find(r => r.task === 'first')?.state, 'stopped');
    assert.equal(records.find(r => r.task === 'second')?.state, 'completed');
    assert.deepEqual(asked, ['second'], 'the stopped child never sent its task to the model');
  } finally { await children.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

/** Children whose model works on its task until aborted, and answers any later message at once. */
async function busyChildren(dir: string, reports: string[]) {
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  const asked: string[][] = [];
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const typed = context.messages.flatMap(m => m.role === 'user' ? [textContent(m.content)] : []).slice(1);
      asked.push(typed);
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: `Now doing: ${typed.at(-1)}` }], api: model.api, model: model.id, provider: model.provider, stopReason: 'stop', timestamp: Date.now(), usage: emptyUsage() };
      void (async () => {
        stream.push({ type: 'start', partial: message });
        if (!typed.length) await new Promise<void>(resolve => {
          options?.signal?.addEventListener('abort', () => resolve(), { once: true }); if (options?.signal?.aborted) resolve();
        });
        if (options?.signal?.aborted) { message.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: message }); }
        else stream.push({ type: 'done', reason: 'stop', message });
        stream.end();
      })();
      return stream;
    },
  });
  const children = new Children(new Memory(join(dir, 'profile'), async input => input.source.slice(0, 100), () => {}), new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async text => { reports.push(text); }, () => {}, join(dir, 'profile'), { settings: each, createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  return { children, asked };
}

test('interrupting a child aborts its step and continues with the queued messages; with none queued it waits for the next one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-interrupt-'));
  const reports: string[] = [];
  const { children, asked } = await busyChildren(dir, reports);
  try {
    const [guided, idle] = await children.spawn([{ task: 'guided' }, { task: 'idle' }], dir);
    await until(() => asked.length === 2);
    await children.tell(guided, 'Use the cache.', 'user');
    await children.tell(guided, 'Main agent note.');
    assert.equal(await children.interrupt(guided), 'continued');
    await until(() => reports.some(r => r.startsWith(`[${guided}]`)));
    assert.match(reports.find(r => r.startsWith(`[${guided}]`))!, /Now doing: Interrupted by the user:\n\nUse the cache\.\n\nMain agent note\./, 'the run went on with both messages');
    assert.deepEqual(asked.at(-1)?.filter(text => text.includes('Use the cache.')).length, 1, 'delivered once, not again as steering');
    const run = children.history.records.get(guided)!;
    assert.equal(run.state, 'completed');
    assert.deepEqual(run.guidance.map(g => g.state), ['delivered', 'delivered']);
    assert.equal(await children.interrupt(idle), 'paused');
    await until(() => children.history.records.get(idle)?.state === 'paused');
    await until(() => reports.some(r => r.startsWith(`[${idle}]`)));
    assert.deepEqual(reports.filter(r => r.startsWith(`[${idle}]`)), [`[${idle}] Interrupted by the user; it waits for their next message, so no report until then.`]);
    assert.ok(children.live(idle), 'still alive, not stopped');
    await children.tell(idle, 'Carry on.', 'user');
    await until(() => !children.active);
    assert.equal(children.history.records.get(idle)?.state, 'completed');
    assert.equal(reports.at(-1), `[${idle}] Now doing: Carry on.`, 'the next message resumes it');
  } finally { await children.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a message sent while an interrupt is still settling is not lost; a stop during that time wins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-interrupt-race-'));
  const reports: string[] = [];
  const { children, asked } = await busyChildren(dir, reports);
  try {
    const [late, stopped] = await children.spawn([{ task: 'late' }, { task: 'stopped' }], dir);
    await until(() => asked.length === 2);
    const interrupting = children.interrupt(late);
    await children.tell(late, 'Late.', 'user');
    assert.equal(await interrupting, 'paused');
    await until(() => children.history.records.get(late)?.state === 'completed');
    assert.equal(reports.at(-1), `[${late}] Now doing: Late.`, 'the late message resumed it');
    // Ctrl+X lands while the interrupt is clearing Pi's queue.
    await children.tell(stopped, 'Use the cache.', 'user');
    const session = children.live(stopped)!.session, clear = session.clearQueue.bind(session);
    session.clearQueue = () => { void children.stop(stopped); return clear(); };
    await children.interrupt(stopped);
    await until(() => children.history.records.get(stopped)?.state === 'stopped');
    assert.ok(!asked.flat().some(text => text.startsWith('Interrupted by the user:')), 'no turn starts after the stop');
    assert.equal(children.history.records.get(stopped)?.guidance[0].state, 'undelivered');
  } finally { await children.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the user can take their newest queued message back; the rest stays queued in order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-withdraw-'));
  const { children, asked } = await busyChildren(dir, []);
  try {
    const [id] = await children.spawn([{ task: 'busy' }], dir);
    await until(() => asked.length === 1);
    await children.tell(id, 'First.', 'user');
    await children.tell(id, 'Second.', 'user');
    await children.tell(id, 'Main agent note.');
    assert.equal(children.withdraw(id), 'Second.', "the user's newest, never the main agent's");
    assert.deepEqual(children.history.records.get(id)?.guidance.map(g => g.text), ['First.', 'Main agent note.']);
    const session = children.live(id)!.session;
    await until(() => session.getSteeringMessages().length === 2);
    assert.deepEqual(session.getSteeringMessages(), ['First.', 'Main agent note.']);
  } finally { await children.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('taking back a message whose text is queued twice keeps the queue and its records in the same order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-withdraw-twice-'));
  const { children, asked } = await busyChildren(dir, []);
  try {
    const [id] = await children.spawn([{ task: 'busy' }], dir);
    await until(() => asked.length === 1);
    await children.tell(id, 'Run tests.', 'user');
    await children.tell(id, 'Update code first.');
    await children.tell(id, 'Run tests.');
    assert.equal(children.withdraw(id), 'Run tests.');
    const session = children.live(id)!.session;
    await until(() => session.getSteeringMessages().length === 2);
    assert.deepEqual(children.history.records.get(id)?.guidance.map(g => g.text), [...session.getSteeringMessages()]);
  } finally { await children.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an interrupt right after taking a message back delivers each remaining message once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-withdraw-interrupt-'));
  const reports: string[] = [];
  const { children, asked } = await busyChildren(dir, reports);
  try {
    const [id] = await children.spawn([{ task: 'busy' }], dir);
    await until(() => asked.length === 1);
    for (const text of ['A.', 'B.', 'C.']) await children.tell(id, text, 'user');
    assert.equal(children.withdraw(id), 'C.');
    assert.equal(await children.interrupt(id), 'continued');
    await until(() => reports.length === 1);
    assert.match(reports[0], /Now doing: Interrupted by the user:\n\nA\.\n\nB\.$/);
    assert.deepEqual(asked.at(-1)?.filter(text => text.includes('B.')).length, 1, 'B arrives once, not also as steering');
  } finally { await children.close(); rmSync(dir, { recursive: true, force: true }); }
});

async function quickChildren(dir: string, memory = new Memory(join(dir, 'profile'), async input => input.source.slice(0, 100), () => {})) {
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple: model => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: model.api, model: model.id, provider: model.provider, stopReason: 'stop', timestamp: Date.now(), usage: emptyUsage() };
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  return new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async () => {}, () => {}, join(dir, 'profile'), { settings: nested, createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
}

test('close() does not wait for a spawn that is still waiting for memory to be summarized', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-close-settling-'));
  const memory = new Memory(join(dir, 'profile'), async () => { throw new Error('compactor outage'); }, () => {});
  const children = await quickChildren(dir, memory);
  try {
    memory.append('user', 'large message '.repeat(100));
    const refused = assert.rejects(children.spawn([{ task: 'quick' }], dir), /Memory wait cancelled/);
    await until(() => children.active);
    const closed = await Promise.race([children.close().then(() => true), new Promise<boolean>(resolve => { setTimeout(resolve, 2000, false).unref(); })]);
    assert.ok(closed, 'close() is still waiting for the spawn');
    await memory.close();
    await refused;
  } finally { await memory.close(); await children.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a task cwd may start with ~ or be relative to the spawning agent; a missing one is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-cwd-'));
  const oldHome = process.env.HOME;
  mkdirSync(join(dir, 'home', 'project'), { recursive: true });
  mkdirSync(join(dir, 'main', 'sub'), { recursive: true });
  const children = await quickChildren(dir);
  try {
    process.env.HOME = join(dir, 'home');
    const [home, relative] = await children.spawn([{ task: 'home', cwd: '~/project' }, { task: 'relative', cwd: 'sub' }], join(dir, 'main'));
    assert.equal(children.live(home)?.info.cwd, join(dir, 'home', 'project'));
    assert.equal(children.live(relative)?.info.cwd, join(dir, 'main', 'sub'));
    await assert.rejects(children.spawn([{ task: 'typo', cwd: '~/projcet' }], join(dir, 'main')), /No such directory/);
    await until(() => !children.active);
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await children.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('a broken package.json above an installed extension does not block spawning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-manifest-'));
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? '';
  mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  writeFileSync(join(agentDir, 'extensions', 'web.js'), `export default (pi) => pi.registerTool({ name: 'installed_web', label: 'w', description: 'w', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [], details: {} }) });\n`);
  writeFileSync(join(agentDir, 'package.json'), '{ "name": "half-written",');
  const children = await quickChildren(dir);
  try {
    const [id] = await children.spawn([{ task: 'inspect tools' }], dir);
    assert.ok(children.live(id)?.session.getAllTools().some(t => t.name === 'installed_web'));
    await until(() => !children.active);
  } finally {
    await children.close(); rmSync(dir, { recursive: true, force: true });
    rmSync(join(agentDir, 'package.json'), { force: true }); rmSync(join(agentDir, 'extensions'), { recursive: true, force: true });
  }
});

test('a ~\\ task cwd is the home directory on Windows only', () => {
  assert.equal(taskDirectory('/base', '~\\project', true), resolve('/base', `${homedir()}\\project`));
  assert.equal(taskDirectory('/base', '~\\project', false), resolve('/base', '~\\project'), 'a POSIX backslash is a literal character');
  assert.equal(taskDirectory('/base', '~/project', false), join(homedir(), 'project'));
});
