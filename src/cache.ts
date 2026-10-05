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
  let found = false;
  for (const message of messages) {
    if (!record(message) || message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (let i = 0; i < message.content.length; i++) {
      const block: unknown = message.content[i];
      if (!record(block) || block.type !== 'text' || typeof block.text !== 'string' || !block.text.startsWith('<chat>\n')) continue;
      found = true;
      const pieces = splitView(block.text);
      message.content.splice(i, 1, ...pieces.map((text, j) => ({ type: 'text', text,
        ...(j < pieces.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}) })));
      break;
    }
    if (found) break;
  }
  if (!found) return payload;
  // Pi's default system/recent-message marks would exceed Anthropic's four-mark limit.
  // Remove all adapter marks first, keeping only the newly split view's three marks.
  for (const section of [payload.system, payload.tools]) {
    if (Array.isArray(section)) for (const item of section) if (record(item)) delete item.cache_control;
  }
  let seenView = false;
  for (const message of messages) {
    if (!record(message)) continue;
    delete message.cache_control;
    if (!Array.isArray(message.content)) continue;
    let inView = false;
    for (const item of message.content) {
      if (!record(item)) continue;
      if (!seenView && item.type === 'text' && typeof item.text === 'string' && item.text.startsWith('<chat>\n')) { inView = true; seenView = true; }
      if (!inView) delete item.cache_control;
      if (inView && typeof item.text === 'string' && item.text.includes('</chat>')) { delete item.cache_control; inView = false; }
    }
  }
  payload.cache_control = { type: 'ephemeral' };
  return payload;
}

/** OpenAI Responses: the same three view breakpoints, and reasoning kept across mid-run messages (recipe §8). */
export function openaiCachePayload(payload: unknown): unknown {
  if (!record(payload) || !Array.isArray(payload.input)) return payload;
  for (const item of payload.input) {
    if (!record(item) || !Array.isArray(item.content)) continue;
    const i = item.content.findIndex((block: unknown) => record(block) && block.type === 'input_text'
      && typeof block.text === 'string' && block.text.startsWith('<chat>\n'));
    if (i < 0) continue;
    const pieces = splitView(item.content[i].text);
    item.content.splice(i, 1, ...pieces.map((text, j) => ({ type: 'input_text', text,
      ...(j < pieces.length - 1 ? { prompt_cache_breakpoint: { mode: 'explicit' } } : {}) })));
    break;
  }
  if (record(payload.reasoning)) payload.reasoning = { ...payload.reasoning, context: 'all_turns' };
  return payload;
}

export function cacheFor(api: string | undefined, payload: unknown): unknown {
  if (api === 'anthropic-messages') return cachePayload(payload);
  if (api === 'openai-responses' || api === 'openai-codex-responses' || api === 'azure-openai-responses') return openaiCachePayload(payload);
  return payload;
}
