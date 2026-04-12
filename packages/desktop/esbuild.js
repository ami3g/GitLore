const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  external: [
    'electron',
    '@lancedb/lancedb',
    'apache-arrow',
    '@huggingface/transformers',
    'onnxruntime-node',
    'web-tree-sitter',
  ],
  logLevel: 'info',
};

async function main() {
  // Bundle main process
  const mainConfig = {
    ...shared,
    entryPoints: ['main/electron.ts'],
    outfile: 'dist/electron.js',
  };

  // Bundle preload script
  const preloadConfig = {
    ...shared,
    entryPoints: ['main/preload.ts'],
    outfile: 'dist/preload.js',
  };

  if (watch) {
    const mainCtx = await esbuild.context(mainConfig);
    const preloadCtx = await esbuild.context(preloadConfig);
    await mainCtx.watch();
    await preloadCtx.watch();
    console.log('[esbuild] Watching main + preload for changes...');
  } else {
    await esbuild.build(mainConfig);
    await esbuild.build(preloadConfig);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
