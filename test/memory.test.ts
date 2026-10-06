import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAP, Memory, start, end, bytes, localDay, type Compression } from '../src/memory.ts';
import { lockProfile } from '../src/profiles.ts';
import { splitView, cachePayload, cacheFor } from '../src/cache.ts';
import { SCALE } from '../src/compactor.ts';
import { logMessage, buildContext, boundedMessage } from '../src/transcript.ts';
import { Inbox } from '../src/inbox.ts';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import type { AssistantMessage, SystemMessage, UserMessage } from '@earendil-works/pi-ai';

test('tree covers all history, fits incrementally, and exact originals survive restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-'));
  const calls: Compression[] = [];
  const compress = async (input: Compression) => { calls.push(input); return input.source.slice(0, 170); };
  let memory = new Memory(dir, compress, () => {}, 1500);
  try {
    for (let i = 0; i < 48; i++) memory.append('user', `Original ${i}: ${'valuable detail '.repeat(30)}`);
    await memory.settle(AbortSignal.timeout(5000), true);
    assert.equal(start(memory.view[0]), 0);
    assert.equal(end(memory.view.at(-1)!), 48);
    for (let i = 1; i < memory.view.length; i++) assert.equal(end(memory.view[i - 1]), start(memory.view[i]));
    assert.ok(memory.size <= 1500);
    assert.ok(memory.view.some(p => p.l > 0));
    assert.ok(calls.every(c => !c.context.includes('not summarized yet')));
    assert.match(memory.zoom(17, 1), /Original 17:/);
    const originals = memory.root.map(e => e.text);
    const parts = [...memory.view];
    memory.append('talk', 'One short new reply.');
    await memory.settle(AbortSignal.timeout(5000), true);
    for (const before of parts) assert.ok(memory.view.some(after => start(after) <= start(before) && end(after) >= end(before)));
    await memory.close();
    memory = new Memory(dir, compress, () => {}, 1500);
    await memory.settle(AbortSignal.timeout(5000), true);
    assert.deepEqual(memory.root.slice(0, 48).map(e => e.text), originals);
    assert.match(memory.zoom(17, 1), /valuable detail/);
    assert.throws(() => memory.zoom(3, 4), /No line/);
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('pending compaction blocks a turn, cancellation works, failure retries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-')); let attempts = 0;
  const memory = new Memory(dir, async () => {
    attempts++; if (attempts === 1) throw new Error('temporary outage'); return 'user: retained decision';
  }, () => {}, 128000, 8, 100);
  try {
    memory.append('user', 'large message '.repeat(100));
    await assert.rejects(memory.settle(AbortSignal.timeout(20)), /cancelled/);
    await memory.settle(AbortSignal.timeout(2000));
    assert.equal(attempts, 2); assert.ok(memory.ready); assert.equal(memory.root.length, 1);
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('torn final line is reported and the next append remains readable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-')); let memory = new Memory(dir, async () => 'summary');
  memory.append('user', 'first'); await memory.close();
  appendFileSync(join(dir, 'main', `${localDay()}.jsonl`), '{"torn":');
  const warnings: string[] = [];
  memory = new Memory(dir, async () => 'summary', text => warnings.push(text));
  memory.append('user', 'second'); await memory.close();
  memory = new Memory(dir, async () => 'summary', () => {});
  try { assert.equal(warnings.length, 1); assert.deepEqual(memory.root.map(e => e.text), ['first', 'second']); }
  finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a live profile cannot be opened by a second writer; other profiles can run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-'));
  const unlock = await lockProfile(dir, 'test owner');
  try {
    await assert.rejects(lockProfile(dir, 'second writer'), /test owner/);
    const other = await lockProfile(dir + '-other', 'other profile'); await other();
  } finally { await unlock(); }
  const again = await lockProfile(dir, 'after close'); await again(); rmSync(dir, { recursive: true, force: true });
});

test('stable cache cuts preserve every character and cap marks at four', () => {
  const view = '<chat>\n' + '0+1|summary of a decision\n'.repeat(5500) + '</chat>';
  assert.equal(splitView(view).join(''), view);
  const payload = { system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: view }, { type: 'text', text: 'new question', cache_control: { type: 'ephemeral' } }] }],
  };
  const output = JSON.stringify(cachePayload(payload));
  assert.equal((output.match(/cache_control/g) ?? []).length, 4);
  assert.equal(payload.messages[0].content.map(b => b.text).join(''), view + 'new question');
});

test('OpenAI requests keep reasoning across turns and send the view unchanged', () => {
  const view = '<chat>\n' + '0+1|summary of a decision\n'.repeat(5500) + '</chat>';
  const payload = { instructions: 'system', reasoning: { effort: 'high' },
    input: [{ role: 'user', content: [{ type: 'input_text', text: view }, { type: 'input_text', text: 'new question' }] }] };
  cacheFor('openai-codex-responses', payload);
  assert.equal(payload.input[0].content.length, 2);
  assert.doesNotMatch(JSON.stringify(payload), /prompt_cache_breakpoint/);
  assert.deepEqual(payload.reasoning, { effort: 'high', context: 'all_turns' });
  const plain: Record<string, unknown> = { input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] };
  assert.equal(cacheFor('openai-responses', plain), plain);
  assert.equal(plain.reasoning, undefined, 'a request without reasoning gets none');
  assert.equal(cacheFor('google-generative-ai', payload), payload);
});

test('the compactor scale line is one node long, realistic, and has nothing to copy', () => {
  assert.equal(bytes(SCALE), 512);
  assert.doesNotMatch(SCALE, /\.{3,}$/, 'no padding');
  assert.doesNotMatch(SCALE, /[^\x20-\x7e]/, 'ASCII only, so bytes equal characters');
  assert.doesNotMatch(SCALE, /\d/, 'no ids or numbers for the compactor to copy');
  for (const kind of ['user', 'talk', 'tool', 'echo', 'work']) assert.match(SCALE, new RegExp(`\\b${kind}: `), `tagged ${kind}`);
});

test('next turn excludes old conversation; current tool loop and reasoning remain verbatim', async () => {
  const system: SystemMessage = { role: 'system', content: 'old system', timestamp: 0 };
  const old: UserMessage = { role: 'user', content: 'OLD FULL CONVERSATION', timestamp: 1 };
  const current: UserMessage = { role: 'user', content: 'new question', timestamp: 2 };
  const assistant: AssistantMessage = { role: 'assistant', content: [{ type: 'thinking', thinking: 'private thoughts', thinkingSignature: 'signed' }, { type: 'text', text: 'visible reply' }],
    api: 'anthropic-messages', provider: 'anthropic', model: 'fixture', stopReason: 'stop', timestamp: 3,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const projected = buildContext([system, old, current, assistant], [current, assistant], '<chat>\n0+1|old summary\n</chat>', 'new system');
  assert.ok(!JSON.stringify(projected).includes('OLD FULL CONVERSATION'));
  assert.equal(projected[2], assistant);
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-')); const memory = new Memory(dir, async () => 'summary');
  try { logMessage(memory, assistant); assert.equal(memory.root.length, 1); assert.equal(memory.root[0].text, 'visible reply'); }
  finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tool images survive active-context truncation while text is bounded', () => {
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'example-base64' };
  const message: ToolResultMessage = { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', isError: false, timestamp: 1,
    content: [{ type: 'text', text: 'x'.repeat(40_000) }, image] };
  const bounded = boundedMessage(message);
  assert.equal(bounded.role, 'toolResult');
  if (bounded.role !== 'toolResult') throw new Error('unexpected role');
  assert.ok(bounded.content.includes(image));
  assert.ok(bounded.content.filter(c => c.type === 'text').reduce((n, c) => n + c.text.length, 0) <= CAP);
});

test('crash recovery saves unconsumed inputs once, including append-before-ack crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-'));
  const memory = new Memory(dir, async () => 'summary');
  try {
    let inbox = new Inbox(dir);
    inbox.record('queued while the agent was working');
    assert.equal(inbox.claim('unrelated extension message'), undefined);
    const skill = inbox.record('/skill:demox  go');
    assert.equal(inbox.claimSkill('demo', 'go'), undefined, 'a skill name must match whole');
    assert.equal(inbox.claimSkill('demox', 'go'), skill);
    inbox.acknowledge(skill);
    const delivered = inbox.record('delivered, but crashed before the journal acknowledgment');
    memory.append('user', 'delivered, but crashed before the journal acknowledgment', new Date().toISOString(), delivered);
    inbox = new Inbox(dir);
    assert.equal(inbox.recover(memory), 1);
    assert.equal(memory.root.length, 2);
    assert.equal(new Inbox(dir).recover(memory), 0);
    assert.equal(memory.root.length, 2);
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('incremental view size and pending count match the rendered view across failures and restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-size-'));
  let failures = 3;
  const compress = async (input: Compression) => {
    if (failures-- > 0) throw new Error('transient');
    return input.source.slice(0, 120 + input.source.length % 200);
  };
  const measured = (memory: Memory) => memory.render().split('\n').slice(1, -1)
    .reduce((n, line) => n + bytes(line.slice(line.indexOf('|') + 1)), 0);
  let memory = new Memory(dir, compress, () => {}, 4000, 8, 10);
  try {
    for (let i = 0; i < 120; i++) {
      memory.append(i % 3 ? 'echo' : 'user', `${i} ${'detail '.repeat(i % 7 ? 90 : 2)}`);
      assert.equal(memory.size, measured(memory), `size after append ${i}`);
    }
    await memory.settle(AbortSignal.timeout(5000), true);
    assert.equal(memory.pending, 0);
    assert.equal(memory.size, measured(memory));
    await memory.close();
    memory = new Memory(dir, compress, () => {}, 4000, 8, 10);
    assert.equal(memory.pending, 0);
    assert.equal(memory.size, measured(memory));
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

// Work counters, not timings: the old code re-measured the whole view on every fit and rescanned every level from 0 on every pump.
function longProfile(count: number) {
  // Written directly: one fsync per append would make the fixture slow. Short entries are their own summaries.
  const dir = mkdtempSync(join(tmpdir(), 'optchat-scale-'));
  mkdirSync(join(dir, 'main')); mkdirSync(join(dir, 'tree'));
  const date = new Date().toISOString(), lines: string[] = [], nodes: string[] = [];
  for (let i = 0; i < count; i++) lines.push(JSON.stringify({ i, kind: 'user', text: `m${i}`, date }));
  for (let l = 0, n = count; n > 0; l++, n = Math.floor(n / 2))
    for (let i = 0; i < n; i++) nodes.push(JSON.stringify({ l, i, text: `summary ${l}:${i}` }));
  writeFileSync(join(dir, 'main', `${localDay()}.jsonl`), lines.join('\n') + '\n');
  writeFileSync(join(dir, 'tree', `${localDay()}.jsonl`), nodes.join('\n') + '\n');
  return dir;
}

test('loading a long profile does not re-measure the whole view for every message', async () => {
  const count = 2048, dir = longProfile(count);
  const get = Map.prototype.get;
  let lookups = 0;
  Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) { lookups++; return get.call(this, key); };
  let memory: Memory | undefined;
  try { memory = new Memory(dir, async () => 'unused', () => {}); }
  finally { Map.prototype.get = get; }
  try {
    assert.equal(memory.view.length, count);
    assert.ok(lookups < 10 * count, `${lookups} lookups to load ${count} messages`);
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a new message is summarized without rescanning every built node', async () => {
  const count = 2048, dir = longProfile(count);
  // A small budget keeps the view short, as in a real profile, so the tree is far larger than the view.
  const memory = new Memory(dir, async () => 'unused', () => {}, 1000);
  try {
    assert.ok(memory.view.length < 100);
    await memory.settle(AbortSignal.timeout(10000), true); // the first pump after load finds each level's frontier
    const get = memory.tree.get;
    let lookups = 0;
    memory.tree.get = function (this: typeof memory.tree, key) { lookups++; return get.call(this, key); };
    memory.append('user', 'one more');
    await memory.settle(AbortSignal.timeout(10000), true);
    assert.equal(memory.pending, 0);
    assert.ok(lookups < count / 2, `${lookups} tree lookups for one new message over ${count}`);
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an expanded /skill: command claims the input it came from, and only that one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-inbox-'));
  try {
    const inbox = new Inbox(dir);
    const plain = inbox.record('/skill:demox');
    const skill = inbox.record('/skill:demox  go');
    assert.equal(inbox.claimSkill('demo', 'go'), undefined, 'a skill name must match whole');
    assert.equal(inbox.claimSkill('demox', 'other'), undefined, 'arguments must match');
    assert.equal(inbox.claimSkill('demox', 'go'), skill);
    assert.equal(inbox.claimSkill('demox', 'go'), undefined, 'an input is claimed once');
    assert.equal(inbox.claimSkill('demox'), plain);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rebuilding a leaf that a saved parent already hides does not inflate the view size', async () => {
  // A damaged tree file can lose a leaf while its parent survives; loading then merges the unbuilt leaf away.
  const dir = mkdtempSync(join(tmpdir(), 'optchat-hidden-'));
  mkdirSync(join(dir, 'main')); mkdirSync(join(dir, 'tree'));
  const date = new Date().toISOString();
  const texts = ['x'.repeat(400), 'b', 'c', 'd'];
  writeFileSync(join(dir, 'main', `${localDay()}.jsonl`), texts.map((text, i) => JSON.stringify({ i, kind: 'user', text, date })).join('\n') + '\n');
  const nodes = [{ l: 0, i: 1 }, { l: 0, i: 2 }, { l: 0, i: 3 }, { l: 1, i: 0 }, { l: 1, i: 1 }];
  writeFileSync(join(dir, 'tree', `${localDay()}.jsonl`), nodes.map(n => JSON.stringify({ ...n, text: `summary ${n.l}:${n.i} padded to twenty` })).join('\n') + '\n{damaged\n');
  const measured = (memory: Memory) => memory.render().split('\n').slice(1, -1)
    .reduce((n, line) => n + bytes(line.slice(line.indexOf('|') + 1)), 0);
  const memory = new Memory(dir, async () => 'top', () => {}, 80);
  try {
    assert.ok(memory.view.every(p => p.l > 0), 'the unbuilt leaf 0 is hidden by its saved parent');
    assert.equal(memory.pending, 1);
    await memory.settle(AbortSignal.timeout(3000), true);
    assert.equal(memory.pending, 0);
    assert.equal(memory.size, measured(memory));
    assert.ok(memory.size <= 80);
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});
