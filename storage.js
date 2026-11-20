// 立てた予定の保存と、URLでの共有。
//
// 保存したデータは、あとで公演データを直したときに古くなりうる。
// 読み戻すときは今のデータと突き合わせ、実在しない公演・回は黙って捨てる。

import { toMinutes, toHHMM } from "./planner.js";

export const STORAGE_KEY = "saien-fes-planner/v1";

const isHHMM = (v) => typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v);
const okSpan = (x) => isHHMM(x.start) && isHHMM(x.end) && toMinutes(x.start) < toMinutes(x.end);

export function encodeState(s) {
  return { v: 1, plan: s.plan, favorites: [...s.favorites], buffer: s.buffer, day: s.day };
}

/** 壊れていても落とさず、通ったものだけ返す。形が違えば null。 */
export function decodeState(raw, { shows, days }) {
  if (!raw || typeof raw !== "object" || raw.v !== 1) return null;
  const byId = new Map(shows.map((s) => [s.id, s]));
  const plan = [];
  const seen = new Set();
  for (const f of Array.isArray(raw.plan) ? raw.plan : []) {
    if (!f || !days.includes(f.day)) continue;
    if (f.showId != null) {
      const show = byId.get(f.showId);
      const slot = show?.slots[f.day]?.find((x) => x.start === f.start && x.end === f.end);
      if (!slot || seen.has(f.showId)) continue;
      seen.add(f.showId);
      plan.push({ showId: f.showId, day: f.day, start: f.start, end: f.end, ...(f.bought ? { bought: true } : {}) });
    } else if (okSpan(f)) {
      plan.push({ day: f.day, start: f.start, end: f.end, label: String(f.label ?? "予定").slice(0, 30) });
    }
  }
  return {
    plan,
    favorites: (Array.isArray(raw.favorites) ? raw.favorites : []).filter((id) => byId.has(id)),
    buffer: [0, 5, 10, 15, 20].includes(raw.buffer) ? raw.buffer : 10,
    day: days.includes(raw.day) ? raw.day : days[0],
  };
}

export function loadState(store, ctx) {
  try {
    return decodeState(JSON.parse(store.getItem(STORAGE_KEY)), ctx);
  } catch {
    return null;
  }
}

export function saveState(store, s) {
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(encodeState(s)));
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 共有 ----------------
 * 予定をURLに畳む。区切り文字なしで桁数を決め打ちにする。
 *   公演の回   公演番号(2) 日(1) 開始(2)                 → 5文字
 *   自分の予定 "-" 日(1) 開始(2) 終了(2) 名札(1)         → 7文字
 * 番号・時刻は36進。時刻は0時からの分（36進2桁で21:35まで表せる）。
 * 購入済みの印は渡さない（自分の買い物の記録なので）。
 * 回は「何時からか」で持つ。データを直したとき別の回にすり替わるより、落ちるほうがいい。
 */
const VERSION = "1";
const b36 = (n) => n.toString(36).padStart(2, "0");
const un36 = (s) => (/^[0-9a-z]{2}$/.test(s) ? parseInt(s, 36) : NaN);

export function encodePlan(plan, { shows, days, labels }) {
  const index = new Map(shows.map((s, i) => [s.id, i]));
  const parts = [];
  for (const f of plan) {
    const d = days.indexOf(f.day);
    if (d < 0) continue;
    if (f.showId != null) {
      const i = index.get(f.showId);
      if (i == null) continue;
      parts.push(b36(i) + d + b36(toMinutes(f.start)));
    } else {
      const li = labels.indexOf(f.label);
      parts.push("-" + d + b36(toMinutes(f.start)) + b36(toMinutes(f.end)) + (li < 0 ? labels.length - 1 : li));
    }
  }
  return parts.length ? VERSION + parts.join("") : "";
}

export function decodePlan(str, { shows, days, labels }) {
  if (typeof str !== "string" || str[0] !== VERSION) return [];
  const out = [];
  const seen = new Set();
  let i = 1;
  while (i < str.length) {
    if (str[i] === "-") {
      const day = days[str[i + 1]];
      const a = un36(str.slice(i + 2, i + 4));
      const b = un36(str.slice(i + 4, i + 6));
      const label = labels[str[i + 6]];
      i += 7;
      if (!day || !label || !(a >= 0) || !(b > a)) continue;
      out.push({ day, start: toHHMM(a), end: toHHMM(b), label });
    } else {
      const show = shows[un36(str.slice(i, i + 2))];
      const day = days[str[i + 2]];
      const at = un36(str.slice(i + 3, i + 5));
      i += 5;
      if (!show || !day || seen.has(show.id)) continue;
      const sl = show.slots[day]?.find((x) => toMinutes(x.start) === at);
      if (!sl) continue;
      seen.add(show.id);
      out.push({ showId: show.id, day, start: sl.start, end: sl.end });
    }
  }
  return out;
}
