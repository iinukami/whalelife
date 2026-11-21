import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { runInNewContext } from "node:vm";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { WebSocket } from "ws";
import { boot } from "../core/index.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

async function fixture(t: TestContext) {
  const root = await temporaryDirectory("whale-current-");
  let app: any;
  t.after(async () => { await app?.close(); });
  await mkdir(join(root, "config"));
  await mkdir(join(root, "plugins/current-probe"), { recursive: true });
  await writeFile(join(root, "plugins/current-probe/plugin.yaml"),
    'id: current-probe\nname: Current session probe\nversion: 1.0.0\ndescription: Isolated test\napiVersion: "1"\n');
  await writeFile(join(root, "plugins/current-probe/index.ts"), `export function apply(ctx) {
    ctx.provide('current-probe', {
      current: () => ctx.sessions.current(),
      create: (name) => ctx.sessions.create(name),
      run: (input) => ctx.sessions.run(input),
    });
  }`);
  await writeFile(join(root, "config/config.json"), JSON.stringify({
    log: { level: "error" }, web: { port: 0 },
    providers: [{ id: "test", base_url: "https://unused.invalid/v1", api_key: "synthetic" }],
    models: [{ id: "chat", name: "Test", provider: "test", model: "test", type: "chat", enabled: true, context_window: 32000 }],
    model_bindings: { chat: "chat" },
    personas: { a: { name: "A", file: "a.md", permission: "off" }, b: { name: "B", file: "b.md", permission: "off" } },
    channels: { web: { persona: "a", permission: "off" } }, memory: { root: "memory", budget_tokens: 6000 },
  }));
  app = await boot(root);
  const requests: any[] = [];
  app.llm.chat = async (input: any) => {
    requests.push(input);
    return { text: "模拟回复", toolCalls: [], usage: { prompt_tokens: 20, completion_tokens: 4 } };
  };
  const url = `http://127.0.0.1:${app.web.server.address().port}`;
  const cookie = (await fetch(url + "/api/login", { method: "POST", body: "{}" })).headers.get("set-cookie")!.split(";")[0];
  const request = (path: string, body?: any) => fetch(url + path, {
    method: body === undefined ? "GET" : "POST", headers: { Cookie: cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const api = async (path: string, body?: any) => {
    const response = await request(path, body), value = await response.json();
    if (!response.ok) throw Error(value.error);
    return value;
  };
  const plugin = () => app.runtime.services.get("current-probe").value;
  const browser = async (legacyId?: string, browserApi = api) => {
    const source = (await readFile("core/ui/app.js", "utf8"))
      .replace(/^import[\s\S]*?;\r?\n/gm, "")
      .replace("const app = new ConsoleApp();\napp.start();", "globalThis.consoleApp = new ConsoleApp();")
      .replace("const app = new ConsoleApp();\r\napp.start();", "globalThis.consoleApp = new ConsoleApp();");
    const node = { addEventListener() {}, querySelector: () => ({}) };
    const { escapeHTML } = await import(new URL("../core/ui/api.js", import.meta.url).href);
    const { extensionActiveKey } = await import(new URL("../core/ui/extensions.js", import.meta.url).href);
    const sandbox: any = { api: browserApi, e: escapeHTML, extensionActiveKey,
      localStorage: { whaleSession: legacyId }, location: { hash: "#chat" },
      document: { getElementById: () => node, querySelectorAll: () => [] },
      window: { addEventListener() {} } };
    for (const file of ["views", "memory", "personas", "models", "plugin-store", "host-updates", "rich"])
      Object.assign(sandbox, await import(new URL(`../core/ui/${file}.js`, import.meta.url).href));
    runInNewContext(source, sandbox);
    const ui = sandbox.consoleApp;
    ui.render = ui.updateChatControls = ui.connect = () => {};
    ui.toast = (text: string) => { throw Error(text); };
    await ui.load();
    return ui;
  };
  return { root, app, requests, url, cookie, request, api, plugin, browser };
}

test("chat refresh and reload show escaped protocol source only in a collapsed disclosure", async t => {
  const f = await fixture(t), ui = await f.browser();
  f.app.config.channels.web.permission = "full";
  const lead = "<b>合成正文 & 结果</b>";
  const block = '<｜DSML｜tool_calls><｜DSML｜invoke name="inspect_execution"></｜DSML｜invoke></｜DSML｜tool_calls>';
  const raw = lead + "\n" + block;
  f.app.llm.chat = async (input: any) => {
    input.onChunk?.(raw);
    return { text: raw, toolCalls: [], usage: { prompt_tokens: 20, completion_tokens: 4 } };
  };
  await f.app.channels.web(ui.state.session, "合成任务", () => {});
  ui.authenticated = true;
  ui.render = () => ui.renderMessages();
  ui.toast = (message: string, error: boolean) => { if (error) throw Error(message); };
  for (const refresh of [() => ui.syncView(), () => ui.reload()]) {
    ui.state.messages = [];
    ui.content.innerHTML = "";
    await refresh();
    assert.equal(ui.state.messages.at(-1).protocolOriginal, raw);
    const html = ui.content.innerHTML;
    const [visible, source] = html.split("<details><summary>查看模型原文</summary><div>");
    assert.match(visible, /&lt;b&gt;合成正文 &amp; 结果&lt;\/b&gt;/);
    assert.doesNotMatch(visible, /DSML/);
    assert.match(source, /&lt;｜DSML｜invoke name=&quot;inspect_execution&quot;&gt;/);
    assert.doesNotMatch(html, /<b>|<｜DSML/);
  }
});

test("concurrent current calls create only once; selection survives a host restart", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.app.memory.listSessionMeta(), {}, "loading a plugin does not create a session");
  const ids = await Promise.all(Array.from({ length: 8 }, () => f.plugin().current()));
  assert.equal(new Set(ids).size, 1);
  assert.equal(Object.keys(await f.app.memory.listSessionMeta()).length, 1);
  assert.equal((await f.api("/api/session/current")).id, ids[0]);
  await f.app.close();
  const restarted = await boot(f.root);
  t.after(() => restarted.close());
  assert.equal(await restarted.sessions.current(), ids[0]);
  assert.equal(Object.keys(await restarted.memory.listSessionMeta()).length, 1);
});

test("Web and isolated plugin default calls share history, facts, persona and usage; explicit calls stay independent", async (t) => {
  const f = await fixture(t), ui = await f.browser();
  const id = ui.state.session;
  await f.app.channels.web(id, "网页的上一句", () => {});
  await f.app.memoryEngine.saveLocalFacts(id, "独立事实标记");
  await f.plugin().run({ text: "插件接着聊", origin: { platform: "假平台", action: "收件" } });
  assert.ok(f.requests.at(-1).messages.some((m: any) => m.content.includes("网页的上一句")));
  assert.ok(f.requests.at(-1).messages.some((m: any) => m.content.includes("独立事实标记")));
  f.app.config.channels.web.persona = "b";
  await f.plugin().run({ text: "换人格继续" });
  assert.equal(await f.plugin().current(), id);
  const rows = await f.app.memory.readSession(id);
  assert.equal(rows.filter((r: any) => r.type === "message").length, 6);
  assert.equal(rows.at(-1).persona_id, "b");
  assert.equal(rows.at(-1).origin.plugin, "current-probe");
  assert.equal((await f.app.memoryEngine.state(id)).usage.chat.requests, 3);
  await ui.load();
  assert.ok(ui.state.messages.some((r: any) => r.text === "插件接着聊"));
  const separate = await f.plugin().create("显式独立");
  await f.plugin().run({ sessionId: separate, persona: "a", text: "独立调用" });
  assert.equal(await f.plugin().current(), id);
  assert.ok(!f.requests.at(-1).messages.some((m: any) => m.content.includes("网页的上一句")));
  await assert.rejects(f.plugin().run({ sessionId: "missing", text: "不能复活" }), /创建或选择/);
});

test("legacy browser migration is one-time; new and selected Web sessions are visible to plugins and other tabs", async (t) => {
  const f = await fixture(t);
  await f.app.memory.saveSessionMeta("old_browser", { updatedAt: "2024-01-01" });
  await f.app.memory.saveSessionMeta("recent", { updatedAt: "2025-01-01" });
  const first = await f.browser("old_browser");
  assert.equal(first.state.session, "old_browser");
  const stale = await f.browser("recent");
  assert.equal(stale.state.session, "old_browser");
  await first.newSession();
  const fresh = first.state.session;
  assert.notEqual(fresh, "old_browser");
  assert.equal(await f.plugin().current(), fresh);
  await stale.load();
  assert.equal(stale.state.session, fresh);
  await first.useSession("recent");
  assert.equal(await f.plugin().current(), "recent");
  assert.equal((await f.api("/api/session/current", { legacyId: "old_browser" })).id, "recent");
  assert.equal(Object.keys(await f.app.memory.listSessionMeta()).length, 3);
});

test("default migration reuses the latest existing session; deletion falls back without resurrecting history", async (t) => {
  const f = await fixture(t);
  await f.app.memory.saveSessionMeta("older", { updatedAt: "2024-01-01" });
  await f.app.memory.saveSessionMeta("newer", { updatedAt: "2025-01-01" });
  assert.equal((await f.api("/api/session/current", { legacyId: "unknown" })).id, "newer");
  await f.app.memoryAdmin.deleteSession({ id: "newer" });
  assert.equal(await f.plugin().current(), "older");
  await assert.rejects(f.api("/api/session/current", { id: "newer" }), /未删除/);
  await f.app.memoryAdmin.deleteSession({ id: "older" });
  const ids = await Promise.all([f.plugin().current(), f.api("/api/session/current").then(r => r.id)]);
  assert.equal(ids[0], ids[1]);
  const entries: any = await f.app.memory.listSessionMeta();
  assert.equal(Object.values<any>(entries).filter(s => !s.deleted).length, 1);
  assert.ok(entries.older.deleted && entries.newer.deleted);
});

test("default requests snapshot current selection; switching during a reply does not move its records", async (t) => {
  const f = await fixture(t), id = await f.plugin().current();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(r => entered = r), blocked = new Promise<void>(r => release = r);
  f.app.llm.chat = async () => { entered(); await blocked; return { text: "原会话答复", toolCalls: [] }; };
  const pending = f.plugin().run({ text: "原会话提问" });
  await started;
  let other: string;
  try {
    other = (await f.api("/api/session/current", { create: true })).id;
    assert.notEqual(other, id);
    await assert.rejects(f.app.memoryAdmin.deleteSession({ id }), /回复/);
  } finally { release(); }
  assert.equal(await pending, "原会话答复");
  assert.equal((await f.app.memory.readSession(id)).at(-1).text, "原会话答复");
  assert.deepEqual(await f.app.memory.readSession(other!), []);
  assert.equal(await f.plugin().current(), other!);
});

test("current selection is guarded during maintenance and plugin cancellation, including queued writes", async (t) => {
  const f = await fixture(t), id = await f.plugin().current();
  f.app.sessions.memoryMaintenance = true;
  await assert.rejects(f.plugin().current(), /维护/);
  await assert.rejects(f.api("/api/session/current", { create: true }), /维护/);
  f.app.sessions.memoryMaintenance = false;
  f.app.sessions.blockedSessions.add(id);
  await assert.rejects(f.plugin().current(), /维护/);
  f.app.sessions.blockedSessions.delete(id);
  let release!: () => void;
  const gate = new Promise<void>(r => release = r);
  const queue = f.app.memory.serial(() => gate);
  const abort = new AbortController();
  const selection = assert.rejects(f.app.sessions.current({ create: true }, abort.signal), /cancel-test/);
  await new Promise<void>(r => setImmediate(r));
  abort.abort(Error("cancel-test")); release();
  await Promise.all([queue, selection]);
  assert.equal(Object.keys(await f.app.memory.listSessionMeta()).length, 1);
  const old = f.plugin();
  await f.app.runtime.action("current-probe", "stop");
  await assert.rejects(async () => old.current(), /停用|停止|关闭|失效/);
  assert.equal(await f.app.sessions.current(), id);
});

test("HTTP authentication and stale Web tabs cannot change the selected session by sending a message", async (t) => {
  const f = await fixture(t), id = await f.plugin().current();
  assert.equal((await fetch(f.url + "/api/session/current")).status, 401);
  assert.equal((await fetch(f.url + "/api/session/current", {
    method: "POST", headers: { Cookie: f.cookie, Origin: "http://untrusted.invalid" }, body: '{"create":true}',
  })).status, 403);
  for (const input of [{ id: "../bad" }, { id: "missing" }, { create: "true" }, { id, create: true }])
    assert.equal((await f.request("/api/session/current", input)).status, 400);
  const current = (await f.api("/api/session/current", { create: true })).id;
  const ws = new WebSocket(f.url.replace("http", "ws") + "/ws/chat", { headers: { Cookie: f.cookie } });
  t.after(() => ws.terminate());
  await once(ws, "open");
  const reply = once(ws, "message");
  ws.send(JSON.stringify({ session: id, expectedSession: id, text: "不应发送" }));
  assert.match(JSON.parse(String((await reply)[0])).error, /其他窗口切换/);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await f.app.memory.readSession(id), []);
  assert.equal(await f.plugin().current(), current);
});

test("restoring a backup restores its selection and leaves sessions intact", async (t) => {
  const f = await fixture(t), id = await f.plugin().current();
  const backup = await f.app.memoryAdmin.backup();
  const newer = (await f.api("/api/session/current", { create: true })).id;
  assert.notEqual(newer, id);
  await f.app.memoryAdmin.restore({ id: backup.id });
  assert.equal(await f.plugin().current(), id);
});

test("a failed selection commit leaves the previous durable selection intact", async (t) => {
  const f = await fixture(t), id = await f.plugin().current(), other = await f.plugin().create("Other");
  const fs = createRequire(import.meta.url)("node:fs/promises"), rename = fs.rename;
  fs.rename = async (from: string, to: string) => {
    if (to === join(f.root, "memory/index.json")) throw Object.assign(Error("test-commit-failure"), { code: "EIO" });
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(f.app.sessions.current({ id: other }), /test-commit-failure/); }
  finally { fs.rename = rename; syncBuiltinESMExports(); }
  assert.equal(await f.plugin().current(), id);
  assert.ok(await f.app.memory.sessionMeta(other));
});

test("an earlier browser refresh cannot overwrite a newly selected session", async (t) => {
  const f = await fixture(t);
  let hold = false, entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
  const ui = await f.browser(undefined, async (path, body) => {
    const result = await f.api(path, body);
    if (hold && path.startsWith("/api/session?")) { hold = false; entered(); await gate; }
    return result;
  });
  const other = await f.plugin().create("Other");
  hold = true;
  const refresh = ui.load();
  await started;
  try { await ui.useSession(other); } finally { release(); }
  await refresh;
  assert.equal(ui.state.session, other);
  assert.equal(await f.plugin().current(), other);
});

test("the session picker lists all live archives without selecting or creating a session", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.url + "/api/session/list")).status, 401);
  assert.deepEqual(await f.api("/api/session/list"), { items: [] });
  assert.deepEqual(await f.app.memory.listSessionMeta(), {});
  for (let i = 0; i < 28; i++)
    await f.app.memory.saveSessionMeta(`archive_${i}`, { name: `档案 ${i}`, updatedAt: "2026-01-01" });
  await f.app.memory.saveSessionMeta("deleted", { name: "已删除", deleted: true });
  const entries = (await f.api("/api/session/list")).items;
  assert.equal(entries.length, 28, "picker is not limited to the memory table's first 25 rows");
  assert.ok(entries.some((s: any) => s.id === "archive_27" && s.name === "档案 27"));
  assert.ok(!entries.some((s: any) => s.id === "deleted"));
  assert.equal(JSON.parse(await readFile(join(f.root, "memory/index.json"), "utf8")).current_session, undefined);
});

test("browsing and editing another archive leaves Web and plugin current session, history and chat meter intact", async (t) => {
  const f = await fixture(t), ui = await f.browser();
  const { loadMemory, bindMemory, renderMemory } = await import(new URL("../core/ui/memory.js", import.meta.url).href);
  const { renderOverview, renderBindings } = await import(new URL("../core/ui/views.js", import.meta.url).href);
  const current = ui.state.session;
  await f.app.memory.saveSessionMeta(current, { name: "当前 <会话>" });
  await f.app.channels.web(current, "当前会话的历史", () => {});
  await f.app.memoryEngine.saveLocalFacts(current, "当前的事实");
  const other = await f.plugin().create("待查档案");
  await f.app.memoryEngine.saveLocalFacts(other, "档案的事实");
  await ui.load();
  ui.state.sessionContext = await f.api("/api/session/context?id=" + current);
  const chatMeter = ui.state.sessionContext, messages = ui.state.messages;
  ui.state.page = "memory";
  ui.state.memoryTab = "local-facts";
  const nodes: any = {
    "#context-session": { value: other },
    "#memory-local-facts": { value: "档案的事实" },
    "#local-facts-count": {},
    "[data-local-facts-save]": {},
    "[data-local-facts-reload]": {},
    "[data-memory-refresh]": {},
    "[data-memory-backup]": {},
  };
  ui.content = { querySelector: (selector: string) => nodes[selector] || null, querySelectorAll: () => [] };
  const errors: string[] = [];
  ui.toast = (message: string, error: boolean) => { if (error) errors.push(message); };
  const originalFetch = globalThis.fetch;
  const mutations: string[] = [];
  t.mock.method(globalThis, "fetch", (path: any, init: any) => {
    if (!String(path).startsWith("/")) return originalFetch(path, init);
    if (init?.method === "POST") mutations.push(path);
    return originalFetch(f.url + path, { ...init, headers: { ...init?.headers, Cookie: f.cookie } });
  });
  await loadMemory(ui);
  bindMemory(ui);
  await nodes["#context-session"].onchange();
  assert.deepEqual(mutations, [], "browsing cannot write the global current selection");
  assert.equal(ui.state.session, current);
  assert.equal(await f.plugin().current(), current);
  assert.equal(ui.state.memoryLoadedSession, other);
  assert.equal(ui.state.memoryDetails.text, "档案的事实");
  assert.strictEqual(ui.state.messages, messages);
  assert.strictEqual(ui.state.sessionContext, chatMeter);
  const html = renderMemory(ui);
  assert.ok(html.includes('当前正在使用：<strong>当前 &lt;会话&gt;</strong>'));
  assert.ok(html.includes('当前 &lt;会话&gt;（正在使用）'));
  assert.match(html, /仅切换查看的档案/);
  assert.doesNotMatch(html, /设为当前会话/);
  assert.match(renderOverview(ui), /当前 &lt;会话&gt;/);
  assert.match(renderBindings(ui), /当前 &lt;会话&gt;/);
  bindMemory(ui);
  nodes["#memory-local-facts"].value = "只修改档案的事实";
  await nodes["[data-local-facts-save]"].onclick();
  assert.deepEqual(errors, []);
  assert.deepEqual(mutations, ["/api/memory/local-facts"]);
  assert.equal((await f.api("/api/memory/local-facts?id=" + current)).text, "当前的事实");
  assert.equal((await f.api("/api/memory/local-facts?id=" + other)).text, "只修改档案的事实");
  assert.equal(await f.plugin().current(), current);
  assert.strictEqual(ui.state.sessionContext, chatMeter);
});
