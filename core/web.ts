/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createServer } from "node:http";
import { clock, timezone } from "./time.ts";
import { mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { resolve as resolvePath, sep as pathSep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { Channels } from "./channels.ts";
import { TurnInput } from "./turn-input.ts";
import { conversationRows } from "./channel-history.ts";
import { toolContentSnapshot } from "./tool-content.ts";
import { PluginWebRegistry } from "./plugin-web.ts";
import { WebClientDisconnectedError } from "./web-errors.ts";
import { OfficialPlugins } from "./official-plugins.ts";
import { CommunityPackages, installedCommunityPackages, type ReviewedCommunityEntry } from "./community-packages.ts";
import { readPublishedCommunityReviews } from "./community-reviews.ts";
import { validPluginId } from "./plugin-state.ts";
import { PluginUpdates } from "./plugin-updates.ts";
import { officialUpdateEntries, readOfficialUpdateEntries } from "./official-update-registry.ts";
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

const directoryPrefix = (path: string) => path.endsWith(pathSep) ? path : path + pathSep;

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
  let lastCommunityReviews: ReviewedCommunityEntry[] | undefined;
  // 本轮输入信箱：本轮还在跑时网页端可以往里塞话，等下一次请求模型前生效。
  // 按「轮」存，不按会话：两个窗口同时跑同一会话时，A 的补充不会落进 B 的回合。
  const webInboxes = new Map<string, TurnInput>();
  // 网页图片上传：一次最多 4 张、单张 4MiB、合计 16MiB，落盘后只在历史里留路径。
  const uploadLimit = Object.freeze({ images: 4, imageBytes: 4 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 });
  const saveUploads = async (id: unknown, value: unknown) => {
    if (value === undefined || value === null) return [] as { path: string; mimeType: string; data: Buffer }[];
    if (!Array.isArray(value)) throw Error("图片列表格式无效");
    if (!value.length) return [];
    if (value.length > uploadLimit.images) throw Error("一次最多发送 " + uploadLimit.images + " 张图片");
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw Error("会话 ID 无效");
    const sessionId = id;
    const parts: { type: "image"; mimeType: string; data: Buffer }[] = [];
    for (const item of value) {
      if (!item || typeof item.mimeType !== "string" || typeof item.data !== "string")
        throw Error("图片格式无效");
      if (!["image/png", "image/jpeg", "image/webp"].includes(item.mimeType))
        throw Error("只支持 PNG、JPEG、WebP 图片");
      if (item.data.length > Math.ceil(uploadLimit.imageBytes / 3) * 4)
        throw Error("单张图片需在 4MiB 以内");
      const decoded = Buffer.from(item.data, "base64");
      if (decoded.toString("base64") !== item.data) throw Error("图片 base64 格式无效");
      if (!decoded.byteLength || decoded.byteLength > uploadLimit.imageBytes)
        throw Error("单张图片需在 4MiB 以内");
      parts.push({ type: "image", mimeType: item.mimeType, data: decoded });
    }
    if (parts.reduce((sum, part) => sum + part.data.byteLength, 0) > uploadLimit.totalBytes)
      throw Error("图片合计需在 16MiB 以内");
    // 复用工具多媒体的签名校验：MIME 与文件头必须对得上。
    const checked = toolContentSnapshot(parts);
    const dir = resolvePath("memory", "uploads", sessionId);
    await mkdir(dir, { recursive: true });
    const batch = Date.now() + "-" + randomBytes(16).toString("hex");
    const saved: { path: string; mimeType: string; data: Buffer }[] = [];
    try {
      for (const [index, part] of checked.entries()) {
        if (part.type !== "image") continue;
        const ext = part.mimeType === "image/png" ? "png" : part.mimeType === "image/jpeg" ? "jpg" : "webp";
        const name = batch + "-" + (index + 1) + "." + ext;
        const bytes = Buffer.from(part.data);
        const file = await open(resolvePath(dir, name), "wx");
        saved.push({ path: "memory/uploads/" + sessionId + "/" + name, mimeType: part.mimeType, data: bytes });
        try {
          await file.writeFile(bytes);
        } finally {
          await file.close();
        }
      }
    } catch (error) {
      // 只回收本批独占创建的文件，包括当前写到一半或关闭失败的文件。
      await Promise.all(saved.map((item) => rm(resolvePath(item.path), { force: true }).catch((problem) => {
        logger.warn("回收未完成的上传图片失败", { path: item.path, error: problem });
      })));
      throw error;
    }
    return saved;
  };

  const reviewedPackages = async () => {
    try {
      lastCommunityReviews = await readPublishedCommunityReviews(lifetime.signal);
      return lastCommunityReviews;
    }
    catch {
      throw Object.assign(Error("暂时无法核对社区插件的审核记录。请稍后重试，或查看作者的安装说明。"), { status: 503 });
    }
  };
  const hostUpdates: HostUpdates = services.hostUpdates ?? new HostUpdates(runtime.root,
    JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version);
  async function reviewedManager(reviews: ReviewedCommunityEntry[], ids: ReadonlySet<string>, registry?: Record<string, any> | null) {
    const available = new Map(reviews.map(entry => [entry.id, entry]));
    const visited = new Set<string>();
    function usesOfficial(id: string): boolean {
      if (visited.has(id)) return false;
      visited.add(id);
      const entry = available.get(id);
      return !entry || entry.dependencies.some(usesOfficial);
    }
    const needsOfficial = [...ids].some(usesOfficial);
    return new CommunityPackages(runtime, reviews, !needsOfficial ? undefined :
      registry ? officialUpdateEntries(registry, undefined, lifetime.signal) : await readOfficialUpdateEntries(lifetime.signal));
  }
  const pluginUpdates = new PluginUpdates(lifetime.signal, async (reviews, ids, registry) =>
    (await reviewedManager(reviews, ids, registry)).compatibleUpdateVersions(ids));
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
    "community-icons.js",
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
            "default-src 'self'; img-src 'self' https://raw.githubusercontent.com/iinukami/whalelife/main/market/assets/community-icons/; connect-src 'self' https://raw.githubusercontent.com; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
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
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://raw.githubusercontent.com/iinukami/whalelife/main/market/assets/community-icons/; connect-src 'self' https://raw.githubusercontent.com/iinukami/whalelife/main/market/catalog.json; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'",
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
      if (pathname === "/api/community-plugins/manage" && req.method === "GET") {
        const { plugins } = await installedCommunityPackages(runtime, lastCommunityReviews);
        return send(200, { plugins });
      }
      if (req.method === "POST" && (pathname === "/api/community-plugins/uninstall/preview" ||
          pathname === "/api/community-plugins/uninstall/apply")) {
        if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json")
          return send(415, {error:"请使用 JSON 提交操作。"});
        const input = await body(req, 4096), apply = pathname.endsWith("/apply");
        if (!input || !validPluginId(input.id) || Object.keys(input).some(key => key !== "id" && !(apply && key === "planKey")) ||
            (apply && (typeof input.planKey !== "string" || !/^[a-f0-9]{64}$/.test(input.planKey))))
          return send(400, {error:"请先查看此社区插件的卸载计划，再确认卸载。"});
        const packages = await installedCommunityPackages(runtime, lastCommunityReviews);
        if (!apply) return send(200, await packages.preview(input.id));
        try { return send(200, await packages.apply(input.id, input.planKey)); }
        finally { lastOfficial = undefined; }
      }
      if (pathname === "/api/community-plugins" && req.method === "GET") {
        const reviews = await reviewedPackages();
        if (!reviews.length) return send(200, { plugins: [] });
        const manager = await reviewedManager(reviews, new Set(reviews.map(r => r.id)))
          .catch(() => new CommunityPackages(runtime, reviews, []));
        return send(200, await manager.list());
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
        try { return send(200, await (await reviewedManager(reviews, new Set([input.id]))).apply(input)); }
        finally { lastOfficial = undefined; }
      }
      if (pathname === "/api/host-update" && req.method === "GET")
        return send(200, await hostUpdates.view());
      if (["/api/host-update/check", "/api/host-update/apply"].includes(pathname) && req.method === "POST") {
        if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json")
          return send(415, { error: "请使用 JSON 提交操作。" });
        const input = await body(req, 4096);
        if (pathname.endsWith("/check")) return send(200, await hostUpdates.check());
        return send(202, await hostUpdates.apply(input));
      }
      if (pathname === "/api/plugin-updates" && req.method === "GET")
        return send(200, pluginUpdates.snapshot(runtime.list()));
      if (pathname === "/api/plugin-updates/check" && req.method === "POST") {
        if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json")
          return send(415, { error: "请使用 JSON 提交操作。" });
        await body(req, 4096);
        let officialUpdates: OfficialPlugins | undefined;
        const reviewed = (registry: Record<string, any>, reviews: ReviewedCommunityEntry[]) =>
          officialUpdates ??= OfficialPlugins.forUpdate(runtime, officialUpdateEntries(registry, undefined, lifetime.signal), reviews);
        return send(200, await pluginUpdates.list(runtime.list(), (registry, reviews) => registry ? reviewed(registry, reviews).list() : officialList(true),
          (registry, ids, reviews) => reviewed(registry, reviews).compatibleUpdateVersions(ids)));
      }
      if (req.method === "POST" && (pathname === "/api/plugin-updates/preview" || pathname === "/api/plugin-updates/apply")) {
        if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json")
          return send(415, {error:"请使用 JSON 提交操作。"});
        const input = await body(req, 4096);
        const apply = pathname.endsWith("/apply");
        const fields = apply ? ["id","source","version","planKey"] : ["id","source","version"];
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key)))
          return send(400, {error:"请使用商店提供的更新计划。"});
        const notice = pluginUpdates.snapshot(runtime.list()).updates.find(row => row.id === input.id &&
          row.source === input.source && row.latestVersion === input.version);
        if (!notice) return send(409, {error:"请先手动检查插件更新，再确认当前可用的新版。"});
        if (apply && (typeof input.planKey !== "string" || !/^[0-9a-f]{64}$/.test(input.planKey)))
          return send(409, {error:"请重新查看更新计划并确认。"});
        // Both preview and confirmation re-read the published approvals. Never accept
        // a download URL, checksum, dependency list or filesystem path from the UI.
        try {
          if (notice.source === "community") {
            const reviews = await reviewedPackages();
            const owner = reviews.find(r => r.id === notice.id && r.repository === notice.repository);
            if (!owner) return send(409, {error:"社区插件的审核记录或仓库已发生变化，请重新检查更新。"});
            const packages = await reviewedManager(reviews, new Set([notice.id]));
            return send(200, apply ? await packages.applyUpdate({ id:notice.id, version:notice.latestVersion, planKey:input.planKey })
              : await packages.updatePlan(notice.id, notice.latestVersion));
          }
          const hasChild = runtime.list().some((p: {id: string}) => p.id.startsWith(notice.runtimeId + "/"));
          const reviews = hasChild ? await reviewedPackages().catch(() => []) : [];
          const packages = OfficialPlugins.forUpdate(runtime, await readOfficialUpdateEntries(lifetime.signal), reviews);
          return send(200, apply ? await packages.apply({ action:"update", id:notice.id, version:notice.latestVersion, planKey:input.planKey })
            : await packages.updatePlan(notice.id, notice.latestVersion));
        } finally { if (apply) lastOfficial = undefined; }
      }
      if (pathname === "/api/official-plugins" && req.method === "GET") return send(200, await officialList());
      if (pathname === "/api/official-plugins/apply" && req.method === "POST") {
        if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json")
          return send(415, { error: "请使用 JSON 提交操作。" });
        const input = await body(req, 4096);
        if (input?.action !== "install" && input?.action !== "uninstall")
          return send(409, {error:"请选择安装或卸载。更新请从商店手动检查并确认。"});
        try { return send(200, await official.apply(input)); }
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
        const params = new URL(req.url, origin).searchParams;
        const id = params.get("id");
        if (!id) return send(400, { error: "请提供会话 ID" });
        // 不传分页参数时保持旧契约：最近 100 条的数组，旧调用方照旧能 rows.filter
        if (!params.has("limit") && !params.has("before"))
          return send(200, conversationRows(await memory.readSession(id)).slice(-100));
        const asked = Number(params.get("limit"));
        const limit =
          Number.isFinite(asked) && asked > 0
            ? Math.min(Math.floor(asked), 500)
            : 40;
        const cursor = Number(params.get("before"));
        const before = params.has("before") ? (Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : 0) : undefined;
        return send(200, await memory.readConversationPage(id, limit, before));
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
      if (req.method === "POST" && req.url === "/api/clipboard-image") {
        if (process.platform !== "win32")
          return send(501, { error: "当前服务端系统不支持读取系统剪贴板，请直接选择图片" });
        // 粘贴兜底：Chromium 常常解不开微信截图那种裸 DIB，回头问 Windows 要位图。
        const script = fileURLToPath(
          new URL("./clipboard-image.ps1", import.meta.url),
        );
        const text = await new Promise<string>((done, fail) => {
          execFile(
            "powershell",
            ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", script],
            { timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
            (error: any, stdout: string) => {
              if (error && !stdout) return fail(error);
              done(String(stdout ?? "").trim());
            },
          );
        });
        if (text === "NOIMAGE")
          return send(409, { error: "系统剪贴板里没有图片" });
        if (!text || text.startsWith("ERROR:"))
          return send(500, { error: "读取系统剪贴板失败" });
        return send(200, { dataUrl: "data:image/png;base64," + text });
      }
      if (req.method === "GET" && memoryUrl.pathname === "/api/media") {
        // 历史里的 [[img:路径]] 靠这里取图：只给允许根目录下的图片与语音。
        const raw = memoryUrl.searchParams.get("path") ?? "";
        if (!raw) return send(400, { error: "缺少 path" });
        const target = resolvePath(raw);
        const roots = [
          resolvePath("memory"),
          resolvePath("plugins"),
          ...((config.web?.media_roots ?? []) as string[]).map((x) => resolvePath(x)),
        ];
        const allowed = roots.some((r) => target === r || target.startsWith(directoryPrefix(r)));
        if (!allowed) return send(403, { error: "路径不在允许范围" });
        // 上面只是字符串比较：符号链接和 junction 能把路径指到根之外。按真实路径再判一次。
        let real: string;
        try {
          real = await realpath(target);
        } catch {
          return send(404, { error: "文件不存在" });
        }
        const realRoots = await Promise.all(
          roots.map(async (root) => {
            try {
              return await realpath(root);
            } catch {
              return undefined;
            }
          }),
        );
        if (!realRoots.some((r) => r !== undefined && (real === r || real.startsWith(directoryPrefix(r)))))
          return send(403, { error: "路径不在允许范围" });
        const ext = real.slice(real.lastIndexOf(".")).toLowerCase();
        const types: Record<string, string> = {
          ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
          ".gif": "image/gif", ".webp": "image/webp",
          ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg",
        };
        const type = types[ext];
        if (!type) return send(415, { error: "不支持的文件类型" });
        try {
          const buf = await readFile(real);
          res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
          res.end(buf);
        } catch {
          send(404, { error: "文件不存在" });
        }
        return;
      }
      if (req.method === "GET" && memoryUrl.pathname === "/api/file") {
        // 回复末尾「本轮文件」的打开入口：只读工作目录里的普通文件，隐藏目录和密钥文件一律不给。
        const raw = memoryUrl.searchParams.get("path") ?? "";
        if (!raw) return send(400, { error: "缺少 path" });
        const base = await realpath(resolvePath(".")).catch(() => resolvePath("."));
        let target: string;
        try {
          // 真实路径：顺带把大小写、尾随点与空格、8.3 短名、符号链接都归一掉，
          // 后面那些按目录名与文件名的黑名单才有意义。
          target = await realpath(resolvePath(raw));
        } catch {
          return send(404, { error: "文件不存在或读不到" });
        }
        const prefix = directoryPrefix(base);
        if (target === base || !target.startsWith(prefix))
          return send(403, { error: "路径不在工作目录内" });
        const relative = target.slice(prefix.length).split(pathSep).join("/");
        const segments = relative.split("/");
        if (!relative || segments.some((seg: string) => seg.startsWith(".") || seg === "node_modules"))
          return send(403, { error: "这个路径不允许打开" });
        if (/^(config|credentials?|secrets?)\.json$/i.test(segments[segments.length - 1] ?? ""))
          return send(403, { error: "sensitive config file blocked" });
        if (/\.(env|key|pem|p12)$/i.test(relative))
          return send(403, { error: "这个文件不允许打开" });
        try {
          const buf = await readFile(target);
          const text = /\.(md|markdown|patch|diff|txt|ts|tsx|js|mjs|cjs|json|css|html|py|yml|yaml|toml|sh|ps1|log|csv)$/i.test(relative);
          const name = segments[segments.length - 1] ?? "file";
          res.writeHead(200, {
            "Content-Type": text ? "text/plain; charset=utf-8" : "application/octet-stream",
            "Content-Disposition": (text ? "inline" : "attachment") + "; filename*=UTF-8''" + encodeURIComponent(name),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(buf);
        } catch {
          send(404, { error: "文件不存在或读不到" });
        }
        return;
      }
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
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
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
      let data: any;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        send({ type: "error", error: "请求不是合法 JSON" });
        return;
      }
      // 中途插话：本轮还在跑时并进当前回合，改方向不必等下一轮。
      // 它插不进已经发出去的那批工具调用，只在下次请求模型前生效。
      if (data.append) {
        // 只认发起时那一轮的 id。以前没有就退回「本会话当前轮」，
        // 结果是另一个窗口排队时它的补充被塞进别人的回合。
        const turnId = typeof data.turn === "string" && data.turn ? data.turn : "";
        const text = String(data.text ?? "");
        const messageId =
          typeof data.messageId === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(data.messageId)
            ? data.messageId
            : "web_" + randomBytes(8).toString("hex");
        const inbox = turnId ? webInboxes.get(turnId) : undefined;
        // 没送进去的一律把原文带回去，界面据此恢复草稿——失败要看得见。
        if (!inbox) {
          send({ type: "append", status: "closed", messageId, text });
          return;
        }
        // 排队中的轮次还没有落盘通道：收下就等于答应了一件做不到的事。
        if (inbox.waitingForSession) {
          send({ type: "append", status: "closed", messageId, text, reason: "queued" });
          return;
        }
        try {
          const result = await inbox.append({
            messageId,
            text,
            receivedAt: new Date().toISOString(),
            timezone: timezone(config.timezone),
          });
          const entered = result.status === "accepted" || result.status === "duplicate";
          send({ type: "append", status: result.status, messageId, ...(!entered && { text }) });
        } catch (error: any) {
          send({ type: "append", status: "rejected", messageId, text, error: error?.message ?? "补充失败" });
        }
        return;
      }
      if (busy) {
        send({ type: "error", error: "正在回复，请稍候" });
        return;
      }
      busy = true;
      try {
        if (data.expectedSession !== undefined &&
          (data.session !== data.expectedSession || data.expectedSession !== await sessions.current({}, lifetime.signal)))
          throw Error("当前会话已在其他窗口切换，请刷新后重试");
        const images = await saveUploads(data.session, data.images);
        // 图落盘了，但这一轮还没算真正开始。清理的界是「用户消息有没有落库」，
        // 见下面 catch：落库之后不许擦。
        const dropUploads = async () => {
          await Promise.all(
            images.map((image) => rm(resolvePath(image.path), { force: true }).catch((error) => {
              logger.warn("清理网页上传图片失败", { path: image.path, error });
            })),
          );
        };
        let inbox: TurnInput | undefined;
        let turnId: string | undefined;
        try {
          const typed = String(data.text ?? "");
          // 图片既落盘，也把路径写进本条文本：历史重开时仍看得到图，模型那头另有 image_url。
          const marked = images.length
            ? [typed.trim(), ...images.map((image) => "[[img:" + image.path + "]]")].filter(Boolean).join("\n")
            : typed;
          inbox = new TurnInput({
            messageId: "web_" + randomBytes(8).toString("hex"),
            text: marked,
            receivedAt: new Date().toISOString(),
            timezone: timezone(config.timezone),
          }, lifetime.signal);
          // 被丢弃的那段回复要能从界面上撤掉
          inbox.setResetHandler(() => send({ type: "reset" }));
          turnId = "t_" + randomBytes(8).toString("hex");
          webInboxes.set(turnId, inbox);
          send({ type: "started", turn: turnId });
          await channels.web(
            data.session,
            marked,
            (text: string) => send({ type: "chunk", text }),
            (context: any) => send({ type: "context", ...context }),
            typeof data.persona === "string" ? data.persona : undefined,
            images.map((image) => ({ mimeType: image.mimeType, data: image.data })),
            inbox,
          );
        } catch (error) {
          // 界是「用户消息有没有落库」，不是「模型有没有回话」：落库之后历史里
          // 那行 [[img:]] 还指着文件，擦掉就成了断链；没落库才是没人引用的孤儿。
          // 落库结果不明时（uploadsKept）按已落库处理——宁可留孤儿图，不能断链。
          const orphan = !inbox || (!inbox.persisted(inbox.messageId) && !inbox.uploadsKept);
          if (orphan) await dropUploads();
          throw error;
        } finally {
          inbox?.closeInput();
          if (turnId) webInboxes.delete(turnId);
        }
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
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // A gated worker has accepted no user operations. A browser preconnect can
      // otherwise keep server.close() pending until the supervisor's shutdown deadline.
      if (services.hostStarting?.()) server.closeAllConnections();
      await Promise.all([handlers, closed]);
    },
  };
}
