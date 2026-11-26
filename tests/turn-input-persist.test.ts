import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const load = () => import(new URL("../core/turn-input.ts", import.meta.url).href);
const webSource = () => readFile(new URL("../core/web.ts", import.meta.url), "utf8");
const appSource = () => readFile(new URL("../core/ui/app.js", import.meta.url), "utf8");

const msg = (id: string, text = "补充一条") => ({
  messageId: id,
  text,
  receivedAt: "2026-11-23T00:00:00.000Z",
  timezone: "Asia/Shanghai",
});

test("补充在接收时就落盘，不必等到消费方 take", async () => {
  const { TurnInput } = await load();
  const saved: string[] = [];
  const input = new TurnInput(msg("seed", "开场"), new AbortController().signal);
  input.setPersister(async (message: { text: string }) => { saved.push(message.text); });
  const result = await input.append(msg("a", "排队时的补充"));
  assert.equal(result.status, "accepted");
  // 还没 take，但已经写下去了：模型报错或取消也不会丢
  assert.deepEqual(saved, ["排队时的补充"]);
  assert.equal(input.persisted("a"), true);
  assert.deepEqual((await input.take()).map((m: { text: string }) => m.text), ["排队时的补充"]);
});

test("排队中的轮次还没有 persister，消费方得自己补写", async () => {
  const { TurnInput } = await load();
  const input = new TurnInput(msg("seed", "开场"), new AbortController().signal);
  assert.equal((await input.append(msg("b"))).status, "accepted");
  assert.equal(input.persisted("b"), false);
});

test("渠道按回执接收，由会话消费后写入历史", async () => {
  const { TurnInput } = await load();
  const order: string[] = [];
  const input = new TurnInput(msg("seed", "开场"), new AbortController().signal);
  input.setPersister(async () => { order.push("row"); });
  await input.append(msg("ok"), async () => { order.push("receipt"); });
  assert.deepEqual(order, ["receipt"]);
  assert.equal(input.persisted("ok"), false);
  assert.equal((await input.take())[0].messageId, "ok");

  const rejected = new TurnInput(msg("seed2", "开场"), new AbortController().signal);
  const second: string[] = [];
  rejected.setPersister(async () => { second.push("row"); });
  await assert.rejects(() => rejected.append(msg("bad"), async () => { throw Error("此消息已经属于其他轮次"); }));
  assert.deepEqual(second, []);
  assert.equal(rejected.persisted("bad"), false);
});

test("被丢弃的那段回复会通知界面撤掉", async () => {
  const { TurnInput } = await load();
  const input = new TurnInput(msg("seed", "开场"), new AbortController().signal);
  let resets = 0;
  input.setResetHandler(() => { resets++; });
  input.notifyReset();
  assert.equal(resets, 1);
});

test("Web 在会话挂上持久化以后才接收新补充，封口后不再属于排队", async () => {
  const { TurnInput } = await load();
  const input = new TurnInput(msg("seed", "开场"), new AbortController().signal);
  // 还没轮到它跑：persister 没挂上，收下就等于答应了一件做不到的事
  assert.equal(input.waitingForSession, true);
  input.setPersister(async () => {});
  assert.equal(input.waitingForSession, false);
  input.closeInput();
  assert.equal(input.waitingForSession, false);
});

test("同一 messageId 重送只写一行", async () => {
  const { TurnInput } = await load();
  const rows: string[] = [];
  const input = new TurnInput(msg("seed", "开场"), new AbortController().signal);
  input.setPersister(async (message: { text: string }) => { rows.push(message.text); });
  const first = await input.append(msg("same", "同一句"));
  const second = await input.append(msg("same", "同一句"));
  assert.equal(first.status, "accepted");
  assert.equal(second.status, "duplicate");
  assert.deepEqual(rows, ["同一句"]);
  await assert.rejects(() => input.append(msg("same", "换了正文")), /同一消息ID对应了不同正文/);
});

test("信箱按轮登记，不按会话：同一会话的两轮各有各的 turn id", async () => {
  const source = await webSource();
  // 开轮时登记 turn id 并告诉前端
  // 开轮时生成并登记 turn id；不锚定 const，变量作用域随外层 try 变过。
  assert.match(source, /turnId = "t_" \+ randomBytes\(8\)\.toString\("hex"\);/);
  assert.match(source, /webInboxes\.set\(turnId, inbox\);/);
  assert.match(source, /send\(\{ type: "started", turn: turnId \}\);/);
  // 补充只认自己那一轮的 id，不再退回「本会话当前轮」
  assert.match(source, /const turnId = typeof data\.turn === "string" && data\.turn \? data\.turn : "";/);
  assert.doesNotMatch(source, /webInboxes\.get\(String\(data\.session/);
  // 排队中的轮次直接回 closed，并把原文带回去恢复草稿
  assert.match(source, /if \(inbox\.waitingForSession\) \{/);
  assert.match(source, /status: "closed", messageId, text, reason: "queued"/);
  // 收尾按 turn 清
  assert.match(source, /webInboxes\.delete\(turnId\);/);
});

test("前端带稳定 messageId，并按它把没进去的补充放回输入框", async () => {
  const source = await appSource();
  assert.match(source, /this\.turn = typeof data\.turn === "string" \? data\.turn : null;/);
  assert.match(source, /text, messageId \}\)/);
  assert.match(source, /const messageId = "nudge_" \+ Date\.now\(\)\.toString\(36\)/);
  assert.match(source, /this\.pendingNudge = \{ text, nudgeId, messageId \};/);
  // 连续两条被拒时按序号删会错位：消息带 nudgeId，撤回按它走
  assert.match(source, /this\.state\.messages = this\.state\.messages\.filter\(\(m\) => m\.nudgeId !== nudgeId\)/);
  // done 可能比 closed 先到：回执按 messageId 找原文，而不是只看「最后一条待定」
  assert.match(source, /this\.pendingNudge\.messageId === data\.messageId/);
  // 输入框空着才放回去；已经有草稿就排进「未送达」，别把用户新写的挤掉
  assert.ok(source.includes("box.value = original;"));
  assert.ok(source.includes('(this.unsentNudges ||= []).push({ text: original, messageId: data.messageId || "" });'));
  // 等回执时切走页面，$("chat-input") 是 null：不能再对着它赋值
  assert.ok(!source.includes('$("chat-input").value = original;'));
  assert.match(source, /if \(data\.type === "reset"\)/);
});

test("被拒的原文有处可放：输入框空着就放回去，否则排进「未送达」", async () => {
  const source = await appSource();
  assert.match(source, /if \(box && !\(box\.value \|\| ""\)\.trim\(\)\)/);
  assert.match(source, /\(this\.unsentNudges \|\|= \[\]\)\.push\(\{ text: original, messageId: data\.messageId \|\| "" \}\);/);
  assert.match(source, /data-nudge-resend/);
  assert.match(source, /data-nudge-drop/);
  // 切走页面时输入框不在，别对着 null 赋值
  assert.ok(!source.includes('$("chat-input").value = original;'));
});

test("「未送达」条和消息容器是同一个节点时不动手", async () => {
  const source = await appSource();
  assert.match(source, /if \(!bar \|\| bar === \$\("messages"\)\) return;/);
});


test("out-of-order or late rejections recover the exact supplement even with a newer draft", async () => {
  const source = await appSource();
  const proto = source.slice(source.indexOf("class ConsoleApp {"), source.indexOf("const app = new ConsoleApp();"));
  const nodes: Record<string, any> = { "chat-input": { value: "" }, send: { disabled: false } };
  class Socket {
    static OPEN = 1; readyState = 1; sent: any[] = [];
    send(frame: string) { this.sent.push(JSON.parse(frame)); }
  }
  const app = Object.create(runInNewContext(proto + "\nConsoleApp.prototype", {
    WebSocket: Socket, location: { origin: "http://localhost" }, $: (id: string) => nodes[id],
  }));
  Object.assign(app, { state: { messages: [], page: "chat", session: "s", status: {}, chatBusy: true }, turn: "t",
    toast() {}, renderMessages() {}, updateChatControls() {}, syncView() {} });
  app.connect("chat");
  const send = (text: string) => { nodes["chat-input"].value = text; app.sendMessage(); return app.chatWS.sent.at(-1); };
  const emit = (data: any) => app.chatWS.onmessage({ data: JSON.stringify(data) });
  const first = send("same text"), second = send("same text");
  nodes["chat-input"].value = "new draft";
  emit({ type: "append", status: "full", messageId: first.messageId });
  assert.equal(nodes["chat-input"].value, "new draft");
  assert.equal(app.unsentNudges?.[0]?.text, "same text");
  assert.equal(app.state.messages.length, 1);
  assert.equal(app.state.messages[0].nudgeId, "n_" + second.messageId);

  emit({ type: "done" });
  delete nodes["chat-input"]; app.state.page = "overview";
  emit({ type: "append", status: "closed", text: "same text", messageId: second.messageId });
  assert.equal(app.state.messages.length, 0);
  assert.equal(app.unsentNudges.length, 2);
  assert.equal(app.unsentNudges[1].messageId, second.messageId);
});
