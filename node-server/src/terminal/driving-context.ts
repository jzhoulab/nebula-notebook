/**
 * Driving context — which notebook the user is currently viewing, per agent
 * terminal. Reported by the browser (notebook switch, tab focus, launch);
 * consumed by agents via `nebula context` (pull) and via a drift notice the
 * operation route attaches to results (push, at act time — the one channel
 * an agent cannot miss, so it never has to poll).
 *
 * In-memory by design: the browser re-reports on every focus/switch, so
 * state heals within seconds of a server restart.
 */

interface Driving {
  notebook: string;
  at: number;
  /** The driving notebook the agent has already been told about (or matched). */
  notifiedFor: string | null;
}

function ago(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  return `${m}m ago`;
}

class DrivingContext {
  private byTerminal = new Map<string, Driving>();

  setDriving(terminalId: string, notebook: string): void {
    if (!terminalId?.trim() || !notebook?.trim()) return;
    const existing = this.byTerminal.get(terminalId);
    if (existing && existing.notebook === notebook) return; // focus ping, not a switch
    this.byTerminal.set(terminalId, {
      notebook,
      at: Date.now(),
      notifiedFor: existing ? null : null,
    });
  }

  getDriving(terminalId: string): { notebook: string; at: number } | null {
    const d = this.byTerminal.get(terminalId);
    return d ? { notebook: d.notebook, at: d.at } : null;
  }

  /**
   * One-line drift notice when `targetNotebook` differs from what the user is
   * viewing — once per switch. Operations on the driving notebook re-arm the
   * notice (so a later switch away notifies again).
   */
  driftNotice(terminalId: string, targetNotebook: string): string | null {
    const d = this.byTerminal.get(terminalId);
    if (!d || !targetNotebook) return null;
    if (d.notebook === targetNotebook) {
      d.notifiedFor = null; // aligned — future switches notify again
      return null;
    }
    if (d.notifiedFor === d.notebook) return null; // already told about this switch
    d.notifiedFor = d.notebook;
    return (
      `note: the user is now viewing ${d.notebook} (switched ${ago(Date.now() - d.at)}); ` +
      `this operation targeted ${targetNotebook}. Keep going if your instruction named this ` +
      `notebook explicitly; if it said "this notebook/cell" without a path, it likely means ${d.notebook} — confirm before editing.`
    );
  }

  clear(): void {
    this.byTerminal.clear();
  }
}

export const drivingContext = new DrivingContext();
