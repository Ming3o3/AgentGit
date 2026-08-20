const byId = (id) => document.getElementById(id);

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

function renderTimeline(events) {
  byId('event-total').textContent = `${events.length} recent`;
  byId('timeline').innerHTML = events.length ? events.map((event) => `
    <li>
      <div class="event-meta"><span>${escapeHtml(relativeTime(event.createdAt))}</span><span>${escapeHtml(event.agentId)}</span><span class="event-type">${escapeHtml(event.type)}</span></div>
      <div class="event-text">${escapeHtml(eventSummary(event))}</div>
    </li>
  `).join('') : '<li class="empty">No events recorded</li>';
}

function renderRefs(refs) {
  byId('ref-total').textContent = `${refs.length} heads`;
  byId('refs').innerHTML = refs.length ? refs.map((ref) => `
    <li>${escapeHtml(ref.name)}<span>${escapeHtml(ref.event_id ?? 'empty')}</span></li>
  `).join('') : '<li class="empty">No refs recorded</li>';
}

function render(data) {
  byId('project-path').textContent = data.repo;
  byId('updated-at').textContent = new Date(data.generatedAt).toLocaleTimeString();
  byId('event-count').textContent = data.summary.events;
  byId('agent-count').textContent = data.summary.agents;
  byId('pending-count').textContent = data.summary.deliveries.pending ?? 0;
  byId('active-count').textContent = (data.summary.tasks.open ?? 0) + (data.summary.tasks.assigned ?? 0) + (data.summary.tasks.in_progress ?? 0) + (data.summary.tasks.blocked ?? 0);
  renderTasks(data.tasks);
  renderTimeline(data.events);
  renderRefs(data.refs);
}

async function refresh() {
  const response = await fetch('/api/overview', { cache: 'no-store' });
  if (!response.ok) throw new Error('Unable to load AgentGit data');
  render(await response.json());
}

byId('refresh').addEventListener('click', () => refresh().catch((error) => { byId('updated-at').textContent = error.message; }));
refresh().catch((error) => { byId('project-path').textContent = error.message; });
setInterval(() => refresh().catch(() => {}), 3000);
