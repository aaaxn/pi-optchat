import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Type } from 'typebox';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, getAgentDir, type AgentSession, type AgentSessionEvent, type ExtensionAPI, type InlineExtension, type ModelRegistry } from '@earendil-works/pi-coding-agent';
import * as sdk from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { SUBAGENT, VIEW_DOC } from './prompts.ts';
import { memoryTools, result } from './tools.ts';
import { type Memory } from './memory.ts';
import type { ModelChoice } from './compactor.ts';
import { cacheFor } from './cache.ts';
import { agentInstructions } from './profiles.ts';
import { deliverGuidance, RunHistory, sessionMessages, transition, undeliverGuidance, type RunInfo } from './runs.ts';
import { UsageLedger } from './usage.ts';
import { textContent } from './transcript.ts';

export interface LiveRun {
  session: AgentSession; info: RunInfo; updated: number; streaming?: AgentMessage;
  tools: Map<string, { name: string; args: unknown; output?: unknown; started: number }>;
}
export interface SpawnTask { task: string; cwd?: string }
interface Options { parentSession?: string; usage?: UsageLedger; createSession?: typeof createAgentSession;
  /** Names of the built-in extensions the main session loaded (see `loadedBuiltins`). */
  builtins?: () => Iterable<string> }

// Subagents load the user's installed extensions, except any copy of OptChat itself: they get memory tools directly and must not open a profile.
const packageName = (path: string): string | undefined => {
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const data: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
      return data && typeof data === 'object' && 'name' in data && typeof data.name === 'string' ? data.name : undefined;
    } catch { return undefined; } // A broken manifest is not OptChat's and must not block every spawn.
  }
};
/** A task's cwd may start with `~` and may be relative to the spawning agent's directory. */
export const taskDirectory = (cwd: string, path = '.', windows = process.platform === 'win32') =>
  resolve(cwd, path.replace(windows ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/, homedir()));
export const CWD_DOC = 'Project directory the subagent works in (~ allowed); its AGENTS.md files load from there. Defaults to your current directory.';
const isOptchat = (path: string) => packageName(path) === 'pi-optchat';

// Pi's CLI adds its built-in extensions (MCP, codemode, tool search) to its own session; SDK sessions such as
// subagents must add them. Pi versions that do not export a factory simply do not get that extension.
const BUILTINS: Record<string, string> = { mcp: 'createMcpExtension', codemode: 'createCodemodeExtension', 'tool-search': 'createToolSearchExtension' };
const PREFIX = 'builtin:';
/** The built-in extensions a session loaded: `--no-mcp`, `-builtin:<name>` settings and replacing extensions leave them out. */
export const loadedBuiltins = (pi: Pick<ExtensionAPI, 'getCommands' | 'getAllTools'>) => new Set([...pi.getCommands(), ...pi.getAllTools()]
  .map(item => item.sourceInfo?.path ?? '').filter(path => path.startsWith(PREFIX) && Object.hasOwn(BUILTINS, path.slice(PREFIX.length))).map(path => path.slice(PREFIX.length)));
/** Fresh built-in extensions for one session, as `builtin:<name>` resources, so the session's own settings still apply. */
export const builtinExtensions = (names: Iterable<string>): InlineExtension[] => [...new Set(names)].flatMap(name => {
  const create = Object.hasOwn(BUILTINS, name) ? (sdk as unknown as Record<string, unknown>)[BUILTINS[name]] : undefined;
  return typeof create === 'function' ? [{ name, factory: create(), replaceable: true, builtin: true }] : [];
});
export class Children {
  private readonly running = new Map<string, LiveRun>();
  readonly history: RunHistory;
  private readonly listeners = new Set<() => void>();
  private closing = false;
  private launching = 0;
  private readonly resuming = new Set<string>();
  private settling = 0;
  private readonly launches = new Set<Promise<unknown>>();
  private readonly completions = new Set<Promise<void>>();
  constructor(private readonly memory: Memory, private readonly registry: ModelRegistry,
    private readonly choice: () => ModelChoice,
    private readonly report: (text: string) => Promise<void>, private readonly warn: (text: string) => void,
    private readonly profileDirectory = memory.directory, private readonly options: Options = {}) {
    this.history = new RunHistory(profileDirectory);
    for (const warning of this.history.warnings) warn(warning);
    for (const run of this.history.records.values()) {
      if (!run.sessionFile || !options.usage) continue;
      try {
        const manager = SessionManager.open(run.sessionFile);
        options.usage.backfill(manager.getEntries(), run.parentSession, 'subagent', run.id);
      } catch (error) { warn(`Could not backfill child usage for ${run.id}: ${String(error)}`); }
    }
  }
  get ids() { return [...this.running.keys()]; }
  get active() { return this.completions.size > 0 || this.launching > 0 || this.settling > 0; }
  live(id: string) { return this.running.get(id); }
  collectUsage() {
    for (const live of this.running.values()) this.options.usage?.backfill(live.session.sessionManager.getEntries(), live.info.parentSession, 'subagent', live.info.id);
  }
  messages(id: string): AgentMessage[] {
    const live = this.running.get(id);
    if (live) return [...live.session.messages, ...(live.streaming ? [live.streaming] : [])];
    const file = this.history.records.get(id)?.sessionFile;
    return file ? sessionMessages(file) : [];
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  private save(info: RunInfo) { this.history.save(info); this.changed(); }
  private observe(live: LiveRun, event: AgentSessionEvent) {
    try {
      live.updated = Date.now();
      if (event.type === 'message_update') live.streaming = event.message;
      if (event.type === 'message_end') live.streaming = undefined;
      if (event.type === 'turn_end' || event.type === 'agent_settled') this.options.usage?.backfill(live.session.sessionManager.getEntries(), live.info.parentSession, 'subagent', live.info.id);
      if (event.type === 'message_start' && event.message.role === 'user') {
        const text = textContent(event.message.content);
        const guidance = live.info.guidance.find(g => g.state === 'queued' && g.text === text);
        if (guidance) { deliverGuidance(guidance); this.save(live.info); }
      }
      if (event.type === 'tool_execution_start') live.tools.set(event.toolCallId, { name: event.toolName, args: event.args, started: Date.now() });
      if (event.type === 'tool_execution_update') {
        const tool = live.tools.get(event.toolCallId); if (tool) tool.output = event.partialResult;
      }
      if (event.type === 'tool_execution_end') live.tools.delete(event.toolCallId);
      this.changed();
    } catch (error) { this.warn(`Could not record subagent activity: ${String(error)}`); }
  }
  async spawn(tasks: SpawnTask[], cwd: string, signal?: AbortSignal) {
    // Each child starts in its project, so Pi loads that project's AGENTS.md files for it.
    const directories = tasks.map(t => taskDirectory(cwd, t.cwd));
    for (const directory of directories) if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error(`No such directory: ${directory}`);
    if (this.closing) throw new Error('Profile is closing.');
    this.settling++;
    try { await this.memory.settle(signal); } finally { this.settling--; }
    if (this.closing) throw new Error('Profile is closing.');
    if (this.running.size + this.launching + tasks.length > 8) throw new Error('Profile limit: at most 8 active agents. Reduce the batch or continue without delegating.');
    const view = this.memory.render();
    const selected = this.choice();
    const model = this.registry.find(selected.provider, selected.model);
    if (!model) throw new Error(`Subagent model unavailable: ${selected.provider}/${selected.model}`);
    const launched = await this.track(this.launchBatch(tasks, directories, selected, model, signal));
    // One spawn is one piece of work: its reports reach the parent together, as one message.
    const work = Promise.all(launched.map(live => this.execute(live, `${view}\n\nYour task:\n${live.info.task}`)))
      .then(reports => this.deliver(reports.join('\n\n')))
      .catch(error => this.warn(`Subagent completion failed: ${String(error)}`))
      .finally(() => { this.completions.delete(work); this.changed(); });
    this.completions.add(work);
    this.changed();
    return launched.map(c => c.info.id);
  }
  /** close() waits for launches, so shutdown never unlocks the profile under a child that is still opening. */
  private track<T>(launch: Promise<T>) {
    this.launches.add(launch);
    const done = () => { this.launches.delete(launch); };
    launch.then(done, done);
    return launch;
  }
  private async launchBatch(tasks: SpawnTask[], directories: string[], selected: ModelChoice, model: Model<Api>, signal?: AbortSignal) {
    const launched: LiveRun[] = [];
    let reserved = tasks.length;
    this.launching += reserved;
    try {
      for (const [n, { task }] of tasks.entries()) {
        const directory = directories[n];
        signal?.throwIfAborted();
        if (this.closing) throw new Error('Profile is closing.');
        const id = randomUUID().slice(0, 8);
        const session = await this.open({ id, directory, provider: selected.provider, model, thinking: selected.thinking,
          sessionManager: SessionManager.create(directory, join(this.profileDirectory, 'runs')) });
        const info: RunInfo = { id, task, cwd: directory, model: `${selected.provider}/${selected.model}`, thinking: session.thinkingLevel,
          parentSession: this.options.parentSession ?? '', sessionFile: session.sessionFile, started: Date.now(), state: 'running', guidance: [] };
        const live: LiveRun = { session, info, updated: Date.now(), tools: new Map() };
        launched.push(live); this.save(info); this.running.set(id, live);
        this.launching--; reserved--;
        session.subscribe(event => this.observe(live, event));
        signal?.throwIfAborted();
        if (this.closing) throw new Error('Profile is closing.');
      }
    } catch (error) {
      for (const child of launched) {
        await this.shutdown(child.session); // Extensions such as MCP close their connections and stop their server processes.
        this.dispose(child.session); this.running.delete(child.info.id);
        transition(child.info, 'failed'); child.info.ended = Date.now(); child.info.report = `Launch failed: ${String(error)}`;
        this.save(child.info);
      }
      throw error;
    } finally { this.launching -= reserved; }
    return launched;
  }
  /** Builds a child session with the same prompt, tools and extensions whether it is new or resumed. */
  private async open(o: { id: string; directory: string; provider: string; model: Model<Api>; thinking?: ModelChoice['thinking']; sessionManager: SessionManager }) {
    const instructions = `${agentInstructions(this.profileDirectory)}\n\nUse tell_parent only when the main agent needs something now (a blocking question, an important early finding, or when asked to). Your final answer is delivered automatically; do not repeat it with tell_parent.`;
    // The user's settings list their installed packages; a copy in memory keeps the child from writing them back.
    const settingsManager = SettingsManager.inMemory({ ...SettingsManager.create(o.directory, getAgentDir()).getSettings(), compaction: { enabled: false }, cacheWarming: 'off' });
    const loader = new DefaultResourceLoader({ cwd: o.directory, agentDir: getAgentDir(), settingsManager,
      noPromptTemplates: true,
      extensionsOverride: base => ({ ...base, extensions: base.extensions.filter(e => !isOptchat(e.resolvedPath)) }),
      extensionFactories: [...builtinExtensions(this.options.builtins?.() ?? []), pi => {
        const provider = this.registry.getRegisteredProviderConfig(o.provider);
        if (provider) pi.registerProvider(o.provider, provider);
        // Same prompt as the main agent (AGENTS.md files, skills, cwd); only the OptChat preamble differs.
        pi.on('before_agent_start', event => {
          event.systemPromptOptions.customPrompt = `${SUBAGENT}\n\n${VIEW_DOC}`;
          event.systemPromptOptions.sections.instructions = instructions;
        });
        pi.on('before_provider_request', (event, ctx) => cacheFor(ctx.model?.api, event.payload));
      }],
    });
    await loader.reload();
    const { session } = await (this.options.createSession ?? createAgentSession)({ cwd: o.directory, resourceLoader: loader, settingsManager,
      model: o.model, thinkingLevel: o.thinking, sessionManager: o.sessionManager,
      customTools: [...memoryTools(() => this.memory), this.parentTool(o.id)],
    });
    // Callers track the session only after this returns: clean up here if its extensions fail to start.
    try { await session.bindExtensions({}); }
    catch (error) { await this.shutdown(session); this.dispose(session); throw error; }
    return session;
  }
  /** Lets a child message the main agent mid-run, the way tell lets the main agent guide it. */
  private parentTool(id: string) {
    return { name: 'tell_parent', label: 'Message main agent',
      description: 'Send the main agent a question or important finding while you keep working. Its reply can arrive as guidance; continue useful work instead of polling. Your final answer is delivered automatically.',
      parameters: Type.Object({ message: Type.String() }), execute: async (_id: string, args: { message: string }) => {
        const message = args.message.trim();
        if (!message) throw new Error('Message is empty.');
        await this.report(`[${id}] Message from subagent (still running): ${message}`);
        return result('Message sent to the main agent.');
      },
    };
  }
  private async shutdown(session: AgentSession) {
    try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); }
    catch (error) { this.warn(`Subagent cleanup failed: ${String(error)}`); }
  }
  private dispose(session: AgentSession) {
    try { session.dispose(); } catch (error) { this.warn(`Subagent cleanup failed: ${String(error)}`); }
  }
  private async execute(live: LiveRun, prompt: string) {
    const { session, info } = live;
    try {
      await session.prompt(prompt);
      const last = session.messages.findLast(m => m.role === 'assistant');
      const ended = last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted') ? last : undefined;
      transition(info, info.state === 'stopping' || ended?.stopReason === 'aborted' ? 'stopped' : ended ? 'failed' : 'completed');
      info.report = ended ? `Task ${ended.stopReason}: ${ended.errorMessage ?? 'No details'}` : session.getLastAssistantText() || 'Finished without a text report.';
    } catch (error) {
      transition(info, info.state === 'stopping' ? 'stopped' : 'failed'); info.report = `${info.state}: ${String(error)}`;
    } finally {
      info.ended = Date.now();
      for (const g of info.guidance) if (g.state === 'queued') undeliverGuidance(g);
      await this.shutdown(session);
      // A failed dispose must neither keep the slot taken nor drop the report below.
      this.dispose(session); this.running.delete(info.id);
    }
    // A metadata failure must not suppress delivery of the actual result.
    try { this.save(info); } catch (error) { this.warn(`Could not save run metadata: ${String(error)}`); }
    return `[${info.id}] ${info.report}`;
  }
  private async deliver(text: string) {
    if (this.closing) { this.memory.append('user', text); return; }
    try { await this.report(text); }
    catch (error) {
      this.memory.append('user', text);
      this.warn(`Subagent report saved but could not wake the parent: ${String(error)}`);
    }
  }
  async tell(id: string, message: string, source: 'manager' | 'user' = 'manager') {
    const live = this.running.get(id);
    if (!live && source === 'manager' && this.history.records.has(id)) return this.track(this.resume(id, message));
    if (live && live.info.state !== 'running') throw new Error(`${id} is finishing. Its report will arrive on its own${source === 'user' ? '' : '; tell it again after that to resume it'}.`);
    if (!live) throw new Error(`No running subagent ${id}.`);
    const text = message.trim(); if (!text) throw new Error('Message is empty.');
    if (source === 'user') this.memory.append('user', `Direct guidance to subagent [${id}]: ${text}`);
    const guidance: RunInfo['guidance'][number] = { text, date: Date.now(), state: 'queued', from: source };
    live.info.guidance.push(guidance); this.save(live.info);
    try { await live.session.steer(text); }
    catch (error) { undeliverGuidance(guidance); this.save(live.info); throw error; }
    if (guidance.state === 'undelivered') throw new Error(`${id} finished before it read the message. Tell it again to resume it.`);
    return 'Message queued for the next tool boundary.';
  }
  /** Reopens a finished child from its saved transcript, same ID and model, and gives it a new message. */
  private async resume(id: string, message: string) {
    const run = this.history.records.get(id)!, text = message.trim();
    if (!text) throw new Error('Message is empty.');
    if (!['completed', 'failed', 'stopped', 'interrupted'].includes(run.state) || this.resuming.has(id)) throw new Error(`${id} is still finishing. Its report will arrive on its own.`);
    if (this.closing) throw new Error('Profile is closing.');
    if (this.running.size + this.launching + 1 > 8) throw new Error(`Profile limit: at most 8 active agents. ${id} can be resumed when one finishes.`);
    let manager: SessionManager | undefined;
    try { if (run.sessionFile && existsSync(run.sessionFile)) manager = SessionManager.open(run.sessionFile); } catch { manager = undefined; }
    if (!manager?.getEntries().some(e => e.type === 'message')) throw new Error(`The saved transcript of ${id} is missing or unreadable, so it cannot be resumed. Spawn a fresh subagent and give it the context it needs.`);
    if (!existsSync(run.cwd) || !statSync(run.cwd).isDirectory()) throw new Error(`${id}'s directory ${run.cwd} no longer exists, so it cannot be resumed. Spawn a fresh subagent instead.`);
    const slash = run.model.indexOf('/'), provider = run.model.slice(0, slash);
    const model = slash > 0 ? this.registry.find(provider, run.model.slice(slash + 1)) : undefined;
    if (!model) throw new Error(`${id}'s model ${run.model} is not available, so it cannot be resumed. Spawn a fresh subagent instead.`);
    this.launching++; this.resuming.add(id);
    let reserved = true;
    try {
      // No thinking level: the session restores the one it ran with.
      const session = await this.open({ id, directory: run.cwd, provider, model, sessionManager: manager });
      if (this.closing) { await this.shutdown(session); this.dispose(session); throw new Error('Profile is closing.'); }
      // The finished record stays untouched (and resumable) unless the new one is saved.
      const { ended: _ended, ...rest } = run;
      const info: RunInfo = { ...rest, state: 'running', started: Date.now(), parentSession: this.options.parentSession ?? run.parentSession,
        guidance: [...run.guidance, { text, date: Date.now(), state: 'queued', from: 'manager' }] };
      try { this.save(info); } catch (error) { this.history.records.set(id, run); await this.shutdown(session); this.dispose(session); throw error; }
      const live: LiveRun = { session, info, updated: Date.now(), tools: new Map() };
      this.running.set(id, live);
      this.launching--; reserved = false;
      session.subscribe(event => this.observe(live, event));
      const work = this.execute(live, text).then(report => this.deliver(report))
        .catch(error => this.warn(`Subagent completion failed: ${String(error)}`))
        .finally(() => { this.completions.delete(work); this.changed(); });
      this.completions.add(work);
    } finally { if (reserved) this.launching--; this.resuming.delete(id); }
    this.changed();
    return `${id} had finished, so I resumed it with its earlier conversation. Its new report will come back on its own.`;
  }
  async stop(id: string) {
    const live = this.running.get(id);
    if (!live) throw new Error(`No running subagent ${id}.`);
    if (!transition(live.info, 'stopping')) return;
    try { this.save(live.info); } catch (error) { this.warn(`Could not save stop status: ${String(error)}`); }
    await live.session.abort();
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.running.keys()].map(id => this.stop(id)));
    await Promise.allSettled(this.launches);
    await Promise.allSettled(this.completions);
  }
}
