'use strict';

(() => {
  const form = $('#llmForm');
  $('#llmAdvanced').insertAdjacentHTML('beforeend', '<label class="form-field">输出长度参数<select name="tokenParameter"><option value="max_tokens">通用 / DeepSeek（max_tokens）</option><option value="max_completion_tokens">新版 OpenAI（max_completion_tokens）</option></select></label>');
  let info = null, working = false, initialized = false, previewSignature = '';
  const dateText = (date, at) => at ? `${at.slice(0, 10)} ${at.slice(11, 16)}（北京时间）` : date || '待确认';
  const feedback = (message, error = false) => { $('#llmFeedback').textContent = message; $('#llmFeedback').dataset.error = String(error); };
  function loadForm() {
    if (!info) return;
    for (const key of ['provider', 'model', 'baseUrl', 'dailyTokenLimit', 'tokenParameter', 'batchSize', 'maxOutputTokens']) form.elements[key].value = info.config[key] || (key === 'tokenParameter' ? 'max_tokens' : '');
    form.elements.jsonMode.checked = info.config.jsonMode;
    form.elements.fastMode.checked = info.config.fastMode !== false;
    form.elements.enabled.checked = info.enabled;
    form.elements.remember.checked = info.remembered;
    form.elements.remember.disabled = !info.canRemember;
    form.elements.consent.checked = info.enabled;
    form.elements.apiKey.value = '';
    initialized = true;
  }
  function render(value) {
    if (!value) { $('#openLlm').disabled = state.mode === 'cloud'; return; }
    info = { ...value, config: { batchSize: 24, maxOutputTokens: 16384, fastMode: true, ...value.config } };
    const active = info.enabled && info.hasKey;
    $('#llmSummary').textContent = `${active ? '自动整理已开启' : info.enabled ? '需要重新填写 API Key' : '自动整理未开启'} · ${info.config.model}`;
    $('#llmKeyNote').textContent = info.hasKey ? `已配置密钥；留空沿用。${info.remembered ? '已由 Windows 账户加密保存。' : '仅本次运行有效，重启后需重新输入。'}` : '尚未配置密钥。密钥仅用于后台调用，不会显示在事项中。';
    const c = info.counts;
    $('#llmStatus').textContent = `${active ? '自动整理中' : info.enabled ? '等待 API Key' : '自动整理已暂停'} · 等待 ${c.queued || 0} · 重试 ${c.retry || 0} · 处理中 ${c.running || 0} 条 · 完成 ${c.done || 0} · 失败 ${c.failed || 0}`;
    $('#llmBatchSummary').textContent = `每批最多 ${info.config.batchSize} 条消息，可生成多条事项；单次输出最多 ${info.config.maxOutputTokens.toLocaleString()} tokens。`;
    $('#llmUsage').textContent = `今日已用 / 保守估计 ${info.usage.tokens.toLocaleString()} / ${info.config.dailyTokenLimit.toLocaleString()} tokens · ${info.usage.requests} 次请求`;
    $('#llmError').textContent = info.lastError || '';
    $('#llmRetry').disabled = !c.failed || working;
    $('#llmPause').disabled = working || !info.enabled && !info.previews.some(j => ['running', 'queued'].includes(j.status));
    $('#llmClear').disabled = working || !info.hasKey && !info.remembered;
    if (!initialized) loadForm();
    const signature = JSON.stringify(info.previews);
    if (previewSignature !== signature) { previewSignature = signature; renderPreviews(); }
  }
  function renderPreviews() {
    $('#llmPreviews').innerHTML = info.previews.slice().reverse().map(job => {
      const label = ({ queued: '等待整理', running: '正在整理', ready: '预览完成', applied: `已保留 ${job.added} 项`, failed: '整理失败' })[job.status];
      return `<div class="llm-preview" data-preview="${escapeHtml(job.id)}"><strong>${escapeHtml(label)} · ${job.count} 条原消息</strong>${job.error ? `<p>${escapeHtml(job.error)}</p>` : ''}${job.status === 'ready' ? `${job.results.length ? '<p>勾选需要保留的结果；需要核对的事项将进入待确认。</p>' : '<p>没有识别到新的具体事项，原文已保留。</p>'}${job.results.map((r, index) => `<label class="llm-preview-row"><input type="checkbox" value="${index}" checked><strong>${escapeHtml(r.title)}</strong><p>${escapeHtml(r.body)}</p><p>截止：${escapeHtml(dateText(r.due, r.dueAt))}${r.eventDate ? `<br>发生：${escapeHtml(dateText(r.eventDate, r.eventAt))}` : ''}</p><p>${r.needsReview ? '待确认 · ' : ''}${escapeHtml(r.reason)}</p><p>${escapeHtml(r.evidence.map(e => '原文：' + e.quote).join('\n'))}</p></label>`).join('')}${job.results.length ? '<button class="add-button" type="button" data-apply-preview>保留所选事项</button>' : ''}` : ''}</div>`;
    }).join('');
  }
  function input() { return { provider: form.elements.provider.value, baseUrl: form.elements.baseUrl.value, model: form.elements.model.value, dailyTokenLimit: Number(form.elements.dailyTokenLimit.value), batchSize: Number(form.elements.batchSize.value), maxOutputTokens: Number(form.elements.maxOutputTokens.value), fastMode: form.elements.fastMode.checked, jsonMode: form.elements.jsonMode.checked, tokenParameter: form.elements.tokenParameter.value, apiKey: form.elements.apiKey.value, remember: form.elements.remember.checked, enabled: form.elements.enabled.checked, consent: form.elements.consent.checked }; }
  async function operation(action) {
    if (working) return;
    working = true;
    $$('#llmDialog button:not([data-close])').forEach(b => { b.disabled = true; });
    try { await action(); } catch (error) { feedback(error.message, true); }
    finally { working = false; $$('#llmDialog button').forEach(b => { b.disabled = false; }); if (info) render(info); }
  }
  $('#openLlm').addEventListener('click', () => operation(async () => { render(await api('/api/llm')); loadForm(); feedback(''); $('#llmDialog').showModal(); }));
  form.elements.provider.addEventListener('change', () => {
    if (form.elements.provider.value === 'deepseek') { form.elements.baseUrl.value = 'https://api.deepseek.com/v1'; form.elements.model.value = 'deepseek-flash'; form.elements.jsonMode.checked = true; form.elements.tokenParameter.value = 'max_tokens'; }
    else { $('#llmAdvanced').open = true; form.elements.baseUrl.value = ''; form.elements.model.value = ''; }
    form.elements.apiKey.value = ''; form.elements.enabled.checked = false; form.elements.consent.checked = false;
  });
  form.elements.baseUrl.addEventListener('input', () => { form.elements.consent.checked = false; });
  form.addEventListener('submit', event => { event.preventDefault(); void operation(async () => { feedback('正在保存…'); render(await api('/api/llm', { method: 'PUT', body: JSON.stringify(input()), signal: AbortSignal.timeout(30000) })); form.elements.apiKey.value = ''; feedback('设置已保存。历史消息可在下方单独预览。'); await sync(); }); });
  $('#llmTest').addEventListener('click', () => operation(async () => { feedback('正在测试连接，不发送真实消息…'); const result = await api('/api/llm/test', { method: 'POST', body: JSON.stringify(input()), signal: AbortSignal.timeout(125000) }); feedback(result.message); render(await api('/api/llm')); }));
  for (const [id, path, text] of [['llmPause', 'pause', '整理已暂停，原文和已生成事项均已保留。'], ['llmRetry', 'retry', '失败消息已重新排队；请确保自动整理已启用。']]) $( '#' + id).addEventListener('click', () => operation(async () => { render(await api('/api/llm/' + path, { method: 'POST', body: '{}' })); form.elements.enabled.checked = info.enabled; feedback(text); }));
  $('#llmClear').addEventListener('click', () => operation(async () => { render(await api('/api/llm', { method: 'DELETE', body: '{}' })); loadForm(); feedback('已暂停整理并移除保存的密钥。'); }));
  $('#llmPreview').addEventListener('click', () => operation(async () => {
    if (!form.elements.consent.checked) throw new Error('请先勾选允许发送待整理文字的说明');
    if (form.elements.apiKey.value) throw new Error('请先保存设置，再生成预览');
    const result = await api('/api/llm/preview', { method: 'POST', body: JSON.stringify({ days: Number($('#llmDays').value), consent: true }) });
    feedback(`已开始整理 ${result.count} 条消息，结果将在下方出现。`); render(await api('/api/llm'));
  }));
  $('#llmPreviews').addEventListener('click', event => {
    const button = event.target.closest('[data-apply-preview]'); if (!button) return;
    const container = button.closest('[data-preview]');
    const selected = $$('input:checked', container).map(i => Number(i.value));
    void operation(async () => { const result = await api('/api/llm/apply', { method: 'POST', body: JSON.stringify({ id: container.dataset.preview, selected }) }); feedback(`已保留 ${result.added} 项；重复或已手动处理的结果会跳过。`); await sync(); render(await api('/api/llm')); });
  });
  $('#llmDialog').addEventListener('close', () => { form.elements.apiKey.value = ''; });
  setInterval(() => { if ($('#llmDialog').open && !working && authenticated) void api('/api/llm').then(render).catch(() => {}); }, 2000);
  window.daymarkLlm = { render, dateText,
    detail(item) {
      if (!item.llm) return '';
      const llm = item.llm;
      return `<p class="detail-hint">大模型整理 · ${escapeHtml(llm.reason)}${llm.review ? '；请核对后确认。' : ''}</p>${item.eventDate || llm.eventText ? `<p>发生时间：${escapeHtml(dateText(item.eventDate, item.eventAt))}${llm.eventText ? ` · 原文：${escapeHtml(llm.eventText)}` : ''}</p>` : ''}${llm.dueText ? `<p>截止依据：${escapeHtml(llm.dueText)}</p>` : ''}${llm.targetId ? `<p>关联原待办：${escapeHtml(state.items.find(i => i.id === llm.targetId)?.title || '原待办已删除')}。确认后才会更新或取消。</p>` : ''}${llm.evidence.map(e => { const raw = state.items.find(i => i.id === e.sourceId); return `<blockquote class="llm-evidence">${escapeHtml(e.quote)}<br><small>${escapeHtml(raw ? shortTime(sourceMessageTime(raw)) : '原消息已删除')}</small></blockquote>`; }).join('')}`;
    },
    async review(item, accept) { await api('/api/llm/review', { method: 'POST', body: JSON.stringify({ id: item.id, accept }) }); $('#detailDialog').close(); await sync(); toast(accept ? '已确认' : '已排除'); }
  };
  function sourceMessageTime(item) { return item.publishedAt || (!['collected', 'observed'].includes(item.timestampKind) ? item.createdAt : null); }
})();
