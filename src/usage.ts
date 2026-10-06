import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { record } from './cache.ts';
import { appendJson } from './memory.ts';

export type UsageRole = 'main' | 'subagent' | 'compactor' | 'import';
export const ranges = ['This session', 'Last hour', 'Today', 'Last 7 days', 'All time'] as const;
export type UsageRange = typeof ranges[number];
export interface UsageEntry {
  id?: string; date: string; role: UsageRole; model: string; provider?: string;
  session?: string; runId?: string; usage: Usage;
}
const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
function validUsage(value: unknown): value is Usage {
  if (!record(value) || !record(value.cost)) return false;
  const cost = value.cost;
  return ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(k => nonnegative(value[k]))
    && ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every(k => nonnegative(cost[k]));
}
function validEntry(value: unknown): value is UsageEntry {
  return record(value) && typeof value.date === 'string' && Number.isFinite(Date.parse(value.date))
    && ['main', 'subagent', 'compactor', 'import'].includes(String(value.role)) && typeof value.model === 'string'
    && ['id', 'provider', 'session', 'runId'].every(k => value[k] === undefined || typeof value[k] === 'string') && validUsage(value.usage);
}
export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
export function addUsage(total: Usage, usage: Usage) {
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) total[key] += usage[key];
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) total.cost[key] += usage.cost[key];
}

/** One profile's ledger. Stable message IDs make resume/backfill idempotent. */
export class UsageLedger {
  readonly entries: UsageEntry[] = [];
  private invalid = 0;
  private readonly ids = new Set<string>();
  private readonly cursors = new Map<string, number>();
  private readonly file: string;
  constructor(directory: string) {
    this.file = join(directory, 'usage.jsonl');
    const contents = existsSync(this.file) ? readFileSync(this.file, 'utf8') : '';
    for (const line of contents.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry: unknown = JSON.parse(line);
        if (!validEntry(entry)) { this.invalid++; continue; }
        if (entry.id && this.ids.has(entry.id)) continue;
        this.entries.push(entry); if (entry.id) this.ids.add(entry.id);
      } catch { this.invalid++; }
    }
    if (contents && !contents.endsWith('\n')) appendFileSync(this.file, '\n');
  }
  get warnings() { return this.invalid ? [`${this.invalid} unreadable usage records excluded; totals may be incomplete.`] : []; }
  add(entry: UsageEntry) {
    if (!validEntry(entry)) { this.invalid++; return; }
    if (entry.id && this.ids.has(entry.id)) return;
    appendJson(this.file, entry);
    this.entries.push(entry); if (entry.id) this.ids.add(entry.id);
  }
  compression(message: AssistantMessage, role: 'compactor' | 'import', session: string) {
    this.add({ id: randomUUID(), date: new Date().toISOString(), role, session, provider: message.provider, model: message.model, usage: message.usage });
  }
  backfill(entries: SessionEntry[], session: string, role: 'main' | 'subagent' = 'main', runId?: string) {
    const cursorKey = `${session}:${runId ?? ''}`;
    const cursor = this.cursors.get(cursorKey) ?? 0;
    for (const entry of entries.slice(cursor <= entries.length ? cursor : 0)) {
      // Pi forks preserve entry IDs/timestamps. Never count inherited responses twice.
      const id = `entry:${entry.id}:${entry.timestamp}`;
      if (entry.type === 'message') {
        const message = entry.message;
        if ((message.role === 'assistant' || message.role === 'toolResult') && message.usage) this.add({ id,
          date: new Date(message.timestamp).toISOString(), role, session, runId,
          provider: message.role === 'assistant' ? message.provider : undefined,
          model: message.role === 'assistant' ? message.model : 'tool usage (model unavailable)', usage: message.usage });
      }
      else if ((entry.type === 'usage' || entry.type === 'compaction' || entry.type === 'branch_summary') && entry.usage) {
        this.add({ id, date: entry.timestamp, role, session, runId, model: 'session overhead', usage: entry.usage });
      }
    }
    this.cursors.set(cursorKey, entries.length);
  }
  select(range: UsageRange, session: string, now = Date.now()) {
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const since = range === 'Last hour' ? now - 3600_000 : range === 'Today' ? today.getTime() : range === 'Last 7 days' ? now - 7 * 86400_000 : 0;
    return this.entries.filter(e => range === 'This session' ? e.session === session : range === 'All time' || (Date.parse(e.date) >= since && Date.parse(e.date) <= now));
  }
}

export function summarizeUsage(entries: UsageEntry[]) {
  const total = emptyUsage(), groups = new Map<string, { role: UsageRole; model: string; requests: number; usage: Usage }>();
  for (const entry of entries) {
    const model = entry.provider ? `${entry.provider}/${entry.model}` : entry.model;
    const key = `${entry.role}:${model}`;
    let group = groups.get(key);
    if (!group) { group = { role: entry.role, model, requests: 0, usage: emptyUsage() }; groups.set(key, group); }
    group.requests++; addUsage(group.usage, entry.usage); addUsage(total, entry.usage);
  }
  return { total, groups: [...groups.values()] };
}
