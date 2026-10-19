import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { NotebookViewer } from './NotebookViewer';
import { parseNotebook } from '../savedNotebook.js';
import css from './viewer.css?inline';
export { parseNotebook };

/** The complete renderer is bundled; the host does not need React, CSS, or a server. */
export function mountNotebook(target:HTMLElement,input:any,options:{title?:string;showCode?:boolean;filename?:string}={}) {
  if(!target?.ownerDocument) throw new TypeError('A DOM container is required');
  parseNotebook(input);
  const doc=target.ownerDocument;
  const host=doc.createElement('div');host.className='nebula-notebook-embed';
  const shadow=host.attachShadow({mode:'open'});
  const style=doc.createElement('style');style.textContent=css;
  const container=doc.createElement('div');shadow.append(style,container);
  target.replaceChildren(host);
  const root=createRoot(container);
  const download=()=>{
    const win=doc.defaultView!;
    const blob=new win.Blob([typeof input==='string'?input:JSON.stringify(input,null,2)],{type:'application/x-ipynb+json'});
    const url=win.URL.createObjectURL(blob),a=doc.createElement('a');
    a.href=url;a.download=options.filename||'notebook.ipynb';a.click();
    win.setTimeout(()=>win.URL.revokeObjectURL(url),1000);
  };
  let visibilityRevision=0;
  const render=(showCode:boolean)=>flushSync(()=>root.render(<NotebookViewer notebook={input} title={options.title} showCode={showCode} visibilityRevision={++visibilityRevision} onDownload={download}/>));
  render(options.showCode!==false);
  let destroyed=false;
  return {element:host,setShowCode(value:boolean){if(!destroyed)render(Boolean(value));},destroy(){if(!destroyed){flushSync(()=>root.unmount());host.remove();destroyed=true;}}};
}
