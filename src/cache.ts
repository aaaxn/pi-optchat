import { isView } from './memory.ts';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stable, line-aligned cuts from recipe §8. Text is preserved byte for byte. */
export function splitView(text: string) {
  const pieces: string[] = [];
  let offset = 0;
  for (const mark of [50_000, 80_000, 100_000]) {
    if (mark >= text.length) break;
    const cut = text.lastIndexOf('\n', mark) + 1;
    if (cut > offset) { pieces.push(text.slice(offset, cut)); offset = cut; }
  }
  pieces.push(text.slice(offset));
  return pieces;
}

/** Anthropic: three stable view marks plus automatic end-of-request caching. */
export function cachePayload(payload: unknown): unknown {
  if (!record(payload) || !Array.isArray(payload.messages)) return payload;
  const messages = payload.messages;
  const view = new Set<unknown>();
  for (const message of messages) {
    if (!record(message) || message.role !== 'user' || !Array.isArray(message.content)) continue;
    const at = message.content.findIndex((block: unknown) => record(block) && block.type === 'text' && typeof block.text === 'string' && isView(block.text));
    if (at < 0) continue;
    const pieces = splitView(message.content[at].text);
    const blocks = pieces.map((text, j) => ({ type: 'text', text, ...(j < pieces.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}) }));
    message.content.splice(at, 1, ...blocks);
    for (const block of blocks) view.add(block);
    break;
  }
  if (!view.size) return payload;
  // Pi's default system/recent-message marks would exceed Anthropic's four-mark limit.
  // Remove every adapter mark, keeping only the newly split view's three marks.
  for (const section of [payload.system, payload.tools]) {
    if (Array.isArray(section)) for (const item of section) if (record(item)) delete item.cache_control;
  }
  for (const message of messages) {
    if (!record(message)) continue;
    delete message.cache_control;
    if (Array.isArray(message.content)) for (const item of message.content) if (record(item) && !view.has(item)) delete item.cache_control;
  }
  payload.cache_control = { type: 'ephemeral' };
  return payload;
}

/** OpenAI Responses: keep reasoning across mid-run messages (recipe §8). The view relies on implicit prefix
 * caching, because the gpt-5.6 models reject explicit prompt_cache_breakpoint marks. */
export function openaiCachePayload(payload: unknown): unknown {
  if (record(payload) && record(payload.reasoning)) payload.reasoning = { ...payload.reasoning, context: 'all_turns' };
  return payload;
}

export function cacheFor(api: string | undefined, payload: unknown): unknown {
  if (api === 'anthropic-messages') return cachePayload(payload);
  if (api === 'openai-responses' || api === 'openai-codex-responses' || api === 'azure-openai-responses') return openaiCachePayload(payload);
  return payload;
}
