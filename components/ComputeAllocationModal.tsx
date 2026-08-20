/**
 * Compute Allocation Modal
 *
 * Submit and manage scheduler-backed compute allocations. Each allocation is a
 * batch job that launches a Nebula client-server on the allocated node(s); once
 * it registers it shows up as a normal server in the kernel menu and kernels run
 * on it over the shared filesystem.
 *
 * "Soonest start" is derived from real idle capacity (idle CPUs / idle GPUs of
 * the requested type), not from `sbatch --test-only` — which on some clusters
 * reports a fixed pessimistic time even when nodes sit idle.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { X, Loader2, Cpu, Trash2, RefreshCw, Server, Zap, Sparkles, CheckCircle2, Clock, Play } from 'lucide-react';
import { markOnboardingStep } from '../services/onboardingService';
import {
  getComputePartitions,
  getPartitionQos,
  listAllocations,
  createAllocation,
  cancelAllocation,
  type ComputePartitions,
  type Allocation,
  type AllocationSpec,
  type PartitionLoad,
  getArmSetup,
} from '../services/computeService';
import { ModalShell } from './ModalShell';

interface ComputeAllocationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onChanged?: () => void;
  /**
   * When opened from a notebook: called with the allocation's server id so
   * the notebook can switch its kernels to that allocation. Active
   * allocations render a "Use for kernels" action when this is provided.
   */
  onUseForKernels?: (serverId: string) => void;
  /**
   * Like onUseForKernels, but for allocations still starting (pending/running):
   * called with the allocation id; the caller watches it and switches kernels
   * the moment it becomes active, so selecting doesn't require waiting here.
   */
  onUseWhenReady?: (allocationId: string) => void;
}

const inputClass =
  'w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500';
const labelClass = 'block text-xs font-medium text-slate-600 mb-1';

/**
 * Number input that tolerates transient edit states: the field can be emptied
 * and retyped from scratch (clamping on every keystroke made that impossible).
 * Valid values commit as they are typed, clamped to min; blur snaps the
 * display back to the committed value.
 */
function NumberField({ value, min, step, onCommit, className, disabled, ariaLabel }: {
  value: number;
  min: number;
  step?: number;
  onCommit: (n: number) => void;
  className: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null); // null = not editing
  return (
    <input
      type="number"
      min={min}
      step={step}
      className={className}
      disabled={disabled}
      aria-label={ariaLabel}
      value={draft ?? String(value)}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(n)) onCommit(Math.max(min, n));
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

const STATE_BADGE: Record<Allocation['state'], string> = {
  pending: 'bg-amber-100 text-amber-700',
  running: 'bg-blue-100 text-blue-700',
  active: 'bg-green-100 text-green-700',
  ended: 'bg-slate-100 text-slate-500',
  failed: 'bg-red-100 text-red-700',
  cancelled: 'bg-slate-100 text-slate-500',
};

/** Readable GPU model, e.g. "nvidia_a100-pcie-40gb" -> "A100-PCIE-40GB". */
function gpuLabel(type: string): string {
  return type.replace(/^nvidia[_-]?/i, '').toUpperCase();
}

/** SLURM time limit -> minutes (null = no/unknown limit). Formats: D-HH:MM:SS, HH:MM:SS, MM:SS. */
function limitMinutes(s: string): number | null {
  const t = (s || '').trim().toLowerCase();
  if (!t || t === 'infinite' || t === 'unlimited' || t === 'n/a') return null;
  const dm = t.match(/^(?:(\d+)-)?(\d+):(\d+):(\d+)$/);
  if (dm) return parseInt(dm[1] || '0', 10) * 1440 + parseInt(dm[2], 10) * 60 + parseInt(dm[3], 10);
  const ms = t.match(/^(\d+):(\d+)$/);
  if (ms) return parseInt(ms[1], 10);
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}

interface Req { cpus: number; gpus: number; gpuType: string; walltimeMinutes: number; }

/** Can this partition run the request right now, and how much headroom? Higher score = better fit. */
function partitionFit(p: PartitionLoad, req: Req): { ok: boolean; reason: string; score: number } {
  if (!p.up) return { ok: false, reason: 'offline', score: -1e9 };
  const lim = limitMinutes(p.timeLimit);
  if (lim !== null && req.walltimeMinutes > lim) {
    return { ok: false, reason: `walltime exceeds ${p.timeLimit} limit`, score: -1e8 };
  }
  if (req.gpus > 0) {
    if (!p.gpus?.length) return { ok: false, reason: 'no GPUs', score: -1e9 };
    if (req.gpuType) {
      const g = p.gpus.find((x) => x.type === req.gpuType);
      if (!g) return { ok: false, reason: 'different GPU type', score: -1e9 };
      if (g.idle < req.gpus) return { ok: false, reason: `only ${g.idle} of ${req.gpus} ${gpuLabel(g.type)} free`, score: -1e6 + g.idle };
      return { ok: true, reason: `${g.idle} ${gpuLabel(g.type)} free now`, score: 1e6 + g.idle };
    }
    // Any type acceptable — the scheduler places on whichever card is free.
    const idle = p.gpus.reduce((s, g) => s + g.idle, 0);
    if (idle < req.gpus) return { ok: false, reason: `only ${idle} of ${req.gpus} GPUs free`, score: -1e6 + idle };
    return { ok: true, reason: `${idle} GPUs free now`, score: 1e6 + idle };
  }
  if (p.cpus.idle < req.cpus) return { ok: false, reason: `only ${p.cpus.idle} of ${req.cpus} CPUs free`, score: -1e6 + p.cpus.idle };
  return { ok: true, reason: `${p.cpus.idle} CPUs free now`, score: 1e6 + p.cpus.idle };
}

export default function ComputeAllocationModal({ isOpen, onClose, onChanged, onUseForKernels, onUseWhenReady }: ComputeAllocationModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // aarch64 queues need an ARM runtime on the server; when it's missing we
  // hand over an agent-executable setup prompt instead of letting the submit
  // fail with an env-var error. null = not fetched / unavailable.
  const [armSetup, setArmSetup] = useState<{ configured: boolean; prompt: string } | null>(null);
  const [armPromptCopied, setArmPromptCopied] = useState(false);
  const [data, setData] = useState<ComputePartitions | null>(null);
  const [allocations, setAllocations] = useState<Allocation[]>([]);

  // Form state
  const [partition, setPartition] = useState('');
  const [qos, setQos] = useState('');
  const [cpus, setCpus] = useState(4);
  const [memGb, setMemGb] = useState(8);
  const [gpus, setGpus] = useState(0);
  const [gpuType, setGpuType] = useState('');
  const [walltimeHours, setWalltimeHours] = useState(2);
  const [jobName, setJobName] = useState('');
  const [idleRelease, setIdleRelease] = useState(false);
  const [idleMinutes, setIdleMinutes] = useState(60);
  const [submitting, setSubmitting] = useState(false);

  // QoS the selected partition will actually accept (null = any; [] = still checking).
  const [partitionQos, setPartitionQos] = useState<string[] | null>(null);

  const buildSpec = useCallback((): AllocationSpec => ({
    partition,
    qos: qos || undefined,
    account: data?.associations?.account || undefined,
    cpus,
    memGb,
    gpus: gpus > 0 ? gpus : undefined,
    gpuType: gpus > 0 && gpuType ? gpuType : undefined,
    walltimeMinutes: Math.max(1, Math.round(walltimeHours * 60)),
    jobName: jobName || undefined,
    idleTimeoutMinutes: idleRelease ? Math.max(10, Math.round(idleMinutes) || 60) : undefined,
  }), [partition, qos, data, cpus, memGb, gpus, gpuType, walltimeHours, jobName, idleRelease, idleMinutes]);

  const refreshAll = useCallback(async () => {
    try { setAllocations(await listAllocations()); } catch { /* keep last */ }
  }, []);

  const refreshLoad = useCallback(async () => {
    try { setData(await getComputePartitions()); } catch { /* keep last */ }
  }, []);

  // Load partitions + allocations when the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [partData] = await Promise.all([getComputePartitions(), refreshAll()]);
        if (cancelled) return;
        setData(partData);
        const parts = partData.associations?.partitions ?? [];
        if (parts.length && !partition) setPartition(parts[0]);
        const defQos = partData.associations?.defaultQos;
        if (defQos && !qos) setQos(defQos);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load compute options');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Allocation state is cheap (in-memory) — poll often so transitions show
  // fast. Paused while the tab is hidden.
  useEffect(() => {
    if (!isOpen) return;
    const id = setInterval(() => { if (!document.hidden) refreshAll(); }, 4000);
    return () => clearInterval(id);
  }, [isOpen, refreshAll]);

  // Queue load + QoS usage hit the scheduler — poll slowly, never hidden.
  useEffect(() => {
    if (!isOpen) return;
    const id = setInterval(() => { if (!document.hidden) refreshLoad(); }, 15000);
    return () => clearInterval(id);
  }, [isOpen, refreshLoad]);

  // Refresh the moment the tab becomes visible again.
  useEffect(() => {
    if (!isOpen) return;
    const onVisible = () => { if (!document.hidden) { refreshAll(); refreshLoad(); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [isOpen, refreshAll, refreshLoad]);

  // When the partition changes, discover which QoS it accepts and keep the
  // selected QoS valid (some partitions require an explicit QoS).
  useEffect(() => {
    if (!isOpen || !partition) { setPartitionQos(null); return; }
    let cancelled = false;
    getPartitionQos(partition)
      .then((allowed) => {
        if (cancelled) return;
        setPartitionQos(allowed);
        if (allowed && allowed.length && !allowed.includes(qos)) setQos(allowed[0]);
      })
      .catch(() => { if (!cancelled) setPartitionQos(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, partition]);

  // Drop a GPU type that the newly-selected queue doesn't offer.
  useEffect(() => {
    const gpus = data?.load?.partitions.find((p) => p.name === partition)?.gpus;
    const types = gpus?.map((g) => g.type) ?? [];
    setGpuType((cur) => (cur && !types.includes(cur) ? '' : cur));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partition]);

  const handleSubmit = async () => {
    if (!partition) { setError('Pick a partition first'); return; }
    setSubmitting(true);
    setError(null);
    try {
      await createAllocation(buildSpec());
      markOnboardingStep('allocatedCompute');
      await refreshAll();
      onChanged?.();
    } catch (e: any) {
      setError(e?.message || 'Failed to submit allocation');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id: string) => {
    try {
      await cancelAllocation(id);
      await refreshAll();
      onChanged?.();
    } catch (e: any) {
      setError(e?.message || 'Failed to cancel allocation');
    }
  };

  if (!isOpen) return null;

  const associations = data?.associations;
  const partitions = associations?.partitions ?? [];
  const loadParts = data?.load?.partitions ?? [];
  const loadByName = new Map(loadParts.map((p) => [p.name, p]));
  const allQos = data?.load?.qoses ?? [];
  const qosByName = new Map(allQos.map((q) => [q.name, q]));

  // QoS the user may pick. If the partition requires an explicit QoS, that set
  // wins (discovered from the scheduler); otherwise the account-level list.
  const qosRequired = !!(partitionQos && partitionQos.length > 0);
  const accountQos = (associations?.qoses?.length ? associations.qoses : allQos.map((q) => q.name));
  const qosOptions = qosRequired ? partitionQos! : accountQos;

  const req: Req = { cpus, gpus, gpuType, walltimeMinutes: Math.max(1, Math.round(walltimeHours * 60)) };

  // Capacity-based recommendation across allowed partitions.
  const candidates = partitions
    .map((name) => { const p = loadByName.get(name); return p ? { name, p, fit: partitionFit(p, req) } : null; })
    .filter(Boolean) as { name: string; p: PartitionLoad; fit: ReturnType<typeof partitionFit> }[];
  const ranked = [...candidates].sort((a, b) => b.fit.score - a.fit.score);
  const recommended = ranked[0];

  const selectedLoad = loadByName.get(partition);
  // Only the GPU model(s) that actually exist in the selected queue.
  const partitionGpuTypes = selectedLoad?.gpus?.map((g) => g.type) ?? [];
  const selectedIsArm = Boolean(selectedLoad?.archs?.length && selectedLoad.archs.every((a) => a !== 'x86_64'));

  useEffect(() => {
    if (!selectedIsArm || armSetup !== null) return;
    let cancelled = false;
    getArmSetup().then((info) => { if (!cancelled && info) setArmSetup(info); });
    return () => { cancelled = true; };
  }, [selectedIsArm, armSetup]);
  const selectedFit = selectedLoad ? partitionFit(selectedLoad, req) : null;
  const betterExists = recommended && recommended.name !== partition &&
    (!selectedFit || recommended.fit.score > selectedFit.score + 1);

  const applyRecommended = () => {
    if (!recommended) return;
    setPartition(recommended.name);
    if (gpus > 0 && !gpuType && recommended.p.gpus?.length === 1) setGpuType(recommended.p.gpus[0].type);
  };

  return (
    // overflow-y-auto on the backdrop + m-auto on the panel: centered when it
    // fits, scrollable without clipping the top when taller than the viewport
    // (flex items-center alone clips the top edge in that case)
    <div className="fixed inset-0 bg-black/50 flex z-50 overflow-y-auto p-4" onClick={onClose}>
      <ModalShell
        onClose={onClose}
        label="Compute Allocation"
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full m-auto max-h-[85vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b sticky top-0 bg-white z-10">
          <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
            <Cpu className="w-5 h-5 text-blue-600" /> Compute Allocation
          </h2>
          <button onClick={onClose} aria-label="Close" className="p-1 hover:bg-slate-100 rounded">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500 py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading compute options…
            </div>
          ) : (
            <>
              {error && (
                <div className="text-xs text-red-700 bg-red-50 border border-red-100 rounded px-3 py-2">
                  {error}
                </div>
              )}

              {/* Recommendation — suggests the partition that can start this request soonest */}
              {betterExists && (
                <button
                  onClick={applyRecommended}
                  className="w-full text-left text-xs rounded px-3 py-2 border border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-800 flex items-center gap-2"
                >
                  <Sparkles className="w-4 h-4 flex-shrink-0 text-blue-500" />
                  <span>
                    <span className="font-medium">{recommended.name}</span>{' '}
                    {recommended.fit.ok ? `can start this now — ${recommended.fit.reason}` : `is the closest fit — ${recommended.fit.reason}`}
                  </span>
                  <span className="flex-1" />
                  <span className="font-medium underline">Use it</span>
                </button>
              )}

              {/* Request form */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Partition / Queue</label>
                  <select className={inputClass} aria-label="Partition / Queue" value={partition} onChange={(e) => setPartition(e.target.value)}>
                    {partitions.length === 0 && <option value="">(none available)</option>}
                    {partitions.map((p) => {
                      const lp = loadByName.get(p);
                      const free = lp?.gpus?.length ? `${lp.gpus.reduce((s2, g) => s2 + g.idle, 0)} gpu free` : lp ? `${lp.cpus.idle} cpu free` : '';
                      // Flag non-x86 queues — their kernels need matching-arch envs.
                      const arch = lp?.archs?.some((a) => a !== 'x86_64') ? lp!.archs!.join('+') : '';
                      return <option key={p} value={p}>{p}{free ? ` — ${free}` : ''}{arch ? ` · ${arch}` : ''}</option>;
                    })}
                  </select>
                  {selectedIsArm && armSetup && !armSetup.configured && (
                    <div data-testid="arm-setup-banner" className="mt-2 p-2 rounded-md bg-amber-50 border border-amber-200 text-xs text-amber-800">
                      This queue runs {selectedLoad?.archs?.join('+')} nodes, but this server has no ARM runtime configured — allocations here will be refused.
                      Setup is a one-time task; the easiest path is handing it to an agent:
                      <button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(armSetup.prompt);
                            setArmPromptCopied(true);
                            setTimeout(() => setArmPromptCopied(false), 2500);
                          } catch { /* clipboard unavailable */ }
                        }}
                        className="ml-1 px-2 py-0.5 rounded bg-amber-600 text-white font-medium hover:bg-amber-700"
                      >
                        {armPromptCopied ? 'Copied!' : 'Copy setup prompt'}
                      </button>
                      <span className="block mt-1 text-amber-700/80">Paste it to an agent running on the server (or run: nebula compute arm-setup).</span>
                    </div>
                  )}
                </div>
                <div>
                  <label className={labelClass}>Walltime (hours)</label>
                  <NumberField min={0.25} step={0.25} className={inputClass} value={walltimeHours}
                    onCommit={setWalltimeHours} ariaLabel="Walltime in hours" />
                </div>
                <div>
                  <label className={labelClass}>CPUs</label>
                  <NumberField min={1} className={inputClass} value={cpus}
                    onCommit={setCpus} ariaLabel="Number of CPUs" />
                </div>
                <div>
                  <label className={labelClass}>Memory (GB)</label>
                  <NumberField min={1} className={inputClass} value={memGb}
                    onCommit={setMemGb} ariaLabel="Memory in GB" />
                </div>
                <div>
                  <label className={labelClass}>GPUs (0 = none)</label>
                  <NumberField min={0} className={inputClass} value={gpus}
                    onCommit={setGpus} ariaLabel="Number of GPUs" />
                </div>
                <div>
                  <label className={labelClass}>GPU type</label>
                  <select className={inputClass} value={gpuType}
                    disabled={gpus === 0 || partitionGpuTypes.length === 0}
                    onChange={(e) => setGpuType(e.target.value)}>
                    <option value="">
                      {gpus === 0 ? '—' : partitionGpuTypes.length === 0 ? 'no GPUs in this queue' : '(any type)'}
                    </option>
                    {partitionGpuTypes.map((t) => <option key={t} value={t}>{gpuLabel(t)}</option>)}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className={labelClass}>Job name (optional)</label>
                  <input type="text" className={inputClass} value={jobName} placeholder={`nebula-${partition || 'compute'}`}
                    onChange={(e) => setJobName(e.target.value)} />
                </div>
                {/* Opt-in idle auto-release: the allocation's server exits itself after
                    N idle minutes, so the job completes and the nodes free up. */}
                <div className="col-span-2 flex items-center gap-2 text-xs text-slate-600">
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" checked={idleRelease} onChange={(e) => setIdleRelease(e.target.checked)} />
                    End automatically when idle
                  </label>
                  <NumberField
                    min={10} step={5}
                    className="w-20 px-2 py-1 text-xs border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                    value={idleMinutes} disabled={!idleRelease}
                    onCommit={setIdleMinutes}
                    ariaLabel="Idle minutes before auto-end"
                  />
                  <span className={idleRelease ? '' : 'text-slate-400'}>idle minutes (no running cells or terminal use)</span>
                </div>
              </div>

              {/* Availability for the selected partition — capacity-based, not a scheduler guess */}
              {selectedLoad && selectedFit && (
                <div className={`text-xs rounded px-3 py-2 border flex items-start gap-2 ${
                  selectedFit.ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-amber-50 border-amber-200 text-amber-800'
                }`}>
                  {selectedFit.ok
                    ? <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-green-600 mt-px" />
                    : <Clock className="w-4 h-4 flex-shrink-0 text-amber-600 mt-px" />}
                  <span>
                    {selectedFit.ok
                      ? <><span className="font-medium">Should start right away</span> — {selectedFit.reason} on {selectedLoad.name}.</>
                      : <><span className="font-medium">Likely to wait</span> — {selectedFit.reason}; {selectedLoad.jobs.pending} pending in {selectedLoad.name}.</>}
                    {' '}
                    <span className="text-slate-500">
                      ({selectedLoad.cpus.idle}/{selectedLoad.cpus.total} CPUs
                      {selectedLoad.gpus?.length ? selectedLoad.gpus.map((g) => `, ${g.idle}/${g.total} ${gpuLabel(g.type)} GPUs`).join('') : ''} idle
                      {selectedLoad.timeLimit ? `, limit ${selectedLoad.timeLimit}` : ''})
                    </span>
                  </span>
                </div>
              )}

              {/* QoS — usage per QoS + pick one for this job */}
              <div>
                <label className={labelClass}>
                  QoS — how the job is scheduled
                  {qosRequired && <span className="ml-1 font-normal text-amber-600">· {partition} requires an explicit QoS</span>}
                </label>
                <div className="space-y-1">
                  {(qosRequired ? qosOptions : ['', ...qosOptions]).map((q) => {
                    const info = q ? qosByName.get(q) : undefined;
                    const selected = q === qos;
                    const preemptedBy = q ? allQos.filter((x) => x.preempts.includes(q)).map((x) => x.name) : [];
                    let role = '';
                    if (info?.preempts.length) role = `preempts ${info.preempts.join(', ')}`;
                    else if (preemptedBy.length) role = `preemptible · yields to ${preemptedBy.join(', ')}`;
                    return (
                      <button
                        key={q || '__default'}
                        onClick={() => setQos(q)}
                        className={`w-full text-left flex items-center gap-2 text-xs rounded px-2.5 py-1.5 border ${
                          selected ? 'border-blue-300 bg-blue-50' : 'border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${selected ? 'bg-blue-500' : 'bg-slate-300'}`} />
                        <span className="font-medium text-slate-700">{q || '(scheduler default)'}</span>
                        {role && (
                          <span className={`px-1.5 py-0.5 rounded text-[0.625rem] ${
                            info?.preemptible ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'
                          }`}>{role}</span>
                        )}
                        <span className="flex-1" />
                        {info && (
                          <span className="text-slate-400 tabular-nums">
                            {info.jobs.running} run · {info.jobs.pending} pend
                            {info.maxWall ? ` · ≤${info.maxWall}` : ''}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Submit */}
              <div className="flex items-center gap-2">
                <button onClick={handleSubmit} disabled={!partition || submitting}
                  className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5">
                  {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />} Request allocation
                </button>
              </div>

              {/* Current allocations */}
              <div className="pt-2 border-t">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1">
                    <Server className="w-3 h-3" /> Allocations
                  </h3>
                  <button onClick={refreshAll} className="p-1 hover:bg-slate-100 rounded text-slate-400" title="Refresh" aria-label="Refresh">
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </div>
                {allocations.length === 0 ? (
                  <div className="text-xs text-slate-400 py-2">No allocations yet.</div>
                ) : (
                  <div className="space-y-1.5">
                    {allocations.map((a) => (
                      <div key={a.id} className="flex items-center gap-2 text-xs border border-slate-200 rounded px-2.5 py-1.5">
                        <span className={`px-1.5 py-0.5 rounded font-medium ${STATE_BADGE[a.state]}`}>{a.state}</span>
                        <span className="font-medium text-slate-700">{a.spec.jobName}</span>
                        <span className="text-slate-500">
                          {a.spec.partition}{a.spec.qos ? `/${a.spec.qos}` : ''} · {a.spec.cpus}cpu · {a.spec.memGb}GB{a.spec.gpus ? ` · ${a.spec.gpus}gpu${a.spec.gpuType ? ` ${gpuLabel(a.spec.gpuType)}` : ''}` : ''}
                        </span>
                        {a.spec.idleTimeoutMinutes ? (
                          <span className="text-slate-400" title="The allocation's server exits itself after this long without kernel or terminal activity">
                            (auto-ends after {a.spec.idleTimeoutMinutes}m idle)
                          </span>
                        ) : null}
                        {a.nodes?.length ? <span className="text-slate-400 truncate">{a.nodes.join(', ')}</span> : null}
                        {a.jobId && <span className="text-slate-400">job {a.jobId}</span>}
                        <div className="flex-1" />
                        {onUseForKernels && a.state === 'active' && a.serverId && (
                          <button
                            onClick={() => { onUseForKernels(a.serverId!); onClose(); }}
                            className="px-2 py-0.5 rounded border border-green-200 bg-green-50 text-green-700 hover:bg-green-100 font-medium flex items-center gap-1"
                            title="Run this notebook's kernels on this allocation"
                          >
                            <Play className="w-3 h-3" />
                            Use for kernels
                          </button>
                        )}
                        {onUseWhenReady && ['pending', 'running'].includes(a.state) && (
                          <button
                            onClick={() => { onUseWhenReady(a.id); onClose(); }}
                            className="px-2 py-0.5 rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 font-medium flex items-center gap-1"
                            title="Switch this notebook's kernels to this allocation as soon as it finishes starting"
                          >
                            <Clock className="w-3 h-3" />
                            Use when ready
                          </button>
                        )}
                        {!['ended', 'failed', 'cancelled'].includes(a.state) && (
                          <button onClick={() => handleCancel(a.id)} className="p-1 hover:bg-red-50 rounded text-slate-400 hover:text-red-600" title="Cancel" aria-label="Cancel">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </ModalShell>
    </div>
  );
}
