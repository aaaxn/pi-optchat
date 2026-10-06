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
const exec = promisify(execFile);
const string = (v: unknown) => typeof v === 'string' ? v : undefined;
const codexSubagent = (metadata: Record<string, unknown>) => metadata.source === 'subagent'
  || record(metadata.source) && 'subagent' in metadata.source;
const missingSource = (error: unknown) => record(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
const missingWarning = (file: string) => `${file}: source file is no longer available; conversation skipped. Rescan to retry if it returns.`;
export function timestamp(value: unknown, fallback: string): string {
  const time = typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}
/** Header time: minutes are enough to place a message, and the rest of an ISO stamp costs summary bytes. */
const minute = (date: string) => `${date.slice(0, 16).replace('T', ' ')}Z`;
/**
 * Claude Code logs slash commands, `!` shell commands, and their local output as user messages. Returns undefined
 * for anything else, '' for scaffolding to drop, or what the user typed (`/name args`, `!command`), a real request.
 */
export function claudeCommand(content: string): string | undefined {
  const s = content.trimStart();
  if (/^<(local-command|bash)-(stdout|stderr)>/.test(s)) return '';
  const shell = /^<bash-input>([\s\S]*?)<\/bash-input>/.exec(s)?.[1].trim();
  if (shell !== undefined) return shell && `!${shell}`;
  if (!/^<command-(name|message|args)>/.test(s)) return undefined;
  const name = /<command-name>([^<]*)<\/command-name>/.exec(s)?.[1].trim(), args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s)?.[1].trim();
  return name && args ? `${name} ${args}` : '';
}
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
function imported(c: Conversation, id: string, kind: Kind, content: string, date: string, identity = content): ImportedEntry | undefined {
  if (!content.trim()) return undefined;
  // Text provenance survives compression. Stable per-message receipts survive moved files and repeated exports.
  const origin: Origin = { source: c.source, conversation: c.id, message: id, title: c.title, project: c.project };
  return { kind, date, origin, text: `[Historical ${c.source} · ${minute(date)} · ${c.title}]\n${content}`,
    receipt: `import:${digest(JSON.stringify([c.source, c.id, id, kind, identity]))}` };
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
export async function scanLocal(source: 'claude' | 'codex', roots?: string[], signal?: AbortSignal): Promise<Scan> {
  const folders = roots ?? (source === 'claude' ? [join(homedir(), '.claude/projects')]
    : [join(homedir(), '.codex/sessions'), join(homedir(), '.codex/archived_sessions')]);
  const conversations: Conversation[] = [], warnings: string[] = [];
  // Claude workflow journals contain orchestration events, not conversation messages.
  for (const folder of folders) for (const file of await filesUnder(folder, n => n.endsWith('.jsonl') && !(source === 'claude' && n === 'journal.jsonl'), signal)) {
    signal?.throwIfAborted();
    // Import user conversations, not separate delegated runs (including Claude's older flat layout).
    if (source === 'claude' && (relative(folder, dirname(file)).split(/[\\/]/).includes('subagents') || basename(file).startsWith('agent-'))) continue;
    try {
      const info = await stat(file);
      let id = basename(file, '.jsonl'), project = dirname(file), date = info.mtime.toISOString(), title = '';
      let sidechain = false;
      for await (const { value: v, line } of jsonLines(file, warnings, source === 'claude' ? Infinity : 60, signal)) {
        // Sidechain markers can appear late; picker metadata still comes from the first 60 lines.
        if (source === 'claude' && v.isSidechain === true) { sidechain = true; break; }
        if (line > 60) continue;
        if (source === 'codex' && v.type === 'session_meta' && record(v.payload)) {
          if (codexSubagent(v.payload)) { sidechain = true; break; }
          id = string(v.payload.id) ?? id; project = string(v.payload.cwd) ?? project; date = timestamp(v.payload.timestamp ?? v.timestamp, date);
        }
        if (source === 'claude') {
          id = string(v.sessionId) ?? id;
          project = string(v.cwd) ?? project;
          if (v.type === 'custom-title' || v.type === 'ai-title') title = string(v.customTitle ?? v.aiTitle) ?? title;
        }
        const m = source === 'claude' ? v.message : v.type === 'response_item' ? v.payload : undefined;
        const typed = record(m) && m.role === 'user' && !title ? text(m.content) : '';
        const first = source === 'claude' ? claudeCommand(typed) ?? typed : typed;
        if (first.trim()) {
          title = first.replace(/\s+/g, ' ').slice(0, 110);
          date = timestamp(v.timestamp, date);
        }
      }
      if (sidechain) continue;
      conversations.push({ source, file, id, project, date, title: title || id, size: info.size });
    } catch (error) {
      signal?.throwIfAborted();
      if (!missingSource(error)) throw error;
      warnings.push(missingWarning(file));
    }
  }
  return { conversations: conversations.sort((a, b) => b.date.localeCompare(a.date)), warnings };
}
export async function scanChatGPT(input: string, signal?: AbortSignal): Promise<Scan> {
  const path = resolve(input.startsWith('~/') ? join(homedir(), input.slice(2)) : input);
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
      conversations.push({ source: 'chatgpt', id, file: doc.file, title: string(value.title) ?? id,
        project: 'ChatGPT', date: timestamp(value.create_time, info.mtime.toISOString()), size: bytes(JSON.stringify(value)), exported: value });
    }
  }
  return { conversations: conversations.sort((a, b) => b.date.localeCompare(a.date)), warnings };
}

/** Claude Code auto memory: one note per topic file. MEMORY.md is only an index of those files. */
export async function scanClaudeMemories(root = join(homedir(), '.claude/projects'), signal?: AbortSignal): Promise<Scan> {
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
  return { conversations: conversations.sort((a, b) => b.date.localeCompare(a.date)), warnings };
}
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
  for (const line of match ? match[1].split(/\r?\n/) : []) {
    // Newer files nest type/modified under `metadata:`; the first occurrence of each key wins.
    const m = /^\s*([A-Za-z]+):\s*(.+?)\s*$/.exec(line);
    if (m && !fields.has(m[1])) fields.set(m[1], unquote(m[2]));
  }
  return { fields, body: match ? content.slice(match[0].length) : content };
}
function unquote(value: string): string {
  if (value.startsWith('"')) { try { const parsed: unknown = JSON.parse(value); if (typeof parsed === 'string') return parsed; } catch { /* plain text */ } }
  if (/^'.*'$/.test(value)) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}
async function readMemory(c: Conversation, signal?: AbortSignal): Promise<{ entries: ImportedEntry[]; warnings: string[] }> {
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
}

export async function readConversation(c: Conversation, signal?: AbortSignal): Promise<{ entries: ImportedEntry[]; warnings: string[] }> {
  signal?.throwIfAborted();
  if (c.source === 'claude-memory') return readMemory(c, signal);
  const entries: ImportedEntry[] = [], warnings: string[] = [];
  const add = (id: string, kind: Kind, value: string, date: string, identity = value) => { const entry = imported(c, id, kind, value, date, identity); if (entry) entries.push(entry); };
  if (c.source === 'chatgpt') {
    const mapping = c.exported?.mapping;
    if (!record(mapping)) throw new Error('ChatGPT conversation has no message mapping.');
    // Include every branch once. Parent-first traversal handles missing child timestamps.
    const nodes = Object.entries(mapping).filter((pair): pair is [string, Record<string, unknown>] => record(pair[1]));
    nodes.sort((a, b) => timestamp(record(a[1].message) ? a[1].message.create_time : undefined, c.date)
      .localeCompare(timestamp(record(b[1].message) ? b[1].message.create_time : undefined, c.date)));
    const ordered: typeof nodes = [], visited = new Set<string>(), visiting = new Set<string>();
    const visit = (key: string, node: Record<string, unknown>) => {
      if (visited.has(key)) return;
      if (visiting.has(key)) throw new Error(`${c.title}: cycle in ChatGPT conversation mapping.`);
      visiting.add(key);
      const parent = typeof node.parent === 'string' ? mapping[node.parent] : undefined;
      if (typeof node.parent === 'string' && record(parent)) visit(node.parent, parent);
      visiting.delete(key); visited.add(key); ordered.push([key, node]);
    };
    for (const [key, node] of nodes) visit(key, node);
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
      const content = text(m.content); if (!content) continue;
      const branch = hasSelectedBranch ? selected.has(key) ? 'selected branch at export' : 'alternate branch, not the selected outcome' : 'branch selection unavailable';
      add(string(m.id) ?? key, kind, `[message ${key}; parent ${String(node.parent ?? 'root')}; ${branch}${m.recipient ? `; recipient ${String(m.recipient)}` : ''}]\n${content}`, date, content);
    }
    if (hasSelectedBranch) {
      const snapshot = timestamp(c.exported?.update_time, c.date);
      add('export:selected-branch', 'note', `Selected ChatGPT branch in the ${snapshot} export snapshot ends at message ${String(c.exported?.current_node)}. Other branches are alternatives.`, snapshot);
    }
  } else {
    let pending: ImportedEntry[] = [];
    const finish = () => { entries.push(...pending); pending = []; };
    const assistant = (parts: { id: string; content: string }[], date: string, final: boolean) => {
      pending = parts.flatMap(part => {
        const entry = imported(c, part.id, 'talk', part.content, date);
        return entry ? [entry] : [];
      });
      if (final) finish();
    };
    try {
      for await (const { value: v, line } of jsonLines(c.file, warnings, Infinity, signal)) {
        const date = timestamp(v.timestamp, c.date);
        // Context replay and compaction scaffolding are not new user requests.
        if (c.source === 'claude' && v.type === 'system' && v.subtype === 'compact_boundary') { pending = []; continue; }
        if (c.source === 'claude' && (v.isMeta === true || v.isCompactSummary === true)) continue;
        if (c.source === 'claude' && v.isSidechain === true) return { entries: [], warnings };
        if (c.source === 'claude' && ['user', 'assistant'].includes(String(v.type)) && record(v.message)) {
          const m = v.message, id = string(v.uuid) ?? `line:${line}`;
          if (m.role === 'user' && typeof m.content === 'string' && /^\[Request interrupted by user(?: for tool use)?\]$/.test(m.content)) { pending = []; continue; }
          const blocks = Array.isArray(m.content) ? m.content : [];
          const toolActivity = blocks.some(b => record(b) && (['tool_use', 'server_tool_use', 'tool_result'].includes(String(b.type)) || String(b.type).endsWith('_tool_result')));
          if (toolActivity) pending = [];
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
          if (m.role === 'user' && parts.length) { finish(); for (const part of parts) add(part.id, 'user', claudeCommand(part.content) ?? part.content, date, part.content); }
          else if (m.role === 'assistant') {
            const final = m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence';
            if (toolActivity || v.isApiErrorMessage === true || m.stop_reason && !final) pending = [];
            else if (parts.length) assistant(parts, date, final);
            else if (!final) pending = [];
          }
        }
        if (c.source === 'codex' && v.type === 'session_meta' && record(v.payload) && codexSubagent(v.payload)) return { entries: [], warnings };
        if (c.source === 'codex' && v.type === 'event_msg' && record(v.payload)) {
          if (v.payload.type === 'task_complete') finish();
          if (['turn_aborted', 'task_started', 'task_failed'].includes(String(v.payload.type))) pending = [];
        }
        if (c.source === 'codex' && v.type === 'response_item' && record(v.payload)) {
          const m = v.payload, id = string(m.id) ?? string(m.call_id) ?? `line:${line}`;
          if (m.type === 'message' && m.role === 'user') { finish(); add(id, 'user', text(m.content), date); }
          else if (m.type === 'message' && m.role === 'assistant') {
            pending = [];
            const channel = m.channel ?? m.phase;
            const final = channel === 'final' || channel === 'final_answer';
            if (!channel || final) assistant([{ id, content: text(m.content) }], date, final);
          } else if (['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output', 'web_search_call', 'image_generation_call', 'local_shell_call', 'agent_message'].includes(String(m.type))) pending = [];
          else if (!['message', 'reasoning'].includes(String(m.type))) { pending = []; warnings.push(`${c.file}:${line}: unsupported response item ${String(m.type)} skipped`); }
        }
      }
      finish(); // Older exports may omit explicit final markers; retain only the last text reply.
    } catch (error) {
      signal?.throwIfAborted();
      if (!missingSource(error)) throw error;
      // Do not stage a partial conversation if the source becomes unavailable mid-read.
      return { entries: [], warnings: [...warnings, missingWarning(c.file)] };
    }
  }
  const unique = new Map(entries.map(e => [e.receipt, e]));
  return { entries: [...unique.values()], warnings };
}
