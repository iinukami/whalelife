/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createServer } from "node:http";
import { clock } from "./time.ts";
import { readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { Channels } from "./channels.ts";
import { conversationRows } from "./channel-history.ts";
import { PluginWebRegistry } from "./plugin-web.ts";
import { WebClientDisconnectedError } from "./web-errors.ts";
import { OfficialPlugins } from "./official-plugins.ts";
import { CommunityPackages } from "./community-packages.ts";
import { readPublishedCommunityReviews } from "./community-reviews.ts";
import { PluginUpdates } from "./plugin-updates.ts";
import { HostUpdates } from "./host-updates.ts";
import { CacheDiagnostics } from "./cache-diagnostics.ts";

const marketFiles = new Map([
  ["index.html", "text/html"],
  ["catalog.json", "application/json"],
  ["official-releases.json", "application/json"],
  ["assets/catalog.js", "text/javascript"],
  ["assets/catalog-validation.js", "text/javascript"],
  ["assets/symbols.js", "text/javascript"],
  ["assets/market.js", "text/javascript"],
  ["assets/market.css", "text/css"],
  ["assets/whale.svg", "image/svg+xml"],
]);

export async function startWeb(config: any, services: any, runtime: any) {
  const { logger, memory, sessions } = services;
  const channels = services.channels ?? new Channels(memory, sessions, config);
  const { host = "127.0.0.1", port = 9270 } = config.web;
  if (host !== "127.0.0.1" && (!config.web.lan_enabled || !config.web.password))
    throw Error("局域网监听需 lan_enabled 与访问密码");
  const tokens = new Set<string>();
  const routes = new PluginWebRegistry();
  const official = new OfficialPlugins(runtime);
  const cacheDiagnostics = new CacheDiagnostics(services.modelConfig, services.executionArchive?.root);
  const lifetime = new AbortController();
  const reviewedPackages = async () => {
    try { return await readPublishedCommunityReviews(lifetime.signal); }
    catch {
      throw Object.assign(Error("暂时无法核对社区插件的审核记录。请稍后重试，或查看作者的安装说明。"), { status: 503 });
    }
  };
  const hostUpdates: HostUpdates = services.hostUpdates ?? new HostUpdates(runtime.root,
    JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version);
  const pluginUpdates = new PluginUpdates(lifetime.signal);
  let officialRead: ReturnType<typeof official.list> | undefined;
  let lastOfficial: { time: number; result: Awaited<ReturnType<typeof official.list>> } | undefined;
  function officialList(forNotice = false) {
    if (officialRead) return officialRead;
    // A concurrently opened management page already checks file ownership. Brief reuse
    // is only for advisory badges. Every package change still revalidates its own plan.
    if (forNotice && lastOfficial && Date.now() - lastOfficial.time < 30_000) return Promise.resolve(lastOfficial.result);
    officialRead = official.list().then(result => {
      lastOfficial = { time: Date.now(), result };
      return result;
    }).finally(() => { officialRead = undefined; });
    return officialRead;
  }
  const register = (method: string, path: string, handler: any) => routes.register("", lifetime.signal, method, path, handler);
  let origin = `http://${host}:${port}`;
  const assets = new Set([
    "styles.css",
    "models.css",
    "app.js",
    "rich.js",
    "api.js",
    "icons.js",
    "models.js",
    "views.js",
    "official-plugins.js",
    "plugin-store.js",
    "plugin-updates.js",
    "host-updates.js",
    "personas.js",
    "memory.js",
    "context.js",
    "extensions.js",
  ]);
  const allowedOrigin = (req: any) =>
    !req.headers.origin ||
    req.headers.origin === origin ||
    (config.web.lan_enabled &&
      (() => {
        try {
          const url = new URL(req.headers.origin);
          return url.protocol === "http:" && url.host === req.headers.host;
        } catch {
          return false;
        }
      })());
  const authorized = (req: any) =>
    tokens.has(
      (req.headers.cookie ?? "").match(/(?:^|; )whale=([a-f0-9]+)/)?.[1],
    );
  const body = async (req: any, limit = 65536) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw Error("请求过大");
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      throw Error("请求 JSON 格式无效");
    }
  };
  const savePersona = (input: any) => {
    if (sessions.memoryMaintenance) throw Error("记忆恢复中，请稍后编辑人格");
    return memory.serial(() => {
      if (sessions.memoryMaintenance) throw Error("记忆恢复中，请稍后编辑人格");
      return services.modelConfig.savePersona(input);
    });
  };
  const server = createServer(async (req, res) => {
    const send = (status: number, value: any) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (services.hostStarting?.()) return send(503, { error: "本体正在启动，请稍后重试。" });
      if (!allowedOrigin(req)) return send(403, { error: "来源无效" });
      const pathname = req.url?.split("?", 1)[0] ?? "";
      if (req.method === "GET" && pathname === "/market") {
        res.writeHead(308, { Location: "/market/" + req.url!.slice(pathname.length) });
        return res.end();
      }
      if (req.method === "GET" && pathname.startsWith("/market/")) {
        const file = pathname.slice("/market/".length) || "index.html";
        if (file === "index.html" && authorized(req)) {
          res.writeHead(302, { Location: "/#market", Vary: "Cookie", "Cache-Control": "no-store" });
          return res.end();
        }
        const type = marketFiles.get(file);
        if (!type) return send(404, { error: "文件不存在" });
        const content = await readFile(new URL("../market/" + file, import.meta.url));
        res.writeHead(200, {
          "Content-Type": type + "; charset=utf-8",
          ...(file === "index.html" ? { Vary: "Cookie" } : {}),
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Content-Security-Policy":
            "default-src 'self'; connect-src 'self' https://raw.githubusercontent.com; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        });
        return res.end(content);
      }
      if (req.method === "GET" && req.url?.startsWith("/ui/")) {
        const asset = req.url.slice(4);
        if (!assets.has(asset)) return send(404, { error: "文件不存在" });
        res.writeHead(200, {
          "Content-Type": asset.endsWith(".css")
            ? "text/css; charset=utf-8"
            : "text/javascript; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(await readFile(new URL("./ui/" + asset, import.meta.url)));
        return;
      }
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Frame-Options": "DENY",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://raw.githubusercontent.com/iinukami/whalelife/main/market/catalog.json; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        });
        res.end(await readFile(new URL("./ui/index.html", import.meta.url)));
        return;
      }
      if (req.method === "POST" && req.url === "/api/login") {
        const input = await body(req);
        const expected = String(config.web.password ?? "");
        const actual = String(input.password ?? "");
        if (
          expected &&
          (Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
            !timingSafeEqual(Buffer.from(actual), Buffer.from(expected)))
        )
          return send(401, { error: "访问密码错误" });
        const token = randomBytes(32).toString("hex");
        tokens.add(token);
        res.setHeader(
          "Set-Cookie",
          `whale=${token}; HttpOnly; SameSite=Strict; Path=/`,
        );
        return send(200, { ok: true });
      }
      if (!authorized(req)) return send(401, { error: "请先登录" });
      if (pathname === "/api/community-plugins" && req.method === "GET") {
        const reviews = await reviewedPackages();
        return send(200, reviews.length ? await new CommunityPackages(runtime, reviews).list() : { plugins: [] });
      }
      if (pathname === "/api/community-plugins/apply" && req.method === "POST") {
        if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json")
          return send(415, { error: "请使用 JSON 提交操作。" });
        const input = await body(req, 4096);
        if (!input || input.action !== "install" || typeof input.id !== "string" ||
            typeof input.planKey !== "string" || !/^[a-f0-9]{64}$/.test(input.planKey) ||
            Object.keys(input).some(key => !["id", "action", "planKey"].includes(key)))
          return send(400, {error: "请先查看商店提供的安装计划，再确认安装。"});
        // Re-read the maintainer's approvals on confirmation, including revocations and changed packages.
        const reviews = await reviewedPackages();
        try { return send(200, await new CommunityPackages(runtime, reviews).apply(input)); }
        finally { lastOfficial = undefined; }
      }
      if (pathname === "/api/host-update" && req.method === "GET")
        return send(200, await hostUpdates.status());
      if (["/api/host-update/check", "/api/host-update/apply"].includes(pathname) && req.method === "POST") {
        if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json")
          return send(415, { error: "请使用 JSON 提交操作。" });
        const input = await body(req, 4096);
        if (pathname.endsWith("/check")) return send(200, await hostUpdates.status(true));
        return send(202, await hostUpdates.apply(input));
      }
      if (pathname === "/api/plugin-updates" && req.method === "GET") {
        return send(200, await pluginUpdates.list(runtime.list(), () => officialList(true)));
      }
      if (pathname === "/api/official-plugins" && req.method === "GET") return send(200, await officialList());
      if (pathname === "/api/official-plugins/apply" && req.method === "POST") {
        if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json")
          return send(415, { error: "请使用 JSON 提交操作。" });
        try { return send(200, await official.apply(await body(req, 4096))); }
        finally { lastOfficial = undefined; }
      }
      const memoryUrl = new URL(req.url!, origin);
      if (memoryUrl.pathname === "/api/session/list" && req.method === "GET") {
        const entries = await memory.listSessionMeta();
        return send(200, { items: Object.entries<any>(entries).filter(([, meta]) => !meta.deleted)
          .map(([id, meta]) => ({ id, name: meta.name || id, updatedAt: meta.updatedAt }))
          .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "") || a.id.localeCompare(b.id)) });
      }
      if (memoryUrl.pathname === "/api/session/current" && ["GET", "POST"].includes(req.method!)) {
        const input = req.method === "POST" ? await body(req, 4096) : {};
        return send(200, { id: await sessions.current({ id: input.id, create: input.create, legacyId: input.legacyId }, lifetime.signal) });
      }
      if (memoryUrl.pathname === "/api/memory/local-facts") {
        if (req.method === "GET")
          return send(
            200,
            await services.memoryEngine.localFacts(
              memoryUrl.searchParams.get("id"),
            ),
          );
        if (req.method === "POST") {
          const input = await body(req, 4096);
          if (typeof input.revision !== "string")
            throw Error("请先读取事实版本");
          return send(
            200,
            await services.memoryEngine.saveLocalFacts(
              input.id,
              input.text,
              input.revision,
            ),
          );
        }
      }
      if (memoryUrl.pathname === "/api/memory/knowledge") {
        if (req.method === "GET")
          return send(
            200,
            await services.memoryEngine.inspect(
              memoryUrl.searchParams.get("id"),
              memoryUrl.searchParams.get("query") || "",
              memoryUrl.searchParams.get("archived") === "true",
              {
                offset: Number(memoryUrl.searchParams.get("offset") ?? "0"),
                limit: Number(memoryUrl.searchParams.get("limit") ?? "25"),
              },
            ),
          );
        if (req.method === "POST") {
          const input = await body(req);
          return send(
            200,
            await services.memoryEngine.change(
              input.id,
              input.record_id,
              input.action,
              input.space_id,
            ),
          );
        }
      }
      if (
        req.method === "POST" &&
        memoryUrl.pathname === "/api/memory/settings"
      ) {
        const input = await body(req);
        return send(
          200,
          await services.memoryEngine.settings(
            input.id,
            input.settings,
            input.memberships,
          ),
        );
      }
      if (req.method === "POST" && memoryUrl.pathname === "/api/memory/spaces")
        return send(
          200,
          await services.memoryEngine.createSpace((await body(req)).name),
        );
      if (req.method === "GET" && memoryUrl.pathname === "/api/session/context")
        return send(
          200,
          await sessions.contextStatus(memoryUrl.searchParams.get("id")),
        );
      if (req.method === "POST" && memoryUrl.pathname === "/api/memory/diary/retry")
        return send(200, await sessions.retryDiary((await body(req, 4096)).id));
      if (
        req.method === "POST" &&
        memoryUrl.pathname === "/api/session/context"
      ) {
        const input = await body(req);
        return send(200, await sessions.updateContext(input.id, input.context));
      }
      if (
        req.method === "POST" &&
        memoryUrl.pathname === "/api/memory/session/rename"
      )
        return send(
          200,
          await services.memoryAdmin.renameSession(await body(req)),
        );
      if (
        req.method === "POST" &&
        memoryUrl.pathname === "/api/memory/session/delete"
      )
        return send(
          200,
          await services.memoryAdmin.deleteSession(await body(req)),
        );
      if (req.method === "GET" && memoryUrl.pathname === "/api/memory")
        return send(
          200,
          await services.memoryAdmin.catalog({
            search: memoryUrl.searchParams.get("search") || "",
            offset: Number(memoryUrl.searchParams.get("offset") || 0),
            limit: Number(memoryUrl.searchParams.get("limit") || 25),
          }),
        );
      if (req.method === "GET" && memoryUrl.pathname === "/api/memory/facts")
        return send(200, await services.memoryAdmin.facts());
      if (req.method === "POST" && memoryUrl.pathname === "/api/memory/facts")
        return send(
          200,
          await services.memoryAdmin.saveFacts(await body(req, 131072)),
        );
      if (req.method === "POST" && memoryUrl.pathname === "/api/memory/session/tool-projection") {
        const input = await body(req, 4096);
        return send(200, await services.memoryEngine.setToolProjection(input.id, input.record_id, input.revision, input.enabled));
      }
      if (req.method === "GET" && memoryUrl.pathname === "/api/memory/session")
        return send(
          200,
          await services.memoryAdmin.session(
            memoryUrl.searchParams.get("id"),
            Number(memoryUrl.searchParams.get("offset") || 0),
            Number(memoryUrl.searchParams.get("limit") || 100),
            memoryUrl.searchParams.get("search") || "",
          ),
        );
      if (
        req.method === "GET" &&
        memoryUrl.pathname === "/api/memory/summaries"
      )
        return send(200, await services.memoryAdmin.summaries());
      if (req.method === "GET" && memoryUrl.pathname === "/api/memory/summary")
        return send(
          200,
          await services.memoryAdmin.summary(memoryUrl.searchParams.get("id")),
        );
      if (req.method === "GET" && memoryUrl.pathname === "/api/memory/backups")
        return send(200, await services.memoryAdmin.backups());
      if (req.method === "POST" && memoryUrl.pathname === "/api/memory/backup")
        return send(200, await services.memoryAdmin.backup());
      if (req.method === "POST" && memoryUrl.pathname === "/api/memory/restore")
        return send(200, await services.memoryAdmin.restore(await body(req)));
      if (req.method === "GET" && req.url?.startsWith("/api/persona?")) {
        const id = new URL(req.url, origin).searchParams.get("id");
        return send(200, await services.personaFiles.get(id));
      }
      if (req.method === "POST" && req.url === "/api/persona/config")
        return send(200, await savePersona(await body(req)));
      if (req.method === "POST" && req.url === "/api/persona") {
        const input = await body(req);
        const snapshot = services.modelConfig.snapshot();
        const selected = snapshot.personas.find((p: any) => p.id === input.id);
        if (!selected) return send(400, { error: "人格不存在" });
        const result = await savePersona({
          ...input,
          name: selected.name,
          model: selected.model,
          configRevision: snapshot.revision,
          activate: false,
        });
        return send(200, result.persona);
      }
      if (req.url === "/api/model-config" && req.method === "GET")
        return send(200, services.modelConfig.snapshot());
      if (pathname === "/api/cache-diagnostics" && req.method === "GET")
        return send(200, await cacheDiagnostics.check(memoryUrl.searchParams.get("model") ?? ""));
      if ((pathname === "/api/cache-diagnostics/test" || pathname === "/api/cache-diagnostics/apply") && req.method === "POST") {
        if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json")
          return send(415, { error: "请使用 JSON 提交操作" });
        const input = await body(req, 4096);
        if (pathname.endsWith("/apply")) return send(200, await cacheDiagnostics.apply(input));
        const cancellation = new AbortController();
        const cancel = () => { if (!res.writableEnded) cancellation.abort(); };
        res.once("close", cancel);
        try {
          if (res.destroyed) return;
          const result = await cacheDiagnostics.test(input, AbortSignal.any([cancellation.signal, lifetime.signal]));
          if (!res.destroyed) send(200, result);
          return;
        } finally { res.off("close", cancel); }
      }
      if (req.url === "/api/model-config" && req.method === "POST") {
        const value = await services.modelConfig.save(await body(req));
        services.llm.providers = config.providers;
        return send(200, value);
      }
      if (req.url === "/api/model-config/models" && req.method === "POST") {
        const value = await body(req);
        const result = await services.modelConfig.listModels(value.providerId);
        sessions.modelLimits.clear();
        return send(200, result);
      }
      if (req.url === "/api/model-config/test" && req.method === "POST") {
        const value = await body(req);
        return send(
          200,
          await services.modelConfig.testModel(
            value.modelId,
            value.detectDimensions === true,
          ),
        );
      }
      if (req.url === "/api/model-config/models/draft" && req.method === "POST") {
        const result = await services.modelConfig.listDraftModels(await body(req));
        // Refresh from saved connections on the next context read. Draft metadata
        // must never become an active model's capacity without saving its config.
        sessions.modelLimits.clear();
        return send(200, result);
      }
      if (req.url === "/api/model-config/probe" && req.method === "POST") {
        return send(
          200,
          await services.modelConfig.probeDraft(await body(req)),
        );
      }
      if (req.url === "/api/model-config/compatibility" && req.method === "POST") {
        const value = await body(req), cancellation = new AbortController();
        const cancel = () => { if (!res.writableEnded) cancellation.abort(); };
        res.once("close", cancel);
        try {
          const result = await services.modelConfig.probeCompatibility(value,
            AbortSignal.any([lifetime.signal, cancellation.signal]));
          if (!res.destroyed) return send(200, result);
          return;
        } finally { res.off("close", cancel); }
      }
      if (req.method === "GET" && req.url?.startsWith("/api/session?")) {
        const id = new URL(req.url, origin).searchParams.get("id");
        if (!id) return send(400, { error: "请提供会话 ID" });
        return send(200, conversationRows(await memory.readSession(id)).slice(-100));
      }
      if (req.method === "GET" && req.url === "/api/status")
        return send(200, {
          core: "running",
          clock: clock(config.timezone),
          models: (config.models ?? config.providers).map((p: any) => ({
            id: p.id,
            model: p.model,
          })),
          persona: config.channels.web.persona,
          personaName: config.personas?.[config.channels.web.persona]?.name,
          permission:
            config.channels.web.permission ??
            config.personas?.[config.channels.web.persona]?.permission,
          memory: await memory.status(),
          plugins: runtime.list(),
          pluginPages: routes.pages(),
          diagnostics: services.diagnostics?.status(),
        });
      if (req.method === "GET" && req.url === "/api/logs")
        return send(200, logger.lines);
      if (req.method === "POST" && req.url === "/api/plugin") {
        const data = await body(req);
        await runtime.action(data.id, data.action);
        return send(200, { ok: true });
      }
      if (await routes.serve(req.method!, memoryUrl.pathname, req, res)) return;
      send(404, { error: "接口不存在" });
    } catch (error: any) {
      if (error instanceof WebClientDisconnectedError) {
        logger.info("Web 客户端已断开");
        return;
      }
      logger.error("Web 请求失败", { error });
      if (res.destroyed) return;
      if (!res.headersSent)
        send(
          [400, 404, 409, 413, 500, 502, 503].includes(error.status)
            ? error.status
            : 400,
          {
            error: error.message,
            ...(Array.isArray(error.rolledBack) ? { rolledBack: error.rolledBack } : {}),
          },
        );
      else res.end();
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  server.on("upgrade", (req, socket, head) => {
    if (
      services.hostStarting?.() || !allowedOrigin(req) ||
      !authorized(req) ||
      !["/ws/logs", "/ws/chat"].includes(req.url ?? "")
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });
  wss.on("connection", (ws: WebSocket, req: any) => {
    const send = (data: any) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    };
    if (req.url === "/ws/logs") {
      for (const line of logger.lines) send({ type: "log", line });
      const listener = (line: string) => {
        if (ws.bufferedAmount > 1024 * 1024) {
          ws.close();
          return;
        }
        send({ type: "log", line });
      };
      logger.on("line", listener);
      ws.on("close", () => logger.off("line", listener));
      return;
    }
    let busy = false;
    ws.on("message", async (raw) => {
      if (busy) {
        send({ type: "error", error: "正在回复，请稍候" });
        return;
      }
      busy = true;
      try {
        const data = JSON.parse(raw.toString());
        if (data.expectedSession !== undefined &&
          (data.session !== data.expectedSession || data.expectedSession !== await sessions.current({}, lifetime.signal)))
          throw Error("当前会话已在其他窗口切换，请刷新后重试");
        await channels.web(
          data.session,
          String(data.text ?? ""),
          (text: string) => send({ type: "chunk", text }),
          (context: any) => send({ type: "context", ...context }),
          typeof data.persona === "string" ? data.persona : undefined,
        );
        send({ type: "done" });
      } catch (error: any) {
        logger.error("聊天失败", { error });
        send({
          type: "error",
          error: "回复失败：" + error.message + "。请检查配置或日志后重试。",
        });
      } finally {
        busy = false;
      }
    });
    ws.on("error", (error) => logger.warn("WebSocket 错误", { error }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (address && typeof address !== "string") origin = `http://${host}:${address.port}`;
      resolve();
    });
  });
  logger.info("Web 监听", { url: origin });
  return {
    server,
    wss,
    page: (path: string, handler: any) => register("GET", path, handler),
    api: (path: string, handler: any) => register("POST", path, handler),
    registerPlugin: (...args: Parameters<PluginWebRegistry["register"]>) => routes.register(...args),
    pages: () => routes.pages(),
    async close() {
      lifetime.abort(Error("核心正在关闭"));
      const handlers = routes.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await Promise.all([handlers, new Promise<void>((r) => server.close(() => r()))]);
    },
  };
}
