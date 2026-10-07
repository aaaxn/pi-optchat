import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, getAgentDir, type AgentSession, type AgentSessionEvent, type ExtensionAPI, type InlineExtension, type ModelRegistry } from '@earendil-works/pi-coding-agent';
import * as sdk from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { SUBAGENT, VIEW_DOC } from './prompts.ts';
import { memoryTools, SEARCH_DOC, searchTool } from './tools.ts';
import { type Memory } from './memory.ts';
import type { ModelChoice } from './compactor.ts';
import { cachePayload } from './cache.ts';
import { RunHistory, transition, sessionMessages, type RunInfo, type RunState, type FinishReason } from './runs.ts';
import { UsageLedger } from './usage.ts';
import { textContent } from './transcript.ts';
import { Type } from 'typebox';
import { result } from './tools.ts';
import type { HandoffEvidence } from './handoff.ts';
import { DEFAULT_SETTINGS, type Settings } from './settings.ts';

export interface LiveRun {
  session: AgentSession; info: RunInfo; updated: number; streaming?: AgentMessage;
  tools: Map<string, { name: string; args: unknown; output?: unknown; started: number }>;
  pendingReports: string[]; pendingGuidance: string[]; wake?: () => void; completion?: Promise<void>;
  /** Set by the user's interrupt: the queued guidance the run continues with once its current step is aborted; with none, it pauses. */
  interruption?: RunInfo['guidance'];
  /** Messages being steered back into Pi's queue after it was cleared; other queue changes wait for it. */
  requeueing?: Promise<void>;
  /** Shared by the children of one spawn whose reports are delivered together, in spawn order. */
  batch?: { ids: string[]; reports: Map<string, string> };
}
interface Options { parentSession?: string; usage?: UsageLedger; createSession?: typeof createAgentSession;
  /** Names of the built-in extensions the main session loaded (see `loadedBuiltins`). */
  builtins?: () => Iterable<string>;
  /** Journals the reports a main-agent spawn has so far while its other children still run (none: the batch was delivered), so a crash cannot lose them. */
  hold?: (batch: string, texts: string[]) => void;
  /** Read on every spawn, so a changed profile setting applies to the next one. Missing settings take their defaults. */
  settings?: () => Partial<Settings>;
  summarizeHandoff?: (run: RunInfo, messages: AgentMessage[], descendants?: HandoffEvidence[]) => Promise<string> }

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
/** Pi hands steering to a run only between tool calls, so one long command keeps the parent and the user from reaching it. */
export const STEERABLE = 'Never block in a single command for more than about 60 seconds. To wait for something, poll in short separate tool calls (for example one `sleep 30` per call), so messages from your parent or the user can reach you between calls.';

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
    private readonly choice: () => ModelChoice, private readonly instructions: () => string,
    private readonly report: (text: string, options?: { once?: boolean; count?: number }) => Promise<void>, private readonly warn: (text: string) => void,
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
  private get settings(): Settings { return { ...DEFAULT_SETTINGS, ...this.options.settings?.() }; }
  private full(extra: number) { return this.running.size + this.launching + extra > this.settings.maxAgents; }
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
      if (event.type === 'message_end') {
        live.streaming = undefined;
      }
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
  async spawn(tasks: { task: string; cwd?: string }[], cwd: string, signal?: AbortSignal, parentId?: string, connected = false) {
    return (await this.launch(tasks, cwd, signal, parentId, connected)).ids;
  }
  /** The spawn tools' answer, saying how this spawn's reports will come back. */
  async start(tasks: { task: string; cwd?: string }[], cwd: string, signal?: AbortSignal, parentId?: string) {
    const { ids, grouped } = await this.launch(tasks, cwd, signal, parentId);
    return `Started: ${ids.join(', ')}. ${grouped && ids.length > 1 ? 'Their reports will arrive together, as one message, once all of them have finished.' : 'Reports will arrive automatically.'}`;
  }
  private async launch(tasks: { task: string; cwd?: string }[], cwd: string, signal: AbortSignal | undefined, parentId: string | undefined, connected = false) {
    for (const directory of tasks.map(t => taskDirectory(cwd, t.cwd))) if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error(`No such directory: ${directory}`);
    if (this.closing) throw new Error('Profile is closing.');
    this.settling++;
    try { await this.memory.settle(signal); } finally { this.settling--; }
    const parent = parentId ? this.running.get(parentId) : undefined;
    const cancelled = () => this.closing || (parentId !== undefined && this.running.get(parentId)?.info.state !== 'running');
    if (parentId && (!parent || parent.info.state !== 'running')) throw new Error('The parent is no longer running.');
    const depth = parent ? parent.info.depth + 1 : 1;
    const { subagentLevels, maxAgents, groupReports } = this.settings;
    if (depth > subagentLevels) throw new Error(`Delegation depth limit reached: this profile allows ${subagentLevels} level${subagentLevels === 1 ? '' : 's'} of subagents.`);
    if (this.closing) throw new Error('Profile is closing.');
    if (this.full(tasks.length)) throw new Error(`Profile limit: at most ${maxAgents} active agents, including parents and descendants. Reduce the batch or continue without delegating.`);
    const view = this.memory.render();
    const selected = this.choice();
    const model = this.registry.find(selected.provider, selected.model);
    if (!model) throw new Error(`Subagent model unavailable: ${selected.provider}/${selected.model}`);
    const launched = await this.track(this.launchBatch({ tasks, cwd, depth, parentId, connected, selected, model, signal, cancelled }));
    // Grouped, the last child of this spawn to finish delivers every report; otherwise each reports on its own.
    const batch = groupReports && !connected ? { ids: launched.map(c => c.info.id), reports: new Map<string, string>() } : undefined;
    for (const live of launched) {
      live.batch = batch;
      const work = this.execute(live, `${view}\n\nYour task:\n${live.info.task}`).catch(error => this.warn(`Subagent completion failed: ${String(error)}`))
        .finally(() => { this.completions.delete(work); this.changed(); });
      this.completions.add(work);
      live.completion = work;
    }
    this.changed();
    return { ids: launched.map(c => c.info.id), grouped: batch !== undefined };
  }
  /** close() waits for launches, so shutdown never unlocks the profile under a child that is still opening. */
  private track<T>(launch: Promise<T>) {
    this.launches.add(launch);
    const done = () => { this.launches.delete(launch); };
    launch.then(done, done);
    return launch;
  }
  private async launchBatch({ tasks, cwd, depth, parentId, connected, selected, model, signal, cancelled }: { tasks: { task: string; cwd?: string }[]; cwd: string; depth: number; parentId?: string; connected: boolean;
    selected: ModelChoice; model: Model<Api>; signal?: AbortSignal; cancelled: () => boolean }) {
    const launched: LiveRun[] = [];
    let reserved = tasks.length;
    this.launching += reserved;
    try {
      for (const task of tasks) {
        signal?.throwIfAborted();
        if (cancelled()) throw new Error('Parent or profile is stopping.');
        const id = randomUUID().slice(0, 8), directory = taskDirectory(cwd, task.cwd);
        const session = await this.open({ id, directory, depth, parentId, connected, provider: selected.provider, model, thinking: selected.thinking,
          sessionManager: SessionManager.create(directory, join(this.profileDirectory, 'runs')) });
        const info: RunInfo = { id, task: task.task, cwd: directory, model: `${selected.provider}/${selected.model}`, thinking: session.thinkingLevel,
          parentSession: this.options.parentSession ?? '', parentId, depth, sessionFile: session.sessionFile, started: Date.now(), state: 'running', guidance: [], ...(connected ? { connected: true } : {}) };
        const live: LiveRun = { session, info, updated: Date.now(), tools: new Map(), pendingReports: [], pendingGuidance: [] };
        launched.push(live); this.save(info); this.running.set(id, live);
        this.launching--; reserved--;
        session.subscribe(event => this.observe(live, event));
        signal?.throwIfAborted();
        if (cancelled()) throw new Error('Parent or profile is stopping.');
      }
    } catch (error) {
      for (const child of launched) {
        await this.shutdown(child.session); // Extensions such as MCP close their connections and stop their server processes.
        this.dispose(child.session); this.running.delete(child.info.id);
        transition(child.info, 'failed'); child.info.ended = Date.now(); child.info.report = `Launch failed: ${String(error)}`;
        if (child.info.connected) child.info.handoff = { reason: signal?.aborted ? 'disconnected' : 'failed' };
        this.save(child.info);
        if (child.info.connected) await this.deliverHandoff(child.info).catch(error => this.warn(`Handoff saved for recovery: ${String(error)}`));
      }
      throw error;
    } finally { this.launching -= reserved; }
    return launched;
  }
  /** Builds a child session with the same prompt, tools and extensions whether it is new or resumed. */
  private async open(o: { id: string; directory: string; depth: number; parentId?: string; connected: boolean; provider: string; model: Model<Api>;
    thinking?: ModelChoice['thinking']; sessionManager: SessionManager }) {
    const { id, directory, depth, parentId, connected } = o;
    const { subagentLevels, maxAgents, memorySearch } = this.settings, delegates = depth < subagentLevels;
    const delegation = delegates ? `You may delegate parts of your assigned task with spawn when useful. Child reports arrive automatically after your current run ends; the harness keeps you alive to receive them. Never poll, sleep, or wait in a tool for children. Finish your current work and return; you will be prompted with their results. The profile allows ${maxAgents} active agents total.` : 'You are at the maximum delegation depth. Complete your task with your own tools.';
    const instructions = [this.instructions(), delegation, STEERABLE, connected ? 'You are speaking directly with the user in a connected window. Continue this conversation across requests. Use tell_parent for questions or findings the main agent needs now. A handoff will be generated when the user completes or disconnects the window.'
      : 'Use tell_parent only when your parent needs something now (a blocking question, an important early finding, or when asked to). Your final answer is delivered automatically; do not repeat it with tell_parent.'].filter(Boolean).join('\n\n');
    // The user's settings list their installed packages; a copy in memory keeps the child from writing them back.
    const settingsManager = SettingsManager.inMemory({ ...SettingsManager.create(directory, getAgentDir()).getSettings(), compaction: { enabled: false }, cacheWarming: 'off' });
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: getAgentDir(), settingsManager,
      noPromptTemplates: true,
      extensionsOverride: base => ({ ...base, extensions: base.extensions.filter(e => !isOptchat(e.resolvedPath)) }),
      extensionFactories: [...builtinExtensions(this.options.builtins?.() ?? []), pi => {
        const provider = this.registry.getRegisteredProviderConfig(o.provider);
        if (provider) pi.registerProvider(o.provider, provider);
        // Same prompt as the main agent (AGENTS.md files, skills, cwd); only the OptChat preamble differs.
        pi.on('before_agent_start', event => {
          event.systemPromptOptions.customPrompt = `${SUBAGENT}\n\n${VIEW_DOC}${memorySearch ? SEARCH_DOC : ''}`;
          event.systemPromptOptions.sections.instructions = instructions;
        });
        pi.on('before_provider_request', (event, ctx) => ctx.model?.api === 'anthropic-messages' ? cachePayload(event.payload) : event.payload);
      }],
    });
    await loader.reload();
    const { session } = await (this.options.createSession ?? createAgentSession)({ cwd: directory, resourceLoader: loader, settingsManager,
      model: o.model, thinkingLevel: o.thinking, sessionManager: o.sessionManager,
      customTools: [...memoryTools(() => this.memory), ...(memorySearch ? [searchTool(() => this.memory)] : []), ...(delegates ? this.delegationTools(id, directory, subagentLevels, maxAgents) : []), this.parentTool(id, parentId, connected)],
      excludeTools: delegates ? [] : ['spawn', 'tell'],
    });
    // Callers track the session only after this returns: clean up here if its extensions fail to start.
    try { await session.bindExtensions({}); }
    catch (error) { await this.shutdown(session); this.dispose(session); throw error; }
    return session;
  }
  private delegationTools(parentId: string, cwd: string, levels: number, maxAgents: number) {
    return [{ name: 'spawn', label: 'Delegate task', description: `Delegate parts of your task. Results arrive automatically after this run; never poll or sleep waiting. Maximum depth ${levels} and ${maxAgents} active agents per profile.`,
      parameters: Type.Object({ tasks: Type.Array(Type.Object({ task: Type.String(), cwd: Type.Optional(Type.String({ description: CWD_DOC })) }), { minItems: 1 }) }),
      execute: async (_id: string, args: { tasks: { task: string; cwd?: string }[] }, signal?: AbortSignal) => result(await this.start(args.tasks, cwd, signal, parentId)),
    }, { name: 'tell', label: 'Guide child', description: 'Send guidance to one of your direct children. A finished child is resumed with its earlier conversation, and its new report arrives automatically.',
      parameters: Type.Object({ id: Type.String(), message: Type.String() }),
      execute: async (_id: string, args: { id: string; message: string }) => {
        if (this.history.records.get(args.id)?.parentId !== parentId) throw new Error('You can only guide your own children.');
        return result(await this.tell(args.id, args.message, 'manager', parentId));
      },
    }];
  }
  /** Lets a child message its parent mid-run, the way tell lets the parent guide it. */
  private parentTool(id: string, parentId: string | undefined, connected: boolean) {
    return { name: 'tell_parent', label: parentId ? 'Message parent agent' : 'Message main agent',
      description: `Send ${parentId ? 'your parent agent' : 'the main agent'} a question or important finding while you keep working. Its reply can arrive as guidance; continue useful work instead of polling. Your final answer is delivered automatically.`,
      parameters: Type.Object({ message: Type.String() }), execute: async (_id: string, args: { message: string }) => {
        const message = args.message.trim();
        if (!message) throw new Error('Message is empty.');
        const text = `[${id}] ${connected ? 'Connected agent message' : 'Message from subagent (still running)'}: ${message}`;
        if (!await this.toParent(parentId, text)) throw new Error('Your parent is no longer running.');
        return result(parentId ? `Message sent to parent ${parentId}.` : 'Message sent to the main agent.');
      },
    };
  }
  /** A mid-run message to a child's parent: false if that parent is no longer running. */
  private async toParent(parentId: string | undefined, text: string) {
    if (!parentId) { await this.report(text); return true; }
    const parent = this.running.get(parentId);
    if (!parent || !['running', 'waiting', 'paused'].includes(parent.info.state)) return false;
    if (parent.info.state === 'running') await parent.session.steer(text);
    else { parent.pendingReports.push(text); parent.wake?.(); } // A paused parent keeps it until the user resumes it.
    this.changed();
    return true;
  }
  private async shutdown(session: AgentSession) {
    try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); }
    catch (error) { this.warn(`Subagent cleanup failed: ${String(error)}`); }
  }
  private dispose(session: AgentSession) {
    try { session.dispose(); } catch (error) { this.warn(`Subagent cleanup failed: ${String(error)}`); }
  }
  private directChildren(id: string) { return [...this.running.values()].filter(c => c.info.parentId === id); }
  private async execute(live: LiveRun, prompt: string) {
    const { session, info } = live;
    try {
      if (info.connected) await this.report(`[${info.id}] User started a connected conversation in ${info.cwd}. That agent is handling this request with the user directly; don't do it yourself. Initial message: ${info.task}\n\nUse tell with this agent ID only if you know something it needs. It stays open between replies and sends a final handoff on completion or disconnect.`);
      // A stop that lands before the first prompt has no turn to abort, so it is honoured here.
      const state: RunState = info.state; // a local, so the loop below still sees later state changes
      if (this.closing || info.handoff || state === 'stopping') throw new Error('Stopped before its first request.');
      await session.prompt(prompt);
      while (info.state !== 'stopping') {
        if (live.interruption) {
          const guidance = live.interruption.filter(g => g.state === 'queued');
          // Read Pi's queue only once a rebuild has landed, and take the interrupt's messages off it so they arrive once.
          // Until this is done, tell() holds new messages in pendingGuidance, where the turn below or a pause picks them up.
          await live.requeueing;
          const texts = new Set(guidance.map(g => g.text));
          await this.requeue(live, session.clearQueue().steering.filter(text => !texts.has(text)));
          live.interruption = undefined;
          if (!guidance.length) {
            // Nothing to hand over: the run waits for its next message instead of ending, and whoever waits on its report hears why.
            if (transition(info, 'paused')) {
              this.save(info);
              if (!info.connected) await this.toParent(info.parentId, `[${info.id}] Interrupted by the user; it waits for their next message, so no report until then.`)
                .catch(error => this.warn(`Could not tell the parent about the interrupt: ${String(error)}`));
            }
            continue;
          }
          if (!transition(info, 'running')) continue; // A stop during the cleanup wins.
          for (const g of guidance) g.state = 'delivered';
          this.save(info);
          await session.prompt(`Interrupted by the user:\n\n${guidance.map(g => g.text).join('\n\n')}`);
          continue;
        }
        const paused = info.state === 'paused';
        if (paused && !live.pendingGuidance.length) {
          await new Promise<void>(resolve => { live.wake = resolve; }); live.wake = undefined;
          continue;
        }
        const last = session.messages.findLast(m => m.role === 'assistant');
        if (!paused && last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted')) break;
        if (live.pendingGuidance.length) {
          transition(info, 'running'); this.save(info);
          await session.prompt(live.pendingGuidance.shift()!);
          continue;
        }
        if (live.pendingReports.length) {
          transition(info, 'running'); this.save(info);
          await session.prompt(live.pendingReports.splice(0).join('\n\n'));
          continue;
        }
        const children = this.directChildren(info.id).flatMap(child => child.completion ? [child.completion] : []);
        if (!children.length && !info.connected) break;
        const wake = new Promise<void>(resolve => { live.wake = resolve; });
        transition(info, 'waiting'); this.save(info);
        await Promise.race([...children, wake]); live.wake = undefined;
      }
      const last = session.messages.findLast(m => m.role === 'assistant');
      transition(info, info.state === 'stopping' || last?.role === 'assistant' && last.stopReason === 'aborted' ? 'stopped'
        : last?.role === 'assistant' && last.stopReason === 'error' ? 'failed' : 'completed');
      info.report = last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted')
        ? `Task ${last.stopReason}: ${last.errorMessage ?? 'No details'}` : session.getLastAssistantText() || 'Finished without a text report.';
    } catch (error) {
      transition(info, info.state === 'stopping' ? 'stopped' : 'failed'); info.report = `${info.state}: ${String(error)}`;
    } finally {
      const children = this.directChildren(info.id);
      await Promise.allSettled(children.map(child => this.stop(child.info.id)));
      await Promise.allSettled(children.flatMap(child => child.completion ? [child.completion] : []));
      info.ended = Date.now();
      for (const g of info.guidance) if (g.state === 'queued') g.state = 'undelivered';
      await this.shutdown(session);
      // A failed dispose must neither keep the slot taken nor drop the report below.
      this.dispose(session); this.running.delete(info.id);
    }
    if (info.connected) {
      info.handoff ??= { reason: 'failed' };
      transition(info, info.handoff.reason === 'complete' ? 'completed' : 'interrupted');
      this.save(info);
      await this.deliverHandoff(info);
      return;
    }
    // A metadata failure must not suppress delivery of the actual result.
    try { this.save(info); } catch (error) { this.warn(`Could not save run metadata: ${String(error)}`); }
    let text = `[${info.id}] ${info.report}`;
    const batch = live.batch;
    let count: number | undefined;
    if (batch) {
      batch.reports.set(info.id, text);
      const texts = batch.ids.flatMap(id => batch.reports.get(id) ?? []);
      if (texts.length < batch.ids.length) { if (!info.parentId) this.options.hold?.(batch.ids[0], texts); return; }
      text = texts.join('\n\n'); count = texts.length;
    }
    if (info.parentId) {
      const parent = this.running.get(info.parentId);
      if (parent && parent.info.state !== 'stopping') { parent.pendingReports.push(text); this.changed(); }
      return;
    }
    if (this.closing) this.memory.append('user', text);
    else try { await this.report(text, { count }); }
    catch (error) {
      this.memory.append('user', text);
      this.warn(`Subagent report saved but could not wake the parent: ${String(error)}`);
    }
    if (batch && batch.ids.length > 1) this.options.hold?.(batch.ids[0], []);
  }
  /** `caller` is the agent sending a manager message: undefined for the main agent, else the parent subagent's ID. */
  async tell(id: string, message: string, source: 'manager' | 'user' = 'manager', caller?: string) {
    const live = this.running.get(id);
    if (!live && source === 'manager' && this.history.records.has(id)) return this.track(this.resume(id, message, caller));
    if (live && !['running', 'waiting', 'paused'].includes(live.info.state)) throw new Error(`${id} is finishing. Its report will arrive on its own${live.info.connected || source === 'user' ? '' : '; tell it again after that to resume it'}.`);
    if (!live) throw new Error(`No running subagent ${id}.`);
    const text = live.info.connected && source === 'manager' ? `[Main agent guidance]\n${message.trim()}` : message.trim(); if (!message.trim()) throw new Error('Message is empty.');
    if (source === 'user') this.memory.append('user', `Direct guidance to subagent [${id}]: ${text}`);
    const guidance: RunInfo['guidance'][number] = { text, date: Date.now(), state: 'queued', from: source };
    live.info.guidance.push(guidance); this.save(live.info);
    try {
      await live.requeueing; // Keeps the queue in the order messages were sent.
      if (live.info.state === 'running' && !live.interruption) await live.session.steer(text);
      else { live.pendingGuidance.push(text); live.wake?.(); } // Waiting, paused or being interrupted: this message starts its next turn.
    }
    catch (error) { guidance.state = 'undelivered'; this.save(live.info); throw error; }
    if (guidance.state === 'undelivered') throw new Error(`${id} finished before it read the message. Tell it again to resume it.`);
    return 'Message queued for the next tool boundary.';
  }
  /**
   * The user's Ctrl+C, never destructive: aborts the current step. With guidance queued, the run continues at once with it;
   * with none, it pauses until the next message (from the user or a tell). Only stop() ends a run.
   */
  async interrupt(id: string): Promise<'continued' | 'paused'> {
    const live = this.running.get(id);
    if (live?.info.state === 'paused') return 'paused';
    if (!live || !['running', 'waiting'].includes(live.info.state)) throw new Error(`No running subagent ${id}.`);
    const guidance = live.info.guidance.filter(g => g.state === 'queued');
    // Nothing yields before the abort starts, so the run cannot finish in between and drop the messages.
    // They leave pendingGuidance here and Pi's steering queue in execute(), which then sends them in one prompt.
    const texts = new Set(guidance.map(g => g.text));
    live.pendingGuidance = live.pendingGuidance.filter(text => !texts.has(text));
    live.interruption = guidance;
    live.wake?.();
    await live.session.abort();
    return guidance.length ? 'continued' : 'paused';
  }
  /** Takes the user's newest undelivered message back off the queue, to edit it; undefined when there is none left to take. */
  withdraw(id: string) {
    const live = this.running.get(id);
    const text = live?.info.guidance.findLast(g => g.state === 'queued' && g.from === 'user')?.text;
    if (!live || text === undefined || live.requeueing || live.interruption) return undefined;
    // The queue holds only texts, so of equal ones the last is taken back, record and queue entry alike.
    const guidance = live.info.guidance.findLast(g => g.state === 'queued' && g.text === text)!;
    const pending = live.pendingGuidance.lastIndexOf(guidance.text);
    if (pending >= 0) live.pendingGuidance.splice(pending, 1);
    else {
      const steering = live.session.getSteeringMessages();
      const at = steering.lastIndexOf(guidance.text);
      if (at < 0) return undefined; // Already on its way to the agent.
      // Pi cannot drop a single queued message: clear the queue and steer the rest back in order.
      void this.requeue(live, live.session.clearQueue().steering.filter((_, i) => i !== at));
    }
    live.info.guidance.splice(live.info.guidance.indexOf(guidance), 1); this.save(live.info);
    return guidance.text;
  }
  private requeue(live: LiveRun, texts: string[]) {
    const work: Promise<void> = (async () => {
      try { for (const text of texts) await live.session.steer(text); }
      catch (error) { this.warn(`Could not requeue a message for ${live.info.id}: ${String(error)}`); }
    })().finally(() => { if (live.requeueing === work) live.requeueing = undefined; });
    live.requeueing = work;
    return work;
  }
  /** Reopens a finished child from its saved transcript, same ID, parent and model, and gives it a new message. */
  private async resume(id: string, message: string, caller: string | undefined) {
    const run = this.history.records.get(id)!, text = message.trim();
    if (!text) throw new Error('Message is empty.');
    if (run.connected) throw new Error(`${id} was a connected conversation with the user. It has ended and its handoff was delivered, so it cannot be resumed. Spawn a new subagent instead.`);
    if (!['completed', 'failed', 'stopped', 'interrupted'].includes(run.state) || this.resuming.has(id)) throw new Error(`${id} is still finishing. Its report will arrive on its own.`);
    if (run.parentId !== caller) {
      if (!run.parentId) throw new Error(`Only the main agent can resume ${id}.`);
      const parent = this.running.get(run.parentId);
      throw new Error(parent && ['running', 'waiting', 'paused'].includes(parent.info.state) ? `Only ${id}'s parent ${run.parentId} can resume it. Ask ${run.parentId} with tell.`
        : `Only ${id}'s parent ${run.parentId} can resume it, and that parent is no longer running. Resume ${run.parentId} instead, or spawn a new subagent.`);
    }
    if (this.closing) throw new Error('Profile is closing.');
    if (this.full(1)) throw new Error(`Profile limit: at most ${this.settings.maxAgents} active agents, including parents and descendants. ${id} can be resumed when one finishes.`);
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
      const session = await this.open({ id, directory: run.cwd, depth: run.depth, parentId: run.parentId, connected: false, provider, model, sessionManager: manager });
      // stop() cannot see this child until it is registered, so a parent stopped meanwhile must cancel it here.
      const parent = run.parentId ? this.running.get(run.parentId) : undefined;
      if (this.closing || run.parentId && (!parent || !['running', 'waiting', 'paused'].includes(parent.info.state))) {
        await this.shutdown(session); this.dispose(session); throw new Error('Parent or profile is stopping.');
      }
      // The finished record stays untouched (and resumable) unless the new one is saved.
      const { ended: _ended, ...rest } = run;
      const info: RunInfo = { ...rest, state: 'running', started: Date.now(), parentSession: this.options.parentSession ?? run.parentSession,
        guidance: [...run.guidance, { text, date: Date.now(), state: 'queued', from: 'manager' }] };
      try { this.save(info); } catch (error) { this.history.records.set(id, run); await this.shutdown(session); this.dispose(session); throw error; }
      const live: LiveRun = { session, info, updated: Date.now(), tools: new Map(), pendingReports: [], pendingGuidance: [] };
      this.running.set(id, live);
      this.launching--; reserved = false;
      session.subscribe(event => this.observe(live, event));
      const work = this.execute(live, text).catch(error => this.warn(`Subagent completion failed: ${String(error)}`))
        .finally(() => { this.completions.delete(work); this.changed(); });
      this.completions.add(work);
      live.completion = work;
    } finally { if (reserved) this.launching--; this.resuming.delete(id); }
    this.changed();
    return `${id} had finished, so I resumed it with its earlier conversation. Its new report will come back on its own.`;
  }
  async finish(id: string, reason: FinishReason) {
    const live = this.running.get(id);
    if (live?.info.connected) {
      live.info.handoff ??= { reason }; this.save(live.info);
      await this.stop(id);
      await live.completion;
    }
    return this.history.records.get(id)?.handoff;
  }
  async recoverHandoffs() {
    const eligible = [...this.history.records.values()].filter(run => run.connected && !this.running.has(run.id) && !run.handoff?.delivered);
    const recovery = (async () => {
      for (const run of eligible) {
        run.handoff ??= { reason: 'owner-stopped' };
        transition(run, run.handoff.reason === 'complete' ? 'completed' : 'interrupted'); this.save(run);
        await this.deliverHandoff(run);
      }
    })();
    this.completions.add(recovery);
    try { await recovery; } finally { this.completions.delete(recovery); this.changed(); }
  }
  private async deliverHandoff(run: RunInfo) {
    const handoff = run.handoff;
    if (!handoff || handoff.delivered) return;
    if (!handoff.text) {
      const evidence = [run, ...this.history.descendants(run.id)].map((record): HandoffEvidence => {
        try { return { run: record, messages: this.messages(record.id) }; }
        catch (error) { return { run: record, messages: [], transcriptError: String(error) }; }
      });
      let summary: string;
      try {
        if (!this.options.summarizeHandoff) throw new Error('No handoff summarizer configured');
        summary = await this.options.summarizeHandoff(run, evidence[0].messages, evidence.slice(1));
      } catch (error) {
        summary = `Automatic summary unavailable: ${String(error)}\nInitial request: ${run.task}\nLast recorded result: ${run.report ?? 'No final answer recorded.'}\nUndelivered guidance: ${run.guidance.filter(g => g.state === 'undelivered').map(g => g.text).join('\n')}\nRead the saved transcript or run metadata for the full work and user corrections.`;
      }
      const source = evidence.map(({ run: record, transcriptError }) => {
        const location = record.sessionFile && existsSync(record.sessionFile) ? `Full transcript: ${record.sessionFile}`
          : `No transcript available. Run metadata: ${join(this.profileDirectory, 'runs', `${record.id}.optchat.json`)}`;
        return `[${record.id}] ${record.state}${record.parentId ? ` · parent ${record.parentId}` : ''}\n${location}${transcriptError ? `\nTranscript read failed: ${transcriptError}` : ''}`;
      }).join('\n');
      handoff.text = `[${run.id}] Connected conversation ${handoff.reason === 'complete' ? 'completed by user' : `interrupted (${handoff.reason})`}. This describes the conversation ending, not proof that every task succeeded.\n${summary}\n${source}`;
      run.report = handoff.text; this.save(run);
    }
    await this.report(handoff.text, { once: true });
    handoff.delivered = true; this.save(run);
  }
  async stop(id: string) {
    const live = this.running.get(id);
    if (!live) throw new Error(`No running subagent ${id}.`);
    const descendants: LiveRun[] = [];
    const collect = (run: LiveRun) => { descendants.push(run); for (const child of this.directChildren(run.info.id)) collect(child); };
    collect(live);
    const stopping = descendants.filter(run => transition(run.info, 'stopping'));
    for (const run of stopping) {
      if (run.info.connected) run.info.handoff ??= { reason: 'owner-stopped' };
      run.wake?.();
      try { this.save(run.info); } catch (error) { this.warn(`Could not save stop status: ${String(error)}`); }
    }
    await Promise.allSettled(stopping.map(run => run.session.abort()));
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.running.keys()].map(id => this.stop(id)));
    await Promise.allSettled(this.launches);
    await Promise.allSettled(this.completions);
  }
}
