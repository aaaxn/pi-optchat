import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type UserMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { buildContext, textContent } from '../src/transcript.ts';
import { COMPACT } from '../src/prompts.ts';
import { emptyUsage } from '../src/usage.ts';

const user = (content: UserMessage['content']): UserMessage => ({ role: 'user', content, timestamp: 1 });
const answer = (text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => ({
  role: 'assistant', content: [{ type: 'text', text }], timestamp: 2, stopReason,
  api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: emptyUsage(),
});
test('context holds the view and the current run only, never an earlier exchange', () => {
  const toolResult: AgentMessage = { role: 'toolResult', toolCallId: 'read', toolName: 'read',
    content: [{ type: 'text', text: 'OLD TOOL OUTPUT' }], isError: false, timestamp: 1 };
  const history = [user('Older question'), answer('Older answer'), toolResult, answer('Second option. ' + 'Detail. '.repeat(70))];
  const current = user('Why is that?');
  const thinking = answer('Working on the follow-up.');
  thinking.content.unshift({ type: 'thinking', thinking: 'CURRENT REASONING' });
  const context = buildContext([...history, current, thinking], [current, thinking], '<chat>\nsummary\n</chat>', 'instructions');
  assert.deepEqual(context.map(m => m.role), ['system', 'user', 'assistant']);
  assert.ok(context[1].role === 'user');
  assert.equal(textContent(context[1].content), '<chat>\nsummary\n</chat>\nWhy is that?');
  assert.equal(context.at(-1), thinking);
  assert.doesNotMatch(JSON.stringify(context), /OLD TOOL OUTPUT|Older question|Older answer|Second option/);
  assert.throws(() => buildContext(history, [], 'view', 'prompt'), /no current user message/);
});

test('real Pi lifecycle starts every turn from the view alone, across tool calls, steering, and resume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-context-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const captured: Context[] = [];
  const errors: string[] = [];
  let notifySteeringStarted!: () => void;
  let releaseSteering!: () => void;
  const steeringStarted = new Promise<void>(resolve => { notifySteeringStarted = resolve; });
  const steeringRelease = new Promise<void>(resolve => { releaseSteering = resolve; });
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    const config = loadConfig(profilePath('fixture'));
    saveConfig(profilePath('fixture'), { ...config, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
      modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model, context) {
        const compression = context.messages.some(m => m.role === 'system' && m.content === COMPACT);
        const snapshot = structuredClone(context);
        snapshot.messages = snapshot.messages.filter(m => m.role !== 'system');
        if (!compression) captured.push(snapshot);
        const latest = context.messages.at(-1);
        const text = textContent(latest?.content).split('</chat>').at(-1)!.trim();
        const reply = answer(compression ? 'Summary of fixture exchanges.' : latest?.role === 'toolResult' ? 'Because Append preserves existing summaries.' : `Answer to: ${text}`);
        reply.api = model.api; reply.provider = model.provider; reply.model = model.id;
        if (text === 'Why is that?') {
          reply.stopReason = 'toolUse';
          reply.content = [{ type: 'toolCall', id: 'zoom-1', name: 'zoom', arguments: { id: 0, n: 1 } }];
        }
        const stream = createAssistantMessageEventStream();
        void (async () => {
          if (text === 'Task with constraints.') {
            stream.push({ type: 'start', partial: reply });
            notifySteeringStarted();
            await steeringRelease;
          }
          if (text === 'Fail now.') {
            reply.stopReason = 'error'; reply.errorMessage = 'Synthetic failure';
            stream.push({ type: 'error', reason: 'error', error: reply });
          } else stream.push({ type: 'done', reason: reply.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: reply });
          stream.end();
        })();
        return stream;
      },
    });
    const marker = (pi: Parameters<typeof optchat>[0]) => {
      pi.on('agent_before_settle', event => ({ entries: [...event.entries, { type: 'custom', customType: 'marker' }] }));
    };
    const open = async (manager: SessionManager) => {
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
        noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [marker, optchat] });
      await loader.reload();
      const created = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
        resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date'] });
      session = created.session;
      await session.bindExtensions({ onError: error => errors.push(error.error) });
      return session;
    };
    const close = async () => {
      if (!session) return;
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose(); session = undefined;
    };
    const manager = SessionManager.create(dir, join(dir, 'sessions'));
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    let active = await open(manager);
    await active.prompt('Should I append?');
    assert.equal(captured[0].messages.length, 1);
    await active.prompt('Why is that?');
    const followUp = captured[1].messages;
    assert.deepEqual(followUp.map(m => m.role), ['user'], 'a new turn carries no earlier exchange');
    assert.deepEqual(captured[2].messages[0], followUp[0], 'the view must stay frozen during tools');
    assert.ok(captured[2].messages.some(m => m.role === 'toolResult'));
    await active.prompt('Okay.');
    assert.deepEqual(captured[3].messages.map(m => m.role), ['user']);
    const saved = manager.getSessionFile(); assert.ok(saved);
    await close();
    active = await open(SessionManager.open(saved));
    await active.prompt('Explain that answer.');
    assert.deepEqual(captured[4].messages.map(m => m.role), ['user'], 'resume must not replay the session transcript');
    const steered = active.prompt('Task with constraints.');
    await steeringStarted;
    await active.steer('Also include tests.');
    releaseSteering();
    await steered;
    const duringSteering = captured.find(c => textContent(c.messages.at(-1)?.content) === 'Also include tests.')!.messages;
    assert.deepEqual(duringSteering.map(m => m.role), ['user', 'assistant', 'user'], 'steering stays within its own run');
    assert.ok(textContent(duringSteering[0].content).endsWith('Task with constraints.'));
    await close();
    active = await open(SessionManager.open(saved));
    await active.prompt('Check constraints.');
    assert.deepEqual(captured.at(-1)!.messages.map(m => m.role), ['user']);
    await active.prompt('Fail now.');
    assert.equal(active.messages.findLast(m => m.role === 'assistant')?.stopReason, 'error');
    await close();
    active = await open(SessionManager.open(saved));
    await active.prompt('Retry follow-up.');
    assert.deepEqual(captured.at(-1)!.messages.map(m => m.role), ['user']);
    await close();
    const fresh = SessionManager.inMemory(dir);
    fresh.appendCustomEntry('optchat.profile', { name: 'fixture' });
    active = await open(fresh);
    await active.prompt('Fresh session.');
    assert.equal(captured.at(-1)!.messages.length, 1);
    const main = join(dir, 'profiles', 'fixture', 'main');
    const log = readdirSync(main).flatMap(file => readFileSync(join(main, file), 'utf8').trim().split('\n'));
    assert.equal(log.length, 23, 'only actual requests, replies, one failure, and tool activity should be logged');
    assert.deepEqual(errors, []);
    await active.prompt('Large paste: ' + 'z'.repeat(2_100_000));
    assert.equal(fresh.getBranch().filter(e => e.type === 'compaction').length, 1, 'a large in-process transcript is dropped');
    assert.ok(active.messages.length <= 2);
    await active.prompt('After rotation.');
    assert.deepEqual(captured.at(-1)!.messages.map(m => m.role), ['user']);
    assert.match(textContent(captured.at(-1)!.messages[0].content), /After rotation\.$/);
    assert.equal(fresh.getBranch().filter(e => e.type === 'compaction').length, 1, 'a small transcript is kept');
    assert.equal(fresh.getBranch().filter(e => e.type === 'custom' && e.customType === 'marker').length, 3, 'other extensions keep their settle entries');
    assert.deepEqual(errors, []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a skill command is logged once, as its expansion, and never recovered as an unanswered input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-skill-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    const config = loadConfig(profilePath('fixture'));
    saveConfig(profilePath('fixture'), { ...config, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    mkdirSync(join(dir, 'skills', 'demo'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo skill.\n---\n\nFollow the demo steps.\n');
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
      modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model) {
        const reply = answer('Done.'); reply.api = model.api; reply.provider = model.provider; reply.model = model.id;
        const stream = createAssistantMessageEventStream();
        void (async () => { stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(); })();
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true,
      noSkills: true, additionalSkillPaths: [join(dir, 'skills')], noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.create(dir, join(dir, 'sessions'));
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date'] })).session;
    await session.bindExtensions({});
    await session.prompt('/skill:demo   Do the task. ');
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose(); session = undefined;
    const main = join(dir, 'profiles', 'fixture', 'main');
    const log = readdirSync(main).flatMap(file => readFileSync(join(main, file), 'utf8').trim().split('\n')).map(line => JSON.parse(line));
    assert.deepEqual(log.map(entry => entry.kind), ['user', 'talk']);
    assert.match(log[0].text, /^<skill name="demo"[\s\S]*Follow the demo steps\.[\s\S]*Do the task\.$/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'profiles', 'fixture', 'pending-inputs.json'), 'utf8')), []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main agent keeps Pi\'s AGENTS.md files and skills, with profile instructions last', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-prompt-'));
  const agentDir = join(dir, 'agent');
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    const profile = profilePath('fixture');
    saveConfig(profile, { ...loadConfig(profile), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    writeFileSync(join(profile, 'AGENTS.md'), 'PROFILE_RULES');
    mkdirSync(join(agentDir, 'skills', 'demo-skill'), { recursive: true });
    writeFileSync(join(agentDir, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: Demo skill.\n---\nBody');
    writeFileSync(join(agentDir, 'AGENTS.md'), 'GLOBAL_RULES');
    writeFileSync(join(dir, 'AGENTS.md'), 'REPO_RULES');
    const systems: string[] = [];
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
      modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model, context) {
        const system = textContent(context.messages.find(m => m.role === 'system')?.content);
        if (system !== COMPACT) systems.push(system);
        const reply = answer(system === COMPACT ? 'Summary.' : 'Done.');
        reply.api = model.api; reply.provider = model.provider; reply.model = model.id;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(); });
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager, noExtensions: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date', 'read'] })).session;
    await session.bindExtensions({});
    await session.prompt('Hello.');
    const system = systems.at(-1) ?? '';
    assert.ok(system.includes('demo-skill'), 'skills are listed');
    const order = ['GLOBAL_RULES', 'REPO_RULES', 'PROFILE_RULES'].map(rule => system.indexOf(rule));
    assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), 'global, then repo AGENTS.md, then profile instructions last');
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
