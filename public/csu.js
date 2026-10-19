(() => {
  const dialog = document.querySelector('#csuDialog');
  if (!dialog) return;
  const field = id => document.getElementById(id);
  let loading = false, latest = null, lastSync = null;
  function feedback(text) { field('csuError').textContent = text || ''; field('csuError').hidden = !text; }
  function paint(value) {
    latest = value;
    field('csuHeadline').textContent = value.busy ? '正在处理…' : { connected: '教务采集正常', partial: '部分读取成功', needs_login: '等待学校登录', error: '需要处理', not_configured: '尚未连接' }[value.status] || '尚未连接';
    field('csuStatus').textContent = value.message;
    field('csuLastSync').textContent = value.lastSync ? `最近同步：${new Date(value.lastSync).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）` : '尚无成功同步记录';
    field('csuConnect').disabled = value.busy;
    field('csuConnect').textContent = value.configured ? '重新打开学校登录窗口' : '打开学校登录窗口';
    field('csuSync').hidden = !value.configured;
    field('csuSync').disabled = value.busy;
    field('csuSync').textContent = ['connected', 'partial'].includes(value.status) ? '立即同步教务通知' : '我已登录，开始同步';
    field('csuDisconnect').disabled = value.busy;
    field('csuSettings').hidden = !value.configured && !value.remembered;
    field('csuRemember').disabled = !value.canRemember || value.busy;
    field('csuDays').disabled = value.busy;
    const warnings = field('csuWarnings'); warnings.replaceChildren();
    for (const text of value.warnings || []) { const p = document.createElement('p'); p.textContent = text; warnings.append(p); }
    warnings.hidden = !value.warnings?.length;
    field('csuLlmNote').textContent = state.llm?.enabled ? '大模型自动整理已开启，新通知会沿用当前服务和用量设置。' : '可在“大模型整理”中启用自动处理；未启用时，仍会保存教务通知原文。';
    if (lastSync !== value.lastSync) { lastSync = value.lastSync; void sync(); }
  }
  async function refresh() {
    if (loading || !dialog.open || !authenticated) return;
    loading = true;
    try { paint(await api('/api/accounts/csu')); } catch (error) { feedback(error.message); }
    finally { loading = false; }
  }
  async function open() {
    feedback(''); dialog.showModal();
    if (!state.localAccountsEnabled) { feedback('请先连接本机 Daymark 服务，再管理教务登录'); field('csuConnect').disabled = true; return; }
    await refresh();
    if (latest) { field('csuDays').value = String(latest.days); field('csuRemember').checked = latest.canRemember && (latest.configured ? latest.remembered : true); }
  }
  document.addEventListener('click', event => { if (event.target.closest('[data-connect-csu]')) void open(); });
  field('csuConnect').addEventListener('click', async () => {
    feedback(''); field('csuConnect').disabled = true;
    try {
      const result = await api('/api/accounts/csu', { method: 'POST', body: JSON.stringify({ days: Number(field('csuDays').value), remember: field('csuRemember').checked }) });
      paint(result); toast('正在打开学校登录窗口，请在那里完成验证');
    } catch (error) { feedback(error.message); } finally { if (!latest?.busy) field('csuConnect').disabled = false; }
  });
  field('csuSync').addEventListener('click', async () => {
    feedback(''); field('csuSync').disabled = true;
    try { paint(await api('/api/accounts/csu/sync', { method: 'POST', body: JSON.stringify({ days: Number(field('csuDays').value) }) })); } catch (error) { feedback(error.message); } finally { if (!latest?.busy) field('csuSync').disabled = false; }
  });
  field('csuDisconnect').addEventListener('click', async () => {
    feedback('');
    try { paint(await api('/api/accounts/csu', { method: 'DELETE', body: '{}' })); await sync(); toast('已删除保存的教务登录状态'); } catch (error) { feedback(error.message); }
  });
  field('csuOpenLlm').addEventListener('click', () => { dialog.close(); document.querySelector('#openLlm').click(); });
  setInterval(() => { void refresh(); }, 2000);
})();
