/**
 * Renders the sbatch script that launches a Nebula client-server inside a job.
 *
 * The rendered job:
 *  - re-invokes this very Nebula install (same node binary + entry) with --client
 *    from the same working directory (all visible on the shared filesystem),
 *  - points it at the login-node main server,
 *  - carries a one-time allocation token so the main server can correlate the
 *    resulting registration back to this allocation.
 *
 * The client spawns its kernels locally (ZeroMQ on 127.0.0.1 on the compute
 * node); nothing here touches the kernel transport.
 */

import type { JobSpec } from './types';
import { formatWalltime, shellQuote } from './util';
import * as path from 'path';

export interface LaunchContext {
  /** URL the compute node uses to reach the main server, e.g. http://login:3000 */
  mainUrl: string;
  secret?: string;
  /** Absolute node binary path (shared FS), e.g. process.execPath */
  nodeBin: string;
  /** Node exec args, e.g. ['--import', 'tsx'] */
  execArgv: string[];
  /** Server entry script, e.g. process.argv[1] */
  scriptPath: string;
  /** Working directory to launch from (the nebula checkout) */
  cwd: string;
  /** Directory (on shared storage) for job scripts + logs */
  stateDir: string;
  /**
   * Per-arch runtime substitutions (node's process.arch keys, e.g. 'arm64')
   * for partitions whose CPU arch differs from this server's — see arch.ts.
   */
  archOverrides?: Record<string, { nodeBin: string; cwd: string; scriptPath: string }>;
  /** Arch of nodeBin itself. Defaults to process.arch; overridable for tests. */
  serverArch?: string;
}

export function renderJobScript(
  spec: JobSpec,
  ctx: LaunchContext,
  allocId: string,
  token: string,
): string {
  const walltime = formatWalltime(spec.walltimeMinutes);
  const launch = [ctx.nodeBin, ...ctx.execArgv, ctx.scriptPath, '--client']
    .map(shellQuote)
    .join(' ');

  const directives = [
    `#SBATCH --job-name=${spec.jobName}`,
    `#SBATCH --partition=${spec.partition}`,
    spec.qos ? `#SBATCH --qos=${spec.qos}` : null,
    spec.account ? `#SBATCH --account=${spec.account}` : null,
    `#SBATCH --cpus-per-task=${spec.cpus}`,
    `#SBATCH --mem=${spec.memGb}G`,
    spec.gpus ? `#SBATCH --gres=gpu:${spec.gpuType ? `${spec.gpuType}:` : ''}${spec.gpus}` : null,
    `#SBATCH --time=${walltime}`,
    `#SBATCH --output=${path.join(ctx.stateDir, `${allocId}.log`)}`,
  ].filter(Boolean).join('\n');

  const secretLine = ctx.secret
    ? `export NEBULA_CLUSTER_SECRET=${shellQuote(ctx.secret)}\n`
    : '';

  // PORT=0 → the client binds an ephemeral port and registers the *actual* bound
  // port with the main server (see index.ts client-registration wiring). Binding
  // 0.0.0.0 makes it reachable from the login node for the kernel proxy.
  return `#!/bin/bash
${directives}

cd ${shellQuote(ctx.cwd)}
export PATH=${shellQuote(path.dirname(ctx.nodeBin))}:"$PATH"
export NEBULA_MAIN_SERVER=${shellQuote(ctx.mainUrl)}
${secretLine}export NEBULA_ALLOCATION_TOKEN=${shellQuote(token)}
export NEBULA_SERVER_NAME=${shellQuote(spec.jobName)}
${spec.idleTimeoutMinutes ? `export NEBULA_IDLE_EXIT_MINUTES=${Math.floor(spec.idleTimeoutMinutes)}\n` : ''}export PORT=0
exec ${launch}
`;
}
