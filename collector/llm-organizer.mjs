import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { autoPromoteChatTasks } from '../shared/chat-triage.mjs';
import { windowsVault } from './windows-vault.mjs';
import { llmDefaults, cleanLlmConfig, scopeKey, sourceTime, buildMessages, validateResults, applyResults, taskRevision } from '../shared/llm-tasks.mjs';

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const initial = () => ({ config: { ...llmDefaults }, enabled: false, generation: 0, previews: [], usage: { day: today(), tokens: 0, requests: 0 }, lastError: null });
const eligible = i => i.source !== 'manual' && !i.llm && (!i.externalId?.includes(':work:')) && (!i.kind || i.kind !== 'task' || i.autoTask) && !i.done && !i.archived && !i.userEditedAt && i.triageDecision !== 'dismissed';
export function queueLlmItem(draft, item) {
  if (draft.llm?.enabled && eligible(item)) item.llmQueue = { status: 'queued', attempts: 0, nextAt: Date.now() + 2000 };
}
function checkedResults(content, sources, existing) {
  try { return validateResults(content, sources, existing); }
  catch (error) { error.code = 'INVALID_RESULT'; throw error; }
}
function partition(items, config) {
  const groups = new Map();
  for (const item of items) {
    const key = JSON.stringify([scopeKey(item), item.llmQueue?.splitGroup || '']); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item);
  }
  const batches = [];
  for (const group of groups.values()) {
    group.sort((a, b) => String(sourceTime(a) || a.createdAt).localeCompare(String(sourceTime(b) || b.createdAt)));
    let batch = [], size = 0;
    for (const item of group) {
      const length = JSON.stringify(item.body || item.title).length;
      if (batch.length && (size + length > 48000 || batch.length >= (config.batchSize || llmDefaults.batchSize))) { batches.push(batch); batch = []; size = 0; }
      batch.push(item); size += length;
    }
    if (batch.length) batches.push(batch);
  }
  return batches;
}

export async function requestCompletion(config, key, messages, { fetcher = fetch, signal, timeout = 120000 } = {}) {
  let response;
  const maxOutputTokens = config.maxOutputTokens ?? llmDefaults.maxOutputTokens;
  const deepseek = new URL(config.baseUrl).hostname === 'api.deepseek.com';
  const fast = deepseek && config.fastMode !== false;
  try {
    response = await fetcher(config.baseUrl + '/chat/completions', { method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout), headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ model: config.model, messages, [config.tokenParameter || 'max_tokens']: maxOutputTokens, ...(fast ? { thinking: { type: 'disabled' } } : {}), ...(config.jsonMode ? { response_format: { type: 'json_object' } } : {}) }) });
  } catch { throw bad('连接失败或超时，请检查服务地址和网络后重试', 503); }
  if (!response.ok) {
    await response.body?.cancel();
    throw bad(({ 401: 'API Key 无效或已失效，请重新填写', 403: '服务拒绝访问，请检查模型权限', 402: '服务余额不足，请充值后重试', 429: '请求频率或服务额度受限，请稍后重试' })[response.status] || (response.status >= 500 ? '模型服务暂时不可用，请稍后重试' : '模型不支持当前请求，请检查模型名称及 JSON 模式'), response.status >= 500 ? 503 : response.status);
  }
  const reader = response.body.getReader(); let length = 0; const chunks = [];
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 1500000) throw Object.assign(bad('模型响应过大，需拆分消息批次'), { code: 'OUTPUT_LENGTH' }); chunks.push(Buffer.from(value)); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error.status ? error : bad('读取模型响应超时，请重试', 503); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw bad('模型服务返回了无效响应'); }
  const answer = data.choices?.[0], used = data.usage?.total_tokens;
  const tokens = Number.isSafeInteger(used) && used >= 0 ? used : null;
  if (answer?.finish_reason === 'length') throw Object.assign(bad('模型输出达到单次上限'), { code: 'OUTPUT_LENGTH', tokens });
  if (typeof answer?.message?.content !== 'string' || !answer.message.content.trim()) throw Object.assign(bad('模型未返回内容，请重试或更换模型'), { tokens });
  return { content: answer.message.content, tokens };
}

export async function createLlmOrganizer({ getStore, transaction, vault = windowsVault, fetcher = fetch, interval = 500, requestInterval = 250 }) {
  let key = '', busy = false, closed = false, controller = null, settingsBusy = false;
  let lastRequest = 0;
  await transaction(draft => {
    draft.llm ||= initial(); draft.llm.previews ||= [];
    draft.llm.config = { ...llmDefaults, ...draft.llm.config };
    for (const item of draft.items) if (item.llmQueue?.status === 'running') item.llmQueue.status = 'queued';
    for (const job of draft.llm.previews) if (job.status === 'running') job.status = 'queued';
  });
  if (getStore().llm.secretCipher) {
    try { key = await vault('unprotect', getStore().llm.secretCipher); }
    catch { await transaction(draft => { draft.llm.lastError = '无法解密保存的 API Key，请在设置中重新填写'; }); }
  }
  function view() {
    const state = getStore().llm;
    const counts = { queued: 0, retry: 0, running: 0, failed: 0, done: 0 };
    for (const item of getStore().items) { const status = item.llmQueue?.status; if (status in counts) counts[status]++; }
    return { config: state.config, enabled: state.enabled, hasKey: Boolean(key), remembered: Boolean(state.secretCipher), canRemember: process.platform === 'win32', counts, lastError: state.lastError, usage: state.usage.day === today() ? state.usage : { day: today(), tokens: 0, requests: 0 }, previews: state.previews.map(({ id, status, count, results, added, error, createdAt }) => ({ id, status, count, results, added, error, createdAt })) };
  }
  function existingFor(sources) {
    const scope = scopeKey(sources[0]);
    return getStore().items.filter(i => i.kind === 'task' && scopeKey(i) === scope && !i.archived && !sources.some(s => s.id === i.id)).slice(0, 30);
  }
  async function completion(config, apiKey, messages) {
    const wait = lastRequest + requestInterval - Date.now();
    if (wait > 0) await delay(wait, undefined, { signal: controller?.signal });
    if (closed || controller?.signal.aborted) throw bad('整理已暂停', 409);
    // Reserve an upper bound on input bytes + output, so parallel requests cannot overspend.
    const reserve = Buffer.byteLength(JSON.stringify(messages), 'utf8') + (config.maxOutputTokens ?? llmDefaults.maxOutputTokens);
    await transaction(draft => {
      const state = draft.llm;
      if (state.usage.day !== today()) state.usage = { day: today(), tokens: 0, requests: 0 };
      if (state.usage.tokens + reserve > config.dailyTokenLimit) throw bad('达到每日用量上限，请提高额度或明天再试', 409);
      state.usage.tokens += reserve; state.usage.requests++;
    });
    lastRequest = Date.now();
    // Failed/unknown-usage requests retain the reservation, avoiding undercounting.
    const requestDay = today();
    const settle = async tokens => { if (tokens !== null && tokens !== undefined) await transaction(draft => { if (draft.llm.usage.day === requestDay) draft.llm.usage.tokens = Math.max(0, draft.llm.usage.tokens - reserve + tokens); }); };
    let result;
    try { result = await requestCompletion(config, apiKey, messages, { fetcher, signal: controller?.signal }); }
    catch (error) { await settle(error.tokens); throw error; }
    await settle(result.tokens);
    return result;
  }
  async function save(input) {
    if (settingsBusy) throw bad('正在保存设置，请稍候', 409);
    settingsBusy = true;
    try {
      const config = cleanLlmConfig(input);
      const prior = getStore().llm;
      const changedEndpoint = prior.config.baseUrl !== config.baseUrl;
      if (changedEndpoint && !input.apiKey) throw bad('更换服务地址时请重新填写该服务的 API Key');
      const nextKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : key;
      if (nextKey.length > 512 || /[\s\r\n]/u.test(nextKey)) throw bad('API Key 格式不正确');
      if (input.enabled && (!nextKey || input.consent !== true)) throw bad('启用前请填写 API Key，并确认允许发送待整理的消息');
      const cipher = input.remember && nextKey ? await vault('protect', nextKey) : null;
      controller?.abort();
      await transaction(draft => { Object.assign(draft.llm, { config, enabled: input.enabled === true, secretCipher: cipher, generation: draft.llm.generation + 1, lastError: null }); });
      key = nextKey;
      return view();
    } finally { settingsBusy = false; }
  }
  async function test(input) {
    if (busy || settingsBusy) throw bad('正在整理或保存设置，请稍后测试', 409);
    busy = true; controller = new AbortController();
    try {
      const config = cleanLlmConfig(input);
      if (config.baseUrl !== getStore().llm.config.baseUrl && !input.apiKey) throw bad('更换服务地址时请重新填写 API Key');
      const apiKey = String(input.apiKey || key).trim();
      if (!apiKey || apiKey.length > 512 || /\s/u.test(apiKey)) throw bad('请填写有效的 API Key');
      const result = await completion({ ...config, maxOutputTokens: 256 }, apiKey, [{ role: 'system', content: '只输出 JSON：{"ok":true}' }, { role: 'user', content: '测试连接，不包含真实消息。' }]);
      try { if (JSON.parse(result.content).ok !== true) throw new Error(); } catch { throw bad('服务已连接，但未按要求返回 JSON，请检查模型或 JSON 模式'); }
      return { ok: true, message: '连接成功，模型能够返回结构化内容', tokens: result.tokens };
    } finally { busy = false; controller = null; }
  }
  async function preview(input) {
    if (input.consent !== true) throw bad('请先确认允许发送待整理的文字消息');
    if (!key) throw bad('请先保存模型配置和 API Key');
    const days = Number(input.days);
    if (![1, 7, 30].includes(days)) throw bad('请选择近 1、7 或 30 天');
    const items = getStore().items.filter(i => eligible(i) && !['done', 'running', 'queued', 'retry'].includes(i.llmQueue?.status) && sourceTime(i) && Date.parse(sourceTime(i)) >= Date.now() - days * 86400000);
    if (items.length > 100) throw bad(`范围内有 ${items.length} 条消息，请缩小到近 1 天；每次最多整理 100 条`);
    if (!items.length) throw bad('该范围内没有可整理的消息；已手动处理或原时间未知的消息会跳过');
    const job = { id: randomBytes(10).toString('hex'), status: 'queued', count: items.length, groups: partition(items, getStore().llm.config).map(rows => rows.map(i => i.id)), results: [], createdAt: new Date().toISOString() };
    await transaction(draft => { if (draft.llm.previews.some(j => ['running', 'queued'].includes(j.status))) throw bad('已有历史消息正在整理，请等待完成', 409); draft.llm.previews = [...draft.llm.previews.slice(-4), job]; });
    return { id: job.id, count: job.count };
  }
  async function apply(id, selection) {
    return transaction(draft => {
      const job = draft.llm.previews.find(j => j.id === id);
      if (!job || job.status !== 'ready') throw bad('预览不存在或已处理，请刷新', 409);
      if (!Array.isArray(selection) || !selection.length || selection.some(i => !Number.isInteger(i) || i < 0 || i >= job.results.length)) throw bad('请选择要保存的事项');
      const added = applyResults(draft, job.results, { selected: selection });
      for (const id of added) for (const sourceId of draft.items.find(i => i.id === id).llm.sourceIds) {
        const source = draft.items.find(i => i.id === sourceId);
        if (source.autoTask && !source.done && !source.archived && !source.userEditedAt) { source.kind = 'notification'; delete source.autoTask; }
        source.llmQueue = { status: 'done' };
      }
      job.status = 'applied'; job.added = added.length; return { added: added.length };
    });
  }
  async function review(id, accept) {
    return transaction(draft => {
      const proposal = draft.items.find(i => i.id === id);
      if (!proposal?.llm?.review) throw bad('该事项已处理，请刷新', 409);
      if (!accept) { proposal.triageDecision = 'dismissed'; proposal.llm.review = false; proposal.userEditedAt = new Date().toISOString(); return { ok: true }; }
      const target = proposal.llm.targetId && draft.items.find(i => i.id === proposal.llm.targetId);
      if (proposal.llm.kind === 'change' && !target) throw bad('未能可靠关联原待办，请打开原待办手动核对变更', 409);
      if (proposal.llm.targetId && (!target || taskRevision(target) !== proposal.llm.targetRevision || target.done || target.archived || target.userEditedAt || target.triageDecision === 'dismissed')) throw bad('原待办已被处理或修改，请打开原待办手动核对，避免覆盖你的操作', 409);
      if (target) {
        if (proposal.llm.changeAction === 'cancel') { target.archived = true; target.llmCancelledBy = proposal.id; }
        else { for (const field of ['title', 'body', 'due', 'dueAt', 'eventDate', 'eventAt']) target[field] = proposal[field]; target.llmUpdatedBy = proposal.id; }
        target.userEditedAt = new Date().toISOString(); proposal.archived = true;
      } else { proposal.kind = 'task'; }
      proposal.llm.review = false; proposal.confidence = 'high'; proposal.userEditedAt = new Date().toISOString();
      return { ok: true };
    });
  }
  async function tick() {
    if (closed || busy || settingsBusy || !key) return;
    const state = getStore().llm;
    const job = state.previews.find(j => j.status === 'queued');
    const pending = getStore().items.filter(i => eligible(i) && ['queued', 'retry'].includes(i.llmQueue?.status) && i.llmQueue.nextAt <= Date.now());
    if (!job && (!state.enabled || !pending.length)) return;
    busy = true; controller = new AbortController();
    const generation = state.generation, config = state.config;
    let batch = [], existing = [], activeGroup = -1;
    try {
      if (job) {
        await transaction(draft => { draft.llm.previews.find(j => j.id === job.id).status = 'running'; });
        for (const [groupIndex, ids] of job.groups.entries()) {
          if (groupIndex < (job.nextGroup || 0)) continue;
          if (closed || generation !== getStore().llm.generation) throw bad('设置已更改，请重新预览', 409);
          activeGroup = groupIndex;
          const sources = ids.map(id => getStore().items.find(i => i.id === id)).filter(Boolean);
          if (!sources.length) continue;
          const tasks = existingFor(sources);
          const response = await completion(config, key, buildMessages(sources, tasks));
          const results = checkedResults(response.content, sources, tasks);
          await transaction(draft => { const j = draft.llm.previews.find(j => j.id === job.id); j.results.push(...results); j.nextGroup = groupIndex + 1; });
        }
        await transaction(draft => { if (generation !== draft.llm.generation) throw bad('设置已更改，请重新预览', 409); draft.llm.previews.find(j => j.id === job.id).status = 'ready'; draft.llm.lastError = null; });
      } else {
        batch = partition(pending, config)[0]; existing = existingFor(batch);
        // Include adjacent text from the same conversation to resolve follow-up fragments.
        const focusIds = batch.map(i => i.id), scope = scopeKey(batch[0]);
        const firstTime = Date.parse(sourceTime(batch[0]) || batch[0].createdAt);
        const context = []; let contextSize = 0;
        for (const item of getStore().items) {
          if (context.length >= 6) break;
          if (!item.llm && scopeKey(item) === scope && !focusIds.includes(item.id) && sourceTime(item) && Date.parse(sourceTime(item)) <= firstTime && Date.parse(sourceTime(item)) >= firstTime - 2 * 3600000 && contextSize + (item.body?.length || 0) <= 12000) { context.push(item); contextSize += item.body?.length || 0; }
        }
        const sources = [...context, ...batch];
        await transaction(draft => { for (const row of batch) { const i = draft.items.find(i => i.id === row.id); i.llmQueue.status = 'running'; i.llmQueue.attempts++; } });
        const messages = buildMessages(sources, existing);
        messages[1].content = JSON.stringify({ ...JSON.parse(messages[1].content), focusIds, instruction: '只整理与 focusIds 新消息有关的事项，其他消息仅供上下文参考，不重复输出旧事项。' });
        const response = await completion(config, key, messages);
        const results = checkedResults(response.content, sources, existing).filter(r => r.sourceIds.some(id => focusIds.includes(id)));
        await transaction(draft => {
          if (generation !== draft.llm.generation || closed) throw bad('设置已更改，本次结果未写入', 409);
          applyResults(draft, results);
          for (const row of batch) { const i = draft.items.find(i => i.id === row.id); if (i) i.llmQueue = { status: 'done' }; }
          draft.llm.lastError = null;
        });
      }
    } catch (error) {
      if (!closed) await transaction(draft => {
        const outputLimited = error.code === 'OUTPUT_LENGTH', invalidResult = error.code === 'INVALID_RESULT';
        const split = outputLimited || invalidResult;
        const message = outputLimited ? '模型输出达到上限，已自动拆小批次继续整理' : invalidResult ? error.message + '；已拆小批次隔离检查' : error.status ? error.message : '整理失败，请重试';
        const terminalMessage = outputLimited ? '单条消息的输出仍超长，请提高单次输出上限后重试' : error.message;
        draft.llm.lastError = message;
        if (job) {
          const j = draft.llm.previews.find(j => j.id === job.id), ids = j?.groups[activeGroup];
          if (j && split && ids?.length > 1) {
            const middle = Math.ceil(ids.length / 2);
            j.groups.splice(activeGroup, 1, ids.slice(0, middle), ids.slice(middle));
            j.status = 'queued'; j.nextGroup = activeGroup; delete j.error;
          } else if (j) { j.status = 'failed'; j.error = split ? terminalMessage : message; draft.llm.lastError = j.error; }
        } else if (split && batch.length > 1) {
          const middle = Math.ceil(batch.length / 2), group = randomBytes(8).toString('hex');
          for (const [index, row] of batch.entries()) {
            const item = draft.items.find(i => i.id === row.id); if (!item?.llmQueue) continue;
            Object.assign(item.llmQueue, { status: 'queued', attempts: 0, nextAt: Date.now(), splitGroup: group + (index < middle ? ':a' : ':b'), error: message });
          }
        } else for (const row of batch) {
          const item = draft.items.find(i => i.id === row.id); if (!item?.llmQueue) continue;
          const retry = item.llmQueue.attempts < 3 && !split && ![401, 402, 403, 409].includes(error.status);
          Object.assign(item.llmQueue, { status: retry ? 'retry' : 'failed', nextAt: Date.now() + 15000 * item.llmQueue.attempts, error: split ? terminalMessage : message });
          if (split) draft.llm.lastError = item.llmQueue.error;
        }
        autoPromoteChatTasks(draft.items);
      });
    } finally { busy = false; controller = null; }
  }
  const timer = setInterval(() => { void tick().catch(() => {}); }, interval); timer.unref();
  return { view, save, test, preview, apply, review, tick,
    async pause() { controller?.abort(); await transaction(draft => { draft.llm.enabled = false; draft.llm.generation++; for (const j of draft.llm.previews) if (j.status === 'queued') j.status = 'failed', j.error = '整理已暂停，请重新预览'; }); return view(); },
    async clear() { await this.pause(); key = ''; await transaction(draft => { delete draft.llm.secretCipher; }); return view(); },
    async retry() { await transaction(draft => { for (const i of draft.items) if (eligible(i) && i.llmQueue?.status === 'failed') i.llmQueue = { status: 'queued', attempts: 0, nextAt: Date.now() }; draft.llm.lastError = null; }); return view(); },
    async close() { closed = true; clearInterval(timer); controller?.abort(); }
  };
}
