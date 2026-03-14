const { build } = require('esbuild');
const { cpSync } = require('fs');
const path = require('path');

const distRenderer = path.join(__dirname, '..', 'dist', 'renderer');

// Bundle renderer TS into a single IIFE
build({
  entryPoints: [path.join(__dirname, '..', 'src', 'renderer', 'app.ts')],
  bundle: true,
  outfile: path.join(distRenderer, 'app.js'),
  platform: 'browser',
  format: 'iife',
  sourcemap: true,
  external: [], // everything is bundled
  define: {
    'process.env.NODE_ENV': '"production"',
  },
}).then(() => {
  // Copy static files
  cpSync(
    path.join(__dirname, '..', 'src', 'renderer', 'index.html'),
    path.join(distRenderer, 'index.html'),
  );
  cpSync(
    path.join(__dirname, '..', 'src', 'renderer', 'styles.css'),
    path.join(distRenderer, 'styles.css'),
  );
  console.log('[build] Renderer bundled successfully');
}).catch((err) => {
  console.error('[build] Renderer bundle failed:', err);
  process.exit(1);
});
