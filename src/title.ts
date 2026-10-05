/** Terminal tab titles: `● π personal · 2 agents`. */
const agents = (count: number) => count > 0 ? ` · ${count} ${count === 1 ? 'agent' : 'agents'}` : '';
export const mainTitle = (profile: string, working: boolean, running: number) => `${working ? '● ' : ''}π ${profile}${agents(running)}`;
/**
 * Pi writes its own "π - <cwd>" title after binding a session (startup, reload, profile switch) and on
 * session renames, so the last title is kept and re-applied at those points.
 */
export class TabTitle {
  private title: string | undefined;
  private set: ((title: string) => void) | undefined;
  show(set: (title: string) => void, title: string) {
    this.set = set;
    if (title === this.title) return;
    this.title = title; this.apply();
  }
  reapply() { this.apply(); }
  clear() { this.title = undefined; this.set = undefined; }
  private apply() {
    if (!this.title || !this.set) return;
    try { this.set(this.title); } catch { /* A ctx captured before a session replacement is stale; the next session sets its own. */ }
  }
}
