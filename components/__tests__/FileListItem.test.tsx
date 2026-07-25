/**
 * Rename-box selection regression (lab bug report): the focus/select effect
 * must fire ONCE on entering edit mode — not on every keystroke. With
 * editValue in its deps, each typed character re-selected the whole name,
 * so typing replaced the entire filename repeatedly.
 */
import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileListItem } from '../FileListItem';
import type { FileItem } from '../../services/fileService';

vi.mock('../../services/fileService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/fileService')>();
  return { ...actual, readFile: vi.fn().mockResolvedValue({ type: 'text', content: '' }) };
});

const item: FileItem = {
  id: '/x/results.csv',
  name: 'results.csv',
  path: '/x/results.csv',
  isDirectory: false,
  size: '1 KB',
  sizeBytes: 1024,
  modified: Date.now() / 1000,
  extension: '.csv',
  fileType: 'data',
};

const Harness: React.FC = () => {
  const [value, setValue] = useState(item.name);
  return (
    <FileListItem
      item={item}
      isEditing
      editValue={value}
      onEditChange={setValue}
      onConfirmEdit={() => {}}
      onCancelEdit={() => {}}
    />
  );
};

describe('FileListItem rename box', () => {
  it('selects the basename once on entering edit mode', () => {
    render(<Harness />);
    const input = screen.getByDisplayValue('results.csv') as HTMLInputElement;
    // name-without-extension selected ("results" = 0..7)
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('results'.length);
  });

  it('does NOT re-select everything on each keystroke', () => {
    render(<Harness />);
    const input = screen.getByDisplayValue('results.csv') as HTMLInputElement;
    // A keystroke: value changes and the browser collapses the caret. Simulate
    // the collapse FIRST, then fire the change — if the select-effect re-runs
    // on editValue (the bug), it re-spreads the selection AFTER this event and
    // the assertion below catches it.
    input.setSelectionRange(1, 1);
    fireEvent.change(input, { target: { value: 'r.csv' } });
    // Read the selection AS THE EFFECT LEFT IT — no manual repositioning here.
    expect(input.selectionEnd).toBe(input.selectionStart); // collapsed = no re-select
  });
});
