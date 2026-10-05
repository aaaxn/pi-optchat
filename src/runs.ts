import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { atomicWrite } from './profiles.ts';
import { record } from './cache.ts';
import { textContent } from './transcript.ts';

export const runStates = ['running', 'stopping', 'completed', 'failed', 'stopped', 'interrupted'] as const;
export type RunState = typeof runStates[number];
export interface RunInfo {
  id: string; task: string; cwd: string; model: string; thinking: string;
  parentSession: string; sessionFile?: string; started: number; ended?: number;
  state: RunState; report?: string;
  guidance: { text: string; date: number; state: 'queued' | 'delivered' | 'undelivered' }[];
}
export const isActiveRun = (run: RunInfo) => run.state === 'running' || run.state === 'stopping';
function isRun(value: unknown): value is RunInfo {
  return record(value) && ['id', 'task', 'cwd', 'model', 'thinking', 'parentSession'].every(k => typeof value[k] === 'string')
    && typeof value.id === 'string' && /^[a-zA-Z0-9-]+$/.test(value.id)
    && runStates.includes(value.state as RunState) && typeof value.started === 'number' && Number.isFinite(value.started)
    && (value.ended === undefined || typeof value.ended === 'number')
    && (value.sessionFile === undefined || typeof value.sessionFile === 'string')
    && (value.report === undefined || typeof value.report === 'string')
    && Array.isArray(value.guidance) && value.guidance.every(g => record(g) && typeof g.text === 'string' && typeof g.date === 'number' && ['queued', 'delivered', 'undelivered'].includes(String(g.state)));
}
export function sessionMessages(file: string): AgentMessage[] {
  return SessionManager.open(file).getEntries().flatMap(e => e.type === 'message' ? [e.message] : []);
}

/** Metadata sits beside the SDK's canonical child transcripts, inside this profile. */
export class RunHistory {
  readonly records = new Map<string, RunInfo>();
  readonly warnings: string[] = [];
  private readonly directory: string;
  constructor(profileDirectory: string) {
    this.directory = join(profileDirectory, 'runs');
    const files = existsSync(this.directory) ? readdirSync(this.directory) : [];
    for (const file of files.filter(f => f.endsWith('.optchat.json'))) {
      try {
        const run: unknown = JSON.parse(readFileSync(join(this.directory, file), 'utf8'));
        if (!isRun(run) || file !== `${run.id}.optchat.json`) throw new Error('Invalid metadata');
        // Never follow a stored transcript pointer outside this profile's run directory.
        if (run.sessionFile) run.sessionFile = join(this.directory, basename(run.sessionFile));
        this.records.set(run.id, run);
        if (isActiveRun(run)) {
          run.state = 'interrupted'; run.ended = Date.now();
          run.report = 'Pi closed before this agent finished. Its partial transcript is retained.';
          for (const g of run.guidance) if (g.state === 'queued') g.state = 'undelivered';
          this.save(run);
        }
      } catch { this.warnings.push(`Could not read run metadata: ${file}`); }
    }
    const known = new Set([...this.records.values()].map(r => r.sessionFile));
    // Make pre-inspector child sessions browsable without pretending to know their parent session.
    for (const file of files.filter(f => f.endsWith('.jsonl') && !known.has(join(this.directory, f)))) {
      try {
        const manager = SessionManager.open(join(this.directory, file));
        const messages = manager.getEntries().flatMap(e => e.type === 'message' ? [e.message] : []);
        const first = messages.find(m => m.role === 'user'), last = messages.findLast(m => m.role === 'assistant');
        const content = first?.role === 'user' ? textContent(first.content) : 'Historical child session';
        const task = content.includes('\n\nYour task:\n') ? content.split('\n\nYour task:\n').slice(1).join('\n\nYour task:\n') : content;
        const run: RunInfo = { id: manager.getSessionId(), task, cwd: manager.getCwd(), model: last?.role === 'assistant' ? last.model : 'unknown',
          thinking: 'unknown', parentSession: '', sessionFile: join(this.directory, file), started: first?.timestamp ?? 0,
          ended: last?.timestamp, state: last?.role === 'assistant' && last.stopReason === 'stop' ? 'completed' : 'interrupted', guidance: [] };
        this.records.set(run.id, run); this.save(run);
      } catch { this.warnings.push(`Could not read historical child: ${file}`); }
    }
  }
  save(run: RunInfo) {
    atomicWrite(join(this.directory, `${run.id}.optchat.json`), JSON.stringify(run));
    this.records.set(run.id, run);
  }
  list() {
    return [...this.records.values()].sort((a, b) => Number(isActiveRun(b)) - Number(isActiveRun(a)) || b.started - a.started || a.id.localeCompare(b.id));
  }
}
