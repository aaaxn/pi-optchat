import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { dataHome } from '../src/profiles.ts';

const print = 'console.log(JSON.stringify([process.env.HOME, process.env.OPTCHAT_HOME, process.env.PI_CODING_AGENT_DIR]))';
const run = (preload: string) => JSON.parse(spawnSync(process.execPath, ['--import', 'tsx', '--import', resolve(import.meta.dirname, preload), '-e', print], { encoding: 'utf8' }).stdout) as string[];
const under = (parent: string, path: string) => !relative(resolve(parent), resolve(path)).startsWith('..');

test('a test process reaches the home directory, OptChat data and Pi agent dir only through fresh temporary directories', () => {
  const dirs = { home: homedir(), optchat: dataHome(), pi: getAgentDir() };
  for (const [name, dir] of Object.entries(dirs)) {
    assert.ok(under(tmpdir(), dir) && resolve(dir) !== resolve(tmpdir()), `${name} resolves under ${tmpdir()}, not to ${dir}`);
    assert.ok(existsSync(dir), `${name} exists`);
  }
  assert.equal(new Set(Object.values(dirs)).size, 3, 'the three directories are distinct');
  assert.ok(process.execArgv.some(arg => arg.endsWith('support.ts')), 'the runner preloads test/support.ts into each test file\'s own process; run tests with `npm test`');
});

test('the directories are removed when the process exits and differ between processes', () => {
  const [first, second] = [run('support.ts'), run('support.ts')];
  for (const dir of [...first, ...second]) assert.ok(under(tmpdir(), dir) && !existsSync(dir), `${dir} was removed at exit`);
  assert.equal(new Set([...first, ...second]).size, 6, 'every process gets its own');
});

test('importing the test helpers alone is enough, so a single test file is isolated without --import', () => {
  const dirs = run('fakes.ts');
  for (const dir of dirs) assert.ok(under(tmpdir(), dir) && !existsSync(dir), `${dir} was removed at exit`);
});
