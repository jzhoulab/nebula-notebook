import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import {shadowCss} from './shadow-css.mjs';

export default defineConfig({
  plugins:[react(),tailwindcss(),{
    name:'viewer-runtime-boundary',
    generateBundle(_options,bundle) {
      const forbidden=[...this.getModuleIds()].filter(id=>/\/(services|node-server|packages\/autocomplete)\//.test(id));
      if(forbidden.length) throw new Error(`Viewer includes execution services: ${forbidden.join(', ')}`);
    }
  }],
  css:{postcss:{plugins:[shadowCss()]}},
  define:{'process.env.NODE_ENV':JSON.stringify('production')},
  build:{outDir:path.resolve(__dirname,'dist'),emptyOutDir:true,minify:'esbuild',
    lib:{entry:path.resolve(__dirname,'src/index.tsx'),name:'NebulaNotebookViewer',formats:['es','iife'],fileName:format=>format==='es'?'index.js':'viewer.global.js'},
  },
});
