import { NODE } from './memory.ts';

/** Per-profile choices where OptChat departs from Victor's recipe. Each default is the recipe's behaviour unless noted. */
export const SETTINGS = {
  subagentLevels: { kind: 'number', label: 'Subagent levels', default: 1, min: 1, unit: '',
    description: 'How many levels of subagents. 1: only the main agent starts subagents, as in Victor\'s recipe. 2: those subagents may start their own, and so on.',
    applies: 'Applies to subagents started or resumed after this.' },
  maxAgents: { kind: 'number', label: 'Max active agents', default: 8, min: 1, unit: '',
    description: 'Subagents running at once in this profile, all levels together. It also caps how deep a chain can go.',
    applies: 'Applies to the next spawn.' },
  groupReports: { kind: 'toggle', label: 'Group subagent reports', default: true,
    description: 'On: the subagents started by one spawn report together, in one message once the last of them finishes, as in Victor\'s recipe. Off: each subagent reports as soon as it finishes.',
    applies: 'Applies to the next spawn.' },
  previousExchange: { kind: 'toggle', label: 'Previous exchange', default: true,
    description: 'Send your last request and its answer in full with the next turn, so a follow-up reads the exact wording. Off: memory view only, as in Victor\'s recipe. On by default: a study found it costs little and saves zooms.',
    applies: 'Applies from the next turn.' },
  previousExchangeKB: { kind: 'number', label: 'Previous exchange limit', default: 16, min: 1, unit: 'KB',
    description: 'A larger last exchange, usually a big paste, is left out and the model zooms into memory instead.',
    applies: 'Applies from the next turn.' },
  memorySearch: { kind: 'toggle', label: 'Memory search', default: false,
    description: 'Give agents a search tool that finds original messages by plain text, newest first, for exact names, numbers, paths or errors the view doesn\'t show. Off: zoom and date only, as in Victor\'s recipe. Turning it on or off makes the next turn re-cache its prompt once.',
    applies: 'Applies from the next turn, and to subagents started or resumed after this.' },
  summaryAcceptBytes: { kind: 'number', label: 'Summary size tolerance', default: NODE * 1.25, min: NODE, unit: 'bytes',
    description: `The compactor is always asked for ${NODE}-byte lines; a longer line up to this size is kept instead of retried. ${NODE}: strict, as in Victor's recipe. The default saves retries for a little more view space.`,
    applies: 'Applies to the next summary.' },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type Settings = { -readonly [K in SettingKey]: (typeof SETTINGS)[K]['default'] extends boolean ? boolean : number };
export type NumberKey = { [K in SettingKey]: Settings[K] extends number ? K : never }[SettingKey];
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export const isNumberKey = (key: SettingKey): key is NumberKey => SETTINGS[key].kind === 'number';

/** Why a value can't be used, or undefined if it can. Numbers are whole and at least their minimum. */
export function invalid(key: SettingKey, value: unknown) {
  if (isNumberKey(key)) { const { label, min } = SETTINGS[key]; return Number.isSafeInteger(value) && Number(value) >= min ? undefined : `${label} must be a whole number of ${min} or more.`; }
  return typeof value === 'boolean' ? undefined : `${SETTINGS[key].label} must be true or false.`;
}

/** Missing keys take their defaults, so config files written before a setting existed keep working. */
export function readSettings(value: Record<string, unknown>): Settings {
  return Object.fromEntries(SETTING_KEYS.map(key => {
    const raw = Object.hasOwn(value, key) ? value[key] : SETTINGS[key].default, problem = invalid(key, raw);
    if (problem) throw new Error(problem);
    return [key, raw];
  })) as Settings;
}
export const DEFAULT_SETTINGS = readSettings({});
