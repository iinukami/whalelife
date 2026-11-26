/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { ChannelImage, SenderProfile } from "./plugin-api.ts";
import { channelImageFingerprint, CHANNEL_IMAGE_LIMITS } from "./channel-images.ts";

export type TurnMessage = { messageId: string; text: string; images?: ChannelImage[]; senderProfile?: SenderProfile; receivedAt: string; timezone: string };
export type TurnAppendResult = { status: "accepted" | "duplicate" | "closed" | "full" | "cancelled"; messageId: string };
type Entry = { message: TurnMessage; imageFingerprint?: string; saved: boolean; commit?: Promise<void> };

/** One process-local turn. Persisted receipts are evidence, never a replay queue. */
export class TurnInput {
  private seen = new Map<string, Entry>();
  private pending: Entry[] = [];
  private commits = new Set<Promise<void>>();
  private characters = 0;
  private imageCount = 0;
  private imageBytes = 0;
  private closed = false;
  private readonly historyFailure = new AbortController();
  readonly signal: AbortSignal;
  private persister?: (message: TurnMessage) => Promise<void>;
  // 哪些补充在接收时就已经落盘了，消费方别再写一遍
  private persistedIds = new Set<string>();
  /** 落库结果不确定时置位：图片一律保留，等人工清理。 */
  private uploadsGuarded = false;
  private resetHandler?: () => void;
  /** 这一轮主消息的 id。web 那头要在失败时区分「已落库」和「根本没开始」。 */
  readonly messageId: string;

  /** 谁来把补充落盘。会话在开跑时就该挂上，别等 consumeInput 才写。 */
  setPersister(persist: (message: TurnMessage) => Promise<void>) {
    this.persister = persist;
  }

  /** 这条补充是不是已经由 persister 落过盘。排队中的轮次还没有 persister，答案是否。 */
  persisted(messageId: string) {
    return this.persistedIds.has(messageId);
  }

  /** 主消息已经落库。落库之后历史就指着图了，外面不能再去擦。 */
  markPersisted(messageId: string) {
    this.persistedIds.add(messageId);
  }
  /**
   * 落库结果不明（比如 JSONL 追加成功、随后的元数据写入失败）。
   * 这时历史里可能已经有那行 [[img:]]，宁可留下没人引用的孤儿图，也不能让它指向不存在的文件。
   */
  protectUploads() {
    this.uploadsGuarded = true;
  }

  /** 图片被标记为「不许擦」过。 */
  get uploadsKept() {
    return this.uploadsGuarded;
  }

  /** A Web turn may be registered before its session has installed the history writer. */
  get waitingForSession() {
    return !this.persister && !this.closed;
  }

  /** 被丢弃的那段回复要从界面上撤掉，否则和存档对不上。 */
  setResetHandler(handler: () => void) {
    this.resetHandler = handler;
  }

  notifyReset() {
    this.resetHandler?.();
  }

  constructor(initial: TurnMessage, signal: AbortSignal) {
    this.validate(initial);
    this.signal = AbortSignal.any([signal, this.historyFailure.signal]);
    this.messageId = initial.messageId;
    // The initial pictures are already owned by the channel route; keep only their identity here.
    const { images, ...fields } = initial;
    const message = structuredClone(fields);
    this.imageCount = images?.length ?? 0;
    this.imageBytes = images?.reduce((sum, image) => sum + image.data.byteLength, 0) ?? 0;
    this.seen.set(message.messageId, { message, imageFingerprint: images?.length ? channelImageFingerprint(images) : undefined, saved: true });
    this.characters = message.text.length;
  }

  private validate(message: TurnMessage) {
    if (!message || typeof message.messageId !== "string" || !message.messageId.trim())
      throw Error("消息ID不能为空");
    if (typeof message.text !== "string" || (!message.text.trim() && !message.images?.length) || message.text.length > 16000)
      throw Error("请输入 1–16000 字");
  }

  async append(message: TurnMessage, persist?: () => Promise<void>): Promise<TurnAppendResult> {
    this.validate(message);
    const messageId = message.messageId;
    if (this.signal.aborted) return { status: "cancelled", messageId };
    const imageCount = message.images?.length ?? 0;
    const imageFingerprint = imageCount ? channelImageFingerprint(message.images!) : undefined;
    const previous = this.seen.get(messageId);
    if (previous) {
      if (previous.message.text !== message.text || previous.imageFingerprint !== imageFingerprint) throw Error("同一消息ID对应了不同正文或图片");
      // A duplicate cannot acknowledge an original write that later fails.
      await previous.commit;
      return { status: "duplicate", messageId };
    }
    if (this.closed) return { status: "closed", messageId };
    const imageBytes = message.images?.reduce((sum, image) => sum + image.data.byteLength, 0) ?? 0;
    if (this.seen.size >= 128 || this.characters + message.text.length > 128000 ||
      this.imageCount + imageCount > CHANNEL_IMAGE_LIMITS.images || this.imageBytes + imageBytes > CHANNEL_IMAGE_LIMITS.totalBytes)
      return { status: "full", messageId };

    // Reserve synchronously, before the persistence callback can yield or fail.
    const snapshot = structuredClone(message);
    const entry: Entry = { message: snapshot, imageFingerprint, saved: false };
    this.seen.set(messageId, entry);
    this.pending.push(entry);
    this.characters += snapshot.text.length;
    this.imageCount += imageCount;
    this.imageBytes += imageBytes;
    const write = async () => {
      // A channel acknowledges its own durable receipt. Its history row is written
      // when the session consumes the message, inside the channel's generation task.
      if (persist) {
        await persist();
      } else if (this.persister) {
        try { await this.persister(snapshot); }
        catch (error) { this.historyFailure.abort(error); throw error; }
        this.persistedIds.add(snapshot.messageId);
      }
    };
    const commit = Promise.resolve().then(write).then(() => { entry.saved = true; }).catch(error => {
      this.seen.delete(messageId);
      this.pending = this.pending.filter(item => item !== entry);
      this.characters -= snapshot.text.length;
      this.imageCount -= imageCount;
      this.imageBytes -= imageBytes;
      throw error;
    }).finally(() => { this.commits.delete(commit); });
    entry.commit = commit;
    this.commits.add(commit);
    await commit;
    return { status: "accepted", messageId };
  }

  async take(): Promise<TurnMessage[]> {
    this.signal.throwIfAborted();
    while (this.commits.size) {
      // Cancellation must release a consumer even if a storage operation is stuck.
      await new Promise<void>((resolve, reject) => {
        const abort = () => { this.signal.removeEventListener("abort", abort); reject(this.signal.reason); };
        this.signal.addEventListener("abort", abort, { once: true });
        Promise.allSettled([...this.commits]).then(() => {
          this.signal.removeEventListener("abort", abort);
          resolve();
        });
        if (this.signal.aborted) abort();
      });
      this.signal.throwIfAborted();
    }
    const rows = this.pending.filter(entry => entry.saved).map(({ message }) => {
      const images = message.images;
      delete message.images;
      const row = structuredClone(message);
      if (images) row.images = images;
      return row;
    });
    this.pending = [];
    return rows;
  }

  hasPending() { return this.pending.length > 0 || this.commits.size > 0; }

  /** No await between this check and the caller committing its final reply. */
  tryFinish() {
    if (this.hasPending()) return false;
    this.closed = true;
    return true;
  }

  closeInput() { this.closed = true; }

  /** A caller may keep its ChannelTurn handle after cancellation or completion. */
  releaseImages() {
    for (const entry of this.pending) delete entry.message.images;
  }
}
