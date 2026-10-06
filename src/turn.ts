import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { UserMessage } from '@earendil-works/pi-ai';
import { parseSkillBlock, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Inbox } from './inbox.ts';
import type { Memory } from './memory.ts';
import { atomicWrite } from './profiles.ts';
import { asUser, boundedMessage, buildContext, logMessage, textContent, typedText } from './transcript.ts';

export const NEEDS_PROFILE = 'Choose an OptChat profile first: /optchat profile';
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

const JOURNAL = 'pending-reports.json';
const REPORT = 'report:';
const reportReceipt = (text: string) => REPORT + createHash('sha256').update(text).digest('hex');

export interface TurnProfile { memory: Memory; inbox: Inbox; dir: string }
export type TurnContext = Pick<ExtensionContext, 'signal' | 'abort'> & { ui: Pick<ExtensionContext['ui'], 'notify' | 'setWorkingMessage'> };

class Run {
  messages: AgentMessage[] = [];
  logged = 0;
  view: string | undefined;
  receipts = new Map<AgentMessage, string>();
  constructor(public started = false) {}
}

export class Turn {
  working = false;
  prompt = '';
  private failure: string | undefined;
  private reports: string[] = [];
  private run = new Run();

  constructor(private readonly profile: () => TurnProfile | undefined) {}

  get fault() { return this.failure; }
  get pendingReports(): readonly string[] { return this.reports; }

  static journal(dir: string): string[] {
    const file = join(dir, JOURNAL);
    const saved: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    if (!Array.isArray(saved) || !saved.every((s): s is string => typeof s === 'string')) throw new Error('Invalid pending report journal.');
    return saved;
  }
  restore(saved: string[], dir: string, memory: Memory) {
    const logged = new Set(memory.root.map(e => e.receipt));
    this.reports = saved.filter(text => !logged.has(reportReceipt(text)));
    atomicWrite(join(dir, JOURNAL), JSON.stringify(this.reports));
    this.failure = undefined;
  }
  addReport(text: string) { this.reports.push(text); this.save(); }
  private save() {
    const p = this.profile();
    if (p) atomicWrite(join(p.dir, JOURNAL), JSON.stringify(this.reports));
  }

  reset() { this.run = new Run(); this.prompt = ''; this.working = false; }
  agentStart() { this.working = true; }
  start() { this.flush(); this.run = new Run(true); }
  startIfIdle() { if (this.profile() && !this.run.started) this.start(); }
  settled(ctx: TurnContext) {
    try { this.flush(); } catch (error) { this.fail(error, ctx); }
    this.run.started = false; this.working = false;
  }
  fail(error: unknown, ctx: TurnContext) { this.failure = errorText(error); ctx.ui.notify(this.failure, 'error'); }

  /** The message to store in place of `message`, when it is too long to keep whole. */
  messageEnd(message: AgentMessage, ctx: TurnContext): AgentMessage | undefined {
    const p = this.profile();
    if (!p || !this.run.started) return;
    const bounded = boundedMessage(message), current = asUser(bounded);
    if (current.role === 'user') {
      try { this.claim(p, current); }
      catch (error) { ctx.abort(); this.fail(error, ctx); }
    }
    this.run.messages.push(current);
    if (this.run.view !== undefined) {
      try { this.flush(); } catch (error) { ctx.abort(); this.fail(error, ctx); }
    }
    return bounded === message ? undefined : bounded;
  }
  private claim(p: TurnProfile, message: UserMessage) {
    const text = textContent(message.content);
    if (this.reports.includes(text)) { this.run.receipts.set(message, reportReceipt(text)); return; }
    const typed = typedText(message.content), skill = parseSkillBlock(typed.bare);
    let receipt = p.inbox.claim(typed.text) ?? p.inbox.claim(typed.bare)
      ?? (skill ? p.inbox.claimSkill(skill.name, skill.userMessage) : undefined);
    if (!receipt) { p.inbox.record(text); receipt = p.inbox.claim(text); }
    if (receipt) this.run.receipts.set(message, receipt);
  }

  flush() {
    const p = this.profile();
    if (!p) return;
    const run = this.run;
    while (run.logged < run.messages.length) {
      const message = run.messages[run.logged];
      const receipt = run.receipts.get(message);
      logMessage(p.memory, message, receipt); run.logged++;
      if (receipt && !receipt.startsWith(REPORT)) p.inbox.acknowledge(receipt);
      run.receipts.delete(message);
      if (message.role === 'user') {
        const index = this.reports.indexOf(textContent(message.content));
        if (index >= 0) { this.reports.splice(index, 1); this.save(); }
      }
    }
  }

  async context(messages: AgentMessage[], ctx: TurnContext, importBusy: (dir: string) => boolean): Promise<AgentMessage[]> {
    try {
      const p = this.profile();
      if (!p) throw new Error(NEEDS_PROFILE);
      if (importBusy(p.dir)) throw new Error('Profile is unavailable while importing.');
      if (this.failure) throw new Error(this.failure);
      if (this.run.view === undefined) {
        ctx.ui.setWorkingMessage('Waiting for OptChat summaries…');
        try {
          await p.memory.settle(ctx.signal);
          this.run.view = p.memory.render(); // Capture old history before logging the new input.
          this.flush();
        } finally { ctx.ui.setWorkingMessage(); }
      }
      return buildContext(messages, this.run.messages, this.run.view, this.prompt);
    } catch (error) {
      // Pi catches extension errors. Explicitly abort so it cannot fall back to old context.
      ctx.abort();
      try { this.flush(); } catch (persistenceError) { this.failure = errorText(persistenceError); }
      ctx.ui.notify(errorText(error), 'error');
      return [{ role: 'system', content: 'OptChat context unavailable. Stop.', timestamp: 0 }];
    }
  }
}
