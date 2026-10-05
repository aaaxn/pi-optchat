import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Type } from 'typebox';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, getAgentDir, type AgentSession, type AgentSessionEvent, type ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { SUBAGENT, VIEW_DOC } from './prompts.ts';
import { memoryTools, result } from './tools.ts';
import { type Memory } from './memory.ts';
import type { ModelChoice } from './compactor.ts';
import { cacheFor } from './cache.ts';
import { RunHistory, sessionMessages, type RunInfo } from './runs.ts';
import { UsageLedger } from './usage.ts';
import { textContent } from './transcript.ts';

export interface LiveRun {
  session: AgentSession; info: RunInfo; updated: number; streaming?: AgentMessage;
  tools: Map<string, { name: string; args: unknown; output?: unknown; started: number }>;
}
export interface SpawnTask { task: string; cwd?: string }
interface Options { parentSession?: string; usage?: UsageLedger; createSession?: typeof createAgentSession }

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
export class Children {
  private readonly running = new Map<string, LiveRun>();
  readonly history: RunHistory;
  private readonly listeners = new Set<() => void>();
  private closing = false;
  private launching = 0;
  private settling = 0;
  private readonly completions = new Set<Promise<void>>();
  constructor(private readonly memory: Memory, private readonly registry: ModelRegistry,
    private readonly choice: () => ModelChoice, private readonly instructions: () => string,
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
        if (guidance) { guidance.state = 'delivered'; this.save(live.info); }
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
    const instructions = `${this.instructions()}\n\nUse tell_parent only when the main agent needs something now (a blocking question, an important early finding, or when asked to). Your final answer is delivered automatically; do not repeat it with tell_parent.`;
    const launched: LiveRun[] = [];
    let reserved = tasks.length;
    this.launching += reserved;
    try {
      for (const [n, { task }] of tasks.entries()) {
        const directory = directories[n];
        signal?.throwIfAborted();
        if (this.closing) throw new Error('Profile is closing.');
        const id = randomUUID().slice(0, 8);
        // The user's settings list their installed packages; a copy in memory keeps the child from writing them back.
        const settingsManager = SettingsManager.inMemory({ ...SettingsManager.create(directory, getAgentDir()).getSettings(), compaction: { enabled: false }, cacheWarming: 'off' });
        const loader = new DefaultResourceLoader({ cwd: directory, agentDir: getAgentDir(), settingsManager,
          noPromptTemplates: true,
          extensionsOverride: base => ({ ...base, extensions: base.extensions.filter(e => !isOptchat(e.resolvedPath)) }),
          extensionFactories: [pi => {
            const provider = this.registry.getRegisteredProviderConfig(selected.provider);
            if (provider) pi.registerProvider(selected.provider, provider);
            // Same prompt as the main agent (AGENTS.md files, skills, cwd); only the OptChat preamble differs.
            pi.on('before_agent_start', event => {
              event.systemPromptOptions.customPrompt = `${SUBAGENT}\n\n${VIEW_DOC}`;
              event.systemPromptOptions.sections.instructions = instructions;
            });
            pi.on('before_provider_request', (event, ctx) => cacheFor(ctx.model?.api, event.payload));
          }],
        });
        await loader.reload();
        const { session } = await (this.options.createSession ?? createAgentSession)({ cwd: directory, resourceLoader: loader, settingsManager,
          model, thinkingLevel: selected.thinking, sessionManager: SessionManager.create(directory, join(this.profileDirectory, 'runs')),
          customTools: [...memoryTools(() => this.memory), this.parentTool(id)],
        });
        await session.bindExtensions({});
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
        this.dispose(child.session); this.running.delete(child.info.id);
        child.info.state = 'failed'; child.info.ended = Date.now(); child.info.report = `Launch failed: ${String(error)}`;
        this.save(child.info);
      }
      throw error;
    } finally { this.launching -= reserved; }
    // One spawn is one piece of work: its reports reach the parent together, as one message.
    const work = Promise.all(launched.map(live => this.execute(live, view)))
      .then(reports => this.deliver(reports.join('\n\n')))
      .catch(error => this.warn(`Subagent completion failed: ${String(error)}`))
      .finally(() => { this.completions.delete(work); this.changed(); });
    this.completions.add(work);
    this.changed();
    return launched.map(c => c.info.id);
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
  private dispose(session: AgentSession) {
    try { session.dispose(); } catch (error) { this.warn(`Subagent cleanup failed: ${String(error)}`); }
  }
  private async execute(live: LiveRun, view: string) {
    const { session, info } = live;
    try {
      await session.prompt(`${view}\n\nYour task:\n${info.task}`);
      const last = session.messages.findLast(m => m.role === 'assistant');
      const ended = last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted') ? last : undefined;
      info.state = info.state === 'stopping' || ended?.stopReason === 'aborted' ? 'stopped' : ended ? 'failed' : 'completed';
      info.report = ended ? `Task ${ended.stopReason}: ${ended.errorMessage ?? 'No details'}` : session.getLastAssistantText() || 'Finished without a text report.';
    } catch (error) {
      info.state = info.state === 'stopping' ? 'stopped' : 'failed'; info.report = `${info.state}: ${String(error)}`;
    } finally {
      info.ended = Date.now();
      for (const g of info.guidance) if (g.state === 'queued') g.state = 'undelivered';
      try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); }
      catch (error) { this.warn(`Subagent cleanup failed: ${String(error)}`); }
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
    if (!live || live.info.state !== 'running') throw new Error(`No running subagent ${id}.`);
    const text = message.trim(); if (!text) throw new Error('Message is empty.');
    if (source === 'user') this.memory.append('user', `Direct guidance to subagent [${id}]: ${text}`);
    const guidance: RunInfo['guidance'][number] = { text, date: Date.now(), state: 'queued', from: source };
    live.info.guidance.push(guidance); this.save(live.info);
    try { await live.session.steer(text); }
    catch (error) { guidance.state = 'undelivered'; this.save(live.info); throw error; }
    return 'Message queued for the next tool boundary.';
  }
  async stop(id: string) {
    const live = this.running.get(id);
    if (!live) throw new Error(`No running subagent ${id}.`);
    live.info.state = 'stopping';
    try { this.save(live.info); } catch (error) { this.warn(`Could not save stop status: ${String(error)}`); }
    await live.session.abort();
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.running.keys()].map(id => this.stop(id)));
    await Promise.allSettled(this.completions);
  }
}
