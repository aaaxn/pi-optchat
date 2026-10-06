import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { Memory, localDay, type Compressor } from '../src/memory.ts';
import { record } from '../src/cache.ts';
import { adapters, readConversation, timestamp, type Conversation, type ImportedEntry } from '../src/import/sources.ts';
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

test('Claude slash commands keep only typed arguments, local command output is dropped, and headers stay short', async () => {
  const dir = temp(), file = join(dir, 'claude.jsonl');
  const user = (uuid: string, content: string) => ({ type: 'user', uuid, sessionId: 'session-1', cwd: '/synthetic', timestamp: date, message: { role: 'user', content } });
  const reply = (uuid: string, text: string) => ({ type: 'assistant', uuid, timestamp: date, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
  lines(file, [
    user('compact', '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>'),
    user('stdout', '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>'),
    user('stderr', '<local-command-stderr>Unknown command</local-command-stderr>'),
    user('shell', '<bash-input>git status</bash-input>'),
    user('shell-out', '<bash-stdout>On branch main</bash-stdout><bash-stderr></bash-stderr>'),
    user('skill', '<command-message>oreo-mode</command-message>\n<command-name>/oreo-mode</command-name>\n<command-args>ship the parser fix</command-args>'),
    reply('a1', 'shipped'),
    user('plain', 'what is next?'),
    reply('a2', 'the docs'),
  ]);
  try {
    const source = { ...conversation('claude', file), id: 'cbcb64a5-871a-4179-a897-e3683852d011' };
    const parsed = await readConversation(source);
    assert.deepEqual(parsed.entries.map(e => e.text.slice(e.text.indexOf(']\n') + 2)), ['!git status', '/oreo-mode ship the parser fix', 'shipped', 'what is next?', 'the docs']);
    assert.equal(parsed.entries[0].text.split('\n')[0], '[Historical claude · 2026-01-02 12:00Z · cbcb64a5-871a · Fixture]', 'a short id the agent can glob for, no seconds');
    assert.equal(parsed.entries[0].origin?.conversation, source.id, 'the full id stays in the structured origin');
    assert.doesNotMatch(JSON.stringify(parsed.entries), /command-|bash-|Compacted|Unknown command|On branch/);
    // The receipt hashes the raw command, so a command imported before this filter is still recognized.
    const raw = '<command-message>oreo-mode</command-message>\n<command-name>/oreo-mode</command-name>\n<command-args>ship the parser fix</command-args>';
    assert.equal(parsed.entries[1].receipt, `import:${createHash('sha256').update(JSON.stringify(['claude', source.id, 'skill', 'user', raw])).digest('hex')}`);
    const scan = await adapters.claude.scan(dir);
    assert.equal(scan.conversations[0].title, '!git status', 'a bare command never becomes the title');
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
    const scan = await adapters.codex.scan(dir);
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
    const scan = await adapters.chatgpt.scan(dir); assert.equal(scan.conversations.length, 1);
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
    const scan = await adapters.claude.scan(dir);
    assert.deepEqual(scan.conversations.map(c => c.id), ['shared']);
    assert.deepEqual(scan.conversations.map(c => c.file), [parent]);
    assert.ok(scan.conversations.every(c => c.project === '/project' && c.date === date));
    const parsed = await readConversation(scan.conversations[0]);
    assert.equal(parsed.entries.length, 2);
    assert.match(parsed.entries[1].text, /Child reported useful findings/);
    assert.deepEqual(scan.warnings, []);
    await assert.rejects(adapters.claude.scan(dir, AbortSignal.abort()));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Claude discovery checks late sidechain markers without extending metadata extraction or Codex scanning', async () => {
  const dir = temp(), parent = join(dir, 'parent.jsonl'), child = join(dir, 'renamed-child.jsonl');
  const metadata = Array.from({ length: 60 }, () => ({ type: 'file-history-snapshot' }));
  const user = { type: 'user', sessionId: 'parent', cwd: '/project', timestamp: date, message: { role: 'user', content: 'Parent request' } };
  lines(parent, [user, ...metadata.slice(1), { type: 'custom-title', sessionId: 'later', cwd: '/later', customTitle: 'Later title' }]);
  lines(child, [...metadata, { ...user, isSidechain: true }]);
  try {
    const scan = await adapters.claude.scan(dir);
    assert.deepEqual(scan.conversations.map(c => c.file), [parent]);
    const { id, project, title, date: foundDate } = scan.conversations[0];
    assert.deepEqual({ id, project, title, date: foundDate }, { id: 'parent', project: '/project', title: 'Parent request', date });
    assert.deepEqual(scan.warnings, []);
    assert.equal((await readConversation(conversation('claude', child))).entries.length, 0);

    // Invalid JSON after line 60 would warn if Codex discovery read beyond its metadata budget.
    writeFileSync(parent, [JSON.stringify({ type: 'session_meta', payload: { id: 'codex-parent', cwd: '/project', source: 'cli', timestamp: date } }),
      ...metadata.slice(1).map(value => JSON.stringify(value)), 'not JSON'].join('\n') + '\n');
    rmSync(child);
    const codex = await adapters.codex.scan(dir);
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
    const scan = await adapters.claude.scan(dir);
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
    const scan = await adapters.claude.scan(dir);
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
    const scan = await adapters.chatgpt.scan(zip); assert.equal(scan.conversations.length, 1);
    const parsed = await readConversation(scan.conversations[0]); assert.equal(parsed.entries.length, 1);
    assert.match(parsed.entries[0].text, /zip fixture message/); assert.equal(existsSync(file), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Claude memories import each topic file once as a dated note, and an edited file as a newer note', async () => {
  const root = temp(), alpha = join(root, '-tmp-alpha'), beta = join(root, '-work-beta');
  for (const dir of [join(alpha, 'memory'), join(alpha, 'session', 'session-memory'), join(beta, 'memory')]) mkdirSync(dir, { recursive: true });
  lines(join(alpha, 'session.jsonl'), [{ type: 'user', cwd: '/tmp/alpha', message: { role: 'user', content: 'hi' } }]);
  writeFileSync(join(alpha, 'memory', 'MEMORY.md'), '- [Deploys](feedback_deploys.md) INDEX ONLY\n');
  writeFileSync(join(alpha, 'session', 'session-memory', 'summary.md'), 'SESSION SUMMARY\n');
  const deploys = join(alpha, 'memory', 'feedback_deploys.md');
  writeFileSync(deploys, '---\nname: Deploys\ndescription: "Never deploy on \\"Fridays\\""\ntype: feedback\nmodified: 2026-03-04T05:06:07.000Z\n---\nWait until Monday.\n');
  const pr = join(beta, 'memory', 'project_pr.md');
  writeFileSync(pr, '---\nname: PR status\ndescription: Tracking PR\nmetadata:\n  type: project\n---\nPR #7023 is open.\n');
  utimesSync(pr, new Date(date), new Date(date));
  try {
    const scan = await adapters['claude-memory'].scan(root);
    assert.deepEqual(scan.warnings, []);
    const read = async () => (await Promise.all(scan.conversations.map(c => readConversation(c)))).flatMap(p => p.entries);
    const first = await read();
    assert.deepEqual(first.map(e => [e.kind, e.date, e.origin?.project, e.origin?.title]), [
      ['note', '2026-03-04T05:06:07.000Z', '/tmp/alpha', 'Deploys'],
      ['note', date, '-work-beta', 'PR status'],
    ]);
    assert.equal(first[0].text, '[Historical Claude Code memory · 2026-03-04 05:06Z · project /tmp/alpha · type feedback · Deploys]\nNever deploy on "Fridays"\n\nWait until Monday.');
    assert.match(first[1].text, /project -work-beta · type project · PR status\]\nTracking PR\n\nPR #7023 is open\.$/);
    assert.doesNotMatch(JSON.stringify(first), /INDEX ONLY|SESSION SUMMARY/);
    const existing = first.map((e, i) => ({ ...e, i, size: 0 }));
    assert.deepEqual(deduplicate(existing, await read()), { added: [], skipped: 2 });
    writeFileSync(pr, readFileSync(pr, 'utf8').replace('is open', 'is merged'));
    const { added } = deduplicate(existing, await read());
    assert.equal(added.length, 1); assert.match(added[0].text, /PR #7023 is merged/); assert.ok(added[0].date > date, 'edited note is dated by the read, not the scan');
  } finally { rmSync(root, { recursive: true, force: true }); }
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

test('a time without a zone is UTC whatever the machine zone, and an out-of-range time falls back without throwing', () => {
  const zone = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  try {
    assert.equal(timestamp('2026-01-02T12:00:00', 'x'), '2026-01-02T12:00:00.000Z');
    assert.equal(timestamp('2026-01-02 12:00', 'x'), '2026-01-02T12:00:00.000Z');
    assert.equal(timestamp('2026-01-02T12:00:00-03:00', 'x'), '2026-01-02T15:00:00.000Z');
    assert.equal(timestamp(1767355200, 'x'), '2026-01-02T12:00:00.000Z');
    for (const bad of [1e13, -1e13, NaN, Infinity, 'not a time', undefined, null]) assert.equal(timestamp(bad, 'fallback'), 'fallback');
  } finally { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; }
});

test('a ChatGPT conversation with an empty or multi-line title gets a one-line header that falls back to its id', async () => {
  const dir = temp(), file = join(dir, 'conversations.json');
  const chat = (id: string, title: unknown) => ({ id, title, create_time: 1767355200, mapping: {
    u: { parent: null, message: { id: 'm', author: { role: 'user' }, create_time: 1767355200, content: { parts: ['hi'] } } } } });
  writeFileSync(file, JSON.stringify([chat('abc-def-ghi-jkl-mno', ''), chat('blank-title-0000-0000', '  \n '), chat('long-title-1111-1111', 'First line\nsecond   line ' + 'x'.repeat(200)), chat('missing-title-2222', undefined)]));
  try {
    const scan = await adapters.chatgpt.scan(dir);
    const headers = new Map<string, string>();
    for (const c of scan.conversations) headers.set(c.id, (await readConversation(c)).entries[0].text.split('\n')[0]);
    assert.equal(headers.get('abc-def-ghi-jkl-mno'), '[Historical chatgpt · 2026-01-02 12:00Z · abc-def-ghi-j · abc-def-ghi-jkl-mno]');
    assert.equal(headers.get('blank-title-0000-0000'), '[Historical chatgpt · 2026-01-02 12:00Z · blank-title-0 · blank-title-0000-0000]');
    assert.equal(headers.get('missing-title-2222'), '[Historical chatgpt · 2026-01-02 12:00Z · missing-title · missing-title-2222]');
    const long = headers.get('long-title-1111-1111') ?? '';
    assert.match(long, /^\[Historical chatgpt · 2026-01-02 12:00Z · long-title-11 · First line second line x+\]$/);
    assert.ok(long.length < 200);
    assert.ok(scan.conversations.every(c => c.title && !/\n/.test(c.title)));
    const origin = (await readConversation(scan.conversations.find(c => c.id === 'abc-def-ghi-jkl-mno')!)).entries[0].origin;
    assert.equal(origin?.title, 'abc-def-ghi-jkl-mno');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a resumed Claude transcript takes its id from its first record, so copied messages import once', async () => {
  const dir = temp();
  const user = (uuid: string, session: string, content: string) => ({ type: 'user', uuid, sessionId: session, cwd: '/project', timestamp: date, message: { role: 'user', content } });
  const reply = (uuid: string, session: string, content: string) => ({ type: 'assistant', uuid, sessionId: session, timestamp: date, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: content }] } });
  lines(join(dir, 'A.jsonl'), [user('u1', 'A', 'q1'), reply('a1', 'A', 'r1')]);
  lines(join(dir, 'B.jsonl'), [user('u1', 'A', 'q1'), reply('a1', 'A', 'r1'), user('u2', 'B', 'q2'), reply('a2', 'B', 'r2')]);
  try {
    const scan = await adapters.claude.scan(dir);
    assert.deepEqual(scan.conversations.map(c => c.id), ['A', 'A']);
    const all = (await Promise.all(scan.conversations.map(c => readConversation(c)))).flatMap(parsed => parsed.entries);
    assert.deepEqual(deduplicate([], all).added.map(e => e.text.split('\n')[1]), ['q1', 'r1', 'q2', 'r2']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const codexFixture = new URL('./fixtures/codex-rollout.jsonl', import.meta.url).pathname;
const receipt = (...identity: unknown[]) => `import:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;

test('Codex titles and entries skip the contextual messages Codex injects, and keep what the user typed', async () => {
  const dir = temp();
  copyFileSync(codexFixture, join(dir, 'rollout-2026-03-04T09-00-00.jsonl'));
  try {
    const scan = await adapters.codex.scan(dir);
    assert.equal(scan.conversations.length, 1);
    const [c] = scan.conversations;
    assert.deepEqual({ id: c.id, project: c.project, title: c.title, date: c.date },
      { id: '0199c0de-1111-7222-8333-444455556666', project: '/home/dev/synthetic-app', title: 'Add a --dry-run flag to the sync command.', date: '2026-03-04T09:00:02.000Z' });
    const parsed = await readConversation(c);
    assert.deepEqual(parsed.entries.map(e => [e.kind, e.origin?.message, e.text.slice(e.text.indexOf(']\n') + 2)]), [
      ['user', 'msg-1', 'Add a --dry-run flag to the sync command.'],
      ['talk', 'msg-2', 'Added --dry-run to sync.'],
      ['user', 'msg-3', 'Now document the flag in the README.'],
      ['talk', 'msg-4', 'Documented --dry-run in the README.'],
    ]);
    assert.equal(parsed.entries[0].text.split('\n')[0], '[Historical codex · 2026-03-04 09:00Z · 0199c0de-1111 · Add a --dry-run flag to the sync command.]');
    assert.doesNotMatch(JSON.stringify(parsed.entries), /AGENTS\.md|environment_context|user_shell_command|<skill>|hook_prompt|codex_internal_context|turn_aborted|subagent_notification|SECRET|Reading the sync/);
    assert.deepEqual(parsed.warnings, []);
    // Receipts hash the raw message, so a conversation imported before this filter is still recognized.
    const raw = '<environment_context>\n  <cwd>/home/dev/synthetic-app</cwd>\n</environment_context>\nNow document the flag in the README.';
    assert.equal(parsed.entries[2].receipt, receipt('codex', c.id, 'msg-3', 'user', raw));
    assert.equal(parsed.entries[0].receipt, receipt('codex', c.id, 'msg-1', 'user', 'Add a --dry-run flag to the sync command.'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex scaffold drops only the fragments Codex itself marks as injected context', () => {
  const { scaffold } = adapters.codex;
  for (const injected of [
    '# AGENTS.md instructions for /p\n\n<INSTRUCTIONS>\nbe nice\n</INSTRUCTIONS>', '# AGENTS.md instructions\n\n<INSTRUCTIONS>\nx\n</INSTRUCTIONS>',
    '<environment_context>\n<cwd>/p</cwd>\n</environment_context>', '  <ENVIRONMENT_CONTEXT>x</environment_context>  ', '<skill>\n<name>demo</name>\n</skill>',
    '<user_shell_command>\n<command>ls</command>\n</user_shell_command>', '<turn_aborted>\ninterrupted\n</turn_aborted>',
    '<subagent_notification>{}</subagent_notification>', '<hook_prompt hook_run_id="run-1">Retry</hook_prompt>', '<agent_message_board_notification>x</agent_message_board_notification>',
    '<recommended_plugins>\n- Drive\n</recommended_plugins>', '<codex_internal_context source="extension">\nsteer\n</codex_internal_context>',
    '<goal_context>\ngo\n</goal_context>', '<external_notes>value</external_notes>',
    'Warning: apply_patch was requested via exec_command. Use the apply_patch tool instead of exec_command.',
    'Warning: Your account was flagged for potentially high-risk cyber activity and routed to another model.',
    'Warning: The maximum number of unified exec processes you can keep open is 60.',
  ]) assert.equal(scaffold(injected), '', injected);
  for (const typed of [
    'fix the parser', '<project_context>\nbody\n</project_context>', '<environment_context>\nno closing tag', 'see the # AGENTS.md instructions for details',
    '<codex_internal_context source="Extension">\nbody\n</codex_internal_context>', '<hook_prompt>no run id</hook_prompt>', '<external_a>x</external_b>',
  ]) assert.equal(scaffold(typed), typed, typed);
  assert.equal(scaffold([{ type: 'input_text', text: '<environment_context>x</environment_context>' }, { type: 'input_text', text: 'real' }, { type: 'input_image' }]),
    'real\n[image attachment; image bytes are not imported]');
});

test('a ChatGPT conversation with a very long chain of replies imports in order, and a parent cycle is still rejected', async () => {
  const nodes = 20_000, mapping: Record<string, unknown> = {};
  for (let i = nodes - 1; i >= 0; i--) mapping[`n${i}`] = { parent: i ? `n${i - 1}` : null,
    message: { id: `m${i}`, author: { role: i % 2 ? 'assistant' : 'user' }, end_turn: true, content: { parts: [`message ${i}`] } } };
  const chat = (exported: Record<string, unknown>) => ({ ...conversation('chatgpt', 'export.json'), exported });
  const parsed = await readConversation(chat({ mapping, current_node: `n${nodes - 1}` }));
  assert.equal(parsed.entries.length, nodes + 1);
  assert.deepEqual(parsed.entries.slice(0, 3).map(e => e.origin?.message), ['m0', 'm1', 'm2']);
  assert.equal(parsed.entries.at(-1)?.origin?.message, 'export:selected-branch');
  const loop = { a: { parent: 'b', message: { author: { role: 'user' }, content: { parts: ['a'] } } }, b: { parent: 'a', message: { author: { role: 'user' }, content: { parts: ['b'] } } } };
  await assert.rejects(readConversation(chat({ mapping: loop })), /cycle in ChatGPT conversation mapping/);
});

test('a Claude memory with a folded or literal YAML description imports the text, not the indicator', async () => {
  const root = temp(), memory = join(root, '-tmp-alpha', 'memory'); mkdirSync(memory, { recursive: true });
  const note = (name: string, description: string) => writeFileSync(join(memory, `${name}.md`), `---\nname: ${name}\n${description}\ntype: user\n---\nbody of ${name}\n`);
  note('folded', 'description: >\n  a long\n  description: with a colon\n\n  second paragraph');
  note('literal', 'description: |-\n  first line\n  second line');
  note('plain', 'description: one line');
  try {
    const scan = await adapters['claude-memory'].scan(root);
    const texts = new Map<string, string[]>();
    for (const c of scan.conversations) texts.set(c.title, (await readConversation(c)).entries[0].text.split('\n'));
    assert.deepEqual(texts.get('folded')?.slice(1, 3), ['a long description: with a colon second paragraph', '']);
    assert.deepEqual(texts.get('literal')?.slice(1, 3), ['first line second line', '']);
    assert.deepEqual(texts.get('plain')?.slice(1, 3), ['one line', '']);
    for (const lines of texts.values()) assert.match(lines[0], /· type user · /, 'a key after the block still parses');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const repo = new URL('..', import.meta.url).pathname;

test('a source added to Origin without an adapter fails tsc', () => {
  const memory = join(repo, 'src/memory.ts'), sources = join(repo, 'src/import/sources.ts');
  const config = ts.getParsedCommandLineOfConfigFile(join(repo, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); } });
  assert.ok(config);
  const errors = (memoryText: string) => {
    const host = ts.createCompilerHost(config.options), getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, ...rest) => name === memory ? ts.createSourceFile(name, memoryText, languageVersion) : getSourceFile(name, languageVersion, ...rest);
    const program = ts.createProgram([sources], config.options, host);
    return ts.getPreEmitDiagnostics(program, program.getSourceFile(sources)).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  };
  const original = readFileSync(memory, 'utf8'), withFifth = original.replace("| 'chatgpt';", "| 'chatgpt' | 'slack';");
  assert.notEqual(withFifth, original);
  assert.deepEqual(errors(original), []);
  const failures = errors(withFifth);
  assert.match(failures[0], /does not satisfy the expected type 'Record<[^>]*"slack"[^>]*, Adapter>'[\s\S]*Property 'slack' is missing/);
});

test('lint rejects a comparison of an import source with a name outside the adapter table, and only under src/import', () => {
  const root = temp();
  for (const dir of ['src/import', 'test']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'src/import/branch.ts'), [
    "export const a = (c: { source: string }) => c.source === 'claude';",
    "export const b = (c: { source: string }) => 'codex' !== c.source;",
    "export const d = (c: { source: string }) => { switch (c.source) { case 'chatgpt': return 1; default: return 0; } };",
    "export const kept = (c: { source: string; id: string }, other: string) => c.source === other || c.id === 'claude' || other === 'claude';",
  ].join('\n') + '\n');
  writeFileSync(join(root, 'src/agents.ts'), "export const tell = (event: { source: string }) => event.source === 'extension';\n");
  try {
    const run = (() => { try { return execFileSync(process.execPath, ['--import', 'tsx', join(repo, 'scripts/lint.ts'), root], { cwd: repo, encoding: 'utf8' }); } catch (error) { return record(error) ? String(error.stdout) : ''; } })();
    const message = 'Per-source behavior lives in the adapter table in src/import/sources.ts.';
    assert.deepEqual(run.split('\n').filter(line => line.startsWith('src/')),
      [1, 2, 3].map(line => `src/import/branch.ts:${line} source-branch ${message}`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
