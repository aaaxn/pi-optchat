import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from '../src/memory.ts';
import { exportBrowser } from '../src/browser.ts';

test('memory browser embeds escaped data and a script that compiles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-browser-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  try {
    memory.append('user', 'Hello </script><img src=x onerror=alert(1)> $& $1');
    memory.append('talk', 'Reply\nwith lines');
    const html = readFileSync(exportBrowser(memory, 'test'), 'utf8');
    const [, json] = html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/) ?? [];
    assert.ok(json && !json.includes('<'));
    const data: unknown = JSON.parse(json);
    assert.ok(typeof data === 'object' && data !== null && 'root' in data && Array.isArray(data.root));
    assert.equal(data.root[0].text, 'Hello </script><img src=x onerror=alert(1)> $& $1');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    assert.doesNotThrow(() => new Function(scripts[0][1]));
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});
