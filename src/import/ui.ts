import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import type { Memory } from '../memory.ts';
import { bytes } from '../memory.ts';
import { scanLocal, scanChatGPT, readConversation, type Conversation, type ImportedEntry, type Source } from './sources.ts';
import { deduplicate, type ImportMode, type ImportJob, type ImportProgress } from './job.ts';
import { selectMany } from './multi-select.ts';
import { homedir } from 'node:os';

type ImportUI = { ui: Pick<ExtensionUIContext, 'select' | 'input' | 'confirm' | 'notify' | 'setWidget' | 'custom'> };
const clean = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const size = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;
export async function chooseImport(ctx: ImportUI, profile: string, memory: Memory, model: string, signal: AbortSignal): Promise<{ entries: ImportedEntry[]; mode: ImportMode } | undefined> {
  const sourceLabel = await ctx.ui.select(`Import into ${profile} · source`, ['Claude Code', 'Codex', 'ChatGPT export'], { signal });
  if (!sourceLabel) return;
  const source: Source = sourceLabel === 'Claude Code' ? 'claude' : sourceLabel === 'Codex' ? 'codex' : 'chatgpt';
  ctx.ui.setWidget('optchat-import', ['Scanning local conversation metadata…']);
  let scan;
  try {
    if (source === 'chatgpt') {
      const path = await ctx.ui.input('ChatGPT export ZIP, extracted folder, or conversations JSON path', undefined, { signal });
      if (!path?.trim()) return;
      scan = await scanChatGPT(path.trim(), signal);
    } else scan = await scanLocal(source, undefined, signal);
  } finally { ctx.ui.setWidget('optchat-import', undefined); }
  let candidates = scan.conversations;
  if (!candidates.length) throw new Error(`No conversations found for this source.${scan.warnings.length ? '\n' + scan.warnings.slice(0, 4).map(clean).join('\n') : ''}`);
  if (source !== 'chatgpt') {
    const counts = new Map<string, number>();
    for (const c of candidates) counts.set(c.project, (counts.get(c.project) ?? 0) + 1);
    const projects = [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([p]) => p);
    const selected = await selectMany(ctx.ui, 'Projects', projects, p => `${p.startsWith(homedir() + '/') ? '~' + p.slice(homedir().length) : p} (${counts.get(p)} conversations)`, signal);
    if (!selected) return;
    candidates = candidates.filter(c => selected.includes(c.project));
  }
  const range = await ctx.ui.select('Conversation dates', ['All history', 'Filter by start date'], { signal });
  if (!range) return;
  if (range === 'Filter by start date') {
    const after = await ctx.ui.input('Started on/after YYYY-MM-DD (blank = no lower bound)', undefined, { signal }); if (after === undefined) return;
    const before = await ctx.ui.input('Started on/before YYYY-MM-DD (blank = no upper bound)', undefined, { signal }); if (before === undefined) return;
    for (const day of [after, before]) if (day && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day)) throw new Error('Enter dates as YYYY-MM-DD.');
    if (after && before && after > before) throw new Error('Start date must precede end date.');
    candidates = candidates.filter(c => (!after || c.date.slice(0, 10) >= after) && (!before || c.date.slice(0, 10) <= before));
  }
  if (!candidates.length) throw new Error('No conversations match these dates.');
  const scope = await ctx.ui.select(`${candidates.length} conversations · ${size(candidates.reduce((n, c) => n + c.size, 0))} source files`, ['All matching conversations', 'Choose individual conversations'], { signal });
  if (!scope) return;
  const conversations: Conversation[] | undefined = scope === 'Choose individual conversations'
    ? await selectMany(ctx.ui, 'Conversations', candidates, c => `${c.date.slice(0, 10)} · ${c.title} · ${c.id}`, signal) : candidates;
  if (!conversations) return;
  const entries: ImportedEntry[] = [], warnings = [...scan.warnings];
  try {
    for (const [i, c] of conversations.entries()) {
      ctx.ui.setWidget('optchat-import', [`Reading ${i + 1}/${conversations.length}: ${clean(c.title)}`]);
      const parsed = await readConversation(c, signal);
      for (const entry of parsed.entries) entries.push(entry);
      for (const warning of parsed.warnings) warnings.push(warning);
    }
  } finally { ctx.ui.setWidget('optchat-import', undefined); }
  if (warnings.length) {
    const choice = await ctx.ui.select(`${warnings.length} source issues: unavailable conversations or unsupported records.\n${warnings.slice(0, 4).map(clean).join('\n')}`, ['Cancel', 'Continue with supported records'], { signal });
    if (choice !== 'Continue with supported records') return;
  }
  if (!entries.length) { ctx.ui.notify('No readable messages remain to import. Rescan or choose different conversations.', 'info'); return; }
  const { added, skipped } = deduplicate(memory.root, entries);
  if (!added.length) { ctx.ui.notify(`Nothing new to import (${skipped} messages already present).`, 'info'); return; }
  let mode: ImportMode = 'append';
  if (memory.root.length) {
    const selected = await ctx.ui.select('How should this history join your memory?', [
      `Append · keep ${memory.tree.size} existing summaries`,
      `Rebuild by conversation start date · recompress ${memory.root.length + added.length} messages`,
    ], { signal });
    if (!selected) return;
    mode = selected.startsWith('Rebuild') ? 'rebuild' : 'append';
  }
  const affected = mode === 'rebuild' ? [...memory.root, ...added] : added;
  const inputBytes = affected.reduce((n, e) => n + bytes(e.text), 0);
  let nodes = 0;
  for (let n = memory.root.length + added.length; n > 0; n = Math.floor(n / 2)) nodes += n;
  if (mode === 'append') nodes -= memory.tree.size;
  const preview = `${profile} · ${mode}\nHistorical user messages and final replies; tool activity excluded.\n${conversations.length} conversations selected · ${added.length} new messages · ${skipped} duplicates skipped\n${size(inputBytes)} text to index (~${Math.ceil(inputBytes / 4).toLocaleString()} source tokens; rough estimate)\nCompactor: ${model}\nUp to ${nodes} new summary nodes; small nodes need no model call. Context and retries add usage.\nChatting in this profile pauses until completion or discard. You can pause and resume compression. The previous memory is retained.`;
  if (!await ctx.ui.confirm('Start import?', preview, { signal })) return;
  return { entries, mode };
}
export async function showProgress(ctx: { ui: Pick<ExtensionUIContext, 'select' | 'setWidget'> }, job: ImportJob,
  run: (signal: AbortSignal, progress: (value: ImportProgress) => void) => Promise<unknown>, outerSignal: AbortSignal) {
  const controller = new AbortController(), finished = new AbortController();
  const abort = () => controller.abort(); outerSignal.addEventListener('abort', abort, { once: true });
  if (outerSignal.aborted) abort();
  const task = run(controller.signal, p => ctx.ui.setWidget('optchat-import', [
    `${job.mode} import · ${p.messages}/${p.total} messages indexed · ${p.summaries} summary nodes`,
    p.error ? `Retrying: ${clean(p.error)} · you can pause` : 'The original memory stays intact until this finishes.',
  ]));
  // Attach a rejection handler immediately; UI and model failures can happen independently.
  const outcome = task.then(() => ({ complete: true as const }), error => ({ complete: false as const, error })).finally(() => finished.abort());
  try {
    await ctx.ui.select('Import in progress', ['Pause import'], { signal: finished.signal });
    if (!finished.signal.aborted) controller.abort();
    const result = await outcome;
    if (!result.complete && !controller.signal.aborted) throw result.error;
    return result.complete;
  } finally {
    controller.abort(); await outcome;
    outerSignal.removeEventListener('abort', abort); ctx.ui.setWidget('optchat-import', undefined);
  }
}
