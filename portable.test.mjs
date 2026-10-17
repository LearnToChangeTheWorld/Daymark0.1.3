import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { resolveWechatPython } from '../collector/wechat.mjs';
import { defaultNapcatDirectory } from '../collector/napcat.mjs';
import { checkWindowsBundle } from '../tools/check-windows-bundle.mjs';

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'daymark-portable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const quoted = value => "'" + value.replaceAll("'", "''") + "'";
const common = fileURLToPath(new URL('../tools/runtime-common.ps1', import.meta.url));
function powershell(code) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `. ${quoted(common)}; ${code}`], { encoding: 'utf8', timeout: 15000, stdio: 'pipe' });
}

test('private chat runtimes take precedence, explicit Python paths remain explicit, old installs still work', async t => {
  const root = await temporary(t);
  await assert.rejects(resolveWechatPython({ root, override: '' }), error => error.code === 'component_missing');
  const old = join(root, '.venv-wechat/Scripts/python.exe');
  await mkdir(join(root, '.venv-wechat/Scripts'), { recursive: true }); await writeFile(old, 'synthetic');
  assert.equal(await resolveWechatPython({ root, override: '' }), old);
  const current = join(root, 'runtimes/python/python.exe');
  await mkdir(join(root, 'runtimes/python'), { recursive: true }); await writeFile(current, 'synthetic');
  assert.equal(await resolveWechatPython({ root, override: '' }), current);
  assert.equal(await resolveWechatPython({ root, override: old }), old);
  await assert.rejects(resolveWechatPython({ root, override: join(root, 'missing.exe') }), error => error.code === 'component_missing');
  assert.equal(defaultNapcatDirectory(root), join(root, 'vendor/napcat'));
  await mkdir(join(root, 'runtimes/napcat'), { recursive: true }); await writeFile(join(root, 'runtimes/napcat/NapCatWinBootMain.exe'), 'synthetic');
  assert.equal(defaultNapcatDirectory(root), join(root, 'runtimes/napcat'));
});

test('offline setup refuses missing or altered dependency archives', { skip: process.platform !== 'win32' }, async t => {
  const root = await temporary(t);
  const code = `Get-DaymarkDownload ([pscustomobject]@{file='synthetic.zip';url='https://invalid.example/synthetic.zip';sha256='${'0'.repeat(64)}'}) ${quoted(root)} -Offline`;
  assert.throws(() => powershell(code), error => /Offline dependency is missing/.test(error.stderr));
  await writeFile(join(root, 'synthetic.zip'), 'altered synthetic archive');
  assert.throws(() => powershell(code), error => /checksum mismatch/.test(error.stderr));
});

test('runtime ZIP extraction rejects paths outside its destination', { skip: process.platform !== 'win32' }, async t => {
  const root = await temporary(t);
  const archive = join(root, 'bad.zip'), destination = join(root, 'runtime');
  const code = `$z=[IO.Compression.ZipFile]::Open(${quoted(archive)},[IO.Compression.ZipArchiveMode]::Create); $e=$z.CreateEntry('../escaped.txt'); $s=New-Object IO.StreamWriter($e.Open()); $s.Write('synthetic'); $s.Dispose(); $z.Dispose(); Expand-DaymarkArchive ${quoted(archive)} ${quoted(destination)}`;
  assert.throws(() => powershell(code), error => /escapes its destination/.test(error.stderr));
  await assert.rejects(access(join(root, 'escaped.txt')), { code: 'ENOENT' });
});

test('Windows package check rejects altered binaries and files outside the release manifests', async t => {
  const root = await temporary(t);
  const paths = ['Daymark.exe', 'Start-Daymark.cmd', 'Check-Daymark.cmd', 'QUICKSTART.md', 'tools/windows-client.ps1', 'runtimes/node/node.exe', 'runtimes/node/LICENSE', 'runtimes/python/python.exe', 'runtimes/python/LICENSE.txt', 'runtimes/napcat/NapCatWinBootMain.exe', 'runtimes/napcat/LICENSE', 'runtimes/napcat/DAYMARK-SOURCE.txt'];
  const entries = [];
  for (const path of paths) {
    const bytes = Buffer.from('Synthetic package fixture: ' + path);
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), bytes);
    entries.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await writeFile(join(root, 'source-manifest.json'), JSON.stringify({ files: entries.filter(file => !file.path.startsWith('runtimes/') && file.path !== 'Daymark.exe') }));
  await writeFile(join(root, 'runtime-manifest.json'), JSON.stringify({ files: entries.filter(file => file.path.startsWith('runtimes/') || file.path === 'Daymark.exe') }));
  assert.equal((await checkWindowsBundle(root)).ok, true);
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data/private.json'), 'synthetic unwanted user data');
  await assert.rejects(checkWindowsBundle(root), /Unexpected package file/);
  await rm(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'runtimes/node/node.exe'), 'altered synthetic binary');
  await assert.rejects(checkWindowsBundle(root), /Wrong (?:size|digest)/);
});
