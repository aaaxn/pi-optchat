import './support.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpoint } from '../src/checkpoint.ts';

const tracked = (dir: string) => execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8' }).trim().split('\n');

test('a checkpoint writes the ignore file whenever it is missing, and never replaces one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-checkpoint-'));
  try {
    execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
    mkdirSync(join(dir, 'main'));
    writeFileSync(join(dir, 'main', 'a.jsonl'), '{}\n'); writeFileSync(join(dir, 'usage.jsonl'), '{}\n'); writeFileSync(join(dir, 'memory.html'), '<p>');
    await checkpoint(dir);
    assert.deepEqual(tracked(dir), ['.gitignore', 'main/a.jsonl']);
    writeFileSync(join(dir, '.gitignore'), '/mine/\n');
    await checkpoint(dir);
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), '/mine/\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
