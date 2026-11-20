// ★を付けた公演を、どの回に入れるかの組み合わせを考える。DOM には触れない。
//
// すでに入れた予定（fixed）は動かさない。その残りの時間に、★の公演を1回ずつ割り振る。
// 移動にとる時間（buffer）より短い間隔は作らない。
//
// 並べ方の良さ:
//   1. 入る公演の数が多いほど良い
//   2. 同じ数なら、待ち時間（その日の最初の予定から最後の予定までのあき）が短いほど良い
//   3. それも同じなら、早く終わるほど良い
//
// 計算はビットマスクDP。★の公演1つをビット1本に見立てる。
//   ・日ごとに「この組み合わせを全部その日に入れたら、最も早く何時に終われるか」を
//     小さい組み合わせから順に埋める（入らない組み合わせは INF のまま）
//   ・2日なら「1日目に入る組 A」と「残りから2日目に入る最大の組 B」を合わせて最大数を出す
//   ・待ち時間は、決まった組ごとに「最初に行く回」を変えて同じ表を作り、いちばん短いものを選ぶ
// ★が MAX_WANT を超えると表が大きくなりすぎるので、それ以上は組まない（tooMany）。

import { toMinutes } from "./planner.js";

export const MAX_WANT = 20;
const DEFAULTS = { limit: 3, budgetMs: 600 };
const INF = 32767;
const T = 1500; // 分の表の長さ（0:00〜25:00）

const minutesOf = (x) => [toMinutes(x.start), toMinutes(x.end)];
const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** a と b（同じ日）が、移動時間を取ったうえで両立するか。 */
function compatible(a, b, buffer) {
  if (a.day !== b.day) return true;
  return a.b + buffer <= b.a || b.b + buffer <= a.a;
}

function prepare(shows, wantIds, fixed, { days, buffer }) {
  const byId = new Map(shows.map((s) => [s.id, s]));
  const placed = new Set(fixed.filter((f) => f.showId != null).map((f) => f.showId));
  const want = [...new Set(wantIds)].filter((id) => byId.has(id) && !placed.has(id));
  const fixedHere = fixed
    .filter((f) => days.includes(f.day))
    .map((f) => {
      const [a, b] = minutesOf(f);
      return { ...f, a, b };
    });
  // 公演ごと・日ごとの、すでに入れた予定とぶつからない回
  const options = new Map();
  for (const id of want) {
    const perDay = {};
    for (const day of days) {
      perDay[day] = [];
      for (const x of byId.get(id).slots[day] ?? []) {
        const [a, b] = minutesOf(x);
        const c = { showId: id, day, start: x.start, end: x.end, a, b };
        if (fixedHere.every((f) => compatible(c, f, buffer))) perDay[day].push(c);
      }
    }
    options.set(id, perDay);
  }
  return { byId, want, fixedHere, options };
}

/** nextEnd[t] = 開始が t 分以降の回のうち、いちばん早い終了時刻。無ければ INF。 */
function nextEndTable(slots) {
  const ne = new Int16Array(T + 1).fill(INF);
  for (const c of slots) if (c.b < ne[c.a]) ne[c.a] = c.b;
  for (let t = T - 1; t >= 0; t--) if (ne[t + 1] < ne[t]) ne[t] = ne[t + 1];
  return ne;
}

/**
 * その日に、組み合わせ mask の公演を全部入れたときの最も早い終了時刻の表。
 * first を渡すと、その回を最初に行く回として固定する。
 */
function earliestEnd(tables, buffer, first) {
  const k = tables.length;
  const size = 1 << k;
  const E = new Int16Array(size).fill(INF);
  const via = new Int8Array(size).fill(-1);
  if (first) {
    E[1 << first.bit] = first.b;
    via[1 << first.bit] = first.bit;
  } else {
    E[0] = -buffer; // 最初の回は何時からでもいい
  }
  for (let m = 0; m < size; m++) {
    const e = E[m];
    if (e === INF) continue;
    const t = Math.max(0, e + buffer);
    if (t > T) continue;
    for (let j = 0; j < k; j++) {
      if (m & (1 << j)) continue;
      const ne = tables[j][t];
      const n = m | (1 << j);
      if (ne < E[n]) {
        E[n] = ne;
        via[n] = j;
      }
    }
  }
  return { E, via };
}

/** 予定の待ち時間（日ごとの、予定と予定のあいだのあきの合計）と、最後に終わる時刻の合計。 */
function score(picks, fixedHere) {
  const byDay = new Map();
  for (const x of [...fixedHere, ...picks]) {
    if (!byDay.has(x.day)) byDay.set(x.day, []);
    byDay.get(x.day).push(x);
  }
  let idle = 0;
  let lastEnd = 0;
  for (const [day, list] of byDay) {
    if (!picks.some((p) => p.day === day)) continue; // ★を入れていない日は比べる意味がない
    list.sort((p, q) => p.a - q.a);
    for (let i = 1; i < list.length; i++) idle += Math.max(0, list[i].a - list[i - 1].b);
    lastEnd += Math.max(...list.map((x) => x.b));
  }
  return { idle, lastEnd };
}

/**
 * ids の公演を全部 day に入れる並べ方のうち、待ち時間の短いものを最大 keep 個。
 * 最初に行く回を1つずつ固定して、そのたびに最も早く終わる並べ方を作る。
 */
function bestOrders(ids, day, options, fixedHere, buffer, keep) {
  if (!ids.length) return [{ picks: [], idle: 0, lastEnd: 0 }];
  const slots = ids.map((id) => options.get(id)[day]);
  const tables = slots.map(nextEndTable);
  const full = (1 << ids.length) - 1;
  const fixedDay = fixedHere.filter((f) => f.day === day);

  const firsts = ids.length <= 12 ? slots.flatMap((list, bit) => list.map((c) => ({ ...c, bit }))) : [null];
  const seen = new Set();
  const out = [];
  for (const first of firsts) {
    const { E, via } = earliestEnd(tables, buffer, first);
    if (E[full] === INF) continue;
    // 後ろからたどって、実際の回を決める
    const picks = [];
    let m = full;
    while (m) {
      const j = via[m];
      const prev = m ^ (1 << j);
      let c;
      if (first && prev === 0) c = first;
      else {
        const t = prev === 0 ? 0 : Math.max(0, E[prev] + buffer);
        c = slots[j].filter((x) => x.a >= t && x.b === E[m]).sort((p, q) => p.a - q.a)[0];
      }
      picks.push(c);
      m = prev;
    }
    const key = picks.map((c) => c.showId + c.a).sort().join();
    if (seen.has(key)) continue;
    seen.add(key);
    const s = score(picks, fixedDay);
    out.push({ picks, idle: s.idle, lastEnd: s.lastEnd });
  }
  out.sort((x, y) => x.idle - y.idle || x.lastEnd - y.lastEnd);
  return out.slice(0, keep);
}

/**
 * ★の公演の組み合わせを、良い順に最大 limit 案返す。入る数が最大の案だけを返す。
 * 返り値:
 *   total     … 組む対象の公演数（★のうち、まだ予定に入っていないもの）
 *   best      … 入れられた最大の数
 *   plans     … [{ picks: [{showId, day, start, end}], missing: [showId], idle }]
 *   truncated … 同じ数で入る振り分けが多すぎて、時間内に全部は比べきれなかった
 *   tooMany   … ★が多すぎて組めない（MAX_WANT まで）
 */
export function arrange(shows, wantIds, fixed, opts) {
  const o = { ...DEFAULTS, ...opts };
  const { want, fixedHere, options } = prepare(shows, wantIds, fixed, o);
  const n = want.length;
  const empty = { total: n, best: 0, plans: [], truncated: false, tooMany: false };
  if (n === 0) return empty;
  if (n > MAX_WANT) return { ...empty, tooMany: true };

  const t0 = clock();
  const size = 1 << n;
  const full = size - 1;
  const pc = new Uint8Array(size);
  for (let m = 1; m < size; m++) pc[m] = pc[m >> 1] + (m & 1);

  // 日ごとに、全部その日に入る組み合わせか
  const ok = o.days.map((day) => {
    const tables = want.map((id) => nextEndTable(options.get(id)[day]));
    return earliestEnd(tables, o.buffer, null).E;
  });

  // 振り分け [A(1日目), B(2日目)] の候補と、最大数
  let best = 0;
  const parts = [];
  if (o.days.length === 1) {
    const E = ok[0];
    for (let m = 1; m < size; m++) if (E[m] !== INF && pc[m] > best) best = pc[m];
    if (!o.countOnly) for (let m = 1; m < size; m++) if (E[m] !== INF && pc[m] === best) parts.push([m]);
  } else {
    // G[m] = m の中から2日目に入れられる最大の組（の大きさと中身）
    const [E1, E2] = ok;
    const G = new Uint8Array(size);
    const GM = new Int32Array(size);
    for (let m = 0; m < size; m++) if (E2[m] !== INF) {
      G[m] = pc[m];
      GM[m] = m;
    }
    for (let b = 0; b < n; b++) {
      const bit = 1 << b;
      for (let m = 0; m < size; m++) {
        if (m & bit && G[m ^ bit] > G[m]) {
          G[m] = G[m ^ bit];
          GM[m] = GM[m ^ bit];
        }
      }
    }
    for (let a = 0; a < size; a++) if (E1[a] !== INF && pc[a] + G[full ^ a] > best) best = pc[a] + G[full ^ a];
    if (!o.countOnly) {
      for (let a = 0; a < size; a++) {
        if (E1[a] === INF || pc[a] + G[full ^ a] !== best) continue;
        parts.push([a, GM[full ^ a]]);
      }
    }
  }
  if (o.countOnly || best === 0) return { ...empty, best };

  // 振り分けごとに待ち時間の短い並べ方を作り、全体で良い順に並べる
  const ids = (m) => want.filter((_, i) => m & (1 << i));
  // 振り分けが多いときは、片方の日に寄せすぎていないもの（両日の数が近いもの）から見る
  parts.sort((p, q) => Math.abs(pc[p[0]] - pc[p[1] ?? 0]) - Math.abs(pc[q[0]] - pc[q[1] ?? 0]));
  const found = [];
  const keys = new Set();
  let truncated = false;
  for (const part of parts) {
    if (clock() - t0 > o.budgetMs) {
      truncated = true;
      break;
    }
    const perDay = part.map((m, i) => bestOrders(ids(m), o.days[i], options, fixedHere, o.buffer, o.limit));
    // 日ごとの候補を掛け合わせる
    let combos = [{ picks: [], idle: 0, lastEnd: 0 }];
    for (const list of perDay) {
      const next = [];
      for (const x of combos) for (const y of list) next.push({ picks: [...x.picks, ...y.picks], idle: x.idle + y.idle, lastEnd: x.lastEnd + y.lastEnd });
      combos = next;
    }
    for (const c of combos) {
      const key = c.picks.map((p) => p.showId + p.day + p.a).sort().join();
      if (keys.has(key)) continue;
      keys.add(key);
      found.push(c);
    }
    found.sort((x, y) => x.idle - y.idle || x.lastEnd - y.lastEnd);
    found.length = Math.min(found.length, o.limit);
  }

  const plans = found.map((p) => {
    const got = new Set(p.picks.map((x) => x.showId));
    return {
      picks: [...p.picks]
        .sort((x, y) => x.day.localeCompare(y.day) || x.a - y.a)
        .map(({ showId, day, start, end }) => ({ showId, day, start, end })),
      missing: want.filter((id) => !got.has(id)),
      idle: p.idle,
    };
  });
  return { total: n, best, plans, truncated, tooMany: false };
}

/**
 * 全部は入らないときの理由。
 *   noSlot         … 選んだ日に回がない
 *   blockedByFixed … 回はあるが、どれもすでに入れた予定とぶつかる（with にぶつかる予定）
 *   dropOne        … その1公演をあきらめれば、残り（上の2つを除く）が全部入る
 */
export function explainMissing(shows, wantIds, fixed, opts) {
  const o = { ...DEFAULTS, ...opts };
  const { byId, want, fixedHere } = prepare(shows, wantIds, fixed, o);
  const noSlot = [];
  const blockedByFixed = [];
  const pool = [];
  for (const id of want) {
    const slots = o.days.flatMap((day) => (byId.get(id).slots[day] ?? []).map((x) => ({ day, ...x })));
    if (!slots.length) {
      noSlot.push(id);
      continue;
    }
    const hits = new Set();
    let any = false;
    for (const x of slots) {
      const [a, b] = minutesOf(x);
      const c = { day: x.day, a, b };
      const bad = fixedHere.filter((f) => !compatible(c, f, o.buffer));
      if (bad.length) bad.forEach((f) => hits.add(f));
      else any = true;
    }
    if (any) pool.push(id);
    else blockedByFixed.push({ id, with: [...hits].map(({ a, b, ...f }) => f) });
  }

  const dropOne = [];
  const count = { ...o, countOnly: true };
  if (pool.length > 1 && pool.length <= MAX_WANT && arrange(shows, pool, fixed, count).best < pool.length) {
    for (const id of pool) {
      const rest = pool.filter((x) => x !== id);
      if (arrange(shows, rest, fixed, count).best === rest.length) dropOne.push(id);
    }
  }
  return { noSlot, blockedByFixed, dropOne };
}
