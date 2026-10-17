import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ChatError } from './napcat.mjs';

export async function resolveWechatPython({ override = process.env.STUDENT_INBOX_PYTHON_PATH, root = fileURLToPath(new URL('../', import.meta.url)) } = {}) {
  const candidates = override ? [override] : [join(root, 'runtimes/python/python.exe'), join(root, '.venv-wechat/Scripts/python.exe')];
  for (const path of candidates) { try { await access(path); return path; } catch {} }
  throw new ChatError('微信读取组件尚未安装，请双击 Start-Daymark.cmd 自动准备组件', 'component_missing');
}

export class WechatClient {
  constructor({ dataDir, platform = 'wechat' } = {}) { this.pending = new Map(); this.seq = 0; this.dataDir = dataDir; this.platform = platform; }
  async open() {
    if (this.child?.exitCode === null) return;
    const python = await resolveWechatPython();
    this.child = spawn(python, ['-I', fileURLToPath(new URL('./wechat_bridge.py', import.meta.url)), '--platform', this.platform, ...(this.dataDir ? ['--data-dir', this.dataDir] : [])], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    this.child.stderr.on('data', () => {});
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let response; try { response = JSON.parse(line); } catch { return; }
      const task = this.pending.get(response.id); if (!task) return;
      clearTimeout(task.timer); this.pending.delete(response.id);
      response.result?.error ? task.reject(new ChatError(response.result.error, response.result.errorCode || 'read_failed')) : task.done(response.result);
    });
    const stopped = () => { for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new ChatError('微信读取组件已停止，请重新连接')); } this.pending.clear(); };
    this.child.on('error', stopped); this.child.on('exit', stopped);
  }
  async call(action, options = {}) {
    await this.open(); const id = ++this.seq;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ChatError('微信读取超时，请检查本机客户端状态后重试')); this.child?.kill(); }, 30_000);
      this.pending.set(id, { done, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, action, ...options }) + '\n', (error) => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(new ChatError('微信读取组件无法启动')); } });
    });
  }
  start() { return this.call('start'); }
  loginStatus() { return this.call('status'); }
  refreshQr() { return this.call('refresh'); }
  initialize() { return this.call('initialize'); }
  groups() { return this.call('groups'); }
  preview(groups) { return this.call('read', { groups, preview: true }); }
  read(groups, cursors = {}) { return this.call('read', { groups, cursors }); }
  async close() { if (this.child?.exitCode === null) { try { await this.call('close'); } catch {} } this.child?.stdin.end(); this.child?.kill(); this.child = null; }
}
