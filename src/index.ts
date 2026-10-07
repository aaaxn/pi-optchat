import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { parseSkillBlock, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Memory } from './memory.ts';
import { createCompressor } from './compactor.ts';
import { atomicWrite, createProfile, instructions, lastProfile, listProfiles, loadConfig, lockProfile, profilePath, rememberProfile, saveConfig, ProfileBusyError, type ProfileConfig } from './profiles.ts';
import { MASTER, VIEW_DOC } from './prompts.ts';
import { cachePayload, record } from './cache.ts';
import { asUser, boundedMessage, buildContext, logMessage, previousExchange, REPORT_TYPE, RUN_BOUNDARY, textContent, typedText } from './transcript.ts';
import { registerReportRenderer, type ReportDetails } from './report-message.ts';
import { memoryTools, result, SEARCH_DOC, searchTool } from './tools.ts';
import { Children, CWD_DOC, loadedBuiltins } from './agents.ts';
import { exportBrowser } from './browser.ts';
import { Inbox } from './inbox.ts';
import { checkpoint } from './checkpoint.ts';
import { memoryDirectory, pendingImport, prepareImport, runImport, discardImport } from './import/job.ts';
import { chooseImport, showProgress } from './import/ui.ts';
import { IMPORT_GUIDANCE } from './import/guidance.ts';
import { UsageLedger } from './usage.ts';
import { showInspector, type InspectorPage } from './inspector.ts';
import { showAgentView } from './agent-view.ts';
import { inspectorShortcut, mountNavigation } from './navigation.ts';
import { serveWindows } from './window-bridge.ts';
import { openConnectedWindow, registerConnectedRenderer } from './connected-window.ts';
import { createHandoffSummarizer } from './handoff.ts';
import { mainTitle, TabTitle } from './title.ts';
import { showModelPicker, showSettings } from './settings-page.ts';

const binding = 'optchat.profile';
const CONTINUITY = '\n\nFor conversational continuity, the memory view may be followed by the immediately preceding completed exchange (its user requests and final answer, in full text; left out when very long), then the new input. Use that exact wording to understand follow-ups; older exchanges and previous tool output remain accessible through memory and zoom.';
const toggle = (prompt: string, line: string, on: boolean, after: string) => on === prompt.includes(line) ? prompt : on ? prompt.replace(after, after + line) : prompt.replace(line, '');
/** A report run while idle reuses the last built prompt, so Previous exchange and Memory search changes since then are applied here. */
const promptFor = (prompt: string, { previousExchange, memorySearch }: ProfileConfig) =>
  toggle(toggle(prompt, CONTINUITY, previousExchange, VIEW_DOC), SEARCH_DOC, memorySearch, previousExchange ? VIEW_DOC + CONTINUITY : VIEW_DOC);
interface Active { name: string; dir: string; config: ProfileConfig; memory: Memory; inbox: Inbox; children: Children; usage: UsageLedger; unlock: () => Promise<void> }

export default function optchat(pi: ExtensionAPI) {
  let active: Active | undefined;
  let remote: Awaited<ReturnType<typeof openConnectedWindow>> | undefined;
  let closeWindows: (() => Promise<void>) | undefined;
  let recovery: Promise<void> | undefined;
  let run: AgentMessage[] = [];
  let previous: AgentMessage[] = [];
  let logged = 0;
  let view: string | undefined;
  let prompt = '';
  let runStarted = false;
  let fault: string | undefined;
  /** Reports not yet in memory. `count`: how many subagent reports the text joins. `batch`: held while the rest of that spawn runs, not sent yet. */
  let reports: { text: string; count?: number; batch?: string }[] = [];
  const receipts = new Map<AgentMessage, string>();
  let checkpoints = Promise.resolve();
  let importing = false;
  let stopping = false;
  let importController: AbortController | undefined;
  let importTask: Promise<void> | undefined;
  let unmountNavigation: (() => void) | undefined;
  let inspectorController: AbortController | undefined;
  const shortcut = inspectorShortcut();
  const title = new TabTitle();
  let working = false;
  let untitle: (() => void) | undefined;
  const showTitle = (ctx: ExtensionContext) => {
    const a = active;
    if (a) title.show(text => ctx.ui.setTitle(text), mainTitle(a.name, working, a.children.ids.length));
  };
  /** Journals written before batches held plain strings. */
  const isPendingReport = (s: unknown): s is string | { text: string; count?: number } =>
    typeof s === 'string' || record(s) && typeof s.text === 'string' && (s.count === undefined || typeof s.count === 'number');
  const reportReceipt = (text: string) => 'report:' + createHash('sha256').update(text).digest('hex');
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
  pi.registerFlag('optchat-profile', { description: 'OptChat profile (required for noninteractive sessions without a saved binding)', type: 'string' });
  const required = () => { if (!active) throw new Error('Choose an OptChat profile first: /optchat profile'); return active; };
  const status = (ctx: ExtensionContext) => {
    const a = active;
    if (!a) { ctx.ui.setStatus('optchat', 'OptChat: choose profile'); return; }
    // A display only: a broken import journal is refused where it matters, never here.
    let note = '';
    try { note = importing ? ' · importing' : pendingImport(a.dir) ? ' · import paused: /optchat import' : ''; }
    catch { note = ' · import journal invalid'; }
    ctx.ui.setStatus('optchat', `OptChat: ${a.name} · ${a.memory.root.length} messages · ${a.memory.pending} pending · ${a.children.ids.length} agents${note}`);
  };
  const saveReports = () => { if (active) atomicWrite(join(active.dir, 'pending-reports.json'), JSON.stringify(reports)); };
  const flush = () => {
    if (!active) return;
    while (logged < run.length) {
      const message = run[logged];
      const receipt = receipts.get(message);
      logMessage(active.memory, message, receipt); logged++;
      if (receipt && !receipt.startsWith('report:')) active.inbox.acknowledge(receipt);
      receipts.delete(message);
      if (message.role === 'user') {
        const text = textContent(message.content), index = reports.findIndex(r => !r.batch && r.text === text);
        if (index >= 0) { reports.splice(index, 1); saveReports(); }
      }
    }
  };
  // Shown as a dark background box, not as the user's own message. Before this profile has run once there is no
  // built system prompt to reuse, so that rare case still goes through Pi's normal prompt path as a user message.
  const sendReport = (text: string, count?: number) => {
    if (prompt) pi.sendMessage<ReportDetails>({ customType: REPORT_TYPE, content: text, display: true, details: { count } }, { triggerTurn: true, deliverAs: 'steer' });
    else pi.sendUserMessage(text, { deliverAs: 'steer', expandPromptTemplates: false });
  };
  const deliverReport = async (text: string, { once = false, count }: { once?: boolean; count?: number } = {}) => {
    if (once && (active?.memory.root.some(e => e.receipt === reportReceipt(text)) || reports.some(r => r.text === text))) return;
    reports.push({ text, count }); saveReports();
    if (!stopping) sendReport(text, count);
  };
  const holdReports = (batch: string, texts: string[]) => {
    reports = [...reports.filter(r => r.batch !== batch), ...texts.length ? [{ text: texts.join('\n\n'), count: texts.length, batch }] : []];
    saveReports();
  };
  const stop = async () => {
    remote?.close(); remote = undefined;
    inspectorController?.abort(); unmountNavigation?.(); unmountNavigation = undefined;
    stopping = true; importController?.abort(); await importTask?.catch(() => {});
    if (!active) return;
    const old = active;
    try {
      await closeWindows?.(); closeWindows = undefined;
      await recovery;
      await old.children.close(); flush(); if (!pendingImport(old.dir)) old.inbox.recover(old.memory);
      await old.memory.close(); await checkpoints;
      await checkpoint(old.dir);
    } finally {
      await old.memory.close(); await old.unlock(); active = undefined;
      run = []; previous = []; logged = 0; view = undefined; runStarted = false; receipts.clear(); prompt = '';
      untitle?.(); untitle = undefined; title.clear(); working = false;
    }
  };
  const CONNECT = 'Start a connected subagent conversation here', BACK = 'Back';
  const chooseProfile = async (ctx: ExtensionContext): Promise<string | undefined> => {
    if (!ctx.hasUI) return undefined;
    const names = listProfiles(), last = lastProfile();
    if (last) names.sort((a, b) => Number(b === last) - Number(a === last));
    const selected = await ctx.ui.select('OptChat profile', [...names, '+ Create profile']);
    if (selected !== '+ Create profile') return selected;
    const name = (await ctx.ui.input('New profile name', 'work or personal'))?.trim();
    if (!name) return undefined;
    createProfile(name); return name;
  };
  const openProfile = async (name: string, ctx: ExtensionContext) => {
    const dir = profilePath(name);
    if (!existsSync(dir)) throw new Error(`Profile ${name} does not exist. Use /optchat profile to create it.`);
    const unlock = await lockProfile(dir, `${name} · PID ${process.pid} · ${hostname()} · ${ctx.cwd}`);
    let openingMemory: Memory | undefined;
    try {
      const config = loadConfig(dir);
      const sessionId = ctx.sessionManager.getSessionId();
      const usage = new UsageLedger(dir);
      usage.backfill(ctx.sessionManager.getEntries(), sessionId);
      const pending = join(dir, 'pending-reports.json');
      const saved: unknown = existsSync(pending) ? JSON.parse(readFileSync(pending, 'utf8')) : [];
      if (!Array.isArray(saved) || !saved.every(isPendingReport)) throw new Error('Invalid pending report journal.');
      const memory = new Memory(memoryDirectory(dir), createCompressor(ctx.modelRegistry, () => config.compactor, message => {
        usage.compression(message, 'compactor', sessionId);
        status(ctx);
      }, () => config.summaryAcceptBytes), warning => ctx.ui.notify(warning, 'error'));
      openingMemory = memory;
      const inbox = new Inbox(dir);
      const recovered = pendingImport(dir) ? 0 : inbox.recover(memory);
      if (recovered) ctx.ui.notify(`Recovered ${recovered} unanswered inputs into ${name}'s memory. Ask to continue them when ready.`, 'info');
      const children = new Children(memory, ctx.modelRegistry, () => config.subagent, () => `${instructions(dir)}\n\n${IMPORT_GUIDANCE}`,
        deliverReport, text => ctx.ui.notify(text, 'error'), dir, { parentSession: sessionId, usage, builtins: () => loadedBuiltins(pi), settings: () => config, hold: holdReports,
          summarizeHandoff: createHandoffSummarizer(ctx.modelRegistry, () => config.compactor, message => usage.compression(message, 'compactor', sessionId)) });
      const loggedReports = new Set(memory.root.map(e => e.receipt));
      // Reports a crash held back with their unfinished siblings are delivered now, as they are.
      reports = saved.map(s => typeof s === 'string' ? { text: s } : { text: s.text, count: s.count })
        .filter(r => !loggedReports.has(reportReceipt(r.text)));
      atomicWrite(pending, JSON.stringify(reports));
      rememberProfile(name);
      active = { name, dir, config, memory, inbox, children, usage, unlock }; fault = undefined;
      if (ctx.mode === 'tui') unmountNavigation = mountNavigation(ctx, children, memory, shortcut, page => { void inspect(ctx, page); });
      closeWindows = await serveWindows(dir, children, () => !stopping && !importing && !pendingImport(dir), deliverReport);
      untitle = children.subscribe(() => showTitle(ctx)); showTitle(ctx);
      status(ctx);
      ctx.ui.notify(`OptChat · ${name} · ${memory.root.length} messages\nCompactor: ${config.compactor.provider}/${config.compactor.model} (${config.compactor.thinking})`, 'info');
      const queuedReports = [...reports];
      if (!pendingImport(dir)) recovery = children.recoverHandoffs().catch(error => ctx.ui.notify(`Handoff recovery: ${errorText(error)}`, 'error'));
      setImmediate(() => { if (active?.memory === memory && !pendingImport(dir)) for (const r of queuedReports) sendReport(r.text, r.count); });
    } catch (error) {
      await closeWindows?.(); closeWindows = undefined;
      untitle?.(); untitle = undefined; title.clear();
      if (active && active.memory === openingMemory) {
        unmountNavigation?.(); unmountNavigation = undefined;
        await active.children.close(); active = undefined;
      }
      await openingMemory?.close();
      await unlock(); throw error;
    }
  };

  pi.on('session_start', async (_event, ctx) => {
    stopping = false;
    const entries = ctx.sessionManager.getEntries();
    const saved = entries.findLast(e => e.type === 'custom' && e.customType === binding);
    const boundName = saved?.type === 'custom' && record(saved.data) && typeof saved.data.name === 'string' ? saved.data.name : undefined;
    // A session with conversation in it belongs to its profile. One that is only bound (a fresh `/optchat profile` session) may still pick another.
    const settled = boundName !== undefined && entries.some(e => e.type === 'message' || e.type === 'custom_message');
    const flag = pi.getFlag('optchat-profile');
    try {
      if (boundName && typeof flag === 'string' && flag !== boundName) throw new Error(`Session belongs to ${boundName}; cannot resume it as ${flag}.`);
      let name = boundName ?? (typeof flag === 'string' ? flag : await chooseProfile(ctx));
      for (;;) {
        if (!name) { status(ctx); return; }
        try { await openProfile(name, ctx); break; }
        catch (error) {
          if (!(error instanceof ProfileBusyError) || ctx.mode !== 'tui') throw error;
          // A resumed conversation already belongs to this profile, so another profile needs a new session (/optchat profile).
          const choice = await ctx.ui.select(`${name} is open in another window\n${error.owner}`, settled ? [CONNECT] : [CONNECT, BACK]);
          if (choice === CONNECT) { remote = await openConnectedWindow(pi, ctx, name, text => title.show(t => ctx.ui.setTitle(t), text)); fault = undefined; break; }
          if (choice !== BACK) throw error;
          name = await chooseProfile(ctx);
        }
      }
      if (name !== boundName) pi.appendEntry(binding, { name });
    } catch (error) {
      if (active) await stop().catch(() => {});
      fault = errorText(error); ctx.ui.notify(fault, 'error');
    }
    // Pi sets its own title once every session_start handler has finished, so put ours back afterwards.
    for (const ms of [0, 250, 1000]) setTimeout(() => title.reapply(), ms).unref();
  });
  pi.on('session_info_changed', () => title.reapply()); // Pi retitles the tab on session renames, just before this.
  pi.on('session_shutdown', stop);
  pi.on('session_before_switch', () => remote || importing || active?.children.active ? { cancel: true } : undefined);
  pi.on('session_before_fork', () => remote || importing || active?.children.active ? { cancel: true } : undefined);
  pi.on('input', async (event, ctx) => {
    if (remote) {
      try {
        if (event.images?.length) throw new Error('Connected windows currently accept text only; provide a file path for the agent to read.');
        await remote.submit(event.text);
      } catch (error) { ctx.ui.notify(errorText(error), 'error'); ctx.ui.setEditorText(event.text); }
      return { action: 'handled' };
    }
    if (!active) { ctx.ui.notify(fault ?? 'Select a profile with /optchat profile before chatting.', 'error'); return { action: 'handled' }; }
    if (importing || pendingImport(active.dir)) { ctx.ui.notify('This profile has an import in progress. Use /optchat import to resume or discard it, or switch profiles.', 'info'); return { action: 'handled' }; }
    if (event.source !== 'extension') {
      try { active.inbox.record(event.text); }
      catch (error) { ctx.ui.notify(`Could not save input: ${errorText(error)}`, 'error'); return { action: 'handled' }; }
    }
    return { action: 'continue' };
  });
  const startRun = (ctx: ExtensionContext) => {
    flush(); run = []; logged = 0; view = undefined; runStarted = true;
    const config = active?.config;
    previous = config?.previousExchange ? previousExchange(ctx.sessionManager.getBranch(), config.previousExchangeKB * 1000) : [];
    pi.appendEntry(RUN_BOUNDARY, { state: 'start' });
  };
  // A report sent while Pi is idle starts its run without before_agent_start; it reuses the last built prompt.
  pi.on('agent_start', (_event, ctx) => {
    working = true; showTitle(ctx);
    if (active && !runStarted) startRun(ctx);
  });
  pi.on('before_agent_start', (event, ctx) => {
    startRun(ctx);
    const a = required();
    // Pi's own prompt sections (AGENTS.md files, skills, cwd) stay; the profile's instructions go last.
    syncSearch(a.config);
    event.systemPromptOptions.customPrompt = `${MASTER}\n\n${VIEW_DOC}${a.config.previousExchange ? CONTINUITY : ''}${a.config.memorySearch ? SEARCH_DOC : ''}`;
    event.systemPromptOptions.sections.instructions = `${instructions(a.dir)}\n\n${IMPORT_GUIDANCE}`;
    prompt = event.systemPrompt;
  });
  pi.on('message_end', (event, ctx) => {
    if (!active || !runStarted) return;
    const bounded = boundedMessage(event.message);
    const message = asUser(bounded);
    if (message.role === 'user') {
      try {
        const text = textContent(message.content);
        if (reports.some(r => !r.batch && r.text === text)) receipts.set(message, reportReceipt(text));
        else {
          // The inbox journaled the typed input: match without image placeholders or Pi's image notes.
          const typed = typedText(message.content), skill = parseSkillBlock(typed.bare);
          let receipt = active.inbox.claim(typed.text) ?? active.inbox.claim(typed.bare)
            ?? (skill ? active.inbox.claimSkill(skill.name, skill.userMessage) : undefined);
          if (!receipt) { active.inbox.record(text); receipt = active.inbox.claim(text); }
          if (receipt) receipts.set(message, receipt);
        }
      } catch (error) { ctx.abort(); fault = errorText(error); ctx.ui.notify(fault, 'error'); }
    }
    run.push(message);
    if (view !== undefined) {
      try { flush(); } catch (error) { ctx.abort(); fault = errorText(error); ctx.ui.notify(fault, 'error'); }
    }
    if (bounded !== event.message) return { message: bounded };
  });
  pi.on('context_with_system', async (event, ctx) => {
    try {
      const a = required();
      if (importing || pendingImport(a.dir)) throw new Error('Profile is unavailable while importing.');
      if (fault) throw new Error(fault);
      if (view === undefined) {
        ctx.ui.setWorkingMessage('Waiting for OptChat summaries…');
        try { await a.memory.settle(ctx.signal); } finally { ctx.ui.setWorkingMessage(); }
        view = a.memory.render(); // Capture old history before logging the new input.
        flush();
      }
      return { messages: buildContext(event.messages, run, view, promptFor(prompt, a.config), previous) };
    } catch (error) {
      // Pi catches extension errors. Explicitly abort so it cannot fall back to old context.
      ctx.abort();
      try { flush(); } catch (persistenceError) { fault = errorText(persistenceError); }
      ctx.ui.notify(errorText(error), 'error');
      return { messages: [{ role: 'system', content: 'OptChat context unavailable. Stop.', timestamp: 0 }] };
    }
  });
  pi.on('before_provider_request', (event, ctx) => ctx.model?.api === 'anthropic-messages' ? cachePayload(event.payload) : event.payload);
  pi.on('cache_warming_decision', () => ({ action: 'stop' }));
  pi.on('session_before_compact', (_event, ctx) => {
    ctx.ui.notify('OptChat manages history between turns. Pi compaction is disabled; an exceptionally long single run may require stopping and continuing in a new turn.', 'info');
    return { cancel: true };
  });
  const collectUsage = (ctx: ExtensionContext) => {
    try { active?.usage.backfill(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId()); }
    catch (error) { ctx.ui.notify(`Could not save usage: ${errorText(error)}`, 'error'); }
  };
  pi.on('turn_end', (_event, ctx) => collectUsage(ctx));
  pi.on('agent_settled', async (_event, ctx) => {
    collectUsage(ctx);
    try { flush(); } catch (error) { fault = errorText(error); ctx.ui.notify(fault, 'error'); }
    if (runStarted) pi.appendEntry(RUN_BOUNDARY, { state: 'end' });
    runStarted = false; status(ctx);
    working = false; showTitle(ctx);
    if (active) {
      const dir = active.dir;
      checkpoints = checkpoints.then(() => checkpoint(dir)).catch(error => ctx.ui.notify(`Local checkpoint failed: ${errorText(error)}`, 'error'));
      await checkpoints;
    }
  });
  registerConnectedRenderer(pi);
  registerReportRenderer(pi);
  for (const tool of memoryTools(() => required().memory)) pi.registerTool(tool);
  pi.registerTool({ ...searchTool(() => required().memory), defaultActive: false });
  // The tool and its prompt line change together, once per toggle, so the cached prefix is otherwise stable.
  // Synced on save too: a report turn started while idle reuses the tool set without before_agent_start.
  const syncSearch = ({ memorySearch }: ProfileConfig) => {
    const tools = pi.getActiveTools();
    if (tools.includes('search') !== memorySearch) pi.setActiveTools(memorySearch ? [...tools, 'search'] : tools.filter(name => name !== 'search'));
  };
  pi.registerTool({ name: 'spawn', label: 'Spawn background agents',
    description: 'Start background subagents, returning IDs immediately. Use only when the user asks. Give each task the cwd of the project it works on, so the subagent starts there with that project\'s AGENTS.md. Each receives the current memory view and read-only zoom/date. Whether children may delegate further, and how many agents may run at once, is set per profile. Completion reports arrive automatically; never poll or sleep waiting for them.',
    parameters: Type.Object({ tasks: Type.Array(Type.Object({ task: Type.String(), cwd: Type.Optional(Type.String({ description: CWD_DOC })) }), { minItems: 1 }) }),
    async execute(_id, args, signal, _update, ctx) {
      const text = await required().children.start(args.tasks, ctx.cwd, signal); status(ctx);
      return result(text);
    },
  });
  pi.registerTool({ name: 'tell', label: 'Tell background agent', description: 'Send a message to a subagent. A running one gets it at its next tool boundary. A finished one you started is resumed with its earlier conversation, and its new report arrives automatically.',
    parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    async execute(_id, args) { return result(await required().children.tell(args.id, args.message)); },
  });

  /** The settings page's options: every model Pi is logged in to, with the thinking levels it takes, sorted so each provider's models sit together. */
  const settingsOptions = (ctx: ExtensionContext, a: Active) => ({ profile: a.name, config: a.config,
    models: ctx.modelRegistry.getAvailable().map(m => ({ name: `${m.provider}/${m.id}`, thinking: getSupportedThinkingLevels(m) })).sort((x, y) => x.name.localeCompare(y.name)),
    save: (config: ProfileConfig) => { saveConfig(a.dir, config); syncSearch(config); } });
  const pickModel = async (ctx: ExtensionContext, role: 'compactor' | 'subagent') => {
    const a = required();
    if (ctx.mode !== 'tui') throw new Error('Choosing a model requires interactive Pi. Edit config.json in the profile directory instead.');
    const choice = await showModelPicker(ctx, role, settingsOptions(ctx, a));
    if (choice) ctx.ui.notify(`${role}: ${choice.provider}/${choice.model} (${choice.thinking}); applies to new calls.`, 'info');
  };
  const inspect = async (ctx: ExtensionContext, page: InspectorPage) => {
    if (inspectorController) return;
    const controller = new AbortController();
    try {
      const a = required();
      if (ctx.mode !== 'tui') throw new Error('The inspector requires interactive Pi.');
      if (importing) throw new Error('Close the import dialog before opening the inspector.');
      inspectorController = controller;
      const signal = inspectorController.signal;
      const action = await showInspector(ctx, { profile: a.name, session: ctx.sessionManager.getSessionId(), children: a.children, usage: a.usage, memory: a.memory, page, signal,
        refreshUsage: () => { collectUsage(ctx); try { a.children.collectUsage(); } catch (error) { ctx.ui.notify(`Could not save child usage: ${errorText(error)}`, 'error'); } },
      });
      if (signal.aborted) return;
      if (action === 'model') await pickModel(ctx, 'subagent');
      else if (action) await showAgentView(ctx, { id: action.open, children: a.children, signal });
    } catch (error) { ctx.ui.notify(errorText(error), 'error'); }
    finally { if (inspectorController === controller) inspectorController = undefined; }
  };
  pi.registerShortcut(shortcut, { description: 'Inspect OptChat agents, usage and background activity', handler: ctx => inspect(ctx, 'agents') });
  const command = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (remote) { ctx.ui.notify('Manage this profile in its original window. Here use /tell-main or /complete.', 'info'); return; }
    if (importing) throw new Error('Close the import dialog before changing profile settings.');
    let action = args.trim();
    if (!action) {
      const a = active;
      const info = a ? `${a.name} · ${a.memory.root.length} messages · ${a.memory.pending} pending\nCompactor: ${a.config.compactor.model} (${a.config.compactor.thinking})\nAgents: ${a.config.subagent.model} (${a.config.subagent.thinking})\n${a.memory.lastError ?? ''}` : 'No active profile';
      action = await ctx.ui.select(`OptChat\n${info}`, ['profile', 'settings', 'model', 'agents', 'usage', 'activity', 'instructions', 'browse', 'import']) ?? '';
    }
    if (action === 'import') {
      const a = required();
      if (!ctx.hasUI) throw new Error('/optchat import requires interactive Pi.');
      if (!ctx.isIdle() || a.children.active || reports.length) throw new Error('Finish active work and pending reports before importing.');
      importing = true; importController = new AbortController(); let closed = false;
      status(ctx);
      const signal = importController.signal;
      importTask = (async () => {
        let job = pendingImport(a.dir);
        if (job) {
          const selected = await ctx.ui.select(`Paused ${job.mode} import · ${job.added} new messages`, ['Resume import', 'Discard staged import', 'Cancel'], { signal });
          if (selected === 'Discard staged import') {
            if (await ctx.ui.confirm('Discard import?', 'Original memory stays unchanged. Staged summaries will be removed.', { signal })) { signal.throwIfAborted(); discardImport(a.dir); }
            return;
          }
          if (selected !== 'Resume import') return;
        } else {
          const plan = await chooseImport(ctx, a.name, a.memory, `${a.config.compactor.provider}/${a.config.compactor.model} (${a.config.compactor.thinking})`, signal);
          if (!plan) return;
          signal.throwIfAborted();
          flush(); a.inbox.recover(a.memory); await checkpoints; await a.memory.close(); closed = true;
          signal.throwIfAborted();
          job = prepareImport(a.dir, a.memory, plan.entries, plan.mode);
          if (!job) return;
        }
        if (!closed) { await a.memory.close(); closed = true; }
        const compress = createCompressor(ctx.modelRegistry, () => a.config.compactor, message => {
          a.usage.compression(message, 'import', ctx.sessionManager.getSessionId());
        }, () => a.config.summaryAcceptBytes);
        const completed = await showProgress(ctx, job, (signal, progress) => runImport(a.dir, compress, signal, progress), signal);
        ctx.ui.notify(completed ? `Imported ${job.added} messages into ${a.name}. Previous memory retained at ${job.previous === '.' ? a.dir : join(a.dir, job.previous)}.`
          : 'Import paused. Use /optchat import to resume. Other profiles remain available.', 'info');
      })();
      let failure: unknown;
      try { await importTask; } catch (error) { failure = error; }
      finally { importing = false; importTask = undefined; importController = undefined; ctx.ui.setWidget('optchat-import', undefined); }
      if (closed && !stopping) await ctx.newSession({ setup: async manager => { manager.appendCustomEntry(binding, { name: a.name }); } });
      else status(ctx);
      if (failure) throw failure;
      return;
    }
    if (action === 'profile') {
      if (!ctx.isIdle() || active?.children.active) throw new Error('Finish or stop active work before switching profiles.');
      const selected = await chooseProfile(ctx);
      if (!selected || selected === active?.name) return;
      await ctx.newSession({ setup: async manager => { manager.appendCustomEntry(binding, { name: selected }); } });
      return;
    }
    if (action === 'settings') {
      const a = required();
      if (ctx.mode !== 'tui') throw new Error('/optchat settings requires interactive Pi. Edit config.json in the profile directory instead.');
      return showSettings(ctx, settingsOptions(ctx, a));
    }
    if (action === 'model') return pickModel(ctx, 'compactor');
    if (action === 'agents model') return pickModel(ctx, 'subagent');
    if (action === 'agents' || action === 'usage' || action === 'activity') return inspect(ctx, action);
    if (action === 'instructions') {
      const a = required();
      const edited = await ctx.ui.editor(`${a.name} · AGENTS.md`, instructions(a.dir));
      if (edited !== undefined) { atomicWrite(join(a.dir, 'AGENTS.md'), edited); ctx.ui.notify('Saved. Applies to the next turn and newly spawned agents.', 'info'); }
      return;
    }
    if (action === 'browse') {
      const a = required(), file = exportBrowser(a.memory, a.name, a.dir);
      if (ctx.hasUI) execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [file], error => { if (error) ctx.ui.notify(`Open ${file}`, 'info'); });
      ctx.ui.notify(file, 'info'); return;
    }
    if (action) throw new Error('Use /optchat [profile|settings|model|agents|usage|activity|instructions|browse|import].');
  };
  pi.registerCommand('complete', { description: 'End this connected conversation and hand off to the main agent', handler: async (_args, ctx) => {
    if (!remote) { ctx.ui.notify('/complete is for connected subagent windows.', 'info'); return; }
    try { await remote.complete(); } catch (error) { ctx.ui.notify(errorText(error), 'error'); }
  } });
  pi.registerCommand('tell-main', { description: 'Send a message to the main agent from this connected window', handler: async (args, ctx) => {
    if (!remote) { ctx.ui.notify('/tell-main is for connected subagent windows.', 'info'); return; }
    try { await remote.tell(args); } catch (error) { ctx.ui.notify(errorText(error), 'error'); }
  } });
  pi.registerCommand('optchat', { description: 'OptChat profiles, settings, models, agents, instructions, memory browser, and imports',
    getArgumentCompletions: prefix => ['profile', 'settings', 'model', 'agents', 'agents model', 'usage', 'activity', 'instructions', 'browse', 'import'].filter(s => s.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => { try { await command(args, ctx); } catch (error) { ctx.ui.notify(errorText(error), 'error'); } },
  });
}
