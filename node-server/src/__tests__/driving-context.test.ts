// @vitest-environment node
/**
 * Driving context: which notebook the user is looking at, per agent terminal.
 * The browser reports it (notebook switch, tab focus); agents consume it two
 * ways — `nebula context` (pull, when interpreting "this notebook") and a
 * drift notice attached to operation results (push, at act time). The notice
 * fires ONCE per switch: no noise while the agent keeps legitimately working
 * on an explicitly named notebook.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { drivingContext } from '../terminal/driving-context';

const T = 'agent-abc-proj';

describe('drivingContext', () => {
  beforeEach(() => drivingContext.clear());

  it('stores and returns the driving notebook with a timestamp', () => {
    drivingContext.setDriving(T, '/w/nb1.ipynb');
    const d = drivingContext.getDriving(T)!;
    expect(d.notebook).toBe('/w/nb1.ipynb');
    expect(d.at).toBeGreaterThan(0);
    expect(drivingContext.getDriving('other')).toBeNull();
  });

  it('notices drift once per switch, then stays quiet', () => {
    drivingContext.setDriving(T, '/w/nb1.ipynb');
    expect(drivingContext.driftNotice(T, '/w/nb1.ipynb')).toBeNull(); // on target

    drivingContext.setDriving(T, '/w/nb2.ipynb'); // user switched
    const first = drivingContext.driftNotice(T, '/w/nb1.ipynb');
    expect(first).toContain('/w/nb2.ipynb');
    expect(first).toContain('/w/nb1.ipynb');
    // same switch, second op — quiet
    expect(drivingContext.driftNotice(T, '/w/nb1.ipynb')).toBeNull();
  });

  it('re-arms after the agent touches the driving notebook or the user switches again', () => {
    drivingContext.setDriving(T, '/w/nb2.ipynb');
    expect(drivingContext.driftNotice(T, '/w/nb1.ipynb')).not.toBeNull();
    // agent moves to the driving notebook → aligned
    expect(drivingContext.driftNotice(T, '/w/nb2.ipynb')).toBeNull();
    // user switches away again → a new notice is due
    drivingContext.setDriving(T, '/w/nb3.ipynb');
    expect(drivingContext.driftNotice(T, '/w/nb2.ipynb')).toContain('/w/nb3.ipynb');
  });

  it('re-reporting the SAME notebook is not a switch (focus ping) — no re-notice', () => {
    drivingContext.setDriving(T, '/w/nb2.ipynb');
    expect(drivingContext.driftNotice(T, '/w/nb1.ipynb')).not.toBeNull();
    drivingContext.setDriving(T, '/w/nb2.ipynb'); // focus event, same notebook
    expect(drivingContext.driftNotice(T, '/w/nb1.ipynb')).toBeNull();
  });

  it('is silent with no driving report at all (nothing to compare against)', () => {
    expect(drivingContext.driftNotice(T, '/w/nb1.ipynb')).toBeNull();
  });

  it('rejects garbage terminal ids and notebook paths', () => {
    drivingContext.setDriving('', '/w/nb1.ipynb');
    drivingContext.setDriving(T, '');
    expect(drivingContext.getDriving('')).toBeNull();
    expect(drivingContext.getDriving(T)).toBeNull();
  });
});
