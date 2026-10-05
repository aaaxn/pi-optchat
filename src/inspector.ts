import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Children } from './agents.ts';
import { isActiveRun } from './runs.ts';
import { ranges, summarizeUsage, type UsageLedger, type UsageRange } from './usage.ts';

export const clean = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\t/g, '  ');
export const oneLine = (text: string) => clean(text).replace(/\n/g, ' ');
export const count = (n: number) => n.toLocaleString('en-US');
export const elapsed = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.floor(ms / 1000) % 60}s`;
/** Shortens plain text with an ellipsis, preferring a word boundary. */
export function fit(text: string, width: number) {
  if (visibleWidth(text) <= width) return text;
  if (width < 2) return sliceByColumn(text, 0, width, true);
  const cut = sliceByColumn(text, 0, width - 1, true), space = cut.lastIndexOf(' '); // Unlike truncateToWidth, adds no style reset.
  return `${(space > cut.length * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
/** Left text and right text on one line, the right side flush with the edge when both fit. */
const spread = (left: string, right: string, width: number) => {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return gap >= 2 ? `${left}${' '.repeat(gap)}${right}` : left;
};
export type InspectorPage = 'agents' | 'usage';
/** Closing the panel either picks the subagent model or opens one agent's conversation. */
export type InspectorAction = 'model' | { open: string };
type Tone = 'accent' | 'muted' | 'dim' | 'error' | 'border';
interface Options {
  profile: string; session: string; children: Children; usage: UsageLedger; page: InspectorPage;
  rows: () => number; redraw: () => void; done: (action?: InspectorAction) => void;
  color: (tone: Tone, text: string) => string;
  context: () => number | null | undefined;
  refreshUsage?: () => void;
  signal?: AbortSignal;
}

/** UI projection only: inspecting never injects child transcripts into parent memory. */
export class Inspector implements Component, Focusable {
  focused = true;
  private page: InspectorPage;
  private selected?: string;
  private top = 0;
  private scroll = 0;
  private lineCount = 0;
  private hintLines = 1;
  private range: UsageRange = 'This session';
  private ended = false;
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
  private finish(action?: InspectorAction) { if (!this.ended) { this.dispose(); this.options.done(action); } }
  dispose() {
    this.ended = true; clearInterval(this.timer); this.unsubscribe(); this.options.signal?.removeEventListener('abort', this.abort);
  }
  invalidate() {}
  /** Body rows left after the rules, title, hint and spacing; the rest of the screen keeps the footer visible. */
  private get height() { return Math.max(1, Math.floor(this.options.rows() * 0.8) - 6 - (this.hintLines - 1)); }
  private select(delta: number) {
    const list = this.options.children.history.list();
    const index = Math.max(0, list.findIndex(r => r.id === this.selected));
    this.selected = list[Math.max(0, Math.min(list.length - 1, index + delta))]?.id;
  }
  handleInput(data: string) {
    if (this.ended) return;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) return this.finish();
    if (data === 'u' || matchesKey(data, 'tab')) {
      this.page = this.page === 'agents' ? 'usage' : 'agents'; this.scroll = 0;
    } else if (this.page === 'usage') {
      if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
        const delta = matchesKey(data, 'left') ? -1 : 1;
        this.range = ranges[(ranges.indexOf(this.range) + delta + ranges.length) % ranges.length]; this.scroll = 0;
      } else this.scrollInput(data);
    } else {
      if (matchesKey(data, 'up')) this.select(-1);
      else if (matchesKey(data, 'down')) this.select(1);
      else if (matchesKey(data, 'pageUp')) this.select(-this.height);
      else if (matchesKey(data, 'pageDown')) this.select(this.height);
      else if (matchesKey(data, 'home')) this.select(-Infinity);
      else if (matchesKey(data, 'end')) this.select(Infinity);
      else if (data === 'm') return this.finish('model');
      else if (matchesKey(data, 'return') && this.selected) return this.finish({ open: this.selected });
    }
    this.options.redraw();
  }
  private scrollInput(data: string) {
    const delta = matchesKey(data, 'up') ? -1 : matchesKey(data, 'down') ? 1 : matchesKey(data, 'pageUp') ? -this.height : matchesKey(data, 'pageDown') ? this.height : 0;
    if (delta || matchesKey(data, 'home') || matchesKey(data, 'end')) {
      this.scroll = matchesKey(data, 'home') ? 0 : matchesKey(data, 'end') ? this.lineCount : this.scroll + delta;
      this.scroll = Math.max(0, Math.min(this.scroll, this.lineCount - this.height));
    }
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
    const inner = Math.max(1, width - 2);
    let title = `OptChat · ${profile} · ${this.page === 'usage' ? 'Usage' : 'Agents'}`;
    let info: string, body: string[], hint: string;
    if (this.page === 'usage') {
      const lines = wrapTextWithAnsi(clean(this.usageLines()), inner); this.lineCount = lines.length;
      this.scroll = Math.max(0, Math.min(this.scroll, lines.length - this.height));
      body = lines.slice(this.scroll, this.scroll + this.height);
      info = `${this.scroll + 1}–${Math.min(this.scroll + this.height, lines.length)} / ${lines.length}`;
      hint = '←→ period · ↑↓/PgUp/PgDn scroll · Tab agents · Esc close';
    } else {
      const list = children.history.list();
      if (!this.selected) this.selected = list[0]?.id;
      const cursor = Math.max(0, list.findIndex(r => r.id === this.selected));
      this.top = Math.max(0, Math.min(this.top, list.length - this.height));
      if (cursor < this.top) this.top = cursor;
      if (cursor >= this.top + this.height) this.top = cursor - this.height + 1;
      const rows = list.slice(this.top, this.top + this.height).map(run => {
        const live = children.live(run.id), tools = live ? [...live.tools.values()].map(t => t.name).join(', ') : '';
        const status = live ? `${run.state === 'stopping' ? 'stopping' : tools || (live.streaming ? 'responding' : 'working')} · ${elapsed(Date.now() - live.updated)} ago` : run.state;
        return { run, task: oneLine(run.task), status, time: elapsed((run.ended ?? Date.now()) - run.started) };
      });
      // Columns: task (flexible) · status · duration (right-aligned); status yields first on narrow screens.
      const timeWidth = Math.max(0, ...rows.map(r => r.time.length));
      let statusWidth = Math.min(Math.max(0, ...rows.map(r => visibleWidth(r.status))), Math.floor(inner * 0.4));
      if (inner - 2 - statusWidth - timeWidth - 4 < 12) statusWidth = 0;
      const taskWidth = Math.max(1, inner - 2 - timeWidth - 2 - (statusWidth ? statusWidth + 2 : 0));
      body = rows.map(({ run, task, status, time }) => {
        const selected = run.id === this.selected;
        const name = truncateToWidth(fit(task, taskWidth), taskWidth, '', true);
        const meta = `${statusWidth ? `${truncateToWidth(fit(status, statusWidth), statusWidth, '', true)}  ` : ''}${time.padStart(timeWidth)}`;
        return selected ? color('accent', `→ ${name}  ${meta}`) : `  ${name}  ${color('muted', meta)}`;
      });
      if (!body.length) body.push(color('muted', 'No agents yet. Ask the main agent to delegate a task.'));
      info = `${list.filter(isActiveRun).length} active · ${list.length} saved${list.length ? ` · ${cursor + 1}/${list.length}` : ''}`;
      hint = '↑↓ select · Enter open · m model · Tab usage · Esc close';
    }
    title = fit(title, Math.max(1, inner - visibleWidth(info) - 2));
    const footer = wrapTextWithAnsi(hint, inner).map(line => color('dim', line));
    this.hintLines = footer.length;
    const rule = color('border', '─'.repeat(Math.max(1, width)));
    // Same layout as Pi's own selectors: rules above and below, content indented by one column.
    const content = [spread(color('accent', title), color('dim', info), inner), '', ...body, '', ...footer].map(line => ` ${truncateToWidth(line, inner, '…')}`);
    return [rule, ...content, rule].map(line => truncateToWidth(line, width));
  }
}

let showing = false;
/** True while the panel is on screen; cleared before Pi restores the editor so the agent bar returns in the same frame. */
export const inspectorShowing = () => showing;
/** Takes the editor's place, like Pi's own selectors; Pi restores the editor and its draft on close. */
export function showInspector(ctx: ExtensionContext, options: Omit<Options, 'rows' | 'redraw' | 'done' | 'color' | 'context'>) {
  return ctx.ui.custom<InspectorAction | undefined>((tui, theme, _keys, done) => {
    showing = true;
    return new Inspector({ ...options,
      rows: () => tui.terminal.rows, redraw: () => tui.requestRender(), done: action => { showing = false; done(action); },
      color: (tone, text) => theme.fg(tone, text), context: () => ctx.getContextUsage()?.tokens,
    });
  });
}
