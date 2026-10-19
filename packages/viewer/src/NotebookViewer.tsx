import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Code, FileText, LockKeyhole, List, Download, ChevronsDownUp, ChevronsUpDown, ChevronDown, ChevronRight } from 'lucide-react';
import { MarkdownPreview } from '../../../components/MarkdownPreview';
import { PythonHighlighter } from '../../../components/PythonHighlighter';
import { CELL_FRAME, CELL_TOOLBAR, CELL_INDEX } from '../../../lib/notebookPresentation';
import { parseNotebook, renderOutput } from '../savedNotebook.js';

interface Props {notebook:any; title?:string; showCode?:boolean; visibilityRevision?:number; onDownload?:()=>void}
const button = 'nb-button inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100';

function SavedOutput({output}: {output:any}) {
  const target=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    const el=target.current!;
    el.replaceChildren(renderOutput(el.ownerDocument,output));
    return ()=>el.replaceChildren();
  },[output]);
  return <div ref={target} />;
}

function ReadingCell({cell,index,showCode,language,visibilityRevision}: {cell:any;index:number;showCode:boolean;language:string;visibilityRevision:number}) {
  const [sourceOpen,setSourceOpen]=useState(showCode);
  const [outputOpen,setOutputOpen]=useState(cell.metadata?.scrolled!==true);
  useLayoutEffect(()=>setSourceOpen(showCode),[showCode,visibilityRevision]);
  const isCode=cell.cell_type==='code';
  return <article data-cell-index={index} className={`${CELL_FRAME} nb-cell border-slate-200`}>
    <div className={`${CELL_TOOLBAR} rounded-t-lg`}>
      <span className={CELL_INDEX}>#{index+1}</span>
      {isCode && <span className={`font-mono text-xs ${cell.execution_count==null?'text-slate-400':'text-green-600'}`} title="Saved execution count">{cell.execution_count==null?'[ ]':`[${cell.execution_count}]`}</span>}
      {isCode && cell.execution_count==null && <span className="text-xs text-slate-400">Not executed</span>}
      <span className="flex-1" />
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs text-slate-600">{isCode?<Code size={13}/>:<FileText size={13}/>} {isCode?'Code':cell.cell_type==='markdown'?'Text':'Raw'}</span>
      {cell.cell_type!=='markdown' && <button type="button" className="nb-icon-button text-slate-400 hover:bg-blue-50 hover:text-blue-600" aria-expanded={sourceOpen} aria-label={`${sourceOpen?'Hide':'Show'} source for cell ${index+1}`} onClick={()=>setSourceOpen(!sourceOpen)}>{sourceOpen?<ChevronsDownUp size={14}/>:<ChevronsUpDown size={14}/>}</button>}
    </div>
    {cell.cell_type==='markdown'?<MarkdownPreview content={cell.source} allowImages={false}/>:sourceOpen && <div data-code-source className="nb-source px-3 py-2">{isCode && language==='python'?<PythonHighlighter code={cell.source}/>:<pre className="font-mono text-sm leading-6 whitespace-pre-wrap break-words text-slate-800">{cell.source}</pre>}</div>}
    {!!cell.outputs.length && <div className="border-t border-slate-100">
      <button type="button" className="nb-output-toggle flex items-center gap-1 px-3 py-1 text-xs text-slate-500" aria-expanded={outputOpen} onClick={()=>setOutputOpen(!outputOpen)}>{outputOpen?<ChevronDown size={12}/>:<ChevronRight size={12}/>} Saved output</button>
      {outputOpen && <div className="nb-outputs px-3 pb-3" aria-label={`Saved outputs for cell ${index+1}`}>{cell.outputs.map((o:any,i:number)=><SavedOutput output={o} key={i}/>)}</div>}
    </div>}
  </article>;
}

export function NotebookViewer({notebook,title,showCode=true,visibilityRevision=0,onDownload}: Props) {
  const parsed=useMemo(()=>parseNotebook(notebook),[notebook]);
  const [showSources,setShowSources]=useState(showCode);
  const [contentsOpen,setContentsOpen]=useState(false);
  useLayoutEffect(()=>setShowSources(showCode),[showCode,visibilityRevision]);
  const root=useRef<HTMLElement>(null);
  const headings=parsed.cells.flatMap((c:any,index:number)=>{
    const match=c.cell_type==='markdown' && /^#{1,3}\s+(.+)$/m.exec(c.source);
    return match?[{index,title:match[1]}]:[];
  });
  const language=String(parsed.metadata.language_info?.name || parsed.metadata.kernelspec?.language || 'python').toLowerCase();
  return <section ref={root} className="nebula-viewer bg-slate-50 text-slate-800" aria-label="Nebula read-only notebook">
    <header className="nb-toolbar border-b border-slate-200 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <FileText size={19} className="text-slate-500"/>
        <h2 className="min-w-0 break-words text-lg font-bold tracking-tight">{title || parsed.metadata.title || 'Untitled notebook'}</h2>
        <span className="rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-xs text-slate-400">.ipynb</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-500"><span>Nebula Notebook</span><span className="inline-flex items-center gap-1 text-indigo-500"><LockKeyhole size={12}/> Read-only · saved outputs</span><span>{language} · {parsed.cells.length} cells</span></div>
    </header>
    <div className="nb-controls flex flex-wrap gap-2 border-b border-slate-200 px-4 py-2">
      <button type="button" className={button} aria-expanded={contentsOpen} onClick={()=>setContentsOpen(!contentsOpen)}><List size={14}/>Contents</button>
      <button type="button" className={button} onClick={()=>setShowSources(!showSources)}>{showSources?<ChevronsDownUp size={14}/>:<ChevronsUpDown size={14}/>} {showSources?'Hide code':'Show code'}</button>
      {onDownload && <button type="button" className={button} onClick={onDownload}><Download size={14}/>Download .ipynb</button>}
    </div>
    <div className={`nb-reading-layout ${contentsOpen?'nb-with-contents':''}`}>
      {contentsOpen && <nav className="nb-contents text-sm" aria-label="Notebook contents">{headings.length?headings.map((h:any)=><button className="nb-section-link" key={h.index} onClick={()=>root.current?.querySelector(`[data-cell-index="${h.index}"]`)?.scrollIntoView({block:'start'})}>{h.title}</button>):<p>No section headings</p>}</nav>}
      <div className="nb-pages">{parsed.cells.map((cell:any,index:number)=><ReadingCell key={index} cell={cell} index={index} showCode={showSources} visibilityRevision={visibilityRevision} language={language}/>)}</div>
    </div>
  </section>;
}
