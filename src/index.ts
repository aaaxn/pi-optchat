import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Memory } from './memory.ts';
import { createCompressor } from './compactor.ts';
import { agentInstructions, atomicWrite, createProfile, instructions, lastProfile, listProfiles, loadConfig, lockProfile, profilePath, rememberProfile, saveConfig, ProfileBusyError, type ProfileConfig } from './profiles.ts';
import { MASTER, VIEW_DOC } from './prompts.ts';
import { cacheFor, record } from './cache.ts';
import { REPORT_TYPE } from './transcript.ts';
import { errorText, NEEDS_PROFILE, Turn } from './turn.ts';
import { registerReportRenderer } from './report-message.ts';
import { memoryTools, result } from './tools.ts';
import { Children, CWD_DOC, loadedBuiltins } from './agents.ts';
import { exportBrowser } from './browser.ts';
import { Inbox } from './inbox.ts';
import { checkpoint } from './checkpoint.ts';
import { memoryDirectory, pendingImport, prepareImport, runImport, discardImport } from './import/job.ts';
import { chooseImport, showProgress } from './import/ui.ts';
import { UsageLedger } from './usage.ts';
import { showInspector, type InspectorPage } from './inspector.ts';
import { showAgentView } from './agent-view.ts';
import { inspectorShortcut, mountNavigation } from './navigation.ts';
import { mainTitle, TabTitle } from './title.ts';

const binding = 'optchat.profile';
interface Active { name: string; dir: string; config: ProfileConfig; memory: Memory; inbox: Inbox; children: Children; usage: UsageLedger; unlock: () => Promise<void> }

export default function optchat(pi: ExtensionAPI) {
  let active: Active | undefined;
  const turn = new Turn(() => active);
  let checkpoints = Promise.resolve();
  let importing = false;
  let stopping = false;
  let importController: AbortController | undefined;
  let importTask: Promise<void> | undefined;
  let unmountNavigation: (() => void) | undefined;
  let inspectorController: AbortController | undefined;
  const shortcut = inspectorShortcut();
  const title = new TabTitle();
  let untitle: (() => void) | undefined;
  const showTitle = (ctx: ExtensionContext) => {
    const a = active;
    if (a) title.show(text => ctx.ui.setTitle(text), mainTitle(a.name, turn.working, a.children.ids.length));
  };
  pi.registerFlag('optchat-profile', { description: 'OptChat profile (required for noninteractive sessions without a saved binding)', type: 'string' });
  const required = () => { if (!active) throw new Error(NEEDS_PROFILE); return active; };
  const status = (ctx: ExtensionContext) => {
    const a = active;
    ctx.ui.setStatus('optchat', a ? `OptChat: ${a.name} · ${a.memory.root.length} messages · ${a.memory.pending} pending · ${a.children.ids.length} agents${importing ? ' · importing' : pendingImport(a.dir) ? ' · import paused: /optchat import' : ''}` : 'OptChat: choose profile');
  };
  // Shown as a dark background box, not as the user's own message. Before this profile has run once there is no
  // built system prompt to reuse, so that rare case still goes through Pi's normal prompt path as a user message.
  const sendReport = (text: string) => {
    if (turn.prompt) pi.sendMessage({ customType: REPORT_TYPE, content: text, display: true }, { triggerTurn: true, deliverAs: 'steer' });
    else pi.sendUserMessage(text, { deliverAs: 'steer', expandPromptTemplates: false });
  };
  const deliverReport = async (text: string) => {
    turn.addReport(text);
    if (!stopping) sendReport(text);
  };
  const stop = async () => {
    inspectorController?.abort(); unmountNavigation?.(); unmountNavigation = undefined;
    stopping = true; importController?.abort(); await importTask?.catch(() => {});
    if (!active) return;
    const old = active;
    try {
      await old.children.close(); turn.flush(); if (!pendingImport(old.dir)) old.inbox.recover(old.memory);
      await old.memory.close(); await checkpoints;
      await checkpoint(old.dir);
    } finally {
      await old.memory.close(); await old.unlock(); active = undefined;
      turn.reset(); untitle?.(); untitle = undefined; title.clear();
    }
  };
  const BACK = 'Back';
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
      const saved = Turn.journal(dir); // Read before the memory opens, so a bad journal fails before the inbox recovers anything.
      const memory = new Memory(memoryDirectory(dir), createCompressor(ctx.modelRegistry, () => config.compactor, message => {
        usage.compression(message, 'compactor', sessionId);
        status(ctx);
      }), warning => ctx.ui.notify(warning, 'error'));
      openingMemory = memory;
      const inbox = new Inbox(dir);
      const recovered = pendingImport(dir) ? 0 : inbox.recover(memory);
      if (recovered) ctx.ui.notify(`Recovered ${recovered} unanswered inputs into ${name}'s memory. Ask to continue them when ready.`, 'info');
      const children = new Children(memory, ctx.modelRegistry, () => config.subagent,
        deliverReport, text => ctx.ui.notify(text, 'error'), dir, { parentSession: sessionId, usage, builtins: () => loadedBuiltins(pi) });
      turn.restore(saved, dir, memory);
      rememberProfile(name);
      active = { name, dir, config, memory, inbox, children, usage, unlock };
      if (ctx.mode === 'tui') unmountNavigation = mountNavigation(ctx, children, shortcut, page => { void inspect(ctx, page); });
      untitle = children.subscribe(() => showTitle(ctx)); showTitle(ctx);
      status(ctx);
      ctx.ui.notify(`OptChat · ${name} · ${memory.root.length} messages\nCompactor: ${config.compactor.provider}/${config.compactor.model} (${config.compactor.thinking})`, 'info');
      const queuedReports = [...turn.pendingReports];
      setImmediate(() => { if (active?.memory === memory && !pendingImport(dir)) for (const text of queuedReports) sendReport(text); });
    } catch (error) {
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
          if (settled || await ctx.ui.select(`${name} is open in another window\n${error.owner}`, [BACK]) !== BACK) throw error;
          name = await chooseProfile(ctx);
        }
      }
      if (name !== boundName) pi.appendEntry(binding, { name });
    } catch (error) {
      if (active) await stop().catch(() => {});
      turn.fail(error, ctx);
    }
    // Pi sets its own title once every session_start handler has finished, so put ours back afterwards.
    for (const ms of [0, 250, 1000]) setTimeout(() => title.reapply(), ms).unref();
  });
  pi.on('session_info_changed', () => title.reapply()); // Pi retitles the tab on session renames, just before this.
  pi.on('session_shutdown', stop);
  pi.on('session_before_switch', () => importing || active?.children.active ? { cancel: true } : undefined);
  pi.on('session_before_fork', () => importing || active?.children.active ? { cancel: true } : undefined);
  const importBusy = (dir: string) => importing || Boolean(pendingImport(dir));
  pi.on('input', async (event, ctx) => {
    if (!active) { ctx.ui.notify(turn.fault ?? 'Select a profile with /optchat profile before chatting.', 'error'); return { action: 'handled' }; }
    if (importBusy(active.dir)) { ctx.ui.notify('This profile has an import in progress. Use /optchat import to resume or discard it, or switch profiles.', 'info'); return { action: 'handled' }; }
    if (event.source !== 'extension') {
      try { active.inbox.record(event.text); }
      catch (error) { ctx.ui.notify(`Could not save input: ${errorText(error)}`, 'error'); return { action: 'handled' }; }
    }
    return { action: 'continue' };
  });
  // A report sent while Pi is idle starts its run without before_agent_start; it reuses the last built prompt.
  pi.on('agent_start', (_event, ctx) => { turn.agentStart(); showTitle(ctx); turn.startIfIdle(); });
  pi.on('before_agent_start', event => {
    turn.start();
    const a = required();
    // Pi's own prompt sections (AGENTS.md files, skills, cwd) stay; the profile's instructions go last.
    event.systemPromptOptions.customPrompt = `${MASTER}\n\n${VIEW_DOC}`;
    event.systemPromptOptions.sections.instructions = agentInstructions(a.dir);
    turn.prompt = event.systemPrompt;
  });
  pi.on('message_end', (event, ctx) => {
    const bounded = turn.messageEnd(event.message, ctx);
    if (bounded) return { message: bounded };
  });
  pi.on('context_with_system', async (event, ctx) => ({ messages: await turn.context(event.messages, ctx, importBusy) }));
  pi.on('before_provider_request', (event, ctx) => cacheFor(ctx.model?.api, event.payload));
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
    turn.settled(ctx); showTitle(ctx); status(ctx);
    if (active) {
      const dir = active.dir;
      checkpoints = checkpoints.then(() => checkpoint(dir)).catch(error => ctx.ui.notify(`Local checkpoint failed: ${errorText(error)}`, 'error'));
      await checkpoints;
    }
  });
  registerReportRenderer(pi);
  for (const tool of memoryTools(() => required().memory)) pi.registerTool(tool);
  pi.registerTool({ name: 'spawn', label: 'Spawn background agents',
    description: 'Start one background subagent per task, in parallel, returning IDs immediately. Use only when the user asks. Give each task the cwd of the project it works on, so the subagent starts there with that project\'s AGENTS.md. Each receives the current memory view and read-only zoom/date. When all of this spawn\'s subagents finish, their reports arrive together as one message; never poll or sleep waiting for them. Put independent work in separate spawns. The profile allows 8 active agents.',
    parameters: Type.Object({ tasks: Type.Array(Type.Object({ task: Type.String(), cwd: Type.Optional(Type.String({ description: CWD_DOC })) }), { minItems: 1, maxItems: 8 }) }),
    async execute(_id, args, signal, _update, ctx) {
      const ids = await required().children.spawn(args.tasks, ctx.cwd, signal); status(ctx);
      return result(`Started: ${ids.join(', ')}. Reports will arrive automatically.`);
    },
  });
  pi.registerTool({ name: 'tell', label: 'Tell background agent', description: 'Send a message to a subagent. A running one gets it at its next tool boundary. A finished one you started is resumed with its earlier conversation, and its new report arrives automatically.',
    parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    async execute(_id, args) { return result(await required().children.tell(args.id, args.message)); },
  });

  const pickModel = async (ctx: ExtensionContext, role: 'compactor' | 'subagent') => {
    const a = required(), current = a.config[role];
    const choices = ctx.modelRegistry.getAvailable().map(m => `${m.provider}/${m.id}`);
    choices.sort((a, b) => Number(b === `${current.provider}/${current.model}`) - Number(a === `${current.provider}/${current.model}`) || a.localeCompare(b));
    const selected = await ctx.ui.select(`${a.name}: ${role} model`, choices);
    if (!selected) return;
    const thinking = await ctx.ui.select('Thinking level', ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    if (!thinking) return;
    const separator = selected.indexOf('/');
    a.config[role] = { provider: selected.slice(0, separator), model: selected.slice(separator + 1), thinking: thinking as ThinkingLevel };
    saveConfig(a.dir, a.config); ctx.ui.notify(`${role}: ${selected} (${thinking}); applies to new calls.`, 'info');
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
      const action = await showInspector(ctx, { profile: a.name, session: ctx.sessionManager.getSessionId(), children: a.children, usage: a.usage, page, signal,
        refreshUsage: () => { collectUsage(ctx); try { a.children.collectUsage(); } catch (error) { ctx.ui.notify(`Could not save child usage: ${errorText(error)}`, 'error'); } },
      });
      if (signal.aborted) return;
      if (action === 'model') await pickModel(ctx, 'subagent');
      else if (action) await showAgentView(ctx, { id: action.open, children: a.children, signal });
    } catch (error) { ctx.ui.notify(errorText(error), 'error'); }
    finally { if (inspectorController === controller) inspectorController = undefined; }
  };
  pi.registerShortcut(shortcut, { description: 'Inspect OptChat agents and usage', handler: ctx => inspect(ctx, 'agents') });
  const command = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (importing) throw new Error('Close the import dialog before changing profile settings.');
    let action = args.trim();
    if (!action) {
      const a = active;
      const info = a ? `${a.name} · ${a.memory.root.length} messages · ${a.memory.pending} pending\nCompactor: ${a.config.compactor.model} (${a.config.compactor.thinking})\nAgents: ${a.config.subagent.model} (${a.config.subagent.thinking})\n${a.memory.lastError ?? ''}` : 'No active profile';
      action = await ctx.ui.select(`OptChat\n${info}`, ['profile', 'model', 'agents', 'usage', 'instructions', 'browse', 'import']) ?? '';
    }
    if (action === 'import') {
      const a = required();
      if (!ctx.hasUI) throw new Error('/optchat import requires interactive Pi.');
      if (!ctx.isIdle() || a.children.active || turn.pendingReports.length) throw new Error('Finish active work and pending reports before importing.');
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
          turn.flush(); a.inbox.recover(a.memory); await checkpoints; await a.memory.close(); closed = true;
          signal.throwIfAborted();
          job = prepareImport(a.dir, a.memory, plan.entries, plan.mode);
          if (!job) return;
        }
        if (!closed) { await a.memory.close(); closed = true; }
        const compress = createCompressor(ctx.modelRegistry, () => a.config.compactor, message => {
          a.usage.compression(message, 'import', ctx.sessionManager.getSessionId());
        });
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
    if (action === 'model') return pickModel(ctx, 'compactor');
    if (action === 'agents model') return pickModel(ctx, 'subagent');
    if (action === 'agents' || action === 'usage') return inspect(ctx, action);
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
    if (action) throw new Error('Use /optchat [profile|model|agents|usage|instructions|browse|import].');
  };
  pi.registerCommand('optchat', { description: 'OptChat profiles, models, agents, instructions, memory browser, and imports',
    getArgumentCompletions: prefix => ['profile', 'model', 'agents', 'agents model', 'usage', 'instructions', 'browse', 'import'].filter(s => s.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => { try { await command(args, ctx); } catch (error) { ctx.ui.notify(errorText(error), 'error'); } },
  });
}
