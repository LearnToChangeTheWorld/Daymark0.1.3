// Run against an EXTRACTED release in a disposable directory, never a live profile.
// Uses an isolated empty profile and a PATH with no system Node/Python.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const root = resolve(process.argv[2] || '');
assert(process.argv[2], 'Pass the extracted complete package directory');
assert(process.platform === 'win32', 'Run on Windows');
const data = await mkdtemp(join(tmpdir(), 'daymark-launch-check-'));
const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port; await new Promise(r => probe.close(r));
const system = process.env.SystemRoot || 'C:\\Windows';
const environment = { ...process.env, PATH: join(system, 'System32') + ';' + join(system, 'System32/WindowsPowerShell/v1.0'), PORT: String(port), STUDENT_INBOX_DATA_DIR: data };
// Do not inherit overrides from the maintainer's active project.
delete environment.STUDENT_INBOX_PYTHON_PATH;
delete environment.STUDENT_INBOX_QQ_PATH;
delete environment.STUDENT_INBOX_WECHAT_PATH;
let output = '';
const child = spawn(join(system, 'System32/cmd.exe'), ['/d', '/c', 'Start-Daymark.cmd -NoBrowser -Offline'], { cwd: root, windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
try {
  for (let attempt = 0; attempt < 150 && !/Access code:/.test(output); attempt++) {
    if (child.exitCode !== null) throw new Error('Launcher exited before printing an access code. Inspect the disposable package manually.');
    await new Promise(r => setTimeout(r, 200));
  }
  const code = output.match(/Access code: ([\w-]+)/)?.[1]; assert(code, 'Access code was not printed');
  const base = 'http://127.0.0.1:' + port;
  assert.equal((await fetch(base + '/api/health')).status, 200);
  const paired = await fetch(base + '/api/pair', { method: 'POST', body: JSON.stringify({ code }) });
  assert.equal(paired.status, 200);
  assert.equal((await fetch(base + '/api/state', { headers: { cookie: paired.headers.get('set-cookie').split(';')[0] } })).status, 200);
  assert(!/Downloading /.test(output), 'The complete package tried to download a component');
  console.log(JSON.stringify({ ok: true, launcher: 'Start-Daymark.cmd', offline: true, withoutSystemNodeOrPython: true, health: 200, pairing: 200, workspace: 200 }));
} finally {
  if (child.exitCode === null) {
    execFileSync(join(system, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'pipe' });
    await new Promise(r => { if (child.exitCode !== null) r(); else child.once('exit', r); });
  }
  await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
