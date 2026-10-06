import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeProvider, fakeRuntime } from './fakes.ts';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { mainTitle, TabTitle } from '../src/title.ts';
import { COMPACT } from '../src/prompts.ts';
import { emptyUsage } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out'); await sleep(10); }
}

test('tab titles show the profile, whether the agent is working, and running subagents', () => {
  assert.equal(mainTitle('personal', false, 0), 'π personal');
  assert.equal(mainTitle('personal', true, 0), '● π personal');
  assert.equal(mainTitle('personal', true, 1), '● π personal · 1 agent');
  assert.equal(mainTitle('work', false, 2), 'π work · 2 agents');
});

test('the last title is re-applied after Pi overwrites it, and a stale ctx is ignored', () => {
  const written: string[] = [];
  const title = new TabTitle();
  title.reapply();
  assert.equal(written.length, 0, 'nothing to restore before a title was set');
  title.show(t => written.push(t), 'π work');
  title.show(t => written.push(t), 'π work');
  assert.deepEqual(written, ['π work'], 'unchanged titles are not rewritten');
  title.reapply();
  assert.deepEqual(written, ['π work', 'π work']);
  title.show(() => { throw new Error('This extension ctx is stale'); }, '● π work');
  title.reapply();
  title.clear(); title.reapply();
  assert.deepEqual(written, ['π work', 'π work']);
});

test('the main window title follows the real Pi session: profile, working, running subagents, and restored after renames', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-title-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  let notifyHeld!: () => void, release!: () => void, releaseChild!: () => void;
  const childReleased = new Promise<void>(resolve => { releaseChild = resolve; });
  const held = new Promise<void>(resolve => { notifyHeld = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    const config = loadConfig(profilePath('fixture'));
    saveConfig(profilePath('fixture'), { ...config, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' }, subagent: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    const runtime = await fakeRuntime(dir, fakeProvider((model, context) => {
      const compression = context.messages.some(m => m.role === 'system' && m.content === COMPACT);
      const last = context.messages.at(-1);
      const text = textContent(last?.content);
      const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: compression ? 'Summary.' : 'Done.' }],
        timestamp: Date.now(), stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, usage: emptyUsage() };
      if (!compression && last?.role === 'user' && text.endsWith('Spawn one.')) {
        reply.stopReason = 'toolUse';
        reply.content = [{ type: 'toolCall', id: 'spawn-1', name: 'spawn', arguments: { tasks: [{ task: 'child task' }] } }];
      }
      const stream = createAssistantMessageEventStream();
      void (async () => {
        if (!compression && text.endsWith('Long task.')) { stream.push({ type: 'start', partial: reply }); notifyHeld(); await released; }
        if (!compression && text.endsWith('child task')) { stream.push({ type: 'start', partial: reply }); await childReleased; }
        stream.push({ type: 'done', reason: reply.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: reply });
        stream.end();
      })();
      return stream;
    }, { model: 'fixture' }), 'fixture');
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.create(dir, join(dir, 'sessions'));
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date', 'spawn'] })).session;
    const titles: string[] = [];
    const uiContext: ExtensionUIContext = { ...session.extensionRunner.getUIContext(), setTitle: title => { titles.push(title); } };
    await session.bindExtensions({ uiContext });

    assert.equal(titles[0], 'π fixture');
    await sleep(300); // Interactive Pi writes its own "π - <cwd>" title right after session_start; ours follows.
    assert.ok(titles.length >= 3 && titles.every((t): boolean => t === 'π fixture'), JSON.stringify(titles));

    const running = session.prompt('Long task.');
    await held;
    assert.equal(titles.at(-1), '● π fixture');
    release(); await running; await session.agent.waitForIdle();
    await until(() => titles.at(-1) === 'π fixture');

    const before = titles.length;
    session.setSessionName('renamed'); // Pi retitles the tab on renames.
    await until(() => titles.length > before);
    assert.equal(titles.at(-1), 'π fixture');

    await session.prompt('Spawn one.');
    await session.agent.waitForIdle();
    assert.ok(titles.includes('● π fixture · 1 agent'), JSON.stringify(titles));
    await until(() => titles.at(-1) === 'π fixture · 1 agent');
    releaseChild();
    await until(() => titles.at(-1) === 'π fixture' && titles.includes('● π fixture') && titles.lastIndexOf('● π fixture') > titles.indexOf('π fixture · 1 agent'));
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
