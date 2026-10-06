import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ModelChoice } from './compactor.ts';
import { record } from './cache.ts';
import { IMPORT_GUIDANCE } from './import/guidance.ts';

export const dataHome = () => resolve(process.env.OPTCHAT_HOME ?? join(homedir(), '.optchat'));
export interface ProfileConfig { compactor: ModelChoice; subagent: ModelChoice }
export const defaults: ProfileConfig = {
  compactor: { provider: 'anthropic', model: 'claude-sonnet-5-5', thinking: 'medium' },
  subagent: { provider: 'anthropic', model: 'claude-opus-5-5', thinking: 'high' },
};
export function profilePath(name: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error('Profile names: 1–64 lowercase letters, digits, hyphens, or underscores.');
  return join(dataHome(), 'profiles', name);
}
export function listProfiles() {
  const root = join(dataHome(), 'profiles');
  return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(f => f.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(f.name)).map(f => f.name).sort() : [];
}
export function atomicWrite(file: string, text: string) {
  mkdirSync(resolve(file, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  const fd = openSync(temporary, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  const parent = openSync(resolve(file, '..'), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
export function createProfile(name: string) {
  const dir = profilePath(name);
  if (existsSync(dir)) throw new Error(`Profile already exists: ${name}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  saveConfig(dir, defaults);
  atomicWrite(join(dir, 'AGENTS.md'), `# ${name}\n\nThis is the ${name} profile.\nAdd your personal instructions here.\n`);
}
export function saveConfig(dir: string, config: ProfileConfig) { atomicWrite(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n'); }
function modelChoice(value: unknown): value is ModelChoice {
  return record(value) && typeof value.provider === 'string' && typeof value.model === 'string'
    && typeof value.thinking === 'string' && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.thinking);
}
export function loadConfig(dir: string): ProfileConfig {
  const value: unknown = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  if (!record(value) || !modelChoice(value.compactor) || !modelChoice(value.subagent)) throw new Error(`Invalid profile config: ${dir}/config.json`);
  return { compactor: value.compactor, subagent: value.subagent };
}
export function instructions(dir: string) { return readFileSync(join(dir, 'AGENTS.md'), 'utf8'); }
export const agentInstructions = (dir: string) => `${instructions(dir)}\n\n${IMPORT_GUIDANCE}`;
export function lastProfile() {
  try { const name = readFileSync(join(dataHome(), 'last-profile'), 'utf8').trim(); return listProfiles().includes(name) ? name : undefined; }
  catch { return undefined; }
}
export function rememberProfile(name: string) { atomicWrite(join(dataHome(), 'last-profile'), name); }

export class ProfileBusyError extends Error {
  constructor(readonly owner: string) { super(`Profile already running: ${owner}`); }
}
/** Unix socket paths are limited by sun_path: 104 bytes on macOS, 108 on Linux, each including the final NUL. */
const SOCKET_PATH_MAX = 103;
export function profileSocket(dir: string) {
  const hash = createHash('sha256').update(dir).digest('hex').slice(0, 24);
  const path = join(tmpdir(), `pi-optchat-${process.getuid?.() ?? 'user'}-${hash}.sock`), length = Buffer.byteLength(path);
  if (length > SOCKET_PATH_MAX) throw new Error(`Cannot lock the profile: its socket path is ${length} bytes and the limit is ${SOCKET_PATH_MAX}. Set TMPDIR to a shorter directory: ${path}`);
  return path;
}

/** OS-owned socket lifetime, no timeout-based stealing of a busy profile. */
export async function lockProfile(dir: string, description: string) {
  const socketPath = profileSocket(dir);
  const server = createServer(socket => { socket.on('error', () => socket.destroy()); socket.end(description); });
  const listen = () => new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', failed); resolve(); };
    server.once('error', failed); server.once('listening', ready); server.listen(socketPath);
  });
  try { await listen(); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') throw error;
    const before = statSync(socketPath);
    const owner = await new Promise<string | undefined>((resolve, reject) => {
      const socket = createConnection(socketPath); let message = '';
      socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('Profile lock did not respond; refusing to steal it.')); });
      socket.on('data', data => { message += data.toString(); });
      socket.on('end', () => resolve(message || 'another Pi instance'));
      socket.on('error', e => { if ('code' in e && e.code === 'ECONNREFUSED') resolve(undefined); else reject(e); });
    });
    if (owner !== undefined) throw new ProfileBusyError(owner);
    if (statSync(socketPath).ino !== before.ino) throw new Error('Profile lock changed; try again.');
    unlinkSync(socketPath); await listen();
  }
  chmodSync(socketPath, 0o600);
  return () => new Promise<void>(resolve => server.close(() => resolve()));
}
