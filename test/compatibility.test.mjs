import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { findWindowsClient } from '../collector/windows-client.mjs';
import { usesLegacyQQ } from '../collector/qq.mjs';
import { ChatError } from '../collector/napcat.mjs';
import { createChatAccounts } from '../collector/chat-accounts.mjs';

const quote = value => "'" + value.replaceAll("'", "''") + "'";
const discovery = fileURLToPath(new URL('../tools/windows-client.ps1', import.meta.url));
function ps(code, env = process.env) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from("$ProgressPreference='SilentlyContinue';" + code, 'utf16le').toString('base64')], { env, encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 15000 });
}
async function fixture(t) {
  // Windows TEMP may use an 8.3 alias; discovery returns the canonical long path.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'daymark-compat-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, '自定义安装 中文 space'); await mkdir(folder);
  const pe = Buffer.alloc(128); pe.writeUInt16LE(0x5a4d); pe.writeInt32LE(64, 60); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x8664, 68);
  const image = join(folder, 'Weixin.exe'); await writeFile(image, pe);
  return { root, folder, image, pe };
}

test('Windows discovery honors custom Unicode paths and rejects an invalid explicit override', { skip: process.platform !== 'win32' }, async t => {
  const { image } = await fixture(t);
  const run = async (shell, args, options) => ({ stdout: execFileSync(shell, args, { ...options, env: { ...process.env, STUDENT_INBOX_WECHAT_PATH: image } }) });
  const result = await findWindowsClient('WeChat', { run });
  assert.equal(result.client.path, image); assert.equal(result.client.architecture, 'x64');
  const code = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; . ${quote(discovery)}; Get-DaymarkClient WeChat | ConvertTo-Json -Compress -Depth 4`;
  const missing = JSON.parse(ps(code, { ...process.env, STUDENT_INBOX_WECHAT_PATH: image + '.missing' }));
  assert.equal(missing.found, false); assert.equal(missing.reason, 'override_invalid');
});

test('Windows discovery uses running image paths and quoted registry install locations', { skip: process.platform !== 'win32' }, async t => {
  const { image, folder } = await fixture(t);
  const setup = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; . ${quote(discovery)}; $env:STUDENT_INBOX_WECHAT_PATH=''; function Get-Item {}; function Get-ChildItem {}; `;
  const processResult = JSON.parse(ps(setup + `function Get-Process { [pscustomobject]@{Path=${quote(image)}} }; Get-DaymarkClient WeChat | ConvertTo-Json -Compress -Depth 4`));
  assert.equal(processResult.client.path, image);
  const registryResult = JSON.parse(ps(setup + `function Get-Process {}; function Get-ChildItem { [pscustomobject]@{PSPath='synthetic'} }; function Get-ItemProperty { [pscustomobject]@{DisplayName='Weixin';InstallLocation=${quote('"' + folder + '"')}} }; Get-DaymarkClient WeChat | ConvertTo-Json -Compress -Depth 4`));
  assert.equal(registryResult.client.path, image);
});

test('classic QQ and NTQQ choose separate adapters without requiring a single exact build', () => {
  assert.equal(usesLegacyQQ({ version: '9.7.23.1', architecture: 'x86' }), true);
  assert.equal(usesLegacyQQ({ version: '8.9.4.21603', architecture: 'x86' }), true);
  assert.equal(usesLegacyQQ({ version: '9.9.15.1', architecture: 'x64' }), false);
  assert.equal(usesLegacyQQ({ version: '9.9.20.37051', architecture: 'x64' }), false);
  assert.equal(usesLegacyQQ({ version: '10.0.0.1', architecture: 'x64' }), false);
});

test('failed QR startup ends with an error instead of a permanent starting state, and can retry', async t => {
  const { root } = await fixture(t); let fail = true;
  const manager = await createChatAccounts({ dataDir: root, autoRestore: false, pollMs: 1e7, deliver: async () => {},
    wechatFactory: () => ({ async start() { if (fail) throw new ChatError('安装位置检查失败', 'discovery_failed'); return this.loginStatus(); }, async loginStatus() { return { mode: 'local_database', loginState: 'client_missing', readable: false, errorCode: 'client_missing', message: '未找到安装位置' }; }, async close() {} }) });
  t.after(() => manager.close());
  const ready = async () => { for (let n = 0; n < 200 && manager.view('wechat').busy; n++) await new Promise(r => setTimeout(r, 5)); assert.equal(manager.view('wechat').busy, false); };
  manager.connect('wechat'); await ready();
  assert.equal(manager.view('wechat').loginState, 'failed'); assert.equal(manager.view('wechat').errorCode, 'discovery_failed');
  fail = false; manager.connect('wechat'); await ready();
  assert.equal(manager.view('wechat').loginState, 'client_missing'); assert.equal(manager.view('wechat').status, 'error');
});

test('legacy QQ uses UI snapshots, automatic learning selection, account isolation and no false history claim', async t => {
  const { root } = await fixture(t); let account = '123456789'; let posts = ['历史画面']; const delivered = [];
  const state = () => ({ mode: 'uia', supportsHistory: false, loginState: 'authenticated', readable: true, accountId: account, account });
  const manager = await createChatAccounts({ dataDir: root, autoRestore: false, pollMs: 1e7, deliver: async event => delivered.push(event), qqFactory: () => ({ mode: 'uia', async start() { return state(); }, async loginStatus() { return state(); }, async groups() { return { ...state(), groups: [{ id: '高等数学课程群', name: '高等数学课程群' }, { id: '游戏开黑', name: '游戏开黑' }] }; }, async read(groups) { assert.deepEqual(groups, ['高等数学课程群']); return { ...state(), chats: [{ id: groups[0], messages: posts.map(text => ({ text })) }] }; }, async close() {} }) });
  t.after(() => manager.close());
  manager.connect('qq'); for (let n = 0; n < 200 && manager.view('qq').busy; n++) await new Promise(r => setTimeout(r, 5));
  assert.equal(manager.view('qq').collectionState, 'collecting'); assert.equal(manager.view('qq').history, null); assert.equal(delivered.length, 0);
  posts.push('请提交本周作业'); await manager.check('qq');
  assert.equal(delivered.length, 1); assert.equal(delivered[0].source, 'qq'); assert.equal(delivered[0].timestampKind, 'observed');
  await assert.rejects(manager.history('qq'), /不支持按日期补读/);
  account = '987654321'; await manager.check('qq'); assert.equal(delivered.length, 1, 'switching accounts creates a fresh baseline');
});

test('connection headlines distinguish terminal errors from active login work', async () => {
  const source = await readFile(new URL('../public/chat.js', import.meta.url), 'utf8');
  const prefix = source.slice(0, source.indexOf('function renderCheckFeedback'));
  const headline = info => runInNewContext(prefix + '; chatPlatform="wechat"; chatHeadline(info)', { info });
  assert.match(headline({ loginState: 'starting', status: 'error', collectionState: 'error', busy: false }), /连接失败/);
  assert.match(headline({ loginState: 'client_missing', status: 'error' }), /安装位置/);
  assert.match(headline({ loginState: 'starting', status: 'needs_login', busy: true }), /正在启动/);
});
