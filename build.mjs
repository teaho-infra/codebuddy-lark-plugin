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
    // undici is optional at runtime (global fetch dispatcher); resolved from
    // the host Node install when present, skipped silently when not.
    'undici',
  ],
  // Note: the https-proxy-agent bundling alias was needed for v5, whose
  // bare-import could resolve to the ES6 class file that axios then called
  // without `new`. v9 (current) exports a plain factory from "./dist/index.js"
  // and bundles cleanly without the alias; scripts/patch-dist.mjs remains as
  // a safety net if a stale v5 ever reappears.
  logLevel: 'info',
});
