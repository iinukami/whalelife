import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const load = () => import(new URL("../core/ui/rich.js", import.meta.url).href);
const appSource = () => readFile(new URL("../core/ui/app.js", import.meta.url), "utf8");

/** 只实现 detailsState / applyDetailsState 用到的那点 DOM 形状。 */
type StubDetails = { open: boolean };
type StubMessage = {
  dataset: { index: string };
  querySelectorAll: (selector: string) => StubDetails[];
};
const boxOf = (messages: StubMessage[]) => ({
  querySelectorAll: (selector: string) => (selector === ".message[data-index]" ? messages : []),
});
const messageOf = (index: number, details: StubDetails[]): StubMessage => ({
  dataset: { index: String(index) },
  querySelectorAll: (selector: string) => (selector === "details" ? details : []),
});

test("表格单元格里的转义竖线不算列分隔", async () => {
  const { renderRich } = await load();
  const html = renderRich(["| 内容 | 状态 |", "| --- | --- |", "| A\\|B | 完成 |"].join("\n"));
  assert.equal((html.match(/<td/g) || []).length, 2);
  assert.match(html, /A\|B/);
  assert.match(html, /完成/);
  assert.doesNotMatch(html, /\\/);
});

test("行内代码保留原样，不被当成加粗或链接", async () => {
  const { renderRich } = await load();
  const bold = renderRich("`**原样**`");
  assert.match(bold, /<code>\*\*原样\*\*<\/code>/);
  assert.doesNotMatch(bold, /<strong>/);
  const link = renderRich("`[说明](https://example.org/)`");
  assert.match(link, /<code>\[说明\]\(https:\/\/example\.org\/\)<\/code>/);
  assert.doesNotMatch(link, /<a /);
});

test("算式里的乘号不会被当成斜体", async () => {
  const { renderRich } = await load();
  const html = renderRich("3 * 4 * 5 = 60");
  assert.match(html, /3 \* 4 \* 5 = 60/);
  assert.doesNotMatch(html, /<em>/);
});

test("四个反引号围栏能把三个反引号的示例整段包住", async () => {
  const { renderRich } = await load();
  const html = renderRich(["````markdown", "```js", "**示例**", "```", "````"].join("\n"));
  assert.equal((html.match(/<pre/g) || []).length, 1);
  assert.match(html, /```js/);
  assert.match(html, /\*\*示例\*\*/);
  assert.doesNotMatch(html, /<strong>/);
});

test("重画消息列表时保留「查看模型原文」的展开状态", async () => {
  const { detailsState, applyDetailsState } = await load();
  const state = detailsState(boxOf([messageOf(0, [{ open: false }]), messageOf(1, [{ open: true }])]));
  assert.equal(state.size, 1);
  const after = boxOf([messageOf(0, [{ open: false }]), messageOf(1, [{ open: false }])]);
  applyDetailsState(after, state);
  assert.equal(after.querySelectorAll(".message[data-index]")[1].querySelectorAll("details")[0].open, true);
});

test("只有空白的首个分片不撤掉等待气泡，头像跟着人格名", async () => {
  const { hasVisibleText, avatarLabel } = await load();
  assert.equal(hasVisibleText(""), false);
  assert.equal(hasVisibleText("\n"), false);
  assert.equal(hasVisibleText(" \n\t"), false);
  assert.equal(hasVisibleText("你好"), true);
  assert.equal(avatarLabel("鲸鲸"), "鲸");
  assert.equal(avatarLabel(""), "助");
});

test("流式分片只重画当前回复，等待气泡不再写死人名", async () => {
  const source = await appSource();
  const from = source.indexOf('data.type === "chunk"');
  const branch = source.slice(from, source.indexOf('data.type === "done"', from));
  assert.match(branch, /if \(created\) this\.renderMessages\(\);/);
  assert.match(branch, /else this\.updateStreamingReply\(\);/);
  assert.match(source, /data-streaming="1"/);
  assert.doesNotMatch(source, /mini-avatar">勘</);
});
