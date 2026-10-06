import { fakeProvider, fakeRuntime } from './fakes.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { createCompressor } from '../src/compactor.ts';
import { Memory } from '../src/memory.ts';
import { emptyUsage } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';

/** A fake Anthropic model whose calls answer and finish only when the test says so, over a real memory view long enough for cache marks. */
async function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-compactor-'));
  const calls: { source: string; options: { sessionId?: string; transport?: string }; answer: () => void; finish: () => void; fail: () => void }[] = [];
  const provider = fakeProvider((model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const source = textContent(context.messages.findLast(m => m.role === 'user')?.content).split('\n').at(-1) ?? '';
    const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: `summary of ${source}` }], api: model.api, provider: model.provider,
      model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
    stream.push({ type: 'start', partial: message });
    const step = <T>() => { let resolve = (_: T) => {}; return { promise: new Promise<T>(r => { resolve = r; }), resolve }; };
    const answered = step<boolean>(), finished = step<void>();
    calls.push({ source, options: { sessionId: options?.sessionId, transport: options?.transport },
      answer: () => answered.resolve(true), fail: () => answered.resolve(false), finish: () => finished.resolve() });
    void (async () => {
      if (!await answered.promise) {
        message.stopReason = 'error'; message.errorMessage = 'overloaded';
        stream.push({ type: 'error', reason: 'error', error: message }); return stream.end();
      }
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'summary', partial: message });
      await finished.promise;
      stream.push({ type: 'done', reason: 'stop', message }); stream.end();
    })();
    return stream;
  });
  const runtime = await fakeRuntime(dir, { ...provider, api: 'anthropic-messages' });
  const compress = createCompressor(new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'off' }));
  const memory = new Memory(dir, async () => 'summary', () => {}, 1_000_000);
  t.after(async () => { await memory.close(); rmSync(dir, { recursive: true, force: true }); });
  // Each message fits in one summary line, so the view passes 100k characters and the first 50k are a shared, cacheable prefix.
  for (let i = 0; i < 240; i++) memory.append('user', 'an old remembered line '.repeat(20));
  await memory.settle(AbortSignal.timeout(5000), true);
  const view = memory.render();
  const run = (source: string, context = view, signal = new AbortController().signal) => compress({ context, source, merge: false }, signal);
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  const newer = async () => { memory.append('user', 'one new line'); await memory.settle(AbortSignal.timeout(5000), true); return memory.render(); };
  return { calls, run, settle, view, newer };
}

test('parallel calls on a cold view wait until one call has started answering, and a warm view skips the wait', async t => {
  const { calls, run, settle, newer } = await setup(t);
  const replies = ['a', 'b', 'c'].map(source => run(source));
  await settle();
  assert.deepEqual(calls.map(c => c.source), ['a'], 'only the primer starts while the shared view is cold');
  calls[0].answer();
  await settle();
  assert.deepEqual(calls.map(c => c.source), ['a', 'b', 'c'], 'the rest start together once the primer answers, before it finishes');
  calls.forEach(c => { c.answer(); c.finish(); });
  assert.deepEqual(await Promise.all(replies), ['summary of a', 'summary of b', 'summary of c']);
  const warm = run('d', await newer());
  await settle();
  assert.equal(calls.length, 4, 'a newer view with the same cached prefix starts right away');
  calls[3].answer(); calls[3].finish();
  await warm;
});

test('every compactor call shares one session id over SSE (recipe §8, checklist 10)', async t => {
  const { calls, run, settle } = await setup(t);
  const reply = run('a');
  await settle();
  calls[0].answer(); calls[0].finish();
  await reply;
  assert.deepEqual(calls.map(c => c.options), [{ sessionId: 'optchat-compactor', transport: 'sse' }]);
});

test('a failing primer releases the waiting calls instead of hanging them', { timeout: 5000 }, async t => {
  const { calls, run, settle } = await setup(t);
  const replies = ['a', 'b', 'c'].map(source => run(source).catch((error: Error) => error.message));
  await settle();
  calls[0].fail();
  await settle();
  assert.equal(calls.length, 2, 'the next waiter primes in its place');
  calls[1].answer();
  await settle();
  calls.slice(1).forEach(c => { c.answer(); c.finish(); });
  assert.deepEqual(await Promise.all(replies), ['overloaded', 'summary of b', 'summary of c']);
});

test('a waiting call that is cancelled stops at once without ever calling the model', { timeout: 5000 }, async t => {
  const { calls, run, settle, view } = await setup(t);
  const primer = run('a'), cancel = new AbortController();
  const waiter = run('b', view, cancel.signal);
  await settle();
  cancel.abort();
  await assert.rejects(waiter, { name: 'AbortError' });
  calls[0].answer(); calls[0].finish();
  await primer;
  assert.deepEqual(calls.map(c => c.source), ['a']);
});
