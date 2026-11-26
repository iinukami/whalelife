import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { temporaryDirectory } from "./temporary-directory.ts";
import { appendFile, mkdir, readFile, readdir, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Memory } from "../core/memory.ts";
import { Sessions } from "../core/session.ts";
import { TurnInput } from "../core/turn-input.ts";
import { startWeb } from "../core/web.ts";
import WebSocket from "ws";

const quiet = { info() {}, error() {}, warn() {}, lines: [] as string[] } as any;
const directoryLink = process.platform === "win32" ? "junction" : "dir";

const boot = async (t: TestContext) => {
  const previous = process.cwd();
  const root = await temporaryDirectory("whale-img-guards-");
  process.chdir(root);
  // 先回到原目录，否则临时目录的清理会因为「当前工作目录被占用」而失败。
  t.after(() => process.chdir(previous));
  const app = await startWeb({ web: { host: "127.0.0.1", port: 0 } }, { channels: {}, logger: quiet }, {});
  t.after(() => app.close());
  const address = app.server.address() as any;
  assert.ok(address && typeof address === "object");
  const url = "http://127.0.0.1:" + address.port;
  const login = await fetch(url + "/api/login", { method: "POST", body: "{}" });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  assert.ok(cookie, "登录要拿到 cookie");
  const get = (path: string) =>
    fetch(url + path, { headers: { Cookie: cookie } });
  return { root, url, get, app };
};

test("媒体接口按真实路径复核：目录链接指到允许根之外就拒绝", async t => {
  const { root, get } = await boot(t);
  await mkdir(join(root, "memory"), { recursive: true });
  const outside = await temporaryDirectory("whale-img-outside-");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await writeFile(join(outside, "secret.png"), png);
  const linked = join(root, "memory", "linked");
  await symlink(outside, linked, directoryLink);
  t.after(() => process.platform === "win32" ? rmdir(linked) : unlink(linked));
  const res = await get("/api/media?path=" + encodeURIComponent("memory/linked/secret.png"));
  assert.equal(res.status, 403, "junction 指向外部目录必须被拒");
  // 同一张图放回允许根里面就应当能取到，说明拒绝来自路径复核而不是别的原因。
  const inside = join(root, "memory", "uploads", "ok");
  await mkdir(inside, { recursive: true });
  await writeFile(join(inside, "ok.png"), png);
  const good = await get("/api/media?path=" + encodeURIComponent("memory/uploads/ok/ok.png"));
  assert.equal(good.status, 200);
  assert.equal(good.headers.get("content-type"), "image/png");
});

test("媒体接口拒绝允许根内的非媒体文件", async t => {
  const { root, get } = await boot(t);
  await mkdir(join(root, "memory"), { recursive: true });
  await writeFile(join(root, "memory", "notes.txt"), "not an image\n");
  const res = await get("/api/media?path=memory/notes.txt");
  assert.equal(res.status, 415);
});

test("文件接口拒绝敏感文件及其文件名变形", async t => {
  const { root, get } = await boot(t);
  await writeFile(join(root, "config.json"), JSON.stringify({ web: {} }));
  assert.equal(process.cwd(), root, "处理器按 cwd 解析相对路径");
  for (const raw of ["config.json", "Config.JSON", "CONFIG.json", "config.json.", "config.json "]) {
    const res = await get("/api/file?path=" + encodeURIComponent(raw));
    assert.ok(res.status === 403 || (raw !== "config.json" && res.status === 404), raw);
  }
  // 普通文件照旧能开
  await writeFile(join(root, "notes.md"), "# hi\n");
  const ok = await get("/api/file?path=" + encodeURIComponent("notes.md"));
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /hi/);
});

test("文件、媒体和剪贴板接口要求登录 cookie", async t => {
  const { url } = await boot(t);
  for (const [path, method] of [
    ["/api/file?path=notes.txt", "GET"],
    ["/api/media?path=memory/photo.png", "GET"],
    ["/api/clipboard-image", "POST"],
  ]) {
    const response = await fetch(url + path, { method });
    assert.equal(response.status, 401, path);
    await response.arrayBuffer();
  }
});

test("WebSocket 上限能容纳四张 4MiB 图的 JSON 消息", async t => {
  const { app } = await boot(t);
  const image = { mimeType: "image/png", data: Buffer.alloc(4 * 1024 * 1024).toString("base64") };
  const message = JSON.stringify({ session: "example", text: "看看这四张图", images: Array(4).fill(image) });
  assert.ok(Buffer.byteLength(message) < app.wss.options.maxPayload!);
});


const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
).toString("base64");

// 拉起一个能收发聊天消息的实例：channels.web 的行为由参数决定。
const bootChat = async (t: TestContext, web: any, testRoot?: string) => {
  const previous = process.cwd();
  const root = testRoot ?? await temporaryDirectory("whale-img-chat-");
  process.chdir(root);
  t.after(() => process.chdir(previous));
  const app = await startWeb({ web: { host: "127.0.0.1", port: 0 } }, { channels: { web }, logger: quiet }, {});
  t.after(() => app.close());
  const address = app.server.address() as any;
  const url = "http://127.0.0.1:" + address.port;
  const login = await fetch(url + "/api/login", { method: "POST", body: "{}" });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  assert.ok(cookie, "登录要拿到 cookie");
  // 收一轮回复，直到见到 error 或 done 为止。
  const chat = (payload: any) => new Promise<any>((resolve, reject) => {
    const socket = new WebSocket(url.replace("http", "ws") + "/ws/chat", {
      headers: { Cookie: cookie, Origin: url },
    });
    const timer = setTimeout(() => { socket.terminate(); reject(Error("等聊天回执超时")); }, 15000);
    socket.on("open", () => socket.send(JSON.stringify(payload)));
    socket.on("message", (raw) => {
      const data = JSON.parse(String(raw));
      if (data.type === "error" || data.type === "done") {
        clearTimeout(timer);
        socket.close();
        resolve(data);
      }
    });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
  const uploads = async (session: string) => {
    try { return await readdir(join(root, "memory", "uploads", session)); }
    catch (error: any) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  return { root, chat, uploads };
};

test("模型失败但用户消息已落库：图必须留着，历史里的标记还指着它", async t => {
  const web = async (_id: string, _text: string, _chunk: any, _ctx: any, _persona: any, _images: any, input: any) => {
    input.markPersisted(input.messageId);
    throw Error("模型炸了");
  };
  const { chat, uploads } = await bootChat(t, web);
  const reply = await chat({ session: "s1", text: "看看这张", images: [{ mimeType: "image/png", data: png }] });
  assert.equal(reply.type, "error", "这一轮要报错");
  const files = await uploads("s1");
  assert.deepEqual(files.length, 1, "已经落库的图不能被擦");
});


test("通道报错且用户消息没落库：图要擦掉，不留孤儿", async t => {
  const web = async () => { throw Error("会话被切走了"); };
  const { chat, uploads } = await bootChat(t, web);
  const reply = await chat({ session: "s2", text: "看看这张", images: [{ mimeType: "image/png", data: png }] });
  assert.equal(reply.type, "error");
  const files = await uploads("s2");
  assert.deepEqual(files.length, 0, "没落库的图应当被回收");
});

test("正文超长在建轮时就抛：图同样要被回收", async t => {
  const web = t.mock.fn(async () => { throw Error("不该被调用"); });
  const { chat, uploads } = await bootChat(t, web);
  const reply = await chat({ session: "s3", text: "x".repeat(20000), images: [{ mimeType: "image/png", data: png }] });
  assert.equal(reply.type, "error");
  assert.match(reply.error, /1–16000/);
  assert.equal(web.mock.callCount(), 0);
  const files = await uploads("s3");
  assert.deepEqual(files.length, 0, "建轮就失败时图不能留在盘上");
});

// ---- 落库失败的真实链路：真的调 Sessions.chat，让 appendEvent 在元数据写失败时抛 ----

const personaFile = "image-test-persona\n";

// 起一个真 Memory + 真 Sessions，只把 appendEvent / readSession 换成受控版本。
// appendMode=throw-after-write 复现「JSONL 已追加、元数据写失败」；
// readMode=throw 复现「回读本身失败」，值不是数组复现「读回来的东西没法判」。
const bootSession = async (t: TestContext, options: { appendMode: "throw-after-write" | "throw-before-write"; readMode?: "ok" | "throw" | "not-array" | "null-row" }) => {
  const root = await temporaryDirectory("whale-img-persist-");
  await writeFile(join(root, "p.md"), personaFile);
  const config = {
    providers: [{ id: "model", model: "chat", base_url: "https://unused.invalid", context_window: 32000 }],
    personas: { p: { name: "P", file: "p.md", provider: "model", permission: "full" } },
    channels: { web: { persona: "p", permission: "full" } },
    memory: { include_summary: false },
  };
  const real = new Memory(join(root, "memory"), quiet);
  await real.init();
  const indexError = Error("元数据写失败");
  let modelCalls = 0;
  // 只在 appendEvent 抛过之后才让 readSession 出故障：前面读历史那次必须正常，
  // 否则故障点跑到 appendEvent 之前，验的就不是回读这条路径了。
  let persistFailed = false;
  const flaky = new Proxy(real, {
    get(target, prop) {
      if (prop === "appendEvent") return async (row: any) => {
        if (options.appendMode === "throw-after-write") {
          const episodes = join(target.sessionDir(row.session), "episodes");
          await mkdir(episodes, { recursive: true });
          const month = new Date().toISOString().slice(0, 7);
          await appendFile(join(episodes, month + ".jsonl"), JSON.stringify(row) + "\n");
          // 在正文追加和索引更新之间注入故障。
          persistFailed = true;
          throw indexError;
        }
        persistFailed = true;
        throw Error("JSONL 写失败");               // 一行都没写下去
      };
      if (prop === "readSession" && options.readMode && options.readMode !== "ok") return async (id: string) => {
        if (persistFailed && options.readMode === "throw") throw Error("读不出来");
        if (persistFailed && options.readMode === "null-row") return [null];
        if (persistFailed) return { rows: [] };   // 非数组：判不清
        return target.readSession(id);
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const llm = { chat: async () => { modelCalls++; return { text: "不该走到模型", toolCalls: [] }; } };
  const tools = { list: () => [], call: async () => ({ ok: true }), multimodal: () => undefined };
  const sessions = new Sessions(root, config, { memory: flaky, llm, tools, logger: quiet });
  t.after(() => sessions.close());
  const route = { channel: "web", account: "local", peer: "s1", persona: "p", permission: "full" } as any;
  const signal = new AbortController().signal;
  const makeInput = () => new TurnInput({
    messageId: "m1", text: "看看这张", receivedAt: new Date().toISOString(), timezone: "Australia/Brisbane",
  }, signal);
  return { root, real, sessions, route, makeInput, signal, indexError, modelCalls: () => modelCalls };
};

const sendWithImage = (booted: any, input: any) => booted.sessions.chat(
  "s1", "看看这张", () => {}, undefined, "p", booted.route, false, undefined,
  [{ mimeType: "image/png", data: Buffer.from(png, "base64") }], input,
);

test("JSONL 已追加、元数据写失败：回读得到那行，图必须留着", async t => {
  const booted = await bootSession(t, { appendMode: "throw-after-write" });
  const input = booted.makeInput();
  await assert.rejects(() => sendWithImage(booted, input), /元数据写失败/);
  assert.equal(input.uploadsKept, true, "历史里已经有 [[img:]]，不能擦图");
  assert.equal(booted.modelCalls(), 0, "落库失败就不该走到模型");
  const rows = await booted.real.readSession("s1");
  assert.ok(rows.some((row: any) => row.text === "看看这张"), "这条测试的前提是 JSONL 真的写进去了");
});

test("reopening the session after an index write failure can read the referenced image", async t => {
  const fixture = await bootSession(t, { appendMode: "throw-after-write" });
  const web = async (id: string, text: string, chunk: any, context: any, persona: string, images: any, input: TurnInput) => {
    try {
      await fixture.sessions.chat(id, text, chunk, context, persona, fixture.route, false, undefined, images, input);
    } catch (error) {
      assert.equal(error, fixture.indexError);
      throw error;
    }
  };
  const { root, chat } = await bootChat(t, web, fixture.root);
  const reply = await chat({ session: "s1", text: "看看这张", images: [{ mimeType: "image/png", data: png }] });
  assert.equal(reply.type, "error");
  assert.match(reply.error, /元数据写失败/);
  assert.equal(fixture.modelCalls(), 0);
  await fixture.sessions.close();

  const reopened = new Memory(join(root, "memory"), quiet);
  await reopened.init();
  const row = (await reopened.readSession("s1")).find(row => row.role === "user");
  assert.ok(row);
  const marker = /^看看这张\n\[\[img:(memory\/uploads\/s1\/[^/\\\]]+)\]\]$/.exec(row.text);
  assert.ok(marker, "the reopened message must contain its saved upload path");
  assert.deepEqual(await readFile(join(root, marker[1])), Buffer.from(png, "base64"));
});

test("落库失败且回读不了：判不清一律保留图", async t => {
  const booted = await bootSession(t, { appendMode: "throw-after-write", readMode: "throw" });
  const input = booted.makeInput();
  await assert.rejects(() => sendWithImage(booted, input), /元数据写失败/);
  assert.equal(input.uploadsKept, true, "读不清不等于没写进去");
});

test("回读给回非数组：不能靠 rows.some 再抛一次，图照样保留", async t => {
  const booted = await bootSession(t, { appendMode: "throw-after-write", readMode: "not-array" });
  const input = booted.makeInput();
  await assert.rejects(() => sendWithImage(booted, input), /元数据写失败/);
  assert.equal(input.uploadsKept, true, "回读结果不可解析时按已落库处理");
});

test("回读只返回 null 行：判不清，保留图并上报原始错误", async t => {
  const booted = await bootSession(t, { appendMode: "throw-after-write", readMode: "null-row" });
  const input = booted.makeInput();
  await assert.rejects(() => sendWithImage(booted, input), error => error === booted.indexError);
  assert.equal(input.uploadsKept, true);
});

test("确认没落库：不置保护标记，图可以回收", async t => {
  const booted = await bootSession(t, { appendMode: "throw-before-write" });
  const input = booted.makeInput();
  await assert.rejects(() => sendWithImage(booted, input), /JSONL 写失败/);
  assert.equal(input.uploadsKept, false, "一条都没写下去时不该留孤儿");
  const rows = await booted.real.readSession("s1");
  assert.equal(rows.length, 0);
});
