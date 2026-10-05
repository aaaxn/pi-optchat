import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, getAgentDir, type AgentSession, type AgentSessionEvent, type ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { SUBAGENT, VIEW_DOC } from './prompts.ts';
import { memoryTools } from './tools.ts';
import { type Memory } from './memory.ts';
import type { ModelChoice } from './compactor.ts';
import { cacheFor } from './cache.ts';
import { RunHistory, sessionMessages, type RunInfo, type FinishReason } from './runs.ts';
import { UsageLedger } from './usage.ts';
import { textContent } from './transcript.ts';
import { Type } from 'typebox';
import { result } from './tools.ts';
import type { HandoffEvidence } from './handoff.ts';

export interface LiveRun {
  session: AgentSession; info: RunInfo; updated: number; streaming?: AgentMessage;
  tools: Map<string, { name: string; args: unknown; output?: unknown; started: number }>;
  pendingReports: string[]; pendingGuidance: string[]; wake?: () => void; completion?: Promise<void>;
}
interface Options { parentSession?: string; usage?: UsageLedger; createSession?: typeof createAgentSession;
  summarizeHandoff?: (run: RunInfo, messages: AgentMessage[], descendants?: HandoffEvidence[]) => Promise<string> }

export const webExtension = join(dirname(fileURLToPath(import.meta.url)), '../node_modules/pi-web-access/dist/index.js');
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
    private readonly report: (text: string, once?: boolean) => Promise<void>, private readonly warn: (text: string) => void,
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
    if (this.closing) throw new Error('Profile is closing.');
    this.settling++;
    try { await this.memory.settle(signal); } finally { this.settling--; }
    const parent = parentId ? this.running.get(parentId) : undefined;
    const cancelled = () => this.closing || (parentId !== undefined && this.running.get(parentId)?.info.state !== 'running');
    if (parentId && (!parent || parent.info.state !== 'running')) throw new Error('The parent is no longer running.');
    const depth = parent ? parent.info.depth + 1 : 1;
    if (depth > 3) throw new Error('Delegation depth limit reached: great-grandchildren cannot spawn.');
    if (this.closing) throw new Error('Profile is closing.');
    if (this.running.size + this.launching + tasks.length > 8) throw new Error('Profile limit: at most 8 active agents, including parents and descendants. Reduce the batch or continue without delegating.');
    const view = this.memory.render();
    const selected = this.choice();
    const model = this.registry.find(selected.provider, selected.model);
    if (!model) throw new Error(`Subagent model unavailable: ${selected.provider}/${selected.model}`);
    const launched: LiveRun[] = [];
    let reserved = tasks.length;
    this.launching += reserved;
    try {
      for (const task of tasks) {
        signal?.throwIfAborted();
        if (cancelled()) throw new Error('Parent or profile is stopping.');
        const id = randomUUID().slice(0, 8), directory = task.cwd ?? cwd;
        const delegation = depth < 3 ? 'You may delegate parts of your assigned task with spawn when useful. Child reports arrive automatically after your current run ends; the harness keeps you alive to receive them. Never poll, sleep, or wait in a tool for children. Finish your current work and return; you will be prompted with their results. The profile allows 8 active agents total.' : 'You are at the maximum delegation depth. Complete your task with your own tools.';
        const prompt = `${SUBAGENT}\n\n${VIEW_DOC}\n\n${this.instructions()}\n\n${delegation}\n\n${connected ? 'You are speaking directly with the user in a connected window. Continue this conversation across requests. Use tell_main for questions or findings the main agent needs now. A handoff will be generated when the user completes or disconnects the window.' : ''}\n\nWorking directory: ${directory}`;
        const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off' });
        const loader = new DefaultResourceLoader({ cwd: directory, agentDir: getAgentDir(), settingsManager,
          noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true,
          additionalExtensionPaths: [webExtension], systemPrompt: prompt,
          extensionFactories: [pi => {
            const provider = this.registry.getRegisteredProviderConfig(selected.provider);
            if (provider) pi.registerProvider(selected.provider, provider);
            pi.on('before_agent_start', () => ({ systemPrompt: prompt }));
            pi.on('before_provider_request', (event, ctx) => cacheFor(ctx.model?.api, event.payload));
          }],
        });
        await loader.reload();
        const { session } = await (this.options.createSession ?? createAgentSession)({ cwd: directory, resourceLoader: loader, settingsManager,
          model, thinkingLevel: selected.thinking, sessionManager: SessionManager.create(directory, join(this.profileDirectory, 'runs')),
          customTools: [...memoryTools(() => this.memory), ...(depth < 3 ? this.delegationTools(id, directory) : []), ...(connected ? [{
            name: 'tell_main', label: 'Message main agent', description: 'Send the main agent a question or important finding. Its reply can arrive as guidance; continue useful work instead of polling.',
            parameters: Type.Object({ message: Type.String() }), execute: async (_id: string, args: { message: string }) => {
              await this.report(`[${id}] Connected agent message: ${args.message}`); return result('Message sent to the main agent.');
            },
          }] : [])],
          excludeTools: depth < 3 ? [] : ['spawn', 'tell'],
        });
        await session.bindExtensions({});
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
        child.session.dispose(); this.running.delete(child.info.id);
        child.info.state = 'failed'; child.info.ended = Date.now(); child.info.report = `Launch failed: ${String(error)}`;
        if (child.info.connected) child.info.handoff = { reason: signal?.aborted ? 'disconnected' : 'failed' };
        this.save(child.info);
        if (child.info.connected) await this.deliverHandoff(child.info).catch(error => this.warn(`Handoff saved for recovery: ${String(error)}`));
      }
      throw error;
    } finally { this.launching -= reserved; }
    // Each child reports independently. A slow sibling must not hold back a finished result.
    for (const live of launched) {
      const work = this.execute(live, view).catch(error => this.warn(`Subagent completion failed: ${String(error)}`))
        .finally(() => { this.completions.delete(work); this.changed(); });
      this.completions.add(work);
      live.completion = work;
    }
    this.changed();
    return launched.map(c => c.info.id);
  }
  private delegationTools(parentId: string, cwd: string) {
    return [{ name: 'spawn', label: 'Delegate task', description: 'Delegate parts of your task. Results arrive automatically after this run; never poll or sleep waiting. Maximum depth 3 and 8 active agents per profile.',
      parameters: Type.Object({ tasks: Type.Array(Type.Object({ task: Type.String(), cwd: Type.Optional(Type.String()) }), { minItems: 1, maxItems: 8 }) }),
      execute: async (_id: string, args: { tasks: { task: string; cwd?: string }[] }, signal?: AbortSignal) => result(`Started: ${(await this.spawn(args.tasks, cwd, signal, parentId)).join(', ')}. Results will arrive automatically.`),
    }, { name: 'tell', label: 'Guide child', description: 'Send guidance to one of your direct children.',
      parameters: Type.Object({ id: Type.String(), message: Type.String() }),
      execute: async (_id: string, args: { id: string; message: string }) => {
        if (this.history.records.get(args.id)?.parentId !== parentId) throw new Error('You can only guide your own children.');
        return result(await this.tell(args.id, args.message));
      },
    }];
  }
  private directChildren(id: string) { return [...this.running.values()].filter(c => c.info.parentId === id); }
  private async execute(live: LiveRun, view: string) {
    const { session, info } = live;
    try {
      if (info.connected) await this.report(`[${info.id}] User started a connected conversation in ${info.cwd}. Initial request: ${info.task}\nUse tell with this agent ID to coordinate. It stays open between replies and sends a final handoff on completion or disconnect.`);
      if (this.closing || info.handoff) throw new Error('Conversation stopped before its first request.');
      await session.prompt(`${view}\n\nYour task:\n${info.task}`);
      while (info.state !== 'stopping') {
        const last = session.messages.findLast(m => m.role === 'assistant');
        if (last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted')) break;
        if (live.pendingGuidance.length) {
          info.state = 'running'; this.save(info);
          await session.prompt(live.pendingGuidance.shift()!);
          continue;
        }
        if (live.pendingReports.length) {
          info.state = 'running'; this.save(info);
          await session.prompt(live.pendingReports.splice(0).join('\n\n'));
          continue;
        }
        const children = this.directChildren(info.id).flatMap(child => child.completion ? [child.completion] : []);
        if (!children.length && !info.connected) break;
        const wake = new Promise<void>(resolve => { live.wake = resolve; });
        info.state = 'waiting'; this.save(info);
        await Promise.race([...children, wake]); live.wake = undefined;
      }
      const last = session.messages.findLast(m => m.role === 'assistant');
      info.state = info.state === 'stopping' || last?.role === 'assistant' && last.stopReason === 'aborted' ? 'stopped'
        : last?.role === 'assistant' && last.stopReason === 'error' ? 'failed' : 'completed';
      info.report = last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted')
        ? `Task ${last.stopReason}: ${last.errorMessage ?? 'No details'}` : session.getLastAssistantText() || 'Finished without a text report.';
    } catch (error) {
      info.state = info.state === 'stopping' ? 'stopped' : 'failed'; info.report = `${info.state}: ${String(error)}`;
    } finally {
      const children = this.directChildren(info.id);
      await Promise.allSettled(children.map(child => this.stop(child.info.id)));
      await Promise.allSettled(children.flatMap(child => child.completion ? [child.completion] : []));
      info.ended = Date.now();
      for (const g of info.guidance) if (g.state === 'queued') g.state = 'undelivered';
      try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); }
      catch (error) { this.warn(`Subagent cleanup failed: ${String(error)}`); }
      finally { session.dispose(); this.running.delete(info.id); }
    }
    if (info.connected) {
      info.handoff ??= { reason: 'failed' };
      info.state = info.handoff.reason === 'complete' ? 'completed' : 'interrupted';
      this.save(info);
      await this.deliverHandoff(info);
      return;
    }
    // A metadata failure must not suppress delivery of the actual result.
    try { this.save(info); } catch (error) { this.warn(`Could not save run metadata: ${String(error)}`); }
    const text = `[${info.id}] ${info.report}`;
    if (info.parentId) {
      const parent = this.running.get(info.parentId);
      if (parent && parent.info.state !== 'stopping') { parent.pendingReports.push(text); this.changed(); }
      return;
    }
    if (this.closing) { this.memory.append('user', text); return; }
    try { await this.report(text); }
    catch (error) {
      this.memory.append('user', text);
      this.warn(`Subagent report saved but could not wake the parent: ${String(error)}`);
    }
  }
  async tell(id: string, message: string, source: 'manager' | 'user' = 'manager') {
    const live = this.running.get(id);
    if (!live || !['running', 'waiting'].includes(live.info.state)) throw new Error(`No running subagent ${id}.`);
    const text = live.info.connected && source === 'manager' ? `[Main agent guidance]\n${message.trim()}` : message.trim(); if (!message.trim()) throw new Error('Message is empty.');
    if (source === 'user') this.memory.append('user', `Direct guidance to subagent [${id}]: ${text}`);
    const guidance: RunInfo['guidance'][number] = { text, date: Date.now(), state: 'queued' };
    live.info.guidance.push(guidance); this.save(live.info);
    try {
      if (live.info.state === 'waiting') { live.pendingGuidance.push(text); live.wake?.(); }
      else await live.session.steer(text);
    }
    catch (error) { guidance.state = 'undelivered'; this.save(live.info); throw error; }
    return 'Message queued for the next tool boundary.';
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
        run.state = run.handoff.reason === 'complete' ? 'completed' : 'interrupted'; this.save(run);
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
    await this.report(handoff.text, true);
    handoff.delivered = true; this.save(run);
  }
  async stop(id: string) {
    const live = this.running.get(id);
    if (!live) throw new Error(`No running subagent ${id}.`);
    const descendants: LiveRun[] = [];
    const collect = (run: LiveRun) => { descendants.push(run); for (const child of this.directChildren(run.info.id)) collect(child); };
    collect(live);
    for (const run of descendants) {
      if (run.info.connected) run.info.handoff ??= { reason: 'owner-stopped' };
      run.info.state = 'stopping';
      run.wake?.();
      try { this.save(run.info); } catch (error) { this.warn(`Could not save stop status: ${String(error)}`); }
    }
    await Promise.allSettled(descendants.map(run => run.session.abort()));
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.running.keys()].map(id => this.stop(id)));
    await Promise.allSettled(this.completions);
  }
}
