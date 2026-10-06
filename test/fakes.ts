import './support.ts';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children } from '../src/agents.ts';
import type { ModelChoice } from '../src/compactor.ts';
import type { Memory } from '../src/memory.ts';
import { emptyUsage, type UsageLedger } from '../src/usage.ts';

type ProviderConfig = Parameters<ModelRuntime['registerProvider']>[1];
type Stream = NonNullable<ProviderConfig['streamSimple']>;

const PROVIDER = 'optchat-test';
const MODEL = 'child';
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** A synthetic provider with one model. A string reply is the text of every answer; a function is the model itself. */
export function fakeProvider(reply?: string | Stream, options: { model?: string; cost?: typeof NO_COST } = {}): ProviderConfig {
  const { model = MODEL, cost = NO_COST } = options;
  const streamSimple: Stream | undefined = typeof reply === 'string' ? model => {
    const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: reply }], api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
    return stream;
  } : reply;
  return {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: model, name: `Synthetic ${model}`, reasoning: false, input: ['text'], cost, contextWindow: 100000, maxTokens: 1000 }],
    ...(streamSimple && { streamSimple }),
  };
}

/** A Pi model runtime whose only credentials and caches live in `dir`, with `provider` registered under `name`. */
export async function fakeRuntime(dir: string, provider: ProviderConfig, name = PROVIDER) {
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider(name, provider);
  return runtime;
}

interface ChildrenOptions {
  memory: Memory; runtime: ModelRuntime; dir: string;
  choice?: ModelChoice; instructions?: string; report?: (text: string) => Promise<void>; warn?: (text: string) => void;
  parentSession?: string; usage?: UsageLedger; builtins?: () => Iterable<string>;
  createSession?: typeof createAgentSession;
}

/** `Children` over a fake runtime. By default its sessions use that runtime and it runs the `child` model of `fakeProvider`. */
export function makeChildren({ memory, runtime, dir, choice = { provider: PROVIDER, model: MODEL, thinking: 'minimal' }, instructions = '',
  report = async () => {}, warn = () => {}, parentSession, usage, builtins, createSession }: ChildrenOptions) {
  return new Children(memory, new ModelRegistry(runtime), () => choice, () => instructions, report, warn, dir,
    { parentSession, usage, builtins, createSession: createSession ?? (options => createAgentSession({ ...options, modelRuntime: runtime })) });
}
