import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainThread } from 'node:worker_threads';

// Worker threads inherit the flag and the environment, so only the main thread makes and removes the directories.
if (isMainThread) {
  const sandboxes = (['HOME', 'OPTCHAT_HOME', 'PI_CODING_AGENT_DIR'] as const).map(name => {
    const dir = mkdtempSync(join(tmpdir(), `optchat-${name.toLowerCase()}-`));
    process.env[name] = dir;
    return dir;
  });
  process.on('exit', () => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });
}
