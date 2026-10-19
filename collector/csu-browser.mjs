import { spawn } from 'node:child_process';
import { access, readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CSU_LOGIN, CSU_STUDENT, CsuError, csuUrl, readOnlyNotice, noticeId } from './csu.mjs';

export function csuCookies(cookies) {
  return (Array.isArray(cookies) ? cookies : []).filter(c => typeof c.name === 'string' && typeof c.value === 'string' && c.domain?.replace(/^\./, '') === 'csujwc.its.csu.edu.cn' && (!c.expires || c.expires === -1 || c.expires > Date.now() / 1000)).map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || '/', secure: c.secure === true, httpOnly: c.httpOnly === true, ...(c.expires > 0 ? { expires: c.expires } : {}), ...(['Strict', 'Lax', 'None'].includes(c.sameSite) ? { sameSite: c.sameSite } : {}) }));
}
// Separate disposable profile; only the JWC session cookie can be saved by the manager.
// Neither passwords nor the university-wide SSO cookies leave the school's login window.
export async function openCsuBrowser({ dataDir, cookies = [], headless = false, login = false }) {
  const candidates = [process.env.STUDENT_INBOX_EDGE_PATH,
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe')].filter(Boolean);
  let executable;
  for (const path of candidates) { try { await access(path); executable = path; break; } catch {} }
  if (!executable) throw new CsuError('未找到 Microsoft Edge，请安装后再连接教务系统');
  const parent = resolve(dataDir, 'browser-sessions'); await mkdir(parent, { recursive: true });
  const profile = await mkdtemp(join(parent, 'csu-'));
  const child = spawn(executable, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-features=msEdgeSigninIntercept,msEdgeSigninRampUp', ...(headless ? ['--headless=new'] : []), 'about:blank'], { windowsHide: headless, stdio: 'ignore' });
  let launchError = false; child.on('error', () => { launchError = true; });
  let socket, closed = false, sequence = 0, loginTarget, readerTarget, readerSession;
  const pending = new Map(), sessions = new Map();
  function command(method, params = {}, sessionId) {
    if (closed || socket?.readyState !== WebSocket.OPEN) return Promise.reject(new CsuError('教务窗口已关闭，请重新打开登录窗口', 'needs_login'));
    const id = ++sequence;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new CsuError('教务页面响应超时，请检查校园网络后重试')); }, 15000);
      pending.set(id, { done, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async function close() {
    if (closed) return;
    if (socket?.readyState === WebSocket.OPEN) { try { await command('Browser.close'); } catch {} }
    closed = true; socket?.close(); child.kill();
    const target = resolve(profile);
    if (target.startsWith(parent + sep) && target !== parent) await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
  async function attach(targetId) {
    if (sessions.has(targetId)) return sessions.get(targetId);
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    sessions.set(targetId, sessionId); await command('Page.enable', {}, sessionId); return sessionId;
  }
  async function evaluate(expression, sessionId) {
    const answer = await command('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    if (answer.exceptionDetails) throw new CsuError('教务页面尚未就绪，请保持窗口打开后重试');
    return answer.result?.value;
  }
  async function capture(sessionId) {
    const result = await evaluate(`(() => { const pages = []; function visit(w, depth) { if (depth > 6 || pages.length >= 16) return; try { const url = w.location.href; if (new URL(url).hostname === 'csujwc.its.csu.edu.cn') pages.push({url, text: w.document.documentElement.outerHTML.slice(0, 2000000)}); for (let i = 0; i < w.frames.length; i++) visit(w.frames[i], depth + 1); } catch {} } visit(window, 0); return pages; })()`, sessionId);
    return (result || []).filter(p => { try { csuUrl(p.url); return typeof p.text === 'string'; } catch { return false; } });
  }
  try {
    let address;
    for (let i = 0; i < 80; i++) {
      if (launchError || child.exitCode !== null) throw new CsuError('Edge 无法启动，请检查浏览器设置');
      try { const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/); if (/^\d+$/.test(port) && path?.startsWith('/devtools/browser/')) { address = `ws://127.0.0.1:${Number(port)}${path}`; break; } } catch {}
      await delay(100);
    }
    if (!address) throw new CsuError('无法连接独立教务窗口，请检查浏览器调试策略');
    socket = new WebSocket(address);
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new CsuError('连接教务窗口超时')), 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); done(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new CsuError('无法连接教务窗口')); }, { once: true });
    });
    socket.addEventListener('message', ({ data }) => { const reply = JSON.parse(data), request = pending.get(reply.id); if (!request) return; clearTimeout(request.timer); pending.delete(reply.id); if (reply.error) request.reject(new CsuError('教务窗口正在跳转或已关闭，请稍后重试')); else request.done(reply.result); });
    socket.addEventListener('close', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new CsuError('教务窗口已关闭', 'needs_login')); } pending.clear(); });
    const created = await command('Target.createTarget', { url: 'about:blank' }); loginTarget = created.targetId;
    const sessionId = await attach(loginTarget);
    const valid = csuCookies(cookies);
    if (valid.length) await command('Network.setCookies', { cookies: valid }, sessionId);
    const nav = await command('Page.navigate', { url: login ? CSU_LOGIN : CSU_STUDENT }, sessionId);
    if (nav.errorText) throw new CsuError('无法打开中南教务，请检查校园网或学校 VPN');
    async function snapshot() {
      const { targetInfos } = await command('Target.getTargets'), pages = [];
      for (const target of targetInfos.filter(t => t.type === 'page' && t.targetId !== readerTarget)) {
        try { csuUrl(target.url); } catch { continue; }
        pages.push(...await capture(await attach(target.targetId)));
      }
      return pages;
    }
    async function read(value) {
      const url = csuUrl(value); if (!readOnlyNotice(url.href)) throw new CsuError('只允许读取教务通知列表和正文');
      if (!readerTarget) { const target = await command('Target.createTarget', { url: 'about:blank', background: true }); readerTarget = target.targetId; readerSession = await attach(readerTarget); }
      const nav = await command('Page.navigate', { url: url.href }, readerSession);
      if (nav.errorText) throw new CsuError('无法读取教务页面，请检查校园网或学校 VPN');
      for (let i = 0; i < 45; i++) {
        await delay(200);
        let result;
        try { result = await evaluate('({ready:document.readyState,url:location.href,text:document.documentElement.outerHTML.slice(0,2000000)})', readerSession); } catch { continue; }
        if (!result || result.url === 'about:blank' || result.ready !== 'complete') continue;
        try { csuUrl(result.url); } catch { throw new CsuError('教务登录已失效，请重新打开登录窗口', 'needs_login'); }
        const current = csuUrl(result.url);
        if (current.pathname === url.pathname && (noticeId(current.href) !== noticeId(url.href) || current.searchParams.get('method') !== url.searchParams.get('method') || current.searchParams.get('pageIndex') !== url.searchParams.get('pageIndex'))) continue;
        return { url: result.url, text: result.text };
      }
      throw new CsuError('读取教务通知超时，请稍后重试');
    }
    async function getCookies() { const result = await command('Storage.getCookies'); return csuCookies(result.cookies); }
    return { snapshot, read, cookies: getCookies, close, get alive() { return !closed && socket?.readyState === WebSocket.OPEN; } };
  } catch (error) { await close(); throw error; }
}
