import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { COMPACT } from './prompts.ts';
import { bytes, NODE, type Compressor } from './memory.ts';
import { cacheFor, splitView } from './cache.ts';
import { IMPORT_GUIDANCE } from './import/guidance.ts';

export interface ModelChoice { provider: string; model: string; thinking: ThinkingLevel }
/** Recipe §4.2: a realistic, dense line of exactly NODE bytes, tagged with kinds. No ids or numbers: the compactor copies them. */
export const SCALE = 'user: Keep work and personal memory separate; use a binary summary tree and inspect original messages before acting. talk: Implemented the append-only log with durable writes and a stable view. tool: ran the test suite; echo: one failure, a timezone test that assumes UTC time. user: Main agent uses a large model, compactor a small one at medium effort. work: Worker finished the parser; tests cover invalid records and repeated imports. talk: The browser opens original messages, keeping the dates and sources.';
const WARM_MS = 4 * 60_000; // Anthropic's short cache lives 5 minutes from its last use.

/** Parallel calls can't read a cache entry that isn't written yet, so one call primes a cold prefix and the rest wait until it answers. */
function primeFirst() {
  const warm = new Map<string, number | Promise<void>>();
  return async (prefix: string, signal: AbortSignal) => {
    for (let state = warm.get(prefix); state !== undefined; state = warm.get(prefix)) {
      if (typeof state === 'number') { if (Date.now() - state < WARM_MS) break; warm.delete(prefix); continue; }
      // A cancelled waiter leaves at once instead of waiting for someone else's primer.
      signal.throwIfAborted();
      let wake = () => {};
      const aborted = new Promise<void>(resolve => { wake = resolve; });
      signal.addEventListener('abort', wake, { once: true });
      await Promise.race([state, aborted]);
      signal.removeEventListener('abort', wake);
      signal.throwIfAborted();
    }
    let release = () => {};
    const pending = warm.has(prefix) ? undefined : new Promise<void>(resolve => { release = resolve; });
    if (pending) warm.set(prefix, pending);
    return (ok: boolean) => {
      if (ok) { for (const [k, at] of warm) if (typeof at === 'number' && Date.now() - at >= WARM_MS) warm.delete(k); warm.set(prefix, Date.now()); }
      else if (warm.get(prefix) === pending) warm.delete(prefix);
      release();
    };
  };
}
export function createCompressor(registry: ModelRegistry, choice: () => ModelChoice,
  onUsage: (message: AssistantMessage) => void = () => {}): Compressor {
  const gate = primeFirst();
  return async (input, signal) => {
    const selected = choice();
    const model = registry.find(selected.provider, selected.model);
    if (!model) throw new Error(`Compactor model unavailable: ${selected.provider}/${selected.model}. Use /optchat model.`);
    const step = `${input.historical ? IMPORT_GUIDANCE + '\n\n' : ''}For scale, this line is exactly 512 bytes:\n${SCALE}\n\n${input.merge ? 'Merge these two lines into one' : 'Compress this message into one line'}, in at most 512 bytes:\n${input.source}`;
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: input.context }, { type: 'text', text: step }], timestamp: Date.now() }];
    const view = splitView(input.context);
    const prefix = model.api === 'anthropic-messages' && view.length > 1 ? `${model.provider}/${model.id}/${selected.thinking}\n${view.slice(0, -1).join('')}` : undefined;
    const tries: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const warmed = prefix ? await gate(prefix, signal) : () => {};
      let reply: AssistantMessage;
      try {
        const stream = registry.streamSimple(model, { systemPrompt: COMPACT, messages }, {
          reasoning: selected.thinking === 'off' ? undefined : selected.thinking, signal, cacheRetention: 'short',
          sessionId: 'optchat-compactor', transport: 'sse', onPayload: payload => cacheFor(model.api, payload),
        });
        // The cache entry is usable once the model starts answering.
        for await (const event of stream) if (event.type !== 'start') { warmed(event.type !== 'error'); break; }
        reply = await stream.result();
      } finally { warmed(false); }
      onUsage(reply);
      if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(reply.errorMessage ?? `Compactor ${reply.stopReason}`);
      const line = reply.content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
      if (!line) throw new Error('Compactor returned no text.');
      tries.push(line);
      if (bytes(line) <= NODE) break;
      messages.push(reply);
      const cut = Buffer.from(line).subarray(0, NODE).toString('utf8').replace(/\uFFFD$/, '');
      messages.push({ role: 'user', content: `That line is ${bytes(line)} bytes; the limit is 512. It must end where it is cut here:\n${cut}| ← LIMIT`, timestamp: Date.now() });
    }
    return tries.reduce((a, b) => bytes(a) <= bytes(b) ? a : b);
  };
}
