import { createHash } from 'node:crypto';
import { validDate, validateEvent } from '../shared/events.mjs';

// SSO entry verified against chendaile/CSUMCP at 7db3ccc3715ed6460ecbd3d6338ce0fd3c666b7e.
// Use the university's browser login so that current CAPTCHA/QR/MFA remain native.
export const CSU_ORIGIN = 'http://csujwc.its.csu.edu.cn';
export const CSU_SSO = CSU_ORIGIN + '/sso.jsp';
export const CSU_STUDENT = CSU_ORIGIN + '/jsxsd/framework/xsMain.jsp';
export const CSU_LOGIN = 'https://ca.csu.edu.cn/authserver/login?service=' + encodeURIComponent(CSU_SSO);
export class CsuError extends Error {
  constructor(message, code = 'error') { super(message); this.name = 'CsuError'; this.code = code; }
}
export function csuUrl(value, base = CSU_ORIGIN) {
  let url;
  try { url = new URL(value, base); } catch { throw new CsuError('教务链接格式不正确'); }
  if (url.hostname !== 'csujwc.its.csu.edu.cn' || !['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password) throw new CsuError('仅允许读取中南大学教务系统的链接');
  url.hash = ''; return url;
}
export function decodeHtml(value) {
  const names = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', middot: '·' };
  return String(value || '').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (raw, key) => {
    if (!key.startsWith('#')) return names[key.toLowerCase()] ?? raw;
    const point = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
  });
}
export function htmlText(html) {
  return decodeHtml(String(html || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|select|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<input\b[^>]*>/gi, '').replace(/<\/(?:p|div|tr|li|h[1-6]|table|section)>|<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:td|th)>/gi, ' | ').replace(/<[^>]*>/g, '')).replace(/[\t \u3000]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function attribute(tag, name) { return decodeHtml(tag.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\x27([^\x27]*)\x27|([^\\s>]+))', 'i'))?.slice(1).find(x => x !== undefined) || ''); }
export function loggedOut(html) {
  return /用户没有登录|请重新登录|登录已失效|会话.{0,6}过期|<title[^>]*>\s*(?:出错页面|统一身份认证)/i.test(html) || /<(?:input|form)\b[^>]*(?:id|name)\s*=\s*["'](?:userPassword|RANDOMCODE|frmloginZndx|pwdFromId)["']/i.test(html);
}
export function authenticatedPages(pages) {
  return pages.some(p => { try { csuUrl(p.url); } catch { return false; } return !loggedOut(p.text) && /(?:退出(?:登录|系统)?|注销|我的桌面|学生个人中心|安全退出|个人信息|教学服务)/.test(htmlText(p.text)); });
}
export function noticeId(value) {
  const url = csuUrl(value), id = url.searchParams.get('contentId') || url.searchParams.get('ggid') || url.searchParams.get('id');
  return /^[a-z\d_-]{1,100}$/i.test(id || '') ? id : null;
}
export function readOnlyNotice(value) {
  const url = csuUrl(value), method = url.searchParams.get('method') || '';
  // Current student portal and the older portal expose different read-only routes.
  if (url.pathname === '/jsxsd/ggly/ysgg_query') return !method;
  if (url.pathname === '/jsxsd/ggly/ggly_show') return !method && Boolean(noticeId(url.href));
  return /^\/(?:jsxsd\/)?ggly\.do$/i.test(url.pathname) && /^(?:ggly(?:Main|List|View|Query|Index)|main|list|view|query|index)$/i.test(method);
}
export function noticeLinks(html, base) {
  const result = [], markup = String(html).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const add = (candidate, title = '') => {
    try { const url = csuUrl(candidate, base); if (readOnlyNotice(url.href)) result.push({ url: url.href, id: noticeId(url.href), title }); } catch {}
  };
  for (const match of markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const raw = attribute(match[1], 'href'), onclick = attribute(match[1], 'onclick');
    const title = htmlText(match[2]) || attribute(match[1], 'title');
    add(raw, title);
    // JsMod/showWindow contain literal URLs; never evaluate school JavaScript.
    for (const quoted of (raw + ' ' + onclick).matchAll(/["']([^"'<>\s]*(?:ggly\.do|\/ggly\/(?:ysgg_query|ggly_show))(?:\?[^"'<>]*)?)["']/gi)) add(quoted[1], title);
    const call = (raw + ' ' + onclick).match(/\bgglyView\s*\(\s*["']([a-z\d_-]{1,100})["']/i);
    if (call) add('/ggly.do?method=gglyView&contentId=' + encodeURIComponent(call[1]), title);
  }
  // The received-notices form uses pageIndex. Only advance the observed list route.
  const url = csuUrl(base), current = Number(attribute(markup.match(/<input\b[^>]*name=["']pageIndex["'][^>]*>/i)?.[0] || '', 'value')) || Number(url.searchParams.get('pageIndex')) || 1;
  const total = Number(htmlText(markup).match(/共\s*(\d+)\s*页/)?.[1]);
  if (url.pathname === '/jsxsd/ggly/ysgg_query' && current > 0 && current < total && total <= 10000) {
    url.searchParams.set('pageIndex', String(current + 1)); add(url.href);
  }
  return [...new Map(result.map(link => [link.url, link])).values()];
}
export function publishedDate(text) {
  const match = String(text).match(/(?:发布(?:时间|日期)?|公告时间|通知时间)\s*[:：]?\s*(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})日?(?:\s+([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?)?/);
  if (!match) return null;
  const day = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  if (!validDate(day)) return null;
  return new Date(`${day}T${(match[4] || '00').padStart(2, '0')}:${match[5] || '00'}:${match[6] || '00'}+08:00`).toISOString();
}
export function listingNotices(html, base) {
  // Match innermost rows: the desktop nests its whole notice table in a layout row.
  const rows = [...String(html).matchAll(/<(tr|li)\b[^>]*>((?:(?!<(?:tr|li)\b)[\s\S])*?)<\/\1>/gi)].map(m => m[2]);
  const entries = noticeLinks(html, base).filter(l => l.id);
  for (const entry of entries) {
    const row = rows.find(r => noticeLinks(r, base).some(l => l.id === entry.id));
    const date = htmlText(row || '').match(/\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/);
    entry.publishedAt = date ? publishedDate(`发布时间：${date[0]}`) : null;
    // The portal's anchor says “查看”/“教务通知”; the actual title is a sibling cell.
    if (row && /^(?:查看|教务通知|公告|通知)$/.test(entry.title)) {
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => htmlText(m[1]));
      entry.title = cells.find(text => text && !/^\d+$|^20\d{2}[-/.]|^(?:查看|教务通知|公告|通知)$/.test(text)) || entry.title;
    }
  }
  return entries;
}
// Extract a balanced element, preserving nested paragraphs and table cells.
function element(html, opening) {
  const found = opening.exec(html); if (!found) return null;
  const tag = found[1], tokens = new RegExp('<\\/?' + tag + '\\b[^>]*>', 'gi'); tokens.lastIndex = found.index;
  let depth = 0, start = found.index + found[0].length;
  for (let token; (token = tokens.exec(html));) { depth += /^<\//.test(token[0]) ? -1 : 1; if (depth === 0) return html.slice(start, token.index); }
  return null;
}
function elementContents(html, tag) {
  const tokens = new RegExp('<\\/?' + tag + '\\b[^>]*>', 'gi'), parts = [];
  let depth = 0, start = 0;
  for (let token; (token = tokens.exec(html));) {
    if (/^<\//.test(token[0])) { if (--depth === 0) parts.push(html.slice(start, token.index)); }
    else if (depth++ === 0) start = tokens.lastIndex;
  }
  return parts;
}
export function noticeDetail(html, fallbackTitle) {
  if (loggedOut(html)) throw new CsuError('教务登录已失效，请重新打开学校登录窗口', 'needs_login');
  if (/<title[^>]*>\s*(?:错误|出错|异常)|系统发生错误|系统异常|您没有权限|无权访问|内容不存在/.test(html)) throw new CsuError('教务系统未返回可读取的通知正文');
  const portalTable = element(html, /<(table)\b[^>]*align=["']center["'][^>]*>/i);
  const portalCells = elementContents(portalTable || '', 'td');
  const portalBody = /发布类别[：:]|发布时间[：:]/.test(htmlText(portalTable || '')) && portalCells.length >= 3 ? portalCells[1] : null;
  const titleHtml = (portalBody ? portalCells[0] : null) || element(html, /<(h[12])\b[^>]*>/i) || element(html, /<(div|td|span)\b[^>]*(?:id|class)=["'][^"']*(?:ggtitle|notice-title|ggbt)[^"']*["'][^>]*>/i);
  const title = htmlText(titleHtml || fallbackTitle).trim();
  const content = element(html, /<(div|td|section)\b[^>]*(?:id|class)=["'][^"']*(?:ggnr|ggcontent|notice-content|content-detail|article-content|v_news_content)[^"']*["'][^>]*>/i)
    || portalBody || element(html, /<(body)\b[^>]*>/i) || html;
  const body = htmlText(content).replace(/(?:关闭窗口|打印本页|返回列表)\s*$/g, '').trim();
  if (!title || body.length < 8) throw new CsuError('通知正文格式无法识别，请在教务窗口核对后重试');
  // Only a labelled publication date counts. Deadlines in the body are NOT publication dates.
  const metadata = element(html, /<(div|td|span)\b[^>]*(?:id|class)=["'][^"']*(?:publish|ggtime|notice-time|article-info)[^"']*["'][^>]*>/i);
  return { title, body, publishedAt: publishedDate(htmlText(metadata || (portalBody ? portalCells[2] : html)).slice(0, 2200)) };
}
export class CsuClient {
  constructor(browser, { now = () => Date.now(), maxNotices = 100, maxPages = 12 } = {}) { this.browser = browser; this.now = now; this.maxNotices = maxNotices; this.maxPages = maxPages; }
  async collect({ accountId, days = 7, seen = [] }, emit) {
    const pages = await this.browser.snapshot();
    if (!authenticatedPages(pages)) throw new CsuError('请先在学校窗口完成登录和验证码，再点击“我已登录，开始同步”', 'needs_login');
    const queue = [...pages], visited = new Set(), entries = new Map(), warnings = [];
    let emptyBoard = false, capped = false;
    while (queue.length && visited.size < this.maxPages) {
      const page = queue.shift(); if (visited.has(page.url)) continue; visited.add(page.url);
      if (loggedOut(page.text)) throw new CsuError('教务登录已失效，请重新登录', 'needs_login');
      for (const notice of listingNotices(page.text, page.url)) entries.set(notice.id, notice);
      if (/暂无(?:通知|公告)|没有(?:相关)?(?:通知|公告)|无(?:通知|公告|相关记录)/.test(htmlText(page.text))) emptyBoard = true;
      for (const link of noticeLinks(page.text, page.url).filter(l => !l.id)) {
        if (visited.has(link.url) || queue.some(p => p.url === link.url)) continue;
        if (visited.size + queue.length >= this.maxPages) { capped = true; break; }
        const value = await this.browser.read(link.url); queue.push(value);
      }
    }
    if (!entries.size && !emptyBoard) throw new CsuError('已进入教务系统，但尚未识别通知列表。请在学校窗口打开“教务通知”后再同步', 'structure_changed');
    const known = new Set(seen), observed = [], cutoff = this.now() - days * 86400000;
    let count = 0, skipped = 0;
    for (const entry of entries.values()) {
      const externalId = `${accountId}:notice:${entry.id}`;
      if (known.has(externalId)) { skipped++; continue; }
      if (entry.publishedAt && Date.parse(entry.publishedAt) < cutoff) { skipped++; continue; }
      if (count >= this.maxNotices) { capped = true; break; }
      try {
        const page = await this.browser.read(entry.url);
        const detail = noticeDetail(page.text, entry.title), publishedAt = detail.publishedAt || entry.publishedAt;
        if (publishedAt && Date.parse(publishedAt) < cutoff) { skipped++; continue; }
        if (publishedAt && Date.parse(publishedAt) > this.now() + 86400000) { warnings.push('有通知的发布时间晚于当前日期，已跳过，请核对学校页面'); continue; }
        const text = `${detail.body}\n\n教务原文：${entry.url}`;
        // Keep all text: oversized notices become ordered pieces with stable identifiers.
        const parts = []; for (let i = 0; i < text.length; i += 11000) parts.push(text.slice(i, i + 11000));
        for (let i = 0; i < parts.length; i++) await emit(validateEvent({ source: 'csu', sourceName: '中南大学教务系统', externalId: parts.length === 1 ? externalId : `${externalId}:part:${i + 1}`, kind: 'notification', category: 'academic', title: detail.title + (parts.length > 1 ? `（${i + 1}/${parts.length}）` : ''), body: parts[i], createdAt: publishedAt || new Date(this.now()).toISOString(), publishedAt, timestampKind: publishedAt ? 'published' : 'collected' }));
        observed.push(externalId); count++;
      } catch (error) {
        if (error.code === 'needs_login') throw error;
        if (!(error instanceof CsuError)) throw error; // local delivery failures must remain retryable
        warnings.push(`“${entry.title || '通知'}”读取失败：${error.message}`);
      }
    }
    if (capped) warnings.push(`本次达到读取上限（${this.maxPages} 个列表、${this.maxNotices} 条新通知），后续同步继续读取`);
    const latestPublishedAt = [...entries.values()].map(e => e.publishedAt).filter(Boolean).sort().at(-1) || null;
    return { count, skipped, scanned: entries.size, observed, warnings: warnings.slice(0, 30), days, latestPublishedAt };
  }
}
export function csuEventHash(event) { return createHash('sha256').update('csu\0' + event.externalId).digest('hex'); }
