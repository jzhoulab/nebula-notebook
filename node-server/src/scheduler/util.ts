/**
 * Small shared helpers for the scheduler module.
 */

/** Format minutes as a SLURM walltime string (`D-HH:MM:SS` or `HH:MM:SS`). */
export function formatWalltime(minutes: number): string {
  const total = Math.max(1, Math.floor(minutes));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  const hhmmss = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
  return d > 0 ? `${d}-${hhmmss}` : hhmmss;
}

/** POSIX single-quote a string so it is safe to embed in a shell script. */
export function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Compress a job log's tail into a one-line failure reason: the last few
 * non-empty lines (the error is at the end), capped so a pathological log
 * can't flood the UI. Null when there is nothing to say.
 */
export function summarizeLogTail(content: string): string | null {
  const lines = content
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  const joined = lines.slice(-3).join(' | ');
  return joined.length > 300 ? `…${joined.slice(-300)}` : joined;
}
