window.__ModuleLoader__.load({ id: 'dsh-agentgit', factory: (require) => { var module = { exports: {} }; var exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.jsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = __toESM(require("react"), 1);
var PANEL_EVENT = "agentgit:panel";
function setPanelOpen(open) {
  window.dispatchEvent(new CustomEvent(PANEL_EVENT, { detail: Boolean(open) }));
}
function usePanelOpen() {
  const [open, setOpen] = (0, import_react.useState)(false);
  (0, import_react.useEffect)(() => {
    const onPanel = (event) => setOpen(Boolean(event.detail));
    window.addEventListener(PANEL_EVENT, onPanel);
    return () => window.removeEventListener(PANEL_EVENT, onPanel);
  }, []);
  return [open, setPanelOpen];
}
function formatTime(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}
function statusClass(status) {
  return `agentgit-status agentgit-status-${String(status ?? "unknown").replaceAll("_", "-")}`;
}
function Stat({ label, value }) {
  return /* @__PURE__ */ import_react.default.createElement("div", { className: "agentgit-stat" }, /* @__PURE__ */ import_react.default.createElement("span", null, label), /* @__PURE__ */ import_react.default.createElement("strong", null, value ?? 0));
}
function AgentGitButton({ wide }) {
  return /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      type: "button",
      title: "AgentGit \u5386\u53F2",
      "aria-label": "\u6253\u5F00 AgentGit \u5386\u53F2",
      className: `agentgit-button${wide ? " agentgit-button-wide" : ""}`,
      onClick: () => setPanelOpen(true)
    },
    /* @__PURE__ */ import_react.default.createElement("span", { className: "agentgit-button-icon", "aria-hidden": "true" }, "\u21BA"),
    wide && /* @__PURE__ */ import_react.default.createElement("span", { className: "agentgit-button-label" }, "AgentGit")
  );
}
function EventRow({ event, onSelect }) {
  return /* @__PURE__ */ import_react.default.createElement("button", { type: "button", className: "agentgit-event", onClick: () => onSelect(event) }, /* @__PURE__ */ import_react.default.createElement("span", { className: "agentgit-event-type" }, event.type), /* @__PURE__ */ import_react.default.createElement("span", { className: "agentgit-event-meta" }, event.agentId, " \xB7 ", formatTime(event.createdAt)), /* @__PURE__ */ import_react.default.createElement("span", { className: "agentgit-event-id" }, event.id));
}
function Detail({ event, onClose }) {
  if (!event) return null;
  return /* @__PURE__ */ import_react.default.createElement("div", { className: "agentgit-detail-backdrop", onClick: onClose }, /* @__PURE__ */ import_react.default.createElement("section", { className: "agentgit-detail", role: "dialog", "aria-modal": "true", "aria-label": "\u4E8B\u4EF6\u8BE6\u60C5", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ import_react.default.createElement("header", null, /* @__PURE__ */ import_react.default.createElement("h3", null, "\u4E8B\u4EF6\u8BE6\u60C5"), /* @__PURE__ */ import_react.default.createElement("button", { type: "button", onClick: onClose }, "\xD7")), /* @__PURE__ */ import_react.default.createElement("dl", null, /* @__PURE__ */ import_react.default.createElement("dt", null, "ID"), /* @__PURE__ */ import_react.default.createElement("dd", null, event.id), /* @__PURE__ */ import_react.default.createElement("dt", null, "\u7C7B\u578B"), /* @__PURE__ */ import_react.default.createElement("dd", null, event.type), /* @__PURE__ */ import_react.default.createElement("dt", null, "Agent"), /* @__PURE__ */ import_react.default.createElement("dd", null, event.agentId), /* @__PURE__ */ import_react.default.createElement("dt", null, "Session"), /* @__PURE__ */ import_react.default.createElement("dd", null, event.sessionId ?? "-"), /* @__PURE__ */ import_react.default.createElement("dt", null, "\u65F6\u95F4"), /* @__PURE__ */ import_react.default.createElement("dd", null, formatTime(event.createdAt))), /* @__PURE__ */ import_react.default.createElement("pre", null, JSON.stringify(event.payload, null, 2))));
}
function AgentGitPanel() {
  const [open, setOpen] = usePanelOpen();
  const [data, setData] = (0, import_react.useState)(null);
  const [selected, setSelected] = (0, import_react.useState)(null);
  const [error, setError] = (0, import_react.useState)(null);
  const [loading, setLoading] = (0, import_react.useState)(false);
  const [refresh, setRefresh] = (0, import_react.useState)(0);
  (0, import_react.useEffect)(() => {
    if (!open) return void 0;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, setOpen]);
  (0, import_react.useEffect)(() => {
    if (!open) return void 0;
    let stopped = false;
    const load = async () => {
      setLoading(true);
      try {
        const response = await fetch("/agentgit/api?limit=50", { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`AgentGit API ${response.status}`);
        const next = await response.json();
        if (!stopped) {
          setData(next);
          setError(null);
        }
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!stopped) setLoading(false);
      }
    };
    load();
    const timer = window.setInterval(load, 2e3);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [open, refresh]);
  if (!open) return null;
  const summary = data?.summary ?? {};
  const taskCounts = summary.tasks ?? {};
  const deliveryCounts = summary.deliveries ?? {};
  return /* @__PURE__ */ import_react.default.createElement("div", { className: "agentgit-overlay", role: "dialog", "aria-modal": "true", "aria-label": "AgentGit \u5386\u53F2\u9762\u677F", onClick: () => setOpen(false) }, /* @__PURE__ */ import_react.default.createElement("section", { className: "agentgit-panel", onClick: (event) => event.stopPropagation() }, /* @__PURE__ */ import_react.default.createElement("header", { className: "agentgit-panel-header" }, /* @__PURE__ */ import_react.default.createElement("div", null, /* @__PURE__ */ import_react.default.createElement("h2", null, "AgentGit \u5386\u53F2"), /* @__PURE__ */ import_react.default.createElement("p", null, "Agent \u4E4B\u95F4\u7684\u6D88\u606F\u3001\u4EFB\u52A1\u4E0E\u4E0D\u53EF\u53D8\u4E8B\u4EF6\u8BB0\u5F55")), /* @__PURE__ */ import_react.default.createElement("button", { type: "button", className: "agentgit-close", onClick: () => setOpen(false), "aria-label": "\u5173\u95ED" }, "\xD7")), error && /* @__PURE__ */ import_react.default.createElement("div", { className: "agentgit-error" }, "\u65E0\u6CD5\u8BFB\u53D6 AgentGit\uFF1A", error), /* @__PURE__ */ import_react.default.createElement("div", { className: "agentgit-content" }, /* @__PURE__ */ import_react.default.createElement("section", { className: "agentgit-section" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "agentgit-section-title" }, /* @__PURE__ */ import_react.default.createElement("h3", null, "\u6982\u89C8"), /* @__PURE__ */ import_react.default.createElement("button", { type: "button", onClick: () => setRefresh((value) => value + 1), disabled: loading }, loading ? "\u5237\u65B0\u4E2D\u2026" : "\u5237\u65B0")), /* @__PURE__ */ import_react.default.createElement("div", { className: "agentgit-stats" }, /* @__PURE__ */ import_react.default.createElement(Stat, { label: "\u4E8B\u4EF6", value: summary.events }), /* @__PURE__ */ import_react.default.createElement(Stat, { label: "Agent", value: summary.agents }), /* @__PURE__ */ import_react.default.createElement(Stat, { label: "\u4EFB\u52A1", value: Object.values(taskCounts).reduce((sum, count) => sum + count, 0) }), /* @__PURE__ */ import_react.default.createElement(Stat, { label: "\u5F85\u5904\u7406\u6D88\u606F", value: deliveryCounts.pending }))), /* @__PURE__ */ import_react.default.createElement("section", { className: "agentgit-section" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "agentgit-section-title" }, /* @__PURE__ */ import_react.default.createElement("h3", null, "\u4EFB\u52A1")), /* @__PURE__ */ import_react.default.createElement("div", { className: "agentgit-table" }, (data?.tasks ?? []).map((task) => /* @__PURE__ */ import_react.default.createElement("div", { className: "agentgit-task", key: task.id }, /* @__PURE__ */ import_react.default.createElement("div", null, /* @__PURE__ */ import_react.default.createElement("strong", null, task.title), /* @__PURE__ */ import_react.default.createElement("small", null, task.id)), /* @__PURE__ */ import_react.default.createElement("span", { className: statusClass(task.status) }, task.status), /* @__PURE__ */ import_react.default.createElement("small", null, task.assigneeId ?? "\u672A\u5206\u914D", " \xB7 ", formatTime(task.updatedAt)))), !data?.tasks?.length && /* @__PURE__ */ import_react.default.createElement("div", { className: "agentgit-empty" }, "\u6682\u65E0\u4EFB\u52A1"))), /* @__PURE__ */ import_react.default.createElement("section", { className: "agentgit-section" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "agentgit-section-title" }, /* @__PURE__ */ import_react.default.createElement("h3", null, "\u6700\u8FD1\u4E8B\u4EF6"), /* @__PURE__ */ import_react.default.createElement("span", null, data?.events?.length ?? 0, " \u6761")), /* @__PURE__ */ import_react.default.createElement("div", { className: "agentgit-events" }, (data?.events ?? []).map((event) => /* @__PURE__ */ import_react.default.createElement(EventRow, { key: event.id, event, onSelect: setSelected })), !data?.events?.length && /* @__PURE__ */ import_react.default.createElement("div", { className: "agentgit-empty" }, "\u6682\u65E0\u4E8B\u4EF6"))), /* @__PURE__ */ import_react.default.createElement("section", { className: "agentgit-section" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "agentgit-section-title" }, /* @__PURE__ */ import_react.default.createElement("h3", null, "Refs / Checkpoints")), /* @__PURE__ */ import_react.default.createElement("div", { className: "agentgit-table" }, (data?.refs ?? []).map((ref) => /* @__PURE__ */ import_react.default.createElement("div", { className: "agentgit-ref", key: ref.name }, /* @__PURE__ */ import_react.default.createElement("strong", null, ref.name), /* @__PURE__ */ import_react.default.createElement("code", null, ref.event_id ?? "-"), /* @__PURE__ */ import_react.default.createElement("small", null, formatTime(ref.updated_at)))), !data?.refs?.length && /* @__PURE__ */ import_react.default.createElement("div", { className: "agentgit-empty" }, "\u6682\u65E0 ref")))), /* @__PURE__ */ import_react.default.createElement(Detail, { event: selected, onClose: () => setSelected(null) })));
}
var css = `
.agentgit-button{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;border:0;border-radius:8px;background:transparent;color:inherit;padding:8px 10px;cursor:pointer;font:inherit}.agentgit-button-wide{justify-content:flex-start}.agentgit-button:hover{background:color-mix(in srgb,currentColor 10%,transparent)}.agentgit-button-icon{font-size:18px;line-height:20px}.agentgit-button-label{font-size:13px}.agentgit-overlay{position:fixed;inset:0;z-index:1000;display:flex;justify-content:flex-end;background:rgba(0,0,0,.18);pointer-events:auto}.agentgit-panel{width:min(720px,100vw);height:100%;overflow:auto;background:var(--background-primary,#fff);color:var(--text-primary,#1f2937);box-shadow:-8px 0 30px rgba(0,0,0,.18);font:14px system-ui,sans-serif}.agentgit-panel-header{display:flex;justify-content:space-between;gap:16px;padding:24px;border-bottom:1px solid rgba(128,128,128,.22);position:sticky;top:0;background:inherit;z-index:1}.agentgit-panel-header h2,.agentgit-panel-header p{margin:0}.agentgit-panel-header p{margin-top:5px;opacity:.65;font-size:12px}.agentgit-close{border:0;background:transparent;font-size:26px;cursor:pointer;color:inherit}.agentgit-content{padding:16px 24px 40px}.agentgit-section{margin-bottom:24px}.agentgit-section-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.agentgit-section-title h3{margin:0;font-size:14px}.agentgit-section-title button{border:1px solid rgba(128,128,128,.35);border-radius:6px;background:transparent;color:inherit;padding:4px 9px;cursor:pointer}.agentgit-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.agentgit-stat{border:1px solid rgba(128,128,128,.22);border-radius:8px;padding:12px}.agentgit-stat span,.agentgit-stat strong{display:block}.agentgit-stat span{font-size:11px;opacity:.65}.agentgit-stat strong{font-size:22px;margin-top:4px}.agentgit-task,.agentgit-ref{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:12px;align-items:center;border-top:1px solid rgba(128,128,128,.16);padding:10px 0}.agentgit-task strong,.agentgit-task small,.agentgit-ref strong,.agentgit-ref small{display:block;min-width:0;overflow-wrap:anywhere}.agentgit-task small,.agentgit-ref small{font-size:11px;opacity:.62}.agentgit-ref code{overflow:hidden;text-overflow:ellipsis}.agentgit-status{border-radius:999px;padding:3px 8px;background:rgba(128,128,128,.15);font-size:11px;white-space:nowrap}.agentgit-status-completed{background:rgba(34,197,94,.16)}.agentgit-status-blocked{background:rgba(239,68,68,.16)}.agentgit-events{border:1px solid rgba(128,128,128,.22);border-radius:8px;overflow:hidden}.agentgit-event{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 12px;width:100%;border:0;border-top:1px solid rgba(128,128,128,.16);background:transparent;color:inherit;padding:10px 12px;text-align:left;cursor:pointer}.agentgit-event:first-child{border-top:0}.agentgit-event:hover{background:rgba(128,128,128,.08)}.agentgit-event-type{font-weight:600}.agentgit-event-meta{font-size:11px;opacity:.65}.agentgit-event-id{grid-column:1/-1;font:10px ui-monospace,monospace;opacity:.48;overflow:hidden;text-overflow:ellipsis}.agentgit-empty,.agentgit-error{padding:12px;border-radius:8px;background:rgba(128,128,128,.1);opacity:.7}.agentgit-error{margin:16px 24px 0;color:#b91c1c;background:rgba(239,68,68,.1);opacity:1}.agentgit-detail-backdrop{position:fixed;inset:0;z-index:2;background:rgba(0,0,0,.35);display:grid;place-items:center;padding:24px}.agentgit-detail{width:min(640px,100%);max-height:80vh;overflow:auto;border-radius:12px;background:var(--background-primary,#fff);padding:18px;box-shadow:0 12px 40px rgba(0,0,0,.24)}.agentgit-detail header{display:flex;justify-content:space-between}.agentgit-detail header h3{margin:0}.agentgit-detail header button{border:0;background:transparent;font-size:22px;cursor:pointer}.agentgit-detail dl{display:grid;grid-template-columns:90px 1fr;gap:6px 12px;font-size:12px}.agentgit-detail dt{opacity:.6}.agentgit-detail dd{margin:0;word-break:break-all}.agentgit-detail pre{white-space:pre-wrap;word-break:break-word;background:rgba(128,128,128,.1);border-radius:8px;padding:12px;font-size:11px}
@media(max-width:600px){.agentgit-content{padding:12px 16px 32px}.agentgit-panel-header{padding:18px 16px}.agentgit-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.agentgit-task,.agentgit-ref{grid-template-columns:1fr auto}.agentgit-task small:last-child,.agentgit-ref small{grid-column:1/-1}.agentgit-event{grid-template-columns:1fr}.agentgit-event-id{grid-column:1}}
`;
function installStyles() {
  if (document.querySelector("style[data-agentgit-client]")) return;
  const style = document.createElement("style");
  style.dataset.agentgitClient = "true";
  style.dataset.plugin = "dsh-agentgit";
  style.dataset.pluginCss = "dsh-agentgit/client.css";
  style.textContent = css;
  document.head.appendChild(style);
}
installStyles();
var inject = ["slots"];
function apply(ctx) {
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name: "sidebar.footer.action", id: "agentgit-history", order: 100 }, AgentGitButton));
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "agentgit-history-panel", order: 100 }, AgentGitPanel));
}
return module.exports; } });
