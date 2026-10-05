import { CustomEditor, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth, type KeyId } from '@earendil-works/pi-tui';
import type { Children } from './agents.ts';
import { inspectorShowing, type InspectorPage } from './inspector.ts';
import { isActiveRun } from './runs.ts';

/** Configured before extension registration; this also works in legacy terminals with F6. */
export function inspectorShortcut(value = process.env.OPTCHAT_INSPECT_KEY ?? 'f6'): KeyId {
  const parts = value.split('+'), base = parts.pop() ?? '';
  const special = ['escape', 'enter', 'return', 'tab', 'space', 'backspace', 'delete', 'insert', 'home', 'end', 'pageUp', 'pageDown', 'up', 'down', 'left', 'right'];
  if ((!/^[a-z0-9]$/.test(base) && !/^f([1-9]|1[0-2])$/.test(base) && !special.includes(base))
    || new Set(parts).size !== parts.length || parts.some(p => !['ctrl', 'alt', 'shift', 'super'].includes(p))) throw new Error('Invalid OPTCHAT_INSPECT_KEY. Example: f6 or ctrl+shift+a.');
  return value as KeyId;
}

export class BarNavigation {
  selected: InspectorPage | undefined;
  handle(data: string, empty: boolean, autocomplete: boolean, open: (page: InspectorPage) => void): boolean {
    if (!this.selected) {
      if (empty && !autocomplete && matchesKey(data, 'down')) { this.selected = 'agents'; return true; }
      return false;
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'up')) { this.selected = undefined; return true; }
    if (matchesKey(data, 'left') || matchesKey(data, 'right') || matchesKey(data, 'tab')) {
      this.selected = this.selected === 'agents' ? 'usage' : 'agents'; return true;
    }
    if (matchesKey(data, 'return')) { const page = this.selected; this.selected = undefined; open(page); return true; }
    if (matchesKey(data, 'down')) return true;
    this.selected = undefined; return false; // Typing naturally resumes editing.
  }
}

export function mountNavigation(ctx: ExtensionContext, children: Children, shortcut: string, open: (page: InspectorPage) => void) {
  const navigation = new BarNavigation();
  const previous = ctx.ui.getEditorComponent();
  let redraw = () => {};
  const factory: Parameters<typeof ctx.ui.setEditorComponent>[0] = (tui, theme, keys) => {
    class OptChatEditor extends CustomEditor {
      override handleInput(data: string) {
        if (navigation.handle(data, this.getText().length === 0, this.isShowingAutocomplete(), open)) { tui.requestRender(); return; }
        super.handleInput(data);
      }
    }
    return new OptChatEditor(tui, theme, keys);
  };
  // An existing custom editor owns its input rules; the shortcut remains available.
  if (!previous) ctx.ui.setEditorComponent(factory);
  ctx.ui.setWidget('optchat-agents', (tui, theme) => {
    redraw = () => tui.requestRender();
    return {
      invalidate() {},
      render(width: number) {
        if (inspectorShowing()) return []; // The open panel replaces the editor and this bar.
        const list = children.history.list(), running = list.filter(isActiveRun).length;
        const label = (page: InspectorPage, text: string) => navigation.selected === page ? theme.fg('accent', `› ${text}`) : theme.fg('muted', text);
        const left = `${label('agents', `Agents: ${running} running · ${list.length - running} saved`)}   ${label('usage', 'Usage')}`;
        const hint = theme.fg('dim', navigation.selected ? '←→ select · Enter open · Esc input' : `${previous ? '' : '↓ select · '}${shortcut} inspect`);
        const gap = width - visibleWidth(left) - visibleWidth(hint);
        return [truncateToWidth(gap >= 3 ? `${left}${' '.repeat(gap)}${hint}` : `${left}   ${hint}`, width)];
      },
    };
  }, { placement: 'belowEditor' });
  const unsubscribe = children.subscribe(() => redraw());
  return () => {
    unsubscribe(); ctx.ui.setWidget('optchat-agents', undefined);
    if (!previous && ctx.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(undefined);
  };
}
