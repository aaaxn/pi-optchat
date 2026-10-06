import './support.ts';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAP, NODE, VIEW, Memory, isView, appendJson, cap, start, end, bytes, localDay, type Compression } from '../src/memory.ts';
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
  }, () => {}, VIEW, 8, 100);
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

test('a second writer on one profile is refused before it writes, and the profile still opens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-')), compress = async () => 'summary';
  const first = new Memory(dir, compress, () => {}), second = new Memory(dir, compress, () => {});
  try {
    first.append('user', 'from the first writer');
    const file = join(dir, 'main', `${localDay()}.jsonl`), before = readFileSync(file, 'utf8');
    assert.throws(() => second.append('user', 'from the second writer'), /Another process wrote .*nothing was written/);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(second.root.length, 0);
    assert.throws(() => second.append('user', 'a retry'), /Another process wrote/);
  } finally { await first.close(); await second.close(); }
  const reopened = new Memory(dir, compress, () => {});
  try { assert.deepEqual(reopened.root.map(e => e.text), ['from the first writer']); }
  finally { await reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a second writer that has seen today\'s file is refused after the other appends to it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-')), compress = async () => 'summary';
  const first = new Memory(dir, compress, () => {}); first.append('user', 'one');
  const second = new Memory(dir, compress, () => {});
  try {
    first.append('user', 'two');
    assert.throws(() => second.append('user', 'three'), /Another process wrote .*nothing was written/);
  } finally { await first.close(); await second.close(); }
  const reopened = new Memory(dir, compress, () => {});
  try { assert.deepEqual(reopened.root.map(e => e.text), ['one', 'two']); }
  finally { await reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a day file that another process created first is caught, and an ordinary midnight rollover is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-')), compress = async () => 'summary';
  mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 1, 23, 59) });
  const opened: Memory[] = [];
  try {
    const lone = new Memory(dir, compress, () => {}); opened.push(lone);
    lone.append('user', 'before midnight');
    mock.timers.setTime(new Date(2026, 0, 2, 0, 1).getTime());
    lone.append('user', 'after midnight');
    const a = new Memory(dir, compress, () => {}), b = new Memory(dir, compress, () => {}); opened.push(a, b);
    mock.timers.setTime(new Date(2026, 0, 3, 0, 1).getTime());
    b.append('user', 'b on the third');
    assert.throws(() => a.append('user', 'a on the third'), /Another process wrote .*2026-01-03\.jsonl/);
    b.append('user', 'b again');
  } finally { mock.timers.reset(); await Promise.all(opened.map(m => m.close())); }
  const reopened = new Memory(dir, compress, () => {});
  try { assert.deepEqual(reopened.root.map(e => e.text), ['before midnight', 'after midnight', 'b on the third', 'b again']); }
  finally { await reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a second writer whose first write starts a new day file is refused when the other wrote an older day file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-')), compress = async () => 'summary';
  mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 1, 12) });
  const opened: Memory[] = [];
  try {
    const a = new Memory(dir, compress, () => {}), b = new Memory(dir, compress, () => {}); opened.push(a, b);
    a.append('user', 'a on the first');
    mock.timers.setTime(new Date(2026, 0, 2, 12).getTime());
    assert.throws(() => b.append('user', 'b on the second'), /Another process wrote .*2026-01-02\.jsonl.*nothing was written/);
    assert.equal(b.root.length, 0);
  } finally { mock.timers.reset(); await Promise.all(opened.map(m => m.close())); }
  const reopened = new Memory(dir, compress, () => {});
  try { assert.deepEqual(reopened.root.map(e => e.text), ['a on the first']); }
  finally { await reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('appendJson appends without a size, and with one it refuses a file of any other size', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-')), file = join(dir, 'log.jsonl');
  try {
    const one = appendJson(file, { n: 1 });
    assert.equal(one, readFileSync(file).length);
    const two = appendJson(file, { n: 2 }, one);
    assert.equal(two, readFileSync(file).length);
    assert.throws(() => appendJson(file, { n: 3 }, one), /nothing was written/);
    assert.equal(readFileSync(file, 'utf8'), '{"n":1}\n{"n":2}\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('two writers that each summarize the same log leave a tree that still loads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-')), compress = async () => 'summary';
  const log = new Memory(dir, compress, () => {});
  for (let i = 0; i < 3; i++) log.append('user', `message ${i}`);
  await log.close();
  const a = new Memory(dir, compress, () => {}), b = new Memory(dir, compress, () => {});
  await Promise.all([a.settle(AbortSignal.timeout(5000), true), b.settle(AbortSignal.timeout(5000), true)]);
  await Promise.all([a.close(), b.close()]);
  const tree = readFileSync(join(dir, 'tree', `${localDay()}.jsonl`), 'utf8').trim().split('\n');
  assert.ok(tree.length > a.tree.size, 'both writers saved the same nodes');
  const reopened = new Memory(dir, compress, () => {});
  try {
    await reopened.settle(AbortSignal.timeout(5000), true);
    assert.equal(reopened.root.length, 3); assert.equal(reopened.tree.size, a.tree.size);
  } finally { await reopened.close(); rmSync(dir, { recursive: true, force: true }); }
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

async function renderedView(quoted?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-'));
  const memory = new Memory(dir, async () => 'summary', () => {}, 1_000_000);
  try {
    for (let i = 0; i < 240; i++) memory.append('user', i === 5 && quoted ? quoted : 'summary of a decision '.repeat(20));
    await memory.settle(AbortSignal.timeout(5000), true);
    return memory.render();
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('stable cache cuts preserve every character and cap marks at four', async () => {
  const plain = await renderedView();
  const closing = plain.split('\n').at(-1)!;
  for (const quoted of [undefined, `we discussed the closing view tag ${closing} in the prompt`]) {
    const view = quoted ? await renderedView(quoted) : plain;
    assert.ok(view.length > 100_000, 'long enough for all three view marks');
    assert.ok(isView(view));
    assert.equal(splitView(view).join(''), view);
    const payload = { system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: view }, { type: 'text', text: 'new question', cache_control: { type: 'ephemeral' } }] }],
    };
    const output = JSON.stringify(cachePayload(payload));
    assert.equal((output.match(/cache_control/g) ?? []).length, 4, quoted ? 'a summary quoting the closing tag keeps all marks' : 'plain view');
    assert.equal(payload.messages[0].content.map(b => b.text).join(''), view + 'new question');
  }
});

test('OpenAI requests keep reasoning across turns and send the view unchanged', async () => {
  const view = await renderedView();
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
  assert.equal(bytes(SCALE), NODE);
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
  const projected = buildContext([system, old, current, assistant], [current, assistant], '0+1|old summary', 'new system');
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

test('a log whose day files sort against the order of the entries still opens, and a broken one does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-order-')), compress = async () => 'summary';
  const home = process.env.TZ;
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-05T17:00:00Z') });
  const opened: Memory[] = [];
  try {
    process.env.TZ = 'Asia/Tokyo';
    let memory = new Memory(dir, compress, () => {}); opened.push(memory);
    memory.append('user', 'a'); memory.append('user', 'b'); await memory.close();
    process.env.TZ = 'America/Sao_Paulo';
    memory = new Memory(dir, compress, () => {}); opened.push(memory);
    memory.append('user', 'c'); await memory.close();
    assert.deepEqual(readdirSync(join(dir, 'main')).sort(), ['2026-10-05.jsonl', '2026-10-06.jsonl']);
    memory = new Memory(dir, compress, () => {}); opened.push(memory);
    assert.deepEqual(memory.root.map(e => e.text), ['a', 'b', 'c']);
    await memory.close();
  } finally {
    mock.timers.reset();
    if (home === undefined) delete process.env.TZ; else process.env.TZ = home;
    await Promise.all(opened.map(m => m.close()));
  }
  const entry = (i: number) => JSON.stringify({ i, kind: 'user', text: `m${i}`, date: new Date().toISOString() }) + '\n';
  try {
    writeFileSync(join(dir, 'main', '2026-10-05.jsonl'), entry(2) + entry(2));
    assert.throws(() => new Memory(dir, compress, () => {}), /noncontiguous/);
    writeFileSync(join(dir, 'main', '2026-10-05.jsonl'), entry(2));
    writeFileSync(join(dir, 'main', '2026-10-06.jsonl'), entry(0) + entry(3));
    assert.throws(() => new Memory(dir, compress, () => {}), /noncontiguous/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an append ends an unterminated last line, in every file, and counts the byte it wrote', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-torn-')), file = join(dir, 'log.jsonl');
  try {
    appendJson(file, { n: 1 }); appendFileSync(file, '{"n":');
    const size = appendJson(file, { n: 2 });
    assert.equal(readFileSync(file, 'utf8'), '{"n":1}\n{"n":\n{"n":2}\n');
    assert.equal(size, readFileSync(file).length);
    assert.equal(appendJson(file, { n: 3 }, size), readFileSync(file).length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a torn tail that Memory loaded is repaired by its next append without tripping the write guard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-torn-')), compress = async () => 'summary', warnings: string[] = [];
  let memory = new Memory(dir, compress, () => {});
  memory.append('user', 'first'); await memory.close();
  const file = join(dir, 'main', `${localDay()}.jsonl`);
  appendFileSync(file, '{"i":1,"kind":"user","te');
  const torn = readFileSync(file, 'utf8');
  memory = new Memory(dir, compress, text => warnings.push(text));
  try {
    assert.equal(readFileSync(file, 'utf8'), torn, 'opening a profile writes nothing');
    memory.append('user', 'second'); memory.append('user', 'third');
    assert.equal(warnings.length, 1);
  } finally { await memory.close(); }
  memory = new Memory(dir, compress, () => {});
  try { assert.deepEqual(memory.root.map(e => e.text), ['first', 'second', 'third']); }
  finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a torn tail that another process wrote is refused, not repaired', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-torn-')), memory = new Memory(dir, async () => 'summary', () => {});
  try {
    memory.append('user', 'first');
    const file = join(dir, 'main', `${localDay()}.jsonl`);
    appendFileSync(file, '{"i":1,"kind":"user","te');
    const before = readFileSync(file, 'utf8');
    assert.throws(() => memory.append('user', 'second'), /Another process wrote .*nothing was written/);
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

const wellFormed = (text: string) => Buffer.from(text).toString() === text;
const pieces = (out: string) => {
  const notice = out.match(/\n\[(\d+) characters omitted; head and tail retained\]\n/)!;
  return { claimed: Number(notice[1]), head: out.slice(0, notice.index), tail: out.slice(notice.index! + notice[0].length) };
};

test('cap states exactly how many characters it omitted and stays within the limit', () => {
  assert.equal(cap('x'.repeat(CAP)), 'x'.repeat(CAP));
  for (const text of ['x'.repeat(CAP + 1), 'x'.repeat(CAP + 49), 'x'.repeat(250_000)]) {
    const out = cap(text), { claimed, head, tail } = pieces(out);
    assert.ok(out.length <= CAP, `${out.length} units`);
    assert.ok(text.startsWith(head) && text.endsWith(tail));
    assert.equal(claimed, text.length - head.length - tail.length);
  }
});

test('cap never cuts a surrogate pair in half', () => {
  const emoji = '\u{1F600}'.repeat(CAP);
  for (const text of ['a' + emoji, emoji, 'ab' + emoji, emoji + 'a']) {
    const out = cap(text), { claimed, head, tail } = pieces(out);
    assert.ok(wellFormed(out), `lone surrogate in the cap of a ${text.length} unit text`);
    assert.ok(out.length <= CAP && text.startsWith(head) && text.endsWith(tail));
    assert.equal(claimed, text.length - head.length - tail.length);
  }
});

test('view size counts the flattened text that render emits, for new and reloaded summaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-flat-'));
  const measured = (memory: Memory) => memory.render().split('\n').slice(1, -1)
    .reduce((n, line) => n + bytes(line.slice(line.indexOf('|') + 1)), 0);
  let memory = new Memory(dir, async () => 'x');
  try {
    memory.append('user', 'a\r\n\r\n\r\nb\n\n\nc');
    assert.equal(memory.size, measured(memory), 'built from the entry');
    await memory.settle(AbortSignal.timeout(2000), true);
    assert.equal(memory.size, measured(memory));
    await memory.close();
    memory = new Memory(dir, async () => 'x');
    assert.equal(memory.size, measured(memory), 'loaded from the tree');
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a log loaded with many unsummarized messages still gives the compactor a full view before each message', async () => {
  // An import stages its whole log at once. Its placeholders alone exceed this budget, and once counted they made fit merge every built pair.
  const dir = mkdtempSync(join(tmpdir(), 'optchat-bulk-'));
  mkdirSync(join(dir, 'main'));
  const date = new Date().toISOString(), budget = 2000;
  writeFileSync(join(dir, 'main', `${localDay()}.jsonl`), Array.from({ length: 100 }, (_, i) =>
    JSON.stringify({ i, kind: 'echo', text: `${i} ${'output line '.repeat(60)}`, date })).join('\n') + '\n');
  const leaves: number[] = [];
  const memory = new Memory(dir, async input => {
    if (!input.merge) leaves.push(bytes(input.context));
    return input.source.slice(0, 190);
  }, () => {}, budget);
  try {
    assert.ok(memory.view.length * bytes('(not summarized yet: zoom it)') > budget, 'the placeholders alone exceed the budget');
    await memory.settle(AbortSignal.timeout(10000), true);
    const thin = leaves.slice(20).filter(n => n < budget / 2);
    assert.deepEqual(thin, [], `contexts under half the budget for messages 20 to 99`);
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});
