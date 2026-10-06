import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, lockProfile, profilePath, saveConfig } from '../src/profiles.ts';
import { fakeProvider, fakeRuntime } from './fakes.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function start(dir: string, ui: Partial<ExtensionUIContext>, bound?: string, talked = false) {
  const runtime = await fakeRuntime(dir, fakeProvider(undefined, { model: 'fixture' }), 'fixture');
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  if (bound) manager.appendCustomEntry('optchat.profile', { name: bound });
  if (talked) manager.appendMessage({ role: 'user', content: 'earlier turn', timestamp: Date.now() });
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
    resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom'] });
  const titles: string[] = [], errors: string[] = [];
  const uiContext: ExtensionUIContext = { ...session.extensionRunner.getUIContext(), setTitle: t => { titles.push(t); },
    notify: (text, type) => { if (type === 'error') errors.push(text); }, ...ui };
  await session.bindExtensions({ uiContext, mode: 'tui' });
  return { session, titles, errors, manager };
}

test('a busy profile offers Back to pick another profile, and picking another opens it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-busy-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  const sessions: Awaited<ReturnType<typeof start>>['session'][] = [];
  let unlock: (() => Promise<void>) | undefined;
  try {
    for (const name of ['busy', 'other', 'third']) {
      createProfile(name);
      const config = loadConfig(profilePath(name));
      saveConfig(profilePath(name), { ...config, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' }, subagent: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    }
    unlock = await lockProfile(profilePath('busy'), 'busy · PID 1 · elsewhere');

    // New session: pick `busy`, it's taken, choose "Back", then pick `other`.
    const asked: { title: string, options: string[] }[] = [];
    const picks = ['busy', 'Back', 'other'];
    const fresh = await start(dir, { select: async (title, options) => { asked.push({ title, options }); return picks.shift(); } });
    sessions.push(fresh.session);
    assert.deepEqual(asked.map(a => a.title.split('\n')[0]), ['OptChat profile', 'busy is open in another window', 'OptChat profile']);
    assert.match(asked[1].title, /busy · PID 1 · elsewhere/);
    assert.deepEqual(asked[1].options, ['Back']);
    assert.equal(fresh.titles[0], 'π other');
    assert.deepEqual(fresh.errors, []);
    const bound = fresh.manager.getEntries().filter(e => e.type === 'custom' && e.customType === 'optchat.profile');
    assert.deepEqual(bound.map(e => e.type === 'custom' && e.data), [{ name: 'other' }], 'the session is bound to the profile actually opened');

    // `/optchat profile` makes a fresh session already bound to its pick; a busy pick can still go Back and rebind.
    const switchedPicks = ['Back', 'third']; // `other` is held by the session above
    const switched = await start(dir, { select: async () => switchedPicks.shift() }, 'busy');
    sessions.push(switched.session);
    assert.equal(switched.titles[0], 'π third');
    assert.deepEqual(switched.errors, []);
    const rebound = switched.manager.getEntries().filter(e => e.type === 'custom' && e.customType === 'optchat.profile');
    assert.deepEqual(rebound.map(e => e.type === 'custom' && e.data), [{ name: 'busy' }, { name: 'third' }], 'the latest binding wins');

    // A resumed conversation already belongs to `busy`, so it cannot switch: opening it fails.
    const resumedAsked: string[][] = [];
    const resumed = await start(dir, { select: async (_title, options) => { resumedAsked.push(options); return undefined; } }, 'busy', true);
    sessions.push(resumed.session);
    assert.deepEqual(resumedAsked, []);
    assert.match(resumed.errors.join('\n'), /Profile already running/);
  } finally {
    for (const session of sessions) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    await unlock?.(); await sleep(50);
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
