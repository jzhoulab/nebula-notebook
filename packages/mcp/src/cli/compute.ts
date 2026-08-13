/**
 * `nebula compute …` — scheduler-backed compute allocations (HPC clusters).
 *
 * Detection-gated: servers without a scheduler (laptops, plain workstations)
 * report enabled=false and every other subcommand fails fast with a clear
 * message. Same AXI conventions as the rest of the CLI: --json/--quiet,
 * one hint line, `--wait` FOLLOWS the allocation internally (the agent never
 * writes its own poll loop — the process exiting is the signal).
 */

import type {
  ComputeAllocation,
  ComputeSpec,
  NebulaClient,
} from '../notebook/client.js';
import {
  CliError,
  EXIT,
  makeClient,
  parse,
  parseIntFlag,
  printHint,
  printJson,
  requirePositional,
  resolveUrl,
  toCliError,
} from './shared.js';

const COMPUTE_HELP = `usage: nebula compute <status|queues|alloc|ls|use|cancel> …

Scheduler-backed compute (HPC clusters). Optional: servers without a
scheduler report "no scheduler on this server" — check status first.

  compute status                     scheduler present? enabled?
  compute queues                     partitions + QoS + idle CPUs/GPUs + backlog
  compute alloc --partition P [...]  request an allocation
      [--qos Q] [--cpus N] [--mem GB] [--gpus N] [--gpu-type T]
      [--walltime H] [--name NAME] [--idle-timeout MIN] [--wait] [--max-wait S]
      --idle-timeout MIN auto-ends the allocation after MIN minutes with no
      kernel or terminal activity (the node's server exits itself) — a safety
      net against forgotten allocations; recommended for agent-created ones.
      --wait BLOCKS until the allocation is active (internal polling; run it
      as a background shell task for long queue waits). Exit 1 on failure,
      exit 3 if --max-wait (default 3600s) expires while still queued.
  compute ls                         list allocations
  compute use <alloc-id|name> <notebook-path>
                                     bind the notebook's kernels to the
                                     allocation's server (must be active);
                                     after this, nebula run executes there
  compute cancel <id>                cancel an allocation (frees the nodes)

Etiquette: allocations consume real cluster resources — request modest sizes,
cancel what you created when done, never cancel allocations you didn't create,
and add --idle-timeout 60 as a safety net in case you forget.

examples:
  nebula compute queues
  nebula compute alloc --partition gpu --gpus 1 --walltime 2 --idle-timeout 60 --wait
  nebula compute use a1b2c3d4 analysis.ipynb
  nebula compute cancel a1b2c3d4`;

/** --wait polling: starts quick, backs off to ~5s (same philosophy as nebula run). */
const POLL_START_MS = 1_000;
const POLL_MAX_MS = 5_000;

const TERMINAL_STATES = new Set(['ended', 'failed', 'cancelled']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function cmdCompute(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === '--help' || sub === '-h') {
    console.log(COMPUTE_HELP);
    return sub === undefined ? EXIT.USAGE : EXIT.OK;
  }

  switch (sub) {
    case 'status':
      return computeStatus(rest);
    case 'queues':
      return computeQueues(rest);
    case 'alloc':
      return computeAlloc(rest);
    case 'ls':
      return computeLs(rest);
    case 'use':
      return computeUse(rest);
    case 'cancel':
      return computeCancel(rest);
    default:
      throw new CliError(`unknown compute subcommand: ${sub}`, EXIT.USAGE, "run 'nebula compute --help' for the list");
  }
}

function noScheduler(): CliError {
  return new CliError(
    'no scheduler on this server — compute allocations are unavailable',
    EXIT.ERROR,
    'kernels run directly on the server; check availability with: nebula compute status'
  );
}

// =============================================================================
// compute status
// =============================================================================

async function computeStatus(argv: string[]): Promise<number> {
  const { values } = parse(argv);
  if (values.help) {
    console.log(COMPUTE_HELP);
    return EXIT.OK;
  }
  const client = makeClient(resolveUrl(values.url));
  const result = await client.computeStatus();
  if (!result.success) throw toCliError(result.error);

  const { enabled, scheduler } = result.data!;
  if (values.json) {
    printJson(result.data);
    return EXIT.OK;
  }
  console.log(`enabled: ${enabled}`);
  console.log(`scheduler: ${scheduler ?? '-'}`);
  if (enabled) {
    printHint('see partitions and load with: nebula compute queues', values);
  } else {
    printHint('no scheduler here — notebooks execute directly on this server', values);
  }
  return EXIT.OK;
}

// =============================================================================
// compute queues
// =============================================================================

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function table(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => (r[col] ?? '').length)));
  return rows.map((r) => r.map((cell, col) => pad(cell ?? '', widths[col])).join('  ').trimEnd());
}

async function computeQueues(argv: string[]): Promise<number> {
  const { values } = parse(argv);
  if (values.help) {
    console.log(COMPUTE_HELP);
    return EXIT.OK;
  }
  const client = makeClient(resolveUrl(values.url));
  const result = await client.listPartitions();
  if (!result.success) throw toCliError(result.error);

  const data = result.data!;
  if (!data.enabled) throw noScheduler();

  if (values.json) {
    printJson(data);
    return EXIT.OK;
  }

  const allowed = new Set(data.associations?.partitions ?? []);
  const partitions = data.load?.partitions ?? [];
  // Only surface an ARCH column on heterogeneous clusters — kernels (and the
  // allocation client) only run on partitions matching an installed runtime.
  const showArch = partitions.some((p) => p.archs?.some((a) => a !== 'x86_64'));
  const rows: string[][] = [
    ['PARTITION', 'STATE', ...(showArch ? ['ARCH'] : []), 'TIMELIMIT', 'CPUS idle/tot', 'GPUS idle/tot (type)', 'PENDING', 'RUNNING'],
  ];
  for (const p of partitions) {
    rows.push([
      p.name + (allowed.size > 0 && !allowed.has(p.name) ? ' *' : ''),
      p.up ? 'up' : 'down',
      ...(showArch ? [p.archs?.join('+') ?? '?'] : []),
      p.timeLimit,
      `${p.cpus.idle}/${p.cpus.total}`,
      p.gpus?.length ? p.gpus.map((g) => `${g.idle}/${g.total} (${g.type})`).join(', ') : '-',
      String(p.jobs.pending),
      String(p.jobs.running),
    ]);
  }
  for (const line of table(rows)) console.log(line);
  if (allowed.size > 0 && partitions.some((p) => !allowed.has(p.name))) {
    console.log('(* = you cannot submit to this partition)');
  }

  const qoses = data.load?.qoses ?? [];
  if (qoses.length > 0) {
    console.log('');
    const qosRows: string[][] = [['QOS', 'PRIORITY', 'MAX WALL', 'PREEMPTIBLE', 'PENDING', 'RUNNING']];
    for (const q of qoses) {
      qosRows.push([
        q.name + (q.name === data.associations?.defaultQos ? ' (default)' : ''),
        String(q.priority),
        q.maxWall ?? '-',
        q.preemptible ? 'yes' : 'no',
        String(q.jobs.pending),
        String(q.jobs.running),
      ]);
    }
    for (const line of table(qosRows)) console.log(line);
  }

  printHint('request one with: nebula compute alloc --partition <P> [--wait]', values);
  return EXIT.OK;
}

// =============================================================================
// compute alloc
// =============================================================================

async function computeAlloc(argv: string[]): Promise<number> {
  const { values } = parse(argv, {
    partition: { type: 'string' },
    qos: { type: 'string' },
    cpus: { type: 'string' },
    mem: { type: 'string' },
    gpus: { type: 'string' },
    'gpu-type': { type: 'string' },
    walltime: { type: 'string' },
    name: { type: 'string' },
    'idle-timeout': { type: 'string' },
    wait: { type: 'boolean' },
    'max-wait': { type: 'string' },
  });
  if (values.help) {
    console.log(COMPUTE_HELP);
    return EXIT.OK;
  }
  const partition = typeof values.partition === 'string' ? values.partition : '';
  if (!partition) {
    throw new CliError('--partition is required', EXIT.USAGE, 'see available partitions with: nebula compute queues');
  }

  const spec: ComputeSpec = { partition };
  if (typeof values.qos === 'string') spec.qos = values.qos;
  if (values.cpus !== undefined) spec.cpus = parseIntFlag(values.cpus, '--cpus', 1);
  if (values.mem !== undefined) spec.memGb = parseIntFlag(values.mem, '--mem', 4);
  if (values.gpus !== undefined) spec.gpus = parseIntFlag(values.gpus, '--gpus', 0);
  if (typeof values['gpu-type'] === 'string') spec.gpuType = values['gpu-type'];
  if (values.walltime !== undefined) {
    const hours = Number(values.walltime);
    if (Number.isNaN(hours) || hours <= 0) {
      throw new CliError(`--walltime must be a positive number of hours, got "${String(values.walltime)}"`, EXIT.USAGE);
    }
    spec.walltimeMinutes = Math.round(hours * 60);
  }
  if (typeof values.name === 'string') spec.jobName = values.name;
  if (values['idle-timeout'] !== undefined) {
    const minutes = parseIntFlag(values['idle-timeout'], '--idle-timeout', 60);
    if (minutes <= 0) {
      throw new CliError(`--idle-timeout must be a positive number of minutes, got "${String(values['idle-timeout'])}"`, EXIT.USAGE);
    }
    spec.idleTimeoutMinutes = minutes;
  }

  const maxWait = parseIntFlag(values['max-wait'], '--max-wait', 3600);
  const client = makeClient(resolveUrl(values.url));

  // Fail fast with a friendly message when the server has no scheduler.
  const status = await client.computeStatus();
  if (status.success && !status.data!.enabled) throw noScheduler();

  const created = await client.createAllocation(spec);
  if (!created.success) throw toCliError(created.error);
  let alloc = created.data!;

  if (!values.wait) {
    if (values.json) {
      printJson(alloc);
      return EXIT.OK;
    }
    console.log(`allocation: ${alloc.id}`);
    console.log(`state: ${alloc.state}`);
    printHint(`follow with: nebula compute ls; when active: nebula compute use ${alloc.id} <notebook.ipynb>`, values);
    return EXIT.OK;
  }

  // --wait: FOLLOW the allocation until active or terminal. Internal polling
  // only — launch as a background shell task; process exit is the signal.
  const deadline = maxWait <= 0 ? Number.POSITIVE_INFINITY : Date.now() + maxWait * 1000;
  let pollMs = POLL_START_MS;
  while (alloc.state !== 'active' && !TERMINAL_STATES.has(alloc.state) && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    pollMs = Math.min(pollMs * 1.5, POLL_MAX_MS);
    try {
      const list = await client.listAllocations();
      if (list.success) {
        const found = list.data!.find((a) => a.id === alloc.id);
        if (found) alloc = found;
      }
    } catch {
      // transient network blip — keep following
    }
  }

  if (values.json) {
    printJson(alloc);
    return alloc.state === 'active' ? EXIT.OK : TERMINAL_STATES.has(alloc.state) ? EXIT.ERROR : EXIT.RUNNING;
  }

  console.log(`allocation: ${alloc.id}`);
  console.log(`state: ${alloc.state}`);
  if (alloc.state === 'active') {
    console.log(`server: ${alloc.serverId}`);
    console.log(`node: ${alloc.nodes?.join(',') || '-'}`);
    printHint(`bind a notebook to it with: nebula compute use ${alloc.id} <notebook.ipynb>`, values);
    return EXIT.OK;
  }
  if (TERMINAL_STATES.has(alloc.state)) {
    console.error(`error: allocation ${alloc.id} ${alloc.state}${alloc.reason ? ` (${alloc.reason})` : ''}`);
    return EXIT.ERROR;
  }
  printHint(`still ${alloc.state} after ${maxWait}s (exit 3); keep following with: nebula compute ls`, values);
  return EXIT.RUNNING;
}

// =============================================================================
// compute ls
// =============================================================================

async function computeLs(argv: string[]): Promise<number> {
  const { values } = parse(argv);
  if (values.help) {
    console.log(COMPUTE_HELP);
    return EXIT.OK;
  }
  const client = makeClient(resolveUrl(values.url));
  const result = await client.listAllocations();
  if (!result.success) throw toCliError(result.error);

  const allocations = result.data!;
  if (values.json) {
    printJson(allocations);
    return EXIT.OK;
  }
  if (allocations.length === 0) {
    console.log('(no allocations)');
    printHint('request one with: nebula compute alloc --partition <P> --wait', values);
    return EXIT.OK;
  }

  const rows: string[][] = [['ID', 'STATE', 'PARTITION', 'QOS', 'CPUS', 'MEM', 'GPUS', 'NODE', 'NAME']];
  for (const a of allocations) {
    rows.push([
      a.id,
      a.state,
      a.spec.partition,
      a.spec.qos ?? '-',
      String(a.spec.cpus),
      `${a.spec.memGb}G`,
      a.spec.gpus ? `${a.spec.gpus}${a.spec.gpuType ? ` (${a.spec.gpuType})` : ''}` : '-',
      a.nodes?.join(',') || '-',
      a.spec.jobName,
    ]);
  }
  for (const line of table(rows)) console.log(line);
  printHint('bind a notebook to an active one: nebula compute use <id> <notebook.ipynb>', values);
  return EXIT.OK;
}

// =============================================================================
// compute use
// =============================================================================

async function findAllocation(client: NebulaClient, idOrName: string): Promise<ComputeAllocation> {
  const result = await client.listAllocations();
  if (!result.success) throw toCliError(result.error);
  const allocations = result.data!;
  const found =
    allocations.find((a) => a.id === idOrName) ??
    allocations.find((a) => a.spec.jobName === idOrName);
  if (!found) {
    throw new CliError(`allocation not found: ${idOrName}`, EXIT.ERROR, 'list allocations with: nebula compute ls');
  }
  return found;
}

async function computeUse(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    kernel: { type: 'string' },
  });
  if (values.help) {
    console.log(COMPUTE_HELP);
    return EXIT.OK;
  }
  const usage = 'nebula compute use <alloc-id|name> <notebook-path>';
  const idOrName = requirePositional(positionals, 0, 'alloc-id|name', usage);
  const nbPath = requirePositional(positionals, 1, 'notebook-path', usage);

  const url = resolveUrl(values.url);
  const client = makeClient(url, nbPath);

  const alloc = await findAllocation(client, idOrName);
  if (alloc.state !== 'active' || !alloc.serverId) {
    throw new CliError(
      `allocation ${alloc.id} is not active (state: ${alloc.state}) — kernels need an active allocation`,
      EXIT.ERROR,
      alloc.state === 'pending' || alloc.state === 'running'
        ? `it is still coming up; check with: nebula compute ls`
        : `request a new one with: nebula compute alloc --partition ${alloc.spec.partition} --wait`
    );
  }

  const kernelName = typeof values.kernel === 'string' ? values.kernel : undefined;
  const bound = await client.getOrCreateKernelForFile(nbPath, kernelName, alloc.serverId);
  if (!bound.success) throw toCliError(bound.error, nbPath);

  if (values.json) {
    printJson({
      allocationId: alloc.id,
      serverId: alloc.serverId,
      sessionId: bound.data!.sessionId,
      kernelName: bound.data!.kernelName,
      path: nbPath,
    });
    return EXIT.OK;
  }
  console.log(`bound: ${nbPath} → allocation ${alloc.id} (server ${alloc.serverId})`);
  console.log(`session: ${bound.data!.sessionId} (${bound.data!.kernelName})`);
  printHint(`nebula run ${nbPath} <cell-id> now executes on the allocation; cancel it when done: nebula compute cancel ${alloc.id}`, values);
  return EXIT.OK;
}

// =============================================================================
// compute cancel
// =============================================================================

async function computeCancel(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv);
  if (values.help) {
    console.log(COMPUTE_HELP);
    return EXIT.OK;
  }
  const id = requirePositional(positionals, 0, 'id', 'nebula compute cancel <id>');
  const client = makeClient(resolveUrl(values.url));

  const result = await client.cancelAllocation(id);
  if (!result.success) {
    if (/not found/i.test(result.error ?? '')) {
      throw new CliError(`allocation not found: ${id}`, EXIT.ERROR, 'list allocations with: nebula compute ls');
    }
    throw toCliError(result.error);
  }

  if (values.json) {
    printJson({ cancelled: true, id });
    return EXIT.OK;
  }
  console.log(`cancelled: ${id}`);
  printHint('notebooks bound to it fall back to a new kernel on next use', values);
  return EXIT.OK;
}
