const byId = (id) => document.getElementById(id);

let currentData = { events: [], tasks: [], refs: [] };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function relativeTime(value) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function formatDuration(value) {
  if (!Number.isFinite(value)) return '-';
  if (value < 1000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / (1024 ** index);
  return `${scaled.toFixed(index === 0 || scaled >= 10 ? 0 : 1)} ${units[index]}`;
}

function eventSummary(event) {
  const payload = event.payload ?? {};
  if (event.type.endsWith('.message') || event.type === 'message.sent') return payload.text ?? 'Message';
  if (event.type === 'task.created') return payload.title ?? 'Task created';
  if (event.type === 'task.assigned') return `Assigned to ${payload.assigneeId ?? 'agent'}`;
  if (event.type === 'task.status_changed') return `Status changed to ${payload.status ?? 'unknown'}`;
  if (event.type === 'git.checkpoint') return payload.summary ?? 'Checkpoint created';
  if (event.type === 'tool.called') return payload.name ?? 'Tool called';
  if (event.type === 'tool.completed') return 'Tool completed';
  return event.type;
}

function renderTasks(tasks) {
  byId('task-total').textContent = `${tasks.length} total`;
  byId('tasks').innerHTML = tasks.length ? tasks.map((task) => `
    <tr>
      <td>${escapeHtml(task.title)}<small>${escapeHtml(task.id)}</small></td>
      <td>${escapeHtml(task.assigneeId ?? 'Unassigned')}</td>
      <td><span class="priority priority-${escapeHtml(task.priority)}">${escapeHtml(task.priority)}</span></td>
      <td><span class="status status-${escapeHtml(task.status)}">${escapeHtml(task.status.replace('_', ' '))}</span></td>
      <td>${escapeHtml(relativeTime(task.updatedAt))}</td>
    </tr>
  `).join('') : '<tr><td class="empty" colspan="5">No tasks recorded</td></tr>';
}

function filteredEvents() {
  const query = byId('event-search').value.trim().toLowerCase();
  const agent = byId('agent-filter').value;
  const type = byId('type-filter').value;
  return currentData.events.filter((event) => {
    if (agent && event.agentId !== agent) return false;
    if (type && event.type !== type) return false;
    if (!query) return true;
    const searchable = [event.id, event.agentId, event.type, event.taskId, event.sessionId, eventSummary(event)]
      .filter(Boolean).join(' ').toLowerCase();
    return searchable.includes(query);
  });
}

function renderTimeline() {
  const events = filteredEvents();
  byId('event-total').textContent = events.length === currentData.events.length
    ? `${events.length} recent`
    : `${events.length} of ${currentData.events.length}`;
  byId('timeline').innerHTML = events.length ? events.map((event) => `
    <li>
      <button type="button" class="event-button" data-event-id="${escapeHtml(event.id)}">
        <span class="event-meta"><span>${escapeHtml(relativeTime(event.createdAt))}</span><span>${escapeHtml(event.agentId)}</span><span class="event-type">${escapeHtml(event.type)}</span></span>
        <span class="event-text">${escapeHtml(eventSummary(event))}</span>
        <span class="event-links">${event.parents.length} parent${event.parents.length === 1 ? '' : 's'}${event.causationId ? ' / caused' : ''}</span>
      </button>
    </li>
  `).join('') : '<li class="empty">No matching events</li>';
}

function populateFilter(id, values, allLabel) {
  const select = byId(id);
  const selected = select.value;
  select.innerHTML = `<option value="">${allLabel}</option>${values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}`;
  if (values.includes(selected)) select.value = selected;
}

function renderRefs(refs) {
  byId('ref-total').textContent = `${refs.length} heads`;
  byId('refs').innerHTML = refs.length ? refs.map((ref) => `
    <li>${escapeHtml(ref.name)}<span>${escapeHtml(ref.event_id ?? 'empty')}</span></li>
  `).join('') : '<li class="empty">No refs recorded</li>';
}

function renderHealth(health) {
  const status = health?.status ?? 'unknown';
  const statusElement = byId('health-status');
  statusElement.textContent = status;
  statusElement.className = `health-status health-${status}`;
  const alerts = health?.alerts ?? [];
  const band = byId('alert-band');
  band.hidden = alerts.length === 0;
  byId('alerts').innerHTML = alerts.map((alert) => `
    <li><span class="alert-severity alert-${escapeHtml(alert.severity)}">${escapeHtml(alert.severity)}</span>${escapeHtml(alert.message)}</li>
  `).join('');
}

function renderMetrics(metrics) {
  byId('event-rate').textContent = metrics?.events?.perMinute ?? 0;
  byId('delivery-p95').textContent = formatDuration(metrics?.messages?.deliveryLatency?.p95Ms);
  byId('completion-p95').textContent = formatDuration(metrics?.tasks?.completionDuration?.p95Ms);
  byId('storage-size').textContent = formatBytes(metrics?.storage?.totalBytes);
}

function render(data) {
  currentData = data;
  byId('project-path').textContent = data.repo;
  byId('updated-at').textContent = new Date(data.generatedAt).toLocaleTimeString();
  byId('event-count').textContent = data.summary.events;
  byId('agent-count').textContent = data.summary.agents;
  byId('pending-count').textContent = data.summary.deliveries.pending ?? 0;
  byId('active-count').textContent = (data.summary.tasks.open ?? 0) + (data.summary.tasks.assigned ?? 0) + (data.summary.tasks.in_progress ?? 0) + (data.summary.tasks.blocked ?? 0);
  populateFilter('agent-filter', [...new Set(data.events.map((event) => event.agentId))].sort(), 'All agents');
  populateFilter('type-filter', [...new Set(data.events.map((event) => event.type))].sort(), 'All types');
  renderTasks(data.tasks);
  renderTimeline();
  renderRefs(data.refs);
  renderHealth(data.health);
  renderMetrics(data.metrics);
}

function relationshipGroup(label, events) {
  return `
    <div class="relationship-group">
      <h3>${escapeHtml(label)} <span>${events.length}</span></h3>
      ${events.length ? events.map((event) => `
        <button type="button" class="relationship-event" data-related-event="${escapeHtml(event.id)}">
          <strong>${escapeHtml(event.type)}</strong><small>${escapeHtml(event.agentId)} / ${escapeHtml(relativeTime(event.createdAt))}</small>
          <code>${escapeHtml(event.id)}</code>
        </button>
      `).join('') : '<p class="empty compact-empty">None</p>'}
    </div>`;
}

function renderEventContext(context) {
  const event = context.event;
  byId('dialog-title').textContent = event.type;
  byId('event-properties').innerHTML = [
    ['ID', event.id], ['Agent', event.agentId], ['Task', event.taskId ?? '-'],
    ['Session', event.sessionId ?? '-'], ['Created', new Date(event.createdAt).toLocaleString()],
    ['Hash', event.contentHash],
  ].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
  byId('event-relationships').innerHTML = [
    relationshipGroup('Parents', context.parents),
    relationshipGroup('Caused by', context.causation ? [context.causation] : []),
    relationshipGroup('Children', context.children),
    relationshipGroup('Effects', context.effects),
  ].join('');
  byId('event-payload').textContent = JSON.stringify(event.payload, null, 2);
}

async function showEventContext(eventId) {
  const dialog = byId('event-dialog');
  byId('dialog-title').textContent = 'Loading...';
  byId('event-properties').innerHTML = '';
  byId('event-relationships').innerHTML = '';
  byId('event-payload').textContent = '';
  dialog.hidden = false;
  const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/context`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Unable to load event ${eventId}`);
  renderEventContext(await response.json());
}

async function refresh() {
  const response = await fetch('/api/overview', { cache: 'no-store' });
  if (!response.ok) throw new Error('Unable to load AgentGit data');
  render(await response.json());
}

byId('refresh').addEventListener('click', () => refresh().catch((error) => { byId('updated-at').textContent = error.message; }));
byId('event-search').addEventListener('input', renderTimeline);
byId('agent-filter').addEventListener('change', renderTimeline);
byId('type-filter').addEventListener('change', renderTimeline);
byId('timeline').addEventListener('click', (event) => {
  const button = event.target.closest('[data-event-id]');
  if (button) showEventContext(button.dataset.eventId).catch((error) => { byId('dialog-title').textContent = error.message; });
});
byId('event-relationships').addEventListener('click', (event) => {
  const button = event.target.closest('[data-related-event]');
  if (button) showEventContext(button.dataset.relatedEvent).catch((error) => { byId('dialog-title').textContent = error.message; });
});
function closeEventContext() { byId('event-dialog').hidden = true; }

byId('dialog-close').addEventListener('click', closeEventContext);
byId('event-dialog').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) closeEventContext();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeEventContext(); });

refresh().catch((error) => { byId('project-path').textContent = error.message; });
setInterval(() => refresh().catch(() => {}), 3000);
