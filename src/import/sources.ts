import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { record } from '../cache.ts';
import { bytes, type Entry, type Kind, type Origin } from '../memory.ts';

export type Source = Origin['source'];
export type ImportedEntry = Omit<Entry, 'i' | 'size'>;
export interface Conversation {
  source: Source; id: string; file: string; title: string; project: string; date: string; size: number;
  exported?: Record<string, unknown>;
}
export interface Scan { conversations: Conversation[]; warnings: string[] }
export interface Read { entries: ImportedEntry[]; warnings: string[] }
export interface Adapter {
  label: string;
  /** What the memory browser calls this source in "imported from ...". */
  browserLabel: string;
  words: { plural: string; singular: string; item: string; preview: string };
  byProject: boolean;
  input?: string;
  /** `location` is the path the user typed, or a folder that replaces the default one. */
  scan(location: string | undefined, signal?: AbortSignal): Promise<Scan>;
  entries(c: Conversation, signal?: AbortSignal): Promise<Read>;
  /** What the user typed in a user message: '' when it holds only this source's own scaffolding. */
  scaffold(content: unknown): string;
}
const exec = promisify(execFile);
const string = (v: unknown) => typeof v === 'string' ? v : undefined;
const codexSubagent = ({ source }: Record<string, unknown>) => source === 'subagent' || record(source) && 'subagent' in source;
const missingSource = (error: unknown) => record(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
const missingWarning = (file: string) => `${file}: source file is no longer available; conversation skipped. Rescan to retry if it returns.`;
const zoneless = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;
/** A time without a zone is UTC, not the machine's zone. A number above 1e11 is milliseconds (1e11 seconds is the year 5138). */
export function timestamp(value: unknown, fallback: string): string {
  const time = typeof value === 'number' ? (value > 1e11 ? value : value * 1000) : typeof value === 'string' ? Date.parse(value.trim().replace(zoneless, '$1T$2Z')) : NaN;
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}
/** Header time: minutes are enough to place a message, and the rest of an ISO stamp costs summary bytes. */
const minute = (date: string) => `${date.slice(0, 16).replace('T', ' ')}Z`;
const titleOf = (title: string | undefined, id: string) => (title ?? '').replace(/\s+/g, ' ').trim().slice(0, 110) || id;
const byRecent = (conversations: Conversation[]) => conversations.sort((a, b) => b.date.localeCompare(a.date));
/**
 * Claude Code logs slash commands, `!` shell commands, and their local output as user messages. Returns undefined
 * for anything else, '' for scaffolding to drop, or what the user typed (`/name args`, `!command`), a real request.
 */
function claudeCommand(content: string): string | undefined {
  const s = content.trimStart();
  if (/^<(local-command|bash)-(stdout|stderr)>/.test(s)) return '';
  const shell = /^<bash-input>([\s\S]*?)<\/bash-input>/.exec(s)?.[1].trim();
  if (shell !== undefined) return shell && `!${shell}`;
  if (!/^<command-(name|message|args)>/.test(s)) return undefined;
  const name = /<command-name>([^<]*)<\/command-name>/.exec(s)?.[1].trim(), args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s)?.[1].trim();
  return name && args ? `${name} ${args}` : '';
}
const tagged = (tag: string, open = `<${tag}>`) => new RegExp(`^${open}[\\s\\S]*</${tag}>$`, 'i');
/** The messages Codex itself recognizes as context it injected, not typed by the user (codex-rs core/src/context/contextual_user_message.rs). */
const codexContext = [
  tagged('INSTRUCTIONS', '# AGENTS\\.md instructions'), tagged('environment_context'), tagged('user_shell_command'), tagged('turn_aborted'),
  tagged('subagent_notification'), tagged('skill'), tagged('agent_message_board_notification'), tagged('recommended_plugins'), tagged('goal_context'),
  tagged('hook_prompt', '<hook_prompt hook_run_id="[^"]+">'), /^<codex_internal_context source="[a-z][a-z0-9_]*">[\s\S]*<\/codex_internal_context>$/,
  /^<external_([^>]+)>[\s\S]*<\/external_\1>$/i,
  /^Warning: apply_patch was requested via [\s\S]*Use the apply_patch tool instead of exec_command\.$/,
  /^Warning: Your account was flagged for potentially high-risk cyber activity/,
  /^Warning: The maximum number of unified exec processes you can keep open is/,
];
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n');
  if (!record(value)) return '';
  if (['thinking', 'redacted_thinking', 'reasoning', 'encrypted_content'].includes(String(value.type))) return '';
  if (typeof value.text === 'string') return value.text;
  if (['image', 'image_url', 'input_image', 'image_asset_pointer'].includes(String(value.type ?? value.content_type))) return '[image attachment; image bytes are not imported]';
  if (value.content !== undefined) return text(value.content);
  if (value.parts !== undefined) return text(value.parts);
  if (typeof value.content_type === 'string') return `[${value.content_type} attachment; binary content is not imported]`;
  return '';
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
function imported(c: Conversation, id: string, kind: Kind, content: string, date: string, identity = content, conversation = c.id): ImportedEntry | undefined {
  if (!content.trim()) return undefined;
  // Text provenance survives compression. Stable per-message receipts survive moved files and repeated exports.
  const origin: Origin = { source: c.source, conversation, message: id, title: c.title, project: c.project };
  // The agent reads only text, so the id's first 13 characters stay in it: enough to find a Claude or Codex transcript by
  // glob. Codex ids are UUIDv7, whose first 8 characters are a coarse timestamp shared by many sessions.
  return { kind, date, origin, text: `[Historical ${c.source} · ${minute(date)} · ${c.id.slice(0, 13)} · ${titleOf(c.title, c.id)}]\n${content}`,
    receipt: `import:${digest(JSON.stringify([c.source, conversation, id, kind, identity]))}` };
}
async function* jsonLines(file: string, warnings: string[], limit = Infinity, signal?: AbortSignal) {
  const stream = createReadStream(file, { encoding: 'utf8', signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of lines) {
      n++; if (!line.trim()) continue;
      try { const value: unknown = JSON.parse(line); if (record(value)) yield { value, line: n }; }
      catch { warnings.push(`${file}:${n}: invalid JSON record skipped`); }
      if (n >= limit) break;
    }
  } finally { lines.close(); stream.destroy(); }
}
type Records = AsyncGenerator<{ value: Record<string, unknown>; line: number }>;
async function filesUnder(path: string, accept: (name: string) => boolean, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const entries = await readdir(path, { withFileTypes: true }).catch(error => {
    if (record(error) && error.code === 'ENOENT') return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) files.push(...await filesUnder(join(path, entry.name), accept, signal));
    else if (entry.isFile() && accept(entry.name)) files.push(join(path, entry.name));
  }
  return files.sort();
}

interface Meta { id: string; project: string; date: string; title: string }
interface Transcripts {
  folders: string[]; accept(name: string): boolean; skip?(folder: string, file: string): boolean;
  limit: number; meta(records: Records, meta: Meta): Promise<Meta | undefined>;
}
async function scanTranscripts(source: 'claude' | 'codex', t: Transcripts, signal?: AbortSignal): Promise<Scan> {
  const conversations: Conversation[] = [], warnings: string[] = [];
  for (const folder of t.folders) for (const file of await filesUnder(folder, t.accept, signal)) {
    signal?.throwIfAborted();
    if (t.skip?.(folder, file)) continue;
    try {
      const info = await stat(file);
      const meta = await t.meta(jsonLines(file, warnings, t.limit, signal), { id: basename(file, '.jsonl'), project: dirname(file), date: info.mtime.toISOString(), title: '' });
      if (meta) conversations.push({ source, file, ...meta, title: meta.title || meta.id, size: info.size });
    } catch (error) {
      signal?.throwIfAborted();
      if (!missingSource(error)) throw error;
      warnings.push(missingWarning(file));
    }
  }
  return { conversations: byRecent(conversations), warnings };
}
/** Replies wait in `pending` until something marks them final, so a tool loop's progress text never reaches memory. */
function turns(c: Conversation) {
  const entries: ImportedEntry[] = [];
  let pending: ImportedEntry[] = [];
  const finish = () => { entries.push(...pending); pending = []; };
  return {
    entries, finish,
    reset: () => { pending = []; },
    add(id: string, kind: Kind, content: string, date: string, identity = content, conversation?: string) { const entry = imported(c, id, kind, content, date, identity, conversation); if (entry) entries.push(entry); },
    assistant(parts: { id: string; content: string }[], date: string, final: boolean, conversation?: string) {
      pending = parts.flatMap(part => { const entry = imported(c, part.id, 'talk', part.content, date, part.content, conversation); return entry ? [entry] : []; });
      if (final) finish();
    },
  };
}
type Turns = ReturnType<typeof turns>;
async function readTranscript(c: Conversation, signal: AbortSignal | undefined, step: (v: Record<string, unknown>, line: number, date: string, t: Turns, warnings: string[]) => 'drop' | void): Promise<Read> {
  const warnings: string[] = [], t = turns(c);
  try {
    for await (const { value, line } of jsonLines(c.file, warnings, Infinity, signal)) {
      if (step(value, line, timestamp(value.timestamp, c.date), t, warnings) === 'drop') return { entries: [], warnings };
    }
    t.finish(); // Older exports may omit explicit final markers; retain only the last text reply.
  } catch (error) {
    signal?.throwIfAborted();
    if (!missingSource(error)) throw error;
    return { entries: [], warnings: [...warnings, missingWarning(c.file)] };
  }
  return { entries: t.entries, warnings };
}

const claudeScaffold = (content: unknown) => { const typed = text(content); return claudeCommand(typed) ?? typed; };
const claude: Adapter = {
  label: 'Claude Code',
  browserLabel: 'Claude Code',
  words: { plural: 'Conversations', singular: 'Conversation', item: 'messages', preview: 'Historical user messages and final replies; tool activity excluded.' },
  byProject: true,
  scaffold: claudeScaffold,
  scan: (location, signal) => scanTranscripts('claude', {
    folders: [location ?? join(homedir(), '.claude/projects')], limit: Infinity,
    // Claude workflow journals contain orchestration events, not conversation messages.
    accept: name => name.endsWith('.jsonl') && name !== 'journal.jsonl',
    // Import user conversations, not separate delegated runs (including Claude's older flat layout).
    skip: (folder, file) => relative(folder, dirname(file)).split(/[\\/]/).includes('subagents') || basename(file).startsWith('agent-'),
    async meta(records, meta) {
      for await (const { value: v, line } of records) {
        // Sidechain markers can appear late; picker metadata still comes from the first 60 lines.
        if (v.isSidechain === true) return undefined;
        if (line > 60) continue;
        meta.project = string(v.cwd) ?? meta.project;
        if (v.type === 'custom-title' || v.type === 'ai-title') meta.title = string(v.customTitle ?? v.aiTitle) ?? meta.title;
        const typed = record(v.message) && v.message.role === 'user' && !meta.title ? claudeScaffold(v.message.content) : '';
        if (typed.trim()) { meta.title = typed.replace(/\s+/g, ' ').slice(0, 110); meta.date = timestamp(v.timestamp, meta.date); }
      }
      return meta;
    },
  }, signal),
  entries: (c, signal) => readTranscript(c, signal, (v, line, date, t, warnings) => {
    // Context replay and compaction scaffolding are not new user requests.
    if (v.type === 'system' && v.subtype === 'compact_boundary') { t.reset(); return; }
    if (v.isMeta === true || v.isCompactSummary === true) return;
    if (v.isSidechain === true) return 'drop';
    if (!['user', 'assistant'].includes(String(v.type)) || !record(v.message)) return;
    const m = v.message, id = string(v.uuid) ?? `line:${line}`, session = string(v.sessionId);
    if (m.role === 'user' && typeof m.content === 'string' && /^\[Request interrupted by user(?: for tool use)?\]$/.test(m.content)) { t.reset(); return; }
    const blocks = Array.isArray(m.content) ? m.content : [];
    const toolActivity = blocks.some(b => record(b) && (['tool_use', 'server_tool_use', 'tool_result'].includes(String(b.type)) || String(b.type).endsWith('_tool_result')));
    if (toolActivity) t.reset();
    const parts = typeof m.content === 'string' ? [{ id, content: m.content }] : blocks.flatMap((b, index) => {
      if (!record(b)) return [];
      if (['text', 'image', 'image_url', 'document'].includes(String(b.type))) {
        const content = b.type === 'document' ? '[document attachment; binary content is not imported]' : text(b);
        return content ? [{ id: `${id}:${index}`, content }] : [];
      }
      if (!['tool_use', 'server_tool_use', 'tool_result', 'thinking', 'redacted_thinking', 'reasoning', 'encrypted_content'].includes(String(b.type)) && !String(b.type).endsWith('_tool_result'))
        warnings.push(`${c.file}:${line}: unsupported Claude content block ${String(b.type)} skipped`);
      return [];
    });
    // Receipts keep the raw text, so a command already imported is still recognized.
    if (m.role === 'user' && parts.length) { t.finish(); for (const part of parts) t.add(part.id, 'user', claudeScaffold(part.content), date, part.content, session); }
    else if (m.role === 'assistant') {
      const final = m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence';
      if (toolActivity || v.isApiErrorMessage === true || m.stop_reason && !final) t.reset();
      else if (parts.length) t.assistant(parts, date, final, session);
      else if (!final) t.reset();
    }
  }),
};

const codexScaffold = (content: unknown) => (Array.isArray(content) ? content : [content]).map(text).filter(piece => piece && !codexContext.some(re => re.test(piece.trim()))).join('\n');
const codex: Adapter = {
  label: 'Codex',
  browserLabel: 'Codex',
  words: claude.words,
  byProject: true,
  scaffold: codexScaffold,
  scan: (location, signal) => scanTranscripts('codex', {
    folders: location ? [location] : [join(homedir(), '.codex/sessions'), join(homedir(), '.codex/archived_sessions')], limit: 60,
    accept: name => name.endsWith('.jsonl'),
    async meta(records, meta) {
      for await (const { value: v } of records) {
        if (v.type === 'session_meta' && record(v.payload)) {
          if (codexSubagent(v.payload)) return undefined;
          meta.id = string(v.payload.id) ?? meta.id; meta.project = string(v.payload.cwd) ?? meta.project; meta.date = timestamp(v.payload.timestamp ?? v.timestamp, meta.date);
        }
        const typed = v.type === 'response_item' && record(v.payload) && v.payload.role === 'user' && !meta.title ? codexScaffold(v.payload.content) : '';
        if (typed.trim()) { meta.title = typed.replace(/\s+/g, ' ').slice(0, 110); meta.date = timestamp(v.timestamp, meta.date); }
      }
      return meta;
    },
  }, signal),
  entries: (c, signal) => readTranscript(c, signal, (v, line, date, t, warnings) => {
    if (v.type === 'session_meta' && record(v.payload) && codexSubagent(v.payload)) return 'drop';
    if (v.type === 'event_msg' && record(v.payload)) {
      if (v.payload.type === 'task_complete') t.finish();
      if (['turn_aborted', 'task_started', 'task_failed'].includes(String(v.payload.type))) t.reset();
    }
    if (v.type === 'response_item' && record(v.payload)) {
      const m = v.payload, id = string(m.id) ?? string(m.call_id) ?? `line:${line}`;
      if (m.type === 'message' && m.role === 'user') { t.finish(); t.add(id, 'user', codexScaffold(m.content), date, text(m.content)); }
      else if (m.type === 'message' && m.role === 'assistant') {
        t.reset();
        const channel = m.channel ?? m.phase;
        const final = channel === 'final' || channel === 'final_answer';
        if (!channel || final) t.assistant([{ id, content: text(m.content) }], date, final);
      } else if (['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output', 'web_search_call', 'image_generation_call', 'local_shell_call', 'agent_message'].includes(String(m.type))) t.reset();
      else if (!['message', 'reasoning'].includes(String(m.type))) { t.reset(); warnings.push(`${c.file}:${line}: unsupported response item ${String(m.type)} skipped`); }
    }
  }),
};

const chatgpt: Adapter = {
  label: 'ChatGPT export',
  browserLabel: 'ChatGPT',
  words: claude.words,
  byProject: false,
  input: 'ChatGPT export ZIP, extracted folder, or conversations JSON path',
  scaffold: text,
  async scan(location, signal) {
    if (!location) throw new Error('Select a ChatGPT export ZIP, extracted folder, or JSON file.');
    const path = resolve(location.startsWith('~/') ? join(homedir(), location.slice(2)) : location);
    const info = await stat(path);
    const documents: { file: string; content: string }[] = [];
    const accept = (name: string) => /^conversations(?:[-_]?\d+)?\.json$/i.test(basename(name));
    if (info.isDirectory()) {
      for (const file of await filesUnder(path, accept, signal)) documents.push({ file, content: await readFile(file, { encoding: 'utf8', signal }) });
    } else if (path.toLowerCase().endsWith('.zip')) {
      const listing = await exec('unzip', ['-Z1', path], { signal, maxBuffer: 10_000_000 });
      for (const name of listing.stdout.split('\n').filter(accept)) {
        const result = await exec('unzip', ['-p', path, name], { signal, maxBuffer: 1_000_000_000 });
        documents.push({ file: `${path}:${name}`, content: result.stdout });
      }
    } else documents.push({ file: path, content: await readFile(path, { encoding: 'utf8', signal }) });
    if (!documents.length) throw new Error('No conversations.json or numbered conversation JSON files found. Select a ChatGPT export ZIP, extracted folder, or JSON file.');
    const conversations: Conversation[] = [], warnings: string[] = [];
    for (const doc of documents) {
      const data: unknown = JSON.parse(doc.content);
      if (!Array.isArray(data)) throw new Error(`${doc.file}: expected an array of exported ChatGPT conversations.`);
      for (const value of data) {
        if (!record(value) || !record(value.mapping) || typeof (value.id ?? value.conversation_id) !== 'string') {
          warnings.push(`${doc.file}: unrecognized conversation skipped`); continue;
        }
        const id = String(value.id ?? value.conversation_id);
        conversations.push({ source: 'chatgpt', id, file: doc.file, title: titleOf(string(value.title), id),
          project: 'ChatGPT', date: timestamp(value.create_time, info.mtime.toISOString()), size: bytes(JSON.stringify(value)), exported: value });
      }
    }
    return { conversations: byRecent(conversations), warnings };
  },
  async entries(c, signal) {
    const entries: ImportedEntry[] = [];
    const add = (id: string, kind: Kind, value: string, date: string, identity = value) => { const entry = imported(c, id, kind, value, date, identity); if (entry) entries.push(entry); };
    const mapping = c.exported?.mapping;
    if (!record(mapping)) throw new Error('ChatGPT conversation has no message mapping.');
    // Include every branch once. Parent-first order handles missing child timestamps.
    const nodes = Object.entries(mapping).filter((pair): pair is [string, Record<string, unknown>] => record(pair[1]));
    nodes.sort((a, b) => timestamp(record(a[1].message) ? a[1].message.create_time : undefined, c.date)
      .localeCompare(timestamp(record(b[1].message) ? b[1].message.create_time : undefined, c.date)));
    const ordered: typeof nodes = [], visited = new Set<string>();
    for (const first of nodes) {
      const chain: typeof nodes = [], inChain = new Set<string>();
      let link: (typeof nodes)[number] | undefined = first;
      while (link && !visited.has(link[0])) {
        const [key, node]: (typeof nodes)[number] = link;
        if (inChain.has(key)) throw new Error(`${c.title}: cycle in ChatGPT conversation mapping.`);
        inChain.add(key); chain.push(link);
        const parent = typeof node.parent === 'string' ? mapping[node.parent] : undefined;
        link = typeof node.parent === 'string' && record(parent) ? [node.parent, parent] : undefined;
      }
      for (const done of chain.reverse()) { visited.add(done[0]); ordered.push(done); }
    }
    const selected = new Set<string>();
    let cursor = string(c.exported?.current_node);
    const hasSelectedBranch = !!cursor;
    while (cursor && !selected.has(cursor)) {
      const node = mapping[cursor]; if (!record(node)) break;
      selected.add(cursor); cursor = string(node.parent);
    }
    const dates = new Map<string, string>();
    // For legacy exports without final/end_turn markers, exclude replies followed by
    // more assistant/tool work before the next user message, on the same branch.
    const intermediate = new Set<string>();
    for (const [, node] of ordered) {
      if (!record(node.message) || !record(node.message.author) || !['assistant', 'tool'].includes(String(node.message.author.role))) continue;
      let parent = string(node.parent);
      while (parent) {
        const ancestor = mapping[parent]; if (!record(ancestor)) break;
        if (record(ancestor.message) && record(ancestor.message.author) && ancestor.message.author.role === 'user') break;
        if (intermediate.has(parent)) break;
        intermediate.add(parent); parent = string(ancestor.parent);
      }
    }
    for (const [key, node] of ordered) {
      signal?.throwIfAborted();
      const m = node.message;
      const date = timestamp(record(m) ? m.create_time : undefined, dates.get(String(node.parent)) ?? c.date);
      dates.set(key, date);
      if (!record(m) || !record(m.author) || !['user', 'assistant'].includes(String(m.author.role))) continue;
      if (m.channel === 'analysis' || m.channel === 'commentary'
        || m.recipient && m.recipient !== 'all'
        || record(m.content) && ['thoughts', 'reasoning', 'reasoning_recap'].includes(String(m.content.content_type))) continue;
      const kind = m.author.role === 'user' ? 'user' : 'talk';
      if (kind === 'talk' && (m.status && m.status !== 'finished_successfully'
        || m.end_turn === false || m.channel !== 'final' && m.end_turn !== true && intermediate.has(key))) continue;
      const content = kind === 'user' ? chatgpt.scaffold(m.content) : text(m.content); if (!content) continue;
      const branch = hasSelectedBranch ? selected.has(key) ? 'selected branch at export' : 'alternate branch, not the selected outcome' : 'branch selection unavailable';
      add(string(m.id) ?? key, kind, `[message ${key}; parent ${String(node.parent ?? 'root')}; ${branch}${m.recipient ? `; recipient ${String(m.recipient)}` : ''}]\n${content}`, date, content);
    }
    if (hasSelectedBranch) {
      const snapshot = timestamp(c.exported?.update_time, c.date);
      add('export:selected-branch', 'note', `Selected ChatGPT branch in the ${snapshot} export snapshot ends at message ${String(c.exported?.current_node)}. Other branches are alternatives.`, snapshot);
    }
    return { entries, warnings: [] };
  },
};

/** Claude Code auto memory: one note per topic file. MEMORY.md is only an index of those files. */
const claudeMemory: Adapter = {
  label: 'Claude Code memories',
  browserLabel: 'Claude Code memory',
  words: { plural: 'Memories', singular: 'Memory', item: 'notes', preview: 'Each memory file as one dated historical note; MEMORY.md indexes excluded.' },
  byProject: true,
  scaffold: text,
  async scan(location, signal) {
    const root = location ?? join(homedir(), '.claude/projects');
    const conversations: Conversation[] = [], warnings: string[] = [];
    const dirs = await readdir(root, { withFileTypes: true }).catch(error => { if (missingSource(error)) return []; throw error; });
    for (const dir of dirs.filter(d => d.isDirectory()).map(d => d.name).sort()) {
      signal?.throwIfAborted();
      const folder = join(root, dir, 'memory');
      const files = (await readdir(folder, { withFileTypes: true }).catch(error => { if (missingSource(error)) return []; throw error; }))
        .filter(f => f.isFile() && f.name.endsWith('.md') && f.name !== 'MEMORY.md').map(f => f.name).sort();
      if (!files.length) continue;
      const project = await claudeProject(join(root, dir), dir, signal);
      for (const name of files) {
        const file = join(folder, name);
        try {
          const [info, content] = await Promise.all([stat(file), readFile(file, { encoding: 'utf8', signal })]);
          const { fields } = frontmatter(content);
          conversations.push({ source: 'claude-memory', id: `${dir}/${name}`, file, project, size: info.size,
            title: fields.get('name') ?? basename(name, '.md'), date: timestamp(fields.get('modified'), info.mtime.toISOString()) });
        } catch (error) {
          signal?.throwIfAborted();
          if (!missingSource(error)) throw error;
          warnings.push(`${file}: memory file is no longer available; skipped.`);
        }
      }
    }
    return { conversations: byRecent(conversations), warnings };
  },
  async entries(c, signal) {
    let content: string, modified: Date;
    try { [content, { mtime: modified }] = await Promise.all([readFile(c.file, { encoding: 'utf8', signal }), stat(c.file)]); } catch (error) {
      signal?.throwIfAborted();
      if (!missingSource(error)) throw error;
      return { entries: [], warnings: [`${c.file}: memory file is no longer available; skipped.`] };
    }
    const { fields, body } = frontmatter(content);
    if (!body.trim()) return { entries: [], warnings: [] };
    const one = (s: string) => s.replace(/\s+/g, ' ').trim();
    const name = one(fields.get('name') ?? c.title), type = fields.get('type'), description = fields.get('description');
    // The whole file is the identity, so an edited memory arrives as a newer note and an unchanged one is skipped.
    const hash = digest(content);
    // Date the note from this read, not the earlier scan, in case Claude edited the file meanwhile.
    const date = timestamp(fields.get('modified'), modified.toISOString());
    return { warnings: [], entries: [{ kind: 'note', date,
      origin: { source: c.source, conversation: c.id, message: hash.slice(0, 16), title: name, project: c.project },
      text: `[Historical Claude Code memory · ${minute(date)} · project ${c.project}${type ? ` · type ${one(type)}` : ''} · ${name}]\n${description ? one(description) + '\n\n' : ''}${body.trim()}`,
      receipt: `import:${digest(JSON.stringify([c.source, c.id, hash]))}` }] };
  },
};
/** Claude names project folders after the launch directory with every other character replaced by '-'. Recover it from a transcript. */
async function claudeProject(folder: string, name: string, signal?: AbortSignal): Promise<string> {
  const transcripts = (await readdir(folder)).filter(f => f.endsWith('.jsonl')).sort();
  for (const transcript of transcripts) {
    try {
      for await (const { value } of jsonLines(join(folder, transcript), [], 60, signal)) {
        const cwd = string(value.cwd);
        if (cwd && cwd.replace(/[^a-zA-Z0-9]/g, '-') === name) return cwd;
      }
    } catch (error) { signal?.throwIfAborted(); if (!missingSource(error)) throw error; }
  }
  return name; // Transcripts can be cleaned up while memory remains.
}
function frontmatter(content: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  const fields = new Map<string, string>();
  const lines = match ? match[1].split(/\r?\n/) : [];
  for (let i = 0; i < lines.length; i++) {
    // Newer files nest type/modified under `metadata:`; the first occurrence of each key wins.
    const m = /^(\s*)([A-Za-z]+):\s*(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    let value: string;
    if (/^[>|][+-]?\d?$/.test(m[3])) {
      let end = i + 1;
      while (end < lines.length && (!lines[end].trim() || lines[end].search(/\S/) > m[1].length)) end++;
      value = lines.slice(i + 1, end).map(line => line.trim()).join(m[3].startsWith('>') ? ' ' : '\n').trim();
      i = end - 1;
    } else value = unquote(m[3]);
    if (value && !fields.has(m[2])) fields.set(m[2], value);
  }
  return { fields, body: match ? content.slice(match[0].length) : content };
}
function unquote(value: string): string {
  if (value.startsWith('"')) { try { const parsed: unknown = JSON.parse(value); if (typeof parsed === 'string') return parsed; } catch { /* plain text */ } }
  if (/^'.*'$/.test(value)) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

export const adapters = { claude, 'claude-memory': claudeMemory, codex, chatgpt } satisfies Record<Source, Adapter>;
export const sources = Object.keys(adapters).filter((key): key is Source => key in adapters);
export async function readConversation(c: Conversation, signal?: AbortSignal): Promise<Read> {
  signal?.throwIfAborted();
  const { entries, warnings } = await adapters[c.source].entries(c, signal);
  return { entries: [...new Map(entries.map(e => [e.receipt, e])).values()], warnings };
}
