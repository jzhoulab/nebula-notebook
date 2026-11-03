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
    expect(container.querySelector('[class~="text-[#164]"]')?.textContent).toBe('42');
    expect(screen.getByText('Not executed')).toBeInTheDocument();
    expect(screen.getByText('ValueError: bad key')).toBeInTheDocument();
    expect(container.querySelector('textarea,[contenteditable="true"],img[src^="https:"]')).toBeNull();
    expect(screen.queryByRole('button',{name:/Run cell|Save notebook/i})).not.toBeInTheDocument();
  });
  it('colors Python the way the notebook editor renders it', () => {
    const n=notebook();n.cells[1].source='@wrap\ndef f(x):\n    return None # done\nclass K: pass\nprint("s", 1)';n.cells.pop();
    const {container}=render(<NotebookViewer notebook={n} />);
    const text=(color:string)=>[...container.querySelectorAll(`[class~="text-[${color}]"]`)].map(e=>e.textContent);
    expect(text('#708')).toEqual(['def','return','class','pass']);
    expect(text('#00f')).toEqual(['f']);
    expect(text('#167')).toEqual(['K']);
    expect(text('#219')).toEqual(['None']);
    expect(text('#940')).toEqual(['# done']);
    expect(text('#a11')).toEqual(['"s"']);
    expect(text('#164')).toEqual(['1']);
    expect(text('#404740')).toEqual(['@wrap']);
  });
  it('uses the notebook cell chrome: type pill, error border and output area', () => {
    const {container}=render(<NotebookViewer notebook={notebook()} />);
    const cells=container.querySelectorAll('[data-cell-index]');
    expect(cells[1].className).toContain('hover:border-slate-300');
    expect(cells[2].className).toContain('border-red-200');
    expect(screen.getAllByText('Code')[0].className).toContain('shadow-sm');
    expect(screen.queryByText('Saved output')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Saved outputs for cell 2').className).toContain('p-4');
    expect(screen.getByLabelText('Saved outputs for cell 2').parentElement?.className).toContain('border-t');
  });
  it('bounds collapsed outputs in the notebook gutter style rather than removing them', () => {
    const n=notebook();(n.cells[1].metadata as any).scrolled=true;
    render(<NotebookViewer notebook={n} />);
    const toggle=screen.getByRole('button',{name:'Expand saved output for cell 2'});
    expect(toggle.className).toContain('w-6');
    expect(screen.getByLabelText('Saved outputs for cell 2').style.maxHeight).not.toBe('');
    expect(screen.getByText('42',{selector:'pre'})).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByLabelText('Saved outputs for cell 2').style.maxHeight).toBe('');
    expect(screen.getByRole('button',{name:'Collapse saved output for cell 2'})).toHaveAttribute('aria-expanded','true');
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
