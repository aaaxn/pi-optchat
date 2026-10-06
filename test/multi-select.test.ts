import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { MultiSelect } from '../src/import/multi-select.ts';

test('long lists scroll past the first screen and Space preserves cursor and viewport', () => {
  let rows = 24;
  const completed: (number[] | undefined)[] = [];
  const picker = new MultiSelect({ title: 'Projects', labels: Array.from({ length: 150 }, (_, i) => `/project-${i}/${'long path '.repeat(20)}`),
    rows: () => rows, redraw: () => {}, done: value => completed.push(value), color: (_tone, text) => text });
  try {
    for (let i = 0; i < 75; i++) { picker.handleInput('\x1b[B'); picker.render(60); }
    const before = picker.render(60);
    assert.match(before.find(line => line.startsWith('→')) ?? '', /76\. \/project-75/);
    picker.handleInput(' ');
    const after = picker.render(60);
    assert.match(after.find(line => line.startsWith('→')) ?? '', /\[x\] 76\. \/project-75/);
    assert.equal(after.findIndex(line => line.startsWith('→')), before.findIndex(line => line.startsWith('→')));
    assert.equal(completed.length, 0, 'Space must not close the dialog');
    picker.handleInput('\x1b[F');
    assert.match(picker.render(60).find(line => line.startsWith('→')) ?? '', /150\. \/project-149/);
    picker.handleInput(' ');
    rows = 14;
    const resized = picker.render(36);
    assert.ok(resized.length <= rows - 5);
    assert.ok(resized.every(line => visibleWidth(line) <= 36));
    assert.match(resized.find(line => line.startsWith('→')) ?? '', /150\./);
    picker.handleInput('\r');
    assert.deepEqual(completed, [[75, 149]]);
  } finally { picker.dispose(); }
});

test('filtering keeps selections and bulk shortcuts apply only to matching rows', () => {
  const completed: (number[] | undefined)[] = [];
  const picker = new MultiSelect({ title: 'Projects', labels: ['work-api', 'personal', 'work-ui'], rows: () => 24,
    redraw: () => {}, done: value => completed.push(value), color: (_tone, text) => text });
  try {
    picker.handleInput('\x1b[B'); picker.handleInput(' '); // personal
    picker.handleInput('work'); picker.handleInput('\x01'); // Ctrl+A selects matching work rows
    assert.match(picker.render(80)[0], /3 selected/);
    picker.handleInput('\x04'); // Ctrl+D clears only matches
    assert.match(picker.render(80)[0], /1 selected/);
    picker.handleInput('\x15'); // Ctrl+U clears filter
    assert.ok(picker.render(80).some(line => line.includes('[x] 2. personal')));
    picker.handleInput('\x1b[6~'); // Page down reaches final row
    assert.match(picker.render(80).find(line => line.startsWith('→')) ?? '', /3\. work-ui/);
    picker.handleInput('\r'); assert.deepEqual(completed, [[1]]);
  } finally { picker.dispose(); }
});

test('empty selection stays open and shutdown abort closes a custom picker once', () => {
  const controller = new AbortController(), completed: (number[] | undefined)[] = [];
  const picker = new MultiSelect({ title: 'Projects', labels: ['project'], rows: () => 24, signal: controller.signal,
    redraw: () => {}, done: value => completed.push(value), color: (_tone, text) => text });
  picker.handleInput('\r');
  assert.equal(completed.length, 0);
  assert.ok(picker.render(80).some(line => line.includes('Select at least one')));
  controller.abort(); picker.handleInput('\r'); picker.dispose();
  assert.deepEqual(completed, [undefined]);
});

test('Space types into a non-empty filter, toggles on an empty one, and Tab always toggles', () => {
  const completed: (number[] | undefined)[] = [];
  const picker = new MultiSelect({ title: 'Projects', labels: ['my project', 'myproject', 'other'], rows: () => 24,
    redraw: () => {}, done: value => completed.push(value), color: (_tone, text) => text });
  try {
    for (const ch of 'my project') picker.handleInput(ch);
    const text = picker.render(80).join('\n');
    assert.match(text, /Filter: my project/);
    assert.match(text, /1\/1 matching/);
    assert.match(text, /\[ \] 1\. my project/);
    assert.match(text, /0 selected/);
    picker.handleInput('\t');
    assert.match(picker.render(80)[0], /1 selected/);
    picker.handleInput('\x15'); picker.handleInput('\x1b[B');
    picker.handleInput(' ');
    assert.match(picker.render(80)[0], /2 selected/);
    picker.handleInput('\t');
    assert.match(picker.render(80)[0], /1 selected/);
    picker.handleInput('\r');
    assert.deepEqual(completed, [[0]]);
  } finally { picker.dispose(); }
});
