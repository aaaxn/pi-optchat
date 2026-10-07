import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { getCurrentSystemMessage, type SystemMessage, type UserMessage } from '@earendil-works/pi-ai';
import { CAP, cap, type Memory } from './memory.ts';
import { record } from './cache.ts';
import { DEFAULT_SETTINGS } from './settings.ts';

export const RUN_BOUNDARY = 'optchat.run';
/** Subagent traffic to the main agent: a custom message on screen, a plain user message to the model and memory. */
export const REPORT_TYPE = 'optchat-report';

export function textContent(content: unknown, images = true): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: unknown) => {
    if (typeof part !== 'object' || part === null) return '';
    if ('type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string') return part.text;
    if (images && 'type' in part && part.type === 'image') return '[image attachment: available in Pi session; text memory does not preserve image bytes]';
    return '';
  }).filter(Boolean).join('\n');
}
/** What the user typed, as Pi's input event (and so the inbox) saw it: no image placeholders, and without the
 * `[Image …]` notes Pi appends after the text when it resizes, converts or omits an attached image. */
export function typedText(content: unknown) {
  const text = textContent(content, false);
  return { text, bare: text.replace(/\n\n\[Image[ :][^\n]*\](?:\n\[Image[ :][^\n]*\])*$/, '') };
}
/** Pi's convertToLlm sends every custom message, another extension's too, to the model as a user message. Another
 * extension's starts with "[customType] ", as the recipe marks background work, so the compactor never takes it for the user's words. */
export function asUser(message: AgentMessage): AgentMessage {
  if (message.role !== 'custom') return message;
  const { content, customType } = message, tag = `[${customType}] `;
  return { role: 'user', timestamp: message.timestamp, content: customType === REPORT_TYPE ? content
    : typeof content === 'string' ? tag + content
    : content[0]?.type === 'text' ? [{ ...content[0], text: tag + content[0].text }, ...content.slice(1)]
    : [{ type: 'text', text: tag.trimEnd() }, ...content] };
}
export function logMessage(memory: Memory, message: AgentMessage, receipt?: string) {
  const date = new Date(message.timestamp).toISOString();
  if (message.role === 'user') memory.append('user', textContent(message.content), date, receipt);
  else if (message.role === 'assistant') {
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim()) memory.append('talk', block.text, date);
      if (block.type === 'toolCall') memory.append('tool', `${block.name} ${JSON.stringify(block.arguments)}`, date);
    }
    if (message.stopReason === 'error' || message.stopReason === 'aborted')
      memory.append('echo', `Agent ${message.stopReason}: ${message.errorMessage ?? 'No further details'}`, date);
  } else if (message.role === 'toolResult') memory.append('echo', cap(`${message.toolName}: ${textContent(message.content)}`), date);
}
export function boundedMessage(message: AgentMessage): AgentMessage {
  if (message.role !== 'toolResult') return message;
  const text = message.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (text.length <= CAP) return message;
  return { ...message, content: [{ type: 'text', text: cap(text) }, ...message.content.filter(c => c.type === 'image')] };
}
/** The caller supplies a single settled run, including any steering after text-only replies. */
function completedExchange(history: readonly AgentMessage[]) {
  const last = history.findLastIndex(m => m.role === 'user' || m.role === 'assistant');
  const answer = history[last];
  if (answer?.role !== 'assistant' || answer.stopReason !== 'stop'
    || answer.content.some(block => block.type === 'toolCall')) return [];
  const content = answer.content.flatMap(block => block.type === 'text' ? [{ type: 'text' as const, text: block.text }] : []);
  if (!content.some(block => block.text.trim())) return [];
  const requests: UserMessage[] = [];
  for (const message of history.slice(0, last)) {
    if (message.role === 'user') requests.push({ ...message, content: textContent(message.content) });
  }
  if (!requests.length) return [];
  return [...requests, { ...answer, content }];
}

/** Default limit in bytes of text (16 KB, ~4,000 tokens). Most exchanges are 1-7 KB; a larger one, usually a big paste, is
 * left out entirely and the model falls back to its summaries in the memory view, zooming for the full text if it needs it. */
export const PREVIOUS_EXCHANGE = DEFAULT_SETTINGS.previousExchangeKB * 1000;

/** The latest successful run on this branch, skipping failed and unfinished runs; none if it is over `limit` bytes. */
export function previousExchange(branch: readonly SessionEntry[], limit = PREVIOUS_EXCHANGE) {
  const exchange = latestExchange(branch);
  const bytes = exchange.reduce((sum, message) => sum + Buffer.byteLength(textContent(message.content)), 0);
  return bytes <= limit ? exchange : [];
}

function latestExchange(branch: readonly SessionEntry[]) {
  let end = -1;
  let legacyEnd = branch.length;
  const messages = (entries: readonly SessionEntry[]) => entries.flatMap(entry => entry.type === 'message' ? [asUser(entry.message)] : entry.type === 'custom_message' ? [asUser({ role: 'custom', customType: entry.customType, content: entry.content, display: entry.display, timestamp: Date.parse(entry.timestamp) })] : []);
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== 'custom' || entry.customType !== RUN_BOUNDARY || !record(entry.data)) continue;
    legacyEnd = i;
    if (entry.data.state === 'end') end = i;
    else if (entry.data.state === 'start') {
      if (end >= 0) {
        const exchange = completedExchange(messages(branch.slice(i + 1, end)));
        if (exchange.length) return exchange;
      }
      end = -1;
    }
  }
  // Older sessions have no run markers. Recover a successful exchange best-effort;
  // text-only steering boundaries cannot be reconstructed for those old runs.
  const legacy = messages(branch.slice(0, legacyEnd));
  let boundary = 0;
  let latest: ReturnType<typeof completedExchange> = [];
  for (let i = 0; i < legacy.length; i++) {
    const message = legacy[i];
    if (message.role !== 'assistant' || message.stopReason === 'toolUse') continue;
    const exchange = completedExchange(legacy.slice(boundary, i + 1));
    if (exchange.length) latest = exchange;
    boundary = i + 1;
  }
  return latest;
}

/** Keep one completed exchange plus the current run; all other history comes from the view. */
export function buildContext(canonical: AgentMessage[], run: AgentMessage[], view: string, prompt: string,
  previous: readonly AgentMessage[] = []): AgentMessage[] {
  const system = getCurrentSystemMessage(canonical);
  const head: SystemMessage = { role: 'system', content: prompt, toolsAdded: system?.toolsAdded, timestamp: 0 };
  if (!run.some(m => m.role === 'user')) throw new Error('OptChat has no current user message; refusing to send historical context.');
  let injected = false;
  const messages = [...previous, ...run].filter(m => m.role !== 'system').map(message => {
    if (message.role !== 'user' || injected) return message;
    injected = true;
    return { ...message, content: [{ type: 'text' as const, text: view }, ...(typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content)] };
  });
  return [head, ...messages];
}
