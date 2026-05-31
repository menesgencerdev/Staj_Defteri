const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

const stripQueryPlugin = {
  name: 'strip-query-from-local-imports',
  setup(build) {
    build.onResolve({ filter: /^\.\// }, args => {
      const clean = args.path.split('?')[0];
      return { path: path.resolve(args.resolveDir, clean) };
    });
    build.onResolve({ filter: /^https?:\/\// }, args => ({ path: args.path, external: true }));
  }
};

async function bundle(entry, outfile) {
  await esbuild.build({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(dist, outfile),
    bundle: true,
    format: 'esm',
    target: ['es2020'],
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    plugins: [stripQueryPlugin]
  });
}

(async () => {
  await bundle('auth.js', 'auth.bundle.js');
  await bundle('register.js', 'register.bundle.js');
  await bundle('panel.js', 'panel.bundle.js');
  await bundle('gunluk.js', 'gunluk.bundle.js');
  await bundle('toplantilar.js', 'toplantilar.bundle.js');
})();

