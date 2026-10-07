import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext, type Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import optchat from '../src/index.ts';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { createProfile, defaults, loadConfig, profilePath, saveConfig, type ProfileConfig } from '../src/profiles.ts';
import { settingsPage } from '../src/settings-page.ts';
import { COMPACT } from '../src/prompts.ts';
import { REPORT_TYPE, textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { SEARCH_DOC } from '../src/tools.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));
const model = { provider: 'fixture', model: 'fixture', thinking: 'off' } as const;
const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

async function until(condition: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}
/** A provider whose first reply to a `hold …` task waits until the test releases it or the agent stops. */
async function fixture(dir: string, reply: (context: Context) => string = () => 'done') {
  const releases = new Map<string, () => void>();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(m, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: reply(context) }], api: m.api, provider: m.provider, model: m.id,
        timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      const task = textContent(context.messages.find(x => x.role === 'user')?.content).split('Your task:\n').at(-1) ?? '';
      void (async () => {
        if (task.startsWith('hold') && context.messages.filter(x => x.role === 'user').length === 1) await new Promise<void>(resolve => { releases.set(task, resolve); options?.signal?.addEventListener('abort', () => resolve(), { once: true }); });
        stream.push({ type: 'done', reason: 'stop', message }); stream.end();
      })();
      return stream;
    },
  });
  return { runtime, releases };
}
async function children(dir: string, settings?: () => Partial<ProfileConfig>) {
  const { runtime, releases } = await fixture(dir);
  const memory = new Memory(join(dir, 'memory'), async input => input.source.slice(0, 100), () => {});
  const made = new Children(memory, new ModelRegistry(runtime), () => model, () => '', async () => {}, () => {}, dir,
    { settings, createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  return { children: made, releases, close: async () => { for (const release of releases.values()) release(); await made.close(); await memory.close(); } };
}

test('a config.json from before settings existed loads with the defaults, and settings round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-config-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ compactor: defaults.compactor, subagent: defaults.subagent }));
    assert.deepEqual(loadConfig(dir), { ...defaults, subagentLevels: 1, maxAgents: 8, previousExchange: true, previousExchangeKB: 16, memorySearch: false, summaryAcceptBytes: 640 });
    const changed = { ...loadConfig(dir), subagentLevels: 3, maxAgents: 12, previousExchange: false, previousExchangeKB: 4, memorySearch: true, summaryAcceptBytes: 512 };
    saveConfig(dir, changed);
    assert.deepEqual(loadConfig(dir), changed);
    for (const [key, value] of [['subagentLevels', 0], ['maxAgents', -1], ['previousExchangeKB', 1.5], ['subagentLevels', '3'], ['previousExchange', 'yes'], ['summaryAcceptBytes', 511], ['maxAgents', null]] as const) {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...changed, [key]: value }));
      assert.throws(() => loadConfig(dir), /Invalid profile config/, `${key}: ${value}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('by default only the main agent starts subagents: a child gets no spawn or tell, nor search', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-levels-'));
  const { children: c, releases, close } = await children(dir);
  try {
    const [child] = await c.spawn([{ task: 'hold child' }], dir);
    await until(() => releases.size === 1);
    const tools = c.live(child)?.session.getActiveToolNames() ?? [];
    assert.ok(tools.includes('zoom') && !tools.includes('spawn') && !tools.includes('tell') && !tools.includes('search'));
    await assert.rejects(c.spawn([{ task: 'nested' }], dir, undefined, child), /allows 1 level of subagents/);
  } finally { await close(); rmSync(dir, { recursive: true, force: true }); }
});

test('with Memory search on, a subagent gets the search tool and its prompt line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-search-child-'));
  const { children: c, releases, close } = await children(dir, () => ({ memorySearch: true }));
  try {
    const [child] = await c.spawn([{ task: 'hold child' }], dir);
    await until(() => releases.size === 1);
    const session = c.live(child)!.session;
    assert.ok(session.getActiveToolNames().includes('search'));
    assert.ok(session.systemPrompt.includes(SEARCH_DOC.trim()));
  } finally { await close(); rmSync(dir, { recursive: true, force: true }); }
});

test('subagent levels and max active agents come from the profile, read at each spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-limits-'));
  const settings = { subagentLevels: 2, maxAgents: 3 };
  const { children: c, releases, close } = await children(dir, () => settings);
  try {
    const [child] = await c.spawn([{ task: 'hold child' }], dir);
    assert.ok(c.live(child)?.session.getActiveToolNames().includes('spawn'));
    const [grandchild] = await c.spawn([{ task: 'hold grandchild' }], dir, undefined, child);
    assert.ok(!c.live(grandchild)?.session.getActiveToolNames().includes('spawn'), 'the last level cannot delegate');
    await assert.rejects(c.spawn([{ task: 'hold too deep' }], dir, undefined, grandchild), /allows 2 levels/);
    await assert.rejects(c.spawn([{ task: 'hold a' }, { task: 'hold b' }], dir), /at most 3 active agents/);
    settings.maxAgents = 4;
    await c.spawn([{ task: 'hold a' }, { task: 'hold b' }], dir);
    assert.equal(c.ids.length, 4);
    await until(() => releases.size === 4);
  } finally { await close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a raised max active agents also applies to a subagent that was already running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-raised-'));
  let go!: () => void;
  const raised = new Promise<void>(resolve => { go = resolve; });
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(m, context) {
      const stream = createAssistantMessageEventStream();
      const delegating = textContent(context.messages.find(x => x.role === 'user')?.content).endsWith('delegate') && !context.messages.some(x => x.role === 'toolResult');
      const message: AssistantMessage = { role: 'assistant', api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(), usage: emptyUsage(),
        stopReason: delegating ? 'toolUse' : 'stop',
        content: delegating ? [{ type: 'toolCall', id: 'spawn-1', name: 'spawn', arguments: { tasks: [{ task: 'g1' }, { task: 'g2' }, { task: 'g3' }] } }] : [{ type: 'text', text: 'done' }] };
      void (async () => {
        if (delegating) await raised;
        stream.push({ type: 'done', reason: delegating ? 'toolUse' : 'stop', message }); stream.end();
      })();
      return stream;
    },
  });
  const settings = { subagentLevels: 2, maxAgents: 2 };
  const memory = new Memory(join(dir, 'memory'), async input => input.source.slice(0, 100), () => {});
  const c = new Children(memory, new ModelRegistry(runtime), () => model, () => '', async () => {}, () => {}, dir,
    { settings: () => settings, createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  try {
    const [child] = await c.spawn([{ task: 'delegate' }], dir);
    settings.maxAgents = 4;
    go();
    await until(() => !c.active);
    assert.equal([...c.history.records.values()].filter(r => r.parentId === child).length, 3, 'the child started a batch of 3, allowed by the new limit');
  } finally { await c.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the previous exchange can be turned off, and its size limit is the profile\'s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-previous-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const turns: Context[] = [];
  const { runtime } = await fixture(dir, context => {
    if (context.messages.some(m => m.role === 'system' && m.content === COMPACT)) return 'summary';
    turns.push(structuredClone(context));
    const asked = textContent(context.messages.at(-1)?.content).split('</chat>').at(-1)?.trim() ?? '';
    return asked === 'Long answer please.' ? 'x'.repeat(3000) : `Answer to: ${asked}`;
  });
  const profile = profilePath('fixture');
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  const open = async (config: Partial<ProfileConfig>) => {
    saveConfig(profile, { ...loadConfig(profile), compactor: model, ...config });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom'] })).session;
    await session.bindExtensions({});
    return session;
  };
  const close = async () => { await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session?.dispose(); session = undefined; };
  const messages = (turn: Context) => turn.messages.filter(m => m.role !== 'system').map(m => m.role);
  const continuity = (turn: Context) => JSON.stringify(turn.messages.find(m => m.role === 'system')).includes('immediately preceding completed exchange');
  try {
    createProfile('fixture');
    let s = await open({ previousExchange: false });
    await s.prompt('First.'); await s.prompt('Why?');
    assert.deepEqual(messages(turns.at(-1)!), ['user'], 'off: the follow-up sees the memory view only');
    assert.ok(!continuity(turns.at(-1)!), 'off: the prompt does not mention a replayed exchange');
    await close();
    s = await open({ previousExchange: true, previousExchangeKB: 2 });
    await s.prompt('Short answer please.'); await s.prompt('Why?');
    assert.deepEqual(messages(turns.at(-1)!), ['user', 'assistant', 'user']);
    assert.ok(continuity(turns.at(-1)!));
    await s.prompt('Long answer please.'); await s.prompt('Why?');
    assert.deepEqual(messages(turns.at(-1)!), ['user'], 'a 3 KB exchange is over a 2 KB limit');
  } finally {
    await close();
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the settings page saves a valid number and explains an invalid one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-page-'));
  try {
    const config: ProfileConfig = { ...defaults, compactor: { provider: 'anthropic', model: 'claude-haiku-4-5', thinking: 'low' } };
    const page = settingsPage(plain, { profile: 'demo', config, models: [{ name: 'anthropic/claude-sonnet-5-5', thinking: ['low', 'medium'] }], save: next => saveConfig(dir, next) }, () => {});
    const type = (...keys: string[]) => { for (const key of keys) page.handleInput(key); };
    assert.match(page.render(100).join('\n'), /Subagent levels\s+1  default\n/);
    assert.match(page.render(100).join('\n'), /claude-haiku-4-5 · low  default claude-sonnet-5-5 · medium/, 'a changed model shows its default too');
    type('\x1b[B', '\x1b[B', '\r'); // down to Subagent levels, open it
    type('0', '\r');
    assert.match(page.render(100).join('\n'), /must be a whole number of 1 or more/);
    type('\x7f', 'x', '\r');
    assert.match(page.render(100).join('\n'), /must be a whole number of 1 or more/);
    type('\x7f', '3', '\r');
    assert.equal(config.subagentLevels, 3);
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).subagentLevels, 3);
    assert.match(page.render(100).join('\n'), /Subagent levels\s+3  default 1[\s\S]*Saved subagent levels 3/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('turning Previous exchange off also reaches a turn that a subagent report starts while idle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-report-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const systems: string[] = [];
  const { runtime } = await fixture(dir, context => {
    if (context.messages.some(m => m.role === 'system' && m.content === COMPACT)) return 'summary';
    systems.push(JSON.stringify(context.messages.find(m => m.role === 'system')));
    return 'ok';
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    saveConfig(profilePath('fixture'), { ...loadConfig(profilePath('fixture')), compactor: model });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom'] })).session;
    // The settings page, driven by keys: down past Group subagent reports to Previous exchange, toggle it, close.
    const custom = (async (factory: (tui: unknown, theme: Theme, keys: unknown, done: (result: undefined) => void) => Component) => {
      let closed = false;
      const page = factory({ requestRender: () => {} }, plain, {}, () => { closed = true; });
      for (const key of ['\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', ' ', '\x1b']) page.handleInput?.(key);
      assert.ok(closed);
    }) as unknown as ExtensionUIContext['custom'];
    await session.bindExtensions({ uiContext: { ...session.extensionRunner.getUIContext(), custom }, mode: 'tui' });
    const said = 'immediately preceding completed exchange';
    await session.prompt('Hello.');
    assert.ok(systems.at(-1)!.includes(said));
    await session.prompt('/optchat settings');
    assert.equal(loadConfig(profilePath('fixture')).previousExchange, false);
    await session.sendCustomMessage({ customType: REPORT_TYPE, content: '[8964a512] Done.', display: true }, { triggerTurn: true, deliverAs: 'steer' });
    await session.agent.waitForIdle();
    assert.equal(systems.length, 2);
    assert.ok(!systems.at(-1)!.includes(said), 'the report turn reuses the built prompt, without the replay sentence');
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Memory search turned on and off in /optchat settings adds and removes the tool and its prompt line, also for a report turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-search-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const turns: Context[] = [];
  const { runtime } = await fixture(dir, context => {
    if (context.messages.some(m => m.role === 'system' && m.content === COMPACT)) return 'summary';
    turns.push(context);
    return 'ok';
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    saveConfig(profilePath('fixture'), { ...loadConfig(profilePath('fixture')), compactor: model });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'search'] })).session;
    // The settings page, driven by keys: down to Memory search, toggle it, close.
    const custom = (async (factory: (tui: unknown, theme: Theme, keys: unknown, done: (result: undefined) => void) => Component) => {
      const page = factory({ requestRender: () => {} }, plain, {}, () => {});
      for (const key of ['\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', ' ', '\x1b']) page.handleInput?.(key);
    }) as unknown as ExtensionUIContext['custom'];
    await session.bindExtensions({ uiContext: { ...session.extensionRunner.getUIContext(), custom }, mode: 'tui' });
    // Pi declares the tools on the leading system message, next to the prompt.
    const search = ({ messages: [system] }: Context) => system.role === 'system'
      ? [!!system.toolsAdded?.some(t => t.name === 'search'), JSON.stringify(system.content).includes('search(text)')] : [];
    await session.prompt('Hello.');
    assert.deepEqual(search(turns.at(-1)!), [false, false], 'off by default');
    await session.prompt('/optchat settings');
    assert.equal(loadConfig(profilePath('fixture')).memorySearch, true);
    // A report turn started while idle skips before_agent_start, and still gets the change.
    await session.sendCustomMessage({ customType: REPORT_TYPE, content: '[8964a512] Done.', display: true }, { triggerTurn: true, deliverAs: 'steer' });
    await session.agent.waitForIdle();
    assert.deepEqual(search(turns.at(-1)!), [true, true]);
    await session.prompt('/optchat settings');
    await session.prompt('Again.');
    assert.deepEqual(search(turns.at(-1)!), [false, false]);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the thinking step offers only levels the model takes, so Sonnet 5.5 has no "off" that would run at high effort', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-page-'));
  try {
    const config: ProfileConfig = { ...defaults };
    const page = settingsPage(plain, { profile: 'demo', config, save: next => saveConfig(dir, next),
      models: [{ name: 'anthropic/claude-sonnet-5-5', thinking: ['low', 'medium', 'high'] }] }, () => {});
    page.handleInput('\r'); // open Compactor model
    page.handleInput('\r'); // pick the only model
    const step = page.render(100).join('\n');
    assert.match(step, /Thinking level[\s\S]*low[\s\S]*high/);
    assert.doesNotMatch(step, /^\W*(off|minimal)\s*$/m);
    page.handleInput('\x1b[A'); page.handleInput('\r'); // up from the current "medium" to "low"
    assert.deepEqual(config.compactor, { provider: 'anthropic', model: 'claude-sonnet-5-5', thinking: 'low' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('/optchat model and /optchat agents model pick from a searchable list that scrolls, so the last model is reachable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-picker-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const { runtime } = await fixture(dir);
  const ids = Array.from({ length: 30 }, (_, i) => `model-${String(i).padStart(2, '0')}`);
  runtime.registerProvider('many', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: ids.map(id => ({ id, name: id, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 })) });
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    saveConfig(profilePath('fixture'), { ...loadConfig(profilePath('fixture')), compactor: model });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom'] })).session;
    const screens: string[] = [];
    const custom = (async (factory: (tui: unknown, theme: Theme, keys: unknown, done: (result: unknown) => void) => Component) => {
      let result: unknown;
      const picker = factory({ requestRender: () => {} }, plain, {}, value => { result = value; });
      screens.push(picker.render(100).join('\n'));
      for (const key of ['2', '9']) picker.handleInput?.(key);
      screens.push(picker.render(100).join('\n'));
      for (const key of ['\r', '\r']) picker.handleInput?.(key); // the model, then its only thinking level
      return result;
    }) as unknown as ExtensionUIContext['custom'];
    await session.bindExtensions({ uiContext: { ...session.extensionRunner.getUIContext(), custom }, mode: 'tui' });
    await session.prompt('/optchat model');
    const [full, filtered] = screens;
    assert.match(full, /fixture\/fixture\s+current/, 'the current model is marked');
    assert.ok(!full.includes('many/model-29') && full.split('\n').filter(line => line.includes('many/')).length <= 10, 'the list scrolls instead of growing past the screen');
    assert.ok(filtered.includes('many/model-29'));
    assert.deepEqual(loadConfig(profilePath('fixture')).compactor, { provider: 'many', model: 'model-29', thinking: 'off' });
    await session.prompt('/optchat agents model');
    assert.deepEqual(loadConfig(profilePath('fixture')).subagent, { provider: 'many', model: 'model-29', thinking: 'off' });
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
