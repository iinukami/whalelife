/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { api, escapeHTML as e, availableModels } from "./api.js";
import { icon, whale } from "./icons.js";
import { renderRich, detailsState, applyDetailsState, hasVisibleText, avatarLabel } from "./rich.js";
import { renderModels, bindModels } from "./models.js";
import { renderPersonas, bindPersonas } from "./personas.js";
import { renderMemory, bindMemory, loadMemory } from "./memory.js";
import { renderContextMeter } from "./context.js";
import { renderStore, bindStore } from "./plugin-store.js";
import { bindHostUpdate, resetHostUpdateSession } from "./host-updates.js";
import { extensionPage, extensionNavigation, extensionActiveKey, extensionSignature, updateExtensionContent } from "./extensions.js";
import {
  renderOverview,
  renderBindings,
  bindBindings,
  renderPlugins,
  bindPlugins,
  renderChat,
  bindChat,
  renderLogs,
  bindLogs,
} from "./views.js";

const pages = {
  memory: { name: "记忆管理", render: renderMemory, bind: bindMemory },
  personas: { name: "人格配置", render: renderPersonas, bind: bindPersonas },
  overview: { name: "概览", render: renderOverview, bind: bindHostUpdate },
  models: { name: "模型服务", render: renderModels, bind: bindModels },
  bindings: { name: "使用配置", render: renderBindings, bind: bindBindings },
  chat: { name: "对话", render: renderChat, bind: bindChat },
  plugins: { name: "插件管理", render: renderPlugins, bind: bindPlugins },
  logs: { name: "运行日志", render: renderLogs, bind: bindLogs },
};
const $ = (id) => document.getElementById(id);
const storeRoute = () => /^#market(?:\/([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*))?$/.exec(location.hash);
document
  .querySelectorAll("[data-icon]")
  .forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
document
  .querySelectorAll("[data-whale]")
  .forEach((el) => (el.innerHTML = whale));

class ConsoleApp {
  content = $("content");
  chatWS = null;
  logWS = null;
  reply = null;
  authenticated = false;
  generation = 0;
  toastTimer = null;
  sessionSync = 0;
  sessionReady = false;
  sessionChanging = false;
  state = {
    page: "overview",
    config: null,
    status: null,
    probes: {},
    messages: [],
    logs: [],
    logFollow: true,
    chatBusy: false,
    chatDraft: "",
    session: null,
    sessions: [],
    memorySession: null,
  };
  constructor() {
    this.state.page = this.pageFromHash();
    window.addEventListener("hashchange", () => {
      this.storeNavigating = false;
      const route = storeRoute();
      const page = this.pageFromHash();
      if (route && this.authenticated) {
        if (page !== this.state.page) {
          this.hideStore();
          this.state.page = page;
          this.render();
        }
        this.restoreStoreRoute(route);
        return;
      }
      if ($("store-drawer").open) {
        this.hideStore();
        if (page === this.state.page) return;
      }
      this.state.page = page;
      this.bindingsDirty = false;
      if (this.state.page === "memory") this.state.memoryLoadedTab = null;
      document.body.classList.remove("sidebar-open");
      $("sidebar-scrim").hidden = true;
      if (this.authenticated) {
        this.render();
        this.syncView();
        if (this.state.page === "memory") loadMemory(this);
      }
    });
    this.content.addEventListener("click", event => {
      const link = event.target.closest('a[href="#market"]');
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      this.storeTrigger = link;
      history.pushState({ storeOrigin: this.state.page }, "", "#market");
      this.displayStore(null);
    });
    const drawer = $("store-drawer");
    drawer.addEventListener("cancel", event => {
      event.preventDefault();
      this.leaveStore(false);
    });
    drawer.addEventListener("click", event => {
      if (event.target !== drawer) return;
      const r = drawer.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX >= r.right || event.clientY < r.top || event.clientY >= r.bottom) this.leaveStore(true);
    });
    window.addEventListener("focus", () => this.syncView());
    $("login-form").onsubmit = (event) => {
      event.preventDefault();
      this.login();
    };
    $("refresh").onclick = () => this.reload();
    $("menu-toggle").onclick = () => {
      if (innerWidth <= 760) {
        document.body.classList.toggle("sidebar-open");
        $("sidebar-scrim").hidden =
          !document.body.classList.contains("sidebar-open");
      } else document.body.classList.toggle("collapsed");
    };
    $("sidebar-scrim").onclick = () => {
      document.body.classList.remove("sidebar-open");
      $("sidebar-scrim").hidden = true;
    };
    $("dialog").addEventListener("click", (event) => {
      if (event.target === $("dialog") && !this.dialogBusy) this.closeDialog();
    });
    $("dialog").addEventListener("cancel", (event) => {
      if (this.dialogBusy) event.preventDefault();
    });
  }
  pageFromHash() {
    if (storeRoute()) return history.state?.storeOrigin === "overview" ? "overview" : "plugins";
    const key = location.hash.slice(1);
    return pages[key] || key.startsWith("extension:") || key.startsWith("plugin:") ? key : "overview";
  }
  restoreStoreRoute(route) {
    // Give a bookmarked drawer the same return path as a visit from the console.
    if (!history.state?.storeOrigin) {
      const origin = this.state.page;
      history.replaceState(null, "", "#" + origin);
      history.pushState({ storeOrigin: origin }, "", "#market");
      if (route[1]) history.pushState({ storeOrigin: origin }, "", "#market/" + route[1]);
    }
    this.displayStore(route[1] || null);
  }
  showStoreDetail(id) {
    history.pushState({ storeOrigin: this.state.page }, "", "#market/" + id);
    this.displayStore(id);
  }
  leaveStore(all) {
    if (this.storeNavigating) return;
    this.storeNavigating = true;
    history.go(all && this.state.storeDetail ? -2 : -1);
  }
  displayStore(id) {
    const drawer = $("store-drawer");
    const previous = this.state.storeDetail;
    const opening = !drawer.open;
    if (opening) {
      this.storeScroll = 0;
      this.storeTrigger ??= this.content.querySelector('a[href="#market"]');
      drawer.innerHTML = `<header class="store-drawer-bar">
        <button type="button" data-store-back></button>
        <button type="button" data-store-close>关闭商店 ${icon("close")}</button>
      </header><div class="store-drawer-body"></div>`;
      drawer.querySelector("[data-store-back]").onclick = () => this.leaveStore(false);
      drawer.querySelector("[data-store-close]").onclick = () => this.leaveStore(true);
      drawer.showModal();
    } else if (!previous && id) {
      this.storeScroll = drawer.querySelector("[data-store-scroll]")?.scrollTop || 0;
    }
    this.state.storeDetail = id;
    const backLabel = id ? "插件商店" : pages[this.state.page].name;
    drawer.querySelector("[data-store-back]").innerHTML = icon("back") + "返回" + backLabel;
    const container = drawer.querySelector(".store-drawer-body");
    container.innerHTML = renderStore(this);
    bindStore(this, container, opening);
    const scroll = container.querySelector("[data-store-scroll]");
    if (scroll && !id) scroll.scrollTop = this.storeScroll;
    const card = !id && previous ? container.querySelector(`[data-store-entry="${CSS.escape(previous)}"]`) : null;
    (card || container.querySelector("#store-heading") || drawer.querySelector("[data-store-back]")).focus({ preventScroll: true });
    document.title = "插件商店 · WhaleLife";
  }
  hideStore() {
    const drawer = $("store-drawer");
    if (!drawer.open) return;
    if ($("dialog").open) this.closeDialog();
    drawer.close();
    drawer.replaceChildren();
    this.storeOfficialChange = null;
    this.state.storeDetail = null;
    if (this.storeNeedsRefresh) {
      this.storeNeedsRefresh = false;
      const expanded = new Set([...this.content.querySelectorAll(".plugin-card-children[open]")]
        .map(detail => detail.closest(".plugin-card").querySelector("[data-official-manage-slot]")?.dataset.officialManageSlot));
      const scrollY = window.scrollY;
      this.render();
      for (const detail of this.content.querySelectorAll(".plugin-card-children")) {
        const owner = detail.closest(".plugin-card").querySelector("[data-official-manage-slot]");
        if (owner && expanded.has(owner.dataset.officialManageSlot)) detail.open = true;
      }
      window.scrollTo({ top: scrollY, behavior: "instant" });
    }
    const trigger = this.storeTrigger?.isConnected ? this.storeTrigger : this.content.querySelector('a[href="#market"]');
    trigger?.focus({ preventScroll: true });
    this.storeTrigger = null;
    document.title = pages[this.state.page].name + " · WhaleLife";
  }
  get chatConnected() {
    return this.chatWS?.readyState === WebSocket.OPEN;
  }
  get logConnected() {
    return this.logWS?.readyState === WebSocket.OPEN;
  }
  async start() {
    try {
      await this.load();
      await this.enter();
    } catch (error) {
      if (error.status !== 401)
        $("login-error").textContent = "连接控制台失败：" + error.message;
    }
  }
  async load() {
    const config = await api("/api/model-config");
    const status = await api("/api/status");
    this.state.status = status;
    this.state.config = config;
    await this.syncSession();
  }
  async login() {
    const button = $("login-form").querySelector("button");
    button.disabled = true;
    $("login-error").textContent = "";
    try {
      await api("/api/login", { password: $("password").value });
      $("password").value = "";
      if (this.reloadAfterHostUpdate) {
        // The restarted server can ship different console modules.
        location.reload();
        return;
      }
      await this.load();
      await this.enter();
    } catch (error) {
      $("login-error").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }
  async enter() {
    this.authenticated = true;
    $("login").hidden = true;
    $("shell").hidden = false;
    this.render();
    const route = storeRoute();
    if (route) this.restoreStoreRoute(route);
    this.connect("chat");
    this.connect("logs");
  }
  async refreshStatus() {
    this.state.status = await api("/api/status");
  }
  async useSession(id) {
    if (this.state.chatBusy || this.sessionChanging) throw Error("请等待当前操作结束后切换会话");
    this.sessionChanging = true;
    this.updateChatControls();
    try {
      await this.syncSession({ id });
      this.state.chatDraft = "";
      this.render();
    } finally {
      this.sessionChanging = false;
      this.updateChatControls();
    }
  }
  async syncSession(input) {
    if (this.state.chatBusy || (!input && this.sessionChanging)) return;
    const sequence = ++this.sessionSync;
    const { id } = await api("/api/session/current", input ??
      (this.sessionReady ? undefined : { legacyId: localStorage.whaleSession }));
    const [rows, choices] = await Promise.all([
      api("/api/session?id=" + encodeURIComponent(id)), api("/api/session/list"),
    ]);
    if (sequence !== this.sessionSync || this.state.chatBusy) return;
    this.sessionReady = true;
    if (this.state.session !== id) this.state.sessionContext = null;
    this.state.session = id;
    this.state.sessions = choices.items;
    this.state.sessionName = choices.items.find(item => item.id === id)?.name || id;
    if (this.state.memorySession && !choices.items.some(item => item.id === this.state.memorySession)) {
      this.state.memorySession = null;
      this.state.memoryContext = null;
      this.state.memoryLoadedTab = null;
    }
    localStorage.whaleSession = id;
    this.state.messages = rows
      .filter((r) => r.type === "message")
      .map((r) => ({
        role: r.role,
        text: r.text,
        protocolOriginal: r.tool_protocol_original,
        personaName: r.persona_name,
      }));
  }
  async refreshSessionContext() {
    const id = this.state.session;
    try {
      const value = await api(
        "/api/session/context?id=" + encodeURIComponent(id),
      );
      if (id !== this.state.session) return;
      this.state.sessionContext = value;
      if ($("chat-context"))
        $("chat-context").innerHTML = renderContextMeter(value, true);
    } catch (error) {
      if (id === this.state.session && $("chat-context"))
        $("chat-context").textContent = error.message;
    }
  }
  async syncView() {
    if ($("store-drawer").open) return;
    const page = this.state.page;
    if (this.authenticated && (page.startsWith("extension:") || page.startsWith("plugin:")) && !this.syncing) {
      this.syncing = true;
      try {
        const before = extensionSignature(this.state.status);
        await this.refreshStatus();
        if (this.state.page === page && before !== extensionSignature(this.state.status)) this.render(true);
      } catch (error) { this.toast(error.message, true); }
      finally { this.syncing = false; }
      return;
    }
    if (
      !this.authenticated ||
      this.state.chatBusy ||
      this.syncing ||
      (page === "bindings" && this.bindingsDirty) ||
      !["overview", "plugins", "chat", "memory", "bindings"].includes(page)
    )
      return;
    this.syncing = true;
    try {
      await this.load();
      if (this.state.page === page && !this.state.chatBusy) this.render();
    } catch (error) {
      if (error.status === 401) this.requireLogin();
      else this.toast(error.message, true);
    } finally {
      this.syncing = false;
    }
  }
  async reload() {
    const button = $("refresh");
    button.disabled = true;
    try {
      await this.load();
      if (this.state.page === "memory") await loadMemory(this);
      this.render(extensionActiveKey(this.state.status, this.state.page).startsWith("plugin:"));
      this.toast("状态已刷新");
    } catch (error) {
      this.toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  }
  render(preserveExtension = false) {
    if ($("store-drawer").open) return;
    if (!this.state.config || !this.state.status) return;
    const page = pages[this.state.page] || extensionPage(this);
    const navigation = extensionNavigation(this.state.status);
    $("extension-nav").innerHTML = navigation;
    $("extension-nav-group").hidden = !navigation;
    $("breadcrumb").textContent = page.name;
    document.title = page.name + " · WhaleLife";
    const active = extensionActiveKey(this.state.status, this.state.page);
    document.querySelectorAll("[data-page]").forEach((a) => {
      a.classList.toggle("active", a.dataset.page === active);
      if (a.dataset.page === active)
        a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    const count = availableModels(this.state.config).length;
    $("nav-model-count").textContent = count;
    $("nav-model-count").title = `${count} 个已启用且配置有效的模型`;
    $("nav-model-count").setAttribute("aria-label", `${count} 个可用模型`);
    const markup = page.render(this);
    if (!preserveExtension || !updateExtensionContent(this.content, markup)) this.content.innerHTML = markup;
    page.bind?.(this);
    this.updateConnection();
  }
  configDraft() {
    const c = structuredClone(this.state.config);
    return {
      revision: c.revision,
      timezone: c.timezone,
      providers: c.providers,
      models: c.models,
      bindings: c.bindings,
      personaModels: Object.fromEntries(
        c.personas.map((p) => [p.id, p.model || null]),
      ),
    };
  }
  async saveConfig(next) {
    const result = await api("/api/model-config", next);
    this.state.config = result;
    this.state.probes = {};
    await this.refreshStatus();
    this.render();
    this.toast("配置已保存，将用于下一次请求");
  }
  toast(message, error = false) {
    clearTimeout(this.toastTimer);
    $("toast").textContent = message;
    $("toast").classList.toggle("error", error);
    $("toast").hidden = false;
    this.toastTimer = setTimeout(
      () => ($("toast").hidden = true),
      error ? 9000 : 4000,
    );
  }
  dialog(title, body, submit, label = "保存", danger = false) {
    if ($("dialog").open) this.closeDialog();
    this.dialogBusy = false;
    $("dialog-content").innerHTML =
      `<form id="dialog-form"><div class="dialog-head"><h2 id="dialog-title">${e(title)}</h2><button type="button" class="icon-btn" id="dialog-close" aria-label="关闭对话框">${icon("close")}</button></div><div class="dialog-body">${body}<div id="dialog-error" class="form-error" role="alert"></div></div><div class="dialog-foot"><button type="button" class="btn" id="dialog-cancel">${submit ? "取消" : "关闭"}</button>${submit ? `<button type="submit" class="btn ${danger ? "danger" : "primary"}">${label}</button>` : ""}</div></form>`;
    $("dialog-close").onclick = () => this.closeDialog();
    $("dialog-cancel").onclick = () => this.closeDialog();
    $("dialog-form").onsubmit = async (event) => {
      event.preventDefault();
      if (!submit || this.dialogBusy) return;
      const form = event.currentTarget;
      const button = form.querySelector("[type=submit]");
      const data = new FormData(form);
      this.dialogBusy = true;
      button.disabled = true;
      $("dialog-error").textContent = "";
      try {
        await submit(data);
        this.dialogBusy = false;
        this.closeDialog();
      } catch (error) {
        $("dialog-error").textContent = error.message;
        this.dialogBusy = false;
        button.disabled = false;
      }
    };
    $("dialog").showModal();
  }
  closeDialog() {
    if (this.dialogBusy) return;
    $("dialog").close();
    $("dialog-content").replaceChildren();
  }
  connect(kind, attempt = 0) {
    const generation = this.generation;
    const ws = new WebSocket(
      location.origin.replace(/^http/, "ws") + "/ws/" + kind,
    );
    if (kind === "chat") this.chatWS = ws;
    else this.logWS = ws;
    ws.onopen = () => {
      if (kind === "logs") this.state.logs = [];
      this.updateConnection();
      if (this.state.page === "chat") this.updateChatControls();
      if (this.state.page === "logs") this.render();
    };
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (kind === "logs") {
        this.state.logs.push(data.line);
        if (this.state.logs.length > 1000) this.state.logs.shift();
        if (this.state.page === "logs") this.renderLogs();
        return;
      }
      if (data.type === "context") {
        if (data.queued) {
          this.toast("当前会话正在处理其他请求，已排队等待");
          return;
        }
        this.replyPersonaName = data.personaName;
        this.state.status.persona = data.personaId;
        this.state.status.personaName = data.personaName;
        if (this.state.page === "chat") this.render();
        if (data.contextReset)
          this.toast("人格已更新，本轮使用新的人格上下文；旧记录保留");
        return;
      }
      if (data.type === "chunk") {
        const created = !this.reply;
        if (created) {
          this.reply = {
            role: "assistant",
            text: "",
            personaName: this.replyPersonaName,
          };
          this.state.messages.push(this.reply);
        }
        this.reply.text += data.text;
        if (this.state.page === "chat") {
          if (created) this.renderMessages();
          else this.updateStreamingReply();
        }
        return;
      }
      if (data.type === "done" || data.type === "error") {
        if (data.type === "error") {
          this.state.messages.push({ role: "error", text: data.error });
          this.toast(data.error, true);
        }
        this.state.chatBusy = false;
        this.reply = null;
        this.syncView();
        this.updateChatControls();
      }
      if (this.state.page === "chat") this.renderMessages();
    };
    ws.onclose = () => {
      if (generation !== this.generation) return;
      this.updateConnection();
      if (kind === "chat" && this.state.chatBusy) {
        this.state.messages.push({
          role: "error",
          text: "连接已断开，本次回复可能尚未完成。重新连接后可刷新页面查看保存记录。",
        });
        this.state.chatBusy = false;
        this.reply = null;
        if (this.state.page === "chat") this.renderMessages();
      }
      this.updateChatControls();
      if (this.authenticated)
        setTimeout(
          async () => {
            if (generation !== this.generation) return;
            try {
              await api("/api/status");
              this.connect(kind, Math.min(attempt + 1, 4));
            } catch (error) {
              if (error.status === 401) this.requireLogin();
              else this.connect(kind, Math.min(attempt + 1, 4));
            }
          },
          Math.min(1000 * 2 ** attempt, 10000),
        );
    };
  }
  requireLogin() {
    if (!this.authenticated) return;
    const wasUpdating = resetHostUpdateSession(this);
    this.reloadAfterHostUpdate = wasUpdating;
    this.authenticated = false;
    this.hideStore();
    this.generation++;
    this.chatWS?.close();
    this.logWS?.close();
    $("shell").hidden = true;
    $("login").hidden = false;
    $("login-error").textContent = wasUpdating
      ? "请重新进入控制台，在概览中查看本次更新结果。"
      : "服务已重启或登录已过期，请重新进入。";
  }
  updateConnection() {
    const online = this.chatConnected && this.logConnected;
    $("connection-state").innerHTML =
      `<i class="status-dot" style="${online ? "" : "background:#c5ac72"}"></i> ${online ? "核心已连接" : "正在连接"}`;
  }
  updateChatControls() {
    const activePersona = $("active-persona");
    if (activePersona)
      activePersona.disabled =
        this.state.chatBusy || !this.state.config.personas.length;
    const button = $("send");
    if (button) {
      const persona = this.state.config.personas.find(
        (p) => p.id === this.state.status.persona,
      );
      const selected = this.state.config.models.find(
        (m) =>
          m.id === (persona?.model || this.state.config.bindings.chat) &&
          m.enabled,
      );
      button.disabled = this.state.chatBusy || this.sessionChanging || !this.state.session || !this.chatConnected || !selected;
      button.innerHTML =
        (this.state.chatBusy ? "正在回复…" : "发送") + " " + icon("send");
    }
    if ($("new-session")) $("new-session").disabled = this.state.chatBusy || this.sessionChanging;
  }
  sendMessage() {
    const text = ($("chat-input")?.value || "").trim();
    if (
      !text ||
      !this.chatConnected ||
      this.state.chatBusy ||
      $("send").disabled
    )
      return;
    this.state.messages.push({ role: "user", text });
    this.state.chatBusy = true;
    this.state.chatDraft = "";
    this.reply = null;
    $("chat-input").value = "";
    this.replyPersonaName = this.state.status.personaName;
    this.chatWS.send(
      JSON.stringify({
        session: this.state.session,
        expectedSession: this.state.session,
        text,
        persona: this.state.status.persona,
      }),
    );
    this.updateChatControls();
    this.renderMessages();
  }
  async newSession() {
    if (this.state.chatBusy || this.sessionChanging) return;
    this.sessionChanging = true;
    this.updateChatControls();
    try {
      await this.syncSession({ create: true });
      this.state.chatDraft = "";
      this.render();
    } catch (error) {
      this.toast(error.message, true);
    } finally {
      this.sessionChanging = false;
      this.updateChatControls();
    }
  }
  /** 回复里已经有可见文字，才让它占一个气泡。 */
  replyVisible() {
    return hasVisibleText(this.reply && this.reply.text);
  }
  renderMessages() {
    const personaName = this.state.status.personaName || "助手";
    const box = $("messages");
    if (!box) return;
    if (!this.state.messages.length) {
      box.innerHTML = `<div class="chat-empty"><span class="brand-mark">${whale}</span><h3>今天想和${e(personaName)}聊点什么？</h3><p>从一句问候开始，或试试「记下这个」。</p></div>`;
      return;
    }
    const open = detailsState(box);
    const parts = [];
    this.state.messages.forEach((m, index) => {
      if (m === this.reply && !this.replyVisible()) return;
      parts.push(
        `<div class="message ${m.role === "user" ? "user" : m.role === "error" ? "error" : ""}" data-index="${index}"${m === this.reply ? ' data-streaming="1"' : ""}><span class="mini-avatar" title="${e(m.personaName || "助手")}">${m.role === "user" ? "我" : m.role === "error" ? "!" : e(avatarLabel(m.personaName))}</span><div class="bubble">${renderRich(m.text)}${m.protocolOriginal ? `<details><summary>查看模型原文</summary><div>${e(m.protocolOriginal)}</div></details>` : ""}${m.protocolNote ? '<div class="protocol-note">上面是模型把工具调用写进正文，已替换为说明，没有执行任何工具。</div>' : ""}</div></div>`,
      );
    });
    box.innerHTML = parts.join("");
    applyDetailsState(box, open);
    if (this.state.chatBusy && !this.replyVisible())
      box.insertAdjacentHTML(
        "beforeend",
        `<div class="message" data-thinking="1"><span class="mini-avatar" title="${e(personaName)}">${e(avatarLabel(personaName))}</span><div class="bubble thinking"><i></i><i></i><i></i><span>思考中 <em class="think-face">${pickThinkingFace()}</em></span></div></div>`,
      );
    box.scrollTop = box.scrollHeight;
  }
  /** 流式分片只重画当前那条回复，旧消息和它们的展开状态都不动。 */
  updateStreamingReply() {
    const box = $("messages");
    if (!box || !this.replyVisible()) return;
    const bubble = box.querySelector('.message[data-streaming="1"] .bubble');
    if (!bubble) {
      this.renderMessages();
      return;
    }
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    bubble.innerHTML = renderRich(this.reply.text);
    box.querySelector('.message[data-thinking="1"]')?.remove();
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }
  filteredLogs() {
    return this.state.logs.filter(
      (line) =>
        (!this.state.logLevel ||
          this.state.logLevel === "all" ||
          line.includes("[" + this.state.logLevel + "]")) &&
        line.toLowerCase().includes((this.state.logSearch || "").toLowerCase()),
    );
  }
  renderLogs() {
    const box = $("log-output");
    if (!box) return;
    const lines = this.filteredLogs();
    box.innerHTML = lines
      .map(
        (line) =>
          `<div class="log-line ${line.includes("[ERROR]") ? "error" : line.includes("[WARN]") ? "warn" : "info"}">${e(line)}</div>`,
      )
      .join("");
    if (this.state.logFollow) box.scrollTop = box.scrollHeight;
    $("log-meta").textContent =
      `显示 ${lines.length} / ${this.state.logs.length} 条 · ${this.logConnected ? "实时推送中" : "正在重新连接"}`;
  }
}
const thinkingFaces = ["(｡•ᴗ•｡)","(´｡• ᵕ •｡`)","(๑•̀ㅂ•́)و","(￣▽￣)","(＝ω＝)","(っ˘ω˘ς)","(๑´ω`๑)","(・ω・)","(๑•́ ₃ •̀๑)","( ˘ω˘ )","(´▽`)","(･ω･)ﾉ"];
const pickThinkingFace = () => thinkingFaces[Math.floor(Math.random() * thinkingFaces.length)];

/** 每条回复旁的「念」按钮：交给嘴巴插件合成并播放。 */

const app = new ConsoleApp();
app.start();
