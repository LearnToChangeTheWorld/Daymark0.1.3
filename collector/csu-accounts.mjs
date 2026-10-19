import { readFile, writeFile, mkdir, rename, readdir, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { windowsVault } from './windows-vault.mjs';
import { CsuClient, CsuError, authenticatedPages, csuEventHash } from './csu.mjs';
import { openCsuBrowser, csuCookies } from './csu-browser.mjs';
import { validateEvent } from '../shared/events.mjs';

export async function createCsuAccounts({ dataDir, deliver, browserFactory = openCsuBrowser, vault = windowsVault, interval = 2000, syncInterval = 300000, now = () => Date.now() }) {
  await mkdir(dataDir, { recursive: true });
  const vaultFile = join(dataDir, 'csu.dpapi'), outbox = join(dataDir, 'csu-outbox'); await mkdir(outbox, { recursive: true });
  let browser = null, remembered = false, configured = false, closed = false, busy = false, job = null, cookies = [], accountId = null, days = 7, seen = [];
  let warnings = [], lastAttempt = 0;
  let report = { status: 'not_configured', message: '请打开学校登录窗口，连接中南大学教务系统', lastSync: null };
  let operation = { status: 'idle', message: '尚未同步', stats: null };
  const safeError = error => error instanceof CsuError ? error.message : '本机保存或同步失败，请重试；已读取的消息保留在待投递队列';
  function view() { return { ...report, configured, busy, remembered, canRemember: process.platform === 'win32', days, warnings, operation, windowOpen: Boolean(browser?.alive) }; }
  async function persist() {
    if (!remembered || closed) return;
    const value = await vault('protect', JSON.stringify({ version: 1, accountId, days, cookies: csuCookies(cookies), seen: seen.slice(-10000) }));
    const temp = vaultFile + '.tmp'; await writeFile(temp, value, { mode: 0o600 }); await rename(temp, vaultFile);
  }
  async function flush() {
    for (const name of (await readdir(outbox)).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).sort()) {
      const event = validateEvent(JSON.parse(await readFile(join(outbox, name), 'utf8')));
      if (event.source !== 'csu') throw new Error('invalid CSU outbox');
      await deliver(event); await unlink(join(outbox, name));
    }
  }
  async function enqueue(event) {
    const value = validateEvent(event), path = join(outbox, csuEventHash(value) + '.json');
    try { await readFile(path); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(path + '.tmp', JSON.stringify(value), { mode: 0o600 }); await rename(path + '.tmp', path);
  }
  async function ensureBrowser() {
    if (browser?.alive) return browser;
    await browser?.close();
    if (!cookies.length) throw new CsuError('登录窗口已关闭，请重新打开学校窗口登录', 'needs_login');
    browser = await browserFactory({ dataDir, cookies, headless: true, login: false }); return browser;
  }
  async function runSync() {
    lastAttempt = now(); operation = { status: 'running', message: '正在读取教务系统内通知…', startedAt: new Date(now()).toISOString(), stats: null };
    try {
      await flush(); if (!configured || closed) return;
      const active = await ensureBrowser();
      const result = await new CsuClient(active, { now }).collect({ accountId, days, seen }, enqueue);
      cookies = await active.cookies();
      // Deliver before recording deduplication state. The durable outbox handles interruptions.
      await flush();
      seen = [...new Set([...seen, ...result.observed])].slice(-10000); await persist();
      warnings = result.warnings;
      const message = `本次读取 ${result.count} 条新通知，跳过 ${result.skipped} 条已同步或范围外通知${warnings.length ? '；部分内容需留意' : ''}${!result.count && result.latestPublishedAt ? `；列表最新发布日期为 ${new Date(result.latestPublishedAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })}` : ''}`;
      operation = { ...operation, status: warnings.length ? 'partial' : 'succeeded', message, finishedAt: new Date(now()).toISOString(), stats: { noticesRead: result.count, skipped: result.skipped, scanned: result.scanned, days, latestPublishedAt: result.latestPublishedAt } };
      report = { status: warnings.length ? 'partial' : 'connected', message, lastSync: operation.finishedAt };
    } catch (error) {
      try { await flush(); } catch {}
      report = { ...report, status: error.code === 'needs_login' ? 'needs_login' : 'error', message: safeError(error) };
      operation = { ...operation, status: 'failed', message: safeError(error), finishedAt: new Date(now()).toISOString() };
    }
  }
  function start(work) {
    if (busy) return job;
    busy = true; job = work().finally(() => { busy = false; }); return job;
  }
  function sync(input = {}) {
    if (closed) return Promise.resolve();
    const range = Number(input.days ?? days);
    if (![7, 30].includes(range)) throw Object.assign(new Error('请选择近 7 天或近 30 天通知'), { status: 400 });
    if (busy) return job;
    days = range;
    return start(runSync);
  }
  function connect(input = {}) {
    if (closed || busy) throw Object.assign(new Error('正在处理教务连接，请稍候'), { status: 409 });
    const range = Number(input.days ?? days);
    if (![7, 30].includes(range)) throw Object.assign(new Error('请选择近 7 天或近 30 天通知'), { status: 400 });
    if (input.remember === true && process.platform !== 'win32') throw Object.assign(new Error('保存登录状态仅支持 Windows，可取消保存后连接'), { status: 400 });
    void start(async () => {
      try {
        // Verify that encryption is available BEFORE replacing an existing connection.
        if (input.remember === true) await vault('protect', '{}');
        await browser?.close(); browser = null;
        remembered = input.remember === true; configured = true; days = range;
        // Reauthentication preserves the connection scope and deduplication history.
        // Switching students requires disconnecting first (explained in the UI).
        accountId ||= 'csu-' + randomBytes(12).toString('hex'); cookies = []; warnings = [];
        if (!remembered) await rm(vaultFile, { force: true }); else await persist();
        report = { ...report, status: 'needs_login', message: '请在学校窗口完成登录、验证码或扫码，再回到这里同步' };
        operation = { status: 'idle', message: '等待学校登录', stats: null };
        browser = await browserFactory({ dataDir, cookies, headless: false, login: true });
      } catch (error) { report = { ...report, status: 'error', message: safeError(error) }; }
    });
    return view();
  }
  async function disconnect() {
    if (busy) throw Object.assign(new Error('正在同步，请完成后再断开'), { status: 409 });
    await rm(vaultFile, { force: true }); await browser?.close(); browser = null;
    configured = false; remembered = false; cookies = []; accountId = null; seen = []; warnings = [];
    report = { status: 'not_configured', message: '已断开并删除保存的教务登录状态；已采集消息保留', lastSync: null };
    operation = { status: 'idle', message: '尚未同步', stats: null }; return view();
  }
  try {
    const saved = JSON.parse(await vault('unprotect', await readFile(vaultFile, 'utf8')));
    if (saved.version !== 1 || !/^csu-[a-f0-9]{24}$/.test(saved.accountId) || ![7, 30].includes(saved.days)) throw new Error('invalid saved account');
    accountId = saved.accountId; days = saved.days; cookies = csuCookies(saved.cookies); seen = Array.isArray(saved.seen) ? saved.seen.filter(x => typeof x === 'string').slice(-10000) : [];
    remembered = true; configured = true;
    report = { ...report, status: 'needs_login', message: cookies.length ? '正在恢复保存的教务登录状态' : '请重新打开学校登录窗口' };
  } catch (error) {
    if (error.code !== 'ENOENT') report = { ...report, status: 'needs_login', message: '无法恢复教务登录状态，请重新打开学校登录窗口' };
  }
  // Flush previously collected text even when a saved session has expired.
  if (configured && cookies.length) void sync(); else { try { await flush(); } catch { report = { ...report, status: 'error', message: '上次读取的教务消息尚未写入事项库，请点击同步重试' }; } }
  const timer = setInterval(() => {
    if (closed || busy || !configured) return;
    if (report.status === 'needs_login') {
      if (!browser?.alive) return;
      void start(async () => {
        try { if (authenticatedPages(await browser.snapshot())) await runSync(); }
        catch (error) { report = { ...report, message: safeError(error) }; }
      });
    } else if (now() - lastAttempt >= syncInterval) void sync();
  }, interval); timer.unref();
  async function close() { if (closed) return; closed = true; clearInterval(timer); await browser?.close(); await job; }
  return { view, connect, sync, disconnect, close };
}
