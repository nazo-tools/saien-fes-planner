// 予定の計算。DOM には触れない。
//
// 予定（plan）は次の2種類の並び。
//   公演の回  { showId, day, start, end, bought? }
//   自分の予定 { label, day, start, end }       … ごはん・休憩・予約不要コンテンツなど
//
// 自動で埋めることはしない。選んだ回が他とぶつかるか、前後がどれだけあくかを出すだけ。

/** "HH:MM" を 0時からの分に変換する。 */
export function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  if (!m) throw new Error(`時刻の形式が不正です: ${hhmm}`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) throw new Error(`時刻の範囲が不正です: ${hhmm}`);
  return h * 60 + mi;
}

/** 分を "H:MM" に戻す。 */
export function toHHMM(min) {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}

const span = (x) => [toMinutes(x.start), toMinutes(x.end)];
const sameSlot = (x, y) => x.showId === y.showId && x.day === y.day && x.start === y.start;
const byStart = (x, y) => toMinutes(x.start) - toMinutes(y.start) || toMinutes(x.end) - toMinutes(y.end);

/**
 * ある回が、今の予定に対してどういう状態か。
 *   chosen   … もう選んでいる
 *   moved    … 同じ公演の別の回を選んでいる（選ぶと入れ替わる）
 *   conflict … 時間が重なる予定がある（with に相手）
 *   tight    … 重ならないが、前後のあきが移動時間より短い（gap に最小のあき）
 *   free     … 問題なく入る
 * 重なりは moved より優先して返す。入れ替えた先でぶつかるほうが困るので。
 */
export function slotStatus(slot, plan, bufferMin = 0) {
  if (plan.some((p) => p.showId != null && sameSlot(p, slot))) return { state: "chosen" };

  const [a, b] = span(slot);
  const others = plan.filter((p) => p.day === slot.day && !(slot.showId != null && p.showId === slot.showId));
  const hit = others.filter((p) => {
    const [pa, pb] = span(p);
    return pa < b && a < pb;
  });
  if (hit.length) return { state: "conflict", with: hit };

  let gap = Infinity;
  for (const p of others) {
    const [pa, pb] = span(p);
    gap = Math.min(gap, pb <= a ? a - pb : pa - b);
  }
  if (gap < bufferMin) return { state: "tight", gap };

  if (slot.showId != null && plan.some((p) => p.showId === slot.showId)) return { state: "moved" };
  return { state: "free" };
}

/**
 * 「今の予定に入るものだけ」で出す公演か。
 * もう予定に入れた公演（どの日でも）は出さない。探したいのは「あと何が入るか」なので。
 * まだの公演は、その日に問題なく入る回（free）が1つでもあれば出す。
 */
export function fitsPlan(show, day, plan, bufferMin = 0) {
  if (plan.some((p) => p.showId === show.id)) return false;
  return (show.slots[day] ?? []).some(
    (x) => slotStatus({ showId: show.id, day, start: x.start, end: x.end }, plan, bufferMin).state === "free",
  );
}

/**
 * 回ボタンの見た目の種類（kind = CSSのクラス）と2行目の言葉。
 * 色だけに頼らないよう、どの状態にも言葉を付ける。
 * outside … 空き時間で絞っていて、その空きに入らない回。選択中以外は状態より優先する。
 * special … 特別回の札（入る回のときだけ終了時刻の代わりに出す）
 */
export function slotFace(st, x, { outside = false, special = null } = {}) {
  if (st.state === "chosen") return { kind: "chosen", word: "予定中" };
  if (outside) return { kind: "outside", word: "時間外" };
  switch (st.state) {
    case "tight": return { kind: "tight", word: `あき${st.gap}分` };
    case "conflict": return { kind: "conflict", word: "別の予定" };
    case "moved": return { kind: "moved", word: "入れ替え" };
    default: return { kind: "free", word: special ?? `〜${x.end}` };
  }
}

/**
 * 回を予定に入れる。同じ公演の別の回と、時間が重なる予定は外す。
 * 外したものは removed で返す（画面で「〇〇を外しました」と出すため）。
 */
export function choose(plan, slot) {
  const kept = plan.find((p) => p.showId != null && sameSlot(p, slot));
  const [a, b] = span(slot);
  const removed = [];
  const next = [];
  for (const p of plan) {
    if (kept && p === kept) continue;
    const sameShow = slot.showId != null && p.showId === slot.showId;
    const [pa, pb] = span(p);
    const overlap = p.day === slot.day && pa < b && a < pb;
    if (sameShow || overlap) removed.push(p);
    else next.push(p);
  }
  next.push(kept ?? { ...slot });
  next.sort((x, y) => x.day.localeCompare(y.day) || byStart(x, y));
  return { plan: next, removed };
}

/** 予定から1件外す。 */
export function unchoose(plan, item) {
  return plan.filter(
    (p) =>
      !(p.day === item.day && p.start === item.start && p.end === item.end && p.showId === item.showId && p.label === item.label),
  );
}

/**
 * その日の空き時間。open〜close のうち、予定が入っていないところ。
 * a/b は分。edgeA/edgeB は「その端が日の始まり／終わりか」（移動時間を取らなくていい端）。
 */
export function gapsOf(plan, day, { open, close }) {
  const items = plan.filter((p) => p.day === day).map(span).sort((x, y) => x[0] - y[0]);
  const O = toMinutes(open);
  const C = toMinutes(close);
  const out = [];
  let cur = O;
  let edge = true;
  for (const [a, b] of items) {
    if (a > cur) out.push({ a: cur, b: a, edgeA: edge, edgeB: false });
    if (b > cur) {
      cur = b;
      edge = false;
    }
  }
  if (C > cur) out.push({ a: cur, b: C, edgeA: edge, edgeB: true });
  return out;
}

/** その回が、前後に移動時間を取ったうえで空きに収まるか。 */
export function fitsGap(slot, gap, bufferMin = 0) {
  const [a, b] = span(slot);
  const lo = gap.a + (gap.edgeA ? 0 : bufferMin);
  const hi = gap.b - (gap.edgeB ? 0 : bufferMin);
  return a >= lo && b <= hi;
}

/** その回の料金。特別枠（再入場チケットなど）は別料金。 */
export function priceOf(show, start) {
  return show.special?.[start]?.price ?? show.price;
}

/** 日ごと・全体の公演数、料金、謎解き時間、購入済みの数。 */
export function summarize(plan, shows) {
  const byId = new Map(shows.map((s) => [s.id, s]));
  const days = {};
  const total = { count: 0, price: 0, bought: 0, boughtPrice: 0 };
  for (const p of plan) {
    if (p.showId == null) continue;
    const show = byId.get(p.showId);
    if (!show) continue;
    const d = (days[p.day] ??= { count: 0, price: 0, minutes: 0, bought: 0, boughtPrice: 0 });
    const price = priceOf(show, p.start);
    const [a, b] = span(p);
    d.count++;
    d.price += price;
    d.minutes += b - a;
    total.count++;
    total.price += price;
    if (p.bought) {
      d.bought++;
      d.boughtPrice += price;
      total.bought++;
      total.boughtPrice += price;
    }
  }
  return { days, total };
}

/* ---------------- 当日 ---------------- */

/** 今が会期中なら { day, min }。端末のローカル時刻で見る。 */
export function festivalNow(date, fes) {
  if (date.getFullYear() !== fes.year) return null;
  const id = String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  if (!fes.days.some((d) => d.id === id)) return null;
  return { day: id, min: date.getHours() * 60 + date.getMinutes() };
}

/** 予定を「今」で切って、いま・次・それ以降に分ける。 */
export function nowNext(plan, now) {
  const today = plan
    .filter((f) => f.day === now.day)
    .map((f) => ({ ...f, a: toMinutes(f.start), b: toMinutes(f.end) }))
    .sort((x, y) => x.a - y.a);
  const t = now.min;
  const current = today.find((f) => f.a <= t && t < f.b) ?? null;
  const upcoming = today.filter((f) => f.a > t);
  const next = upcoming[0] ?? null;
  return {
    current,
    next,
    later: upcoming.slice(1),
    untilNext: next ? next.a - t : null,
    leftOfCurrent: current ? current.b - t : null,
  };
}

/** コピー用のテキスト。 */
export function planToText(plan, shows, days) {
  const byId = new Map(shows.map((s) => [s.id, s]));
  const blocks = [];
  for (const d of days) {
    const items = plan.filter((p) => p.day === d.id).sort(byStart);
    if (!items.length) continue;
    const lines = [`■ ${d.label}(${d.weekday})`];
    for (const p of items) {
      const show = p.showId != null ? byId.get(p.showId) : null;
      const what = show ? `${show.title}（${show.floor} ${show.room}）` : p.label;
      lines.push(`${p.start}-${p.end} ${what}`);
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}
