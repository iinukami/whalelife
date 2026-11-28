import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";

const { bindHostUpdate, hostUpdateContent, resetHostUpdateSession } =
  await import(new URL("../core/ui/host-updates.js", import.meta.url).href);
const ready = {
  current: "0.1.0", phase: "idle", supported: true, checked: true,
  latest: { version: "0.1.1", url: "https://github.com/iinukami/whalelife/releases/tag/v0.1.1" },
};

function overview() {
  const slot = {
    innerHTML: "", ownerDocument: { activeElement: null }, contains: () => false,
    querySelector: () => null,
    onclick: (_event: unknown) => {},
  };
  let confirm: (() => Promise<void>) | undefined;
  const app = {
    authenticated: true, state: { page: "overview" }, content: { querySelector: () => slot },
    requireLogin() {
      resetHostUpdateSession(app);
      app.authenticated = false;
    },
    dialog(_title: string, _body: string, submit: () => Promise<void>, label: string) {
      assert.equal(label, "更新并重启");
      confirm = submit;
    },
  };
  return {
    app, slot, click(action: string) {
      slot.onclick({ target: { closest: () => ({ dataset: { hostAction: action } }) } });
    },
    confirm: async () => { assert.ok(confirm); await confirm(); },
  };
}

function mockSessionStorage(t: TestContext) {
  const entries = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { sessionStorage: {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  } } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
}

function assertCompactSuccess(html: string) {
  assert.doesNotMatch(html, /class="wl-track"|<details\b[^>]*\bopen\b/);
  assert.match(html, /v0\.1\.1/);
  assert.match(html, /<summary\b[^>]*>[\s\S]*?更新记录[\s\S]*?<\/summary>[\s\S]*?已切换版本[\s\S]*?<\/details>/);
  assert.match(html, /data-host-action="check"/);
}

test("a console read or cancelled dialog cannot apply an update; confirming pins the shown version", async t => {
  const view = overview();
  const requests: { path: string; body?: string }[] = [];
  const fetch = t.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    requests.push({ path, body: init.body as string });
    return Response.json(path.endsWith("/apply") ? { ...ready, phase: "preparing" } : ready);
  });
  t.after(() => resetHostUpdateSession(view.app));
  bindHostUpdate(view.app);
  await turn();
  assert.match(view.slot.innerHTML, /v0\.1\.1 可更新/);
  assert.match(view.slot.innerHTML, /当前版本 v0\.1\.0/);
  assert.match(view.slot.innerHTML, /href="https:\/\/github\.com\/iinukami\/whalelife\/releases\/tag\/v0\.1\.1"[^>]*>发行说明</);
  view.click("open");
  assert.equal(fetch.mock.callCount(), 1); // The cancel path never runs submit.
  view.click("open");
  await view.confirm();
  assert.deepEqual(requests.map(call => call.path), ["/api/host-update", "/api/host-update/apply"]);
  assert.deepEqual(JSON.parse(requests[1].body!), { version: "0.1.1", confirmed: true });
  assert.match(view.slot.innerHTML, /data-phase="prepare"/);
  assert.doesNotMatch(view.slot.innerHTML, /更新成功/);
});

test("an interrupted apply waits for server status and 401 requires login; rollback survives a new session", async t => {
  const view = overview();
  let reads = 0, applies = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async (path: string) => {
    if (path.endsWith("/apply")) { applies++; throw Error("断线"); }
    if (++reads === 1) return Response.json(ready);
    if (reads === 2) return Response.json({ error: "请重新登录" }, { status: 401 });
    return Response.json({ ...ready, lastResult: { status: "rolled-back", version: "0.1.1", message: "已恢复 0.1.0" } });
  });
  t.after(() => resetHostUpdateSession(view.app));
  bindHostUpdate(view.app);
  await turn();
  view.click("open");
  await view.confirm();
  assert.match(view.slot.innerHTML, /data-phase="reconnect"/);
  assert.doesNotMatch(view.slot.innerHTML, /更新成功/);
  t.mock.timers.tick(2000);
  await turn();
  assert.equal(view.app.authenticated, false);
  t.mock.timers.tick(60_000);
  assert.equal(reads, 2);
  view.app.authenticated = true;
  bindHostUpdate(view.app);
  await turn();
  assert.match(view.slot.innerHTML, /更新失败，已回滚/);
  assert.match(view.slot.innerHTML, /已恢复 0\.1\.0/);
  t.mock.timers.tick(60_000);
  assert.match(view.slot.innerHTML, /data-phase="restored"/);
  assert.match(view.slot.innerHTML, /data-host-action="open"/);
  assert.equal(applies, 1);
});

test("offline checks can be retried, and only the host's returned outcome is shown as success", async t => {
  const view = overview();
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (path: string) => {
    paths.push(path);
    if (paths.length === 1) throw Error("无法连接发行源");
    return Response.json({ ...ready, current: "0.1.1", latest: null,
      lastResult: { status: "updated", version: "0.1.1", message: "已更新并重启" } });
  });
  t.after(() => resetHostUpdateSession(view.app));
  bindHostUpdate(view.app);
  await turn();
  assert.match(view.slot.innerHTML, /无法连接发行源/);
  assert.match(view.slot.innerHTML, /href="https:\/\/github\.com\/iinukami\/whalelife\/releases"[^>]*>GitHub 正式发行版</);
  assert.doesNotMatch(view.slot.innerHTML, /暂无更高的正式版本/);
  view.click("check");
  await turn();
  assert.equal(paths[1], "/api/host-update/check");
  assert.match(view.slot.innerHTML, /更新成功/);
  assert.match(view.slot.innerHTML, /当前版本 v0\.1\.1 · 暂无更高的正式版本/);
  assert.match(view.slot.innerHTML, /GitHub 正式发行版/);
  assert.doesNotMatch(hostUpdateContent({ hostUpdate: { data: { ...ready, supported: false } } }), /data-host-action="open"/);
  const failedCheck = hostUpdateContent({ hostUpdate: { data: {
    ...ready, latest: null, checked: false, error: "无法读取更新清单", lastCheckedAt: "2026-11-21T10:20:30.000Z",
  } } });
  assert.match(failedCheck, /上次成功检查/);
  assert.match(failedCheck, /无法读取更新清单/);
  assert.doesNotMatch(failedCheck, /暂无更高的正式版本|data-host-action="open"/);
  for (const status of ["updated", "failed", "rolled-back"]) {
    const html = hostUpdateContent({ hostUpdate: { data: { ...ready, latest: null, checked: false,
      error: "无法读取更新清单", lastResult: { status, version: ready.current, message: "上次结果" } } } });
    assert.match(html, /无法读取更新清单/);
    assert.match(html, /GitHub 正式发行版/);
  }
});

test("opening and idling on the overview only read local status; a click checks GitHub", async t => {
  const view = overview();
  const paths: string[] = [];
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.mock.method(globalThis, "fetch", async (path: string) => {
    paths.push(path);
    return Response.json({ ...ready, latest: null, checked: path.endsWith("/check") });
  });
  t.after(() => resetHostUpdateSession(view.app));
  bindHostUpdate(view.app);
  assert.doesNotMatch(view.slot.innerHTML, /暂无更高的正式版本/);
  await turn();
  assert.match(view.slot.innerHTML, /当前版本 v0\.1\.0 · 尚未检查更新/);
  assert.match(view.slot.innerHTML, /GitHub 正式发行版/);
  assert.doesNotMatch(view.slot.innerHTML, /data-host-action="open"|>发行说明</);
  t.mock.timers.tick(60 * 60_000);
  bindHostUpdate(view.app);
  await turn();
  assert.deepEqual(paths, ["/api/host-update"]);
  view.click("check");
  view.click("check");
  await turn();
  assert.match(view.slot.innerHTML, /暂无更高的正式版本/);
  t.mock.timers.tick(60 * 60_000);
  await turn();
  assert.deepEqual(paths, ["/api/host-update", "/api/host-update/check"]);
});

test("a three-minute disconnect preserves the last confirmed stage and reconnect only reads the current result", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date("2026-11-27T12:00:00Z") });
  const view = overview();
  const paths: string[] = [];
  let offline = false, recovered = false;
  t.mock.method(globalThis, "fetch", async (path: string) => {
    paths.push(path);
    if (path.endsWith("/apply")) return Response.json({ ...ready, phase: "restarting" });
    if (offline) throw TypeError("连接中断");
    if (recovered) return Response.json({ ...ready, current: "0.1.1", latest: null,
      lastResult: { status: "updated", version: "0.1.1", message: "已切换版本", at: new Date().toISOString() } });
    return Response.json(ready);
  });
  t.after(() => resetHostUpdateSession(view.app));
  bindHostUpdate(view.app);
  await turn();
  view.click("open");
  await view.confirm();
  assert.match(view.slot.innerHTML, /data-phase="restart"/);
  offline = true;
  t.mock.timers.tick(2_000);
  await turn();
  assert.match(view.slot.innerHTML, /data-phase="reconnect"/);
  assert.doesNotMatch(view.slot.innerHTML, /data-host-action="reconnect"/);
  t.mock.timers.tick(178_000);
  await turn();
  assert.match(view.slot.innerHTML, /data-phase="reconnect"/);
  t.mock.timers.tick(2_000);
  await turn();
  assert.match(view.slot.innerHTML, /data-phase="timeout"/);
  assert.match(view.slot.innerHTML, /data-host-action="reconnect"/);
  assert.match(view.slot.innerHTML, /v0\.1\.0/);
  assert.match(view.slot.innerHTML, /v0\.1\.1/);
  const countAtTimeout = paths.length;
  t.mock.timers.tick(60_000);
  await turn();
  assert.equal(paths.length, countAtTimeout);
  assert.match(view.slot.innerHTML, /data-phase="timeout"/);
  offline = false;
  recovered = true;
  view.click("reconnect");
  view.click("reconnect");
  await turn();
  assert.deepEqual(paths.slice(countAtTimeout), ["/api/host-update"]);
  assert.equal(paths.filter(p => p.endsWith("/apply")).length, 1);
  assert.match(view.slot.innerHTML, /data-phase="success"/);
  assert.match(view.slot.innerHTML, /已更新到 v0\.1\.1/);
  t.mock.timers.tick(4_999);
  assert.match(view.slot.innerHTML, /data-phase="success"/);
  t.mock.timers.tick(1);
  assertCompactSuccess(view.slot.innerHTML);
  assert.match(view.slot.innerHTML, /控制台暂时与服务断开/);
  assert.deepEqual(paths.slice(countAtTimeout), ["/api/host-update"]);
});

test("refreshing during the success message shows compact history immediately and only reads local status", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  mockSessionStorage(t);
  const view = overview();
  const paths: string[] = [];
  let runningVersionChanged = false;
  t.mock.method(globalThis, "fetch", async (path: string) => {
    paths.push(path);
    if (path.endsWith("/apply")) return Response.json({ ...ready, phase: "restarting" });
    return Response.json(runningVersionChanged
      ? { ...ready, current: "0.1.1", latest: null, checked: false,
          lastResult: { status: "updated", version: "0.1.1", message: "已切换版本" } }
      : ready);
  });
  t.after(() => resetHostUpdateSession(view.app));
  bindHostUpdate(view.app);
  await turn();
  view.click("open");
  await view.confirm();
  runningVersionChanged = true;
  t.mock.timers.tick(2000);
  await turn();
  assert.match(view.slot.innerHTML, /data-phase="success"/);
  resetHostUpdateSession(view.app);
  bindHostUpdate(view.app);
  await turn();
  assertCompactSuccess(view.slot.innerHTML);
  t.mock.timers.tick(10_000);
  assertCompactSuccess(view.slot.innerHTML);
  assert.deepEqual(paths, ["/api/host-update", "/api/host-update/apply", "/api/host-update", "/api/host-update"]);
});

test("the previous rollback of the same target cannot finish a retry and a preparation failure is never a rollback", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date("2026-11-27T12:00:00Z") });
  const view = overview();
  const prior = { status: "rolled-back", version: "0.1.1", message: "上次预检失败", at: "2026-11-26T10:00:00Z" };
  let newFailure = false;
  t.mock.method(globalThis, "fetch", async (path: string) => {
    const result = newFailure
      ? { status: "failed", version: "0.1.1", message: "安装包 SHA-256 校验失败", at: new Date().toISOString() }
      : prior;
    return Response.json({ ...ready, phase: path.endsWith("/apply") ? "preparing" : "idle", lastResult: result });
  });
  t.after(() => resetHostUpdateSession(view.app));
  bindHostUpdate(view.app);
  await turn();
  view.click("open");
  await view.confirm();
  t.mock.timers.tick(2_000);
  await turn();
  assert.doesNotMatch(view.slot.innerHTML, /data-phase="(?:success|restored|failed)"/);
  newFailure = true;
  t.mock.timers.tick(2_000);
  await turn();
  assert.match(view.slot.innerHTML, /data-phase="failed"/);
  assert.match(view.slot.innerHTML, /安装包 SHA-256 校验失败/);
  assert.doesNotMatch(view.slot.innerHTML, /data-phase="restored"/);
  t.mock.timers.tick(60_000);
  assert.match(view.slot.innerHTML, /data-phase="failed"/);
  resetHostUpdateSession(view.app);
  bindHostUpdate(view.app);
  await turn();
  assert.match(view.slot.innerHTML, /data-phase="failed"/);
  assert.match(view.slot.innerHTML, /安装包 SHA-256 校验失败/);
  assert.match(view.slot.innerHTML, /data-host-action="open"/);
});

test("a rejected apply does not leave the relogged console waiting for an update that never started", async t => {
  mockSessionStorage(t);
  const view = overview();
  t.after(() => resetHostUpdateSession(view.app));
  t.mock.method(globalThis, "fetch", async (path: string) => path.endsWith("/apply")
    ? Response.json({ error: "请先登录" }, { status: 401 }) : Response.json(ready));
  bindHostUpdate(view.app);
  await turn();
  view.click("open");
  await view.confirm();
  assert.equal(view.app.authenticated, false);
  view.app.authenticated = true;
  bindHostUpdate(view.app);
  await turn();
  assert.match(view.slot.innerHTML, /data-host-action="open"/);
  assert.doesNotMatch(view.slot.innerHTML, /data-phase="(?:unconfirmed|reconnect|timeout)"/);
});

test("reconnecting after a lost submission can return to checking if the host is idle without a receipt", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date("2026-11-27T12:00:00Z") });
  const view = overview(), paths: string[] = [];
  t.after(() => resetHostUpdateSession(view.app));
  t.mock.method(globalThis, "fetch", async (path: string) => {
    paths.push(path);
    if (path.endsWith("/apply")) throw TypeError("响应中断");
    return Response.json(ready);
  });
  bindHostUpdate(view.app);
  await turn();
  view.click("open");
  await view.confirm();
  t.mock.timers.tick(180_000);
  await turn();
  assert.match(view.slot.innerHTML, /data-phase="timeout"/);
  view.click("reconnect");
  await turn();
  assert.match(view.slot.innerHTML, /data-host-action="check"/);
  assert.doesNotMatch(view.slot.innerHTML, /data-phase="(?:success|restored|timeout)"/);
  assert.equal(paths.filter(p => p.endsWith("/apply")).length, 1);
  assert.equal(paths.filter(p => p.endsWith("/check")).length, 0);
});
