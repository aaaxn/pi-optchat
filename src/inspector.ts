import { Input, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Children } from './agents.ts';
import { isActiveRun, type RunInfo } from './runs.ts';
import { ranges, summarizeUsage, type UsageLedger, type UsageRange } from './usage.ts';
import { textContent } from './transcript.ts';
import { record } from './cache.ts';

export const clean = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\t/g, '  ');
export const oneLine = (text: string) => clean(text).replace(/\n/g, ' ');
export const count = (n: number) => n.toLocaleString('en-US');
export const elapsed = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.floor(ms / 1000) % 60}s`;
export type InspectorPage = 'agents' | 'usage';
interface Options {
  profile: string; session: string; children: Children; usage: UsageLedger; page: InspectorPage;
  rows: () => number; redraw: () => void; done: (action?: 'model') => void;
  color: (tone: 'accent' | 'dim' | 'error', text: string) => string;
  context: () => number | null | undefined;
  refreshUsage?: () => void;
  signal?: AbortSignal;
}

/** UI projection only: inspecting never injects child transcripts into parent memory. */
export class Inspector implements Component, Focusable {
  focused = true;
  private page: InspectorPage;
  private selected?: string;
  private opened?: string;
  private top = 0;
  private scroll = 0;
  private lineCount = 0;
  private follow = true;
  private details = false;
  private range: UsageRange = 'This session';
  private composer?: Input;
  private error = '';
  private busy = false;
  private ended = false;
  private savedMessages?: AgentMessage[];
  private liveTranscript = false;
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly options: Options) {
    this.page = options.page;
    this.selected = options.children.history.list()[0]?.id;
    this.unsubscribe = options.children.subscribe(() => options.redraw());
    this.timer = setInterval(() => { options.refreshUsage?.(); options.redraw(); }, 1000); this.timer.unref();
    options.signal?.addEventListener('abort', this.abort, { once: true });
    if (options.signal?.aborted) queueMicrotask(this.abort);
  }
  private readonly abort = () => this.finish();
  private finish(action?: 'model') { if (!this.ended) { this.dispose(); this.options.done(action); } }
  dispose() {
    this.ended = true; clearInterval(this.timer); this.unsubscribe(); this.options.signal?.removeEventListener('abort', this.abort);
  }
  invalidate() { this.composer?.invalidate(); }
  private get height() { return Math.max(1, Math.floor(this.options.rows() * 0.9) - (this.composer ? 9 : 7)); }
  private select(delta: number) {
    const list = this.options.children.history.list();
    const index = Math.max(0, list.findIndex(r => r.id === this.selected));
    this.selected = list[Math.max(0, Math.min(list.length - 1, index + delta))]?.id;
  }
  private async act(action: () => Promise<unknown>) {
    this.busy = true;
    try { await action(); } catch (error) { this.error = String(error); }
    finally { this.busy = false; if (!this.ended) this.options.redraw(); }
  }
  handleInput(data: string) {
    if (this.ended) return;
    this.error = '';
    if (this.composer) {
      if (matchesKey(data, 'escape')) this.composer = undefined;
      else if (matchesKey(data, 'return') && !this.busy) {
        const text = this.composer.getValue().trim(), id = this.opened;
        if (text && id) { this.composer = undefined; void this.act(() => this.options.children.tell(id, text, 'user')); }
      } else this.composer.handleInput(data);
    } else if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      if (this.opened) { this.opened = undefined; this.savedMessages = undefined; this.scroll = 0; }
      else return this.finish();
    } else if (data === 'u' || matchesKey(data, 'tab')) {
      this.page = this.page === 'agents' ? 'usage' : 'agents'; this.opened = undefined; this.scroll = 0; this.follow = true;
    } else if (this.page === 'usage') {
      if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
        const delta = matchesKey(data, 'left') ? -1 : 1;
        this.range = ranges[(ranges.indexOf(this.range) + delta + ranges.length) % ranges.length]; this.scroll = 0;
      } else this.scrollInput(data);
    } else if (this.opened) {
      if (data === 's' && !this.busy && this.options.children.live(this.opened)?.info.state === 'running') {
        this.composer = new Input({ prompt: 'Message: ', placeholder: 'guidance for this child' }); this.composer.focused = this.focused;
      } else if (data === 'x' && !this.busy && this.options.children.live(this.opened)) {
        const id = this.opened; void this.act(() => this.options.children.stop(id));
      } else if (data === 't') this.details = !this.details;
      else if (data === 'f' || matchesKey(data, 'end')) { this.follow = true; this.scroll = Math.max(0, this.lineCount - this.height); }
      else this.scrollInput(data);
    } else {
      if (matchesKey(data, 'up')) this.select(-1);
      else if (matchesKey(data, 'down')) this.select(1);
      else if (matchesKey(data, 'pageUp')) this.select(-this.height);
      else if (matchesKey(data, 'pageDown')) this.select(this.height);
      else if (matchesKey(data, 'home')) this.select(-Infinity);
      else if (matchesKey(data, 'end')) this.select(Infinity);
      else if (data === 'm') return this.finish('model');
      else if (matchesKey(data, 'return') && this.selected) {
        try {
          this.savedMessages = this.options.children.messages(this.selected); this.opened = this.selected;
          this.liveTranscript = !!this.options.children.live(this.selected);
          this.follow = true; this.scroll = 0;
        } catch (error) { this.error = `Transcript unavailable: ${String(error)}`; }
      }
    }
    this.options.redraw();
  }
  private scrollInput(data: string) {
    const delta = matchesKey(data, 'up') ? -1 : matchesKey(data, 'down') ? 1 : matchesKey(data, 'pageUp') ? -this.height : matchesKey(data, 'pageDown') ? this.height : 0;
    if (delta || matchesKey(data, 'home') || matchesKey(data, 'end')) {
      this.follow = false;
      this.scroll = matchesKey(data, 'home') ? 0 : matchesKey(data, 'end') ? this.lineCount : this.scroll + delta;
      this.scroll = Math.max(0, Math.min(this.scroll, this.lineCount - this.height));
    }
  }
  private transcript(run: RunInfo) {
    const live = this.options.children.live(run.id);
    if (live || this.liveTranscript) {
      try { this.savedMessages = this.options.children.messages(run.id); }
      catch (error) { this.error = `Transcript unavailable: ${String(error)}`; }
      this.liveTranscript = !!live;
    }
    const messages = this.savedMessages ?? [];
    const usage = summarizeUsage(this.options.usage.entries.filter(e => e.runId === run.id)).total;
    const blocks = [`Task: ${run.task}`, `Directory: ${run.cwd}`, `Model: ${run.model} · effort ${run.thinking}`,
      `Usage: ${count(usage.totalTokens)} tokens · ${count(usage.input)} input · ${count(usage.output)} output · ${count(usage.cacheRead)}/${count(usage.cacheWrite)} cache read/write · $${usage.cost.total.toFixed(4)} API-equivalent`];
    let initialUser = true;
    for (const message of messages) {
      if (message.role === 'user') {
        if (initialUser) { initialUser = false; continue; } // The initial memory view is context, not work output.
        blocks.push(`You / manager: ${textContent(message.content)}`);
      } else if (message.role === 'assistant') {
        for (const part of message.content) {
          if (part.type === 'text') blocks.push(part.text);
          else if (part.type === 'toolCall') blocks.push(`Tool: ${part.name}${this.details ? `\n${JSON.stringify(part.arguments, null, 2)}` : ''}`);
        }
        if (message.errorMessage) blocks.push(`Error: ${message.errorMessage}`);
      } else if (message.role === 'toolResult') {
        const output = textContent(message.content);
        blocks.push(`${message.isError ? 'Error' : 'Result'}: ${message.toolName}\n${this.details ? output : `${oneLine(output).slice(0, 160)}${output.length > 160 ? '… [t expands]' : ''}`}`);
      }
    }
    for (const tool of live?.tools.values() ?? []) {
      blocks.push(`Running: ${tool.name} · ${elapsed(Date.now() - tool.started)}\n${JSON.stringify(tool.args)}`);
      if (tool.output) {
        const output = record(tool.output) ? textContent(tool.output.content) : String(tool.output);
        blocks.push(this.details ? output : output.slice(-500));
      }
    }
    if (run.report && !live) blocks.push(`Final report: ${run.report}`);
    for (const g of run.guidance) if (g.state !== 'delivered') blocks.push(`Message ${g.state}: ${g.text}`);
    return blocks.filter(Boolean).map(clean).join('\n\n');
  }
  private usageLines() {
    const { usage, session, context } = this.options;
    const entries = usage.select(this.range, session);
    const { total, groups } = summarizeUsage(entries);
    const input = total.input + total.cacheRead + total.cacheWrite;
    const lines = [`← → period: ${this.range}`, '', `Total processed: ${count(total.totalTokens)} tokens · ${entries.length} usage records`,
      `Input: ${count(input)} · Output: ${count(total.output)}`,
      `Cache read: ${count(total.cacheRead)} · Cache write: ${count(total.cacheWrite)} · Hit rate: ${input ? (100 * total.cacheRead / input).toFixed(1) : '0'}%`,
      `Estimated API-equivalent cost: $${total.cost.total.toFixed(4)}`, '',
      'ROLE / MODEL — input · output · cache read/write · estimated cost'];
    for (const g of groups) lines.push(`${g.role} / ${g.model}\n  ${count(g.usage.input)} uncached input · ${count(g.usage.output)} out · ${count(g.usage.cacheRead)}/${count(g.usage.cacheWrite)} cache · $${g.usage.cost.total.toFixed(4)} · ${g.requests} records`);
    const current = context();
    lines.push('', `Current parent context (Pi estimate): ${current == null ? 'unavailable' : `${count(current)} tokens`} — separate from cumulative usage.`,
      'Costs use model API rates when available; not your subscription bill or remaining allowance.',
      'Usage updates when responses finish. Tool overhead may be a usage record without a request count.',
      'Main tracking starts with this version; the resumed parent session and saved children are backfilled.',
      'Older compactor/child records without a parent session appear only in date-based totals.', ...usage.warnings);
    return lines.join('\n');
  }
  render(width: number): string[] {
    const { color, children, profile } = this.options;
    const inspected = this.opened ? children.history.records.get(this.opened) : undefined;
    const header = color('accent', `OptChat · ${profile} · ${inspected ? `${inspected.state}: ${oneLine(inspected.task)}` : this.page === 'usage' ? 'Usage' : 'Agents'}`);
    let body: string[], hint: string;
    if (this.page === 'usage' || this.opened) {
      const run = this.opened ? children.history.records.get(this.opened) : undefined;
      const text = this.page === 'usage' ? this.usageLines() : run ? `${run.state} · ${elapsed((run.ended ?? Date.now()) - run.started)} · ${run.id}\n\n${this.transcript(run)}` : 'Run unavailable.';
      const lines = wrapTextWithAnsi(clean(text), Math.max(1, width)); this.lineCount = lines.length;
      if (this.opened && this.follow) this.scroll = Math.max(0, lines.length - this.height);
      this.scroll = Math.max(0, Math.min(this.scroll, lines.length - this.height));
      body = lines.slice(this.scroll, this.scroll + this.height);
      body.push(color('dim', `${this.scroll + 1}–${Math.min(this.scroll + this.height, lines.length)} / ${lines.length}${this.opened ? this.follow ? ' · following' : ' · scroll paused (f follows)' : ''}`));
      hint = this.page === 'usage' ? '←→ period · ↑↓/PgUp/PgDn scroll · Tab agents · Esc close' : '↑↓/PgUp/PgDn scroll · t tools · f follow · s message · x stop tree · Esc back';
    } else {
      const list = children.history.list();
      if (!this.selected) this.selected = list[0]?.id;
      const cursor = Math.max(0, list.findIndex(r => r.id === this.selected));
      this.top = Math.max(0, Math.min(this.top, list.length - this.height));
      if (cursor < this.top) this.top = cursor;
      if (cursor >= this.top + this.height) this.top = cursor - this.height + 1;
      body = list.slice(this.top, this.top + this.height).map(run => {
        const live = children.live(run.id), tools = live ? [...live.tools.values()].map(t => t.name).join(', ') : '';
        const activity = live ? `${run.state === 'stopping' ? 'stopping' : tools || (live.streaming ? 'responding' : 'working')} · last activity ${elapsed(Date.now() - live.updated)} ago` : run.state;
        const label = `${run.id === this.selected ? '→' : ' '} ${oneLine(run.task).slice(0, 55)} · ${activity} · ${elapsed((run.ended ?? Date.now()) - run.started)}`;
        return run.id === this.selected ? color('accent', label) : label;
      });
      if (!body.length) body.push('No agents yet. Ask the main agent to delegate a task.');
      body.push(color('dim', `${list.filter(isActiveRun).length} active · ${list.length} saved · ${list.length ? cursor + 1 : 0}/${list.length}`));
      hint = '↑↓ select · Enter inspect · m model · Tab usage · Esc close';
    }
    if (this.composer) { this.composer.focused = this.focused; body.push(...this.composer.render(width)); hint = 'Enter sends guidance · Esc cancels message'; }
    return [header, '', ...body, '', color(this.error ? 'error' : 'dim', this.error || (this.busy ? 'Updating agent…' : hint))].map(line => truncateToWidth(line, width));
  }
}

export function showInspector(ctx: ExtensionContext, options: Omit<Options, 'rows' | 'redraw' | 'done' | 'color' | 'context'>) {
  return ctx.ui.custom<'model' | undefined>((tui, theme, _keys, done) => new Inspector({ ...options,
    rows: () => tui.terminal.rows, redraw: () => tui.requestRender(), done,
    color: (tone, text) => theme.fg(tone, text), context: () => ctx.getContextUsage()?.tokens,
  }), { overlay: true, overlayOptions: { width: '96%', maxHeight: '90%', anchor: 'center' } });
}
