import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { atomicWrite } from './profiles.ts';
import { record } from './cache.ts';
import { textContent } from './transcript.ts';

/** `paused`: interrupted by the user with nothing queued, alive and waiting for its next message. `interrupted` is a finished run cut off by Pi closing or a connected window ending. */
export const runStates = ['running', 'waiting', 'stopping', 'completed', 'failed', 'stopped', 'interrupted', 'paused'] as const;
export type RunState = typeof runStates[number];
export type FinishReason = 'complete' | 'disconnected' | 'owner-stopped' | 'failed';
export interface RunInfo {
  id: string; task: string; cwd: string; model: string; thinking: string;
  parentSession: string; sessionFile?: string; started: number; ended?: number;
  parentId?: string; depth: number;
  state: RunState; report?: string;
  connected?: boolean;
  handoff?: { reason: FinishReason; text?: string; delivered?: boolean };
  /** `from` is missing on runs saved before senders were recorded. */
  guidance: { text: string; date: number; state: 'queued' | 'delivered' | 'undelivered'; from?: 'user' | 'manager' }[];
}
const moves: Record<RunState, readonly RunState[]> = {
  running: ['waiting', 'paused', 'stopping', 'completed', 'failed', 'stopped', 'interrupted'],
  waiting: ['running', 'paused', 'stopping', 'completed', 'failed', 'stopped', 'interrupted'],
  paused: ['running', 'stopping', 'failed', 'stopped', 'interrupted'],
  stopping: ['stopped', 'failed', 'interrupted'],
  // A finished run only takes the outcome of a connected handoff.
  completed: ['interrupted'], failed: ['completed', 'interrupted'], stopped: ['completed', 'interrupted'], interrupted: ['completed'],
};
/** Every run state change goes through here, so a late stop cannot rewrite a finished run. Returns whether the run is now in `to` (true for a repeat, so a second stop can still abort a child that ignored the first). */
export function transition(run: RunInfo, to: RunState) {
  if (run.state !== to && !moves[run.state].includes(to)) return false;
  run.state = to; return true;
}
export const isActiveRun = (run: RunInfo) => run.state === 'running' || run.state === 'waiting' || run.state === 'stopping' || run.state === 'paused';
/** Live and working: a paused run is neither running nor finished. */
export const isRunning = (run: RunInfo) => isActiveRun(run) && run.state !== 'paused';
function isRun(value: unknown): value is RunInfo {
  return record(value) && ['id', 'task', 'cwd', 'model', 'thinking', 'parentSession'].every(k => typeof value[k] === 'string')
    && typeof value.id === 'string' && /^[a-zA-Z0-9-]+$/.test(value.id)
    && runStates.includes(value.state as RunState) && typeof value.started === 'number' && Number.isFinite(value.started)
    && (value.ended === undefined || typeof value.ended === 'number')
    && (value.sessionFile === undefined || typeof value.sessionFile === 'string')
    && (value.report === undefined || typeof value.report === 'string')
    && (value.connected === undefined || typeof value.connected === 'boolean')
    && (value.handoff === undefined || record(value.handoff) && ['complete', 'disconnected', 'owner-stopped', 'failed'].includes(String(value.handoff.reason))
      && (value.handoff.text === undefined || typeof value.handoff.text === 'string')
      && (value.handoff.delivered === undefined || typeof value.handoff.delivered === 'boolean'))
    && typeof value.depth === 'number' && Number.isInteger(value.depth) && value.depth >= 1
    && (value.parentId === undefined || typeof value.parentId === 'string')
    && Array.isArray(value.guidance) && value.guidance.every(g => record(g) && typeof g.text === 'string' && typeof g.date === 'number' && ['queued', 'delivered', 'undelivered'].includes(String(g.state)) && (g.from === undefined || g.from === 'user' || g.from === 'manager'));
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
        if (record(run) && run.depth === undefined) run.depth = 1;
        if (!isRun(run) || file !== `${run.id}.optchat.json`) throw new Error('Invalid metadata');
        // Never follow a stored transcript pointer outside this profile's run directory.
        if (run.sessionFile) run.sessionFile = join(this.directory, basename(run.sessionFile));
        this.records.set(run.id, run);
        if (isActiveRun(run)) {
          if (run.connected) run.handoff ??= { reason: 'owner-stopped' };
          transition(run, 'interrupted'); run.ended = Date.now();
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
          thinking: 'unknown', parentSession: '', depth: 1, sessionFile: join(this.directory, file), started: first?.timestamp ?? 0,
          ended: last?.timestamp, state: last?.role === 'assistant' && last.stopReason === 'stop' ? 'completed' : 'interrupted', guidance: [] };
        this.records.set(run.id, run); this.save(run);
      } catch { this.warnings.push(`Could not read historical child: ${file}`); }
    }
  }
  save(run: RunInfo) {
    atomicWrite(join(this.directory, `${run.id}.optchat.json`), JSON.stringify(run));
    this.records.set(run.id, run);
  }
  descendants(id: string) {
    const result: RunInfo[] = [], visited = new Set([id]);
    const visit = (parent: string) => {
      for (const run of this.records.values()) {
        if (run.parentId !== parent || visited.has(run.id)) continue;
        visited.add(run.id); result.push(run); visit(run.id);
      }
    };
    visit(id);
    return result;
  }
  list() {
    const sorted = [...this.records.values()].sort((a, b) => Number(isActiveRun(b)) - Number(isActiveRun(a)) || b.started - a.started || a.id.localeCompare(b.id));
    const descendants = new Map<string, RunInfo[]>();
    for (const run of sorted) if (run.parentId) {
      const siblings = descendants.get(run.parentId) ?? []; siblings.push(run); descendants.set(run.parentId, siblings);
    }
    const result: RunInfo[] = [], visited = new Set<string>();
    const visit = (run: RunInfo) => {
      if (visited.has(run.id)) return;
      visited.add(run.id); result.push(run);
      for (const child of descendants.get(run.id) ?? []) visit(child);
    };
    for (const run of sorted) if (!run.parentId || !this.records.has(run.parentId)) visit(run);
    for (const run of sorted) visit(run); // Keep even malformed/orphaned old trees visible.
    return result;
  }
}
