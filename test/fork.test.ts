import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { splitView } from '../src/cache.ts';
import { IMPORT_GUIDANCE } from '../src/import/guidance.ts';
import { CAP, Memory, NODE, VIEW } from '../src/memory.ts';
import { createProfile, profilePath } from '../src/profiles.ts';
import * as transcript from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { fakeProvider, fakeRuntime, makeChildren } from './fakes.ts';

const doc = readFileSync(resolve(import.meta.dirname, '..', 'AGENTS.md'), 'utf8');
const section = (heading: string) => doc.split(/^## /m).find(part => part.startsWith(heading)) ?? assert.fail(`AGENTS.md has no "${heading}" section`);
const cells = (heading: string, first: string) => {
  const row = section(heading).split('\n').find(line => line.startsWith(`| ${first} |`) || line.startsWith(`| \`${first}\` |`));
  return row?.split('|').slice(1, -1).map(cell => cell.trim()) ?? assert.fail(`AGENTS.md "${heading}" has no row "${first}"`);
};
const number = (text: string) => Number(text.match(/\d[\d,]*/)?.[0].replaceAll(',', ''));

const design = (area: string) => {
  const [name, , upstream] = cells("Keep the fork's design", area);
  return `AGENTS.md "Keep the fork's design", row "${name}": do not take the upstream side (${upstream})`;
};

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function load(profile?: string) {
  const tools: { name: string; description: string }[] = [], commands: string[] = [], handlers = new Map<string, Handler[]>();
  optchat({ registerTool: (tool: { name: string; description: string }) => tools.push(tool), registerCommand: (name: string) => commands.push(name),
    registerFlag: () => {}, registerShortcut: () => {}, registerMessageRenderer: () => {}, getFlag: () => profile, appendEntry: () => {},
    on: (name: string, handler: Handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]) } as unknown as ExtensionAPI);
  return { tools, commands, handlers };
}

test('spawn never allows subagents to delegate', () => {
  const spawn = load().tools.find(tool => tool.name === 'spawn');
  assert.ok(spawn, 'the main agent registers spawn');
  assert.doesNotMatch(spawn.description, /nest|levels?\b|delegat|their own subagents|grandchild/i, design('Who delegates'));
});

test('the only registered command is optchat', () => {
  assert.deepEqual(load().commands, ['optchat'], design('Windows'));
});

test('a turn sends the view and the new message, never the previous exchange', () => {
  assert.ok(!Object.hasOwn(transcript, 'previousExchange'), design('Turn context'));
  const at = Date.now();
  const earlier: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }], api: 'openai-completions', provider: 'p', model: 'm',
    timestamp: at, stopReason: 'stop', usage: emptyUsage() };
  const previous = [{ role: 'user' as const, content: 'earlier request', timestamp: at }, earlier];
  const current = { role: 'user' as const, content: 'new request', timestamp: at };
  const context = Reflect.apply(transcript.buildContext, undefined, [[], [current], 'view of summaries', 'prompt', previous]);
  assert.deepEqual(context, transcript.buildContext([], [current], 'view of summaries', 'prompt'), design('Turn context'));
});

test('a subagent gets zoom, date and tell_parent beside Pi\'s built-ins, and cannot spawn or tell', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-fork-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const children = makeChildren({ memory, runtime: await fakeRuntime(dir, fakeProvider('done')), dir });
  try {
    const [id] = await children.spawn([{ task: 'report' }], dir);
    const tools = children.live(id)?.session.getAllTools() ?? [];
    assert.deepEqual(tools.filter(tool => tool.sourceInfo.source !== 'builtin').map(tool => tool.name).sort(), ['date', 'tell_parent', 'zoom'], design('Who delegates'));
    assert.ok(tools.some(tool => tool.sourceInfo.source === 'builtin'), 'Pi\'s built-in tools stay');
  } finally { await children.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('AGENTS.md states the NODE, VIEW and CAP the code uses', () => {
  const states = (name: string) => number(cells('Follow the recipe', name)[1]);
  assert.equal(states('NODE'), NODE, 'AGENTS.md "Follow the recipe" constants table: NODE');
  assert.equal(states('VIEW'), VIEW, 'AGENTS.md "Follow the recipe" constants table: VIEW');
  assert.equal(states('CAP'), CAP, 'AGENTS.md "Follow the recipe" constants table: CAP');
});

test('AGENTS.md states the cache marks where splitView cuts the view', () => {
  const marks = [...cells('Follow the recipe', 'Cache marks')[1].matchAll(/\d[\d,]*/g)].map(([text]) => number(text));
  const view = '123456789\n'.repeat((marks.at(-1) ?? 0) / 10 + 1000);
  const cuts = splitView(view).slice(0, -1).reduce<number[]>((at, piece) => [...at, (at.at(-1) ?? 0) + piece.length], []);
  assert.deepEqual(cuts, marks, 'AGENTS.md "Follow the recipe" constants table: cache marks');
});

const withProfile = (name: string) => {
  createProfile(name);
  const dir = profilePath(name);
  return { dir, composed: `${readFileSync(join(dir, 'AGENTS.md'), 'utf8')}\n\n${IMPORT_GUIDANCE}` };
};

test('the main agent gets the profile instructions followed by IMPORT_GUIDANCE', async () => {
  const { dir, composed } = withProfile('main');
  const { handlers } = load('main');
  const fire = async (name: string, event: unknown) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  const ctx = { mode: 'print', hasUI: false, cwd: dir, ui: { notify: () => {}, setStatus: () => {}, setTitle: () => {} },
    sessionManager: { getEntries: () => [], getSessionId: () => 'fork-test' }, modelRegistry: {} } as unknown as ExtensionContext;
  await fire('session_start', { type: 'session_start' });
  try {
    const event = { systemPromptOptions: { sections: {} as Record<string, string> }, systemPrompt: '' };
    await fire('before_agent_start', event);
    assert.equal(event.systemPromptOptions.sections.instructions, composed, 'the main agent gets the profile instructions, then IMPORT_GUIDANCE');
  } finally { await fire('session_shutdown', { type: 'session_shutdown' }); }
});

test('a subagent gets the profile instructions followed by IMPORT_GUIDANCE', async () => {
  const { dir, composed } = withProfile('child');
  let system = '';
  const runtime = await fakeRuntime(dir, fakeProvider((model, context) => {
    const head = context.messages.find(m => m.role === 'system');
    system = Object.values(head && 'sections' in head ? head.sections ?? {} : {}).join('\n');
    return fakeProvider('done').streamSimple!(model, context);
  }));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  let reported!: () => void;
  const done = new Promise<void>(resolve => { reported = resolve; });
  const children = makeChildren({ memory, runtime, dir, report: async () => reported() });
  try {
    await children.spawn([{ task: 'report' }], dir);
    await done;
    assert.ok(system.includes(composed), 'a subagent gets the same instructions and IMPORT_GUIDANCE as the main agent');
  } finally { await children.close(); await memory.close(); }
});
