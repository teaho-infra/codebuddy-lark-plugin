import { mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = resolve(root, 'release');
const output = resolve(releaseDir, 'codebuddy-lark-plugin.tgz');

await mkdir(releaseDir, { recursive: true });
await rm(output, { force: true });

// Keep credentials, dependencies, VCS metadata, and local media out of the
// distributable. dist/index.cjs is self-contained.
const args = [
  '-czf',
  output,
  '--exclude=.env',
  '--exclude=.git',
  '--exclude=node_modules',
  '--exclude=release',
  '--exclude=.lark-media',
  '--exclude=dist/*.map',
  '-C',
  root,
  '.codebuddy-plugin',
  'dist/index.cjs',
  'README.md',
  'LICENSE',
  'package.json',
];

await new Promise((resolvePromise, reject) => {
  const child = spawn('tar', args, { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code) => {
    if (code === 0) resolvePromise();
    else reject(new Error(`tar exited with code ${code}`));
  });
});

process.stdout.write(`${output}\n`);
