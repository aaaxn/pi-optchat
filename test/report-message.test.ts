import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, CustomMessageComponent, DefaultResourceLoader, initTheme, SessionManager, SettingsManager,
  UserMessageComponent, type ExtensionAPI, type MessageRenderer } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { registerReportRenderer, reportParts } from '../src/report-message.ts';
import { REPORT_TYPE, textContent } from '../src/transcript.ts';
import { COMPACT } from '../src/prompts.ts';
import { emptyUsage } from '../src/usage.ts';
import { fakeProvider, fakeRuntime } from './fakes.ts';

initTheme('dark', false);
const plain = (lines: string[]) => lines.join('\n').replace(/\x1b\[[0-9;:]*[A-Za-z]|\x1b[\]_][^\x07\x1b]*(\x07|\x1b\\)/g, '');
const backgrounds = (lines: string[]) => new Set(lines.join('').match(/\x1b\[48;[0-9;]+m/g) ?? []);

test('subagent messages render as a dark labelled box, never in the user-message colour', () => {
  assert.deepEqual(reportParts('[8964a512] Message from subagent (still running): step 1 done'), { label: 'subagent 8964a512 · still running', body: 'step 1 done' });
  assert.deepEqual(reportParts('[8964a512] All done.'), { label: 'subagent 8964a512 · report', body: 'All done.' });
  assert.deepEqual(reportParts('no id'), { label: 'subagent', body: 'no id' });
  let renderer: MessageRenderer | undefined;
  registerReportRenderer({ registerMessageRenderer: (_type: string, r: MessageRenderer) => { renderer = r; } } as unknown as ExtensionAPI);
  const message = { role: 'custom' as const, customType: REPORT_TYPE, content: '[8964a512] Message from subagent (still running): **step 1** done', display: true, timestamp: 1 };
  const lines = new CustomMessageComponent(message, renderer).render(80);
  const text = plain(lines);
  assert.match(text, /↳ subagent 8964a512 · still running/);
  assert.match(text, /step 1 done/);
  assert.doesNotMatch(text, /\[8964a512\]|\[optchat-report\]/);
  const userBg = backgrounds(new UserMessageComponent('typed by you').render(80));
  const reportBg = backgrounds(lines);
  assert.ok(reportBg.size > 0, 'the report has its own background');
  for (const bg of userBg) assert.ok(!reportBg.has(bg), 'the report must not use the user-message background');
});

test('a report reaches an idle or busy main agent as a user message to the model and memory, with the same system prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-report-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const captured: Context[] = [];
  const systems: string[] = [];
  let notifyHeld!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { notifyHeld = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    const config = loadConfig(profilePath('fixture'));
    saveConfig(profilePath('fixture'), { ...config, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    const runtime = await fakeRuntime(dir, fakeProvider((model, context) => {
      const compression = context.messages.some(m => m.role === 'system' && m.content === COMPACT);
      const text = textContent(context.messages.at(-1)?.content);
      if (!compression) {
        const snapshot = structuredClone(context);
        systems.push(textContent(snapshot.messages.find(m => m.role === 'system')?.content));
        snapshot.messages = snapshot.messages.filter(m => m.role !== 'system');
        captured.push(snapshot);
      }
      const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: compression ? 'Summary.' : `Answer to: ${text.split('</chat>').at(-1)?.trim()}` }],
        timestamp: Date.now(), stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, usage: emptyUsage() };
      const stream = createAssistantMessageEventStream();
      void (async () => {
        if (text.endsWith('Long task.')) { stream.push({ type: 'start', partial: reply }); notifyHeld(); await released; }
        stream.push({ type: 'done', reason: 'stop', message: reply });
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
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date'] })).session;
    const errors: string[] = [];
    await session.bindExtensions({ onError: error => errors.push(error.error) });
    const report = (text: string) => session!.sendCustomMessage({ customType: REPORT_TYPE, content: text, display: true }, { triggerTurn: true, deliverAs: 'steer' });

    await session.prompt('Start a subagent.');
    // Idle: Pi runs the report without before_agent_start, so OptChat must start the run itself.
    await report('[8964a512] Message from subagent (still running): step 1 done');
    await session.agent.waitForIdle();
    const idle = captured.at(-1)!.messages;
    assert.equal(idle.at(-1)?.role, 'user');
    assert.ok(textContent(idle.at(-1)!.content).endsWith('[8964a512] Message from subagent (still running): step 1 done'));
    assert.equal(systems.at(-1), systems[0], 'the report run reuses the main system prompt');
    assert.ok(systems[0].length > 0);

    // The next question starts from the view alone, which holds the report as a user line.
    await session.prompt('What did it say?');
    const next = captured.at(-1)!.messages;
    assert.deepEqual(next.map(m => m.role), ['user']);
    assert.match(textContent(next[0].content), /\|user: \[8964a512\] Message from subagent \(still running\): step 1 done/);

    // Busy: the report is steered into the running turn.
    const running = session.prompt('Long task.');
    await held;
    await report('[8964a512] Final report.');
    release();
    await running;
    await session.agent.waitForIdle();
    assert.ok(captured.at(-1)!.messages.some(m => m.role === 'user' && textContent(m.content) === '[8964a512] Final report.'));

    const shown = manager.getBranch().filter(e => e.type === 'custom_message' && e.customType === REPORT_TYPE);
    assert.equal(shown.length, 2, 'both reports are stored as custom messages, so Pi draws them with our renderer');
    assert.ok(!manager.getBranch().some(e => e.type === 'message' && e.message.role === 'user' && textContent(e.message.content).startsWith('[8964a512]')));
    const main = join(dir, 'profiles', 'fixture', 'main');
    const log = readdirSync(main).flatMap(file => readFileSync(join(main, file), 'utf8').trim().split('\n')).map(line => JSON.parse(line) as { kind: string; text: string });
    assert.ok(log.some(e => e.kind === 'user' && e.text === '[8964a512] Message from subagent (still running): step 1 done'));
    assert.ok(log.some(e => e.kind === 'user' && e.text === '[8964a512] Final report.'));
    assert.deepEqual(errors, []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
