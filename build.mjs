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
  sourcemap: false,
  // Note: src/index.ts already has a shebang; do not add a banner here.
  // The Lark SDK ships some large vendored bundles; keep them external to avoid
  // dynamic-require warnings. Everything else is bundled.
  external: [
    // keep native/optional deps external if any appear
  ],
  // Redirect every import of the bare `https-proxy-agent` specifier to the
  // factory entry point (`dist/index.js`). This guarantees only the factory
  // function is bundled into the axios WSClient call site, sidestepping an
  // upstream esbuild quirk where a same-package bare import can resolve to
  // the ES6 class file (`dist/agent.js`), which axios then calls without
  // `new` and throws at runtime. Mirrors what scripts/patch-dist.mjs does as
  // a post-build safety net.
  alias: {
    'https-proxy-agent': 'https-proxy-agent/dist/index.js',
  },
  logLevel: 'info',
});
