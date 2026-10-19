import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CsuClient, CsuError, CSU_ORIGIN, CSU_LOGIN, csuUrl, noticeLinks, listingNotices, noticeDetail, publishedDate, authenticatedPages, readOnlyNotice } from '../collector/csu.mjs';
import { csuCookies } from '../collector/csu-browser.mjs';
import { createCsuAccounts } from '../collector/csu-accounts.mjs';
import { queueLlmItem } from '../collector/llm-organizer.mjs';
import { buildMessages, validateResults } from '../shared/llm-tasks.mjs';

const now = Date.parse('2026-10-19T12:00:00+08:00');
const listUrl = CSU_ORIGIN + '/ggly.do?method=gglyMain';
const detailUrl = id => CSU_ORIGIN + '/ggly.do?method=gglyView&contentId=' + id;
const home = '<body>我的桌面 <a href="/Logon.do?method=logout">退出</a><a href="/ggly.do?method=gglyMain">教务通知</a></body>';
const rows = (id, date = '2026-10-19') => `<tr><td><a href="/ggly.do?method=gglyView&amp;contentId=${id}">考试报名通知 ${id}</a></td><td>${date}</td></tr>`;
const detail = '<body><h1>考试报名通知</h1><p>发布时间：2026-10-19 09:30</p><div id="ggnr"><p>请全体同学于2026年10月20日17:00前提交考试报名表。</p><p>填写学号后交到教务办公室。</p></div><button>关闭窗口</button></body>';
function fakeBrowser(overrides = {}) {
  return { alive: true, snapshot: async () => [{ url: CSU_ORIGIN + '/framework/main.jsp', text: home }], read: async url => ({ url, text: url === listUrl ? '<table>' + rows('one') + '</table>' : detail }), cookies: async () => [{ name: 'JSESSIONID', value: 'synthetic-csu-session', domain: 'csujwc.its.csu.edu.cn', path: '/', httpOnly: true }], async close() { this.alive = false; }, ...overrides };
}

test('CSU only follows the official system and read-only notice actions', () => {
  assert.equal(new URL(CSU_LOGIN).hostname, 'ca.csu.edu.cn');
  assert.equal(new URL(CSU_LOGIN).searchParams.get('service'), CSU_ORIGIN + '/sso.jsp');
  const credentialUrl = new URL(CSU_ORIGIN); credentialUrl.username = 'test-user'; credentialUrl.password = 'test-pass';
  for (const url of ['https://bksy.csu.edu.cn/tztg.htm', 'http://evil.test/', 'http://csujwc.its.csu.edu.cn.evil.test/', 'http://csujwc.its.csu.edu.cn:8080/', credentialUrl.href]) assert.throws(() => csuUrl(url));
  assert.equal(readOnlyNotice(detailUrl('test')), true);
  for (const url of ['/ggly.do?method=save', '/ggly.do?method=gglyDelete', '/Logon.do?method=logout']) assert.equal(readOnlyNotice(url), false);
  const links = noticeLinks(home + '<a href="https://bksy.csu.edu.cn/tztg.htm">官网通知</a><a onclick="gglyView(\'test\')" href="#">站内通知</a>', CSU_ORIGIN);
  assert.deepEqual(links.map(l => l.url), [listUrl, detailUrl('test')]);
});

test('CSU extracts full paragraphs, publication time and stable ids without inventing dates', () => {
  assert.equal(listingNotices(rows('one'), CSU_ORIGIN)[0].publishedAt, '2026-10-18T16:00:00.000Z');
  const result = noticeDetail(detail, 'fallback');
  assert.equal(result.title, '考试报名通知');
  assert.equal(result.body, '请全体同学于2026年10月20日17:00前提交考试报名表。\n填写学号后交到教务办公室。');
  assert.equal(result.publishedAt, '2026-10-19T01:30:00.000Z');
  assert.equal(noticeDetail('<h1>活动通知</h1><div id="ggnr">请在2026年10月20日前提交申请材料。</div>', 'fallback').publishedAt, null);
  assert.equal(publishedDate('发布时间：2026-02-30'), null);
  assert.equal(publishedDate('截止日期：2026-10-20，报名日期：2026-10-19'), null);
  assert.equal(authenticatedPages([{ url: CSU_ORIGIN, text: '<input id="userPassword"><a href="/ggly.do?method=gglyMain">教务通知</a>' }]), false);
  assert.throws(() => noticeDetail('<title>出错页面</title>用户没有登录，请重新登录！', 'title'), e => e.code === 'needs_login');
});

test('CSU collects only station notices, filters old dates and deduplicates across polling', async () => {
  const browser = fakeBrowser({ read: async url => ({ url, text: url === listUrl ? '<table>' + rows('one') + rows('old', '2025-01-01') + '</table>' : detail }) });
  const events = [], client = new CsuClient(browser, { now: () => now });
  const result = await client.collect({ accountId: 'account', days: 7 }, async event => events.push(event));
  assert.equal(result.count, 1); assert.equal(result.skipped, 1);
  assert.equal(events[0].source, 'csu'); assert.equal(events[0].externalId, 'account:notice:one');
  assert.equal(events[0].createdAt, '2026-10-19T01:30:00.000Z');
  assert.match(events[0].body, /填写学号后交到教务办公室/); assert.match(events[0].body, /教务原文：http:\/\/csujwc/);
  const repeated = await client.collect({ accountId: 'account', days: 7, seen: result.observed }, async () => assert.fail('must not redeliver a known notice'));
  assert.equal(repeated.count, 0);
});

test('unknown dates remain unknown and oversize bodies keep every character', async () => {
  const body = '请同学提交材料。'.repeat(2000);
  const browser = fakeBrowser({ read: async url => ({ url, text: url === listUrl ? rows('long', '') : `<h1>超长通知</h1><div id="ggnr">${body}</div>` }) });
  const events = [], result = await new CsuClient(browser, { now: () => now }).collect({ accountId: 'account' }, async e => events.push(e));
  assert.equal(result.count, 1); assert.ok(events.length > 1);
  assert.equal(events.every(e => e.publishedAt === null && e.timestampKind === 'collected' && e.body.length <= 12000), true);
  assert.equal(events.map(e => e.body).join(''), body + '\n\n教务原文：' + detailUrl('long'));
});

test('expired login, unknown structure and local delivery failures are visible, not empty success', async () => {
  await assert.rejects(new CsuClient(fakeBrowser({ snapshot: async () => [] })).collect({ accountId: 'a' }, async () => {}), e => e.code === 'needs_login');
  await assert.rejects(new CsuClient(fakeBrowser({ snapshot: async () => [{ url: CSU_ORIGIN, text: '<p>我的桌面</p>' }] })).collect({ accountId: 'a' }, async () => {}), e => e.code === 'structure_changed');
  await assert.rejects(new CsuClient(fakeBrowser(), { now: () => now }).collect({ accountId: 'a' }, async () => { throw new Error('disk unavailable'); }), /disk unavailable/);
  const warnings = await new CsuClient(fakeBrowser({ read: async url => ({ url, text: url === listUrl ? rows('bad') : '<title>错误</title>系统异常' }) }), { now: () => now }).collect({ accountId: 'a' }, async () => assert.fail());
  assert.equal(warnings.count, 0); assert.equal(warnings.warnings.length, 1);
});

test('CSU session export excludes SSO cookies, other schools, and expired credentials', () => {
  const result = csuCookies([
    { name: 'JSESSIONID', value: 'one', domain: 'csujwc.its.csu.edu.cn', path: '/', expires: -1 },
    { name: 'SSO', value: 'two', domain: '.csu.edu.cn', path: '/' },
    { name: 'CAS', value: 'three', domain: 'ca.csu.edu.cn', path: '/' },
    { name: 'old', value: 'four', domain: 'csujwc.its.csu.edu.cn', expires: 1 }
  ]);
  assert.deepEqual(result.map(c => c.name), ['JSESSIONID']);
});

test('CSU manager restores encrypted cookies, retries the durable outbox, and disconnects without deleting messages', { skip: process.platform !== 'win32' }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'daymark-csu-')); const managers = [], delivered = [];
  const vault = async (mode, value) => mode === 'protect' ? Buffer.from(value).toString('base64') : Buffer.from(value, 'base64').toString('utf8'); // test double, never production
  let offline = true, launches = [];
  const browserFactory = async options => { launches.push(options); return fakeBrowser(); };
  const deliver = async e => { if (offline) throw new Error('disk offline'); delivered.push(e); };
  try {
    let manager = await createCsuAccounts({ dataDir, vault, browserFactory, deliver, interval: 1000000, now: () => now }); managers.push(manager);
    assert.throws(() => manager.connect({ days: 999 }), e => e.status === 400);
    manager.connect({ remember: true, days: 7 }); await manager.sync(); await manager.sync();
    assert.equal(manager.view().status, 'error');
    assert.equal((await readdir(join(dataDir, 'csu-outbox'))).length, 1);
    offline = false; await manager.sync();
    assert.equal(manager.view().status, 'connected');
    assert.throws(() => manager.sync({ days: 999 }), e => e.status === 400);
    const launchCount = launches.length; await manager.sync({ days: 30 });
    assert.equal(manager.view().days, 30); assert.equal(launches.length, launchCount);
    const saved = await readFile(join(dataDir, 'csu.dpapi'), 'utf8');
    assert.equal(saved.includes('synthetic-csu-session'), false); assert.equal(JSON.stringify(manager.view()).includes('synthetic-csu-session'), false);
    assert.equal((await readdir(join(dataDir, 'csu-outbox'))).length, 0);
    await manager.close();
    manager = await createCsuAccounts({ dataDir, vault, browserFactory, deliver, interval: 1000000, now: () => now }); managers.push(manager); await manager.sync();
    assert.equal(launches.at(-1).headless, true); assert.equal(manager.view().status, 'connected');
    assert.equal(new Set(delivered.map(e => e.externalId)).size, 1);
    await manager.disconnect(); assert.equal(manager.view().configured, false);
    await assert.rejects(readFile(join(dataDir, 'csu.dpapi')), { code: 'ENOENT' });
    assert.ok(delivered.length > 0);
  } finally { for (const manager of managers) await manager.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('CSU notifications use the existing LLM queue, summary, evidence and dates', async () => {
  const events = []; await new CsuClient(fakeBrowser(), { now: () => now }).collect({ accountId: 'a' }, async e => events.push(e));
  const item = { ...events[0], id: 'aabb' }, store = { items: [item], llm: { enabled: true } };
  queueLlmItem(store, item); assert.equal(item.llmQueue.status, 'queued');
  const messages = buildMessages([item], [], []);
  assert.match(JSON.stringify(messages), /提交考试报名表/);
  const results = validateResults(JSON.stringify({ results: [{ kind: 'task', title: '提交考试报名表', body: '填写学号后交到教务办公室。', certainty: 'high', audience: 'all', sourceIds: [item.id], evidence: [{ sourceId: item.id, quote: '请全体同学于2026年10月20日17:00前提交考试报名表。' }], due: { sourceId: item.id, text: '2026年10月20日17:00前' }, event: null, targetId: null, reason: '明确要求全体同学提交' }] }), [item], []);
  assert.equal(results[0].due, '2026-10-20'); assert.equal(results[0].dueAt, '2026-10-20T17:00:00+08:00');
  assert.equal(results[0].body, '填写学号后交到教务办公室。');
});

// Synthetic content matching the authenticated portal inspected on 2026-10-19.
const studentHome = `<body>学生个人中心 我的桌面
<a href="/jsxsd/ggly/ysgg_query?Ves632DSdyV=NEW_JSD_WDZM">更多&gt;</a>
<table><tr><td><table>
<tr><td title="选课变更须知">选课变更须知</td><td>2026-09-24</td><td><a href="javascript:JsMod('/jsxsd/ggly/ggly_show?ggid=newest',900,450);">教务通知</a></td></tr>
<tr><td>考试安排</td><td>2026-09-04</td><td><a href="javascript:JsMod('/jsxsd/ggly/ggly_show?ggid=older',900,450);">教务通知</a></td></tr>
</table></td></tr></table>
<script>var template="<a href=\"/jsxsd/ggly/ggly_show?ggid=not-rendered\">查看</a>";</script></body>`;
const receivedList = `<body>我的桌面 <table id="dataList"><tr><th>序号</th><th>标题</th><th>发布时间</th></tr>
<tr><td>1</td><td>选课变更须知</td><td>教务通知</td><td>2026-09-24 16:43:50</td><td><a href="javascript:JsMod('/jsxsd/ggly/ggly_show?ggid=newest',900,450);">查看</a></td></tr>
<tr><td>2</td><td>考试安排</td><td>教务通知</td><td>2026-09-04 10:56:40</td><td><a href="javascript:JsMod('/jsxsd/ggly/ggly_show?ggid=older',900,450);">查看</a></td></tr>
</table><input name="pageIndex" type="text" value="1"><span>共1页 2条</span></body>`;
const studentDetail = `<body><table align="center"><tr><td align="center">选课变更须知</td></tr>
<tr><td align="center"><font><p>请发生学籍变更的同学核对个人课表。</p><table><tr><td>课程</td><td>办理方式</td></tr><tr><td>选修课</td><td>联系任课教师</td></tr></table><p>截止时间请咨询学院。</p></font></td></tr>
<tr><td align="left">发布类别：教务通知<br>发布时间：2026-09-24 16:43:50<br>有效期：2026-09-01至2026-12-31</td></tr></table></body>`;

test('authenticated CSU JSXSD links, nested desktop rows and table-based body match the real layout', () => {
  assert.equal(readOnlyNotice('/jsxsd/ggly/ysgg_query'), true);
  assert.equal(readOnlyNotice('/jsxsd/ggly/ggly_show?ggid=newest'), true);
  for (const path of ['/jsxsd/ggly/ggly_delete?ggid=newest', '/jsxsd/ggly/ggly_show', '/jsxsd/xsxk/xklc_list']) assert.equal(readOnlyNotice(path), false);
  const entries = listingNotices(studentHome, CSU_ORIGIN);
  assert.deepEqual(entries.map(e => [e.id, e.title, e.publishedAt]), [
    ['newest', '选课变更须知', '2026-09-23T16:00:00.000Z'], ['older', '考试安排', '2026-09-03T16:00:00.000Z']
  ]);
  const entry = listingNotices(receivedList, CSU_ORIGIN)[0];
  assert.equal(entry.title, '选课变更须知'); assert.equal(entry.publishedAt, '2026-09-24T08:43:50.000Z');
  const parsed = noticeDetail(studentDetail, '查看');
  assert.equal(parsed.title, '选课变更须知'); assert.equal(parsed.publishedAt, entry.publishedAt);
  assert.match(parsed.body, /课程 \| 办理方式/); assert.match(parsed.body, /截止时间请咨询学院/);
  assert.equal(parsed.body.includes('发布类别'), false); assert.equal(parsed.body.includes('有效期'), false);
});

test('CSU follows observed list pagination and can expand from seven to thirty days', async () => {
  const list = CSU_ORIGIN + '/jsxsd/ggly/ysgg_query?Ves632DSdyV=NEW_JSD_WDZM';
  const next = list + '&pageIndex=2';
  const page1 = receivedList.replace('共1页', '共2页');
  assert.equal(noticeLinks(page1, list).some(l => l.url === next), true);
  const reads = [], events = [];
  const browser = fakeBrowser({ snapshot: async () => [{ url: CSU_ORIGIN + '/jsxsd/framework/xsMain.jsp', text: studentHome }], read: async url => { reads.push(url); return { url, text: url === list ? page1 : url === next ? receivedList.replace('value="1"', 'value="2"').replace('共1页', '共2页') : studentDetail }; } });
  const client = new CsuClient(browser, { now: () => now });
  const week = await client.collect({ accountId: 'a', days: 7 }, async e => events.push(e));
  assert.equal(week.count, 0); assert.equal(week.scanned, 2); assert.ok(reads.includes(next));
  assert.equal(week.latestPublishedAt, '2026-09-24T08:43:50.000Z');
  const month = await client.collect({ accountId: 'a', days: 30 }, async e => events.push(e));
  assert.equal(month.count, 1); assert.equal(events[0].externalId, 'a:notice:newest');
  assert.equal(events[0].publishedAt, week.latestPublishedAt); assert.match(events[0].body, /截止时间请咨询学院/);
});
