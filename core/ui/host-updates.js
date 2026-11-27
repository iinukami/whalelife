/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { api, escapeHTML as e } from "./api.js";
import { icon, whale } from "./icons.js";

const endpoint = "/api/host-update";
const versionLabel = value => /^\d/.test(value) ? "v" + value : value;
const active = data => data?.phase === "preparing" || data?.phase === "restarting";
const attemptKey = "whalelife.hostUpdateAttempt";
const waitLimit = 180_000;
const outcomes = { updated: "success", "rolled-back": "restored", failed: "failed" };
const pending = ui => Boolean(ui?.attempt && !ui.result && ui.phase !== "unknown");
const notes = {
  submitting: "已从控制台提交更新请求。",
  prepare: "服务已接受请求，正在准备更新。",
  restart: "安装包已就绪，服务已进入重启阶段。",
  reconnect: "控制台暂时与服务断开，正在等待更新结果。",
  resuming: "已重新进入控制台，正在读取本次更新状态。",
  unconfirmed: "已连接服务，正在等待本次更新回执。",
  timeout: "已等待 3 分钟，尚未收到本次更新结果。",
  retrying: "已手动重新连接，正在查询本次结果。"
};

function storeAttempt(ui) {
  try {
    if (pending(ui)) window.sessionStorage.setItem(attemptKey, JSON.stringify(ui.attempt));
    else window.sessionStorage.removeItem(attemptKey);
  } catch {} // Storage can be unavailable in a restricted browser.
}

function restoreAttempt() {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(attemptKey));
    if (typeof saved?.from === "string" && typeof saved.to === "string" &&
        Array.isArray(saved.seen) && saved.seen.every(key => Object.hasOwn(notes, key))) return saved;
  } catch {}
}

function begin(ui, data) {
  ui.result = undefined;
  ui.attempt = { from: data.current, to: data.latest?.version ?? "", baseline: data.lastResult ?? null, seen: [], waitingSince: null };
}

function stage(ui, phase) {
  ui.phase = phase;
  if (!ui.attempt.seen.includes(phase)) {
    ui.attempt.seen.push(phase);
    storeAttempt(ui);
  }
}

function matches(attempt, data) {
  const result = data.lastResult, before = attempt.baseline;
  if (!Object.hasOwn(outcomes, result?.status) || (attempt.to && result.version !== attempt.to)) return false;
  if (result.status === "updated" && data.current !== result.version) return false;
  if (result.status === "rolled-back" && data.current !== attempt.from) return false;
  if (!before) return true;
  if (before.at && result.at) return result.at > before.at;
  return result.status !== before.status || result.version !== before.version || result.message !== before.message;
}

function releaseLink(address) {
  try {
    const url = new URL(address);
    if (url.origin === "https://github.com" && !url.username && !url.password &&
        /^\/iinukami\/whalelife\/(?:releases(?:\/|$)|commit\/)/i.test(url.pathname))
      return `<a class="host-release-link" href="${e(url.href)}" target="_blank" rel="noopener noreferrer">发行说明</a>`;
  } catch {}
  return "";
}

function actions(ui) {
  const data = ui.data;
  const latest = data?.latest;
  const error = ui.error || data?.error;
  const available = Boolean(latest?.version && data?.supported && !error);
  const release = latest && !error ? releaseLink(latest.url) : "";
  const open = available
    ? `<button type="button" class="btn small primary" data-host-action="open"${ui.reading ? " disabled" : ""}>查看更新</button>` : "";
  return release + open + `<button type="button" class="btn small" data-host-action="check"${ui.reading ? " disabled" : ""}>${ui.checking ? "检查中…" : "检查更新"}</button>`;
}

function updateCard(ui, phase, result) {
  const data = ui.data, attempt = ui.attempt;
  const seen = attempt?.seen ?? [];
  const lastStep = seen.includes("restart") ? 1 : seen.includes("prepare") ? 0 : -1;
  const current = versionLabel(data?.current || attempt?.from);
  const headings = {
    submitting: "正在提交更新请求", prepare: "正在准备更新", restart: "正在重启 WhaleLife",
    reconnect: "正在等待服务重新连接", resuming: "正在读取更新状态", unconfirmed: "正在确认更新结果", timeout: "暂未收到更新结果",
    retrying: "正在重新连接", success: "已更新到 " + versionLabel(result?.version),
    restored: attempt ? "已恢复到 " + current : "上次更新已回滚", failed: "更新失败", unknown: "服务已连接"
  };
  const descriptions = {
    submitting: "正在等待服务接受本次请求。", prepare: "正在准备并校验安装包。此时仍可使用当前版本。",
    restart: "安装包已就绪。服务重启时，控制台会短暂断开。",
    reconnect: lastStep < 0 ? "控制台会自动重连，查询本次更新的状态。" :
      "最后确认的步骤是" + ["准备更新","重启服务"][lastStep] + "。控制台会自动重连。",
    resuming: "正在向服务查询本次更新的状态。", unconfirmed: "已连上服务，正在等待这次更新的回执。",
    timeout: "已等待 3 分钟。可重新连接，查询这次更新的结果。",
    retrying: "正在查询刚才那次更新的结果。",
    success: "当前运行 " + current + "。", restored: "当前运行 " + current + "。回滚原因见更新记录。",
    failed: result?.message || "服务报告本次更新失败。", unknown: "当前运行 " + current + "，未找到本次更新记录。"
  };
  const done = phase === "success" || phase === "restored";
  const tone = phase === "success" ? "good" : phase === "failed" ? "error" : ["restored","timeout","unknown"].includes(phase) ? "wait" : "active";
  const steps = ["准备更新", "重启服务", "确认版本"].map((label, i) => {
    let mark = "";
    if (done) mark = phase === "restored" && i === 2 ? "outcome" : "done";
    else if (i < lastStep) mark = "done";
    else if (i === lastStep) mark = ["timeout","failed","unknown"].includes(phase) ? "held" : "current";
    const state = {done:"已完成", current:"进行中", held:"最后确认的阶段", outcome:"已确认回滚", "":"待确认"}[mark];
    return `<li data-mark="${mark}" aria-label="${label}，${state}"${mark === "current" ? ' aria-current="step"' : ""}><span class="wl-band" aria-hidden="true"></span><span class="wl-step"><span class="wl-marker" aria-hidden="true"></span>${label}</span></li>`;
  }).join("");
  const versions = attempt?.from && attempt.to
    ? `<span>${e(versionLabel(attempt.from))}</span><span aria-label="更新到">→</span><b>${e(versionLabel(attempt.to))}</b>`
    : `<span>当前 ${e(current)}</span>`;
  const records = seen.map(key => notes[key]);
  if (result) {
    const label = { updated:"更新成功", "rolled-back":"更新失败，已回滚", failed:"更新失败" }[result.status];
    records.push(`${label}（目标 ${versionLabel(result.version)}）。${result.message || ""}`);
  }
  if (phase === "unknown") records.push(descriptions.unknown);
  let controls = result ? actions(ui) : "";
  if (phase === "timeout") controls = `<button type="button" class="btn small" data-host-action="reconnect"${ui.reading ? " disabled" : ""}>重新连接</button>`;
  if (phase === "unknown") controls = '<button type="button" class="btn small" data-host-action="check">检查更新</button>';
  return `<div class="wl-card" data-phase="${phase}" data-tone="${tone}">
    <div class="wl-head"><div class="wl-brand"><span class="wl-emblem">${whale}</span><b>WhaleLife</b><span class="wl-slash" aria-hidden="true">/</span><span>${attempt ? "本体更新" : "上次更新"}</span></div><div class="wl-version">${versions}</div></div>
    <div class="wl-hero"><div class="wl-copy" role="status" aria-atomic="true"><h2>${e(headings[phase])}</h2><p>${e(descriptions[phase])}</p></div>
    <div class="wl-signal" aria-hidden="true"><span class="wl-node wl-console">${icon("terminal")}</span><span class="wl-wire"><span class="wl-packet"></span></span><span class="wl-node wl-host">${icon("database")}</span></div></div>
    <ol class="wl-track" aria-label="本次更新的阶段">${steps}</ol>
    <div class="wl-foot"><details><summary><span class="wl-caret" aria-hidden="true">›</span>更新记录</summary><ol class="wl-log">${records.map(line => "<li>" + e(line) + "</li>").join("")}</ol></details><div class="host-update-actions">${controls}</div></div></div>`;
}

export function hostUpdateContent(app) {
  const ui = app.hostUpdate ?? {};
  const data = ui.data;
  const latest = data?.latest;
  const current = data?.current ? "当前版本 " + versionLabel(data.current) : "";
  const error = ui.error || data?.error;
  const available = Boolean(latest?.version && data?.supported && !error);
  if (ui.attempt) return updateCard(ui, ui.phase, ui.result);
  const last = data?.lastResult;
  if (!data?.checked && !latest && !error && Object.hasOwn(outcomes, last?.status) &&
      (last.status !== "updated" || last.version === data.current))
    return updateCard(ui, outcomes[last.status], last);
  let title = "WhaleLife 本体", status = "";
  if (latest?.version && !error) {
    title = "WhaleLife " + versionLabel(latest.version) + " 可更新";
  } else if (data?.supported && !error && data.phase === "idle") {
    status = data.checked ? "暂无更高的正式版本" : "尚未检查更新";
  }
  if (data?.supported === false && !error) {
    status = "当前安装方式不支持一键更新";
  }
  if (error && data?.lastCheckedAt && (ui.error || !data.checked)) {
    status = "上次成功检查 " + new Date(data.lastCheckedAt).toLocaleString("zh-CN", { hour12: false });
  }
  const info = [current, status].filter(Boolean).join(" · ");
  const resultLabel = { updated: "更新成功", "rolled-back": "更新失败，已回滚", failed: "更新失败" }[last?.status];
  const result = resultLabel
    ? `<p class="host-update-result ${last.status === "updated" ? "ok" : "warning"}">上次更新 · ${e(resultLabel)}${last.version ? "（目标 " + e(versionLabel(last.version)) + "）" : ""}${last.message ? "。" + e(last.message) : ""}</p>` : "";
  return `<div class="host-update-line"><span class="host-update-icon${available ? " available" : ""}">${icon("download")}</span>
    <div class="host-update-copy" role="status"><strong>${e(title)}</strong><small>${info ? e(info) + " · " : ""}<a class="host-release-link" href="https://github.com/iinukami/whalelife/releases" target="_blank" rel="noopener noreferrer">GitHub 正式发行版</a></small>${result}
    ${error ? `<p class="host-update-result warning">${e(error)}</p>` : ""}</div>
    <div class="host-update-actions">${actions(ui)}</div></div>`;
}

function paint(app) {
  const ui = app.hostUpdate;
  const slot = app.content.querySelector("[data-host-update]");
  if (!slot) return;
  const html = hostUpdateContent(app);
  if (ui.slot === slot && ui.html === html) return;
  const focus = slot.ownerDocument.activeElement;
  const action = slot.contains(focus) ? focus.dataset?.hostAction || focus.tagName?.toLowerCase() : "";
  const expanded = slot.querySelector?.("details")?.open;
  slot.innerHTML = html;
  ui.html = html;
  ui.slot = slot;
  const details = slot.querySelector?.("details");
  if (details && expanded) details.open = true;
  if (action === "summary") details?.querySelector("summary").focus({ preventScroll: true });
  else if (action) (slot.querySelector(`[data-host-action="${action}"]:enabled`) ?? details?.querySelector("summary"))?.focus({ preventScroll: true });
}

function schedule(app) {
  const ui = app.hostUpdate;
  clearTimeout(ui.timer);
  if (app.authenticated && pending(ui) && ui.phase !== "timeout")
    ui.timer = setTimeout(() => void read(app), 2000);
}

function waitForResult(app, phase) {
  const ui = app.hostUpdate, attempt = ui.attempt;
  if (attempt.waitingSince == null) {
    attempt.waitingSince = Date.now();
    storeAttempt(ui);
  }
  clearTimeout(ui.deadline);
  const left = waitLimit - (Date.now() - attempt.waitingSince);
  if (left <= 0) {
    stage(ui, "timeout");
    clearTimeout(ui.timer);
  } else {
    stage(ui, phase);
    ui.deadline = setTimeout(() => {
      if (app.hostUpdate !== ui || !pending(ui)) return;
      stage(ui, "timeout");
      clearTimeout(ui.timer);
      paint(app);
    }, left);
  }
}

function acceptStatus(app, data) {
  const ui = app.hostUpdate;
  ui.data = data;
  ui.error = "";
  clearTimeout(ui.deadline);
  if (active(data)) {
    if (!pending(ui) || (data.latest?.version && data.latest.version !== ui.attempt.to)) begin(ui, data);
    ui.attempt.waitingSince = null;
    stage(ui, data.phase === "preparing" ? "prepare" : "restart");
    storeAttempt(ui);
  } else if (pending(ui)) {
    if (matches(ui.attempt, data)) {
      ui.result = data.lastResult;
      ui.phase = outcomes[ui.result.status];
      storeAttempt(ui);
    } else if (ui.phase === "retrying" && data.phase === "idle") {
      // An apply request can be lost before reaching the server. End the wait
      // only after a manual reconnect confirms that the service is idle.
      ui.phase = "unknown";
      storeAttempt(ui);
    } else waitForResult(app, "unconfirmed");
  }
}

async function read(app, checkRelease = false) {
  const ui = app.hostUpdate;
  if (ui.reading || ui.submitting || !app.authenticated) return;
  if (checkRelease && pending(ui)) return;
  if (checkRelease) {
    ui.attempt = undefined;
    ui.result = undefined;
  }
  ui.reading = true;
  ui.checking = checkRelease;
  paint(app);
  try {
    const data = await api(checkRelease ? endpoint + "/check" : endpoint, checkRelease ? {} : undefined, AbortSignal.timeout(20_000));
    if (ui !== app.hostUpdate) return;
    acceptStatus(app, data);
  } catch (error) {
    if (ui !== app.hostUpdate) return;
    if (error.status === 401) return app.requireLogin();
    if (pending(ui)) waitForResult(app, "reconnect");
    else ui.error = error.message || "暂时无法读取更新状态。";
  } finally {
    if (ui === app.hostUpdate) {
      ui.reading = false;
      ui.checking = false;
      paint(app);
      schedule(app);
    }
  }
}

function confirmUpdate(app) {
  const ui = app.hostUpdate;
  const version = ui.data?.latest?.version;
  if (!version || !ui.data.supported || pending(ui) || ui.submitting) return;
  app.dialog("更新 WhaleLife 并重启？",
    `<p class="official-dialog-text">将从 ${e(versionLabel(ui.data.current))} 更新到 <strong>${e(versionLabel(version))}</strong>。重启期间控制台会短暂断开，重新进入后可查看结果。</p>
    <p class="host-confirm-note">预检失败会恢复旧版。新版正式接管后，插件和会话产生的新数据会保留。</p>`,
    async () => {
      if (ui !== app.hostUpdate || ui.reading || ui.submitting || pending(ui) || ui.data?.latest?.version !== version)
        throw Error("更新状态已变化，请关闭并重新查看。");
      clearTimeout(ui.timer);
      ui.submitting = true;
      begin(ui, ui.data);
      stage(ui, "submitting");
      ui.error = "";
      paint(app);
      try {
        const data = await api(endpoint + "/apply", { version, confirmed: true }, AbortSignal.timeout(30_000));
        if (ui !== app.hostUpdate) return;
        acceptStatus(app, data);
      } catch (error) {
        if (ui !== app.hostUpdate) return;
        if (error.status) {
          ui.attempt = undefined;
          ui.error = error.message;
          storeAttempt(ui);
          if (error.status === 401) return app.requireLogin();
        } else {
          // A lost response can follow an accepted update. Only poll; never resubmit it.
          waitForResult(app, "reconnect");
        }
      } finally {
        if (ui === app.hostUpdate) {
          ui.submitting = false;
          paint(app);
          schedule(app);
        }
      }
    }, "更新并重启");
}

export function bindHostUpdate(app) {
  const firstRead = !app.hostUpdate;
  const ui = app.hostUpdate ??= {};
  const slot = app.content.querySelector("[data-host-update]");
  slot.onclick = event => {
    const button = event.target.closest("[data-host-action]");
    if (!button || button.disabled || ui.reading || ui.submitting) return;
    if (pending(ui)) {
      if (ui.phase === "timeout" && button.dataset.hostAction === "reconnect") {
        stage(ui, "retrying");
        void read(app);
      }
      return;
    }
    if (button.dataset.hostAction === "open") confirmUpdate(app);
    if (button.dataset.hostAction === "check") void read(app, true);
  };
  if (firstRead) {
    ui.attempt = restoreAttempt();
    if (ui.attempt) waitForResult(app, "resuming");
    void read(app);
  }
}

export function resetHostUpdateSession(app) {
  const ui = app.hostUpdate;
  clearTimeout(ui?.timer);
  clearTimeout(ui?.deadline);
  app.hostUpdate = undefined;
  return pending(ui);
}
