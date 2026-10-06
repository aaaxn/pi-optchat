import { fakeProvider, fakeRuntime } from './fakes.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { createCompressor } from '../src/compactor.ts';
import { NODE } from '../src/memory.ts';
import { emptyUsage } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';

/** A fake model that answers with a line of each given byte length in turn. `followUps` holds the last message of every call after the first. */
async function attempts(sizes: number[]) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-size-'));
  const followUps: string[] = [];
  let calls = 0;
  const runtime = await fakeRuntime(dir, fakeProvider((model, context) => {
    if (calls) followUps.push(textContent(context.messages.at(-1)?.content));
    const text = 'x'.repeat(sizes[calls++]);
    const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text }], api: model.api,
      provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
    return stream;
  }));
  try {
    const compress = createCompressor(new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'off' }));
    const line = await compress({ context: 'no view', source: 'user: a long message', merge: false }, new AbortController().signal);
    return { calls, size: line.length, followUps };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a summary of NODE bytes is kept; one byte more is retried with the line cut at the limit (recipe §4.3)', async () => {
  assert.deepEqual(await attempts([NODE]), { calls: 1, size: NODE, followUps: [] });
  const over = await attempts([NODE + 1, 400]);
  assert.equal(over.calls, 2);
  assert.equal(over.size, 400);
  assert.equal(over.followUps[0], `That line is ${NODE + 1} bytes; the limit is 512. It must end where it is cut here:\n${'x'.repeat(NODE)}| ← LIMIT`);
});

test('a stubborn model gets 5 tries and the shortest one is kept', async () => {
  const result = await attempts([600, 580, 540, 570, 590, 520]);
  assert.equal(result.calls, 5);
  assert.equal(result.size, 540);
});
