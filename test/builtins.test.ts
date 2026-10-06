import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { builtinExtensions, Children, loadedBuiltins } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { emptyUsage } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';

// The MCP extension reads mcp.json, its log and OAuth tokens from Pi's agent dir: never the user's real one.
const agentDir = process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-builtins-agent-'));
const server = resolve(import.meta.dirname, 'fixtures', 'fake-mcp.mjs');
const ALL = ['mcp', 'codemode', 'tool-search'];

async function until(condition: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}

/** A main session that loads the built-in extensions the way Pi's CLI does, and the names it reports. */
async function mainBuiltins(cwd: string, settings: object, extra: ((pi: ExtensionAPI) => void)[] = []) {
  let api: ExtensionAPI | undefined;
  const settingsManager = SettingsManager.inMemory(settings);
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), settingsManager,
    extensionFactories: [...builtinExtensions(ALL), ...extra, pi => { api = pi; }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory() });
  try { return [...loadedBuiltins(api!)].sort(); } finally { session.dispose(); }
}

test('the main session reports which built-in extensions it loaded, so settings and replacements carry over', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-builtins-main-'));
  try {
    assert.deepEqual(await mainBuiltins(dir, {}), ['codemode', 'mcp', 'tool-search']);
    assert.deepEqual(await mainBuiltins(dir, { extensions: ['-builtin:mcp'] }), ['codemode', 'tool-search'], 'a built-in switched off in settings stays off');
    assert.deepEqual(await mainBuiltins(dir, {}, [pi => pi.registerCommand('mcp', { description: 'other MCP', handler: async () => {} })]), ['codemode', 'tool-search'],
      'a third-party extension that registers /mcp replaces the built-in MCP extension');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every subagent gets the main session\'s built-in extensions and can call MCP tools', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-builtins-'));
  const log = join(dir, 'servers.log');
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [server, log], exposure: 'direct' } } }));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const reports: string[] = [], warnings: string[] = [], seen = new Map<string, string[]>();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  // Every task calls the MCP tool and reports its output.
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const task = textContent(context.messages.find(m => m.role === 'user')?.content).split('Your task:\n').at(-1) ?? '';
      seen.set(task, getCurrentTools(context.messages).map(t => t.name));
      const last = context.messages.at(-1), first = !context.messages.some(m => m.role === 'assistant');
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: `${task}: ${textContent(last && 'content' in last ? last.content : '')}` }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      if (first) {
        message.content = [{ type: 'toolCall', id: `echo-${task}`, name: 'mcp__fake__echo', arguments: { text: task } }];
        message.stopReason = 'toolUse';
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message }); stream.end(); });
      return stream;
    },
  });
  const spawnChildren = (builtins: string[]) => new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async text => { reports.push(text); }, text => warnings.push(text), dir, { builtins: () => builtins, createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  const servers = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  try {
    const children = spawnChildren(await mainBuiltins(dir, {}));
    const [first] = await children.spawn([{ task: 'first' }, { task: 'second' }], dir);
    const registered = children.live(first)?.session.getAllTools().map(t => t.name) ?? [];
    assert.ok(registered.includes('codemode') && registered.includes('tool_search'), 'codemode and tool_search, which reach MCP servers that are not direct, are registered');
    await until(() => !children.active);
    assert.equal(reports.length, 1, 'one spawn, one report');
    assert.match(reports[0], /first: echo:first[\s\S]*second: echo:second/, 'both subagents called the MCP tool');
    for (const task of ['first', 'second']) assert.ok(seen.get(task)?.includes('mcp__fake__echo'), `${task} sees the MCP tool`);
    // Each subagent opens its own connection, and closes it when it ends.
    await until(() => servers().length === 4);
    assert.deepEqual(servers().map(line => line.split(' ')[0]).sort(), ['exit', 'exit', 'start', 'start']);
    await children.close();

    // With MCP switched off for the main session, subagents do not connect either.
    reports.length = 0; seen.clear(); rmSync(log, { force: true });
    const off = spawnChildren(await mainBuiltins(dir, { extensions: ['-builtin:mcp'] }));
    await off.spawn([{ task: 'offline' }], dir);
    await until(() => !off.active);
    assert.ok(!seen.get('offline')?.includes('mcp__fake__echo'));
    assert.match(reports[0], /offline: .*not found/i);
    assert.deepEqual(servers(), [], 'no MCP server process starts');
    await off.close();
    assert.deepEqual(warnings, []);
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); rmSync(join(agentDir, 'mcp.json'), { force: true }); }
});

test('a batch that fails mid-launch closes the MCP connections of the children it rolls back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-builtins-rollback-'));
  const log = join(dir, 'servers.log');
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [server, log], exposure: 'direct' } } }));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple() { throw new Error('rolled-back children never run'); },
  });
  let created = 0;
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async () => {}, () => {}, dir, { builtins: () => ALL, createSession: async options => {
      if (++created === 2) {
        // Fail only once the first child's server is up, so its connection must be closed.
        await until(() => existsSync(log));
        throw new Error('session store unavailable');
      }
      return createAgentSession({ ...options, modelRuntime: runtime });
    } });
  try {
    await assert.rejects(children.spawn([{ task: 'one' }, { task: 'two' }], dir), /session store unavailable/);
    await until(() => readFileSync(log, 'utf8').includes('exit'));
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(line => line.split(' ')[0]), ['start', 'exit']);
  } finally { await children.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); rmSync(join(agentDir, 'mcp.json'), { force: true }); }
});

test('a child whose extensions fail to start still closes its MCP connections', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-builtins-bind-'));
  const log = join(dir, 'servers.log');
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [server, log], exposure: 'direct' } } }));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple() { throw new Error('the child never runs'); },
  });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async () => {}, () => {}, dir, { builtins: () => ALL, createSession: async options => {
      const made = await createAgentSession({ ...options, modelRuntime: runtime }), bind = made.session.bindExtensions.bind(made.session);
      // Binding starts the MCP connection, then fails.
      made.session.bindExtensions = async bindings => { await bind(bindings); await until(() => existsSync(log)); throw new Error('binding failed'); };
      return made;
    } });
  try {
    await assert.rejects(children.spawn([{ task: 'one' }], dir), /binding failed/);
    await until(() => readFileSync(log, 'utf8').includes('exit'));
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(line => line.split(' ')[0]), ['start', 'exit']);
    assert.equal(children.active, false, 'the failed child holds no agent slot');
  } finally { await children.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); rmSync(join(agentDir, 'mcp.json'), { force: true }); }
});
