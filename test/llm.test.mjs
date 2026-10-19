import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { llmDefaults, cleanLlmConfig, resolveDate, validateResults, applyResults, scopeKey, buildMessages } from '../shared/llm-tasks.mjs';
import { createLlmOrganizer, requestCompletion, queueLlmItem } from '../collector/llm-organizer.mjs';
import { presentItems, autoPromoteChatTasks } from '../shared/chat-triage.mjs';
import { cleanItem } from '../shared/events.mjs';

const source = (id = 'abc', body = '请大家明天下午5点前提交实验报告', extra = {}) => ({ id, title: body, body, source: 'qq', sourceName: '物理课程群', externalId: `account:group:${id}`, kind: 'notification', category: 'academic', createdAt: '2026-12-31T15:30:00Z', publishedAt: '2026-12-31T15:30:00Z', ...extra });
const row = (item, extra = {}) => ({ kind: 'task', title: '提交实验报告', body: '提交到学习通', audience: 'all', certainty: 'high', sourceIds: [item.id], evidence: [{ sourceId: item.id, quote: item.body }], due: { sourceId: item.id, text: '明天下午5点前' }, event: null, targetId: null, reason: '全体要求', ...extra });
const answer = (results, usage = 123) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results }) } }], usage: { total_tokens: usage } }), { headers: { 'content-type': 'application/json' } });

test('LLM date resolution uses original Shanghai date across years and never collection time', () => {
  const item = source();
  assert.deepEqual(resolveDate({ sourceId: item.id, text: '明天下午5点前' }, [item]), { date: '2027-01-01', at: '2027-01-01T17:00:00+08:00', text: '明天下午5点前', uncertain: false, inferredYear: false });
  const late = source('a', '明天提交', { publishedAt: '2026-12-31T16:30:00Z' });
  assert.equal(resolveDate({ sourceId: 'a', text: '明天' }, [late]).date, '2027-01-02');
  const observed = source('b', '明天下午5点前交', { publishedAt: null, timestampKind: 'observed' });
  const unknown = resolveDate({ sourceId: 'b', text: '明天下午5点前' }, [observed]);
  assert.equal(unknown.date, null); assert.equal(unknown.uncertain, true);
  assert.throws(() => resolveDate({ sourceId: 'abc', text: '后天' }, [item]), /原文依据/);
});

test('explicit/weekday/ambiguous dates retain precision and validate real calendar dates', () => {
  const item = source('d', '下周一上午8点开会；2027年2月30日；2027年1月3日；周五；明天8点；1月5日；这周日下午2点');
  const date = text => resolveDate({ sourceId: 'd', text }, [item]);
  assert.equal(date('下周一上午8点').at, '2027-01-04T08:00:00+08:00');
  assert.equal(date('2027年2月30日').date, null);
  assert.equal(date('2027年1月3日').at, null);
  assert.equal(date('周五').uncertain, true);
  assert.equal(date('明天8点').at, null);
  assert.equal(date('1月5日').inferredYear, true);
  assert.equal(date('这周日下午2点').at, '2027-01-03T14:00:00+08:00');
  assert.throws(() => cleanItem({ title: 'x', due: '2027-01-01', dueAt: '2027-01-02T15:00:00+08:00' }), /对应日期/);
});

test('model output is validated against evidence, audiences, scopes and known targets', () => {
  const item = source();
  assert.equal(validateResults(JSON.stringify({ results: [row(item)] }), [item])[0].needsReview, false);
  for (const changes of [{ sourceIds: ['missing'] }, { evidence: [{ sourceId: item.id, quote: '虚构文字' }] }, { targetId: 'unknown' }, { due: { sourceId: item.id, text: '今天' } }]) assert.throws(() => validateResults(JSON.stringify({ results: [row(item, changes)] }), [item]));
  const optional = source('opt', '有意向的同学请明天下午5点前提交实验报告');
  assert.equal(validateResults(JSON.stringify({ results: [row(optional)] }), [optional])[0].needsReview, true);
  assert.equal(validateResults(JSON.stringify({ results: [row(item, { due: null })] }), [item])[0].needsReview, true);
  const foreign = source('foreign', item.body, { externalId: 'other:group:1' });
  assert.throws(() => validateResults(JSON.stringify({ results: [row(item, { sourceIds: [item.id, foreign.id], evidence: [item, foreign].map(i => ({ sourceId: i.id, quote: i.body })) })] }), [item, foreign]), /不同账号/);
  assert.throws(() => validateResults('```json\n{}\n```', [item]), /JSON/);
});

test('task splitting retains original and retries do not resurrect user decisions', () => {
  const item = source(); const draft = { items: [item], llm: {} };
  const rows = validateResults(JSON.stringify({ results: [row(item), row(item, { title: '上传报告电子版' })] }), [item]);
  assert.equal(applyResults(draft, rows).length, 2);
  assert.equal(draft.items.find(i => i.id === item.id).body, item.body);
  assert.equal(applyResults(draft, rows).length, 0);
  draft.items.find(i => i.llm).done = true;
  assert.equal(applyResults(draft, [{ ...rows[0], title: '模型换一种说法' }]).length, 0);
  assert.equal(scopeKey(draft.items.find(i => i.llm)), scopeKey(item));
  const deleted = { items: [item], llm: { dismissedSourceIds: [item.id] } };
  assert.equal(applyResults(deleted, rows).length, 0);
});

test('separate messages merge with traceable evidence but same-name groups remain isolated', () => {
  const first = source('a', '请提交实验报告'), second = source('b', '明天下午5点前');
  const merged = row(first, { sourceIds: ['a', 'b'], evidence: [{ sourceId: 'a', quote: first.body }, { sourceId: 'b', quote: second.body }], due: { sourceId: 'b', text: second.body } });
  const results = validateResults(JSON.stringify({ results: [merged] }), [first, second]);
  const draft = { items: [first, second] }; assert.equal(applyResults(draft, results).length, 1);
  assert.equal(draft.items[0].dueAt, '2027-01-01T17:00:00+08:00'); assert.equal(draft.items[0].llm.sourceIds.length, 2);
  const foreign = { ...second, externalId: 'account:other-group:b' };
  assert.throws(() => validateResults(JSON.stringify({ results: [merged] }), [first, foreign]), /不同账号或会话/);
});

async function harness(fetcher = async () => answer([]), seed = null) {
  let store = seed ? structuredClone(seed) : { items: [] };
  let chain = Promise.resolve();
  const transaction = fn => { const promise = chain.then(() => { const draft = structuredClone(store); const result = fn(draft); store = draft; return result; }); chain = promise.catch(() => {}); return promise; };
  const organizer = await createLlmOrganizer({ getStore: () => store, transaction, fetcher, vault: async (mode, value) => mode === 'protect' ? 'cipher:' + value : value.slice(7), interval: 1000000, requestInterval: 0 });
  const configure = extra => organizer.save({ ...llmDefaults, apiKey: 'test-placeholder', enabled: true, consent: true, ...extra });
  const enqueue = async item => transaction(draft => { queueLlmItem(draft, item); if (item.llmQueue) item.llmQueue.nextAt = 0; draft.items.push(item); });
  return { organizer, transaction, configure, enqueue, store: () => store };
}

test('queue runs off collection path, handles split/merge, and excludes other accounts from context', async t => {
  let calls = 0;
  const h = await harness(async (url, options) => {
    calls++; const request = JSON.parse(options.body); const data = JSON.parse(request.messages[1].content);
    assert.equal(options.redirect, 'error'); assert.equal(data.messages.some(i => i.id === 'foreign'), false);
    const item = data.messages.find(i => i.id === 'abc');
    return answer([row({ ...item, body: item.body }), row({ ...item, body: item.body }, { title: '填写登记表' })]);
  }); t.after(() => h.organizer.close());
  await h.configure(); await h.transaction(d => d.items.push(source('foreign', '私密消息', { externalId: 'other:group:1' })));
  await h.enqueue(source());
  autoPromoteChatTasks(h.store().items); assert.equal(h.store().items.find(i => i.id === 'abc').kind, 'notification');
  await h.organizer.tick();
  assert.equal(calls, 1); assert.equal(h.store().items.filter(i => i.llm).length, 2); assert.equal(h.organizer.view().counts.done, 1);
  assert.equal(h.organizer.view().usage.tokens, 123); assert.ok(!JSON.stringify(h.organizer.view()).includes('test-placeholder'));
  await h.organizer.tick(); assert.equal(calls, 1);
});

test('auth failure is bounded, original persists, rule fallback works and explicit retry recovers', async t => {
  let failing = true;
  const h = await harness(async () => failing ? new Response('', { status: 401 }) : answer([row(source())])); t.after(() => h.organizer.close());
  await h.configure(); await h.enqueue(source()); await h.organizer.tick();
  assert.equal(h.organizer.view().counts.failed, 1); assert.match(h.organizer.view().lastError, /API Key/);
  assert.equal(h.store().items[0].body, source().body); assert.equal(h.store().items[0].kind, 'task');
  await h.organizer.tick(); assert.equal(h.organizer.view().usage.requests, 1);
  failing = false; await h.organizer.retry(); await h.organizer.tick();
  assert.equal(h.organizer.view().counts.done, 1); assert.equal(h.store().items.filter(i => i.kind === 'task').length, 1);
});

test('transient rate errors stop after three attempts and malformed output never loses originals', async t => {
  let calls = 0;
  const h = await harness(async () => { calls++; return new Response('', { status: 429 }); }); t.after(() => h.organizer.close());
  await h.configure(); await h.enqueue(source());
  for (let count = 0; count < 3; count++) { await h.transaction(d => { d.items.find(i => i.id === 'abc').llmQueue.nextAt = 0; }); await h.organizer.tick(); }
  assert.equal(calls, 3); assert.equal(h.organizer.view().counts.failed, 1); await h.organizer.tick(); assert.equal(calls, 3);
  const invalid = await harness(async () => new Response('{"choices":[{"message":{"content":"not JSON"}}]}')); t.after(() => invalid.organizer.close());
  await invalid.configure(); await invalid.enqueue(source()); await invalid.organizer.tick();
  assert.equal(invalid.store().items.filter(i => i.llm).length, 0); assert.equal(invalid.store().items[0].body, source().body); assert.match(invalid.organizer.view().lastError, /JSON/);
});

test('an edit or pause during an in-flight completion prevents automatic writes', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const h = await harness(async () => { entered(); return new Promise(resolve => { release = () => resolve(answer([row(source())])); }); }); t.after(() => h.organizer.close());
  await h.configure(); await h.enqueue(source());
  const running = h.organizer.tick(); await started;
  await h.transaction(d => { const item = d.items[0]; item.userEditedAt = new Date().toISOString(); item.title = '我修改的标题'; });
  release(); await running;
  assert.equal(h.store().items.length, 1); assert.equal(h.store().items[0].title, '我修改的标题');
  autoPromoteChatTasks(h.store().items); assert.equal(h.store().items[0].kind, 'notification');
  let finish, enteredPause;
  const starting = new Promise(resolve => { enteredPause = resolve; });
  const paused = await harness(async () => { enteredPause(); return new Promise(resolve => { finish = () => resolve(answer([row(source())])); }); }); t.after(() => paused.organizer.close());
  await paused.configure(); await paused.enqueue(source()); const request = paused.organizer.tick(); await starting; await paused.organizer.pause(); finish(); await request;
  assert.equal(paused.store().items.some(i => i.llm), false); assert.equal(paused.organizer.view().enabled, false);
});

test('confirmed cancellation archives the target, while ordinary read markers do not invalidate a proposal', async t => {
  const original = { ...source('original'), kind: 'task', title: '提交报告' }, followup = source('next', '实验报告取消提交');
  const h = await harness(async () => answer([row(followup, { kind: 'change', changeAction: 'cancel', targetId: original.id, due: null })])); t.after(() => h.organizer.close());
  await h.configure(); await h.transaction(d => d.items.push(original)); await h.enqueue(followup); await h.organizer.tick();
  const id = h.store().items.find(i => i.llm).id;
  await h.transaction(d => { d.items.find(i => i.id === original.id).read = true; }); await h.organizer.review(id, true);
  assert.equal(h.store().items.find(i => i.id === original.id).archived, true);
  assert.equal(h.store().items.find(i => i.id === id).llm.review, false);
});

test('restart recovers running jobs and saved key without sending historical backlog automatically', async t => {
  const h = await harness(async () => answer([row(source())]));
  await h.configure({ remember: true }); await h.enqueue(source());
  await h.transaction(d => { d.items[0].llmQueue.status = 'running'; d.items.push(source('old')); });
  const saved = structuredClone(h.store()); await h.organizer.close();
  const next = await harness(async () => answer([row(source())]), saved); t.after(() => next.organizer.close());
  assert.equal(next.organizer.view().hasKey, true); await next.organizer.tick();
  assert.equal(next.store().items.find(i => i.id === 'abc').llmQueue.status, 'done');
  assert.equal(next.store().items.find(i => i.id === 'old').llmQueue, undefined);
});

test('history is preview-only, selection is atomic and user changes made during preview win', async t => {
  const item = source('abc', source().body, { createdAt: new Date().toISOString(), publishedAt: new Date().toISOString() });
  const h = await harness(async () => answer([row(item), row(item, { title: '上传电子版' })])); t.after(() => h.organizer.close());
  await h.configure({ enabled: false }); await h.enqueue(item);
  await assert.rejects(h.organizer.preview({ days: 7 }), /确认允许/);
  const job = await h.organizer.preview({ days: 7, consent: true }); await h.organizer.tick();
  assert.equal(h.store().items.length, 1); assert.equal(h.organizer.view().previews[0].status, 'ready');
  await assert.rejects(h.organizer.apply(job.id, [99]), /请选择/);
  assert.equal((await h.organizer.apply(job.id, [0])).added, 1);
  await assert.rejects(h.organizer.apply(job.id, [0]), /已处理/);
  assert.equal(h.store().items.filter(i => i.llm).length, 1);
});

test('follow-up changes require review, preserve completed/edited tasks and retain exact evidence', async t => {
  const original = { ...source('original'), kind: 'task', title: '提交报告', due: '2027-01-01' };
  const followup = source('new', '实验报告取消提交');
  const h = await harness(async () => answer([row(followup, { kind: 'change', changeAction: 'cancel', targetId: original.id, due: null })])); t.after(() => h.organizer.close());
  await h.configure(); await h.transaction(d => d.items.push(original)); await h.enqueue(followup); await h.organizer.tick();
  let proposal = h.store().items.find(i => i.llm);
  assert.equal(proposal.llm.review, true); assert.equal(h.store().items.find(i => i.id === original.id).archived, undefined);
  assert.equal(presentItems(h.store().items).find(i => i.id === proposal.id).triage.kind, 'candidate');
  await h.transaction(d => { d.items.find(i => i.id === original.id).done = true; });
  await assert.rejects(h.organizer.review(proposal.id, true), /已被处理或修改/);
  await h.organizer.review(proposal.id, false);
  assert.equal(h.store().items.find(i => i.id === original.id).done, true);
});

test('changing endpoint never reuses saved key; invalid configs and exhausted budgets make no calls', async t => {
  let calls = 0; const h = await harness(async () => { calls++; return answer([]); }); t.after(() => h.organizer.close());
  await h.configure({ dailyTokenLimit: 10000 });
  await assert.rejects(h.configure({ baseUrl: 'https://other.example/v1', apiKey: '' }), /重新填写/);
  const credentialUrl = new URL('https://example.com'); credentialUrl.username = 'test-user'; credentialUrl.password = 'test-password';
  for (const baseUrl of ['http://remote.example/v1', credentialUrl.href, 'https://example.com/v1?key=secret']) assert.throws(() => cleanLlmConfig({ ...llmDefaults, baseUrl }));
  await h.transaction(d => { d.llm.usage.tokens = 10000; }); await h.enqueue(source()); await h.organizer.tick();
  assert.equal(calls, 0); assert.match(h.organizer.view().lastError, /每日用量/);
});

test('HTTP client works with an OpenAI compatible endpoint and sanitizes provider errors', async t => {
  const received = [];
  const mock = createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { total_tokens: 11 } })); });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening'); t.after(() => { mock.close(); mock.closeAllConnections(); });
  const result = await requestCompletion({ ...llmDefaults, baseUrl: `http://127.0.0.1:${mock.address().port}/v1` }, 'placeholder', [{ role: 'user', content: 'JSON' }]);
  assert.equal(result.tokens, 11); assert.equal(received[0].url, '/v1/chat/completions'); assert.equal(received[0].auth, 'Bearer placeholder'); assert.deepEqual(received[0].body.response_format, { type: 'json_object' });
  for (const status of [401, 402, 429, 500]) await assert.rejects(requestCompletion(llmDefaults, 'placeholder', [], { fetcher: async () => new Response('secret provider payload', { status }) }), e => !e.message.includes('secret') && Boolean(e.status));
});


test('larger budgets and batch/output settings are validated and old configs get defaults', async t => {
  assert.equal(llmDefaults.dailyTokenLimit, 10000000);
  assert.equal(cleanLlmConfig({ ...llmDefaults, dailyTokenLimit: 100000000 }).dailyTokenLimit, 100000000);
  for (const change of [{ dailyTokenLimit: 100000001 }, { batchSize: 49 }, { batchSize: 0 }, { maxOutputTokens: 0 }, { maxOutputTokens: 65537 }]) assert.throws(() => cleanLlmConfig({ ...llmDefaults, ...change }));
  const old = { ...llmDefaults, dailyTokenLimit: 1900000 }; delete old.batchSize; delete old.maxOutputTokens; delete old.fastMode;
  const h = await harness(undefined, { items: [], llm: { config: old, enabled: false, generation: 0, usage: { day: '', tokens: 0, requests: 0 } } }); t.after(() => h.organizer.close());
  assert.equal(h.organizer.view().config.dailyTokenLimit, 1900000);
  assert.equal(h.organizer.view().config.batchSize, 24);
  assert.equal(h.organizer.view().config.maxOutputTokens, 16384);
});

test('one completion processes 24 messages into 48 concise bodies while originals remain intact', async t => {
  let calls = 0;
  const h = await harness(async (_url, options) => {
    calls++; const request = JSON.parse(options.body), data = JSON.parse(request.messages[1].content);
    assert.equal(request.max_tokens, 16384); assert.deepEqual(request.thinking, { type: 'disabled' });
    assert.equal(data.focusIds.length, 24);
    assert.match(request.messages[0].content, /body 必须由你提炼/);
    return answer(data.messages.filter(m => data.focusIds.includes(m.id)).flatMap(m => [row(m, { title: '提交报告' + m.id, body: '提交实验报告至学习通。' }), row(m, { title: '填写登记表' + m.id, body: '填写登记表，核对姓名与学号。' })]));
  }); t.after(() => h.organizer.close()); await h.configure();
  for (let i=0;i<24;i++) await h.enqueue(source('bulk'+i, '各位同学好，请大家明天下午5点前提交实验报告，并填写登记表。请认真核对姓名与学号，谢谢大家配合。'));
  await h.organizer.tick();
  assert.equal(calls, 1); assert.equal(h.organizer.view().counts.done, 24);
  assert.equal(h.store().items.filter(i => i.llm).length, 48);
  assert.equal(h.store().items.find(i => i.id === 'bulk0').body.startsWith('各位同学好'), true);
  assert.equal(h.store().items.find(i => i.llm && i.title === '提交报告bulk0').body, '提交实验报告至学习通。');
});

test('truncated batches split persistently and every response usage is counted', async t => {
  const sizes=[];
  const fetcher=async (_url, options) => {
    const data=JSON.parse(JSON.parse(options.body).messages[1].content); const focus=data.messages.filter(m=>data.focusIds.includes(m.id)); sizes.push(focus.length);
    if (focus.length>6) return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{' } }], usage: { total_tokens: 100 } }));
    return answer(focus.map(m=>row(m,{title:'任务'+m.id})),50);
  };
  const h=await harness(fetcher); await h.configure({remember:true});
  for(let i=0;i<24;i++) await h.enqueue(source('split'+i));
  await h.organizer.tick(); assert.equal(h.organizer.view().usage.tokens,100); assert.equal(h.organizer.view().counts.queued,24);
  const seed=structuredClone(h.store()); await h.organizer.close();
  const next=await harness(fetcher,seed); t.after(()=>next.organizer.close());
  for(let i=0;i<10;i++) await next.organizer.tick();
  assert.deepEqual(sizes,[24,12,6,6,12,6,6]);
  assert.equal(next.organizer.view().counts.done,24); assert.equal(next.organizer.view().counts.failed,0);
  assert.equal(next.organizer.view().usage.tokens,500); assert.equal(next.organizer.view().usage.requests,7);
});

test('single-message truncation stops without blindly repeating the request', async t => {
  const h=await harness(async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{'}}],usage:{total_tokens:77}}))); t.after(()=>h.organizer.close());
  await h.configure(); await h.enqueue(source()); await h.organizer.tick(); await h.organizer.tick();
  assert.equal(h.organizer.view().counts.failed,1); assert.equal(h.organizer.view().usage.requests,1); assert.equal(h.organizer.view().usage.tokens,77); assert.match(h.organizer.view().lastError,/单条消息/);
});

test('history preview splits overlong batches without losing earlier results', async t=>{
  const sizes=[]; const h=await harness(async(_url,options)=>{
    const data=JSON.parse(JSON.parse(options.body).messages[1].content); sizes.push(data.messages.length);
    if(data.messages.length>1) return new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{'}}],usage:{total_tokens:20}}));
    return answer(data.messages.map(m=>row(m,{title:'历史任务'+m.id})));
  }); t.after(()=>h.organizer.close()); await h.configure({enabled:false});
  for(let i=0;i<2;i++) await h.enqueue(source('history'+i,source().body,{createdAt:new Date().toISOString(),publishedAt:new Date().toISOString()}));
  await h.organizer.preview({days:7,consent:true}); await h.organizer.tick();
  assert.equal(h.organizer.view().previews[0].status,'queued');
  await h.organizer.tick(); assert.equal(h.organizer.view().previews[0].status,'ready');
  assert.equal(h.organizer.view().previews[0].results.length,2); assert.deepEqual(sizes,[2,1,1]); assert.equal(h.store().items.some(i=>i.llm),false);
});

test('custom endpoints retain chosen output parameter and do not receive DeepSeek options', async()=>{
  let body;
  await requestCompletion({...llmDefaults,baseUrl:'https://custom.example/v1',tokenParameter:'max_completion_tokens',maxOutputTokens:8192},'synthetic',[],{fetcher:async(_url,options)=>{body=JSON.parse(options.body); return answer([]);}});
  assert.equal(body.max_completion_tokens,8192); assert.equal(body.max_tokens,undefined); assert.equal(body.thinking,undefined);
  const prompt=buildMessages([source()],[])[0].content;
  assert.match(prompt,/最多300字/); assert.match(prompt,/不直接复制整段通知/); assert.match(prompt,/逐字复制对应 sourceId/);
});


test('invalid evidence is isolated so another message in the same batch can finish', async t=>{
  const batches=[]; const h=await harness(async(_url,options)=>{
    const data=JSON.parse(JSON.parse(options.body).messages[1].content), focus=data.messages.filter(m=>data.focusIds.includes(m.id)); batches.push(focus.map(m=>m.id));
    return answer(focus.map(m=>row(m,{title:'任务'+m.id,...(m.id==='invalid-evidence'?{evidence:[{sourceId:m.id,quote:'not present in the original'}]}:{})})));
  }); t.after(()=>h.organizer.close()); await h.configure();
  await h.enqueue(source('valid-evidence')); await h.enqueue(source('invalid-evidence'));
  await h.organizer.tick(); await h.organizer.tick(); await h.organizer.tick(); await h.organizer.tick();
  assert.deepEqual(batches,[['valid-evidence','invalid-evidence'],['valid-evidence'],['invalid-evidence']]);
  assert.equal(h.organizer.view().counts.done,1); assert.equal(h.organizer.view().counts.failed,1);
  assert.equal(h.store().items.filter(i=>i.llm).length,1); assert.match(h.organizer.view().lastError,/原文依据/);
  assert.equal(h.store().items.find(i=>i.id==='invalid-evidence').body,source().body);
});
