import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export async function checkWindowsBundle(root) {
  root = resolve(root);
  const source = JSON.parse(await readFile(join(root, 'source-manifest.json'), 'utf8'));
  const runtime = JSON.parse(await readFile(join(root, 'runtime-manifest.json'), 'utf8'));
  const expected = new Set(['source-manifest.json', 'runtime-manifest.json']);
  for (const [section, entries] of [['source', source.files], ['runtime', runtime.files]]) {
    for (const entry of entries) {
      assert(!entry.path.includes('\\') && !entry.path.split('/').some(p => !p || p === '..' || p === '.') && !entry.path.includes(':'), 'Unsafe manifest path');
      if (section === 'runtime') assert((entry.path.startsWith('runtimes/') || entry.path === 'Daymark.exe'), 'Runtime outside its directory');
      else assert(!entry.path.startsWith('runtimes/'), 'Runtime incorrectly marked as source');
      assert(!expected.has(entry.path), 'Duplicate manifest entry');
      expected.add(entry.path);
      const info = await lstat(join(root, entry.path));
      assert(info.isFile() && !info.isSymbolicLink(), 'Linked package file');
      const bytes = await readFile(join(root, entry.path));
      assert.equal(bytes.length, entry.size, 'Wrong size: ' + entry.path);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, 'Wrong digest: ' + entry.path);
    }
  }
  async function walk(folder, prefix = '') {
    for (const file of await readdir(folder, { withFileTypes: true })) {
      const path = prefix + file.name;
      assert(!file.isSymbolicLink(), 'Linked directory: ' + path);
      if (file.isDirectory()) await walk(join(folder, file.name), path + '/');
      else assert(expected.has(path), 'Unexpected package file: ' + path);
    }
  }
  await walk(root);
  for (const path of ['Daymark.exe', 'Start-Daymark.cmd', 'Check-Daymark.cmd', 'QUICKSTART.md', 'tools/windows-client.ps1', 'runtimes/node/node.exe', 'runtimes/node/LICENSE', 'runtimes/python/python.exe', 'runtimes/python/LICENSE.txt', 'runtimes/napcat/NapCatWinBootMain.exe', 'runtimes/napcat/LICENSE', 'runtimes/napcat/DAYMARK-SOURCE.txt']) assert(expected.has(path), 'Missing component: ' + path);
  return { ok: true, sourceFiles: source.files.length, runtimeFiles: runtime.files.length, totalFiles: expected.size };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try { console.log(JSON.stringify(await checkWindowsBundle(process.argv[2] || fileURLToPath(new URL('../', import.meta.url))), null, 2)); }
  catch (error) { console.error('Windows package check failed:', error.message); process.exitCode = 1; }
}
