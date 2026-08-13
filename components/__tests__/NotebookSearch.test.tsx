import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NotebookSearch } from '../NotebookSearch';

describe('NotebookSearch read-only mode', () => {
  it('keeps search navigation available without exposing replace controls', () => {
    render(
      <NotebookSearch
        cells={[{ id: 'cell-1', type: 'code', content: 'evidence', outputs: [], isExecuting: false }]}
        isOpen
        readOnly
        onClose={vi.fn()}
        onNavigateToCell={vi.fn()}
        onReplace={vi.fn()}
        onReplaceAllInCell={vi.fn()}
        onReplaceAllInNotebook={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText('Search in notebook...')).toBeEnabled();
    expect(screen.queryByTitle('Toggle replace')).not.toBeInTheDocument();
  });
});
