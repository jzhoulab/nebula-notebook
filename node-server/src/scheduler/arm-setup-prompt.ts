/**
 * Agent-executable ARM setup prompt.
 *
 * Setting up aarch64 compute support is a one-time, judgment-heavy HPC task
 * (storage policy, partition choice, whether compute nodes have internet) —
 * wrong shape for one-click automation, right shape for an agent. The server
 * contributes what it KNOWS (its own paths, node version, detected aarch64
 * partitions + required QOS, the env var names); the prompt tells the agent
 * to verify every step and finish with an end-to-end allocation proof.
 */

import * as path from 'path';
import type { Scheduler } from './types';
import type { LaunchContext } from './job-template';
import { normalizeArch } from './arch';

export interface ArmSetupFacts {
  configured: boolean;
  serverArch: string;
  nodeVersion: string;
  nodeBin: string;
  installDir: string;
  suggestedArmDir: string;
  suggestedArmNodeDir: string;
  armPartitions: { name: string; qos: string[] | null }[];
}

export async function gatherArmSetupFacts(
  scheduler: Scheduler,
  ctx: LaunchContext,
  serverArch: string = process.arch,
  nodeVersion: string = process.version,
): Promise<ArmSetupFacts> {
  const installDir = path.dirname(ctx.cwd); // ctx.cwd is <checkout>/node-server
  const armPartitions: ArmSetupFacts['armPartitions'] = [];
  try {
    const load = await scheduler.load();
    for (const p of load.partitions) {
      // Homogeneous partitions whose arch differs from the server's. Mixed or
      // unknown partitions are skipped — no safe pick exists (see arch.ts).
      if (p.archs?.length === 1 && normalizeArch(p.archs[0]) !== normalizeArch(serverArch)) {
        let qos: string[] | null = null;
        try { qos = await scheduler.allowedQos(p.name); } catch { /* optional */ }
        armPartitions.push({ name: p.name, qos });
      }
    }
  } catch { /* scheduler unavailable — prompt degrades to placeholders */ }

  return {
    configured: Boolean(ctx.archOverrides?.arm64),
    serverArch,
    nodeVersion,
    nodeBin: ctx.nodeBin,
    installDir,
    suggestedArmDir: `${installDir}-arm64`,
    // <prefix>/bin/node -> sibling <prefix>-arm64
    suggestedArmNodeDir: `${path.dirname(path.dirname(ctx.nodeBin))}-arm64`,
  armPartitions,
  };
}

export function buildArmSetupPrompt(f: ArmSetupFacts): string {
  const part = f.armPartitions[0];
  const partName = part?.name ?? '<arm-partition>';
  const qosFlag = part?.qos?.length ? ` --qos=${part.qos[0]}` : '';
  const partitionList = f.armPartitions.length
    ? f.armPartitions.map((p) => `${p.name}${p.qos?.length ? ` (requires --qos, one of: ${p.qos.join(', ')})` : ''}`).join('; ')
    : '<arm-partition> (none auto-detected — ask the user, or check `sinfo` + `scontrol show node` Arch= fields)';
  const armNodeBin = `${f.suggestedArmNodeDir}/bin/node`;

  return `You are enabling aarch64 (ARM) compute allocations for an existing Nebula Notebook server on an HPC cluster. Nebula re-launches its own install on compute nodes, so ARM partitions need an arm64 Node.js runtime and an arm64-installed copy of the checkout, both on shared storage. Work on the SERVER (where the Nebula server process runs). VERIFY each step before the next; when a step fails, diagnose it — do not skip. Ask the user only for genuinely missing facts (e.g. storage policy).

FACTS about this installation (real values, verified by the server):
- Server CPU arch: ${f.serverArch}; Node ${f.nodeVersion} at ${f.nodeBin}
- Nebula checkout: ${f.installDir}
- ARM partitions detected: ${partitionList}
- Env vars the server reads at startup: NEBULA_ARM64_NODE_BIN, NEBULA_ARM64_DIR

STEPS:
1. Confirm ${f.installDir} is on storage the compute nodes share (e.g. \`df -h\` / ask the user). Plan sibling paths: ${f.suggestedArmNodeDir} and ${f.suggestedArmDir} (or wherever policy dictates — same filesystem).
2. arm64 Node runtime: download https://nodejs.org/dist/${f.nodeVersion}/node-${f.nodeVersion}-linux-arm64.tar.xz, extract so ${armNodeBin} exists. Verify with \`file ${armNodeBin}\` (must say aarch64/ARM). Do NOT try to run it on this ${f.serverArch} machine.
3. Second checkout: \`git clone ${f.installDir} ${f.suggestedArmDir}\`, then set its origin to the same remote as the source checkout.
4. Install server deps ON an ARM node — native modules must be arm64 builds:
   srun -p ${partName}${qosFlag} --time=30 --mem=8G -c4 bash -c 'export PATH=${f.suggestedArmNodeDir}/bin:$PATH && cd ${f.suggestedArmDir}/node-server && npm install --no-audit --no-fund && node -e "require(\"zeromq\"); require(\"better-sqlite3\"); require(\"@homebridge/node-pty-prebuilt-multiarch\"); console.log(\"native modules ok\")"'
   The final line MUST print "native modules ok". If compute nodes have no internet, tell the user — an npm mirror or admin help is needed; do not fake arm64 installs from this ${f.serverArch} machine.
5. Build the workspace dependency (pure TypeScript, any arch works): \`cd ${f.suggestedArmDir}/packages/autocomplete && npm install && npm run build\` and verify dist/index.js exists.
6. Configure the server: set NEBULA_ARM64_NODE_BIN=${armNodeBin} and NEBULA_ARM64_DIR=${f.suggestedArmDir} in the environment the Nebula server launches with (its launcher script / service unit — find how it is started), then restart it and verify /api/health answers.
7. END-TO-END PROOF: \`nebula compute alloc --partition ${partName}${qosFlag ? ` --qos ${part!.qos![0]}` : ''} --cpus 1 --mem 4 --walltime 30 --idle-timeout 10 --wait\` must reach state: active. Cancel it afterwards (\`nebula compute cancel <id>\`). If it fails, read the allocation's reason — it carries the job log tail.
8. Kernels on ARM nodes also need an aarch64 Python with ipykernel (x86_64 conda envs will not run there). Create one on shared storage via srun on the ARM node (e.g. \`/usr/bin/python3 -m venv <shared>/envs/arm64-py && <shared>/envs/arm64-py/bin/pip install ipykernel\`), verify the import, and tell the user to pick it via "Enter interpreter path" (env:<path>) for notebooks bound to ARM allocations.

Report at the end: what was installed where, the allocation id that went active, and anything you had to decide or could not verify.`;
}
