import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ComputeAllocationModal from '../ComputeAllocationModal';
import type { ComputePartitions } from '../../services/computeService';

vi.mock('../../services/onboardingService', () => ({
  markOnboardingStep: vi.fn(),
}));

vi.mock('../../services/computeService', () => ({
  getComputePartitions: vi.fn(),
  getPartitionQos: vi.fn(),
  listAllocations: vi.fn(),
  createAllocation: vi.fn(),
  cancelAllocation: vi.fn(),
  getArmSetup: vi.fn(),
}));

import {
  getComputePartitions,
  getPartitionQos,
  listAllocations,
  getArmSetup,
} from '../../services/computeService';

const partitionsFixture: ComputePartitions = {
  enabled: true,
  associations: {
    account: 'lab',
    partitions: ['main'],
    qoses: ['normal'],
    defaultQos: 'normal',
  },
  load: {
    partitions: [
      {
        name: 'main',
        up: true,
        timeLimit: '7-00:00:00',
        cpus: { alloc: 0, idle: 64, other: 0, total: 64 },
        nodes: { idle: 2, mixed: 0, alloc: 0, down: 0, total: 2 },
        jobs: { pending: 0, running: 0 },
      },
    ],
    qoses: [],
    fetchedAt: 0,
  },
};

/** The number input inside the form field whose label reads `labelText`. */
async function findNumberInput(labelText: string): Promise<HTMLInputElement> {
  const label = await screen.findByText(labelText);
  const input = label.parentElement!.querySelector('input[type="number"]');
  expect(input).not.toBeNull();
  return input as HTMLInputElement;
}

describe('ComputeAllocationModal number inputs', () => {
  beforeEach(() => {
    vi.mocked(getComputePartitions).mockResolvedValue(partitionsFixture);
    vi.mocked(getPartitionQos).mockResolvedValue(null as any);
    vi.mocked(listAllocations).mockResolvedValue([]);
  });

  const renderModal = () =>
    render(<ComputeAllocationModal isOpen={true} onClose={() => {}} />);

  it('lets the CPUs field be emptied and retyped from scratch', async () => {
    renderModal();
    const cpusInput = await findNumberInput('CPUs');
    expect(cpusInput.value).toBe('4');

    // Clearing must not snap back to the minimum mid-edit
    fireEvent.change(cpusInput, { target: { value: '' } });
    expect(cpusInput.value).toBe('');

    fireEvent.change(cpusInput, { target: { value: '16' } });
    expect(cpusInput.value).toBe('16');

    fireEvent.blur(cpusInput);
    expect(cpusInput.value).toBe('16');
  });

  it('restores the last committed value when the field is left empty', async () => {
    renderModal();
    const cpusInput = await findNumberInput('CPUs');

    fireEvent.change(cpusInput, { target: { value: '' } });
    fireEvent.blur(cpusInput);
    expect(cpusInput.value).toBe('4');
  });

  it('clamps below-minimum values on blur, not per keystroke', async () => {
    renderModal();
    const cpusInput = await findNumberInput('CPUs');

    fireEvent.change(cpusInput, { target: { value: '0' } });
    expect(cpusInput.value).toBe('0'); // free to keep typing (e.g. heading for "0" -> "08")

    fireEvent.blur(cpusInput);
    expect(cpusInput.value).toBe('1'); // committed value clamped to min
  });

  it('lets every numeric field in the form be emptied while editing', async () => {
    renderModal();
    for (const labelText of ['Walltime (hours)', 'CPUs', 'Memory (GB)', 'GPUs (0 = none)']) {
      const input = await findNumberInput(labelText);
      fireEvent.change(input, { target: { value: '' } });
      expect(input.value, `${labelText} should stay empty mid-edit`).toBe('');
      fireEvent.blur(input);
      expect(input.value, `${labelText} should restore its value on blur`).not.toBe('');
    }
  });
});

describe('hook order across open/close (React #310 regression)', () => {
  // Every hook must run on EVERY render. The modal early-returns null when
  // closed, so a hook placed below that return runs only while open — and
  // opening the modal then crashes with "Rendered more hooks than during the
  // previous render" (2026-08-31 report: crash when requesting an allocation).
  beforeEach(() => {
    vi.mocked(getComputePartitions).mockResolvedValue(partitionsFixture);
    vi.mocked(getPartitionQos).mockResolvedValue(null as any);
    vi.mocked(listAllocations).mockResolvedValue([]);
    vi.mocked(getArmSetup).mockResolvedValue({ configured: true, prompt: '' });
  });

  it('mounts closed, then opens without a hook-order error', async () => {
    const view = render(<ComputeAllocationModal isOpen={false} onClose={() => {}} />);
    view.rerender(<ComputeAllocationModal isOpen={true} onClose={() => {}} />);
    // The form renders: no throw, and the partition control is present.
    expect(await screen.findByLabelText(/Partition/i)).toBeInTheDocument();
    // …and closing again is equally safe.
    view.rerender(<ComputeAllocationModal isOpen={false} onClose={() => {}} />);
    expect(screen.queryByLabelText(/Partition/i)).toBeNull();
  });
});

describe('ARM partition setup affordance', () => {
  // aarch64 queues without a configured ARM runtime: the modal says so and
  // hands over an agent-executable setup prompt — instead of letting the
  // submit fail with an env-var error the user must act on manually.
  const armFixture: ComputePartitions = {
    ...partitionsFixture,
    associations: { ...partitionsFixture.associations!, partitions: ['main', 'armq'] },
    load: {
      ...partitionsFixture.load!,
      partitions: [
        ...partitionsFixture.load!.partitions,
        {
          name: 'armq', up: true, timeLimit: '7-00:00:00',
          cpus: { alloc: 0, idle: 72, other: 0, total: 72 },
          nodes: { idle: 1, mixed: 0, alloc: 0, down: 0, total: 1 },
          jobs: { pending: 0, running: 0 },
          archs: ['aarch64'],
        },
      ],
    },
  };

  beforeEach(() => {
    vi.mocked(getComputePartitions).mockResolvedValue(armFixture);
    vi.mocked(getPartitionQos).mockResolvedValue(null as any);
    vi.mocked(listAllocations).mockResolvedValue([]);
    vi.mocked(getArmSetup).mockResolvedValue({ configured: false, prompt: 'AGENT ARM SETUP PROMPT for armq' });
  });

  const selectPartition = async (name: string) => {
    const select = (await screen.findByLabelText(/Partition/i)) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: name } });
  };

  it('selecting an aarch64 partition surfaces the setup banner with a copy-prompt button', async () => {
    render(<ComputeAllocationModal isOpen={true} onClose={() => {}} />);
    await selectPartition('armq');
    const banner = await screen.findByTestId('arm-setup-banner');
    expect(banner.textContent).toMatch(/aarch64/);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    fireEvent.click(screen.getByRole('button', { name: /Copy setup prompt/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('AGENT ARM SETUP PROMPT for armq'));
  });

  it('shows nothing for x86 partitions or when ARM is already configured', async () => {
    render(<ComputeAllocationModal isOpen={true} onClose={() => {}} />);
    await selectPartition('main');
    await waitFor(() => expect(screen.queryByTestId('arm-setup-banner')).toBeNull());

    vi.mocked(getArmSetup).mockResolvedValue({ configured: true, prompt: '' });
    render(<ComputeAllocationModal isOpen={true} onClose={() => {}} />);
    await selectPartition('armq');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('arm-setup-banner')).toBeNull();
  });
});
