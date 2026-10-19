import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { NotebookViewer } from '../../packages/viewer/src/NotebookViewer';

const notebook = () => ({nbformat:4, metadata:{title:'Evidence audit',language_info:{name:'python'}}, cells:[
  {cell_type:'markdown', source:'# Evidence\n\n**Saved** output and *context*.\n\n![remote](https://example.org/tracking.png)', metadata:{}},
  {cell_type:'code', source:'print(42) # verified', execution_count:1, metadata:{custom:'preserve'}, outputs:[{output_type:'stream',name:'stdout',text:'42\n'}]},
  {cell_type:'code',source:'raise ValueError()',execution_count:null,metadata:{},outputs:[{output_type:'error',ename:'ValueError',evalue:'bad key',traceback:['ValueError: bad key']}]}
]});

describe('Nebula embeddable reading view', () => {
  it('uses Nebula markdown and syntax presentation with saved execution states', () => {
    const {container}=render(<NotebookViewer notebook={notebook()} />);
    expect(screen.getByRole('heading',{name:'Evidence',level:1})).toBeInTheDocument();
    expect(container.querySelector('em')?.textContent).toBe('context');
    expect(container.querySelector('.text-blue-600')?.textContent).toBe('print');
    expect(container.querySelector('.text-orange-500')?.textContent).toBe('42');
    expect(screen.getByText('Not executed')).toBeInTheDocument();
    expect(screen.getByText('ValueError: bad key')).toBeInTheDocument();
    expect(container.querySelector('textarea,[contenteditable="true"],img[src^="https:"]')).toBeNull();
    expect(screen.queryByRole('button',{name:/Run cell|Save notebook/i})).not.toBeInTheDocument();
  });
  it('hides and restores sources without changing the notebook or losing outputs', () => {
    const n=notebook(),before=JSON.stringify(n);
    const {container}=render(<NotebookViewer notebook={n} />);
    fireEvent.click(screen.getByRole('button',{name:'Hide code'}));
    expect(container.querySelectorAll('[data-code-source]')).toHaveLength(0);
    expect(screen.getByText('42')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Show code'}));
    expect(container.querySelectorAll('[data-code-source]')).toHaveLength(2);
    expect(JSON.stringify(n)).toBe(before);
  });
  it('preserves the full notebook for download, including unknown metadata and MIME payloads', () => {
    const n=notebook();const onDownload=vi.fn();
    render(<NotebookViewer notebook={n} onDownload={onDownload} />);
    fireEvent.click(screen.getByRole('button',{name:'Download .ipynb'}));
    expect(onDownload).toHaveBeenCalledOnce();
    expect(n.cells[1].metadata.custom).toBe('preserve');
  });
  it('renders inert tables and raster fallbacks without executing active output payloads', () => {
    const n=notebook();n.cells[1].outputs=[{output_type:'display_data',data:{'text/html':'<script>window.UNSAFE=true</script><table><tr><td onclick="alert(1)">measured</td></tr></table><iframe src="https://evil.example"></iframe>'}}] as any;
    const {container}=render(<NotebookViewer notebook={n} />);
    expect(container.querySelector('td')?.textContent).toBe('measured');
    expect(container.querySelector('script,iframe,[onclick]')).toBeNull();
    expect((window as any).UNSAFE).toBeUndefined();
  });
});
