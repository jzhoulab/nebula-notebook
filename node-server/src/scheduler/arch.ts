/**
 * Multi-arch launch support for compute allocations.
 *
 * An allocation re-launches THIS Nebula install on the compute node, so the
 * node binary and node_modules must match the compute node's CPU arch. On
 * heterogeneous clusters (CRI: x86_64 login nodes, aarch64 ghq/pearsonq) a
 * per-arch runtime is configured via env:
 *
 *   NEBULA_ARM64_NODE_BIN=/shared/node22-arm64/bin/node
 *   NEBULA_ARM64_DIR=/shared/nebula-notebook-arm64   # checkout with arm64 node_modules
 *
 * Both must live on storage the compute nodes share with the login node.
 */

import * as path from 'path';
import type { LaunchContext } from './job-template';

/** SLURM spellings (uname -m) → node's process.arch identifiers. */
export function normalizeArch(raw: string): string {
  const a = (raw || '').trim().toLowerCase();
  if (a === 'x86_64' || a === 'amd64' || a === 'x64') return 'x64';
  if (a === 'aarch64' || a === 'arm64') return 'arm64';
  return a;
}

const CONFIGURABLE_ARCHES = ['arm64', 'x64'] as const;

/**
 * Read per-arch runtime overrides from the environment. An arch is configured
 * only when BOTH its vars are present — a node binary without its matching
 * node_modules tree (or vice versa) would just fail later and worse.
 */
export function archOverridesFromEnv(
  env: Record<string, string | undefined> = process.env
): NonNullable<LaunchContext['archOverrides']> {
  const overrides: NonNullable<LaunchContext['archOverrides']> = {};
  for (const arch of CONFIGURABLE_ARCHES) {
    const prefix = `NEBULA_${arch.toUpperCase()}_`;
    const nodeBin = env[`${prefix}NODE_BIN`]?.trim();
    const dir = env[`${prefix}DIR`]?.trim();
    if (!nodeBin || !dir) continue;
    overrides[arch] = {
      nodeBin,
      cwd: path.join(dir, 'node-server'),
      scriptPath: path.join(dir, 'node-server', 'src', 'index.ts'),
    };
  }
  return overrides;
}

/**
 * Pick the launch context for a partition's arch: the server's own install
 * when arches match (or the arch is unknown — the status quo), the configured
 * override when they differ, and a loud, actionable refusal otherwise. The
 * refusal is the point: without it the job dies on the compute node with
 * "Exec format error" in a log nobody reads.
 */
export function pickLaunchContext(
  ctx: LaunchContext,
  targetArchRaw: string | null,
  serverArch: string = process.arch // undefined → the running process's arch
): LaunchContext {
  if (!targetArchRaw) return ctx;
  const target = normalizeArch(targetArchRaw);
  if (target === normalizeArch(serverArch)) return ctx;

  const override = ctx.archOverrides?.[target];
  if (!override) {
    const prefix = `NEBULA_${target.toUpperCase()}_`;
    throw new Error(
      `this partition runs ${targetArchRaw} nodes but this Nebula server is ${serverArch} — ` +
      `its runtime cannot execute there. Install a ${targetArchRaw} Node.js and Nebula checkout ` +
      `on shared storage and set ${prefix}NODE_BIN and ${prefix}DIR on the server.`
    );
  }
  return {
    ...ctx,
    nodeBin: override.nodeBin,
    cwd: override.cwd,
    scriptPath: override.scriptPath,
    // Never let a client restart itself mid-job on a source change.
    execArgv: ctx.execArgv.filter((a) => a !== '--watch'),
  };
}
