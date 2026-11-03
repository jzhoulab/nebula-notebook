import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Code, FileText, LockKeyhole, List, Download, ChevronsDownUp, ChevronsUpDown, ChevronDown, ChevronRight } from 'lucide-react';
import { MarkdownPreview } from '../../../components/MarkdownPreview';
import { PythonHighlighter } from '../../../components/PythonHighlighter';
import { CELL_FRAME, CELL_TOOLBAR, CELL_INDEX } from '../../../lib/notebookPresentation';
import { OUTPUT_DEFAULT_HEIGHT_PX } from '../../../config/display.config';
import { parseNotebook, renderOutput } from '../savedNotebook.js';

interface Props {notebook:any; title?:string; showCode?:boolean; visibilityRevision?:number; onDownload?:()=>void}
const button = 'nb-button flex items-center gap-2 px-2 sm:px-3 py-1.5 rounded-md hover:bg-slate-200 text-slate-600 text-xs font-medium transition-colors';
const icon = 'w-4 h-4';
const COUNTER = 'text-[0.625rem] font-mono';

function SavedOutput({output}: {output:any}) {
  const target=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    const el=target.current!;
    el.replaceChildren(renderOutput(el.ownerDocument,output));
    return ()=>el.replaceChildren();
  },[output]);
  return <div ref={target} />;
}

function SavedOutputs({cell,index}: {cell:any;index:number}) {
  const [collapsed,setCollapsed]=useState(cell.metadata?.scrolled===true);
  const [tall,setTall]=useState(cell.metadata?.scrolled===true);
  const content=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    const el=content.current!;
    const measure=()=>{ if(el.scrollHeight>OUTPUT_DEFAULT_HEIGHT_PX) setTall(true); };
    measure();
    if(typeof ResizeObserver==='undefined') return;
    const observer=new ResizeObserver(measure);
    Array.from(el.children).forEach(child=>observer.observe(child));
    return ()=>observer.disconnect();
  },[cell.outputs]);
  const foldable=tall;
  return <div className="relative border-t border-slate-100 rounded-b-lg bg-white">
    {foldable && <button type="button" className="absolute left-0 top-0 bottom-0 w-6 flex items-start pt-3 justify-center cursor-pointer hover:bg-slate-100 transition-colors z-20 border-r border-slate-100" aria-expanded={!collapsed} aria-label={`${collapsed?'Expand':'Collapse'} saved output for cell ${index+1}`} onClick={()=>setCollapsed(!collapsed)}>{collapsed?<ChevronRight className="w-4 h-4 text-slate-400"/>:<ChevronDown className="w-4 h-4 text-slate-400"/>}</button>}
    <div ref={content} className={`nb-outputs p-4 ${foldable?'pl-8':''}`} style={collapsed?{maxHeight:OUTPUT_DEFAULT_HEIGHT_PX}:undefined} aria-label={`Saved outputs for cell ${index+1}`}>{cell.outputs.map((o:any,i:number)=><SavedOutput output={o} key={i}/>)}</div>
  </div>;
}

function ReadingCell({cell,index,showCode,language,visibilityRevision}: {cell:any;index:number;showCode:boolean;language:string;visibilityRevision:number}) {
  const [sourceOpen,setSourceOpen]=useState(showCode);
  useLayoutEffect(()=>setSourceOpen(showCode),[showCode,visibilityRevision]);
  const isCode=cell.cell_type==='code';
  const hasError=cell.outputs.some((o:any)=>o.output_type==='error');
  return <article data-cell-index={index} className={`${CELL_FRAME} nb-cell ${hasError?'border-red-200':'border-slate-200 hover:border-slate-300'}`}>
    <div className={`${CELL_TOOLBAR} rounded-t-lg`}>
      <span className={CELL_INDEX}>#{index+1}</span>
      {isCode && <span className={`${COUNTER} ${cell.execution_count==null?'text-slate-400':'text-green-600'}`} title="Saved execution count">{cell.execution_count==null?'[ ]':`[${cell.execution_count}]`}</span>}
      {isCode && cell.execution_count==null && <span className="text-[0.625rem] text-slate-400">Not executed</span>}
      {cell.cell_type!=='markdown' && <button type="button" className="p-1 rounded cursor-pointer transition-colors text-slate-400 hover:text-blue-600 hover:bg-blue-50" aria-expanded={sourceOpen} aria-label={`${sourceOpen?'Hide':'Show'} source for cell ${index+1}`} onClick={()=>setSourceOpen(!sourceOpen)}>{sourceOpen?<ChevronsDownUp className="w-3.5 h-3.5"/>:<ChevronsUpDown className="w-3.5 h-3.5"/>}</button>}
      <span className="flex-1" />
      <span className="text-[0.625rem] px-1.5 py-0.5 rounded flex items-center gap-0.5 bg-white shadow-sm text-slate-800 font-medium">{isCode?<Code className="w-3 h-3"/>:<FileText className="w-3 h-3"/>} {isCode?'Code':cell.cell_type==='markdown'?'Text':'Raw'}</span>
    </div>
    {cell.cell_type==='markdown'?<MarkdownPreview content={cell.source} allowImages={false}/>:sourceOpen && <div data-code-source className="nb-source px-3 py-2">{isCode && language==='python'?<PythonHighlighter code={cell.source}/>:<pre className="font-mono text-sm whitespace-pre-wrap break-words">{cell.source}</pre>}</div>}
    {!!cell.outputs.length && <SavedOutputs cell={cell} index={index}/>}
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
  return <section ref={root} className="nebula-viewer bg-slate-50" aria-label="Nebula read-only notebook">
    <header className="bg-slate-50/90 py-3 border-b border-slate-200 px-4">
      <div className="flex flex-wrap justify-between items-start gap-3 max-w-5xl mx-auto w-full min-w-0">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2 min-w-0"><span className="px-1 min-w-0 break-words">{title || parsed.metadata.title || 'Untitled notebook'}</span><span className="text-xs font-normal text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">.ipynb</span></h2>
          <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-slate-500"><span className="flex items-center gap-1.5 font-medium text-indigo-500"><LockKeyhole className="w-3 h-3"/> Read-only · saved outputs</span><span>{language} · {parsed.cells.length} cells</span></div>
        </div>
        <div className="nb-controls flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
          <button type="button" className={button} aria-expanded={contentsOpen} onClick={()=>setContentsOpen(!contentsOpen)}><List className={icon}/>Contents</button>
          <button type="button" className={button} onClick={()=>setShowSources(!showSources)}>{showSources?<ChevronsDownUp className={icon}/>:<ChevronsUpDown className={icon}/>} {showSources?'Hide code':'Show code'}</button>
          {onDownload && <button type="button" className={button} onClick={onDownload}><Download className={icon}/>Download .ipynb</button>}
        </div>
      </div>
    </header>
    <div className={`nb-reading-layout ${contentsOpen?'nb-with-contents':''}`}>
      {contentsOpen && <nav className="nb-contents text-sm" aria-label="Notebook contents">{headings.length?headings.map((h:any)=><button className="nb-section-link" key={h.index} onClick={()=>root.current?.querySelector(`[data-cell-index="${h.index}"]`)?.scrollIntoView({block:'start'})}>{h.title}</button>):<p>No section headings</p>}</nav>}
      <div className="nb-pages max-w-5xl mx-auto w-full min-w-0 px-4">{parsed.cells.map((cell:any,index:number)=><ReadingCell key={index} cell={cell} index={index} showCode={showSources} visibilityRevision={visibilityRevision} language={language}/>)}</div>
    </div>
  </section>;
}
