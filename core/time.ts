/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
export const DEFAULT_TIMEZONE = "Asia/Shanghai";
const formatters = new Map<string, Intl.DateTimeFormat>();
const zones = new Map<string, string>();
export function timezone(value: unknown = DEFAULT_TIMEZONE): string {
  if (typeof value !== "string" || !value.trim() || value.length > 100) throw Error("时区无效，请使用 Asia/Shanghai 等时区名称");
  const name = value.trim();
  if (zones.has(name)) return zones.get(name)!;
  try {
    const canonical = new Intl.DateTimeFormat("en", { timeZone: name }).resolvedOptions().timeZone;
    if (zones.size >= 32) zones.clear();
    zones.set(name, canonical);
    return canonical;
  }
  catch { throw Error("时区无效，请使用 Asia/Shanghai 等时区名称"); }
}
/** Undated or timezone-free legacy strings must not acquire an invented local time. */
export function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const n = Date.parse(value), day = Date.parse(value.slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(n) || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10) || Number(value.slice(11, 13)) > 23) return null;
  return n;
}
export function occurrence(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const n = timestamp(value);
  if (n === null) throw Error("发生时间必须是带时区的有效 ISO 日期时间");
  return new Date(n).toISOString();
}
export function clock(zone = DEFAULT_TIMEZONE, now = Date.now()) {
  zone = timezone(zone);
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("zh-CN", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "long", timeZoneName: "shortOffset" });
    if (formatters.size >= 16) formatters.clear();
    formatters.set(zone, formatter);
  }
  const p = Object.fromEntries(formatter.formatToParts(now).map(x => [x.type, x.value]));
  return { timezone: zone, now: new Date(now).toISOString(), local: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`,
    weekday: p.weekday, offset: p.timeZoneName.replace("GMT", "UTC") };
}
export function timeLabel(value: unknown, zone = DEFAULT_TIMEZONE) {
  const n = timestamp(value);
  if (n === null) return "时间未记录或无效";
  const t = clock(zone, n);
  return `${t.local} ${t.offset}`;
}
export function messageTime(row: any, zone: string) {
  if (row?.timezone !== undefined) {
    try { return timeLabel(row.ts, timezone(row.timezone)); }
    catch { return "原时区无效，时间不能确定"; }
  }
  return timeLabel(row?.ts, zone) + "（原时区未记录）";
}
export function timeContext(zone: string, received: string, history: any[], now = Date.now()) {
  const t = clock(zone, now), last = history.findLast(row => row.type === "message" && ["user", "assistant"].includes(row.role));
  const then = timestamp(last?.ts), elapsed = then === null ? null : now - then;
  const gap = elapsed === null ? "未知" : elapsed < 0 ? "时间记录异常" : elapsed < 60000 ? "不足1分钟" :
    elapsed < 3600000 ? `约${Math.floor(elapsed / 60000)}分钟` : elapsed < 86400000 ? `约${Math.floor(elapsed / 3600000)}小时` : `约${Math.floor(elapsed / 86400000)}天`;
  return `【主干时间】当前 ${t.local} ${t.weekday}（${t.timezone}，${t.offset}）；本条消息 ${timeLabel(received, zone)}；距本会话上次交流${gap}。`;
}
export function collectTimes(previous: any, rows: any[]) {
  const range = previous?.time_range;
  const values = [range?.start, range?.end, ...rows.map(row => row?.ts)].map(timestamp).filter((n): n is number => n !== null);
  const incomplete = range?.incomplete || (previous?.text && !range) || rows.some(row => timestamp(row?.ts) === null);
  return { time_range: { ...(values.length ? { start: new Date(Math.min(...values)).toISOString(), end: new Date(Math.max(...values)).toISOString() } : {}),
    ...(incomplete ? { incomplete: true } : {}) } };
}
export function summaryTime(value: any, zone: string) {
  const range = value?.time_range;
  return range?.start && range?.end ? `资料记录时间：${timeLabel(range.start, zone)} 至 ${timeLabel(range.end, zone)}${range.incomplete ? "（部分时间缺失）" : ""}` : "资料时间未记录";
}
export const TIME_GUIDANCE = "记录时间不等于事情发生时间；历史消息中的今天、昨天、明天、刚才以对应消息日期和原时区为依据，后来的回顾不改变原事件日期。引用旧事前核对原消息日期；内容相似不代表事情最近又发生，旧活动、计划或临时状态也不默认延续到今天，以最新发言为准。摘要保留关键事件的明确日期，不把旧相对日期套到当前日期；时间或原时区缺失、异常或有歧义时保留不确定性，不猜日期。日常聊天沿用当前人格自然表达，无需主动报日期或解释核对过程；只有用户询问或确实影响回答时才说明。";
