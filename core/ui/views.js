/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { pluginCard, visiblePluginCards, bindPluginActions } from "./extensions.js";
import {
  api,
  escapeHTML as e,
  typeNames,
  availableModels,
  coreChatModel,
  extensionPlugins,
  sessionName,
} from "./api.js";
import { icon, whale } from "./icons.js";
import { bindManagementIcons } from "./plugin-store.js";
import { renderContextMeter } from "./context.js";
import { hostUpdateContent } from "./host-updates.js";
import { bindPluginUpdateCheck, checkPluginsButton, checkPluginsStatus } from "./plugin-updates.js";

const typeIcon = (type) =>
  type === "embedding" ? "vector" : type === "chat" ? "chat" : "sliders";
const activeChat = (app) => {
  const persona = app.state.config.personas.find(
    (p) => p.id === app.state.status.persona,
  );
  return app.state.config.models.find(
    (m) => m.id === (persona?.model || app.state.config.bindings.chat),
  );
};
export function renderOverview(app) {
  const { status: s, config: c } = app.state;
  const chat = activeChat(app);
  const embed = c.models.find((m) => m.id === c.bindings.embedding);
  const extensions = extensionPlugins(s);
  const active = extensions.filter((p) => p.status === "active").length;
  return `<div class="page-heading"><div><div class="eyebrow">YOUR LOCAL WORKSPACE</div><h1>欢迎回来</h1><p>鲸鲸已就绪。模型、记忆与插件，都在这里。</p></div><div class="heading-actions"><span class="badge green"><i class="status-dot"></i>核心运行中</span></div></div>
 <section class="host-update panel" aria-label="WhaleLife 本体更新" data-host-update>${hostUpdateContent(app)}</section>
 <div class="stats-grid">${[
   [
     "可用模型",
     availableModels(c).length + "",
     "已启用且配置有效的模型",
     "cube",
   ],
   [
     "当前对话",
     chat?.name || "尚未选择",
     chat?.model || "前往使用配置选择模型",
     "chat",
   ],
   [
     "记忆会话",
     s.memory.files + "",
     formatBytes(s.memory.bytes) + " 已保存",
     "database",
   ],
   [
     "运行中的扩展插件",
     active + "",
     extensions.length + " 个扩展插件",
     "puzzle",
     "#market",
   ],
 ]
   .map(
     ([name, value, foot, ico, store]) =>
       `<div class="panel stat-card"><span class="stat-icon">${icon(ico)}</span><small>${name}</small><div class="stat-value ${name === "当前对话" ? "text" : ""}">${e(value)}</div><div class="stat-foot">${e(foot)}${store ? ` · <a class="btn link small" href="${store}">插件商店</a>` : ""}</div></div>`,
   )
   .join("")}</div>
 <div class="overview-grid"><div><section class="panel welcome-panel"><div class="eyebrow">HELLO, WHALELIFE</div><h2>让鲸鲸拥有适合自己的能力</h2><p>接入模型服务，为对话和向量检索分别选择模型，再到聊天页面试一试。</p><div class="row"><a href="#models" class="btn primary">${icon("plus")}管理模型</a><a href="#chat" class="btn">开始聊天 ${icon("arrow")}</a></div><span class="brand-mark">${whale}</span></section><section class="panel" style="margin-top:22px"><div class="panel-header"><h2>模型分工</h2><a class="btn link small" href="#bindings">调整配置 ${icon("arrow")}</a></div><div class="panel-body">${[
   ["chat", "对话模型", chat],
   ["embedding", "向量模型", embed],
 ]
   .map(
     ([type, label, m]) =>
       `<div class="service-line"><span class="square-icon">${icon(typeIcon(type))}</span><div><div class="label">${label}</div><small>${e(m?.name || "尚未配置")}</small></div><span class="badge ${m ? "green" : ""}">${m ? "已选择" : "待选择"}</span></div>`,
   )
   .join("")}</div></section></div>
 <section class="panel"><div class="panel-header"><h2>工作空间状态</h2><span class="badge">本地</span></div><div class="panel-body">${[
   ["grid", "核心服务", "WhaleLife · M0", "运行中"],
   ["database", "记忆存储", s.memory.files + " 个会话已归档", "已连接"],
   ["chat", "当前人格", s.personaName || s.persona, "已启用"],
   ["database", "当前会话", sessionName(app.state) + " · " + (app.state.session || ""), "正在使用"],
   [
     "lock",
     "会话权限",
     { off: "工具已关闭", ask: "安全工具可直接执行", full: "工具可直接执行" }[
       s.permission
     ] || s.permission,
     "已配置",
   ],
 ]
   .map(
     ([ico, title, detail, state]) =>
       `<div class="service-line"><span class="square-icon">${icon(ico)}</span><div><div class="label">${title}</div><small>${e(detail)}</small></div><span class="badge green">${state}</span></div>`,
   )
   .join(
     "",
   )}<div class="hint" style="margin-top:22px">${icon("info")}<span>连接测试结果可在模型服务页面查看。使用配置只会切换之后发起的请求。</span></div></div></section></div>`;
}
function formatBytes(bytes) {
  return bytes < 1024
    ? bytes + " B"
    : bytes < 1048576
      ? (bytes / 1024).toFixed(1) + " KB"
      : (bytes / 1048576).toFixed(1) + " MB";
}

function personaRoutingText(config, personaId) {
  const persona = config.personas.find((p) => p.id === personaId);
  if (!persona) return "先到人格配置页创建人格，再指定给聊天使用。";
  if (persona.model) {
    const model = config.models.find((m) => m.id === persona.model);
    return `「${persona.name}」的专用模型「${model?.name || persona.model}」优先于工作空间的对话模型。更改工作空间模型不会覆盖这项专用设置。`;
  }
  return `「${persona.name}」未设置专用模型，将使用左侧选择的工作空间对话模型。人格专用模型一旦设置，会优先于工作空间选择。`;
}

export function renderBindings(app) {
  const time = app.state.status?.clock;
  const timeSettings = `<div class="binding-field"><div class="binding-label"><h3>时间与日期</h3></div><p class="hint">主干当前时间（读取时）：${time ? e(`${time.local} ${time.weekday}`) : "刷新后查看"}</p></div>`;
  const c = app.state.config;
  const sessions = app.state.sessions?.length ? app.state.sessions : app.state.session ? [{ id: app.state.session, name: sessionName(app.state) }] : [];
  const sessionSettings = `<section class="panel panel-body" style="margin-bottom:22px"><h2>当前会话</h2><p>正在使用：<strong>${e(sessionName(app.state))}</strong> <small>${e(app.state.session)}</small></p><div class="row context-session-select"><label for="active-session">切换到</label><select id="active-session" ${app.state.chatBusy ? "disabled" : ""}>${sessions.map(item => `<option value="${e(item.id)}" ${item.id === app.state.session ? "selected" : ""}>${e(item.name || item.id)}${item.id === app.state.session ? "（正在使用）" : ""}</option>`).join("")}</select><button id="apply-session" class="btn primary small" type="button" disabled>切换会话</button><button id="new-session" class="btn small" type="button" ${app.state.chatBusy ? "disabled" : ""}>${icon("plus")}新建并使用</button></div><p class="hint">选好后点击“切换会话”才生效。网页和跟随当前会话的插件共用此选择，正在处理的请求仍留在原会话。浏览记忆档案不会切换这里。</p><p id="session-switch-error" class="form-error" role="alert"></p></section>`;
  const activePersona = c.activePersona || app.state.status?.persona || "";
  const personaSettings = `<label class="form-field"><span>当前聊天人格</span><select id="active-persona" name="activePersona" required ${app.state.chatBusy || !c.personas.length ? "disabled" : ""}>${!activePersona ? '<option value="">请选择人格</option>' : ""}${c.personas.map((p) => `<option value="${e(p.id)}" ${p.id === activePersona ? "selected" : ""}>${e(p.name)}</option>`).join("")}</select></label><p id="active-persona-routing" class="hint" style="margin-top:16px">${e(personaRoutingText(c, activePersona))}</p><p class="hint" style="margin-top:12px">与模型选择一起保存后生效。切换人格保持当前会话和聊天记录；请等待当前回复结束后切换。</p><a href="#personas" class="btn tonal" style="margin-top:18px">编辑人格 ${icon("arrow")}</a>`;
  const options = (type, selected, inherit = false) =>
    `<option value="">${inherit ? "使用工作空间的对话模型" : "未配置"}</option>` +
    c.models
      .filter(
        (m) =>
          m.type === type &&
          (type !== "chat" || coreChatModel(c, m)) &&
          m.enabled &&
          !m.configuration_error &&
          c.providers.find((p) => p.id === m.provider)?.enabled,
      )
      .map(
        (m) =>
          `<option value="${e(m.id)}" ${m.id === selected ? "selected" : ""}>${e(m.name)} · ${e(c.providers.find((p) => p.id === m.provider)?.name || m.provider)}</option>`,
      )
      .join("");
  const field = (type, description) =>
    `<div class="binding-row"><div class="row">${icon(typeIcon(type))}<h3>${typeNames[type]}模型</h3></div><select name="binding_${type}" aria-label="${typeNames[type]}模型">${options(type, c.bindings[type])}</select><p>${description}</p></div>`;
  return `<div class="page-heading"><div><div class="eyebrow">MODEL ROUTING</div><h1>使用配置</h1><p>明确选择每种能力使用的模型。未配置的用途保持关闭。</p></div><div class="heading-actions"><button type="submit" form="bindings-form" class="btn primary" id="save-bindings">${icon("check")}保存配置</button></div></div><div class="info-banner">${icon("info")}选择已启用的模型，保存后从下一次请求开始生效。</div>${sessionSettings}<form id="bindings-form"><div class="bindings-grid"><section class="panel"><div class="panel-header"><h2>工作空间模型</h2><a href="#models" class="btn small link">管理模型 ${icon("arrow")}</a></div><div class="panel-body">${field("chat", "用于鲸鲸的日常对话和会话摘要。")}${field("embedding", "供插件使用的向量模型。当前支持配置与接口测试；检索由插件实现。")}${field("rerank", "供重排序插件使用的模型选择，可留空。")}<details style="margin-top:20px"><summary class="muted">更多模型用途</summary><div style="margin-top:20px">${field("image", "图像生成服务的模型选择。")}${field("stt", "语音识别服务的模型选择。")}${field("tts", "语音合成服务的模型选择。")}<p class="hint" style="margin-top:16px">这里保存模型选择，图像、语音与重排序的具体调用由对应插件实现。</p></div></details></div></section><section class="panel"><div class="panel-header"><h2>人格配置</h2></div><div class="panel-body">${personaSettings}${timeSettings}</div></section></div><p id="bindings-error" class="form-error" role="alert"></p></form>`;
}
export function bindBindings(app) {
  app.bindingsDirty = false;
  const sessionSelect = document.querySelector("#active-session");
  const applySession = document.querySelector("#apply-session");
  if (sessionSelect && applySession) {
    sessionSelect.onchange = () => {
      app.bindingsDirty = true;
      applySession.disabled = app.state.chatBusy || !sessionSelect.value || sessionSelect.value === app.state.session;
    };
    applySession.onclick = async () => {
      if (applySession.disabled) return;
      const errorBox = document.querySelector("#session-switch-error");
      errorBox.textContent = "";
      applySession.disabled = true;
      try { await app.useSession(sessionSelect.value); app.toast("当前会话已切换"); }
      catch (error) { errorBox.textContent = error.message; sessionSelect.onchange(); }
    };
    document.querySelector("#new-session").onclick = () => app.newSession();
  }
  const form = document.querySelector("#bindings-form");
  form.oninput = () => { app.bindingsDirty = true; };
  const select = form.querySelector("#active-persona");
  select.onchange = () => {
    form.querySelector("#active-persona-routing").textContent =
      personaRoutingText(app.state.config, select.value);
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = document.querySelector("#save-bindings") || form.querySelector("[type=submit]");
    if (button.disabled) return;
    const errorBox = form.querySelector("#bindings-error");
    errorBox.textContent = "";
    const data = new FormData(form);
    const currentPersona =
      app.state.config.activePersona || app.state.status?.persona;
    const selectedPersona = data.get("activePersona") || currentPersona;
    const switching = selectedPersona !== currentPersona;
    if (switching && app.state.chatBusy) {
      errorBox.textContent = "请等待当前回复结束后切换人格。";
      return;
    }
    button.disabled = true;
    const next = app.configDraft();
    if (selectedPersona) next.activePersona = selectedPersona;
    for (const key of ["chat", "embedding", "rerank", "image", "stt", "tts"])
      next.bindings[key] = data.get("binding_" + key) || null;
    try {
      await app.saveConfig(next);
    } catch (error) {
      errorBox.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
}

export function renderPlugins(app) {
  const plugins = extensionPlugins(app.state.status);
  const cards = visiblePluginCards(app.state.status);
  return `<header class="page-heading plugin-hub-heading">
    <div><h1>插件管理</h1><p>${plugins.length} 个扩展插件${cards.length !== plugins.length ? ` · ${cards.length} 个入口` : ""}</p></div>
    <div class="plugin-heading-actions">${checkPluginsButton(app.state)}
      <a class="btn primary store-launch" href="#market" aria-haspopup="dialog" aria-controls="store-drawer">${icon("cube")}插件商店</a></div>
  </header>
  <section id="installed-plugins" aria-label="已安装插件">
    ${checkPluginsStatus(app.state)}
    <div data-official-read-status role="status"></div>
    <div class="plugin-grid">${cards.map(p => pluginCard(app.state.status, p, app.state)).join("")}</div>${plugins.length ? "" : '<div class="panel empty">尚未安装扩展插件</div>'}
  </section>
  <footer class="community-plugin-notice">
    <strong>社区插件免责声明</strong>
    <p>社区插件由第三方作者自由创作并维护。官方插件延续 WhaleLife 主干的设计风格和操作习惯，社区插件的使用体验可能与主干有所不同，请在安装前自行斟酌。</p>
    <p>商店审核仅覆盖所测版本和环境，WhaleLife 不保证社区插件的安全性或稳定性。遇到问题，可在商店的插件详情中点「反馈问题」联系作者。</p>
  </footer>`;
}
export function bindPlugins(app) {
  bindPluginActions(app);
  bindPluginUpdateCheck(app, app.content);
  bindManagementIcons(app);
}

export function renderChat(app) {
  const model = activeChat(app);
  const personaName = app.state.status.personaName || "助手";
  return `<div class="page-heading"><div><div class="eyebrow">PLAYGROUND</div><h1>和${e(personaName)}聊聊</h1><p>测试当前人格的回复，也可以要求记下一条事实。</p></div><div class="heading-actions"><a class="btn" href="#bindings">当前会话：${e(sessionName(app.state))} ${icon("sliders")}</a></div></div><section class="panel chat-panel"><div class="chat-header"><span class="avatar">${e(personaName.slice(0, 1))}</span><div><h3>${e(app.state.status.personaName || "鲸鲸")}</h3><small>${e(model?.name || "请先选择对话模型")} <span>·</span> ${e(app.state.status.persona)}</small></div><div class="spacer"></div><a href="#bindings" class="btn small link">更换模型 ${icon("sliders")}</a></div><div id="chat-context">${renderContextMeter(app.state.sessionContext, true)}</div><div class="chat-body"><div id="chat-rail" class="chat-rail" role="navigation" aria-label="会话导航" hidden></div><div id="messages" class="messages" aria-live="polite"></div></div><div id="nudge-unsent" class="nudge-unsent" hidden></div><form id="chat-form" class="composer"><textarea id="chat-input" aria-label="聊天消息" placeholder="和${e(personaName)}说点什么…" rows="2"></textarea><div class="composer-footer"><small>Enter 发送 · Shift + Enter 换行</small><button id="send" class="btn primary small" type="submit" ${!app.chatConnected || !model ? "disabled" : ""}>${app.state.chatBusy ? "补充" : "发送"} ${icon("send")}</button></div></form></section>`;
}

export function bindChat(app) {
  app.refreshSessionContext();
  app.renderMessages();
  const input = document.querySelector("#chat-input");
  input.value = app.state.chatDraft || "";
  input.oninput = () => (app.state.chatDraft = input.value);
  input.onkeydown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      document.querySelector("#chat-form").requestSubmit();
    }
  };
  document.querySelector("#chat-form").onsubmit = (event) => {
    event.preventDefault();
    app.sendMessage();
  };
}

export function renderLogs(app) {
  return `<div class="page-heading"><div><div class="eyebrow">OBSERVABILITY</div><h1>运行日志</h1><p>与启动窗口同源的实时日志，最近 1000 条。</p></div><div class="heading-actions"><span class="badge ${app.logConnected ? "green" : ""}"><i class="status-dot"></i>${app.logConnected ? "实时连接" : "等待连接"}</span></div></div><section class="panel panel-body"><div class="logs-toolbar"><div class="search-wrap">${icon("search")}<input type="search" id="log-search" aria-label="搜索日志" placeholder="搜索日志内容…" value="${e(app.state.logSearch || "")}"></div><select id="log-level" aria-label="日志级别">${[
    ["all", "所有级别"],
    ["INFO", "INFO"],
    ["WARN", "WARN"],
    ["ERROR", "ERROR"],
    ["DEBUG", "DEBUG"],
  ]
    .map(
      ([value, label]) =>
        `<option value="${value}" ${(app.state.logLevel || "all") === value ? "selected" : ""}>${label}</option>`,
    )
    .join(
      "",
    )}</select><div class="spacer"></div><label class="checkbox-label" style="margin:0"><input type="checkbox" id="log-follow" ${app.state.logFollow ? "checked" : ""}>跟随最新</label><button id="log-export" class="btn small">${icon("download")}导出当前日志</button></div><div id="log-output" class="log-output" role="log" aria-label="实时日志"></div><div id="log-meta" class="log-meta"></div></section>`;
}
export function bindLogs(app) {
  const update = () => {
    app.state.logSearch = document.querySelector("#log-search").value;
    app.state.logLevel = document.querySelector("#log-level").value;
    app.state.logFollow = document.querySelector("#log-follow").checked;
    app.renderLogs();
  };
  document.querySelector("#log-search").oninput = update;
  document.querySelector("#log-level").onchange = update;
  document.querySelector("#log-follow").onchange = update;
  document.querySelector("#log-export").onclick = () => {
    const url = URL.createObjectURL(
      new Blob([app.filteredLogs().join("\n")], {
        type: "text/plain;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "whalelife-logs.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  app.renderLogs();
}
