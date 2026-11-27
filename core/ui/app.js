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
const pinStorageKey = "whalelife.sidebar.pinnedPlugins";
function readPinnedPlugins() {
  try {
    const value = JSON.parse(localStorage.getItem(pinStorageKey) || "[]");
    return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === "string"))] : [];
  } catch { return []; }
}
const storeRoute = () => /^#market(?:\/([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*))?$/.exec(location.hash);
document
  .querySelectorAll("[data-icon]")
  .forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
document
  .querySelectorAll("[data-whale]")
  .forEach((el) => (el.innerHTML = whale));

/** 压成一行纯文本，摘要卡里用。 */
function plainText(text) {
  return String(text || "")
    .replace(/[#*`>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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
  pinnedPlugins = readPinnedPlugins();
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
    this.bindPinMenu();
    window.addEventListener("storage", event => {
      if (event.key !== null && event.key !== pinStorageKey) return;
      this.closePinMenu();
      this.pinnedPlugins = readPinnedPlugins();
      if (this.authenticated) this.renderNavigation();
    });
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
    // 切回窗口只做静默同步：核对会话、补漏，不重拉会话也不跳位置
    window.addEventListener("focus", () => this.syncView({ quiet: true }));
    // toggle 不冒泡，只能用捕获阶段；用户亲手收起时也要记下来
    document.addEventListener("toggle", (event) => this.rememberDetails(event), true);
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
  bindPinMenu() {
    const nav = $("extension-nav");
    const linkFor = event => event.target.closest("a[data-pin-plugin]");
    let menu, item, trigger, hold, suppressTap;
    const cancelHold = () => {
      if (hold) clearTimeout(hold.timer);
      hold = null;
    };
    const close = () => {
      cancelHold();
      if (trigger) menu.hidePopover();
    };
    const open = (link, x, y, input = "mouse") => {
      if (!menu) {
        menu = document.createElement("div");
        menu.className = "plugin-nav-menu";
        menu.setAttribute("role", "menu");
        menu.innerHTML = `<button type="button" role="menuitem">${icon("pin")}<span></span></button>`;
        item = menu.firstElementChild;
        document.body.append(menu);
        menu.addEventListener("beforetoggle", event => {
          if (event.newState === "closed") {
            trigger?.removeAttribute("aria-expanded");
            trigger = null;
          }
        });
        // Keep pointer interactions in the sidebar from taking focus out of a plugin editor.
        item.addEventListener("mousedown", event => event.preventDefault());
        item.addEventListener("click", () => {
          if (!trigger) return;
          const { page, pinPlugin: id } = trigger.dataset;
          const restoreFocus = document.activeElement === item || document.activeElement === trigger;
          close();
          const pins = this.pinnedPlugins;
          this.pinnedPlugins = pins.includes(id) ? pins.filter(p => p !== id) : [id, ...pins];
          try { localStorage.setItem(pinStorageKey, JSON.stringify(this.pinnedPlugins)); }
          catch { /* Keep the tab preference if browser storage is unavailable. */ }
          this.renderNavigation();
          if (restoreFocus) nav.querySelector(`[data-page="${CSS.escape(page)}"]`)?.focus({ preventScroll: true });
        });
        item.addEventListener("keydown", event => {
          if (event.key !== "Escape" && event.key !== "Tab") return;
          if (event.key === "Escape") event.preventDefault();
          const link = trigger;
          close();
          link?.focus({ preventScroll: true });
        });
      }
      // A long press opens before the initial finger lifts. Native light-dismiss would
      // treat that same release as an outside click, so dismiss touch menus on the next press.
      const mode = input === "touch" ? "manual" : "auto";
      if (menu.popover !== mode) {
        close();
        menu.popover = mode;
      }
      trigger?.removeAttribute("aria-expanded");
      trigger = link;
      trigger.setAttribute("aria-expanded", "true");
      menu.setAttribute("aria-label", link.textContent.trim());
      item.lastElementChild.textContent = this.pinnedPlugins.includes(link.dataset.pinPlugin) ? "取消置顶" : "置顶";
      menu.showPopover();
      const { width, height } = menu.getBoundingClientRect();
      menu.style.left = Math.max(4, Math.min(x, document.documentElement.clientWidth - width - 4)) + "px";
      menu.style.top = Math.max(4, Math.min(y, document.documentElement.clientHeight - height - 4)) + "px";
      if (input === "keyboard") item.focus({ preventScroll: true });
    };
    nav.addEventListener("mousedown", event => {
      if (event.button === 2 && linkFor(event)) event.preventDefault();
    });
    nav.addEventListener("contextmenu", event => {
      const link = linkFor(event);
      if (!link) return;
      event.preventDefault();
      const touch = hold || event.pointerType === "touch" || suppressTap === link;
      if (touch) suppressTap = link;
      cancelHold();
      open(link, event.clientX, event.clientY, touch ? "touch" : "mouse");
    });
    nav.addEventListener("keydown", event => {
      const link = linkFor(event);
      if (!link || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
      event.preventDefault();
      const { left, bottom } = link.getBoundingClientRect();
      open(link, left, bottom, "keyboard");
    });
    nav.addEventListener("pointerdown", event => {
      cancelHold();
      suppressTap = null;
      const link = linkFor(event);
      if (!link || event.pointerType !== "touch" || !event.isPrimary) return;
      const { clientX: x, clientY: y } = event;
      hold = { x, y, timer: setTimeout(() => {
        hold = null;
        suppressTap = link;
        open(link, x, y, "touch");
      }, 550) };
    });
    nav.addEventListener("pointermove", event => {
      if (hold && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 8) cancelHold();
    });
    nav.addEventListener("pointerup", cancelHold);
    nav.addEventListener("pointercancel", cancelHold);
    nav.addEventListener("touchend", event => {
      // A completed long press must not also synthesize a tap on the link or menu.
      if (suppressTap && linkFor(event) === suppressTap) {
        event.preventDefault();
        suppressTap = null;
      }
    }, { passive: false });
    window.addEventListener("pointerdown", event => {
      if (trigger && menu.popover === "manual" && !menu.contains(event.target)) close();
    }, true);
    window.addEventListener("keydown", event => {
      if (trigger && menu.popover === "manual" && event.key === "Escape") close();
    });
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("hashchange", close);
    window.addEventListener("blur", close);
    this.closePinMenu = close;
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
  async syncSession(input, options = {}) {
    if (this.state.chatBusy || (!input && this.sessionChanging)) return;
    const sequence = ++this.sessionSync;
    // adopt：别的窗口已经切了会话，这里只跟着显示，不再回写服务端，
    // 否则两个窗口每次聚焦都把对方拽回来。
    const { id } = options.adopt && input && input.id
      ? { id: input.id }
      : await api("/api/session/current", input ??
      (this.sessionReady ? undefined : { legacyId: localStorage.whaleSession }));
    // 刷新时按上次读到的条数取回同样多，不然只会拿回最后一页、位置全丢
    if (id === this.state.session) this.saveChatView();
    const savedView = this.savedView(id);
    const want = Math.min(
      Math.max(savedView ? Number(savedView.count) || 0 : 0, SESSION_PAGE),
      500,
    );
    const pageUrl = `/api/session?id=${encodeURIComponent(id)}&limit=${want}`;
    const [page, choices] = await Promise.all([
      api(pageUrl),
      api("/api/session/list"),
    ]);
    // Keep the oldest loaded message when a new arrival shifts the latest page.
    while (id === this.state.session && savedView && page.hasMore && page.start > savedView.start) {
      if (sequence !== this.sessionSync || this.state.chatBusy) return;
      const older = await api(pageUrl + "&before=" + page.start);
      if (!older.items.length || older.start >= page.start) break;
      const from = older.positions.findIndex(position => position >= savedView.start);
      if (from < 0) break;
      page.items = older.items.slice(from).concat(page.items);
      page.positions = older.positions.slice(from).concat(page.positions);
      page.start = older.positions[from];
      page.hasMore = from > 0 || older.hasMore;
    }
    if (sequence !== this.sessionSync || this.state.chatBusy) return;
    this.sessionReady = true;
    if (this.state.session !== id) {
      this.state.sessionContext = null;
      // 换个会话，上一份「查看模型原文」的展开状态就不作数了
      this.detailsOpen = new Set();
      // 换会话才回到最新一条；同一会话刷新不动位置。
      this.pendingScrollBottom = true;
      this.chatScrolled = false;
      if (this.viewTimer) clearTimeout(this.viewTimer);
    } else if (savedView?.atBottom) this.pendingScrollBottom = true;
    this.state.session = id;
    this.state.sessions = choices.items;
    this.state.sessionName = choices.items.find(item => item.id === id)?.name || id;
    if (this.state.memorySession && !choices.items.some(item => item.id === this.state.memorySession)) {
      this.state.memorySession = null;
      this.state.memoryContext = null;
      this.state.memoryLoadedTab = null;
    }
    localStorage.whaleSession = id;
    this.state.messages = messageRows(page.items, page.positions);
    // 一次就拉到头（会话不足一页）时前面确实一轮都没有，轮号从 1 起；
    // 还有更早的没拉，就先空着，等往前翻页时再数。（勘 2026-11-26）
    this.railPrefix = page.start === 0 ? 0 : undefined;
    this.state.paging = {
      total: page.total,
      start: page.start,
      end: page.end,
      hasMore: page.hasMore,
    };
    // 同一会话刷新：等这一版画出来再照锚点把位置摆回去
    this.pendingRestore =
      savedView && !this.pendingScrollBottom && savedView.index < this.state.messages.length
        ? savedView
        : null;
  }
  // ---- 阅读位置：刷新后要能回到原处 ----
  chatViewKey(id) {
    return "whalelife.chatView." + (id || "");
  }
  /** 记下屏幕最上面那条消息和它被滚掉了多少。 */
  saveChatView() {
    const box = $("messages");
    const id = this.state.session;
    if (!box || !id || !this.state.messages.length) return;
    if (typeof box.querySelectorAll !== "function") return;
    let index = 0;
    let mid = "";
    let offset = 0;
    const nodes = box.querySelectorAll(".message[data-index]");
    if (!nodes.length) return;
    const viewportTop = box.getBoundingClientRect().top;
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom > viewportTop) {
        index = Number(node.dataset.index) || 0;
        // 序号会漂：末尾新增一条，序号对得上的其实是另一条消息。
        // id 是那条消息自己的，翻页、追加都不会变。
        mid = node.dataset.mid || "";
        offset = viewportTop - rect.top;
        break;
      }
    }
    try {
      localStorage.setItem(
        this.chatViewKey(id),
        JSON.stringify({
          count: this.state.messages.length,
          index,
          mid,
          offset,
          atBottom: box.scrollHeight - box.scrollTop - box.clientHeight < 80,
          start: this.state.paging ? this.state.paging.start : 0,
        }),
      );
    } catch {
      // 存不下就算了，不要因为记住位置这点事打断聊天
    }
  }
  savedView(id) {
    try {
      const raw = JSON.parse(localStorage.getItem(this.chatViewKey(id)) || "null");
      if (!raw || !Number.isFinite(raw.index) || !Number.isFinite(raw.count)) return null;
      return raw;
    } catch {
      return null;
    }
  }
  restoreChatView(box) {
    const saved = this.pendingRestore;
    this.pendingRestore = null;
    if (!saved || !box || typeof box.querySelector !== "function") return;
    // 先按消息 id 找：这才是「当时屏幕最上面那条」，序号只是兜底。
    let node = saved.mid && Array.from(box.querySelectorAll(".message[data-index]"))
      .find(item => item.dataset.mid === saved.mid);
    if (!node) node = box.querySelector(`.message[data-index="${saved.index}"]`);
    if (!node) return;
    const top = node.getBoundingClientRect().top - box.getBoundingClientRect().top;
    this.setScrollTop(box, box.scrollTop + top + (Number(saved.offset) || 0));
    this.syncRail();
  }
/** 左侧段落目录：满 20 条或隔 30 分钟切一段，点一下跳到那段。 */
  /** 左侧导航轨：一条用户请求一节。轨道上只画刻度，摘要放进悬浮卡（勘 2026-11-16）。 */
  /** 一批显示多少格：按轨道高度算，扣掉首尾两个翻页格（勘 2026-11-25）。 */
  railBatchSize() {
    const rail = $("chat-rail");
    const h = rail && rail.clientHeight ? rail.clientHeight : 0;
    if (h < 80) return 48;
    let n = Math.max(8, Math.floor((h - 12) / 16) - 2);
    const shrink = this.railShrink;
    if (shrink && shrink.h === h) n = Math.min(n, shrink.n);
    else if (shrink) this.railShrink = null;
    return n;
  }
  /** 左侧导航轨：一条用户请求一节。轨道上只画刻度，摘要放进悬浮卡（勘 2026-11-16）。
      节数多过一批时，首尾各压成一格翻页入口，中间 n 格是本批；不翻页时末尾停在最新一节（勘 2026-11-25）。 */
  renderOutline() {
    const rail = $("chat-rail");
    if (!rail) return;
    // 轨和消息区必须是两个元素；万一是同一个（DOM 结构变了、id 撞了），
    // 宁可把轨关掉，也不能擦掉正文——下面清 innerHTML 会把整个消息区清空。
    if (rail === $("messages")) {
      rail.hidden = true;
      this.railTurns = [];
      this.railStart = null;
      return;
    }
    this.railTurns = [];
    let turn = null;
    (this.state.messages || []).forEach((m, index) => {
      if (m.role === "user") {
        // 中途补充（nudge）也挂在 user 上，但它是同一轮的补充，不是新的一问。
        // 判据只认两条可靠信号：内存里刚发出去的那条带 nudge 标记；
        // 刷新后从服务端读回来的，用户行上多了 external_message_id，且来自 web 渠道、形状对得上。
        // 旧写法还拿「上一轮还没有回答」来猜，可中断、取消之后用户重新发问也是这个形状，
        // 独立的新问题会被并进上一轮，导航上等于没有入口。（勘 2026-11-26 修）
        const isNudge = !!m.nudge || isNudgeRow(m);
        if (isNudge && turn) {
          if (m.text) turn.nudges.push(plainText(m.text));
          return;
        }
        turn = { from: index, ask: plainText(m.text), answers: [], nudges: [] };
        this.railTurns.push(turn);
        return;
      }
      if (turn && m.text) turn.answers.push(plainText(m.text));
    });
    // 前面还有更早历史时，哪怕这一页一条用户轮次都没有（全是助手主动消息），也不能藏整条轨：
    // 藏了就等于把「载入更早」唯一的入口也藏了（作者在 PR #39 上报，勘 2026-11-26 修）。
    const hasOlder = !!(this.state.paging && this.state.paging.hasMore);
    if (this.railTurns.length < 3 && !hasOlder) {
      rail.hidden = true;
      rail.innerHTML = "";
      this.railStart = null;
      this.railPinned = false;
      this.hideRailCard();
      return;
    }
    rail.hidden = false;
    const total = this.railTurns.length;
    // 这一批前面还有多少轮：prefix 未知（首屏、前面没拉过）时不假装知道全会话轮号。
    const prefix = Number.isFinite(this.railPrefix) ? this.railPrefix : null;
    const size = this.railBatchSize();
    this.railBatch = size;
    // 手动翻过页就用 railStart 定的那一批；只有「跟随最新」时才强制贴在末尾
    // （旧写法只认 pinned，翻页里把 pinned 设成 false 之后，一翻就被弹回末尾——勘 2026-11-25 修）
    let start =
      this.railPinned || !Number.isFinite(this.railStart) ? total - size : Math.round(this.railStart);
    start = Math.max(0, Math.min(start, Math.max(0, total - 1)));
    if (start + size > total) start = Math.max(0, total - size);
    this.railStart = start;
    const end = Math.min(total, start + size);
    let html = "";
    if (start > 0) {
      html +=
        '<button type="button" class="chat-rail-tick chat-rail-page" data-page="prev" aria-label="更早的 ' +
        start + ' 轮"><i></i></button>';
    } else if (this.state.paging && this.state.paging.hasMore) {
      // 已经在最早那一批，但服务端还有更早的历史没拉进来：顶格给一个入口，
      // 以前只能把正文滚到最顶触发，导航轨上够不着（作者在 PR #39 上报的第 4 条，勘 2026-11-26 补）。
      html +=
        '<button type="button" class="chat-rail-tick chat-rail-page chat-rail-older" data-page="older" aria-label="载入更早的历史"><i></i></button>';
    }
    for (let i = start; i < end; i += 1) {
      const t = this.railTurns[i];
      html +=
        '<button type="button" class="chat-rail-tick" data-turn="' + i + '" data-ordinal="' +
        (prefix === null ? "" : prefix + i + 1) +
        '" aria-label="' + e(clip(t.ask, 40)) + '"><i></i></button>';
    }
    if (end < total) {
      html +=
        '<button type="button" class="chat-rail-tick chat-rail-page" data-page="next" aria-label="后面还有 ' +
        (total - end) + ' 轮"><i></i></button>' +
        '<button type="button" class="chat-rail-tick chat-rail-page chat-rail-latest" data-page="latest" aria-label="跳到最新"><i></i></button>';
    }
    rail.innerHTML = html;
    // 新刻度没有过渡起点，直接出现会「啪」一下；先摘类再挂回去，重播一次淡入（勘 2026-11-25）。
    rail.classList.remove("rail-swap");
    void rail.offsetWidth;
    rail.classList.add("rail-swap");
    rail.querySelectorAll("[data-turn],[data-page]").forEach((tick) => {
      tick.onmouseenter = () => this.showRailCard(tick);
      tick.onmouseleave = () => this.hideRailCard();
      tick.onfocus = () => this.showRailCard(tick);
      tick.onblur = () => this.hideRailCard();
      tick.onclick = () => {
        if (tick.dataset.page) this.railPage(tick.dataset.page);
        else this.jumpToTurn(Number(tick.dataset.turn));
      };
    });
    this.railFromRender = true;
    this.watchRail();
    this.railFromRender = false;
  }
  /** 翻页：只换这一批刻度，不动消息区（勘 2026-11-25）。 */
  railPage(dir) {
    // 「载入更早」与这一批有没有轮次无关：整页都是助手主动消息时 railTurns 为空，
    // 下面的早退会把唯一的入口变成死按钮（作者在 PR #39 上报，勘 2026-11-26 修）。
    if (dir === "older") {
      this.railLoadOlder();
      return;
    }
    const total = (this.railTurns || []).length;
    if (!total) return;
    const size = this.railBatch || 48;
    // 翻页按整批走，批次不重叠：格子数和「一批」对得上，提示的区间就是点下去真正到的那一批（勘 2026-11-25）
    const from = Number.isFinite(this.railStart) ? this.railStart : Math.max(0, total - size);
    if (dir === "latest") {
      this.railPinned = true;
      this.railStart = Math.max(0, total - size);
      this.hideRailCard();
      // renderOutline 内部会调一次 syncRail，那时高亮还在末尾：保护要先挂上，否则当场被判成「滚回最新」。
      this.railJump = { from: this.railStart, to: this.railStart + size, until: Date.now() + RAIL_JUMP_MS };
      this.renderOutline();
      this.railJump = { from: this.railStart, to: this.railStart + (this.railBatch || size), until: Date.now() + RAIL_JUMP_MS };
      this.jumpToTurn(total - 1);
      return;
    }
    // 手动翻页就是脱离「跟随最新」。旧写法把 pinned 设成「后面还有没有内容」，
    // 翻到早期批次后 pinned 仍是 true，下一次滚动就把这一批拽回末尾——看着像导航失灵（勘 2026-11-25 修）。
    const start = dir === "prev" ? from - size : from + size;
    this.railPinned = false;
    this.railStart = Math.max(0, Math.min(start, Math.max(0, total - size)));
    this.hideRailCard();
    // renderOutline 内部会调一次 syncRail，那一下高亮还在末尾：保护要先挂上，否则当场被判定成「滚回最新」，
    // 批次一路弹回末尾——点一次「更早」看着没反应（作者在 PR #39 上报的第 2 条，勘 2026-11-26 修）。
    this.railJump = { from: this.railStart, to: this.railStart + size, until: Date.now() + RAIL_JUMP_MS };
    this.renderOutline();
    // 翻完要落到那一批的头一格（往前）或末一格（往后），否则刻度换了、消息停在原处（勘 2026-11-25 修）。
    // 平滑滚动途中高亮仍在批外（甚至还在末尾），这段时间同样不许换批。
    this.railJump = { from: this.railStart, to: this.railStart + (this.railBatch || size), until: Date.now() + RAIL_JUMP_MS };
    this.jumpToTurn(
      dir === "prev" ? this.railStart : Math.min(total - 1, this.railStart + (this.railBatch || 48) - 1),
    );
  }
  /** 轨道顶格「载入更早」：往前拉一页历史，批次停在原处不跳（勘 2026-11-26）。 */
  async railLoadOlder() {
    if (this.loadingOlder) return;
    const session = this.state.session;
    const box = $("messages");
    const before = (this.railTurns || []).length;
    const startBefore = Number.isFinite(this.railStart) ? this.railStart : 0;
    await this.loadOlder();
    if (session !== this.state.session || box !== $("messages")) return;
    const added = (this.railTurns || []).length - before;
    // 没拉到（正在加载、或者已经没有更早的）就别动刻度
    if (added <= 0) return;
    // 新轮全加在前面：原来的第 startBefore 轮现在是 startBefore + added
    this.railPinned = false;
    this.railStart = Math.max(0, Math.min(startBefore + added, (this.railTurns || []).length - 1));
    this.railJump = { from: this.railStart, to: this.railStart + (this.railBatch || 48), until: Date.now() + RAIL_JUMP_MS };
    this.renderOutline();
  }
  railCard() {
    let card = document.getElementById("chat-rail-card");
    if (!card) {
      card = document.createElement("div");
      card.id = "chat-rail-card";
      card.className = "chat-rail-card";
      card.hidden = true;
      document.body.appendChild(card);
    }
    return card;
  }
  /** 悬浮卡贴在刻度右边，纵向不许出窗口。 */
  /** 悬浮卡贴在刻度右边，纵向不许出窗口。翻页格显示的是这一批的轮次区间（勘 2026-11-25）。 */
  showRailCard(tick) {
    const card = this.railCard();
    const total = (this.railTurns || []).length;
    const size = this.railBatch || 48;
    // 这一批前面还有多少轮；未知时不假装是全会话轮号（勘 2026-11-26）
    const prefix = Number.isFinite(this.railPrefix) ? this.railPrefix : null;
    const start = Number.isFinite(this.railStart) ? this.railStart : 0;
    let head = "";
    let body = "";
    let meta = "";
    if (tick.dataset.page === "latest") {
      // 倒数第一格固定是「最新的一轮」，不是「又一批」（勘 2026-11-25 修）
      head = "最新的一轮";
      body = prefix === null ? "已加载第 " + total + " 轮" : "第 " + (prefix + total) + " 轮";
      meta =
        (prefix === null ? "共 " + total + " 轮（已加载）· 前面还有更早的" : "共 " + (prefix + total) + " 轮") +
        " · 点一下跳回最新的对话";
    } else if (tick.dataset.page === "older") {
      head = "载入更早的历史";
      body = "点一下往前拉一页，刻度留在当前这一批";
      meta = (prefix === null ? "共 " + total + " 轮（已加载）" : "共 " + (prefix + total) + " 轮") + " · 前面还有更早的";
    } else if (tick.dataset.page) {
      // 提示的是「点下去会落到哪一批」，和 railPage 的落点一致，不是拍脑袋的区间（勘 2026-11-25）
      const raw = tick.dataset.page === "prev" ? start - size : start + size;
      const lo = Math.max(0, Math.min(raw, Math.max(0, total - size)));
      const hi = Math.min(total, lo + size);
      head = tick.dataset.page === "prev" ? "更早的一批" : "后面的一批";
      body =
        prefix === null
          ? "已加载第 " + (lo + 1) + "–" + hi + " 轮"
          : "第 " + (prefix + lo + 1) + "–" + (prefix + hi) + " 轮";
      meta =
        (prefix === null ? "共 " + total + " 轮（已加载）· 前面还有更早的" : "共 " + (prefix + total) + " 轮") +
        " · 点一下换这一批";
    } else {
      const turn = (this.railTurns || [])[Number(tick.dataset.turn)];
      if (!turn) return;
      head = clip(turn.ask, 120);
      const answer =
        (turn.nudges && turn.nudges.length ? "补充：" + turn.nudges.join(" ") + " " : "") +
        turn.answers.join(" ");
      body = clip(answer || "（这一节没有回答）", 260);
      // 先算条数再拼文案。旧写法第一项在前缀未知时是空串，"" + 1 得到 "1"，
      // 再 + 答案数就拼成 "11 条"——一问一答会显示成 11 条（作者在 PR #39 上报，勘 2026-11-26 修）。
      // 条数按这一轮的消息总数算：提问 1 + 补充 + 回答。
      const count = 1 + (turn.nudges ? turn.nudges.length : 0) + turn.answers.length;
      meta =
        (prefix === null ? "" : prefix + Number(tick.dataset.turn) + 1 + " 轮 · ") + count + " 条";
    }
    card.innerHTML =
      "<b>" + e(head) + "</b>" +
      "<span>" + e(body) + "</span>" +
      '<span class="chat-rail-card-meta">' + e(meta) + "</span>";
    card.hidden = false;
    const rect = tick.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const left = Math.min(rect.right + 12, window.innerWidth - box.width - 12);
    const top = Math.max(12, Math.min(rect.top - 8, window.innerHeight - box.height - 12));
    card.style.left = Math.max(12, left) + "px";
    card.style.top = top + "px";
  }
  hideRailCard() {
    const card = document.getElementById("chat-rail-card");
    if (card) card.hidden = true;
  }
  jumpToTurn(index) {
    const turn = (this.railTurns || [])[index];
    if (!turn) return;
    const target = $("messages")?.querySelector('.message[data-index="' + turn.from + '"]');
    if (!target) {
      // 这一轮的消息还没装进页面（分页只装了最近一段），点了不会有反应（勘 2026-11-25 修）
      if (typeof this.toast === "function")
        this.toast("这一轮还没加载到页面，先点消息区顶部的「加载更早的」", true);
      return;
    }
    target.scrollIntoView({ block: "start", behavior: "smooth" });
    // 用户打断平滑滚动也会触发 scrollend，交给 syncRail 确认高亮是否到达目标批次。
    const box = $("messages");
    const jump = this.railJump;
    if (jump && box && typeof box.addEventListener === "function") {
      const done = () => {
        box.removeEventListener("scrollend", done);
        if (this.railJump === jump && box === $("messages")) this.syncRail();
      };
      box.addEventListener("scrollend", done, { once: true, passive: true });
    }
  }
  /** 滚动或窗口尺寸一变就重排：刻度按消息的真实位置摆，紫色只留一个（勘 2026-11-16）。
      旧版一边画按比例插值的游标、一边画按消息判定的高亮，两者位置不一致，
      看着就是"对不上"；窗口一改尺寸还会同时看到两条紫线。现在只保留刻度本身。 */
  watchRail() {
    const rail = $("chat-rail");
    const box = $("messages");
    if (!rail || !box) return;
    // 每次 render() 都会用整页 markup 重建 #messages，拿到的是新节点；
    // 旧监听还挂在被摘下来的那个节点上，此后滚动手势再也送不到轨道，
    // 高亮就永远停在最后一次算出来的位置（勘 2026-11-16 修）。
    if (this.railBox !== box) {
      if (this.railBox && this.railScrollHandler)
        this.railBox.removeEventListener("scroll", this.railScrollHandler);
      this.railScrollHandler = () => this.syncRail();
      box.addEventListener("scroll", this.railScrollHandler, { passive: true });
      this.railBox = box;
    }
    if (!this.railWatched) {
      this.railWatched = true;
      window.addEventListener("resize", () => this.scheduleRail(), { passive: true });
      // 切窗口回来时，尺寸没变、滚动没变，一个事件都不会来。
      // 上一轮若是趁容器被隐藏时算过一遍，高亮就钉死了，得给个重新对账的机会（勘 2026-11-16 修）。
      window.addEventListener("focus", () => this.syncRail());
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) this.syncRail();
      });
    }
    // ResizeObserver 每次都要盯住"当前的"内容节点。
    // 旧写法只在第一次 observe：一旦 #messages 的内层被整体换掉，
    // 观察者盯的就是已经摘下来的节点，此后永不触发（勘 2026-11-16 修）。
    if (typeof ResizeObserver === "function") {
      const target = box.firstElementChild || box;
      if (this.railObserverTarget !== target) {
        if (!this.railObserver) this.railObserver = new ResizeObserver(() => this.syncRail());
        this.railObserver.disconnect();
        this.railObserver.observe(target);
        this.railObserverTarget = target;
      }
    }
    this.syncRail();
  }
  /** 拖窗口会连着来十几次 resize，每来一次就重画整条轨，看着就是一路闪；攒 120ms 再算（勘 2026-11-25）。 */
  scheduleRail() {
    if (this.railTimer) clearTimeout(this.railTimer);
    this.railTimer = setTimeout(() => {
      this.railTimer = null;
      this.syncRail();
    }, 120);
  }
  syncRail() {
    const rail = $("chat-rail");
    const box = $("messages");
    if (!rail || !box || rail.hidden) return;
    if (document.hidden || box.clientHeight < 1 || rail.clientHeight < 1) return;
    // 输入区变高（贴了图、草稿多行）会把聊天区压矮，可窗口尺寸没变、也没滚动，
    // 上面那些监听一个都不会来；刻度还按旧高度排的 top，就溢出到输入框下面去了（勘 2026-11-25 修）。
    if (this.railHeightEl !== rail) {
      if (this.railHeightObs) this.railHeightObs.disconnect();
      this.railHeightEl = rail;
      this.railHeightH = rail.clientHeight;
      if (typeof ResizeObserver === "function") {
        this.railHeightObs = new ResizeObserver(() => {
          const h = rail.clientHeight;
          if (!h || Math.abs(h - (this.railHeightH || 0)) < 2) return;
          this.railHeightH = h;
          this.scheduleRail();
        });
        this.railHeightObs.observe(rail);
      }
    }
    const turns = this.railTurns || [];
    // 窗口尺寸一变，一批能放几格也跟着变；差到两格以上就按新的一批重画（勘 2026-11-25）。
    if (Math.abs(this.railBatchSize() - (this.railBatch || 0)) >= 2) {
      this.renderOutline();
      return;
    }
    const turnTicks = [...rail.querySelectorAll(".chat-rail-tick[data-turn]")];
    if (!turnTicks.length) return;
    // 翻页格和末端「跳到最新」格没有 top 就会落到静态位置、插到中间去，
    // 所以整个轨道一起均匀铺开：更早的一批在第一格，「后面的一批」在倒数第二格（勘 2026-11-25 修）。
    const ticks = [...rail.querySelectorAll(".chat-rail-tick")];
    const boxRect = box.getBoundingClientRect();
    const pad = 6;
    const usable = Math.max(1, rail.clientHeight - pad * 2);
    const count = ticks.length;
    const stepRaw = count > 1 ? usable / (count - 1) : 0;
    if (stepRaw > 0 && stepRaw < 6) {
      const fit = Math.max(4, Math.floor(usable / 6) - 3);
      const shrink = this.railShrink;
      if (!shrink || shrink.h !== rail.clientHeight || shrink.n > fit) {
        this.railShrink = { h: rail.clientHeight, n: fit };
        this.renderOutline();
      }
      return;
    }
    const step = stepRaw;
    const total = step * Math.max(0, count - 1);
    const start = pad + Math.max(0, (usable - total) / 2);
    ticks.forEach((tick, i) => {
      tick.style.top = Math.round((start + i * step) * 10) / 10 + "px";
    });
    const liveBox = box.getBoundingClientRect();
    const head = liveBox.top + Math.min(120, box.clientHeight * 0.3);
    let active = -1;
    turns.forEach((turn, i) => {
      const node = box.querySelector('.message[data-index="' + turn.from + '"]');
      if (!node || !node.isConnected) return;
      const rect = node.getBoundingClientRect();
      if (!rect.height && !rect.width) return;
      if (rect.top <= head) active = i;
    });
    if (active < 0) return;
    // 主动翻页后的平滑滚动期间，高亮还在批外（甚至还在末尾）：这段时间不许换批，也不许「滚回最新」。
    // 否则点一下「更早」立刻被弹回末尾，看着像导航失灵（勘 2026-11-26 修）。
    const jump = this.railJump;
    if (jump) {
      if (Date.now() > jump.until) this.railJump = null;
      else if (active >= jump.from && active < jump.to) this.railJump = null;
      else {
        turnTicks.forEach((tick) => tick.classList.remove("active"));
        return;
      }
    }
    // 手动翻页后用户又滚回最新那条了：重新跟随最新，新消息进来才知道要往末尾走（勘 2026-11-25 修）
    if (!this.railPinned && active >= turns.length - 1) {
      this.railPinned = true;
      this.railStart = Math.max(0, turns.length - (this.railBatch || 48));
      this.renderOutline();
      return;
    }
    const first = Number(turnTicks[0].dataset.turn);
    const last = Number(turnTicks[turnTicks.length - 1].dataset.turn);
    if (active < first || active > last) {
      // 手动翻到别的批次时，高亮在批外是正常的：别把批次拽回去，
      // 等用户点「更新」那一格，或者自己滚回这一批里（勘 2026-11-25）。
      // 只有真正由滚动引起的越界才把批次拽回来；刚翻完页那一下不算（勘 2026-11-25）。
      if (this.railFromRender) {
        turnTicks.forEach((tick) => tick.classList.remove("active"));
        return;
      }
      // 高亮跑出本批：跟着它换批（用户滚到更早/更晚的地方），但不再无条件拽回末尾。
      // 旧写法一越界就把批次重画到 active 附近，翻页后一滚动就跳走（勘 2026-11-25 修）。
      const size = this.railBatch || 48;
      const lo = Math.max(0, active - 2);
      this.railStart = Math.max(0, Math.min(lo, Math.max(0, turns.length - size)));
      this.railPinned = this.railStart + size >= turns.length;
      this.renderOutline();
      return;
    }
    turnTicks.forEach((tick) => tick.classList.toggle("active", Number(tick.dataset.turn) === active));
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
  async syncView(options) {
    if ($("store-drawer").open) return;
    const page = this.state.page;
    if (options?.quiet === true) {
      // 切回窗口只刷状态与上下文，不重拉会话：重拉会让人正读着的消息被顶掉。
      if (!this.authenticated || this.syncing || this.state.chatBusy) return;
      this.syncing = true;
      try {
        await this.refreshStatus();
        if (page === "chat") {
          await this.refreshSessionContext();
          await this.reconcileSession();
        }
      } catch (error) {
        if (error.status === 401) this.requireLogin();
      } finally {
        this.syncing = false;
      }
      return;
    }
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
  /**
   * 切回窗口时和服务端对一下当前会话：别的窗口换过了就跟着换，
   * 否则这一窗还在往旧会话里发，服务端只会一直拒。
   */
  async reconcileSession() {
    if (!this.state.session || this.state.chatBusy || this.sessionChanging) return;
    let current = null;
    try {
      const value = await api("/api/session/current");
      current = value && value.id;
    } catch {
      return;
    }
    if (!current || current === this.state.session) return;
    await this.syncSession({ id: current }, { adopt: true });
    if (this.state.page === "chat") this.render();
    this.toast("其他窗口已切换会话，这里已跟着换过来");
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
  renderNavigation() {
    const navigation = extensionNavigation(this.state.status, this.pinnedPlugins);
    if (navigation !== this.navigationMarkup) {
      this.closePinMenu();
      $("extension-nav").innerHTML = navigation;
      $("extension-nav-group").hidden = !navigation;
      this.navigationMarkup = navigation;
    }
    const active = extensionActiveKey(this.state.status, this.state.page);
    $("sidebar").querySelectorAll("[data-page]").forEach((a) => {
      a.classList.toggle("active", a.dataset.page === active);
      if (a.dataset.page === active)
        a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }
  render(preserveExtension = false) {
    if ($("store-drawer").open) return;
    if (!this.state.config || !this.state.status) return;
    const page = pages[this.state.page] || extensionPage(this);
    this.renderNavigation();
    $("breadcrumb").textContent = page.name;
    document.title = page.name + " · WhaleLife";
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
      if (data.type === "append") {
        const entered = data.status === "accepted" || data.status === "duplicate";
        if (data.status === "accepted") this.toast("已并入本轮");
        else if (data.status === "duplicate") this.toast("这句已经并进去了");
        else if (data.status === "full") this.toast("本轮补充已满，这句没进去", true);
        else if (data.reason === "queued") this.toast("这一轮还在排队，开始回复后可以再补充", true);
        else if (data.status === "closed") this.toast("本轮未接收这条补充，可以重发", true);
        else this.toast(data.error || "补充没送进去", true);
        // 没进去的补充不能留成一条看着已发出的虚线气泡，原文放回输入框。
        // 按 messageId 找，而不是只看「最后一条待定」——done 可能比这条回执先到。
        const pending =
          this.pendingNudge && (!data.messageId || this.pendingNudge.messageId === data.messageId)
            ? this.pendingNudge
            : null;
        if (pending) this.pendingNudge = null;
        if (!entered) {
          const nudgeId = data.messageId ? "n_" + data.messageId : pending?.nudgeId;
          const bubble = nudgeId && this.state.messages.find(message => message.nudgeId === nudgeId);
          const original = bubble?.text || pending?.text || (typeof data.text === "string" ? data.text : "");
          if (nudgeId) this.state.messages = this.state.messages.filter((m) => m.nudgeId !== nudgeId);
          // 原文不能丢：输入框空着就放回去；已经有草稿就排进「未送达」，让用户决定重发还是丢弃
          if (original) {
            const box = $("chat-input");
            if (box && !(box.value || "").trim()) {
              box.value = original;
              this.state.chatDraft = original;
            } else {
              (this.unsentNudges ||= []).push({ text: original, messageId: data.messageId || "" });
            }
          }
          if (this.state.page === "chat") this.renderMessages();
        }
        return;
      }
      if (data.type === "started") {
        // 记住这一轮的 id：两个窗口跑同一会话时，补充要落到自己那一轮上
        this.turn = typeof data.turn === "string" ? data.turn : null;
        return;
      }
      if (data.type === "reset") {
        // 服务端把这段回复丢掉了（不会进存档），界面上的也得撤，否则刷新前后不一致
        if (this.reply) {
          this.reply.text = "";
          if (this.state.page === "chat") this.renderMessages();
        }
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
        this.turn = null;
        this.pendingNudge = null;
        if (data.type === "done") this.pendingSend = null;
        if (data.type === "error") {
          // 这条没发出去：撤掉乐观上屏的气泡，把原文放回输入框，省得重打一遍
          const pending = this.pendingSend;
          this.pendingSend = null;
          if (pending && this.state.messages[pending.index]?.role === "user")
            this.state.messages.splice(pending.index, 1);
          if (pending && !($("chat-input")?.value || "").trim()) {
            $("chat-input").value = pending.text;
            this.state.chatDraft = pending.text;
          }
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
    this.closePinMenu();
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
      // 本轮还在跑时按钮不禁用，改成「补充」：这句话并进当前回合，不另起一轮。
      button.disabled = this.sessionChanging || !this.state.session || !this.chatConnected || !selected;
      button.innerHTML =
        (this.state.chatBusy ? "补充" : "发送") + " " + icon("send");
    }
    if ($("new-session")) $("new-session").disabled = this.state.chatBusy || this.sessionChanging;
  }
  sendMessage() {
    const text = ($("chat-input")?.value || "").trim();
    if (!text || !this.chatConnected || $("send").disabled) return;
    // 本轮还在跑：不排队、不新起一轮，直接并进当前回合让它中途改方向。
    if (this.state.chatBusy) {
      // 稳定 ID：同一句重送不会写出两条历史，服务端按它去重。
      const messageId = "nudge_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      this.chatWS.send(
        JSON.stringify({ append: true, session: this.state.session, turn: this.turn, text, messageId }),
      );
      const nudgeId = "n_" + messageId;
      this.state.messages.push({ role: "user", text, nudge: true, nudgeId });
      this.pendingNudge = { text, nudgeId, messageId };
      this.state.chatDraft = "";
      $("chat-input").value = "";
      this.renderMessages();
      return;
    }
    this.state.messages.push({ role: "user", text });
    // 记下这一条，服务端没接住时好把原文放回输入框
    this.pendingSend = { text, index: this.state.messages.length - 1 };
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
  /** 「查看模型原文」的展开状态：按「会话:消息身份:第几个 details」记，跨整页重画保留。 */
  rememberDetails(event) {
    const details = event && event.target;
    if (!details || details.tagName !== "DETAILS") return;
    const node = details.closest ? details.closest(".message[data-index]") : null;
    if (!node) return;
    const data = node.dataset || {};
    const identity = data.detailKey !== undefined ? data.detailKey : data.index === undefined ? undefined : "i" + data.index;
    if (identity === undefined) return;
    const list = Array.from(node.querySelectorAll("details"));
    const offset = list.indexOf(details);
    if (offset < 0) return;
    if (!this.detailsOpen) this.detailsOpen = new Set();
    const key = identity + ":" + offset;
    if (details.open) this.detailsOpen.add(key);
    else this.detailsOpen.delete(key);
  }
  /** 回复里已经有可见文字，才让它占一个气泡。 */
  replyVisible() {
    return hasVisibleText(this.reply && this.reply.text);
  }
  renderMessages(options) {
    const opts = options || {};
    const personaName = this.state.status.personaName || "助手";
    const box = $("messages");
    if (!box) return;
    // 重画会整块换掉 innerHTML，滚动位置跟着归零。这里先记住：贴底才跟到底，
    // 否则原地不动——否则定时刷新一次就把正在读的旧消息甩到最新。
    const prevTop = box.scrollTop;
    const prevNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const pinBottom = this.takeScrollPin();
    // 会话前缀进键里：两个会话的第 1 条不会撞同一个键
    const keyOf = (m, index) => (this.state.session || "-") + ":" + (m.id || "i" + index);
    if (!this.state.messages.length) {
      box.innerHTML = `<div class="chat-empty"><span class="brand-mark">${whale}</span><h3>今天想和${e(personaName)}聊点什么？</h3><p>从一句问候开始，或试试「记下这个」。</p></div>`;
      this.ensureChatScroll();
      this.renderOutline();
      return;
    }
    // 整页重画会换掉 #messages，状态必须存在实例上，不能只读当前这个盒子
    if (!this.detailsOpen) this.detailsOpen = detailsState(box);
    const open = this.detailsOpen;
    const parts = [];
    this.state.messages.forEach((m, index) => {
      if (m === this.reply && !this.replyVisible()) return;
      parts.push(
        `<div class="message ${m.role === "user" ? "user" : m.role === "error" ? "error" : ""}${m.nudge ? " nudge" : ""}" data-index="${index}" data-mid="${e(String(m.id || index))}" data-detail-key="${e(keyOf(m, index))}"${m === this.reply ? ' data-streaming="1"' : ""}><span class="mini-avatar" title="${e(m.personaName || "助手")}">${m.role === "user" ? "我" : m.role === "error" ? "!" : e(avatarLabel(m.personaName))}</span><div class="bubble">${renderRich(m.text)}${m.protocolOriginal ? `<details><summary>查看模型原文</summary><div>${e(m.protocolOriginal)}</div></details>` : ""}${m.protocolNote ? '<div class="protocol-note">上面是模型把工具调用写进正文，已替换为说明，没有执行任何工具。</div>' : ""}</div></div>`,
      );
    });
    box.innerHTML = parts.join("");
    applyDetailsState(box, open);
    if (this.state.chatBusy && !this.replyVisible())
      box.insertAdjacentHTML(
        "beforeend",
        `<div class="message" data-thinking="1"><span class="mini-avatar" title="${e(personaName)}">${e(avatarLabel(personaName))}</span><div class="bubble thinking"><i></i><i></i><i></i><span>思考中 <em class="think-face">${pickThinkingFace()}</em></span></div></div>`,
      );
    const stick = opts.anchor === "keep" ? false : pinBottom || prevNearBottom;
    this.setScrollTop(box, stick ? box.scrollHeight : prevTop);
    this.ensureChatScroll();
    this.renderOutline();
    if (this.pendingRestore) this.restoreChatView(box);
    this.renderUnsentNudges();
  }
  takeScrollPin() {
    const pin = this.pendingScrollBottom === true;
    this.pendingScrollBottom = false;
    return pin;
  }
  /** 设定滚动位置；恢复原位置时不播动画。 */
  setScrollTop(box, value, behavior) {
    const max = Math.max(0, (box.scrollHeight || 0) - (box.clientHeight || 0));
    const top = Math.max(0, Math.min(Number(value) || 0, max));
    if (behavior === "smooth" && typeof box.scrollTo === "function") {
      box.scrollTo({ top, behavior: "smooth" });
      return;
    }
    // 恢复原位置时不能带平滑动画，否则会看着它慢慢滑回去。
    const style = box.style;
    const previous = style && style.scrollBehavior;
    if (style) style.scrollBehavior = "auto";
    box.scrollTop = top;
    if (style) style.scrollBehavior = previous;
  }
  /** 消息区的滚动、翻页、位置保存只绑一次。刻度轨由 renderOutline 负责。 */
  ensureChatScroll() {
    const box = $("messages");
    if (!box) return;
    if (box.dataset && box.dataset.scrollBound !== "1") {
      box.dataset.scrollBound = "1";
      // 只有真的动手滚过，才允许触顶自动翻页；否则初次加载就会一直往前翻。
      const wake = () => {
        if (box === $("messages")) this.chatScrolled = true;
      };
      box.addEventListener("wheel", wake, { passive: true });
      box.addEventListener("touchmove", wake, { passive: true });
      box.addEventListener("keydown", wake);
      box.addEventListener(
        "scroll",
        () => {
          if (box !== $("messages")) return;
          this.syncRail();
          // 位置攒一下再写，滚动一次不要连着写几十遍 localStorage
          if (this.viewTimer) clearTimeout(this.viewTimer);
          this.viewTimer = setTimeout(() => this.saveChatView(), 400);
          if (box.scrollTop <= 2 && this.chatScrolled && typeof this.loadOlder === 'function')
            this.loadOlder();
        },
        { passive: true },
      );
    }
    this.syncRail();
  }
  /** 滚到顶部时往前翻一页，翻完把阅读位置原样托住。 */
  async loadOlder() {
    const box = $("messages");
    const paging = this.state.paging;
    if (!box || !paging || !paging.hasMore || this.loadingOlder) return;
    const id = this.state.session;
    this.loadingOlder = true;
    const prevHeight = box.scrollHeight;
    const prevTop = box.scrollTop;
    try {
      const page = await api(
        `/api/session?id=${encodeURIComponent(id)}&before=${paging.start}` +
          `&limit=${SESSION_PAGE}`,
      );
      if (paging !== this.state.paging || box !== $("messages") || id !== this.state.session) return;
      this.state.paging = {
        total: page.total,
        start: page.start,
        end: page.end,
        hasMore: page.hasMore,
      };
      const rows = messageRows(page.items, page.positions);
      // 只有拉到顶（start 0）才敢说「前面没有更早的了」，这时已加载的轮序就是全会话轮序。
      // 中间那几页只攒了个半截数，不能拿去显示成绝对轮号，宁可继续标「已加载」。（勘 2026-11-26 修）
      this.railPrefix = page.start === 0 ? 0 : undefined;
      if (!rows.length) {
        this.renderOutline();
        return;
      }
      this.state.messages = rows.concat(this.state.messages);
      this.renderMessages({ anchor: "keep" });
      this.setScrollTop(box, box.scrollHeight - prevHeight + prevTop);
    } catch (error) {
      if (error.status !== 401) this.toast(error.message, true);
    } finally {
      this.loadingOlder = false;
    }
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
    this.syncRail();
  }
  /** 被拒且没处放的补充排在这里：能重发，也能显式丢掉。不碰输入框里正在写的草稿。 */
  renderUnsentNudges() {
    const bar = $("nudge-unsent");
    // 页面没渲染这一块，或者和消息容器是同一个节点（桩环境里常见），就别碰它，
    // 否则清空自己就等于把正文一起擦了。
    if (!bar || bar === $("messages")) return;
    const list = this.unsentNudges || [];
    if (!list.length) {
      bar.hidden = true;
      bar.innerHTML = "";
      return;
    }
    bar.hidden = false;
    bar.innerHTML =
      `<span class="nudge-unsent-label">没送进去 ${list.length} 条</span>` +
      list
        .map(
          (item, index) =>
            `<span class="nudge-unsent-item" title="${e(item.text)}">${e(item.text.length > 24 ? item.text.slice(0, 24) + "…" : item.text)}` +
            `<button type="button" class="btn small" data-nudge-resend="${index}">重发</button>` +
            `<button type="button" class="btn small" data-nudge-drop="${index}">丢弃</button></span>`,
        )
        .join("");
    if (bar.dataset.bound) return;
    bar.dataset.bound = "1";
    bar.addEventListener("click", (event) => {
      const resend = event.target.closest("[data-nudge-resend]");
      const drop = event.target.closest("[data-nudge-drop]");
      if (!resend && !drop) return;
      const index = Number((resend || drop).dataset[resend ? "nudgeResend" : "nudgeDrop"]);
      const item = (this.unsentNudges || [])[index];
      if (!item) return;
      if (drop) {
        this.unsentNudges.splice(index, 1);
        this.renderUnsentNudges();
        return;
      }
      this.unsentNudges.splice(index, 1);
      const box = $("chat-input");
      if (!box) return;
      box.value = box.value.trim() ? item.text + "\n" + box.value : item.text;
      this.state.chatDraft = box.value;
      this.renderUnsentNudges();
      box.focus();
    });
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

// 程序滚动的保护窗口。到期不等于滚动结束，只为没有 scrollend 的环境兜底（勘 2026-11-26）。
const RAIL_JUMP_MS = 8000;
const SESSION_PAGE = 40;

/** 会话行 → 气泡数组；首屏与续页共用一份映射。 */
/** 截短，超了就加省略号。（勘 2026-11-26 补：这一版漏了这个依赖，作者报 clip is not defined） */
function clip(text, max) {
  const flat = String(text || "").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/** 服务端落库的中途补充行带 external_message_id，值是前端发的 nudge_ 开头的消息 ID。
    刷新后 nudge 标记没了，靠它才认得出来（勘 2026-11-26）。
    两道一起看：渠道必须是 web，形状必须是我们自己生成的那种。
    只按前缀猜会撞车——别的渠道的入站消息 ID 由平台给（QQ 是纯数字号，
    契约也允许 nudge_qq123 这种），撞上就把一条独立的新问并进上一轮了。 */
const NUDGE_ID = /^nudge_[a-z0-9]{12,32}$/;
function isNudgeRow(row) {
  if (row?.originChannel !== "web") return false;
  return typeof row.external_message_id === "string" && NUDGE_ID.test(row.external_message_id);
}
function messageRows(rows, positions) {
  return rows
    .filter((row) => row.type === "message")
    .map((row, index) => {
      const originChannel = row.origin?.channel;
      const channel = row.channel;
      // 渠道记录冲突时保留独立的导航入口，避免把普通消息当作补充。
      const conflictingChannels = originChannel != null && channel != null && originChannel !== channel;
      return {
        id: row.id || (positions ? "historical-line:" + positions[index] : undefined),
        role: row.role,
        text: row.text,
        protocolOriginal: row.tool_protocol_original,
        personaName: row.persona_name,
        originChannel: conflictingChannels ? undefined : originChannel ?? channel,
        ...(typeof row.external_message_id === "string" ? { external_message_id: row.external_message_id } : {}),
      };
    });

}

const app = new ConsoleApp();
app.start();
