function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    if (typeof item === 'string') return item;
    if (typeof item?.text === 'string') return item.text;
    return '';
  }).filter(Boolean).join('\n');
}

export function normalizeCodexRecord(raw) {
  const outer = raw?.type;
  const payload = raw?.payload ?? {};
  const inner = payload.type;
  if (outer === 'event_msg' && inner === 'user_message' && typeof payload.message === 'string') {
    return { type: 'user.message', payload: { text: payload.message }, adapter: 'codex' };
  }
  if (outer === 'event_msg' && inner === 'agent_message' && typeof payload.message === 'string') {
    return { type: 'agent.message', payload: { text: payload.message }, adapter: 'codex' };
  }
  if (outer === 'response_item' && inner === 'message') {
    const role = payload.role === 'user' ? 'user' : 'agent';
    const text = textFromContent(payload.content);
    if (!text) return null;
    return { type: `${role}.message`, payload: { text, phase: payload.phase ?? null }, adapter: 'codex' };
  }
  if (outer === 'response_item' && inner === 'function_call') {
    return { type: 'tool.called', payload: { name: payload.name ?? null, arguments: payload.arguments ?? null }, adapter: 'codex' };
  }
  if (outer === 'response_item' && inner === 'function_call_output') {
    return { type: 'tool.completed', payload: { output: payload.output ?? payload.result ?? null }, adapter: 'codex' };
  }
  if (outer === 'event_msg' && inner === 'task_started') {
    return { type: 'session.task_started', payload: { raw: payload }, adapter: 'codex' };
  }
  if (outer === 'event_msg' && inner === 'token_count') {
    return { type: 'usage.updated', payload: { raw: payload }, adapter: 'codex' };
  }
  return null;
}
