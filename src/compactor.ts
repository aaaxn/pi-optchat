import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { COMPACT } from './prompts.ts';
import { bytes, NODE, type Compressor } from './memory.ts';
import { cacheFor } from './cache.ts';
import { IMPORT_GUIDANCE } from './import/guidance.ts';

export interface ModelChoice { provider: string; model: string; thinking: ThinkingLevel }
const scaleBase = 'user: Keep work and personal memory separate; use a binary summary tree and inspect original messages before acting. talk: Implemented the append-only log with durable writes and a stable view. echo: Checked caching, chronological summaries, cancellation, and profile locks. user: Main agent uses Opus; compactor uses Sonnet at medium effort. work: Worker completed the parser; tests cover invalid records and repeated imports. talk: The browser opens original messages, preserving dates and sources.';
export const SCALE = scaleBase.padEnd(NODE, '.').slice(0, NODE);
export function createCompressor(registry: ModelRegistry, choice: () => ModelChoice,
  onUsage: (message: AssistantMessage) => void = () => {}): Compressor {
  return async (input, signal) => {
    const selected = choice();
    const model = registry.find(selected.provider, selected.model);
    if (!model) throw new Error(`Compactor model unavailable: ${selected.provider}/${selected.model}. Use /optchat model.`);
    const step = `${input.historical ? IMPORT_GUIDANCE + '\n\n' : ''}For scale, this line is exactly 512 bytes:\n${SCALE}\n\n${input.merge ? 'Merge these two lines into one' : 'Compress this message into one line'}, in at most 512 bytes:\n${input.source}`;
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: input.context }, { type: 'text', text: step }], timestamp: Date.now() }];
    const tries: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const reply = await registry.streamSimple(model, { systemPrompt: COMPACT, messages }, {
        reasoning: selected.thinking === 'off' ? undefined : selected.thinking, signal, cacheRetention: 'short',
        sessionId: 'optchat-compactor', transport: 'sse', onPayload: payload => cacheFor(model.api, payload),
      }).result();
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
