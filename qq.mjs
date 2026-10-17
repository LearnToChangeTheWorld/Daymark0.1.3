import { NapcatClient, ChatError } from './napcat.mjs';
import { WechatClient } from './wechat.mjs';
import { findWindowsClient } from './windows-client.mjs';

// Keep classic QQ outside NapCat: injecting an NTQQ component into it cannot work.
export function usesLegacyQQ(client) {
  const version = (client.version || '').split('.').map(Number);
  return client.architecture === 'x86' || version[0] < 9 || version[0] === 9 && version[1] < 9;
}
export class QQClient {
  constructor(options) { this.options = options; }
  get mode() { return this.legacy ? 'uia' : 'onebot'; }
  async prepare() {
    if (this.backend) return;
    let found;
    try { found = await findWindowsClient('QQ'); }
    catch { throw new ChatError('无法检查 QQ 安装位置，请确认系统 PowerShell 可用', 'discovery_failed'); }
    if (!found.found) throw new ChatError('未找到 QQ 安装位置。请打开已安装的 QQ 后重试，或设置 STUDENT_INBOX_QQ_PATH', 'client_missing');
    const client = found.client;
    this.legacy = usesLegacyQQ(client);
    this.backend = this.legacy ? new WechatClient({ ...this.options, platform: 'qq' }) : new NapcatClient(this.options);
  }
  async start() { await this.prepare(); return this.backend.start(); }
  async loginStatus() { await this.prepare(); return this.backend.loginStatus(); }
  async groups() { return this.backend.groups(); }
  async read(...args) { return this.backend.read(...args); }
  async preview(...args) { return this.backend.preview(...args); }
  async refreshQr() { return this.backend.refreshQr(); }
  async qrImage() { return this.backend.qrImage(); }
  async loginInfo() { return this.backend.loginInfo(); }
  async remember(...args) { if (!this.legacy) return this.backend.remember(...args); }
  async enableEvents() { if (!this.legacy) return this.backend.enableEvents(); }
  async action(...args) { return this.backend.action(...args); }
  async close() { await this.backend?.close(); }
}
