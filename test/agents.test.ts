import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { RunHistory } from '../src/runs.ts';
import { emptyUsage, UsageLedger } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';
import { SUBAGENT, VIEW_DOC } from '../src/prompts.ts';

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
      for (const m of context.messages) if (m.role === 'system') systemPrompts.add(textContent(m.content));
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
    const [slow, fast, stopped] = await children.spawn(['slow', 'fast', 'stop-me'], dir);
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

    const [first] = await children.spawn(['first'], dir);
    const [second] = await children.spawn(['second'], dir);
    await until(() => releases.has('first') && releases.has('second'));
    for (const id of [first, second]) {
      const tools = children.live(id)!.session.getActiveToolNames();
      assert.ok(tools.includes('zoom') && !tools.includes('spawn') && !tools.includes('tell'), 'subagents get zoom and date, not spawn');
    }
    await assert.rejects(children.spawn(Array.from({ length: 7 }, () => 'too-many'), dir), /8 active agents/);
    children.live(second)!.session.dispose = () => { throw new Error('dispose failed'); };
    releases.get('second')!();
    await until(() => reports.length === 2);
    assert.equal(reports[1], `[${second}] Working on second`, 'separate spawns report independently');
    releases.get('first')!();
    await until(() => !children.active);
    assert.equal(reports[2], `[${first}] Working on first`);
    assert.deepEqual([...systemPrompts], [`${SUBAGENT}\n\n${VIEW_DOC}\n\nProfile instructions.`], 'the child prompt is the recipe\'s, unchanged');
    assert.deepEqual(warnings, ['Subagent cleanup failed: Error: dispose failed'], 'a failed cleanup must not drop the report');
  } finally { for (const release of releases.values()) release(); await children.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});
