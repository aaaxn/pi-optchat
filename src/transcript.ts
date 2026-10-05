import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { getCurrentSystemMessage, type SystemMessage } from '@earendil-works/pi-ai';
import { cap, type Memory } from './memory.ts';

export function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: unknown) => {
    if (typeof part !== 'object' || part === null) return '';
    if ('type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string') return part.text;
    if ('type' in part && part.type === 'image') return '[image attachment: available in Pi session; text memory does not preserve image bytes]';
    return '';
  }).filter(Boolean).join('\n');
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
  if (text.length <= 30_000) return message;
  return { ...message, content: [{ type: 'text', text: cap(text) }, ...message.content.filter(c => c.type === 'image')] };
}
/** Keep only the current run; all earlier history comes from the view. */
export function buildContext(canonical: AgentMessage[], run: AgentMessage[], view: string, prompt: string): AgentMessage[] {
  const system = getCurrentSystemMessage(canonical);
  const head: SystemMessage = { role: 'system', content: prompt, toolsAdded: system?.toolsAdded, timestamp: 0 };
  if (!run.some(m => m.role === 'user')) throw new Error('OptChat has no current user message; refusing to send historical context.');
  let injected = false;
  const messages = run.filter(m => m.role !== 'system').map(message => {
    if (message.role !== 'user' || injected) return message;
    injected = true;
    return { ...message, content: [{ type: 'text' as const, text: view }, ...(typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content)] };
  });
  return [head, ...messages];
}
