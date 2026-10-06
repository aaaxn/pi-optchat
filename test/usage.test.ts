import './support.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { emptyUsage, UsageLedger, summarizeUsage } from '../src/usage.ts';

test('usage keeps roles/sessions separate, includes caches, and survives replay and a torn legacy record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-usage-'));
  const now = Date.now();
  const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Done' }], api: 'anthropic-messages', provider: 'anthropic', model: 'test', stopReason: 'stop', timestamp: now,
    usage: { ...emptyUsage(), input: 10, output: 5, cacheRead: 100, cacheWrite: 20, totalTokens: 135, cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.03, total: 0.061 } } };
  try {
    writeFileSync(join(dir, 'usage.jsonl'), JSON.stringify({ date: new Date(now - 2 * 3600_000).toISOString(), role: 'compactor', model: 'old', usage: message.usage }) + '\n{"torn":');
    let ledger = new UsageLedger(dir);
    assert.equal(ledger.warnings.length, 1);
    const session = SessionManager.inMemory(); session.appendMessage(message);
    ledger.backfill(session.getEntries(), session.getSessionId());
    ledger.backfill(session.getEntries(), session.getSessionId());
    const child = SessionManager.inMemory(); child.appendMessage(message);
    ledger.backfill(child.getEntries(), session.getSessionId(), 'subagent', 'child-1');
    ledger.compression(message, 'import', session.getSessionId());
    assert.equal(ledger.entries.length, 4);
    const total = summarizeUsage(ledger.select('This session', session.getSessionId(), now + 1000));
    assert.equal(total.total.totalTokens, 405);
    assert.equal(total.total.cacheRead, 300);
    assert.equal(total.groups.length, 3);
    assert.ok(Math.abs(total.total.cost.total - 0.183) < 1e-9);
    assert.equal(ledger.select('Last hour', '', now + 1000).length, 3);
    assert.equal(ledger.select('All time', '', now + 1000).length, 4);
    assert.equal(ledger.select('This session', 'unrelated-session').length, 0);
    ledger = new UsageLedger(dir);
    ledger.backfill(session.getEntries(), session.getSessionId());
    assert.equal(ledger.entries.length, 4, 'old torn record must not swallow the next append, or replay duplicate it');
    appendFileSync(join(dir, 'usage.jsonl'), JSON.stringify({ date: new Date().toISOString(), role: 'main', model: 'bad', usage: { ...message.usage, input: -5 } }) + '\n');
    assert.equal(new UsageLedger(dir).entries.length, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Pi forks preserve usage identity instead of charging inherited messages twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-fork-usage-'));
  try {
    const manager = SessionManager.create(dir, dir), ledger = new UsageLedger(dir);
    const leaf = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Paid for once' }], api: 'anthropic-messages', provider: 'anthropic', model: 'test', stopReason: 'stop', timestamp: Date.now(), usage: { ...emptyUsage(), input: 100, totalTokens: 100 } });
    ledger.backfill(manager.getEntries(), manager.getSessionId());
    const forkFile = manager.createBranchedSession(leaf); assert.ok(forkFile);
    const fork = SessionManager.open(forkFile);
    ledger.backfill(fork.getEntries(), fork.getSessionId());
    assert.equal(ledger.entries.length, 1);
    assert.equal(summarizeUsage(ledger.entries).total.totalTokens, 100);
    assert.equal(ledger.select('This session', fork.getSessionId()).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recent ranges use local midnight and a rolling seven days without attributing legacy records to a session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-usage-'));
  const now = new Date(2026, 9, 5, 12).getTime();
  try {
    const ledger = new UsageLedger(dir);
    for (const hours of [1, 13, 100, 200]) ledger.add({ date: new Date(now - hours * 3600_000).toISOString(), role: 'compactor', model: 'test', usage: emptyUsage() });
    assert.equal(ledger.select('Today', 'x', now).length, 1);
    assert.equal(ledger.select('Last 7 days', 'x', now).length, 3);
    assert.equal(ledger.select('This session', 'x', now).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('All time keeps entries dated after now', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-usage-'));
  const now = Date.now();
  try {
    const ledger = new UsageLedger(dir);
    ledger.add({ id: 'future', date: new Date(now + 3600_000).toISOString(), role: 'main', model: 'test', session: 's', usage: emptyUsage() });
    assert.equal(ledger.select('All time', 's', now).length, 1);
    assert.equal(ledger.select('Last hour', 's', now).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('add rejects a record that a reload would reject, so totals match after a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-usage-'));
  const now = Date.now();
  try {
    const ledger = new UsageLedger(dir);
    const good = { ...emptyUsage(), totalTokens: 7, cost: { ...emptyUsage().cost, total: 0.5 } };
    ledger.add({ id: 'good', date: new Date(now).toISOString(), role: 'main', model: 'test', usage: good });
    ledger.add({ id: 'nan', date: new Date(now).toISOString(), role: 'main', model: 'test', usage: { ...good, cost: { ...good.cost, total: NaN } } });
    ledger.add({ id: 'negative', date: new Date(now).toISOString(), role: 'main', model: 'test', usage: { ...good, input: -1 } });
    ledger.add({ id: 'date', date: 'yesterday', role: 'main', model: 'test', usage: good });
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.warnings.length, 1);
    const live = summarizeUsage(ledger.select('All time', '', now)).total;
    const reloaded = new UsageLedger(dir);
    assert.deepEqual(summarizeUsage(reloaded.select('All time', '', now)).total, live);
    assert.deepEqual(reloaded.warnings, []);
    assert.equal(live.cost.total, 0.5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
