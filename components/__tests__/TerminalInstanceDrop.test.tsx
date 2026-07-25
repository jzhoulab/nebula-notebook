/**
 * Terminal drag-and-drop policy.
 *
 * Browsers never expose a dropped OS file's path (only its bytes), so:
 *  - internal drags (Nebula file browser) carry the real server path in
 *    text/plain → type it;
 *  - OS files → explain the limit and offer upload-then-paste;
 *  - every drop preventDefaults so the browser can't navigate away.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const sent: string[] = [];
vi.mock('../../services/terminalService', () => ({
  connectTerminal: vi.fn(() => {
    const ws: any = {
      readyState: 1,
      send: vi.fn((raw: string) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'input') sent.push(msg.data);
      }),
      close: vi.fn(),
    };
    setTimeout(() => ws.onopen?.(), 0);
    return ws;
  }),
}));
vi.mock('../../services/fileService', () => ({
  uploadFile: vi.fn(async (dir: string, f: File) => ({ path: `${dir}/${f.name}` })),
}));
vi.mock('../../services/agentTerminalService', () => ({
  agentTerminalService: {
    registerSender: vi.fn(), unregisterSender: vi.fn(), observeOutput: vi.fn(),
  },
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class { open() {} write() {} onData() {} onResize() {} dispose() {} loadAddon() {} focus() {} get cols() { return 80; } get rows() { return 24; } },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} dispose() {} proposeDimensions() { return { cols: 80, rows: 24 }; } } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { dispose() {} } }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class { dispose() {} } }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { dispose() {} onContextLoss() {} } }));

import { TerminalInstance } from '../TerminalInstance';

const dt = (over: Partial<DataTransfer>) => ({
  types: [], files: [], getData: () => '', ...over,
}) as unknown as DataTransfer;

describe('terminal drop handling', () => {
  beforeEach(() => { sent.length = 0; });

  it('types the server path for an internal file-browser drag', async () => {
    const { container } = render(<TerminalInstance terminalId="t1" isActive cwd="/srv/work" />);
    const root = container.firstChild as HTMLElement;
    fireEvent.drop(root, { dataTransfer: dt({ types: ['text/plain'], getData: () => '/gpfs/data/x.csv' }) });
    await waitFor(() => expect(sent).toContain('/gpfs/data/x.csv'));
  });

  it('shell-quotes a path containing spaces', async () => {
    const { container } = render(<TerminalInstance terminalId="t1" isActive cwd="/srv/work" />);
    const root = container.firstChild as HTMLElement;
    fireEvent.drop(root, { dataTransfer: dt({ types: ['text/plain'], getData: () => '/gpfs/my data/x.csv' }) });
    await waitFor(() => expect(sent[0]).toBe("'/gpfs/my data/x.csv'"));
  });

  it('explains the browser limit for OS files instead of pasting nothing', async () => {
    const file = new File(['hi'], 'local.csv', { type: 'text/csv' });
    const { container } = render(<TerminalInstance terminalId="t1" isActive cwd="/srv/work" />);
    const root = container.firstChild as HTMLElement;
    fireEvent.drop(root, { dataTransfer: dt({ types: ['Files'], files: [file] as unknown as FileList }) });
    expect(await screen.findByText(/upload to the server\?/i)).toBeTruthy();
    // teaches the OS-level workaround for a path on THIS machine
    expect(screen.getByText(/⌥⌘C/)).toBeTruthy();
  });

  it('uploads on confirm and types the resulting SERVER path', async () => {
    const file = new File(['hi'], 'local.csv', { type: 'text/csv' });
    const { container } = render(<TerminalInstance terminalId="t1" isActive cwd="/srv/work" />);
    const root = container.firstChild as HTMLElement;
    fireEvent.drop(root, { dataTransfer: dt({ types: ['Files'], files: [file] as unknown as FileList }) });
    fireEvent.click(await screen.findByText(/upload & paste path/i));
    await waitFor(() => expect(sent).toContain('/srv/work/local.csv'));
  });

  it('warns that a server path is another filesystem when the agent runs locally', () => {
    const { container } = render(<TerminalInstance terminalId="t1" isActive runsOnUserMachine />);
    const root = container.firstChild as HTMLElement;
    fireEvent.dragOver(root, { dataTransfer: dt({ types: ['text/plain'] }) });
    expect(screen.getByText(/runs on your machine/i)).toBeTruthy();
  });
});
