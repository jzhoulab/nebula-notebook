# Scheduler-backed compute (SLURM) — design

Run notebook kernels inside scheduler jobs on compute nodes, while the Nebula
server stays on the login node. Optimized for the common HPC workflow (server on a
login node, notebooks on a shared filesystem, compute runs only via submitted
jobs), but additive: setups without a scheduler are unchanged.

## Decisions (locked)

1. **Allocation granularity:** one job hosts **many** kernels. A submitted job is
   a *compute allocation* — a Nebula compute-server running on the allocated
   node(s) for the job's walltime; you queue once and run several notebooks'
   kernels inside it.
2. **Scheduler scope:** a **pluggable** `Scheduler` interface, **SLURM first**
   (`sbatch`/`squeue`/`scancel`/`sinfo`); PBS/LSF/etc. added later without touching
   the core.
3. **Transport:** **auto-probe** — prefer direct compute↔login HTTP; fall back to
   a login-node-managed **SSH tunnel** to the compute node. Probed at job start.

## Core idea — reuse the cluster model, don't fight the kernel path

Nebula already runs kernels on other machines: a `--client` server spawns the
kernel **locally** (ZeroMQ on `127.0.0.1`, `kernel-service.ts:635`), registers
with the main server over HTTP (`/api/servers/register`), and the main server
bridges browser⇄kernel I/O with a WebSocket proxy (`kernel-proxy.ts:320`).
ZeroMQ never crosses the network.

A SLURM allocation is just **that client-server, launched by the scheduler inside
a job** instead of by hand:

```
  browser ──WS/HTTP──► main server (login node)
                          │  submits sbatch, tracks squeue, proxies kernels
                          │
              register + heartbeat (compute→login)   ▲
                          ▼                           │  kernel-proxy WS (login→compute)
             ┌───────────────────────────────────────┴─────────┐
             │  SLURM job on compute node                       │
             │    nebula --client --main-server=…               │
             │      └─ spawns kernels locally (ZeroMQ 127.0.0.1)│
             └──────────────────────────────────────────────────┘
```

Consequence: **the allocation appears in the existing "Server" section of the
kernel menu** (`Notebook.tsx:3964`). The user picks it like any other server; the
kernel-start / interrupt / restart / WS paths are the ones that already work
(`kernel-proxy.ts`). We add scheduler lifecycle *around* servers, not a new kernel
launcher. `kernel-service.ts` is essentially untouched.

Rejected alternative: a per-kernel `KernelProvider` at `kernel-service.ts:532`
that `sbatch`es one job per kernel. It forces ZeroMQ across nodes (or 5-port
tunnels per kernel), re-queues per notebook, and rewrites the load-bearing kernel
path. The allocation model avoids all three.

## New components

All new code is main-server-side + a job script; the client-server reuses
existing `--client` mode.

### 1. `Scheduler` interface + `SlurmScheduler`  (`node-server/src/scheduler/`)

```ts
interface Scheduler {
  readonly name: string;                       // "slurm"
  detect(): Promise<boolean>;                  // sbatch+squeue on PATH?
  associations(user: string): Promise<Associations>;   // sacctmgr → allowed partitions/QoS + default
  load(): Promise<QueueLoad>;                   // sinfo+squeue+sacctmgr → per-partition/-QoS busyness
  estimateStart(spec: JobSpec): Promise<StartEstimate>;// sbatch --test-only (no submit)
  submit(spec: JobSpec): Promise<{ jobId: string }>;   // sbatch
  query(jobId: string): Promise<JobStatus>;    // squeue/sacct → state + node(s)
  cancel(jobId: string): Promise<void>;        // scancel
}
type JobState = 'pending' | 'running' | 'completing' | 'completed' | 'failed' | 'cancelled';
interface JobStatus { state: JobState; nodes: string[]; reason?: string; }
interface StartEstimate { startsAt?: string; nodes?: string[]; reason?: string; }  // from --test-only
interface JobSpec {
  partition: string; qos?: string; account?: string;
  cpus: number; memGb: number; gpus?: number;
  walltimeMinutes: number; jobName: string;
  script: string;                              // rendered sbatch body
}
```

`SlurmScheduler` shells out (`sbatch --parsable`, `squeue -h -j <id> -O State,NodeList`,
`scancel`, `sinfo -h -o '%P %l %c %m %G'`). Detection is capability-based
(design philosophy: **detect + guide**, never assume) — no `sbatch`, no SLURM UI.

### 2. Allocation manager  (`node-server/src/scheduler/allocation-service.ts`)

Owns the lifecycle the registry doesn't know about (queued/pending state that
precedes registration):

- `create(spec)` → render sbatch script (§3), `scheduler.submit`, persist an
  `Allocation { id, jobId, token, state, resources, createdAt, serverId? }`,
  return it. It surfaces immediately as a **pending server** in the UI.
- Poll `scheduler.query(jobId)` (≈10 s) → drive `pending → running → ended`.
- On the client-server's registration, **correlate by one-time `token`**
  (embedded in the job env, echoed in the register payload) → bind `serverId` to
  the allocation. Extends `PeerServer` (`server-registry.ts:12`) with
  `allocationId?`, `jobId?`, `schedulerState?`, `walltimeEndsAt?`.
- `cancel(id)` → `scancel`; on job end / heartbeat-timeout mark ended, evict the
  server, notify the UI (kernels on it flip to dead — existing dead-kernel path).

Persist allocations to the existing SQLite store (`session-store.ts`) so they
survive a dev-server restart and can be reconciled against `squeue` on boot.

### 3. sbatch job script  (rendered from a template)

```bash
#!/bin/bash
#SBATCH --job-name={{jobName}}
#SBATCH --partition={{partition}}
#SBATCH --cpus-per-task={{cpus}}
#SBATCH --mem={{memGb}}G
{{#gpus}}#SBATCH --gres=gpu:{{gpus}}{{/gpus}}
#SBATCH --time={{walltime}}
#SBATCH --output={{rootDir}}/.nebula/allocations/{{allocId}}.log

source {{nodeEnvActivate}}                 # node runtime on the shared filesystem
export NEBULA_MAIN_SERVER={{mainUrl}}      # http://<login-host>:<port>
export NEBULA_CLUSTER_SECRET={{secret}}    # or pre-shared ~/.nebula/cluster.json
export NEBULA_ALLOCATION_TOKEN={{token}}   # correlation
export NEBULA_SERVER_NAME="{{partition}} · {{gpus}}gpu · {{walltime}}"
export PORT=0                              # pick a free port
exec node {{nebulaEntry}} --client         # existing client mode
```

A shared filesystem means the same node env, nebula checkout, and the user's
Python envs (with `ipykernel`) are visible on the compute node; kernelspec
discovery (`kernelspec.ts`) works unchanged there.

### 4. Transport auto-probe + SSH fallback

The cluster model needs **both** directions: compute→login (register/heartbeat)
and login→compute (kernel proxy to the client's URL).

- **Direct (Phase 1, the common case):** client registers its real
  `computeNode:port`; on receiving the registration the main server does a health
  `GET` to that URL to confirm login→compute reachability. If both hold, done.
- **SSH fallback (Phase 2):** if either direction fails, the **main server** (on
  the login node, which can `ssh <computenode>`) opens one tunnel with `-L` (reach
  the client's HTTP/WS port) and `-R` (client reaches the main server), and
  rewrites the registry URL to the local forwarded port. Port rendezvous via a
  shared-fs file `{{rootDir}}/.nebula/allocations/{{allocId}}.json` (client writes
  its chosen port + node; main writes back the resolved transport). No inbound
  firewall change required — only `ssh login→compute`, which HPC usually allows.

`extraSSHOptions`/known-hosts handled like existing tunnels. Client binds loopback
only in fallback mode (safer on shared compute nodes); binds routable IP in direct
mode, protected by the cluster secret (`auth-middleware.ts:100`).

### 5. Frontend  (`components/`)

Minimal, because allocations reuse the Server section:

- **"+ New compute allocation"** entry in the kernel menu's Server area
  (`Notebook.tsx:3964`) opens a modal: **partition + QoS** (only the ones the user
  may actually use — from `associations()`), cpus, mem, gpus, walltime, optional
  account. Presets (e.g. "GPU", "Quick CPU", "Big memory") over a raw form. A live
  **load panel** (next section) sits beside the fields, and once resources are set
  a "**would start ≈ HH:MM**" line from `estimateStart()` updates as you tweak them.
- Pending/queued servers render in the same list with a **queue state**
  ("Queued · waiting…", live elapsed) instead of a green dot; becomes a normal
  online server once registered. Reuses `clusterService.getClusterInfo`
  (`clusterService.ts:64`) + a light poll for scheduler state.
- Row actions: **Cancel allocation** (`scancel`), show job id / walltime remaining.
- New service `computeService` → `POST /api/compute/allocations`,
  `GET /api/compute/allocations`, `DELETE /api/compute/allocations/:id`,
  `GET /api/compute/partitions`.

## Queue & QoS selection + load monitor

Picking a partition/QoS blind is guesswork, so the launcher surfaces (a) only the
queues/QoS the user may use, and (b) how busy each is, right at decision time.

**Allowed set** — `associations(user)` parses `sacctmgr -nP show assoc user=<u>`
(+ `scontrol show partition` for AllowAccounts/AllowGroups) → the partitions and
QoS the account can submit to, and the default QoS. The form offers only these, so
you never submit something the scheduler will reject.

```ts
interface Associations { account: string; partitions: string[]; qoses: string[]; defaultQos: string; }
```

**Load snapshot** — `load()` aggregates cheap cluster-wide calls (cached ~15–30 s
server-side; the browser polls the cache):

```ts
interface QueueLoad { partitions: PartitionLoad[]; qoses: QosLoad[]; fetchedAt: number; }
interface PartitionLoad {
  name: string; up: boolean; timeLimit: string; allowed: boolean;
  cpus: { alloc: number; idle: number; total: number };
  gpus?: { type: string; alloc: number; idle: number; total: number };
  nodes: { idle: number; mixed: number; alloc: number; down: number };
  jobs: { pending: number; running: number };
}
interface QosLoad {
  name: string; priority: number; maxWall?: string; maxGpusPerUser?: number;
  preemptible: boolean; allowed: boolean; myRunning: number; myPending: number;
}
```
- Partition CPUs/GPUs/node-states: `sinfo -h -o "%P %a %l %C %G %D %t"`.
- Queue depth per partition **and** QoS: `squeue -h -r -o "%P|%q|%t|%u"` aggregated
  → pending/running counts, with *your own* jobs called out.
- QoS priority/limits/preemption: `sacctmgr -nP show qos`.

**Estimated start** — the single most useful signal. `estimateStart(spec)` runs
`sbatch --test-only …`, which returns *"Job would start at <time> on <nodes>"*
**without submitting**. The modal shows a live "would start ≈ HH:MM" as you change
partition/QoS/resources, so you can trade a long queue for a lighter one before
committing.

**UI** — a compact, sortable table in the modal (and optionally a standalone
"Cluster load" panel): each row a partition with an idle-capacity bar (idle CPUs;
idle GPUs by type), queue backlog (▲pending / ●running, your jobs highlighted), and
node health; a QoS picker showing priority / max-wall / GPU cap / preemptible, with
disallowed entries greyed. Sort by idle capacity or backlog to spot the fast lane.

## Kernel flow inside an allocation

Unchanged from today's remote-server path: user picks the allocation's server →
`getOrCreateKernelForFile(file, kernel, serverId)` (`Notebook.tsx:2652`) →
`kernel-proxy` starts/bridges the kernel on the compute node. **Many kernels per
allocation** falls out for free — it's just multiple kernels on one client-server,
bounded by the job's cpus/mem/gpus.

## Config & security

- Cluster secret already gates registration + proxy (`X-Nebula-Cluster-Secret`).
  Reuse `~/.nebula/cluster.json` on the shared filesystem so jobs need no secret
  in env.
- Scheduler settings in `.nebula-config.json`: `scheduler.kind`, default account,
  node-env activate path, nebula entry path, walltime cap, allowed partitions.
- Detection-gated: no scheduler → feature hidden; guide text if `sbatch` missing.

### Multi-arch clusters (aarch64 partitions)

An allocation re-launches this very Nebula install on the compute node, so the
node binary and native modules must match the node's CPU arch. Partitions whose
`scontrol` `Arch=` differs from the server's (`scheduler/arch.ts`) launch a
per-arch runtime configured via env on the main server:

```bash
export NEBULA_ARM64_NODE_BIN=/shared/node22-arm64/bin/node
export NEBULA_ARM64_DIR=/shared/nebula-notebook-arm64   # second checkout
```

Setting up the arm64 checkout (one-time, on shared storage):

1. Download the linux-arm64 Node.js tarball next to the x86 one.
2. `git clone` the repo to `<DIR>`; run `npm install` in `<DIR>/node-server`
   **on an arm node** (e.g. `srun -p <arm-partition> …`) so the native modules
   (zeromq, better-sqlite3, node-pty, esbuild) get arm64 builds.
3. Build the workspace dep once: `cd <DIR>/packages/autocomplete && npm install
   && npm run build` (pure tsc — any arch can run this).

Without the env vars, submitting to a cross-arch partition fails fast at
submit with the fix named — never with an "Exec format error" in the job log.
Mixed-arch partitions resolve to null (treated as the server's arch). Kernels
on arm allocations additionally need aarch64 Python environments — x86_64
conda envs hit the same Exec format error.

## Lifecycle & failure handling

| Event | Behavior |
|---|---|
| Job queued | Allocation `pending`; UI shows "waiting in queue", cancelable. |
| Job starts | Client registers (≤ a few s after `RUNNING`); becomes online server. |
| Walltime near end | Warn in UI (from `walltimeEndsAt`); offer resubmit. |
| Walltime hit / `scancel` | Job dies → heartbeat stops → server evicted → kernels dead. |
| Node failure | `query` returns failed/none → allocation `failed`, surfaced. |
| Dev-server restart | Reconcile persisted allocations against `squeue` on boot. |
| Registration never arrives | Timeout (e.g. running + 60 s, no register) → mark unreachable, hint transport/secret. |

### Idle auto-release

Opt-in per allocation: check **"End automatically when idle"** in the allocation
modal (default 60 minutes, min 10), or pass `--idle-timeout <minutes>` to
`nebula compute alloc` (`idle_timeout_minutes` on the `request_allocation` MCP
tool). The setting travels as `idleTimeoutMinutes` in the allocation spec and the
job script exports `NEBULA_IDLE_EXIT_MINUTES` to the client server on the compute
node, which then checks once a minute whether it is idle — no kernel busy or
starting, and no kernel or terminal activity newer than the timeout. Five minutes
before the cutoff it logs a warning ("run anything to keep it"); at the cutoff it
shuts its kernels down cleanly and exits its own process, so the batch job
completes and the allocation ends naturally — no `scancel`, no scheduler-side
state. Active allocations with the setting show "(auto-ends after Nm idle)" in
the modal.

## Reused vs new

**Reused (little/no change):** `server-registry.ts`, `client-registration.ts`,
`kernel-proxy.ts` (HTTP+WS bridge), `routes/kernel.ts` remote path, `kernel-service.ts`
local spawn, `kernelspec.ts`, kernel menu Server section, `clusterService`.

**New:** `scheduler/` (interface + SlurmScheduler + AllocationService), `routes/compute.ts`,
sbatch template, transport prober + SSH-tunnel helper, `computeService` + the
allocation modal/state, `PeerServer` fields, config keys.

## Phasing

- **Phase 0 — probe (½ day):** submit a throwaway job that curls the login server
  both ways; record whether Phase-1 direct transport works on the target cluster.
- **Phase 1 — MVP:** `SlurmScheduler` (`associations`/`submit`/`query`/`cancel` +
  `--test-only` estimate), `AllocationService`, `routes/compute.ts`, sbatch
  template, **direct transport only**, token correlation. Modal offers the user's
  allowed partitions/QoS with a live "would start ≈ HH:MM"; pending-server
  rendering. End-to-end: submit → job runs → server appears → run a kernel over the
  shared filesystem.
- **Phase 1.5 — load monitor:** `load()` aggregation + the sortable partition/QoS
  busyness panel (idle capacity, backlog, your jobs) beside the form.
- **Phase 2 — robustness:** SSH-tunnel fallback + auto-probe, presets, walltime
  warnings, restart-reconcile, cancel UX, resource caps.
- **Phase 3 — portability:** additional schedulers (PBS/LSF); generalize the job
  template.

## Open questions

- Compute↔login connectivity on the target cluster (settles how much of Phase 2 is
  needed) — answer empirically in Phase 0.
- One allocation shared across notebooks/tabs, or one per notebook by default?
  (Model supports either; default = shared, explicit "new allocation" to isolate.)
- GPU visibility: rely on `--gres` + `CUDA_VISIBLE_DEVICES` inheritance into the
  kernel (should be automatic since the kernel is a child of the job step).
