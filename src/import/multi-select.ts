import { Input, matchesKey, truncateToWidth, type Component, type Focusable } from '@earendil-works/pi-tui';
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';

const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
interface Options {
  title: string;
  labels: string[];
  rows: () => number;
  redraw: () => void;
  done: (indices: number[] | undefined) => void;
  color: (tone: 'accent' | 'dim' | 'error', text: string) => string;
  signal?: AbortSignal;
}

/** One mounted picker: toggling never recreates the dialog or resets its viewport. */
export class MultiSelect implements Component, Focusable {
  private readonly filter = new Input({ prompt: 'Filter: ', placeholder: 'type to filter' });
  private readonly labels: string[];
  private readonly selected = new Set<number>();
  private visible: number[];
  private cursor = 0;
  private top = 0;
  private ended = false;
  private error = '';
  constructor(private readonly options: Options) {
    this.labels = options.labels.map(clean);
    this.visible = this.labels.map((_, i) => i);
    options.signal?.addEventListener('abort', this.abort, { once: true });
    if (options.signal?.aborted) queueMicrotask(this.abort);
  }
  get focused() { return this.filter.focused; }
  set focused(value: boolean) { this.filter.focused = value; }
  private get pageSize() { return Math.max(1, Math.min(20, this.options.rows() - 12)); }
  private readonly abort = () => this.finish(undefined);
  private finish(result: number[] | undefined) {
    if (this.ended) return;
    this.dispose(); this.options.done(result);
  }
  dispose() { this.ended = true; this.options.signal?.removeEventListener('abort', this.abort); }
  invalidate() { this.filter.invalidate(); }
  handleInput(data: string) {
    if (this.ended) return;
    this.error = '';
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) return this.finish(undefined);
    if (matchesKey(data, 'return')) {
      if (this.selected.size) return this.finish([...this.selected].sort((a, b) => a - b));
      this.error = 'Select at least one item with Tab.';
    } else if (matchesKey(data, 'tab') || (matchesKey(data, 'space') && !this.filter.getValue())) {
      const index = this.visible[this.cursor];
      if (index !== undefined) { if (this.selected.has(index)) this.selected.delete(index); else this.selected.add(index); }
    } else if (matchesKey(data, 'ctrl+a')) this.visible.forEach(i => this.selected.add(i));
    else if (matchesKey(data, 'ctrl+d')) this.visible.forEach(i => this.selected.delete(i));
    else if (matchesKey(data, 'down')) this.cursor++;
    else if (matchesKey(data, 'up')) this.cursor--;
    else if (matchesKey(data, 'pageDown')) this.cursor += this.pageSize;
    else if (matchesKey(data, 'pageUp')) this.cursor -= this.pageSize;
    else if (matchesKey(data, 'home')) this.cursor = 0;
    else if (matchesKey(data, 'end')) this.cursor = this.visible.length - 1;
    else {
      const before = this.filter.getValue(); this.filter.handleInput(data);
      if (this.filter.getValue() !== before) {
        const query = clean(this.filter.getValue()).toLocaleLowerCase();
        this.visible = this.labels.map((_, i) => i).filter(i => this.labels[i].toLocaleLowerCase().includes(query));
        this.cursor = 0; this.top = 0;
      }
    }
    this.cursor = Math.max(0, Math.min(this.cursor, this.visible.length - 1));
    this.options.redraw();
  }
  render(width: number): string[] {
    const { color } = this.options;
    const page = this.pageSize;
    this.top = Math.max(0, Math.min(this.top, this.visible.length - page));
    if (this.cursor < this.top) this.top = this.cursor;
    if (this.cursor >= this.top + page) this.top = this.cursor - page + 1;
    const lines = [color('accent', `${clean(this.options.title)} · ${this.selected.size} selected`), ...this.filter.render(width), ''];
    for (let row = this.top; row < Math.min(this.visible.length, this.top + page); row++) {
      const index = this.visible[row];
      const label = `${row === this.cursor ? '→' : ' '} [${this.selected.has(index) ? 'x' : ' '}] ${index + 1}. ${this.labels[index]}`;
      lines.push(row === this.cursor ? color('accent', truncateToWidth(label, width)) : truncateToWidth(label, width));
    }
    if (!this.visible.length) lines.push('No matches. Ctrl+U clears the filter.');
    lines.push(color('dim', `${this.visible.length ? this.cursor + 1 : 0}/${this.visible.length} matching · ${this.labels.length} total`));
    lines.push(color(this.error ? 'error' : 'dim', this.error || '↑↓ move · PgUp/PgDn page · Home/End jump'));
    lines.push(color('dim', 'Tab toggle · Space toggle (empty filter) · Enter continue · Esc cancel'));
    lines.push(color('dim', 'Ctrl+A select matches · Ctrl+D clear matches'));
    return lines.map(line => truncateToWidth(line, width));
  }
}

export async function selectMany<T>(ui: Pick<ExtensionUIContext, 'custom'>, title: string, items: T[], label: (item: T) => string, signal: AbortSignal): Promise<T[] | undefined> {
  if (signal.aborted) return undefined;
  const indices = await ui.custom<number[] | undefined>((tui, theme, _keys, done) => new MultiSelect({
    title, labels: items.map(label), rows: () => tui.terminal.rows,
    redraw: () => tui.requestRender(), done, color: (tone, text) => theme.fg(tone, text), signal,
  }));
  return indices?.map(i => items[i]);
}
