import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url)), directory = await mkdtemp(join(tmpdir(), 'daymark-csu-ui-'));
let child, browser;
try {
  child = spawn(process.execPath, [join(root, 'server.mjs')], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: '0', STUDENT_INBOX_MODE: 'local', STUDENT_INBOX_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  for (let i = 0; i < 200 && !output.includes('Access code:'); i++) { if (child.exitCode !== null) throw new Error('isolated server failed'); await delay(50); }
  const port = output.match(/127\.0\.0\.1:(\d+)/)?.[1]; assert.ok(port);
  const base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1360, height: 1050 }, timezoneId: 'Asia/Shanghai' });
  await context.request.post(base + '/api/pair', { data: { code: (await readFile(join(directory, 'access.token'), 'utf8')).trim() } });
  const page = await context.newPage(), errors = [], calls = [];
  page.on('pageerror', error => errors.push(error.message));
  let state = { configured: false, status: 'not_configured', message: '请打开学校登录窗口，连接中南大学教务系统', busy: false, remembered: false, canRemember: true, days: 7, warnings: [], operation: { status: 'idle' }, lastSync: null };
  await page.route('**/api/accounts/csu**', async route => {
    const request = route.request(); calls.push({ method: request.method(), url: request.url() });
    if (request.method() === 'POST' && request.url().endsWith('/csu')) {
      const input = request.postDataJSON(); assert.deepEqual(input, { days: 30, remember: true });
      state = { ...state, days: input.days, remembered: true, configured: true, status: 'needs_login', message: '请在学校窗口完成登录、验证码或扫码，再回到这里同步' };
    }
    if (request.method() === 'POST' && request.url().endsWith('/sync')) { assert.deepEqual(request.postDataJSON(), { days: 30 }); state = { ...state, status: 'partial', message: '本次读取 2 条新通知，跳过 3 条已同步或范围外通知', lastSync: new Date().toISOString(), warnings: ['一条附件通知的图片暂不解析'] }; }
    if (request.method() === 'DELETE') state = { ...state, configured: false, remembered: false, status: 'not_configured', message: '已断开并删除保存的教务登录状态；已采集消息保留', warnings: [] };
    await route.fulfill({ json: state });
  });
  await page.goto(base); await page.locator('#serverLabel').filter({ hasText: '本机服务已连接' }).waitFor();
  await page.locator('#sourceNav [data-connect-csu]').click(); await page.locator('#csuDialog[open]').waitFor();
  assert.equal(await page.locator('#csuDialog input[type=password]').count(), 0, 'credentials belong only in the university window');
  assert.match(await page.locator('#csuStatus').textContent(), /学校登录窗口/);
  await page.locator('#csuDays').selectOption('30'); await page.locator('#csuConnect').click();
  await page.locator('#csuHeadline').filter({ hasText: '等待学校登录' }).waitFor();
  await page.locator('#csuSync').click(); await page.locator('#csuHeadline').filter({ hasText: '部分读取成功' }).waitFor();
  assert.match(await page.locator('#csuWarnings').textContent(), /图片暂不解析/);
  assert.match(await page.locator('#csuLlmNote').textContent(), /可在“大模型整理”中启用/);
  await mkdir(join(root, 'artifacts'), { recursive: true });
  await page.screenshot({ path: join(root, 'artifacts/csu-connection-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('#csuDialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'mobile dialog does not overflow horizontally');
  await page.screenshot({ path: join(root, 'artifacts/csu-connection-mobile.png'), fullPage: true });
  await page.locator('#csuSettings').evaluate(el => { el.open = true; }); await page.locator('#csuDisconnect').click();
  await page.locator('#csuHeadline').filter({ hasText: '尚未连接' }).waitFor();
  await page.locator('#csuOpenLlm').click(); await page.locator('#llmDialog[open]').waitFor();
  assert.equal(await page.locator('#csuDialog').evaluate(el => el.open), false);
  assert.ok(calls.some(c => c.method === 'DELETE')); assert.deepEqual(errors, []);
  console.log('CSU UI passed: native-login flow, status/errors, LLM entry, disconnect, desktop/mobile; synthetic account API only.');
} finally {
  await browser?.close(); if (child?.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), delay(3000)]); }
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
