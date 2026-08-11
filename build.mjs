import { build } from 'esbuild';

// Bundle the channel server into a single CJS file so the bin shim works
// regardless of ESM resolution quirks. tsc currently segfaults on the
// @larksuiteoapi/node-sdk type graph in this environment; esbuild is used as
// the reliable build path.
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/index.cjs',
  sourcemap: true,
  // Note: src/index.ts already has a shebang; do not add a banner here.
  // The Lark SDK ships some large vendored bundles; keep them external to avoid
  // dynamic-require warnings. Everything else is bundled.
  external: [
    // keep native/optional deps external if any appear
  ],
  logLevel: 'info',
});
