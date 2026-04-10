const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  external: [
    'vscode',
    '@lancedb/lancedb',
    'apache-arrow',
    '@huggingface/transformers',
    'onnxruntime-node',
  ],
  logLevel: 'info',
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
    console.log('[esbuild] Watching for changes...');
  } else {
    await esbuild.build(config);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
