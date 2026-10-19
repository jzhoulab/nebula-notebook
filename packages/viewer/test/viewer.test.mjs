import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {parseNotebook} from '../savedNotebook.js';
const bundle=readFileSync(new URL('../dist/viewer.global.js',import.meta.url),'utf8');
const root=el=>el.querySelector('.nebula-notebook-embed').shadowRoot.querySelector('.nebula-viewer');
const mountNotebook=(el,...args)=>el.ownerDocument.defaultView.NebulaNotebookViewer.mountNotebook(el,...args);

const notebook=()=>({nbformat:4,nbformat_minor:5,metadata:{title:'Audit'},cells:[
  {id:'intro',cell_type:'markdown',metadata:{},source:['# Evidence\n','**Saved** result and [source](https://example.org).']},
  {id:'check',cell_type:'code',metadata:{},source:['print(42)'],execution_count:1,outputs:[{output_type:'stream',name:'stdout',text:['42\n']}]}
]});
const env=()=>{const dom=new JSDOM('<div id="mount"></div>',{url:'https://example.org/',runScripts:'outside-only',pretendToBeVisual:true});dom.window.eval(bundle);return {dom,el:dom.window.document.querySelector('#mount')};};

test('rejects malformed notebooks instead of implying an empty successful run',()=>{
  assert.throws(()=>parseNotebook({cells:[]}),/nbformat/);
  assert.throws(()=>parseNotebook({nbformat:4,cells:'wrong'}),/cells/);
  const n=notebook();n.cells[1].source=19;assert.throws(()=>parseNotebook(n),/source/);
});
test('accepts standard ipynb strings/arrays and preserves the input unchanged',()=>{
  const n=notebook(),before=JSON.stringify(n);const parsed=parseNotebook(JSON.stringify(n));
  assert.equal(parsed.cells[0].source,'# Evidence\n**Saved** result and [source](https://example.org).');
  assert.equal(JSON.stringify(n),before);
});
test('renders saved code, outputs and markdown without any kernel or edit controls',()=>{
  const {dom,el}=env();let network=0;dom.window.fetch=()=>{network++;throw Error('No network');};
  mountNotebook(el,notebook());assert.match(root(el).textContent,/Read-only/);assert.match(root(el).textContent,/42/);
  assert.equal(root(el).querySelectorAll('textarea,input,[contenteditable=true]').length,0);
  assert.equal(root(el).querySelectorAll('button[data-run],button[data-save]').length,0);
  assert.equal(root(el).querySelector('h1').textContent,'Evidence');assert.equal(network,0);dom.window.close();
});
test('never evaluates code cells, script outputs, handler attributes or javascript URLs',()=>{
  const {dom,el}=env();const n=notebook();
  n.cells[0].source='[bad](javascript:alert) <img src=x onerror=alert(1)>';
  n.cells[1].source='globalThis.UNSAFE = true';
  n.cells[1].outputs=[{output_type:'display_data',data:{'text/html':'<script>globalThis.UNSAFE=true</script><table><tr><td onclick="alert(1)">real result</td></tr></table><iframe src="https://bad.example"></iframe>'},metadata:{}}];
  mountNotebook(el,n);assert.equal(dom.window.UNSAFE,undefined);assert.equal(root(el).querySelectorAll('script,iframe,[onclick],[onerror],a[href^="javascript:"]').length,0);assert.equal(root(el).querySelector('td').textContent,'real result');dom.window.close();
});
test('prefers a saved raster fallback over active Nebula/Plotly/widget payloads',()=>{
  const {dom,el}=env();const n=notebook();n.cells[1].outputs=[{output_type:'display_data',data:{'application/vnd.nebula.web+json':{js:'throw Error()'},'image/png':'aGVsbG8=','text/plain':'Figure'},metadata:{}}];
  mountNotebook(el,n);assert.match(root(el).querySelector('img').src,/^data:image\/png;base64,/);assert.equal(root(el).querySelector('img').alt,'Saved notebook output');dom.window.close();
});
test('read-only code visibility is local to the viewer, and destroy removes its listeners/content',()=>{
  const {dom,el}=env();const n=notebook(),before=JSON.stringify(n);const viewer=mountNotebook(el,n,{showCode:false});
  assert.equal(root(el).querySelectorAll('[data-code-source]').length,0);viewer.setShowCode(true);assert.equal(root(el).querySelectorAll('[data-code-source]').length,1);
  assert.equal(JSON.stringify(n),before);viewer.destroy();assert.equal(el.childElementCount,0);dom.window.close();
});
test('retains unexecuted and error states instead of presenting them as completed checks',()=>{
  const {dom,el}=env();const n=notebook();n.cells[1].execution_count=null;n.cells[1].outputs=[{output_type:'error',ename:'ValueError',evalue:'bad key',traceback:['ValueError: bad key']}];
  mountNotebook(el,n);assert.match(root(el).textContent,/Not executed/);assert.match(root(el).textContent,/ValueError: bad key/);dom.window.close();
});
test('bounds displayed output and does not silently discard the underlying notebook',()=>{
  const {dom,el}=env();const n=notebook();n.cells[1].outputs[0].text='z'.repeat(200001);const viewer=mountNotebook(el,n);
  assert.match(root(el).textContent,/Display truncated/);assert.ok(root(el).textContent.length<110000);assert.equal(n.cells[1].outputs[0].text.length,200001);viewer.destroy();dom.window.close();
});
test('an explicit visibility call restores code after a reader toggles it off',()=>{
  const {dom,el}=env();const viewer=mountNotebook(el,notebook());
  [...root(el).querySelectorAll('button')].find(b=>b.textContent.trim()==='Hide code').click();
  return new Promise(resolve=>dom.window.setTimeout(resolve,0)).then(()=>{
    assert.equal(root(el).querySelectorAll('[data-code-source]').length,0);
    viewer.setShowCode(true);
    assert.equal(root(el).querySelectorAll('[data-code-source]').length,1);
    viewer.destroy();dom.window.close();
  });
});
test('the embed contains its styles and does not inject host styles or backend resources',()=>{
  const {dom,el}=env();const viewer=mountNotebook(el,notebook());
  assert.ok(viewer.element.shadowRoot.querySelector('style').textContent.includes('.text-purple-600'));
  assert.equal(dom.window.document.querySelectorAll('style,link,script,iframe').length,0);
  assert.equal(root(el).querySelectorAll('script,iframe').length,0);
  viewer.destroy();dom.window.close();
});
