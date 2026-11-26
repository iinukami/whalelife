/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { persona, personaIdentity } from "./persona.ts";
import { conversationRows } from "./channel-history.ts";
import { channelFailureReason } from "./channel-errors.ts";
import { thinkingToolHistory } from "./llm.ts";
import { EmptyModelResponseError } from "./model-response-error.ts";
import { requestsProtocolExample, ToolProtocolStream } from "./tool-protocol-stream.ts";
import { promptText, toolContentMessage, TOOL_CONTENT_LIMITS } from "./tool-content.ts";
import { channelImageParts, containsAttachedImageBytes, isUnsupportedChannelImage, safeChannelDescription, withPrivateChannelImages } from "./channel-images.ts";
import type { ChannelImage, ChatMessage } from "./plugin-api.ts";
import { timezone, timeContext, timeLabel, messageTime, summaryTime, TIME_GUIDANCE } from "./time.ts";
import { safeId } from "./memory.ts";
import { createHash, randomUUID } from "node:crypto";
import { estimateTokens } from "./memory-engine.ts";
import type { ChannelRoute } from "./channels.ts";
import { shortSummaryKey, shortContext, compressShort, consolidateLong, shouldDeferShortToLong } from "./memory-lifecycle.ts";
import { attribution, historyTail, originNote, originOf, renderHistory, speakerOf, speakerText } from "./provenance.ts";
import { normalizeSenderProfile } from "./sender-profile.ts";
import { SessionQueue, type QueuePolicy } from "./session-queue.ts";
import { TRANSIENT_REPLY, type ToolTurn } from "./tool-retention.ts";
import type { TurnInput, TurnMessage } from "./turn-input.ts";
import { resolveModelContext } from "./model-context.ts";
import { diaryContext, diaryRequestPlan, writeDiary } from "./memory-diary.ts";
import { contextFrame, diaryPrefix, fittingDiaryPrefix, historyEntry, recalledMaterial, supportsContextPrefix } from "./context-material.ts";
import {
  contextPolicy,
  validateContext,
  matchingHistory,
  requestUsage,
  memoryWindow,
} from "./session-context.ts";
/** 本轮图片总量上下限：超过 soft 降 detail，超过 total 直接拒。 */
const IMAGE_LIMITS = Object.freeze({ softBytes: 8 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 });
export class Sessions {
  memoryMaintenance = false;
  blockedSessions = new Set<string>();
  modelLimits = new Map<string, { value: number | null; until: number }>();
  locks = new Set<string>();
  private queue = new SessionQueue(this.locks);
  channelOperations = new Map<string, number>();
  private controller = new AbortController();
  private flights = new Set<Promise<unknown>>();
  private identities = new Map<string, Record<string, any>>();
  root: string;
  config: any;
  services: any;
  constructor(root: string, config: any, services: any) {
    this.root = root;
    this.config = config;
    this.services = services;
  }
  beginClose() {
    this.controller.abort(Error("会话服务已关闭"));
  }
  async close() {
    this.beginClose();
    await Promise.allSettled([...this.flights]);
  }
  private async operation<T>(externalSignal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([this.controller.signal, ...(externalSignal ? [externalSignal] : [])]);
    signal.throwIfAborted();
    const flight = Promise.resolve().then(() => run(signal));
    this.flights.add(flight);
    try {
      return await flight;
    } finally {
      this.flights.delete(flight);
    }
  }
  create(name = "", externalSignal?: AbortSignal) {
    return this.operation(externalSignal, async (signal) => {
      const check = () => {
        signal.throwIfAborted();
        if (this.memoryMaintenance) throw Error("记忆恢复中，请稍后新建会话");
      };
      check();
      if (typeof name !== "string" || name.length > 100) throw Error("会话名称最长100字");
      const id = "plugin_" + crypto.randomUUID().replaceAll("-", "");
      await this.services.memory.saveSessionMeta(id, name ? { name } : {}, check);
      return id;
    });
  }
  current(input: { id?: string; create?: boolean; legacyId?: string } = {}, externalSignal?: AbortSignal): Promise<string> {
    return this.operation(externalSignal, (signal) => this.services.memory.currentSession(input, (id?: string) => {
      signal.throwIfAborted();
      if (this.memoryMaintenance || (id && this.blockedSessions.has(id))) throw Error("会话或记忆正在维护，请稍后重试");
    }));
  }
  async modelLimit(provider: any, signal?: AbortSignal) {
    return resolveModelContext({ provider, modelConfig: this.services.modelConfig, signal }, this.modelLimits);
  }
  private outputReserve(provider: any, legacy = false) {
    const configured = Number(provider.parameters?.max_completion_tokens ?? provider.parameters?.max_tokens);
    const value = Number.isSafeInteger(configured) && configured > 0 ? configured : 2048;
    return Math.max(512, legacy ? Math.min(4096, value) : value);
  }
  async contextStatus(id: string, route?: ChannelRoute) {
    return this.operation(route?.signal, (signal) => this.readContextStatus(id, signal, route));
  }
  private async readContextStatus(id: string, signal: AbortSignal, route?: ChannelRoute) {
    signal.throwIfAborted();
    safeId(id);
    const meta = await this.services.memory.sessionMeta(id);
    signal.throwIfAborted();
    if (meta?.deleted) throw Error("此会话已删除，请新建或选择其他会话");
    const p = await persona(
      this.root,
      this.config,
      route?.persona ?? this.config.channels.web.persona,
    );
    const limit = await this.modelLimit(p.provider, signal);
    const policy = contextPolicy(this.config.memory, meta?.context);
    const storedRows = conversationRows(await this.services.memory.readSession(id)).filter(
      (row: any) => row.type !== "channel_receipt",
    );
    const engine = this.services.memoryEngine;
    const rows = engine ? await engine.contextRows(id, storedRows) : storedRows;
    signal.throwIfAborted();
    const history = matchingHistory(rows, p.revision, policy.history_scope);
    const last = rows.findLast((row: any) => row.role === "assistant" && !row.delivery_id);
    const usage = last?.request_usage;
    const matches =
      usage &&
      last.persona_revision === p.revision &&
      usage.model_id === (p.provider.model_id || p.provider.model) &&
      usage.model === p.provider.model &&
      usage.provider_id === p.provider.id;
    const legacy = policy.memory_mode === "legacy";
    const window = legacy ? memoryWindow(history, policy)
      : { short: history.filter((row: any) => row.type === "message"), long: [] };
    const summaryKey = "p_" + createHash("sha256")
      .update(policy.history_scope === "session" ? id + ":session" : id + ":" + p.revision)
      .digest("hex").slice(0, 40);
    const short = legacy ? await shortContext(engine, id, shortSummaryKey(summaryKey), window.short)
      : { text: "", remaining: window.short, checkpoint: {} };
    const scope = policy.history_scope === "persona" ? "persona:" + p.revision : "session";
    const diary = await diaryContext(engine, id, scope, window.short);
    const diaryApplied = !legacy && policy.history_enabled;
    const state = engine ? await engine.state(id) : undefined;
    const selected = policy.history_enabled ? (diaryApplied ? diary.remaining : short.remaining) : [];
    const source = route?.origin ?? { channel: route?.channel ?? "web" };
    const zone = route?.timezone ?? timezone(this.config.timezone);
    const toolList = (route?.permission ?? this.config.channels.web.permission ?? p.permission) === "off"
      ? [] : this.services.tools?.list?.() ?? [];
    const reference = thinkingToolHistory(p.provider, toolList) || (!legacy && selected.some((row: any) => !["user", "assistant"].includes(row.role)));
    const facts = policy.include_facts ? [...new Set<string>(await this.services.memory.readFacts())].slice(-(this.config.memory.facts_max_lines ?? 100)) : [];
    const local = engine ? await engine.localFacts(id) : { text: "" };
    const query = String(history.findLast((row: any) => row.role === "user")?.text ?? "").slice(0, 16000);
    const recalled = engine ? await engine.search(id, query, { persistTrace: false,
      exclude: [...selected.map((row: any) => String(row.text)), ...facts],
      revision: policy.history_scope === "persona" ? p.revision : undefined,
      budget: Math.min(state?.settings.recall_tokens ?? 800, Math.floor(policy.budget_tokens / 3)) }) : { items: [] };
    const overview = legacy && policy.history_enabled ? (engine ? await engine.readSummary(id, summaryKey) : await this.services.memory.readSummary(summaryKey)) : "";
    const materials = { persona: p, facts, origin: source, zone, engine: !!engine, local: local.text,
      snippets: recalledMaterial(recalled.items, zone), overview, overviewSource: legacy && engine ? await engine.summaryState(id, summaryKey) : {},
      short: legacy && policy.include_summary ? short.text : "", shortSource: short.checkpoint,
      diaries: diaryApplied ? diary.entries : [] };
    const previewRows = legacy ? historyTail(selected.map(historyEntry), policy.budget_tokens, estimateTokens, 0, zone, reference).rows : selected.map(historyEntry);
    const preview = contextFrame(materials, previewRows, reference,
      timeContext(zone, new Date().toISOString(), policy.history_enabled ? history : []), !legacy && supportsContextPrefix(p.provider));
    const estimatedInput = estimateTokens(promptText(preview.messages) + JSON.stringify(toolList));
    const reservedOutput = this.outputReserve(p.provider, legacy);
    const memoryRevision = engine
      ? await engine.contextRevision(id)
      : undefined;
    const status = {
      id,
      name: meta?.name || null,
      policy,
      context_estimate: { input_tokens: estimatedInput, reserved_output_tokens: reservedOutput,
        total_tokens: estimatedInput + reservedOutput, percent: limit.tokens ? (estimatedInput + reservedOutput) / limit.tokens * 100 : null,
        source: "estimate" as const },
      diary: { count: diaryApplied ? diary.entries.length : 0, covered_messages: diaryApplied ? window.short.length - diary.remaining.length : 0,
        remaining_messages: selected.length, chars: diaryApplied ? diary.entries.reduce((sum, entry) => sum + Array.from(entry.text).length, 0) : 0,
        invalid: diary.invalid, enabled: !!policy.diary_enabled, ...(diary.paused ? { paused: diary.paused } : {}),
        ...(typeof last?.memory_notice === "string" ? { notice: last.memory_notice } : {}),
        budget_remaining: Math.max(0, (state?.settings.daily_memory_tokens ?? 20000) -
          (state?.daily?.day === new Date().toISOString().slice(0, 10) ? state.daily.reserved : 0)) },
      memory_window: {
        short_term_messages: window.short.length,
        long_term_messages: window.long.length,
        short_summary_chars: Array.from(short.text).length,
        long_summary_chars: legacy ? Array.from(overview).length : Array.from(diaryApplied ? diary.entries.map(entry => entry.text).join("\n") : "").length,
      },
      persona: p.name,
      model: {
        id: p.provider.model_id || p.provider.model,
        name: p.provider.model,
        context_window: limit.tokens,
        limit_source: limit.source,
      },
      available_messages: history.filter((row: any) => row.type === "message")
        .length,
      stored_messages: storedRows.filter((row: any) => row.type === "message").length,
      consumption: engine ? (await engine.state(id)).usage : undefined,
      usage: matches
        ? {
            ...usage,
            context_window: limit.tokens,
            percent: limit.tokens
              ? (usage.used_tokens / limit.tokens) * 100
              : null,
            settings_changed:
              JSON.stringify(last.context_policy) !== JSON.stringify(policy) ||
              (!!engine && last.memory_revision !== memoryRevision),
          }
        : null,
    };
    signal.throwIfAborted();
    return status;
  }
  async updateContext(id: string, input: any) {
    safeId(id);
    if (
      this.memoryMaintenance ||
      this.blockedSessions.has(id) ||
      this.locks.has(id) ||
      this.channelOperations.has(id)
    )
      throw Error("会话正在处理，请结束后修改上下文");
    const policy = validateContext(input);
    this.blockedSessions.add(id);
    try {
      await this.services.memory.saveSessionMeta(id, { context: policy });
    } finally {
      this.blockedSessions.delete(id);
    }
    return this.contextStatus(id);
  }
  async retryDiary(id: string) {
    safeId(id);
    if (this.memoryMaintenance || this.blockedSessions.has(id) || this.locks.has(id) || this.channelOperations.has(id))
      throw Error("会话正在处理，请结束后恢复日记整理");
    // The session lock excludes conversations/restore; blockedSessions would reject
    // our own engine write through the maintenance guard wired by boot().
    this.locks.add(id);
    try {
      const p = await persona(this.root, this.config, this.config.channels.web.persona);
      const meta = await this.services.memory.sessionMeta(id);
      if (!meta || meta.deleted) throw Error("会话不存在或已删除");
      const policy = contextPolicy(this.config.memory, meta.context);
      if (!policy.diary_enabled) throw Error("请先启用该会话的自动日记整理");
      await this.services.memoryEngine.retryDiary(id, policy.history_scope === "persona" ? "persona:" + p.revision : "session");
    } finally { this.locks.delete(id); }
    return this.contextStatus(id);
  }
  async chat(
    id: string,
    text: string,
    onChunk: (text: string) => void,
    onContext?: (value: any) => void,
    expectedPersona?: string,
    route?: ChannelRoute,
    transient = false,
    queue?: QueuePolicy,
    images?: { mimeType: string; data: Uint8Array }[],
    input?: TurnInput,
  ) {
    const captured = this.captureRoute(id, route);
    return this.dispatch(id, captured.signal, () => this.runChat(id, text, onChunk, captured.signal!, onContext, expectedPersona, captured, transient, { transient: false }, input, images), queue);
  }
  /** Capture arrival metadata before any asynchronous routing or queue wait. */
  async outgoingIdentity(id: string, route: ChannelRoute) {
    const active = this.identities.get(id);
    if (active) return { ...active };
    try { return { ...await personaIdentity(this.root, this.config, route.persona), timezone: route.timezone }; }
    catch {
      this.services.logger.warn("发送消息的人格版本不可读取，仅保留会话归属");
      return { timezone: route.timezone };
    }
  }
  captureRoute(id: string, route?: ChannelRoute): ChannelRoute {
    const initial = route ?? { ...this.config.channels.web, channel: "web", account: "local", peer: id };
    return { ...initial, origin: initial.origin ? { ...initial.origin } : undefined,
      senderProfile: initial.sender ? normalizeSenderProfile(initial.senderProfile) : undefined,
      receivedAt: initial.receivedAt ?? new Date().toISOString(), timezone: initial.timezone ?? timezone(this.config.timezone),
      signal: AbortSignal.any([this.controller.signal, ...(initial.signal ? [initial.signal] : [])]) };
  }
  private dispatch<T>(id: string, signal: AbortSignal | undefined, run: () => Promise<T>, policy?: QueuePolicy): Promise<T> {
    safeId(id);
    if (this.memoryMaintenance || this.blockedSessions.has(id)) return Promise.reject(Error("会话或记忆正在维护，请稍后重试"));
    return this.operation(signal, actual => this.queue.submit(id, actual, run, policy));
  }
  /** Internal channel entry: reserve one slot through generation and delivery.
   * Direct sends use the transport queue, so a tool can await its own receipt. */
  dispatchIncoming<T>(id: string, route: ChannelRoute, run: (generate: (text: string) => Promise<string>, turn: ToolTurn) => Promise<T>, input?: TurnInput): Promise<T> {
    const captured = this.captureRoute(id, route);
    const turn: ToolTurn = { transient: false };
    return this.dispatch(id, captured.signal, () => run(text => this.runChat(id, text, () => {}, captured.signal!, undefined, captured.persona, captured, false, turn, input), turn), { wait: true });
  }
  private async runChat(
    id: string,
    text: string,
    onChunk: (text: string) => void,
    signal: AbortSignal,
    onContext?: (value: any) => void,
    expectedPersona?: string,
    route?: ChannelRoute,
    transient = false,
    turn: ToolTurn = { transient: false },
    input?: TurnInput,
    images?: { mimeType: string; data: Uint8Array }[],
  ) {
    signal.throwIfAborted();
    if (this.memoryMaintenance) throw Error("记忆恢复中，请稍后重试");
    safeId(id);
    if (this.blockedSessions.has(id)) throw Error("会话维护中，请稍后重试");
    const meta = await this.services.memory.sessionMeta(id);
    signal.throwIfAborted();
    if (meta?.deleted) throw Error("此会话已删除，请新建或选择其他会话");
    if (this.memoryMaintenance || this.blockedSessions.has(id))
      throw Error("会话维护中，请稍后重试");
    if (route?.images?.length && !text.trim()) text = `[图片 ${route.images.length} 张]`;
    if (!text.trim() || text.length > 16000) throw Error("请输入 1–16000 字");
    const receivedAt = route?.receivedAt ?? new Date().toISOString(), zone = route?.timezone ?? timezone(this.config.timezone);
    const { memory, memoryEngine: engine, llm, tools, logger } = this.services;
    const execution = await this.services.executionArchive?.start(id, {
      kind: transient ? "technical_task" : "conversation", origin: route?.origin ?? { channel: "web" },
      ...(transient ? {} : { trigger: text.slice(0, 160) }),
    });
    turn.execution = execution;
    const diagnostics = this.services.diagnostics;
    // Only model-facing message objects receive image parts or an auxiliary description.
    const channelPictures: { message: ChatMessage; caption: string; id: string; images: ChannelImage[] }[] = [];
    const attachPictures = (message: ChatMessage, id: string, images?: ChannelImage[]) => {
      if (!images?.length) return;
      const caption = message.content as string;
      channelPictures.push({ message, caption, id, images });
      message.content = [{ type: "text", text: caption }, ...channelImageParts(images)];
    };
    const echoesPictures = (text: string) => channelPictures.some(row => containsAttachedImageBytes(text, row.images));
    let describePictures = false;
    let described = 0;
    const prepareDescriptions = async (activeSignal: AbortSignal) => {
      while (describePictures && described < channelPictures.length) {
        activeSignal.throwIfAborted();
        const row = channelPictures[described];
        let description: string;
        try {
          const value = await route!.describeImages!(row.id, row.images, activeSignal);
          description = safeChannelDescription(value, channelPictures.flatMap(item => item.images));
        } catch {
          activeSignal.throwIfAborted();
          throw Error("渠道辅助识图失败，未生成本轮回复");
        }
        activeSignal.throwIfAborted();
        row.message.content = row.caption + "\n【渠道辅助识图，以下为图片内容描述】\n" + description;
        described++;
      }
    };
    const observed = async () => {
    diagnostics?.event("execution.start", { title: transient ? "technical_task" : "conversation",
      trigger: transient ? "program" : "conversation_input", origin: route?.origin ?? { channel: "web" } });
    let executionStatus: "completed" | "failed" | "cancelled" = "failed";
    try {
      const channel = route ?? this.config.channels.web;
      const channelId = route?.channel ?? "web";
      const source = {
        channel: channelId,
        origin: route?.origin ?? { channel: channelId },
        account: route?.account ?? "local",
        peer: route?.peer ?? id,
        ...(route?.sender ? { sender: route.sender } : {}),
        ...(route?.messageId ? { external_message_id: route.messageId } : {}),
      };
      signal.throwIfAborted();
      const p = await persona(this.root, this.config, channel.persona);
      this.identities.set(id, { persona_id: p.id, persona_name: p.name, persona_revision: p.revision, timezone: zone });
      const policy = contextPolicy(this.config.memory, meta?.context);
      await execution?.write("context", { persona: p.id, provider: p.provider.id, model: p.provider.model,
        model_id: p.provider.model_id || p.provider.model,
        cache_layout_eligible: policy.memory_mode !== "legacy" && policy.history_enabled });
      if (expectedPersona && expectedPersona !== p.id)
        throw Error("当前人格已在其他窗口切换，请刷新后重试");
      const summaryId =
        "p_" +
        createHash("sha256")
          .update(
            policy.history_scope === "session"
              ? id + ":session"
              : id + ":" + p.revision,
          )
          .digest("hex")
          .slice(0, 40);
      const context = {
        persona_id: p.id,
        timezone: zone,
        persona_name: p.name,
        persona_revision: p.revision,
        summary_id: summaryId,
        context_policy: policy,
      };
      const session = {
        id,
        ...source,
        personaId: p.id,
        permission: channel.permission ?? p.permission,
        signal,
      };
      const storedHistory = (engine ? await engine.contextRows(id) : conversationRows(await memory.readSession(id))).filter(
        (row: any) => row.type !== "channel_receipt",
      );
      // Adopt the newest previous all-persona checkpoint once; it must not be
      // reset or re-extracted merely because the active persona changes.
      if (policy.memory_mode === "legacy" && policy.history_scope === "session") {
        const existing = engine
          ? await engine.summaryState(id, summaryId)
          : null;
        if (
          engine
            ? existing.text === undefined && !existing.last_id
            : !(await memory.readSummary(summaryId))
        ) {
          const previous = storedHistory.findLast(
            (row: any) =>
              row.summary_id &&
              row.summary_id !== summaryId &&
              row.context_policy?.history_scope === "session",
          );
          if (previous) {
            const checkpoint = engine
              ? await engine.summaryState(id, previous.summary_id)
              : null;
            const text = engine
              ? await engine.readSummary(id, previous.summary_id)
              : await memory.readSummary(previous.summary_id);
            if (engine)
              await engine.summaryState(id, summaryId, { ...checkpoint, text });
            await memory.writeSummary(summaryId, text, id);
          }
        }
      }
      // Only the final contiguous segment belongs to the current persona version.
      const history = matchingHistory(
        storedHistory,
        p.revision,
        policy.history_scope,
      );
      const contextReset = storedHistory.length > 0 && !history.length;
      if (contextReset && policy.memory_mode === "legacy") {
        await memory.writeSummary(summaryId, "", id);
        if (engine)
          await engine.summaryState(id, summaryId, { covered: 0, text: "" });
        if (engine)
          await engine.summaryState(id, shortSummaryKey(summaryId), { covered: 0, text: "" });
      }
      onContext?.({ personaId: p.id, personaName: p.name, contextReset });
      logger.info("对话人格", {
        persona: p.id,
        revision: p.revision.slice(0, 12),
        contextReset,
      });
      // appendEvent 不是原子的：JSONL 追加成功、随后的 index/session 元数据写失败也会抛。
      // 用固定 id 才能在该情况下回读核对——「不确定」按已落库处理，宁可留孤儿图也不断链。
      const userEventId = randomUUID();
      const userRow = {
        id: userEventId,
        type: "message",
        ...source,
        ...(route?.senderProfile ? { senderProfile: route.senderProfile } : {}),
        origin: { ...source.origin, action: "接收消息" },
        session: id,
        role: "user",
        text,
        ts: receivedAt,
        ...context,
      };
      if (!transient) {
        try {
          await memory.appendEvent(userRow);
          // 落库之后再失败，历史里那行 [[img:]] 还指着图，外面不许擦。
          input?.markPersisted(input.messageId);
        } catch (error) {
            // 回读本身也可能抛、可能给回非数组、行里可能带 null。判不清一律按「可能已落库」处理：
            // 宁可留下没人引用的孤儿图，也不能让历史里那行 [[img:]] 指向不存在的文件。
            let verdict: "kept" | "absent" | "unknown" = "unknown";
            try {
              const rows = await memory.readSession(id);
              if (Array.isArray(rows) && rows.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
                verdict = rows.some((row) => row.id === userEventId) ? "kept" : "absent";
              }
            } catch { verdict = "unknown"; }
            if (verdict !== "absent") input?.protectUploads();
          throw error;
        }
      }
      const currentText = transient ? text : speakerText(speakerOf(userRow), text);
      const cfg = { ...this.config.memory, ...policy };
      const allFacts = policy.include_facts ? [...new Set<string>(await memory.readFacts())] : [];
      const facts = allFacts.slice(-(cfg.facts_max_lines ?? 100));
      const local = engine ? await engine.localFacts(id) : { text: "" };
      const legacy = policy.memory_mode === "legacy";
      let summary = policy.history_enabled && legacy
        ? Array.from(engine ? await engine.readSummary(id, summaryId) : await memory.readSummary(summaryId)).slice(0, 200).join("")
        : "";
      const summaryOrigin = engine ? await engine.summaryState(id, summaryId) : {};
      const shortRows = policy.history_enabled ? (legacy ? memoryWindow(history, policy).short : history.filter((row: any) => row.type === "message")) : [];
      const shortKey = shortSummaryKey(summaryId);
      let short = legacy && policy.include_summary
        ? await shortContext(engine, id, shortKey, shortRows)
        : { checkpoint: { covered: 0 }, text: "", remaining: shortRows };
      let shortSummary = short.text;
      const scope = policy.history_scope === "persona" ? "persona:" + p.revision : "session";
      let diary = engine && !legacy ? await diaryContext(engine, id, scope, shortRows)
        : { entries: [], remaining: shortRows, invalid: 0, paused: undefined };
      const diaryApplied = !legacy && policy.history_enabled;
      const diaryEnabled = !!policy.diary_enabled && policy.history_enabled;
      let recent = (diaryApplied ? diary.remaining : short.remaining).map(historyEntry);
      const budget = cfg.budget_tokens ?? 6000;
      const toolList = session.permission === "off" ? [] : tools.list();
      const historyReference = thinkingToolHistory(p.provider, toolList) ||
        (!legacy && recent.some((row: any) => !["user", "assistant"].includes(row.role)));
      // A time window can contain many messages. Count once and slice once, not N full serializations.
      const tail = (rows: any[], capacity: number, keep = 0) => historyTail(rows, capacity, estimateTokens, keep, zone, historyReference);
      const provisional = legacy ? tail(recent, budget).rows : recent;
      const recalled = engine ? await engine.search(id, text, {
        persistTrace: !transient,
        exclude: [...provisional.map((x: any) => x.content), text, ...facts],
        revision: policy.history_scope === "persona" ? p.revision : undefined,
        budget: Math.min((await engine.state(id)).settings.recall_tokens, Math.floor(budget / 3)),
      }) : { items: [] };
      const snippets = recalledMaterial(recalled.items, zone);
      const materials = (compressed = shortSummary) => ({ persona: p, facts, origin: source.origin,
        zone, engine: !!engine, local: local.text, snippets, overview: summary, overviewSource: summaryOrigin,
        short: compressed, shortSource: short.checkpoint, diaries: diaryApplied ? diary.entries : [] });
      const timing = () => timeContext(zone, receivedAt, policy.history_enabled ? history : []);
      const limit = await this.modelLimit(p.provider, signal);
      const reserve = this.outputReserve(p.provider, legacy);
      const requestBudget = limit.tokens ? Math.max(1, limit.tokens - reserve) : Infinity;
      const stablePrefix = !legacy && (supportsContextPrefix(p.provider) ||
        (policy.history_enabled && p.provider.cache_prefix_optimized === true));
      // 图片只在真正发请求时展开；估算与预算一路走占位文本，不会被 base64 撑爆。
      const imageBytes = (images ?? []).reduce((sum, image) => sum + image.data.byteLength, 0);
      if (imageBytes > IMAGE_LIMITS.totalBytes)
        throw Error("本轮图片合计 " + (imageBytes / 1048576).toFixed(1) + "MiB，超过 16MiB 上限，请分几次发或先压缩");
      const imageDetail: "auto" | "low" = imageBytes > IMAGE_LIMITS.softBytes ? "low" : "auto";
      const imageContent = (value: string): any => !images?.length ? value
        : [{ type: "text", text: value }, ...images.map((image) => ({ type: "image_url",
            image_url: { url: "data:" + image.mimeType + ";base64," + Buffer.from(image.data).toString("base64"), detail: imageDetail } }))];
      const assemble = (rows = recent, compressed = shortSummary) => {
        const frame = contextFrame(materials(compressed), rows, historyReference, timing(), stablePrefix);
        frame.messages.push(transient
          ? { role: "user", content: "【本轮插件临时输入，不是真人发言，不作为经历保存】\n来源：" + JSON.stringify(source.origin) + "\n" + text }
          : { role: "user", content: imageContent(currentText) });
        return frame;
      };
      const assembled = (rows = recent, compressed = shortSummary) => assemble(rows, compressed).messages;
      const capacity = (compressed = shortSummary) => Math.min(
        budget - estimateTokens(summary + compressed + (summary ? originNote(summaryOrigin) + summaryTime(summaryOrigin, zone) : "") +
          (compressed ? originNote(short.checkpoint) + summaryTime(short.checkpoint, zone) : "") + facts.join("\n") + JSON.stringify(snippets)),
        requestBudget - estimateTokens(promptText(assembled([], compressed)) + JSON.stringify(toolList)),
      );
      let recentTokens = tail(recent, Infinity).tokens;
      const overBudget = () => recentTokens > capacity();
      let shortAttempted = false;
      // Short-term classification never changes because its prompt representation is compressed.
      if (legacy && engine && policy.include_summary && policy.history_enabled && overBudget() && recent.length > 1 &&
          !(await shouldDeferShortToLong({ services: this.services, id, key: summaryId,
            provider: p.provider, limit: limit.tokens, signal, timezone: zone, rows: history, policy, revision: p.revision }))) {
        const probe = tail(recent, capacity("摘".repeat(200)), 1);
        const overflow = short.remaining.slice(0, probe.omitted);
        shortAttempted = await compressShort({ services: this.services, id, key: shortKey,
          provider: p.provider, limit: limit.tokens, signal, timezone: zone,
          rows: shortRows, overflow, checkpoint: short.checkpoint });
        short = await shortContext(engine, id, shortKey, shortRows);
        shortSummary = short.text;
        recent = short.remaining.map(historyEntry);
        recentTokens = tail(recent, Infinity).tokens;
      }
      let memoryNotice: string | undefined;
      if (!legacy && diaryEnabled && engine) {
        if (!limit.tokens) memoryNotice = "模型未提供上下文容量，请在模型服务中填写上限；本轮未自动压缩。";
        else if (estimateTokens(promptText(assembled()) + JSON.stringify(toolList)) + reserve >= limit.tokens * policy.compression_trigger_percent! / 100) {
          const inputTokens = estimateTokens(promptText(assembled()) + JSON.stringify(toolList));
          const target = limit.tokens * policy.compression_target_percent! / 100 - reserve;
          // Output is a request ceiling, not a forced diary length or a source truncation limit.
          const outputTokens = Math.max(256, Math.min(8192, Math.floor(requestBudget * 0.1)));
          const cost = (rows: any[]) => estimateTokens(JSON.stringify(renderHistory(rows.map(historyEntry), zone, historyReference)));
          const desired = diaryPrefix(diary.remaining, inputTokens - target + outputTokens, cost);
          const selected = fittingDiaryPrefix(desired, rows => diaryRequestPlan({ rows, scope, timezone: zone,
            outputTokens }).reserved <= limit.tokens!);
          if (diary.paused) memoryNotice = "日记整理已暂停：" + diary.paused.reason;
          else if (estimateTokens(promptText(assembled([])) + JSON.stringify(toolList)) >= target)
            memoryNotice = "已有日记和固定内容已接近压后目标；不会再次压缩旧日记，请提高目标比例或封存后新建会话。";
          else if (!selected.length) memoryNotice = "没有可在模型容量内归档的完整旧对话；请更换更大容量模型或封存后新建会话。";
          else {
            const result = await writeDiary({ services: this.services, id, scope, rows: selected,
              provider: p.provider, limit: limit.tokens, outputTokens, signal, timezone: zone });
            memoryNotice = result.reason;
            diary = await diaryContext(engine, id, scope, shortRows);
            recent = diary.remaining.map(historyEntry);
            if (result.status === "written" && estimateTokens(promptText(assembled()) + JSON.stringify(toolList)) > target)
              memoryNotice = "日记已保存；为保留信息，本次尚未降到目标占用，不会立即追加压缩请求。";
            await execution?.write("memory_diary", { status: result.status, sources: selected.length, reason: result.reason });
          }
        }
      }
      if (legacy) {
        // Compatibility only: new full/diary modes never silently trim stored dialogue.
        while (overBudget() && snippets.length) snippets.pop();
        const fitted = tail(recent, capacity());
        recent = fitted.rows;
        recentTokens = fitted.tokens;
        if (overBudget()) summary = "";
        while (overBudget() && facts.length) facts.shift();
        if (overBudget()) shortSummary = "";
      }
      if (!legacy && estimateTokens(promptText(assembled()) + JSON.stringify(toolList)) > requestBudget)
        throw Error((memoryNotice ? memoryNotice + " " : "") + "当前上下文已达到模型容量，原文已保留。请在使用配置中选择新会话、调整模型容量或启用日记压缩；不会自动删减历史或切换会话。");
      const frame = assemble();
      const messages: any[] = frame.messages;
      if (route?.messageId) attachPictures(messages[messages.length - 1], route.messageId, route.images);
      if (diagnostics?.enabled) diagnostics.event("context.change", { operation: "assemble", source: "session",
        description: "人格、事实、有效日记、召回与历史经当前策略组装；实际发送内容以 request.start.body 为准",
        after: { materials: materials(), history: recent, input: text, transient,
          history_scope: policy.history_scope, context_limit: limit.tokens, request_budget: Number.isFinite(requestBudget) ? requestBudget : null } });
      let final = "";
      let originalProtocolReply: string | undefined;
      let literalExample = requestsProtocolExample(text);
      const offeredNames = new Set<string>(toolList.map((item: any) => item.function.name));
      let measured: any = null;
      let memoryWriteRejected = false;
      const executedToolIds = new Set<string>();
      const mediaSignals: AbortSignal[] = [];
      let mediaImages = 0, mediaBytes = 0;
      const memoryRevision = engine
        ? await engine.contextRevision(id)
        : undefined;
      // A real person's additions remain history even after transient tools.
      const inputRow = (message: TurnMessage) => ({ type: "message", ...source, ...context,
        origin: { ...source.origin, action: "接收消息" }, session: id, role: "user",
        ...(message.senderProfile ? { senderProfile: message.senderProfile } : {}),
        text: message.images?.length && !message.text.trim() ? `[图片 ${message.images.length} 张]` : message.text,
        external_message_id: message.messageId,
        ts: message.receivedAt, timezone: message.timezone });
      // 补充在接收时就落盘：模型报错或取消也不能把它弄丢。
      input?.setPersister(async (message) => { await memory.appendEvent(inputRow(message)); });
      const consumeInput = async () => {
        if (!input) return;
        for (const message of await input.take()) {
          signal.throwIfAborted();
          literalExample ||= requestsProtocolExample(message.text);
          const row = inputRow(message);
          // 接收时就落过盘的，这里不再写一遍；排队中的轮次还没挂 persister，由这里补
          if (!input.persisted(message.messageId)) await memory.appendEvent(row);
          const addition: ChatMessage = { role: "user", content: "【本轮用户补充；消息时间 " + messageTime(row, zone) +
            "；来源 " + JSON.stringify(source.origin) + "】\n" + speakerText(speakerOf(row), row.text) };
          diagnostics?.event("context.change", { operation: "append", source: "user_input", after: { ...addition } });
          attachPictures(addition, message.messageId, message.images);
          messages.push(addition);
          await execution?.write("input_appended", { message_id: message.messageId,
            received_at: message.receivedAt, timezone: message.timezone });
        }
      };
      // Completion is the model's decision; cancellation, permissions and context capacity still apply.
      for (let round = 0; ; round++) {
        turn.round = round + 1;
        const activeTools = memoryWriteRejected ? [] : toolList;
        while (input?.hasPending()) await consumeInput();
        signal.throwIfAborted();
        const requestSignal = mediaSignals.length ? AbortSignal.any([signal, ...mediaSignals]) : signal;
        requestSignal.throwIfAborted();
        if (describePictures) await prepareDescriptions(requestSignal);
        let requestTime = timing();
        frame.refreshTime(requestTime);
        if (
          estimateTokens(promptText(messages) + JSON.stringify(activeTools)) >
          requestBudget
        ) {
          await execution?.write("blocked", { reason: "context_capacity_exceeded", round: turn.round, request_budget: requestBudget });
          throw Error(
            "本轮内容或工具结果超出模型上下文预算，请减少输入或切换更大上下文模型",
          );
        }
        const modelStarted = Date.now();
        await execution?.write("model_start", { round: turn.round });
        // Archival writes can yield to incoming messages; include those before this request.
        if (input?.hasPending()) {
          do {
            await consumeInput();
            if (describePictures) await prepareDescriptions(requestSignal);
          } while (input.hasPending());
          requestSignal.throwIfAborted();
          requestTime = timing();
          frame.refreshTime(requestTime);
          if (estimateTokens(promptText(messages) + JSON.stringify(activeTools)) > requestBudget) {
            await execution?.write("blocked", { reason: "context_capacity_exceeded", round: turn.round, request_budget: requestBudget });
            throw Error("本轮内容或工具结果超出模型上下文预算，请减少输入或切换更大上下文模型");
          }
        }
        diagnostics?.event("context.change", { operation: "refresh", source: "clock", after: requestTime, round: turn.round });
        const stream = activeTools.length && !literalExample ? new ToolProtocolStream(onChunk) : undefined;
        let reply;
        try {
          reply = await llm.chat({
            provider: p.provider, messages, tools: activeTools,
            onChunk: channelPictures.length ? undefined : stream?.push ?? onChunk, signal: requestSignal,
            ...(channelPictures.length && { privateChannelImages: true }),
          }, this.services.toolOrder);
        } catch (error) {
          requestSignal.throwIfAborted();
          // Retry only this rejected model request. Earlier tool calls and their results stay in the frame.
          if (!describePictures && channelPictures.length && !mediaImages && route?.describeImages && isUnsupportedChannelImage(error)) {
            describePictures = true;
            await execution?.write("channel_image_fallback", { round: turn.round, messages: channelPictures.length });
            continue;
          }
          if (!requestSignal.aborted) stream?.interrupted();
          if (channelPictures.length && echoesPictures(error instanceof Error ? error.message : String(error)))
            throw Error("模型返回了原始图片数据，已停止本轮");
          throw error;
        }
        if (channelPictures.length) {
          if (echoesPictures(JSON.stringify(reply))) throw Error("模型返回了原始图片数据，已停止本轮");
          if (describePictures && reply.toolCalls.length) {
            const batch = new Set<string>();
            for (const call of reply.toolCalls) {
              if (executedToolIds.has(call.id) || batch.has(call.id))
                throw Error("模型重复返回已处理的工具调用 ID，本轮已停止；请核对先前的工具回执");
              batch.add(call.id);
            }
          }
          if (reply.text) (stream?.push ?? onChunk)(reply.text);
        }
        // Structured calls are authoritative, even when the provider also
        // supplied literal markup in content. Never construct calls from text.
        if (reply.toolCalls.length) stream?.flushUnclassified();
        await execution?.write("model_result", { round: turn.round, elapsed_ms: Date.now() - modelStarted,
          usage: reply.usage, tool_calls: reply.toolCalls.length, final_reply: !reply.toolCalls.length });
        measured = requestUsage(reply.usage, p.provider, limit.tokens);
        if (engine) await engine.usage(id, "chat", reply.usage);
        requestSignal.throwIfAborted();
        if (!reply.toolCalls.length) {
          // Seal synchronously after the last await. Unsent candidates never enter history.
          if (input && !input.tryFinish()) {
            stream?.flushUnclassified();
            // 这段回复不会进存档，界面上也得撤掉，否则刷新前后不一致
            input.notifyReset();
            continue;
          }
          final = reply.text;
          if (typeof final !== "string" || !final.trim())
            throw new EmptyModelResponseError(reply.finish_reason,
              typeof reply.reasoning_content === "string" && !!reply.reasoning_content.trim());
          if (stream) {
            final = stream.finish(reply.text, offeredNames);
            if (final !== reply.text) {
              if (!transient && !turn.transient) originalProtocolReply = reply.text;
              logger.warn("模型在正文中返回了工具调用标记", { session: id, round: turn.round });
            }
          }
          break;
        }
        if (historyReference && typeof reply.reasoning_content !== "string")
          throw Error("思考模式工具响应缺少 reasoning_content，未执行本次工具调用");
        messages.push({
          role: "assistant",
          content: reply.text || null,
          ...(typeof reply.reasoning_content === "string" ? { reasoning_content: reply.reasoning_content } : {}),
          tool_calls: reply.toolCalls.map((c: any) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.arguments },
          })),
        });
        diagnostics?.event("context.change", { operation: "append", source: "model_tool_calls", after: messages.at(-1) });
        // Protect the entire batch before any call can log parameters or fail.
        if (reply.toolCalls.some((call: any) => tools.entries?.get(call.name)?.transientResult)) turn.transient = true;
        const attachments = [];
        let superseded = false;
        for (const call of reply.toolCalls) {
          const toolSignal = mediaSignals.length ? AbortSignal.any([signal, ...mediaSignals]) : signal;
          toolSignal.throwIfAborted();
          const toolOrigin = tools.entries?.get(call.name)?.origin;
          let result;
          superseded ||= input?.hasPending() ?? false;
          if (superseded) {
            result = { ok: false, executed: false, reason: "user_input_appended",
              result: "未执行：用户补充了消息，请结合补充内容重新判断是否仍需调用此工具。" };
            diagnostics?.event("tool.end", { tool_call_id: call.id, name: call.name, arguments: call.arguments,
              status: "skipped", result });
            await execution?.write("tool_skipped", { round: turn.round, tool_call_id: call.id,
              tool: turn.transient && !toolOrigin ? "[未注册工具]" : call.name, reason: "user_input_appended" });
          } else try {
            if (route?.describeImages) executedToolIds.add(call.id);
            const runTool = () => tools.call(
              call.name,
              JSON.parse(call.arguments),
              mediaSignals.length ? { ...session, signal: toolSignal } : session,
              call.id,
              turn,
            );
            result = await (channelPictures.length ? withPrivateChannelImages(runTool, channelPictures.flatMap(row => row.images)) : runTool());
          } catch (error: any) {
            if (channelPictures.length && echoesPictures(String(error?.message ?? error)))
              throw Error("工具返回了原始图片数据，已停止本轮");
            result = { ok: false, result: turn.transient ? "临时调用参数或执行失败；原始错误不保存" : error.message };
            diagnostics?.event("tool.end", { tool_call_id: call.id, name: call.name, arguments: call.arguments,
              status: "rejected", error });
            await execution?.write("tool_rejected", { round: turn.round,
              tool: turn.transient && !toolOrigin ? "[未注册工具]" : call.name, error: result.result,
              ...(turn.transient ? {} : { arguments: call.arguments }) });
          }
          if (!superseded && !result.ok && ["remember_fact", "edit_facts"].includes(call.name))
            memoryWriteRejected = true;
          const media = tools.multimodal?.(result);
          const storedResult = tools.stored?.(result) ?? (turn.transient ? { ok: result.ok, result: null, transient: true } : result);
          if (channelPictures.length && (echoesPictures(JSON.stringify(storedResult)) ||
            (!media && storedResult !== result && echoesPictures(JSON.stringify(result)))))
            throw Error("工具返回了原始图片数据，已停止本轮");
          await memory.appendEvent({
            type: "tool",
            ...source,
            origin: toolOrigin ?? { action: "工具调用" },
            session: id,
            name: turn.transient && !toolOrigin ? "[未注册工具]" : call.name,
            ...(turn.transient ? {} : { args: call.arguments }),
            ...storedResult,
            ...context,
          });
          if (media) {
            mediaSignals.push(media.signal);
            // Preserve actual receipts above, but never continue with stopped/expired media.
            media.signal.throwIfAborted();
            for (const part of media.content) if (part.type === "image") {
              mediaImages++; mediaBytes += part.data.byteLength;
            }
            if (mediaImages > TOOL_CONTENT_LIMITS.images || mediaBytes > TOOL_CONTENT_LIMITS.totalBytes)
              throw Error("本轮工具图片累计超过16张或16MiB，请减少查看的图片或视频帧");
            attachments.push(toolContentMessage(media.content, call.id, call.name, toolOrigin));
          }
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(media ? { ok: true, result: "临时内容块见本批工具结果后的附件；仅供当前轮读取" } : result),
          });
          diagnostics?.event("context.change", { operation: "append", source: "tool_result", after: messages.at(-1) });
        }
        messages.push(...attachments);
        if (attachments.length && diagnostics?.enabled) {
          // The diagnostic sink saves data URLs as files, including copies returned by ordinary tools.
          const images = channelPictures.flatMap(row => row.images);
          const after = images.length ? attachments.map(message => ({ ...message, content: message.content.map(part => {
            const value = part.type === "image_url" ? part.image_url.url : part.text;
            return containsAttachedImageBytes(value, images) ? { type: "text", text: "[渠道原图已省略]" } : part;
          }) })) : attachments;
          diagnostics.event("context.change", { operation: "append", source: "tool_attachments", after });
        }
      }
      if (!final) throw new EmptyModelResponseError(undefined);
      await memory.appendEvent({
        type: "message",
        ...source,
        origin: { ...source.origin, action: "生成回复" },
        session: id,
        role: "assistant",
        // User-facing conversation is primary history. Technical plugin runs retain their opt-in privacy.
        text: transient && turn.transient ? TRANSIENT_REPLY : final,
        ...(originalProtocolReply === undefined ? {} : { tool_protocol_original: originalProtocolReply }),
        ...(transient && turn.transient ? { transient: true } : {}),
        ...context,
        request_usage: measured,
        memory_revision: memoryRevision,
        ...(memoryNotice ? { memory_notice: memoryNotice } : {}),
      });
      if (legacy && engine && !shortAttempted) {
        const currentRows = (await engine.contextRows(id)).filter((row: any) => row.type === "message");
        await consolidateLong({ services: this.services, id, key: summaryId,
          provider: p.provider, limit: limit.tokens, signal, timezone: zone,
          rows: matchingHistory(currentRows, p.revision, policy.history_scope), policy, revision: p.revision });
      }
      executionStatus = "completed";
      return final;
    } catch (error: any) {
      const reportedError = channelPictures.length || route?.images?.length
        ? channelFailureReason(error, logger.secrets) : error;
      diagnostics?.event("execution.error", { error: reportedError });
      await execution?.write("error", { round: turn.round,
        error: turn.transient ? "含临时资料的执行失败，原始错误不落盘；请核对前序步骤和插件回执" : reportedError });
      throw error;
    } finally {
      this.identities.delete(id);
      input?.closeInput();
      diagnostics?.event("execution.end", { status: signal.aborted ? "cancelled" : executionStatus });
      await execution?.end(signal.aborted ? "cancelled" : executionStatus);
    }
    };
    return diagnostics?.enabled ? diagnostics.run({ execution_id: execution?.id ?? randomUUID(), session_id: id,
      purpose: "chat", relation_verified: true, ...(route?.origin?.plugin ? { plugin_id: route.origin.plugin } : {}) }, observed) : observed();
  }
}
