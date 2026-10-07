import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Children } from './agents.ts';
import type { Memory } from './memory.ts';
import { isActiveRun, isRunning } from './runs.ts';
import type { Usage } from '@earendil-works/pi-ai';
import { ranges, summarizeUsage, type UsageLedger, type UsageRange, type UsageRole } from './usage.ts';

export const clean = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\t/g, '  ');
export const oneLine = (text: string) => clean(text).replace(/\n/g, ' ');
export const count = (n: number) => n.toLocaleString('en-US');
const units = ['', 'k', 'M', 'B'];
/** 950, 12.3k, 164k, 2.4M: enough precision to compare rows at a glance. A value that rounds to 1000 moves up a unit. */
export const short = (n: number) => {
  let unit = 0, value = n;
  const round = (v: number) => v >= 100 || !unit ? Math.round(v) : Number(v.toFixed(1));
  while (unit < units.length - 1 && round(value) >= 1000) { value /= 1000; unit++; }
  return `${round(value)}${units[unit]}`;
};
const dollars = (n: number) => `$${n.toFixed(2)}`;
const cached = (u: Usage) => { const input = u.input + u.cacheRead + u.cacheWrite; return `${input ? Math.round(100 * u.cacheRead / input) : 0}%`; };
const roleNames: Record<UsageRole, string> = { main: 'main', subagent: 'subagents', compactor: 'compactor', import: 'import' };
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
const pages = ['agents', 'usage', 'activity'] as const;
export type InspectorPage = typeof pages[number];
const pageNames: Record<InspectorPage, string> = { agents: 'Agents', usage: 'Usage', activity: 'Activity' };
/** Tab order, wrapping around: Agents, Usage, Activity. */
export const nextPage = (page: InspectorPage, delta = 1) => pages[(pages.indexOf(page) + delta + pages.length) % pages.length];
/** Closing the panel either picks the subagent model or opens one agent's conversation. */
export type InspectorAction = 'model' | { open: string };
type Tone = 'accent' | 'muted' | 'dim' | 'error' | 'warning' | 'border';
interface Options {
  profile: string; session: string; children: Children; usage: UsageLedger; memory: Pick<Memory, 'root' | 'size' | 'budget' | 'lastError' | 'progress' | 'onChange'>; page: InspectorPage;
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
  private readonly unsubscribe: (() => void)[];
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly options: Options) {
    this.page = options.page;
    this.selected = options.children.history.list()[0]?.id;
    this.unsubscribe = [options.children.subscribe(() => options.redraw()), options.memory.onChange(() => options.redraw())];
    this.timer = setInterval(() => { options.refreshUsage?.(); options.redraw(); }, 1000); this.timer.unref();
    options.signal?.addEventListener('abort', this.abort, { once: true });
    if (options.signal?.aborted) queueMicrotask(this.abort);
  }
  private readonly abort = () => this.finish();
  private finish(action?: InspectorAction) { if (!this.ended) { this.dispose(); this.options.done(action); } }
  dispose() {
    this.ended = true; clearInterval(this.timer); this.unsubscribe.forEach(stop => stop()); this.options.signal?.removeEventListener('abort', this.abort);
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
    if (matchesKey(data, 'tab')) {
      this.page = nextPage(this.page); this.scroll = 0;
    } else if (this.page === 'activity') this.scrollInput(data);
    else if (this.page === 'usage') {
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
  /** Period tabs, one headline, then an aligned table with a row per role and model. */
  private usageLines(width: number) {
    const { usage, session, context, color } = this.options;
    const entries = usage.select(this.range, session);
    const { total, groups } = summarizeUsage(entries);
    // No-break spaces keep a label like "Last 7 days" on one line when the tabs wrap.
    const tabs = ranges.map(r => r.replaceAll(' ', '\u00a0')).map((r, i) => ranges[i] === this.range ? color('accent', `[${r}]`) : color('dim', r)).join('  ');
    const lines = [...wrapTextWithAnsi(tabs, width), ''];
    if (!entries.length) lines.push(color('muted', 'No usage in this period.'));
    else {
      lines.push(`${color('accent', dollars(total.cost.total))} estimated · ${short(total.totalTokens)} tokens · ${cached(total)} cached`, '');
      const order = ['main', 'subagent', 'compactor', 'import'] as const;
      const sorted = groups.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || b.usage.cost.total - a.usage.cost.total);
      const rows = sorted.map((g, i) => [i && sorted[i - 1].role === g.role ? '' : roleNames[g.role], oneLine(g.model), dollars(g.usage.cost.total),
        `${total.cost.total ? Math.round(100 * g.usage.cost.total / total.cost.total) : 0}%`, short(g.usage.output), cached(g.usage)]);
      const header = ['', 'model', 'cost', 'share', 'out', 'cached'];
      const widths = header.map((h, c) => Math.max(h.length, ...rows.map(r => r[c].length)));
      // The model column goes first when the screen is too narrow for every column.
      const columns = widths.reduce((sum, w) => sum + w + 2, 0) - 2 <= width ? [0, 1, 2, 3, 4, 5] : [0, 2, 3, 4, 5];
      const line = (cells: string[]) => columns.map(c => c < 2 ? cells[c].padEnd(widths[c]) : cells[c].padStart(widths[c])).join('  ').trimEnd();
      lines.push(color('dim', line(header)), ...rows.map(r => {
        const text = line(r); return color('muted', text.slice(0, widths[0])) + text.slice(widths[0]);
      }));
    }
    const current = context();
    if (current != null) lines.push('', `${color('muted', 'Context now')} ${short(current)} tokens`);
    lines.push('', color('dim', 'Estimated at API prices, not your subscription bill.'), ...usage.warnings.map(w => color('warning', w)));
    return lines.flatMap(l => l ? wrapTextWithAnsi(l, width) : ['']);
  }
  /** Memory as a gauge: how full the view is, whether summaries are catching up, and how many agents run (their list is one Tab away). */
  private activityLines(width: number) {
    const { memory, children, color } = this.options;
    const { done, total, retryIn } = memory.progress();
    const list = children.history.list(), agents = list.filter(isRunning).length, paused = list.filter(r => r.state === 'paused').length;
    const filled = total ? Math.floor(10 * done / total) : 0;
    const lines = [`${color('muted', 'Memory')} · ${count(memory.root.length)} messages · view ${Math.round(memory.size / 1000)} KB / ${Math.round(memory.budget / 1000)} KB`,
      total ? `Catching up · ${count(done)} of ${count(total)} summaries  ${color('accent', '█'.repeat(filled))}${color('dim', '░'.repeat(10 - filled))}` : color('dim', 'Settled')];
    if (memory.lastError) lines.push(color('dim', `${oneLine(memory.lastError)}${retryIn === undefined ? '' : ` · retry in ${elapsed(retryIn)}`}`));
    lines.push('', `${color('muted', 'Agents')} · ${agents} running${paused ? ` · ${paused} interrupted` : ''}`);
    return lines.flatMap(l => l ? wrapTextWithAnsi(l, width) : ['']);
  }
  render(width: number): string[] {
    const { color, children, profile } = this.options;
    const inner = Math.max(1, width - 2);
    let title = `OptChat · ${profile} · ${pageNames[this.page]}`;
    let info: string, body: string[], hint: string;
    if (this.page !== 'agents') {
      const lines = this.page === 'usage' ? this.usageLines(inner) : this.activityLines(inner); this.lineCount = lines.length;
      this.scroll = Math.max(0, Math.min(this.scroll, lines.length - this.height));
      body = lines.slice(this.scroll, this.scroll + this.height);
      info = this.page === 'usage' || lines.length > this.height ? `${this.scroll + 1}–${Math.min(this.scroll + this.height, lines.length)} / ${lines.length}` : '';
      hint = this.page === 'usage' ? '←→ period · ↑↓ scroll · Tab activity · Esc close' : '↑↓ scroll · Tab agents · Esc close';
    } else {
      const list = children.history.list();
      if (!this.selected) this.selected = list[0]?.id;
      const cursor = Math.max(0, list.findIndex(r => r.id === this.selected));
      this.top = Math.max(0, Math.min(this.top, list.length - this.height));
      if (cursor < this.top) this.top = cursor;
      if (cursor >= this.top + this.height) this.top = cursor - this.height + 1;
      const rows = list.slice(this.top, this.top + this.height).map(run => {
        const live = children.live(run.id), tools = live ? [...live.tools.values()].map(t => t.name).join(', ') : '';
        const status = live ? `${run.state === 'stopping' ? 'stopping' : run.state === 'waiting' ? 'waiting for children' : run.state === 'paused' ? 'interrupted · waiting for you' : tools || (live.streaming ? 'responding' : 'working')} · ${elapsed(Date.now() - live.updated)} ago` : run.state;
        return { run, task: `${'  '.repeat(run.depth - 1)}${run.parentId ? '↳ ' : ''}${oneLine(run.task)}`, status, time: elapsed((run.ended ?? Date.now()) - run.started) };
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
