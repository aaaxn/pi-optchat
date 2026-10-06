// Explicit opt-in live verification. Uses canned data in a disposable profile and real model calls.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import optchat from '../src/index.ts';
import { isView } from '../src/memory.ts';
import { createProfile, profilePath } from '../src/profiles.ts';

const home = mkdtempSync(join(tmpdir(), 'optchat-live-'));
process.env.OPTCHAT_HOME = home;
createProfile('smoke');
const registry = await ModelRuntime.create();
const model = registry.getModel('anthropic', 'claude-sonnet-5-5');
assert.ok(model);
const captured: AgentMessage[][] = [];
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: getAgentDir(), settingsManager,
  noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true,
  extensionFactories: [optchat, pi => {
    pi.on('context_with_system', event => { captured.push(structuredClone(event.messages)); });
  }],
});
await loader.reload();
const manager = SessionManager.inMemory(); manager.appendCustomEntry('optchat.profile', { name: 'smoke' });
const { session } = await createAgentSession({ modelRuntime: registry, model, thinkingLevel: 'medium',
  resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date', 'spawn', 'tell'],
});
let failed = false;
await session.bindExtensions({ onError: error => { failed = true; console.error('EXTENSION ERROR', error); } });
try {
  const first = 'Remember my fictional project password phrase: copper heron 814. Reply only ACK. ' + 'Background: this is a synthetic test of preserving original wording through summarized memory. '.repeat(12);
  await session.prompt(first);
  console.log('FIRST:', session.getLastAssistantText());
  const boundary = captured.length;
  await session.prompt('Use zoom to retrieve my exact original message and tell me the fictional password phrase.');
  console.log('SECOND:', session.getLastAssistantText());
  assert.match(session.getLastAssistantText() ?? '', /copper heron 814/i);
  assert.ok(JSON.stringify(captured[boundary]).includes(first), 'previous request missing from the next turn');
  assert.ok(captured[boundary].some(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(block => block.type === 'text' && isView(block.text))));
  assert.ok(session.messages.some(m => m.role === 'toolResult' && m.toolName === 'zoom'));
  await session.prompt('Spawn one background agent. Its only task is to use zoom to read memory message 0, then reply with the fictional password phrase. Do no filesystem work or web browsing. Return immediately after spawn and wait for its automatic report.');
  console.log('SPAWN:', session.getLastAssistantText());
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Subagent report did not arrive within 120 seconds')); }, 120_000);
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'agent_settled' && session.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('] ') && JSON.stringify(m.content).includes('copper heron 814'))) {
        clearTimeout(timeout); unsubscribe(); resolve();
      }
    });
  });
  console.log('REPORT:', session.getLastAssistantText());
  assert.equal(failed, false);
  const logDir = join(profilePath('smoke'), 'main');
  const log = readdirSync(logDir).map(n => readFileSync(join(logDir, n), 'utf8')).join('');
  assert.ok(log.includes('copper heron 814'));
  assert.ok(!log.includes('"kind":"thinking"'));
  console.log('PASS: real summary, exact zoom, fresh second-turn context, Opus child, automatic parent wake.');
} finally {
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  session.dispose();
  console.log('Live fixture:', home);
}
