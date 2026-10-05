import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { Memory, localDay, type Compressor } from '../src/memory.ts';
import { scanLocal, scanChatGPT, readConversation, type Conversation, type ImportedEntry } from '../src/import/sources.ts';
import { prepareImport, runImport, memoryDirectory, pendingImport, discardImport, deduplicate, chronological } from '../src/import/job.ts';
import { chooseImport, showProgress } from '../src/import/ui.ts';

const date = '2026-01-02T12:00:00.000Z';
const short: Compressor = async () => 'Historical decision summarized';
const temp = () => mkdtempSync(join(tmpdir(), 'optchat-import-test-'));
const lines = (path: string, items: unknown[]) => writeFileSync(path, items.map(i => JSON.stringify(i)).join('\n') + '\n');
const conversation = (source: Conversation['source'], file: string): Conversation => ({ source, file, id: 'conversation-1', title: 'Fixture', project: '/synthetic', date, size: 100 });
const entry = (id: string, at = date, text = `Imported ${id}`): ImportedEntry => ({ kind: 'user', text, date: at,
  receipt: `import:${id}`, origin: { source: 'claude', conversation: id, message: id, title: id } });

test('Claude imports user messages and final replies, omitting tool loops and replayed context', async () => {
  const dir = temp(), file = join(dir, 'claude.jsonl');
  const user = { type: 'user', uuid: 'u', timestamp: date, message: { role: 'user', content: 'exact user question' } };
  lines(file, [user, user,
    { type: 'assistant', uuid: 'a', timestamp: date, message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'SECRET REASONING' }, { type: 'text', text: 'intermediate explanation' },
      { type: 'tool_use', name: 'Bash', id: 'call-1', input: { command: 'ls' } },
    ] } },
    { type: 'user', uuid: 't', timestamp: date, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'result'.repeat(10_000) }] } },
    { type: 'user', uuid: 'replay', isCompactSummary: true, message: { role: 'user', content: 'REPLAYED CONTEXT' } },
    { type: 'user', uuid: 'meta', isMeta: true, message: { role: 'user', content: 'AUTOMATIC INSTRUCTIONS' } },
    { type: 'assistant', uuid: 'final', timestamp: date, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'final answer' }] } },
  ]);
  try {
    const parsed = await readConversation(conversation('claude', file));
    assert.deepEqual(parsed.entries.map(e => e.kind), ['user', 'talk']);
    assert.match(parsed.entries[1].text, /final answer/);
    assert.doesNotMatch(JSON.stringify(parsed.entries), /SECRET REASONING|intermediate explanation|call-1|REPLAYED CONTEXT|AUTOMATIC INSTRUCTIONS/);
    assert.deepEqual(parsed.warnings, []);
    assert.equal(parsed.entries[0].date, date);
    const renamed = await readConversation({ ...conversation('claude', file), title: 'Renamed', project: '/moved' });
    assert.deepEqual(renamed.entries.map(e => e.receipt), parsed.entries.map(e => e.receipt));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex imports user messages and final answers once, excluding commentary, tools and agent traffic', async () => {
  const dir = temp(), file = join(dir, 'codex.jsonl');
  const row = (payload: unknown) => ({ type: 'response_item', timestamp: date, payload });
  lines(file, [
    row({ type: 'message', id: 'u', role: 'user', content: [{ type: 'input_text', text: 'QUESTION' }] }),
    { type: 'event_msg', payload: { type: 'user_message', message: 'QUESTION' } },
    row({ type: 'reasoning', summary: [{ text: 'SECRET' }] }),
    row({ type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'SECRET' }] }),
    row({ type: 'message', role: 'assistant', channel: 'commentary', content: [{ type: 'output_text', text: 'Progress update' }] }),
    row({ type: 'function_call', call_id: 'call1', name: 'exec', arguments: '{"cmd":"ls"}' }),
    row({ type: 'function_call_output', call_id: 'call1', output: 'files' }),
    row({ type: 'custom_tool_call', call_id: 'call2', name: 'patch', input: '+new text' }),
    row({ type: 'custom_tool_call_output', call_id: 'call2', output: [{ type: 'input_text', text: 'done' }] }),
    row({ type: 'agent_message', author: 'child', recipient: 'parent', content: 'Agent chatter' }),
    row({ type: 'message', role: 'assistant', channel: 'final', content: [{ type: 'output_text', text: 'ANSWER' }] }),
    row({ type: 'future_type' }),
  ]);
  try {
    const parsed = await readConversation(conversation('codex', file));
    assert.deepEqual(parsed.entries.map(e => e.kind), ['user', 'talk']);
    assert.doesNotMatch(JSON.stringify(parsed.entries), /SECRET|Progress update|Agent chatter|call1|call2/);
    assert.match(parsed.entries[1].text, /ANSWER/);
    assert.equal(parsed.warnings.length, 1);
    assert.equal(new Set(parsed.entries.map(e => e.receipt)).size, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex phase markers exclude commentary and commit explicit final answers immediately', async () => {
  const dir = temp(), file = join(dir, 'phases.jsonl');
  const message = (id: string, phase: string, channel?: string | null) => ({ type: 'response_item', timestamp: date,
    payload: { type: 'message', id, role: 'assistant', phase, channel, content: [{ type: 'output_text', text: id }] } });
  const complete = { type: 'event_msg', payload: { type: 'task_complete' } };
  lines(file, [
    message('progress', 'commentary'), complete,
    message('answer', 'final_answer', null),
    { type: 'response_item', payload: { type: 'function_call', name: 'read', arguments: '{}' } },
    message('more-progress', 'commentary', null), complete,
  ]);
  try {
    const parsed = await readConversation(conversation('codex', file));
    assert.deepEqual(parsed.entries.map(e => e.origin?.message), ['answer']);
    assert.deepEqual(parsed.warnings, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy Claude replies survive tool loops while interrupted text and distinct repeated requests are handled correctly', async () => {
  const dir = temp(), file = join(dir, 'legacy.jsonl');
  const message = (uuid: string, role: string, content: unknown, stop_reason?: string) => ({ type: role, uuid, timestamp: date, message: { role, content, stop_reason } });
  const request = message('u1', 'user', 'Original request');
  lines(file, [request, request,
    message('progress', 'assistant', 'Checking now'),
    message('tool', 'assistant', [{ type: 'tool_use', name: 'Read', id: 'call', input: {} }]),
    message('result', 'user', [{ type: 'tool_result', tool_use_id: 'call', content: 'NOISE' }]),
    message('answer', 'assistant', 'Legacy final answer'),
    message('u2', 'user', 'yes'),
    message('partial', 'assistant', 'Unfinished reply'),
    message('interrupted', 'user', '[Request interrupted by user]'),
    message('u3', 'user', 'yes'),
    message('truncated', 'assistant', 'Truncated reply', 'max_tokens'),
  ]);
  try {
    const parsed = await readConversation(conversation('claude', file));
    assert.deepEqual(parsed.entries.map(e => e.origin?.message), ['u1', 'answer', 'u2', 'u3']);
    assert.doesNotMatch(JSON.stringify(parsed.entries), /NOISE|Checking now|Unfinished reply|Truncated reply/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy Codex replies are superseded by later work and discarded on interruption', async () => {
  const dir = temp(), file = join(dir, 'legacy.jsonl');
  const message = (id: string, role: string, content: string, channel?: string) => ({ type: 'response_item', timestamp: date, payload: { type: 'message', id, role, content, channel } });
  lines(file, [message('u1', 'user', 'Original request'), message('a1', 'assistant', 'Legacy answer'),
    message('u2', 'user', 'Next request'), message('progress', 'assistant', 'Checking'),
    { type: 'response_item', payload: { type: 'function_call', name: 'read', arguments: '{}' } },
    message('a2', 'assistant', 'Answer after tools'), { type: 'event_msg', payload: { type: 'task_complete' } },
    message('u3', 'user', 'Unfinished request'), message('partial', 'assistant', 'Unfinished answer'),
    { type: 'event_msg', payload: { type: 'turn_aborted' } },
  ]);
  try {
    const parsed = await readConversation(conversation('codex', file));
    assert.deepEqual(parsed.entries.map(e => e.origin?.message), ['u1', 'a1', 'u2', 'a2', 'u3']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex discovery and parsing exclude delegated sessions while keeping user forks', async () => {
  const dir = temp();
  const child = join(dir, 'child.jsonl'), parent = join(dir, 'parent.jsonl');
  const metadata = (source: unknown) => ({ type: 'session_meta', payload: { id: 'session', cwd: '/project', source, forked_from_id: 'earlier-session' } });
  const request = { type: 'response_item', payload: { type: 'message', id: 'u', role: 'user', content: 'Request' } };
  lines(parent, [metadata('cli'), request]);
  lines(child, [metadata({ subagent: { thread_spawn: { parent_thread_id: 'session' } } }), request]);
  try {
    const scan = await scanLocal('codex', [dir]);
    assert.deepEqual(scan.conversations.map(c => c.file), [parent]);
    assert.equal((await readConversation(conversation('codex', child))).entries.length, 0);
    assert.equal((await readConversation(scan.conversations[0])).entries.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ChatGPT keeps user messages and final replies on each branch with stable identities', async () => {
  const dir = temp(), file = join(dir, 'conversations-1.json');
  const exported = { id: 'chat-1', title: 'Branches', create_time: 100, update_time: 300, current_node: 'final', mapping: {
    final: { parent: 'result', message: { id: 'f', author: { role: 'assistant' }, channel: 'final', end_turn: true, create_time: null, content: { parts: ['Final answer'] } } },
    result: { parent: 'call', message: { id: 'r', author: { role: 'tool', name: 'python' }, create_time: null, content: { parts: ['42'] } } },
    alternate: { parent: 'u', message: { id: 'alt', author: { role: 'assistant' }, create_time: 220, content: { parts: ['alternate answer'] } } },
    call: { parent: 'progress', message: { id: 'c', author: { role: 'assistant' }, channel: 'analysis', recipient: 'python', create_time: 210, content: { content_type: 'code', text: 'print(42)' } } },
    progress: { parent: 'u', message: { id: 'p', author: { role: 'assistant' }, content: { parts: ['Let me check'] } } },
    reasoning: { parent: 'u', message: { id: 'secret', author: { role: 'assistant' }, channel: 'analysis', recipient: 'all', content: { parts: ['SECRET'] } } },
    u: { parent: null, message: { id: 'u', author: { role: 'user' }, create_time: 200, content: { parts: ['question'] } } },
  } };
  writeFileSync(file, JSON.stringify([exported]));
  try {
    const scan = await scanChatGPT(dir); assert.equal(scan.conversations.length, 1);
    const parsed = await readConversation(scan.conversations[0]);
    const msgs = parsed.entries.filter(e => e.origin?.message !== 'export:selected-branch');
    assert.deepEqual(msgs.map(e => e.origin?.message), ['u', 'f', 'alt']);
    assert.equal(msgs[1].kind, 'talk'); assert.equal(msgs[1].date, new Date(210_000).toISOString());
    assert.match(msgs[2].text, /alternate branch/);
    assert.doesNotMatch(JSON.stringify(parsed.entries), /SECRET|Let me check|print\(42\)/);
    const changed = await readConversation({ ...scan.conversations[0], exported: { ...exported, current_node: 'alternate' } });
    assert.deepEqual(changed.entries.slice(0, -1).map(e => e.receipt), msgs.map(e => e.receipt));
    assert.notEqual(changed.entries.at(-1)?.receipt, parsed.entries.at(-1)?.receipt);
    const backToOriginal = await readConversation({ ...scan.conversations[0], exported: { ...exported, update_time: 400 } });
    assert.notEqual(backToOriginal.entries.at(-1)?.receipt, parsed.entries.at(-1)?.receipt);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Claude discovery keeps the parent conversation and skips modern, legacy, and sidechain child logs', async () => {
  const root = temp(), dir = join(root, 'subagents', '.claude', 'projects');
  const sub = join(dir, 'session', 'subagents'); mkdirSync(sub, { recursive: true });
  const parent = join(dir, 'session.jsonl');
  const user = { type: 'user', sessionId: 'shared', cwd: '/project', timestamp: date, message: { role: 'user', content: 'Parent request' } };
  lines(parent, [user, { type: 'assistant', sessionId: 'shared', message: { role: 'assistant', content: 'Child reported useful findings.' } }]);
  for (const name of ['a', 'b']) lines(join(sub, `agent-${name}.jsonl`), [{ type: 'user', sessionId: 'shared', cwd: '/project', timestamp: date, message: { role: 'user', content: name } }]);
  lines(join(dir, 'agent-legacy.jsonl'), [user]);
  lines(join(dir, 'renamed-child.jsonl'), [{ type: 'file-history-snapshot' }, { ...user, isSidechain: true }]);
  const workflow = join(sub, 'workflows', 'wf-fixture'); mkdirSync(workflow, { recursive: true });
  lines(join(workflow, 'journal.jsonl'), [{ type: 'started', agentId: 'a' }, { type: 'result', result: 'workflow metadata' }]);
  lines(join(workflow, 'conversation.jsonl'), [user]);
  try {
    const scan = await scanLocal('claude', [dir]);
    assert.deepEqual(scan.conversations.map(c => c.id), ['shared']);
    assert.deepEqual(scan.conversations.map(c => c.file), [parent]);
    assert.ok(scan.conversations.every(c => c.project === '/project' && c.date === date));
    const parsed = await readConversation(scan.conversations[0]);
    assert.equal(parsed.entries.length, 2);
    assert.match(parsed.entries[1].text, /Child reported useful findings/);
    assert.deepEqual(scan.warnings, []);
    await assert.rejects(scanLocal('claude', [dir], AbortSignal.abort()));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Claude discovery checks late sidechain markers without extending metadata extraction or Codex scanning', async () => {
  const dir = temp(), parent = join(dir, 'parent.jsonl'), child = join(dir, 'renamed-child.jsonl');
  const metadata = Array.from({ length: 60 }, () => ({ type: 'file-history-snapshot' }));
  const user = { type: 'user', sessionId: 'parent', cwd: '/project', timestamp: date, message: { role: 'user', content: 'Parent request' } };
  lines(parent, [user, ...metadata.slice(1), { type: 'custom-title', sessionId: 'later', cwd: '/later', customTitle: 'Later title' }]);
  lines(child, [...metadata, { ...user, isSidechain: true }]);
  try {
    const scan = await scanLocal('claude', [dir]);
    assert.deepEqual(scan.conversations.map(c => c.file), [parent]);
    const { id, project, title, date: foundDate } = scan.conversations[0];
    assert.deepEqual({ id, project, title, date: foundDate }, { id: 'parent', project: '/project', title: 'Parent request', date });
    assert.deepEqual(scan.warnings, []);
    assert.equal((await readConversation(conversation('claude', child))).entries.length, 0);

    // Invalid JSON after line 60 would warn if Codex discovery read beyond its metadata budget.
    writeFileSync(parent, [JSON.stringify({ type: 'session_meta', payload: { id: 'codex-parent', cwd: '/project', source: 'cli', timestamp: date } }),
      ...metadata.slice(1).map(value => JSON.stringify(value)), 'not JSON'].join('\n') + '\n');
    rmSync(child);
    const codex = await scanLocal('codex', [dir]);
    assert.deepEqual(codex.conversations.map(c => c.id), ['codex-parent']);
    assert.deepEqual(codex.warnings, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('discovery continues when listed files disappear before stat or stream open', async () => {
  const dir = temp(), first = join(dir, 'a.jsonl'), beforeStat = join(dir, 'b.jsonl'), beforeOpen = join(dir, 'c.jsonl');
  for (const file of [first, beforeStat, beforeOpen]) lines(file, [{ type: 'user', sessionId: 'fixture', cwd: '/project', timestamp: date, message: { role: 'user', content: 'kept' } }]);
  const original = fs.createReadStream;
  const patched = mock.method(fs, 'createReadStream', (...args: Parameters<typeof fs.createReadStream>) => {
    if (args[0] === first) rmSync(beforeStat);
    if (args[0] === beforeOpen) rmSync(beforeOpen);
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const scan = await scanLocal('claude', [dir]);
    assert.deepEqual(scan.conversations.map(c => c.file), [first]);
    assert.equal(scan.warnings.length, 2);
    assert.ok(scan.warnings.some(w => w.includes(beforeStat)));
    assert.ok(scan.warnings.some(w => w.includes(beforeOpen)));
    assert.ok(scan.warnings.every(w => w.includes('conversation skipped')));
  } finally { patched.mock.restore(); syncBuiltinESMExports(); rmSync(dir, { recursive: true, force: true }); }
});

test('a selected transcript disappearing warns without importing it; cancellation and unrelated I/O errors still fail', async () => {
  const dir = temp(), file = join(dir, 'selected.jsonl');
  try {
    lines(file, [{ type: 'user', uuid: 'u', message: { role: 'user', content: 'selected conversation' } }]);
    const scan = await scanLocal('claude', [dir]);
    rmSync(file);
    for (const source of ['claude', 'codex'] as const) {
      const parsed = await readConversation({ ...scan.conversations[0], source });
      assert.equal(parsed.entries.length, 0);
      assert.equal(parsed.warnings.length, 1);
      assert.match(parsed.warnings[0], /source file is no longer available/);
    }
    const reason = new Error('User cancelled');
    await assert.rejects(readConversation(scan.conversations[0], AbortSignal.abort(reason)), error => error === reason);
    await assert.rejects(readConversation(conversation('claude', dir)), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EISDIR');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ChatGPT ZIP reads numbered conversation files without extracting other archive data', async () => {
  const dir = temp(), file = join(dir, 'conversations_1.json'), zip = join(dir, 'export.zip');
  writeFileSync(file, JSON.stringify([{ id: 'zip-chat', title: 'ZIP fixture', create_time: 100, mapping: {
    u: { parent: null, message: { id: 'u', author: { role: 'user' }, create_time: 100, content: { parts: ['zip fixture message'] } } },
  } }]));
  try {
    execFileSync('zip', ['-q', zip, 'conversations_1.json'], { cwd: dir }); rmSync(file);
    const scan = await scanChatGPT(zip); assert.equal(scan.conversations.length, 1);
    const parsed = await readConversation(scan.conversations[0]); assert.equal(parsed.entries.length, 1);
    assert.match(parsed.entries[0].text, /zip fixture message/); assert.equal(existsSync(file), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('append activates only after complete indexing, retains original summaries, and repeated imports add nothing', async () => {
  const dir = temp(); const old = new Memory(dir, short);
  let activated: Memory | undefined;
  try {
    old.append('user', 'original exact message', '2026-06-01T00:00:00.000Z');
    await old.settle(undefined, true); await old.close();
    const original = old.node({ l: 0, i: 0 });
    const job = prepareImport(dir, old, [entry('one'), entry('one')], 'append'); assert.ok(job);
    assert.equal(job.added, 1); assert.equal(job.skipped, 1); assert.equal(memoryDirectory(dir), dir);
    await runImport(dir, short, AbortSignal.timeout(5000));
    assert.equal(pendingImport(dir), undefined); assert.notEqual(memoryDirectory(dir), dir);
    activated = new Memory(memoryDirectory(dir), short);
    assert.deepEqual(activated.node({ l: 0, i: 0 }), original);
    assert.equal(activated.root[0].text, 'original exact message');
    assert.equal(activated.root[1].receipt, 'import:one');
    assert.match(activated.zoom(1, 1), /Imported one/);
    assert.deepEqual(deduplicate(activated.root, [entry('one')]), { added: [], skipped: 1 });
    assert.ok(existsSync(join(dir, 'main')));
  } finally { await old.close(); await activated?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('paused imports retain completed summaries, resume from disk, and preserve prior generation through rebuild', async () => {
  const dir = temp(); const old = new Memory(dir, short);
  let current: Memory | undefined;
  try {
    old.append('user', 'native later', '2026-06-01T00:00:00.000Z'); await old.settle(undefined, true); await old.close();
    prepareImport(dir, old, [entry('a'), entry('b', date, 'large '.repeat(200))], 'rebuild');
    await assert.rejects(runImport(dir, async (_input, signal) => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return '';
    }, AbortSignal.timeout(50)));
    assert.equal(memoryDirectory(dir), dir); assert.ok(pendingImport(dir));
    const staged = new Memory(join(dir, pendingImport(dir)!.target), short); const saved = staged.tree.size; await staged.close();
    assert.ok(saved >= 1);
    await runImport(dir, short, AbortSignal.timeout(5000));
    current = new Memory(memoryDirectory(dir), short);
    assert.equal(current.root[0].receipt, 'import:a'); assert.equal(current.root.at(-1)?.text, 'native later');
    assert.ok(current.tree.size >= saved);
    assert.ok(readFileSync(join(dir, 'main', localDay() + '.jsonl'), 'utf8').includes('native later'));
  } finally { await old.close(); await current?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('discard leaves original memory active and a completed pointer swap can finish recovery idempotently', async () => {
  const dir = temp(), old = new Memory(dir, short);
  try {
    old.append('user', 'original'); await old.settle(undefined, true); await old.close();
    const discarded = prepareImport(dir, old, [entry('discard')], 'append'); assert.ok(discarded);
    discardImport(dir); assert.equal(memoryDirectory(dir), dir); assert.equal(pendingImport(dir), undefined);
    const job = prepareImport(dir, old, [entry('keep')], 'append'); assert.ok(job);
    await runImport(dir, short, AbortSignal.timeout(5000));
    // Simulate the durable pointer write succeeding immediately before journal removal crashed.
    writeFileSync(join(dir, 'imports', 'pending.json'), JSON.stringify(job));
    await runImport(dir, short, AbortSignal.timeout(5000));
    assert.equal(pendingImport(dir), undefined);
    assert.equal(memoryDirectory(dir), join(dir, job.target));
    assert.ok(existsSync(join(dir, 'imports', `${job.id}.json`)));
  } finally { await old.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('chronological rebuild keeps imported conversations and native turns together', () => {
  const first = entry('conversation', date), later = { ...entry('conversation', '2026-12-01T00:00:00.000Z'), receipt: 'import:second' };
  const native: ImportedEntry = { kind: 'user', text: 'native', date: '2026-06-01T00:00:00.000Z' };
  assert.deepEqual(chronological([native, first, later]).map(e => e.text), [first.text, later.text, native.text]);
});

test('a failed progress dialog cancels and joins its worker before returning', async () => {
  const dir = temp(), old = new Memory(dir, short); await old.close();
  try {
    const job = prepareImport(dir, old, [entry('large', date, 'long '.repeat(200))], 'append'); assert.ok(job);
    let stopped = false;
    const ui = { select: async () => { throw new Error('UI closed'); }, input: async () => undefined,
      confirm: async () => false, notify: () => {}, setWidget: () => {} };
    await assert.rejects(showProgress({ ui }, job, async signal => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { stopped = true; resolve(); }, { once: true }));
    }, new AbortController().signal), /UI closed/);
    assert.equal(stopped, true);
    assert.equal(memoryDirectory(dir), dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('preparation source dialog receives shutdown cancellation before staging any data', async () => {
  const dir = temp(), memory = new Memory(dir, short), controller = new AbortController();
  try {
    const ui = { select: async (_title: string, _options: string[], opts?: { signal?: AbortSignal }) => {
      assert.equal(opts?.signal, controller.signal);
      return new Promise<undefined>(resolve => opts?.signal?.addEventListener('abort', () => resolve(undefined), { once: true }));
    }, input: async () => undefined, confirm: async () => false, notify: () => {}, setWidget: () => {}, custom: async () => { throw new Error('unexpected picker'); } };
    const task = chooseImport({ ui }, 'test', memory, 'fixture', controller.signal); controller.abort();
    assert.equal(await task, undefined); assert.equal(pendingImport(dir), undefined);
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});
