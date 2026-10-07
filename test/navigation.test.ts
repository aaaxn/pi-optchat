import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BarNavigation, inspectorShortcut } from '../src/navigation.ts';

test('agent-bar focus preserves typing, autocomplete, and ordinary history navigation', () => {
  const nav = new BarNavigation(), opened: string[] = [];
  const input = (data: string, empty = true, autocomplete = false) => nav.handle(data, empty, autocomplete, page => opened.push(page));
  assert.equal(input('\x1b[B', false), false, 'nonempty drafts retain Down');
  assert.equal(input('\x1b[B', true, true), false, 'autocomplete retains Down');
  assert.equal(input('\x1b[A'), false, 'Up retains input history');
  assert.equal(input('\x1b[B'), true);
  assert.equal(nav.selected, 'agents');
  input('\x1b[C'); input('\r');
  assert.deepEqual(opened, ['usage']); assert.equal(nav.selected, undefined);
  input('\x1b[B'); input('\x1b[D'); input('\r');
  assert.deepEqual(opened, ['usage', 'activity'], 'Left from Agents wraps to Activity');
  input('\x1b[B'); assert.equal(input('h'), false); assert.equal(nav.selected, undefined);
  input('\x1b[B'); assert.equal(input('\x1b'), true); assert.equal(nav.selected, undefined);
  assert.equal(inspectorShortcut('ctrl+shift+a'), 'ctrl+shift+a');
  assert.throws(() => inspectorShortcut('ctrl+ctrl+a'));
});
