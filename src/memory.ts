import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';

export const NODE = 512;
export const VIEW = 128_000;
export const CAP = 30_000;
export type Kind = 'user' | 'talk' | 'tool' | 'echo' | 'note';
export interface Origin { source: 'claude' | 'claude-memory' | 'codex' | 'chatgpt'; conversation: string; message: string; title: string; project?: string }
export interface Entry { i: number; kind: Kind; text: string; size: number; date: string; receipt?: string; origin?: Origin }
export interface Part { l: number; i: number }
export interface Summary extends Part { text: string; size: number }
export interface Compression { context: string; source: string; merge: boolean; historical?: boolean }
export type Compressor = (input: Compression, signal: AbortSignal) => Promise<string>;
const key = ({ l, i }: Part) => l * 2 ** 40 + i;
const UNBUILT = '(not summarized yet: zoom it)';
export const start = ({ l, i }: Part) => i * 2 ** l;
export const end = (part: Part) => start(part) + 2 ** part.l;
export const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
export const flat = (s: string) => s.replace(/[\r\n]+/g, ' ');
const lineBytes = (s: string) => bytes(flat(s));
const VIEW_OPEN = '<chat>\n';
export const isView = (text: string) => text.startsWith(VIEW_OPEN);
const notice = (omitted: number) => `\n[${omitted} characters omitted; head and tail retained]\n`;
export function cap(text: string, limit = CAP) {
  if (text.length <= limit) return text;
  const half = Math.floor((limit - notice(text.length).length) / 2);
  const head = text.slice(0, /[\ud800-\udbff]/.test(text[half - 1]) ? half - 1 : half);
  const tail = text.slice(/[\udc00-\udfff]/.test(text[text.length - half]) ? text.length - half + 1 : text.length - half);
  return head + notice(text.length - head.length - tail.length) + tail;
}
export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const otherWriter = (file: string) => new Error(`Another process wrote ${file}. Close every other Pi on this profile and restart Pi; nothing was written.`);
/** With `size`, refuses to append unless the file still has that size. A last line left without its newline is ended first. Returns the new size. */
export function appendJson(file: string, value: unknown, size?: number) {
  const fd = openSync(file, 'a+', 0o600);
  try {
    const length = fstatSync(fd).size, last = Buffer.alloc(1);
    if (size !== undefined && length !== size) throw otherWriter(file);
    const torn = length > 0 && readSync(fd, last, 0, 1, length - 1) === 1 && last[0] !== 0x0a;
    const data = Buffer.from((torn ? '\n' : '') + JSON.stringify(value) + '\n');
    if (writeSync(fd, data) !== data.length) throw new Error(`Incomplete write: ${file}`);
    fsyncSync(fd);
    return fstatSync(fd).size;
  } finally { closeSync(fd); }
}
function records(dir: string, warn: (s: string) => void): unknown[] {
  if (!existsSync(dir)) return [];
  const result: unknown[] = [];
  for (const name of readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort()) {
    const file = join(dir, name);
    for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      if (!line.trim()) continue;
      try { result.push(JSON.parse(line)); }
      catch { warn(`Skipped damaged JSON at ${file}:${index + 1}`); }
    }
  }
  return result;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function isEntry(value: unknown): value is Entry {
  return object(value) && Number.isSafeInteger(value.i) && typeof value.kind === 'string'
    && ['user', 'talk', 'tool', 'echo', 'note'].includes(value.kind)
    && typeof value.text === 'string' && typeof value.date === 'string';
}
function isSummary(value: unknown): value is Summary {
  return object(value) && Number.isSafeInteger(value.l) && Number.isSafeInteger(value.i)
    && typeof value.text === 'string';
}

/** The log is authoritative. The tree and monotonically coarsening view follow recipe §§2–6. */
export class Memory {
  readonly root: Entry[] = [];
  readonly tree = new Map<number, Summary>();
  readonly view: Part[] = [];
  private readonly events = new EventEmitter();
  private readonly controller = new AbortController();
  private readonly busy = new Map<number, Promise<void>>();
  private readonly retryAt = new Map<number, number>();
  private readonly reported = new Set<number>();
  private readonly lastSeenBytes = new Map<string, number>();
  private viewBytes = 0;
  private leaves = 0;
  /** Per level, every node below this index is built. */
  private readonly low: number[] = [];
  private retryTimer?: ReturnType<typeof setTimeout>;
  private scheduled = false;
  private stopped = false;
  lastError?: string;

  constructor(readonly directory: string, private readonly compress: Compressor,
    private readonly warn: (s: string) => void = console.error,
    readonly budget = VIEW, private readonly jobs = 8, private readonly retryMs = 10_000) {
    for (const sub of ['main', 'tree']) mkdirSync(join(directory, sub), { recursive: true, mode: 0o700 });
    const main = join(directory, 'main'), log = records(main, warn);
    for (const name of readdirSync(main).filter(n => n.endsWith('.jsonl'))) this.lastSeenBytes.set(join(main, name), statSync(join(main, name)).size);
    const entries = log.every(isEntry) ? log.sort((a, b) => a.i - b.i) : undefined;
    if (!entries || entries.some((entry, i) => entry.i !== i)) throw new Error('Invalid/noncontiguous OptChat log; refusing to change it.');
    for (const value of entries) this.root.push({ ...value, size: bytes(`${value.kind}: ${value.text}`) });
    for (const value of records(join(directory, 'tree'), warn)) {
      if (!isSummary(value) || value.l < 0 || value.i < 0 || end(value) > this.root.length)
        throw new Error('Invalid OptChat summary record.');
      if (value.l === 0 && !this.tree.has(key(value))) this.leaves++;
      this.tree.set(key(value), { ...value, size: lineBytes(value.text) });
    }
    // Fold history in order; do not retile the entire log on each turn.
    for (let i = 0; i < this.root.length; i++) { this.push(i); this.fit(i + 1); }
    this.schedule();
  }
  private checkLog(next: string) {
    const main = dirname(next), names = readdirSync(main).filter(n => n.endsWith('.jsonl'));
    if (names.length !== this.lastSeenBytes.size || names.some(n => statSync(join(main, n)).size !== this.lastSeenBytes.get(join(main, n)))) throw otherWriter(next);
  }
  append(kind: Kind, text: string, date = new Date().toISOString(), receipt?: string) {
    if (this.stopped) throw new Error('Memory is closed.');
    const entry: Entry = { i: this.root.length, kind, text, date, size: bytes(`${kind}: ${text}`), ...(receipt ? { receipt } : {}) };
    const file = join(this.directory, 'main', `${localDay()}.jsonl`);
    if (!this.lastSeenBytes.has(file)) this.checkLog(file);
    this.lastSeenBytes.set(file, appendJson(file, entry, this.lastSeenBytes.get(file) ?? 0));
    this.root.push(entry); this.push(entry.i); this.fit(); this.schedule();
    return entry;
  }
  node(part: Part) { return this.tree.get(key(part)); }
  private text(part: Part) { return this.node(part)?.text ?? UNBUILT; }
  /** Unlike recipe §5.2, a placeholder costs no budget: no call ever sees one (§6), and an import's thousands of them would fill the view. */
  private partBytes(part: Part) { return this.node(part)?.size ?? 0; }
  private push(i: number) { const part = { l: 0, i }; this.view.push(part); this.viewBytes += this.partBytes(part); }
  render() { return `${VIEW_OPEN}${this.view.map(p => `${start(p)}+${2 ** p.l}|${flat(this.text(p))}`).join('\n')}\n</chat>`; }
  get ready() { return this.view.every(p => this.node(p)); }
  get pending() { return this.root.length - this.leaves; }
  get active() { return this.busy.size; }
  get size() { return this.viewBytes; }
  /** The view tiles the log in order, so a binary search finds the part covering a position. */
  private visible(part: Part) {
    const at = start(part);
    for (let lo = 0, hi = this.view.length - 1; lo <= hi;) {
      const mid = (lo + hi) >> 1, p = this.view[mid];
      if (end(p) <= at) lo = mid + 1;
      else if (start(p) > at) hi = mid - 1;
      else return p.l === part.l && p.i === part.i;
    }
    return false;
  }
  private fit(total = this.root.length) {
    while (this.viewBytes > this.budget) {
      let best = -1; let due = -Infinity;
      for (let j = 0; j + 1 < this.view.length; j++) {
        const a = this.view[j], b = this.view[j + 1];
        if (a.l !== b.l || a.i % 2 || b.i !== a.i + 1) continue;
        const age = (total - start(a)) / 2 ** (a.l + 2);
        if (age > due && this.node({ l: a.l + 1, i: a.i / 2 })) { best = j; due = age; }
      }
      if (best < 0) break;
      const a = this.view[best], b = this.view[best + 1];
      const parent = { l: a.l + 1, i: a.i / 2 };
      this.viewBytes += this.partBytes(parent) - this.partBytes(a) - this.partBytes(b);
      this.view.splice(best, 2, parent);
    }
    this.events.emit('change');
  }
  private schedule() {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }
  private pump() {
    if (this.stopped) return;
    const total = this.root.length;
    const first = this.view.find(p => !this.node(p));
    const boundary = first ? start(first) : total;
    for (let l = 0; 2 ** l <= total; l++) {
      let low = this.low[l] ?? 0;
      while (this.node({ l, i: low })) low++;
      this.low[l] = low;
      for (let i = low; (i + 1) * 2 ** l <= total; i++) {
        if (this.busy.size >= this.jobs) return;
        const part = { l, i }, id = key(part);
        if ((l === 0 ? i : end(part)) > boundary) break;
        if (this.node(part) || this.busy.has(id) || (this.retryAt.get(id) ?? 0) > Date.now()) continue;
        if (l && (!this.node({ l: l - 1, i: 2 * i }) || !this.node({ l: l - 1, i: 2 * i + 1 }))) continue;
        const promise = this.build(part).catch(error => {
          if (this.stopped) return;
          this.lastError = error instanceof Error ? error.message : String(error);
          if (!this.reported.has(id)) { this.reported.add(id); this.warn(`Compactor ${start(part)}+${2 ** l}: ${this.lastError}`); }
          this.retryAt.set(id, Date.now() + this.retryMs);
          if (!this.retryTimer) this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.schedule(); }, this.retryMs);
        }).finally(() => { this.busy.delete(id); this.events.emit('change'); this.schedule(); });
        this.busy.set(id, promise);
      }
    }
    // A later failure can have a later deadline than the timer installed by the first.
    const deadlines = [...this.retryAt.values()].filter(t => t > Date.now());
    if (deadlines.length && !this.retryTimer) this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.schedule(); }, Math.max(1, Math.min(...deadlines) - Date.now()));
  }
  private async build(part: Part) {
    const source = part.l === 0 ? `${this.root[part.i].kind}: ${this.root[part.i].text}`
      : [0, 1].map(offset => this.text({ l: part.l - 1, i: 2 * part.i + offset })).join('\n');
    const boundary = part.l === 0 ? start(part) : end(part);
    const context = `<chat>\n${this.view.filter(p => end(p) <= boundary).map(p => flat(this.text(p))).join('\n')}\n</chat>`;
    const mergeSource = part.l > 0 ? [0, 1].map(offset => flat(this.text({ l: part.l - 1, i: 2 * part.i + offset }))).join('\n') : source;
    const text = bytes(source) <= NODE ? source : (await this.compress({ context, source: mergeSource, merge: part.l > 0,
      historical: this.root.slice(start(part), end(part)).some(entry => !!entry.origin) }, this.controller.signal)).trim();
    if (this.stopped) return;
    if (!text) throw new Error('Compactor returned an empty summary.');
    const node = { ...part, text, size: lineBytes(text) };
    appendJson(join(this.directory, 'tree', `${localDay()}.jsonl`), node);
    this.tree.set(key(part), node); this.retryAt.delete(key(part));
    // A leaf is usually still in the view when built, but after a damaged tree file a saved parent can already hide it.
    if (part.l === 0) { this.leaves++; if (this.visible(part)) this.viewBytes += node.size; }
    if (!this.retryAt.size) this.lastError = undefined;
    this.fit();
  }
  async settle(signal?: AbortSignal, all = false): Promise<void> {
    const done = () => this.ready && (!all || (this.busy.size === 0 && this.tree.size === this.expectedNodes()));
    if (done()) return;
    if (this.stopped || signal?.aborted) throw new Error('Memory wait cancelled.');
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { this.events.off('change', check); signal?.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(new Error('Memory wait cancelled.')); };
      const check = () => { if (this.stopped) abort(); else if (done()) { cleanup(); resolve(); } };
      this.events.on('change', check); signal?.addEventListener('abort', abort, { once: true }); check();
    });
  }
  private expectedNodes() {
    let count = 0;
    for (let n = this.root.length; n > 0; n = Math.floor(n / 2)) count += n;
    return count;
  }
  zoom(id: number, n: number) {
    if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(n) || n < 1 || !Number.isInteger(Math.log2(n)) || id % n || id + n > this.root.length)
      throw new Error(`No line ${id}+${n}.`);
    if (n === 1) { const entry = this.root[id]; return `${id}+0|${entry.kind}: ${entry.text}`; }
    const l = Math.log2(n) - 1, i = 2 * id / n;
    return [0, 1].map(offset => {
      const part = { l, i: i + offset }, node = this.node(part);
      if (!node) throw new Error('This range is not summarized yet.');
      return `${start(part)}+${2 ** l}|${flat(node.text)}`;
    }).join('\n');
  }
  date(id: number) {
    if (!Number.isSafeInteger(id) || !this.root[id]) throw new Error(`No message ${id}.`);
    return new Date(this.root[id].date).toString();
  }
  async close() {
    this.stopped = true; this.controller.abort(); clearTimeout(this.retryTimer);
    this.events.emit('change'); await Promise.allSettled(this.busy.values());
  }
}
