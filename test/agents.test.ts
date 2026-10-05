import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children, taskDirectory } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { RunHistory } from '../src/runs.ts';
import { emptyUsage, UsageLedger } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';
import { SUBAGENT, VIEW_DOC } from '../src/prompts.ts';

// Children load installed extensions from Pi's agent dir; keep tests away from the user's real one.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));

async function until(condition: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}

test('real SDK children stream, report once per spawn, acknowledge steering, stop, and retain profile-local history/usage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-agents-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const usage = new UsageLedger(dir), reports: string[] = [], warnings: string[] = [];
  const releases = new Map<string, () => void>(), systemPrompts = new Set<string>();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      for (const m of context.messages) if (m.role === 'system') systemPrompts.add([textContent(m.content), ...Object.values('sections' in m ? m.sections ?? {} : {})].join('\n'));
      const initial = textContent(context.messages.find(m => m.role === 'user')?.content);
      const task = initial.split('Your task:\n').at(-1) ?? '';
      const guided = context.messages.some(m => m.role === 'user' && textContent(m.content) === 'Please include tests.');
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: guided ? 'Guidance received.' : `Working on ${task}` }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop',
        usage: { ...emptyUsage(), input: 100, output: 10, cacheRead: 50, totalTokens: 160, cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 } } };
      void (async () => {
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: textContent(message.content), partial: message });
        if (!guided) await new Promise<void>(resolve => {
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
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => 'Profile instructions.',
    async text => { reports.push(text); }, text => warnings.push(text), dir,
    { usage, parentSession: 'parent-session', createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  try {
    const [slow, fast, stopped] = await children.spawn([{ task: 'slow' }, { task: 'fast' }, { task: 'stop-me' }], dir);
    await until(() => releases.size === 3);
    await until(() => !!children.live(slow)?.streaming);
    assert.ok(JSON.stringify(children.messages(slow)).includes('Working on slow'));
    await children.tell(slow, 'Please include tests.');
    assert.equal(children.history.records.get(slow)?.guidance[0].state, 'queued');
    releases.get('fast')!();
    await until(() => children.history.records.get(fast)?.state === 'completed');
    await children.tell(stopped, 'This should remain undelivered.');
    await children.stop(stopped);
    await until(() => children.history.records.get(stopped)?.state === 'stopped');
    assert.equal(children.history.records.get(stopped)?.guidance[0].state, 'undelivered');
    assert.equal(reports.length, 0, 'a spawn reports only when all of its subagents finish');
    releases.get('slow')!();
    await until(() => !children.active);
    assert.equal(reports.length, 1);
    const lines = reports[0].split('\n\n');
    assert.deepEqual(lines.map(line => line.slice(1, 9)), [slow, fast, stopped]);
    assert.match(lines[0], /Guidance received/);
    assert.match(lines[1], /Working on fast/);
    assert.equal(children.history.records.get(slow)?.guidance[0].state, 'delivered');
    assert.match(children.history.records.get(slow)?.report ?? '', /Guidance received/);
    assert.ok(usage.select('This session', 'parent-session').length >= 3);
    const before = usage.entries.length;
    const restored = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '', async () => {}, text => warnings.push(text), dir, { usage, parentSession: 'new-parent' });
    assert.equal(usage.entries.length, before, 'reloading saved children must not double count usage');
    assert.ok(restored.messages(slow).some(m => m.role === 'user' && textContent(m.content) === 'Please include tests.'));
    assert.equal(restored.history.records.get(fast)?.state, 'completed');
    assert.equal(new RunHistory(join(dir, 'other-profile')).list().length, 0);
    await restored.close();

    const [first] = await children.spawn([{ task: 'first' }], dir);
    const [second] = await children.spawn([{ task: 'second' }], dir);
    await until(() => releases.has('first') && releases.has('second'));
    for (const id of [first, second]) {
      const tools = children.live(id)!.session.getActiveToolNames();
      assert.ok(tools.includes('zoom') && !tools.includes('spawn') && !tools.includes('tell'), 'subagents get zoom and date, not spawn');
    }
    await assert.rejects(children.spawn(Array.from({ length: 7 }, () => ({ task: 'too-many' })), dir), /8 active agents/);
    children.live(second)!.session.dispose = () => { throw new Error('dispose failed'); };
    releases.get('second')!();
    await until(() => reports.length === 2);
    assert.equal(reports[1], `[${second}] Working on second`, 'separate spawns report independently');
    releases.get('first')!();
    await until(() => !children.active);
    assert.equal(reports[2], `[${first}] Working on first`);
    assert.equal(systemPrompts.size, 1, 'every child call sends the same system prompt');
    const [system] = systemPrompts;
    assert.ok(system.includes(`${SUBAGENT}\n\n${VIEW_DOC}`) && system.includes('Profile instructions.'), 'the recipe preamble and the profile instructions reach the child');
    assert.deepEqual(warnings, ['Subagent cleanup failed: Error: dispose failed'], 'a failed cleanup must not drop the report');
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
  // The main chat runs elsewhere; the task names the project, whose AGENTS.md must still load.
  const project = join(dir, 'project'), home = join(dir, 'home');
  mkdirSync(project); mkdirSync(home);
  writeFileSync(join(project, 'AGENTS.md'), 'REPO_RULES');
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
    async () => {}, () => {}, dir, { createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  try {
    await assert.rejects(children.spawn([{ task: 'nowhere', cwd: join(dir, 'missing') }], home), /No such directory/);
    const [id] = await children.spawn([{ task: 'inspect tools', cwd: project }], home);
    assert.equal(children.live(id)?.info.cwd, project);
    const names = children.live(id)?.session.getAllTools().map(t => t.name) ?? [];
    assert.ok(names.includes('installed_web'), 'installed extensions reach the child');
    assert.ok(!names.includes('optchat_copy'), 'OptChat must not load inside its own children');
    await until(() => !children.active);
    assert.ok(system.includes('demo-skill'), 'skills are listed like in the main agent');
    const order = ['GLOBAL_RULES', 'REPO_RULES', 'PROFILE_RULES'].map(rule => system.lastIndexOf(rule));
    assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), 'global, then repo AGENTS.md, then profile instructions last');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(join(agentDir, 'settings.json'), { force: true }); rmSync(join(agentDir, 'AGENTS.md'), { force: true }); rmSync(join(agentDir, 'extensions'), { recursive: true, force: true }); rmSync(join(agentDir, 'skills'), { recursive: true, force: true }); }
});

test('a child can message the main agent mid-run', async () => {
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
        // Hold each child's first turn.
        const gate = first ? task : undefined;
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
    async text => { reports.push(text); }, text => warnings.push(text), dir, { createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  try {
    // Top-level child: the message reaches the main agent before the final report.
    const [top] = await children.spawn([{ task: 'asker-top' }], dir);
    await until(() => releases.has('asker-top'));
    assert.ok(children.live(top)?.session.getActiveToolNames().includes('tell_parent'));
    releases.get('asker-top')!();
    await until(() => !children.active);
    assert.deepEqual(reports, [`[${top}] Message from subagent (still running): question from asker-top`, `[${top}] asked`]);

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
    async text => { reports.push(text); }, text => warnings.push(text), dir, { createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
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
    assert.deepEqual(reports, [`[${hook}] hook done\n\n[${disposal}] disposal done`], 'one spawn, one report');
    for (const id of [hook, disposal]) assert.equal(children.history.records.get(id)?.state, 'completed');
    assert.equal(children.live(disposal), undefined, 'a failed dispose still frees the agent slot');

    assert.deepEqual(warnings.toSorted(), [
      'Subagent cleanup failed: Error: dispose failed', 'Subagent cleanup failed: Error: shutdown hook failed',
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
    async () => {}, text => warnings.push(text), dir, { createSession });
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

async function quickChildren(dir: string) {
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
  return new Children(new Memory(join(dir, 'profile'), async input => input.source.slice(0, 100), () => {}), new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async () => {}, () => {}, join(dir, 'profile'), { createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
}

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
