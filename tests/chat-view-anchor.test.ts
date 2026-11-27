// #14 第 2 条回归：阅读位置按消息 id 存、按 id 恢复，不跟序号漂。
// app.js 是自执行的控制台脚本，这里用 vm 跑它的源码，把类截出来喂假 DOM。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(here, "..", "core", "ui", "app.js"), "utf8");

/** 把 import 换成从沙盒空桩取；顺带把末尾的实例化换成导出。 */
function toScript(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // 先把跨行的 import 拼成一整条：`import {` 一直到出现分号为止
  const merged = [];
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    if (line.trim().startsWith("import ") && !line.trim().endsWith(";")) {
      while (i + 1 < lines.length) {
        i += 1;
        line += " " + lines[i].trim();
        if (lines[i].trim().endsWith(";")) break;
      }
    }
    merged.push(line);
  }
  const out = [];
  for (const line of merged) {
    const trimmed = line.trim();
    if (trimmed.startsWith("import ") && trimmed.endsWith(";")) {
      const open = trimmed.indexOf("{");
      const close = trimmed.indexOf("}");
      if (open < 0 || close < open) continue; // 默认导入，跳过
      const names = trimmed
        .slice(open + 1, close)
        .split(",")
        .map((name: string) => name.trim().replace(/\s+as\s+/, ": "))
        .filter(Boolean)
        .join(", ");
      out.push("const { " + names + " } = globalThis.__stubBag;");
      continue;
    }
    if (trimmed === "const app = new ConsoleApp();") {
      out.push("globalThis.__ConsoleApp = ConsoleApp;");
      continue;
    }
    if (trimmed === "app.start();") continue;
    out.push(line);
  }
  return out.join("\n");
}

const patched = toScript(raw);
assert.ok(!patched.includes("import "), "还有没处理的 import");
assert.ok(patched.includes("globalThis.__ConsoleApp = ConsoleApp;"), "没截到 ConsoleApp 的实例化那两行");

class FakeNode {
  dataset: Record<string, string>;
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  offsetTop: number;
  offsetHeight: number;
  children: FakeNode[];
  parent?: FakeNode;
  hidden: boolean;
  innerHTML: string;
  classList: { toggle: () => void };
  constructor(attrs: any = {}) {
    this.dataset = attrs.dataset || {};
    this.clientHeight = attrs.clientHeight || 0;
    this.scrollHeight = attrs.scrollHeight || 0;
    this.scrollTop = attrs.scrollTop || 0;
    this.offsetTop = attrs.offsetTop || 0;
    this.offsetHeight = attrs.offsetHeight || 0;
    this.children = attrs.children || [];
    this.hidden = false;
    this.innerHTML = "";
    this.classList = { toggle() {} };
  }
  addEventListener() {}
  removeEventListener() {}
  getBoundingClientRect() {
    const top = this.offsetTop - (this.parent?.scrollTop ?? 0);
    return { top, bottom: top + this.offsetHeight };
  }
  querySelectorAll(sel: string) {
    if (sel.includes("data-index")) {
      for (const child of this.children) child.parent = this;
      return this.children;
    }
    return [];
  }
  querySelector(sel: string) {
    const mid = /data-mid="([^"]*)"/.exec(sel);
    if (mid) return this.children.find((child) => child.dataset.mid === mid[1]) || null;
    const index = /data-index="([^"]*)"/.exec(sel);
    if (index) return this.children.find((child) => child.dataset.index === index[1]) || null;
    return null;
  }
}

function makeApp(elements: Record<string, FakeNode>) {
  const sandbox: Record<string, any> = {
    document: {
      // 构造函数会往各种元素上挂监听：未知 id 也给个空元素，别让它读到 null
      getElementById: (id: string) => elements[id] || new FakeNode({ dataset: {} }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      visibilityState: "visible",
    },
    localStorage: {
      store: new Map<string, string>(),
      getItem(key: string) {
        return this.store.has(key) ? this.store.get(key) : null;
      },
      setItem(key: string, value: unknown) {
        this.store.set(key, String(value));
      },
    },
    window: {
      addEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {} }),
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout,
    clearTimeout,
    console,
    URL,
    URLSearchParams,
    location: { hash: "" },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // 空桩：任何属性都是返回空串的函数，够恢复位置用
  sandbox.__stubBag = new Proxy(
    {},
    {
      get: () => () => "",
    },
  );
  vm.runInContext(patched, sandbox, { filename: "app.js" });
  const App = sandbox.__ConsoleApp;
  assert.equal(typeof App, "function", "没拿到 ConsoleApp");
  const instance = new App();
  instance.__storage = sandbox.localStorage; // 沙盒里的 localStorage，测试要读
  return instance;
}


test("记阅读位置时存的是消息 id，不是序号", () => {
  const nodes = [
    new FakeNode({ dataset: { index: "0", mid: "m-1" }, offsetTop: 360, offsetHeight: 100 }),
    new FakeNode({ dataset: { index: "1", mid: "m-2" }, offsetTop: 460, offsetHeight: 100 }),
    new FakeNode({ dataset: { index: "2", mid: "m-3" }, offsetTop: 560, offsetHeight: 100 }),
  ];
  const box = new FakeNode({ dataset: {}, offsetTop: 360, clientHeight: 200, scrollHeight: 300, children: nodes });
  box.scrollTop = 130;
  const app = makeApp({ "chat-ruler": new FakeNode({ dataset: {} }), messages: box });
  app.state.session = "s1";
  app.state.messages = [{}, {}, {}];
  app.saveChatView();
  const saved = JSON.parse(app.__storage.getItem(app.chatViewKey("s1")));
  assert.equal(saved.mid, "m-2", "应该记下 m-2 的 id");
  assert.equal(saved.offset, 30);
});

test("末尾追加一条后，按 id 仍回到原来那条，不会漂到新消息", () => {
  const box = new FakeNode({ dataset: {}, clientHeight: 200, scrollHeight: 400 });
  const app = makeApp({ "chat-ruler": new FakeNode({ dataset: {} }), messages: box });
  box.children = [
    new FakeNode({ dataset: { index: "0", mid: "m-0" }, offsetTop: 0, offsetHeight: 100 }),
    new FakeNode({ dataset: { index: "1", mid: "m-1" }, offsetTop: 100, offsetHeight: 100 }),
    new FakeNode({ dataset: { index: "2", mid: "m-2" }, offsetTop: 200, offsetHeight: 100 }),
    new FakeNode({ dataset: { index: "3", mid: "m-3" }, offsetTop: 300, offsetHeight: 100 }),
  ];
  const calls: number[] = [];
  app.setScrollTop = (_target: unknown, value: number) => calls.push(value);
  app.pendingRestore = { count: 3, index: 1, mid: "m-2", offset: 30 };
  app.restoreChatView(box);
  assert.deepEqual(calls, [230], "应该落在 m-2 的 200 + 30，而不是序号 1 的 130");
});
