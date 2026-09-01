#!/usr/bin/env node
/**
 * patch-dist.mjs
 *
 * Idempotent post-install patcher for dist/index.cjs that fixes the
 * esbuild bundling bug affecting https-proxy-agent.
 *
 * Background
 * ----------
 * The Lark/Feishu SDK's WSClient reads HTTP(S)_PROXY env vars and
 * constructs an HttpsProxyAgent. esbuild bundles
 * `https-proxy-agent/dist/agent.js` (an ES6 class) AND
 * `https-proxy-agent/dist/index.js` (a factory that does `new agent(...)`).
 *
 * Bug shape (seen in some plugin-cache builds):
 *   var HttpsProxyAgent = require_agent();           // <- ES6 class
 *   ...
 *   agent = HttpsProxyAgent(merged);                 // <- called as fn → throws
 *
 * Fix:
 *   var HttpsProxyAgent = require_dist();            // <- factory, calls new internally
 *
 * This script:
 *   1. Reads dist/index.cjs.
 *   2. Searches for `var <IDENT> = require_agent();` (a non-wrapped usage).
 *   3. For each, verifies the IDENT is used as a function (not `new IDENT`).
 *      If so, replaces `require_agent()` with `require_dist()` on that line.
 *   4. Writes back atomically only if a change was made.
 *   5. Logs what it did (or that no patch was needed).
 *
 * The script is safe to run repeatedly — re-running after a fix is a no-op.
 *
 * Usage:
 *   node scripts/patch-dist.mjs                # patches ./dist/index.cjs
 *   node scripts/patch-dist.mjs --check        # exit 1 if patch needed
 */

import { readFile, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_PATH = resolve(__dirname, '..', 'dist', 'index.cjs');
const CHECK_ONLY = process.argv.includes('--check');

function log(level, msg) {
  process.stderr.write(`[patch-dist] ${level}: ${msg}\n`);
}

async function main() {
  let raw;
  try {
    await access(DIST_PATH);
    raw = await readFile(DIST_PATH, 'utf8');
  } catch (err) {
    log('error', `cannot read ${DIST_PATH}: ${err.message}`);
    process.exit(2);
  }

  // Find every "var IDENT = require_agent();" that is NOT wrapped in
  // __importDefault(...). The internal usage `var agent_1 = __importDefault(require_agent())`
  // is fine because that is the factory module re-importing the class.
  const buggyRe = /^(?!\s*\/\/).*?\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*require_agent\(\s*\)\s*;.*$/gm;
  const matches = [...raw.matchAll(buggyRe)];
  const buggy = matches.filter((m) => !/__importDefault\(\s*require_agent\(\s*\)\s*\)/.test(m[0]));

  if (buggy.length === 0) {
    log('info', 'no buggy `var X = require_agent();` pattern found — already fixed');
    return;
  }

  // For each buggy assignment, confirm the IDENT is used as a function
  // somewhere (i.e. `IDENT(` without a preceding `new `). If only used
  // with `new IDENT(`, the ES6 class is fine and we should not patch.
  const needsPatch = [];
  for (const m of buggy) {
    const ident = m[1];
    const callRe = new RegExp(`(?<!new\\s)\\b${ident}\\s*\\(`, 'g');
    const newRe = new RegExp(`\\bnew\\s+${ident}\\s*\\(`, 'g');
    const callHits = (raw.match(callRe) || []).length;
    const newHits = (raw.match(newRe) || []).length;
    if (callHits > 0 && newHits === 0) {
      needsPatch.push({ line: m[0].trim(), ident, lineNo: lineNumberOf(raw, m.index) });
    } else {
      log('info', `skipping ${ident}: ${callHits} call(s), ${newHits} new(s) — both forms used`);
    }
  }

  if (needsPatch.length === 0) {
    log('info', 'all require_agent() usages are properly used as constructors — no patch needed');
    return;
  }

  if (CHECK_ONLY) {
    log('error', `patch required: ${needsPatch.length} site(s) use require_agent() as function`);
    for (const s of needsPatch) log('error', `  line ~${s.lineNo}: ${s.line}`);
    process.exit(1);
  }

  // Apply patches. Each one replaces only the buggy line — no broad regex.
  let patched = raw;
  let patchedCount = 0;
  for (const site of needsPatch) {
    const before = patched;
    // Replace `var IDENT = require_agent();` -> `var IDENT = require_dist();`
    const siteRe = new RegExp(`(\\bvar\\s+${site.ident}\\s*=\\s*)require_agent(\\s*\\(\\s*\\))`);
    patched = patched.replace(siteRe, (_m, head, tail) => {
      patchedCount += 1;
      return `${head}require_dist${tail}`;
    });
    if (patched === before) {
      log('warn', `could not patch ${site.ident} at line ~${site.lineNo}`);
    }
  }

  if (patchedCount === 0) {
    log('error', 'detected bug but failed to patch — please file a bug');
    process.exit(3);
  }

  // Atomic-ish write: write to .patched, then rename. Avoids half-written dist.
  const tmpPath = DIST_PATH + '.patched';
  await writeFile(tmpPath, patched, 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmpPath, DIST_PATH);

  log('info', `patched ${patchedCount} site(s):`);
  for (const s of needsPatch) log('info', `  line ~${s.lineNo}: var ${s.ident} = require_dist();`);
}

function lineNumberOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

main().catch((err) => {
  log('error', `unexpected failure: ${err.stack || err.message}`);
  process.exit(1);
});
