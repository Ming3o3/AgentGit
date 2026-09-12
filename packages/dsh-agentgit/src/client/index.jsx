import React, { useEffect, useState } from 'react';

const PANEL_EVENT = 'agentgit:panel';

function setPanelOpen(open) {
  window.dispatchEvent(new CustomEvent(PANEL_EVENT, { detail: Boolean(open) }));
}

function usePanelOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onPanel = (event) => setOpen(Boolean(event.detail));
    window.addEventListener(PANEL_EVENT, onPanel);
    return () => window.removeEventListener(PANEL_EVENT, onPanel);
  }, []);
  return [open, setPanelOpen];
}

function formatTime(value) {
  if (!value) return '-';
  try { return new Date(value).toLocaleString(); } catch { return String(value); }
}

function formatDuration(value) {
  if (!Number.isFinite(value)) return '-';
  if (value < 1000) return `${value} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
  return `${(value / 60000).toFixed(1)} min`;
}

function statusClass(status) {
  return `agentgit-status agentgit-status-${String(status ?? 'unknown').replaceAll('_', '-')}`;
}

function Stat({ label, value }) {
  return <div className="agentgit-stat"><span>{label}</span><strong>{value ?? 0}</strong></div>;
}

function AgentGitButton({ wide }) {
  return <button type="button" title="AgentGit 历史" aria-label="打开 AgentGit 历史"
    className={`agentgit-button${wide ? ' agentgit-button-wide' : ''}`} onClick={() => setPanelOpen(true)}>
    <span className="agentgit-button-icon" aria-hidden="true">↺</span>{wide && <span className="agentgit-button-label">AgentGit</span>}
  </button>;
}

function EventRow({ event, onSelect }) {
  return <button type="button" className="agentgit-event" onClick={() => onSelect(event)}>
    <span className="agentgit-event-type">{event.type}</span>
    <span className="agentgit-event-meta">{event.agentId} · {formatTime(event.createdAt)}</span>
    <span className="agentgit-event-id">{event.id}</span>
  </button>;
}

function Relationship({ label, events }) {
  return <div className="agentgit-relationship"><strong>{label}</strong><span>{events.length}</span>
    {events.map((event) => <code key={event.id}>{event.type} / {event.id}</code>)}</div>;
}

function Detail({ event, context, onClose }) {
  if (!event) return null;
  return <div className="agentgit-detail-backdrop" onClick={onClose}>
    <section className="agentgit-detail" role="dialog" aria-modal="true" aria-label="事件详情" onClick={(e) => e.stopPropagation()}>
      <header><h3>事件详情</h3><button type="button" onClick={onClose}>×</button></header>
      <dl><dt>ID</dt><dd>{event.id}</dd><dt>类型</dt><dd>{event.type}</dd><dt>Agent</dt><dd>{event.agentId}</dd>
        <dt>Session</dt><dd>{event.sessionId ?? '-'}</dd><dt>时间</dt><dd>{formatTime(event.createdAt)}</dd></dl>
      {context && <div className="agentgit-relationships"><Relationship label="Parents" events={context.parents} />
        <Relationship label="Caused by" events={context.causation ? [context.causation] : []} />
        <Relationship label="Children" events={context.children} /><Relationship label="Effects" events={context.effects} /></div>}
      <pre>{JSON.stringify(event.payload, null, 2)}</pre>
    </section>
  </div>;
}

function AgentGitPanel() {
  const [open, setOpen] = usePanelOpen();
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [context, setContext] = useState(null);
  const [eventQuery, setEventQuery] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open, setOpen]);

  useEffect(() => {
    if (!open) return undefined;
    let stopped = false;
    const load = async () => {
      setLoading(true);
      try {
        const response = await fetch('/agentgit/api?limit=50', { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`AgentGit API ${response.status}`);
        const next = await response.json();
        if (!stopped) { setData(next); setError(null); }
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!stopped) setLoading(false);
      }
    };
    load();
    const timer = window.setInterval(load, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [open, refresh]);

  if (!open) return null;
  const summary = data?.summary ?? {};
  const taskCounts = summary.tasks ?? {};
  const deliveryCounts = summary.deliveries ?? {};
  const health = data?.health ?? { status: 'unknown', alerts: [] };
  const metrics = data?.metrics ?? {};
  const visibleEvents = (data?.events ?? []).filter((event) => {
    const query = eventQuery.trim().toLowerCase();
    return !query || [event.id, event.type, event.agentId, event.taskId, event.payload?.text]
      .filter(Boolean).join(' ').toLowerCase().includes(query);
  });
  const selectEvent = async (event) => {
    setSelected(event);
    setContext(null);
    try {
      const response = await fetch(`/agentgit/api?eventId=${encodeURIComponent(event.id)}`, { headers: { accept: 'application/json' } });
      if (response.ok) setContext(await response.json());
    } catch { /* The base event detail remains available when context loading fails. */ }
  };
  return <div className="agentgit-overlay" role="dialog" aria-modal="true" aria-label="AgentGit 历史面板" onClick={() => setOpen(false)}>
    <section className="agentgit-panel" onClick={(event) => event.stopPropagation()}>
      <header className="agentgit-panel-header"><div><h2>AgentGit 历史</h2><p>Agent 之间的消息、任务与不可变事件记录</p></div>
        <button type="button" className="agentgit-close" onClick={() => setOpen(false)} aria-label="关闭">×</button></header>
      {error && <div className="agentgit-error">无法读取 AgentGit：{error}</div>}
      <div className="agentgit-content">
        <section className="agentgit-section"><div className="agentgit-section-title"><h3>概览</h3><button type="button" onClick={() => setRefresh((value) => value + 1)} disabled={loading}>{loading ? '刷新中…' : '刷新'}</button></div>
          <div className="agentgit-stats"><Stat label="事件" value={summary.events} /><Stat label="Agent" value={summary.agents} />
            <Stat label="任务" value={Object.values(taskCounts).reduce((sum, count) => sum + count, 0)} /><Stat label="待处理消息" value={deliveryCounts.pending} />
            <Stat label="健康" value={health.status} /><Stat label="事件/分钟" value={metrics.events?.perMinute} />
            <Stat label="送达 P95" value={formatDuration(metrics.messages?.deliveryLatency?.p95Ms)} /><Stat label="完成 P95" value={formatDuration(metrics.tasks?.completionDuration?.p95Ms)} /></div></section>
        {!!health.alerts?.length && <section className="agentgit-alerts">{health.alerts.map((alert) => <p key={alert.code}><strong>{alert.severity}</strong>{alert.message}</p>)}</section>}
        <section className="agentgit-section"><div className="agentgit-section-title"><h3>任务</h3></div><div className="agentgit-table">
          {(data?.tasks ?? []).map((task) => <div className="agentgit-task" key={task.id}><div><strong>{task.title}</strong><small>{task.id}</small></div>
            <span className={statusClass(task.status)}>{task.status}</span><small>{task.assigneeId ?? '未分配'} · {formatTime(task.updatedAt)}</small></div>)}
          {!data?.tasks?.length && <div className="agentgit-empty">暂无任务</div>}</div></section>
        <section className="agentgit-section"><div className="agentgit-section-title"><h3>最近事件</h3><span>{visibleEvents.length} 条</span></div>
          <input className="agentgit-event-search" type="search" value={eventQuery} onChange={(event) => setEventQuery(event.target.value)} placeholder="搜索 ID、类型、Agent 或任务" aria-label="筛选事件" />
          <div className="agentgit-events">{visibleEvents.map((event) => <EventRow key={event.id} event={event} onSelect={selectEvent} />)}
          {!visibleEvents.length && <div className="agentgit-empty">暂无匹配事件</div>}</div></section>
        <section className="agentgit-section"><div className="agentgit-section-title"><h3>Refs / Checkpoints</h3></div><div className="agentgit-table">
          {(data?.refs ?? []).map((ref) => <div className="agentgit-ref" key={ref.name}><strong>{ref.name}</strong><code>{ref.event_id ?? '-'}</code><small>{formatTime(ref.updated_at)}</small></div>)}
          {!data?.refs?.length && <div className="agentgit-empty">暂无 ref</div>}</div></section>
      </div><Detail event={selected} context={context} onClose={() => { setSelected(null); setContext(null); }} />
    </section>
  </div>;
}

const css = `
.agentgit-button{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;border:0;border-radius:8px;background:transparent;color:inherit;padding:8px 10px;cursor:pointer;font:inherit}.agentgit-button-wide{justify-content:flex-start}.agentgit-button:hover{background:color-mix(in srgb,currentColor 10%,transparent)}.agentgit-button-icon{font-size:18px;line-height:20px}.agentgit-button-label{font-size:13px}.agentgit-overlay{position:fixed;inset:0;z-index:1000;display:flex;justify-content:flex-end;background:rgba(0,0,0,.18);pointer-events:auto}.agentgit-panel{width:min(720px,100vw);height:100%;overflow:auto;background:var(--background-primary,#fff);color:var(--text-primary,#1f2937);box-shadow:-8px 0 30px rgba(0,0,0,.18);font:14px system-ui,sans-serif}.agentgit-panel-header{display:flex;justify-content:space-between;gap:16px;padding:24px;border-bottom:1px solid rgba(128,128,128,.22);position:sticky;top:0;background:inherit;z-index:1}.agentgit-panel-header h2,.agentgit-panel-header p{margin:0}.agentgit-panel-header p{margin-top:5px;opacity:.65;font-size:12px}.agentgit-close{border:0;background:transparent;font-size:26px;cursor:pointer;color:inherit}.agentgit-content{padding:16px 24px 40px}.agentgit-section{margin-bottom:24px}.agentgit-section-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.agentgit-section-title h3{margin:0;font-size:14px}.agentgit-section-title button{border:1px solid rgba(128,128,128,.35);border-radius:6px;background:transparent;color:inherit;padding:4px 9px;cursor:pointer}.agentgit-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.agentgit-stat{border:1px solid rgba(128,128,128,.22);border-radius:8px;padding:12px}.agentgit-stat span,.agentgit-stat strong{display:block;min-width:0;overflow-wrap:anywhere}.agentgit-stat span{font-size:11px;opacity:.65}.agentgit-stat strong{font-size:18px;margin-top:4px}.agentgit-alerts{margin:-8px 0 20px;border-left:3px solid #b56416;background:rgba(245,158,11,.1);padding:8px 12px}.agentgit-alerts p{margin:4px 0;font-size:12px}.agentgit-alerts strong{margin-right:8px;text-transform:uppercase;font-size:10px}.agentgit-task,.agentgit-ref{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:12px;align-items:center;border-top:1px solid rgba(128,128,128,.16);padding:10px 0}.agentgit-task strong,.agentgit-task small,.agentgit-ref strong,.agentgit-ref small{display:block;min-width:0;overflow-wrap:anywhere}.agentgit-task small,.agentgit-ref small{font-size:11px;opacity:.62}.agentgit-ref code{overflow:hidden;text-overflow:ellipsis}.agentgit-status{border-radius:999px;padding:3px 8px;background:rgba(128,128,128,.15);font-size:11px;white-space:nowrap}.agentgit-status-completed{background:rgba(34,197,94,.16)}.agentgit-status-blocked{background:rgba(239,68,68,.16)}.agentgit-event-search{width:100%;height:34px;margin-bottom:8px;border:1px solid rgba(128,128,128,.35);border-radius:6px;background:transparent;color:inherit;padding:6px 9px}.agentgit-events{border:1px solid rgba(128,128,128,.22);border-radius:8px;overflow:hidden}.agentgit-event{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 12px;width:100%;border:0;border-top:1px solid rgba(128,128,128,.16);background:transparent;color:inherit;padding:10px 12px;text-align:left;cursor:pointer}.agentgit-event:first-child{border-top:0}.agentgit-event:hover{background:rgba(128,128,128,.08)}.agentgit-event-type{font-weight:600}.agentgit-event-meta{font-size:11px;opacity:.65}.agentgit-event-id{grid-column:1/-1;font:10px ui-monospace,monospace;opacity:.48;overflow:hidden;text-overflow:ellipsis}.agentgit-empty,.agentgit-error{padding:12px;border-radius:8px;background:rgba(128,128,128,.1);opacity:.7}.agentgit-error{margin:16px 24px 0;color:#b91c1c;background:rgba(239,68,68,.1);opacity:1}.agentgit-detail-backdrop{position:fixed;inset:0;z-index:2;background:rgba(0,0,0,.35);display:grid;place-items:center;padding:24px}.agentgit-detail{width:min(640px,100%);max-height:80vh;overflow:auto;border-radius:8px;background:var(--background-primary,#fff);padding:18px;box-shadow:0 12px 40px rgba(0,0,0,.24)}.agentgit-detail header{display:flex;justify-content:space-between}.agentgit-detail header h3{margin:0}.agentgit-detail header button{border:0;background:transparent;font-size:22px;cursor:pointer}.agentgit-detail dl{display:grid;grid-template-columns:90px 1fr;gap:6px 12px;font-size:12px}.agentgit-detail dt{opacity:.6}.agentgit-detail dd{margin:0;word-break:break-all}.agentgit-relationships{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid rgba(128,128,128,.2);border-bottom:1px solid rgba(128,128,128,.2);margin-top:12px}.agentgit-relationship{min-width:0;padding:9px}.agentgit-relationship strong,.agentgit-relationship span{font-size:11px}.agentgit-relationship span{margin-left:5px;opacity:.6}.agentgit-relationship code{display:block;margin-top:4px;font-size:9px;overflow-wrap:anywhere}.agentgit-detail pre{white-space:pre-wrap;word-break:break-word;background:rgba(128,128,128,.1);border-radius:8px;padding:12px;font-size:11px}
@media(max-width:600px){.agentgit-content{padding:12px 16px 32px}.agentgit-panel-header{padding:18px 16px}.agentgit-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.agentgit-task,.agentgit-ref{grid-template-columns:1fr auto}.agentgit-task small:last-child,.agentgit-ref small{grid-column:1/-1}.agentgit-event{grid-template-columns:1fr}.agentgit-event-id{grid-column:1}}
`;

function installStyles() {
  if (document.querySelector('style[data-agentgit-client]')) return;
  const style = document.createElement('style');
  style.dataset.agentgitClient = 'true';
  style.dataset.plugin = 'dsh-agentgit';
  style.dataset.pluginCss = 'dsh-agentgit/client.css';
  style.textContent = css;
  document.head.appendChild(style);
}

// Run inside the lazy-CJS factory so Harness can inventory and remove this
// plugin-owned stylesheet during hot reload or plugin teardown.
installStyles();

export const inject = ['slots'];

export function apply(ctx) {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'agentgit-history', order: 100 }, AgentGitButton));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'agentgit-history-panel', order: 100 }, AgentGitPanel));
}
