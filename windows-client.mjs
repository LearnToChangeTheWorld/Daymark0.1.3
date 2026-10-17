import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
export async function findWindowsClient(platform, { run = execute } = {}) {
  if (!['QQ', 'WeChat'].includes(platform)) throw new TypeError('Unknown client');
  const shell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = fileURLToPath(new URL('../tools/windows-client.ps1', import.meta.url));
  const { stdout } = await run(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Platform', platform], { windowsHide: true, encoding: 'utf8', timeout: 12_000, maxBuffer: 64 * 1024 });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
}
