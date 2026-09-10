import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The server renderer, prebuilt (#45).
 *
 * **Why this is a separate build rather than something wrangler compiles.**
 * Wrangler passes esbuild its own `--jsx-factory` unconditionally, which forces
 * the *classic* JSX transform regardless of what any `tsconfig.json` says. The
 * components import no `React` binding — nothing written this decade does —
 * so every one of them failed at runtime with `React is not defined`, silently,
 * into the fallback that serves the plain shell.
 *
 * Vite already knows how to compile these files, because it compiles them for
 * the browser. So it compiles them once more for the server, and wrangler is
 * handed JavaScript with no JSX left in it (`wrangler.jsonc` aliases `#ssr` to
 * the output). One toolchain owns the transform, which is also why the two
 * builds cannot disagree about it.
 *
 * `dist/ssr` is an intermediate: wrangler inlines it into the Worker bundle at
 * deploy time, so nothing is served from it.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    ssr: 'app/server.tsx',
    outDir: 'dist/ssr',
    emptyOutDir: true,
    // Readable in a stack trace, and wrangler minifies the Worker anyway.
    minify: false,
    rollupOptions: {
      output: { format: 'es', entryFileNames: 'server.js' },
    },
  },
  ssr: {
    // Workers, not Node: no `node:` builtins reached for, and `react-dom`
    // resolved to the build meant for a runtime that is neither a browser nor
    // Node. Left external so wrangler bundles them from node_modules, where
    // its own resolution and dedupe apply.
    target: 'webworker',
    external: ['react', 'react-dom', 'react-dom/server'],
  },
})
