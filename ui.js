// 画面。状態は S に1つだけ持ち、変わったら render() で描き直す。
// 公演は44・回は約480。全部描き直しても数ms なので、差分更新はしない。

import { FES, FLOORS, SHOWS, WALK_INS } from "./shows.js";
import {
  toMinutes,
  toHHMM,
  slotStatus,
  slotFace,
  choose,
  unchoose,
  gapsOf,
  fitsGap,
  summarize,
  priceOf,
  festivalNow,
  nowNext,
  planToText,
} from "./planner.js";
import { arrange, explainMissing, favoriteState, MAX_WANT } from "./arrange.js";
import { loadState, saveState, encodePlan, decodePlan } from "./storage.js";

const DAYS = FES.days.map((d) => d.id);
const DAY_LABEL = Object.fromEntries(FES.days.map((d) => [d.id, `${d.label}(${d.weekday})`]));
const LABELS = ["ごはん", "休憩", "予約不要", "移動", "その他"];
const OPEN = "10:00";
const CLOSE = "20:00";
const FLOOR_COLOR = { "11F": "var(--f11)", "2F": "var(--f2)", "4F": "var(--f4)" };
const byId = new Map(SHOWS.map((s) => [s.id, s]));
const CTX = { shows: SHOWS, days: DAYS, labels: LABELS };

/* ---------------- 状態 ---------------- */

const saved = typeof localStorage !== "undefined" ? loadState(localStorage, CTX) : null;
const S = {
  plan: saved?.plan ?? [],
  favorites: new Set(saved?.favorites ?? []),
  buffer: saved?.buffer ?? 10,
  day: saved?.day ?? DAYS[0],
  view: "list", // list | grid
  fopen: false, // スマホで絞り込み欄を開いているか
  q: "",
  floor: "all",
  diff: "all",
  len: "all",
  onlyFav: false,
  onlyFits: false,
  sort: "place",
  gap: null, // { day, a, b, edgeA, edgeB } 空きで絞り込み中
  sheet: false,
  shared: null, // 共有URLで受け取った予定
  toast: null,
  arrDays: new Set(DAYS), // ★から組むときに使う日
  arr: null, // ★から組んだ結果 { sig, busy, result, why }
};

function persist() {
  if (typeof localStorage !== "undefined") saveState(localStorage, S);
}

function takeShared() {
  const m = /[#&]p=([0-9a-z-]+)/.exec(location.hash);
  if (!m) return;
  const plan = decodePlan(m[1], CTX);
  if (plan.length) S.shared = plan;
}

/* ---------------- 小物 ---------------- */

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

const yen = (n) => "¥" + n.toLocaleString("ja-JP");
const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + "分" : ""}` : `${m}分`);
const floorStyle = (f) => `--fc:${FLOOR_COLOR[f]}`;
const showOf = (p) => (p.showId != null ? byId.get(p.showId) : null);
const nameOf = (p) => showOf(p)?.title ?? p.label;
const slotObj = (show, day, x) => ({ showId: show.id, day, start: x.start, end: x.end });

function say(text, undoPlan) {
  S.toast = { text, undo: undoPlan ?? null, at: Date.now() };
  const at = S.toast.at;
  setTimeout(() => {
    if (S.toast?.at === at) {
      S.toast = null;
      renderToast();
    }
  }, 6000);
  renderToast();
}

function setPlan(next, msg, undo) {
  S.plan = next;
  persist();
  render();
  if (msg) say(msg, undo);
}

/* ---------------- 操作 ---------------- */

function toggleSlot(show, day, x) {
  const slot = slotObj(show, day, x);
  const st = slotStatus(slot, S.plan, S.buffer);
  const before = S.plan;
  if (st.state === "chosen") {
    const item = S.plan.find((p) => p.showId === show.id && p.day === day && p.start === x.start);
    setPlan(unchoose(S.plan, item), `${show.title} ${x.start} を外しました`, before);
    return;
  }
  const { plan, removed } = choose(S.plan, slot);
  // 空きで絞り込んでいたなら、埋まったので解除する
  if (S.gap && S.gap.day === day) S.gap = null;
  const msg = removed.length
    ? `${show.title} ${x.start} を入れ、${removed.map((r) => `${nameOf(r)} ${r.start}`).join("・")} を外しました`
    : `${show.title} ${DAY_LABEL[day]} ${x.start} を入れました`;
  setPlan(plan, msg, before);
}

function slotLabel(show, day, x, st, outside = false) {
  const base = `${show.title} ${DAY_LABEL[day]} ${x.start}から${x.end}`;
  if (outside && st.state !== "chosen") return `${base}、選んだ空き時間には入りません`;
  switch (st.state) {
    case "chosen": return `${base}、予定に入っています。押すと外します`;
    case "moved": return `${base}、別の回を選んでいます。押すとこの回に入れ替えます`;
    case "conflict": return `${base}、${st.with.map(nameOf).join("・")}と重なります。押すと入れ替えます`;
    case "tight": return `${base}、前後のあきが${st.gap}分です`;
    default: return base;
  }
}


/* ---------------- 絞り込み ---------------- */

function matches(show) {
  if (!show.slots[S.day]) return false;
  if (S.floor !== "all" && show.floor !== S.floor) return false;
  if (S.onlyFav && !S.favorites.has(show.id)) return false;
  const d = show.difficulty;
  if (S.diff === "low" && !(d != null && d <= 4)) return false;
  if (S.diff === "mid" && !(d != null && d >= 5 && d <= 6)) return false;
  if (S.diff === "high" && !(d != null && d >= 7)) return false;
  const m = show.durationMin;
  if (S.len === "30" && m > 30) return false;
  if (S.len === "60" && m > 60) return false;
  if (S.len === "90" && m > 90) return false;
  if (S.len === "long" && m <= 90) return false;
  if (S.q) {
    const hay = `${show.title} ${show.group} ${show.room} ${show.tags.join(" ")}`.toLowerCase();
    if (!hay.includes(S.q.toLowerCase())) return false;
  }
  if (S.gap && !show.slots[S.day].some((x) => fitsGap(x, S.gap, S.buffer))) return false;
  if (S.onlyFits) {
    const picked = S.plan.some((p) => p.showId === show.id);
    const ok = show.slots[S.day].some((x) => {
      const st = slotStatus(slotObj(show, S.day, x), S.plan, S.buffer).state;
      return st === "free" || st === "moved";
    });
    if (!picked && !ok) return false;
  }
  return true;
}

const PLACE_ORDER = new Map(SHOWS.map((s, i) => [s.id, i]));
function sorted(list) {
  const first = (s) => toMinutes(s.slots[S.day][0].start);
  const diffOr = (s, v) => s.difficulty ?? v;
  const cmp = {
    place: (a, b) => PLACE_ORDER.get(a.id) - PLACE_ORDER.get(b.id),
    hard: (a, b) => diffOr(b, -1) - diffOr(a, -1),
    easy: (a, b) => diffOr(a, 99) - diffOr(b, 99),
    short: (a, b) => a.durationMin - b.durationMin,
    cheap: (a, b) => a.price - b.price,
    early: (a, b) => first(a) - first(b),
  }[S.sort];
  return [...list].sort((a, b) => cmp(a, b) || PLACE_ORDER.get(a.id) - PLACE_ORDER.get(b.id));
}

/* ---------------- 上部 ---------------- */

function bufferField(id, cls) {
  return h("label", { class: `field ${cls}`, for: id }, "移動にとる時間",
    h("select", {
      id,
      onchange: (e) => { S.buffer = Number(e.target.value); persist(); render(); },
    }, [0, 5, 10, 15, 20].map((n) => h("option", { value: n, selected: S.buffer === n }, `${n}分`))));
}

function topbar() {
  const dayBtns = FES.days.map((d) =>
    h("button", {
      type: "button",
      "aria-pressed": String(S.day === d.id),
      onclick: () => {
        S.day = d.id;
        S.gap = null;
        persist();
        render();
      },
    }, d.label, h("span", { class: "wk" }, `(${d.weekday})`)),
  );
  const viewBtns = [
    ["list", "一覧"],
    ["grid", "時間割"],
  ].map(([v, t]) =>
    h("button", { type: "button", "aria-pressed": String(S.view === v), onclick: () => { S.view = v; render(); } }, t),
  );

  return h("header", { class: "top" },
    h("div", { class: "top-in" },
      h("div", { class: "brand" }, h("h1", null, FES.title), h("span", null, "予定づくり")),
      h("div", { class: "seg", role: "group", "aria-label": "日付" }, dayBtns),
      bufferField("buffer", "buf-top"),
      h("div", { class: "seg", role: "group", "aria-label": "表示" }, viewBtns),
    ),
  );
}

function banners() {
  const out = [];
  const now = festivalNow(new Date(), FES);
  if (now) {
    const nn = nowNext(S.plan, now);
    const parts = [];
    if (nn.current) parts.push(h("span", null, "いま ", h("b", null, nameOf(nn.current)), ` 〜${nn.current.end}（あと${nn.leftOfCurrent}分）`));
    if (nn.next) parts.push(h("span", null, "次 ", h("b", null, nameOf(nn.next)), ` ${nn.next.start}〜（あと${nn.untilNext}分）`, showOf(nn.next)?.floor === "11F" ? "・1Fに集合" : ""));
    if (!parts.length) parts.push(h("span", null, "今日の予定はもうありません"));
    out.push(h("div", { class: "now", role: "status" }, parts));
  }
  if (S.shared) {
    out.push(
      h("div", { class: "shared" },
        h("b", null, `共有された予定（${S.shared.length}件）`),
        h("button", {
          type: "button", class: "btn primary",
          onclick: () => {
            const before = S.plan;
            S.plan = S.shared;
            S.shared = null;
            history.replaceState(null, "", location.pathname + location.search);
            setPlan(S.plan, "共有された予定を自分の予定にしました", before);
          },
        }, "自分の予定にする"),
        h("button", {
          type: "button", class: "btn",
          onclick: () => { S.shared = null; history.replaceState(null, "", location.pathname + location.search); render(); },
        }, "閉じる"),
        h("pre", null, planToText(S.shared, SHOWS, FES.days)),
      ),
    );
  }
  return out.length ? h("div", { class: "banner" }, out) : null;
}

/* ---------------- 一覧 ---------------- */

function filters() {
  const sel = (id, label, key, opts) =>
    h("label", { class: "field", for: id }, label,
      h("select", { id, onchange: (e) => { S[key] = e.target.value; render(); } },
        opts.map(([v, t]) => h("option", { value: v, selected: S[key] === v }, t))));
  const tog = (label, key) =>
    h("button", { type: "button", class: "toggle", "aria-pressed": String(S[key]), onclick: () => { S[key] = !S[key]; render(); } }, label);

  const active = ["floor", "diff", "len"].filter((k) => S[k] !== "all").length + (S.onlyFav ? 1 : 0) + (S.onlyFits ? 1 : 0);

  return h("div", { class: "tools" },
    h("label", { class: "sr", for: "q" }, "公演を検索"),
    h("input", {
      id: "q", type: "search", placeholder: "公演名・団体名・部屋で検索", value: S.q,
      oninput: (e) => { S.q = e.target.value; renderMain(); },
    }),
    h("button", {
      type: "button", id: "filter-toggle", class: "toggle ftoggle", "aria-expanded": String(S.fopen), "aria-controls": "filter-panel",
      onclick: () => { S.fopen = !S.fopen; render(); },
    }, "絞り込み", active ? h("span", { class: "badge" }, h("span", { class: "sr" }, "：設定中"), String(active)) : null),
    h("div", { id: "filter-panel", class: S.fopen ? "fpanel open" : "fpanel" },
    sel("floor", "階", "floor", [["all", "すべて"], ["11F", "11階"], ["2F", "2階"], ["4F", "4階"]]),
    sel("diff", "難易度", "diff", [["all", "すべて"], ["low", "〜4"], ["mid", "5〜6"], ["high", "7〜"]]),
    sel("len", "所要", "len", [["all", "すべて"], ["30", "30分以内"], ["60", "60分以内"], ["90", "90分以内"], ["long", "90分超"]]),
    sel("sort", "並び", "sort", [["place", "場所順"], ["early", "早い回から"], ["hard", "難しい順"], ["easy", "易しい順"], ["short", "短い順"], ["cheap", "安い順"]]),
    tog("★だけ", "onlyFav"),
    tog("今の予定に入るものだけ", "onlyFits"),
    bufferField("buffer-m", "m-only"),
    legend(),
    ),
  );
}

function legend() {
  return h("p", { class: "legend", "aria-hidden": "true" },
    h("span", null, h("i", { class: "l-chosen" }), "選択中"),
    h("span", null, h("i"), "入る"),
    h("span", null, h("i", { class: "l-tight" }), "入るが移動がきつい"),
    h("span", null, h("i", { class: "l-conflict" }), "重なる（押すと入れ替え）"),
    h("span", null, h("i", { class: "l-outside" }), "時間外（選んだ空きに入らない）"),
  );
}

function gapNote() {
  if (!S.gap || S.gap.day !== S.day) return null;
  return h("div", { class: "gapnote", role: "status" },
    h("span", null, `${toHHMM(S.gap.a)}〜${toHHMM(S.gap.b)} の空き（${dur(S.gap.b - S.gap.a)}）に入る回だけ出しています`),
    h("button", { type: "button", class: "btn", onclick: () => { S.gap = null; render(); } }, "解除"),
  );
}

function card(show) {
  const day = S.day;
  const picked = S.plan.find((p) => p.showId === show.id);
  const fav = S.favorites.has(show.id);
  const slots = show.slots[day].map((x) => {
    const st = slotStatus(slotObj(show, day, x), S.plan, S.buffer);
    const outside = !!S.gap && !fitsGap(x, S.gap, S.buffer);
    const face = slotFace(st, x, { outside, special: show.special?.[x.start]?.label });
    return h("button", {
      type: "button",
      id: `s-${show.id}-${day}-${x.start}`,
      class: `slot ${face.kind}`,
      "aria-pressed": String(st.state === "chosen"),
      "aria-label": slotLabel(show, day, x, st, outside),
      onclick: () => toggleSlot(show, day, x),
    }, h("b", null, x.start), h("small", null, face.word));
  });
  const pickedElsewhere = picked && picked.day !== day ? h("p", { class: "note" }, `${DAY_LABEL[picked.day]} ${picked.start} の回を選んでいます`) : null;

  // 上部は3行：①階・部屋・所要・料金・難易度 ②公演名と★ ③団体・人数・形式・初演/再演・タグ
  return h("article", { class: `card${picked ? " has-pick" : ""}`, style: floorStyle(show.floor) },
    h("p", { class: "key" },
      h("span", { class: "flc" }, show.floor),
      h("span", { class: "room" }, show.room),
      h("span", null, `${show.durationMin}分`),
      h("span", null, `${yen(show.price)}/人`),
      h("span", { title: "難易度（10段階）" }, show.difficulty != null ? `難易度${show.difficulty}` : "難易度−"),
    ),
    h("div", { class: "card-h" },
      h("h3", null, show.title),
      h("button", {
        type: "button", class: "star", id: `fav-${show.id}`, "aria-pressed": String(fav),
        "aria-label": fav ? `${show.title}を気になるから外す` : `${show.title}を気になるに入れる`,
        onclick: () => {
          if (fav) S.favorites.delete(show.id);
          else S.favorites.add(show.id);
          persist();
          render();
        },
      }, h("span", { "aria-hidden": "true" }, fav ? "★" : "☆"), "気になる"),
    ),
    h("p", { class: "meta" },
      [show.group, show.people, show.format, show.run, show.tags.join("／")].filter(Boolean).join(" ・ "),
    ),
    show.note ? h("p", { class: "note" }, show.note) : null,
    show.floor === "11F" ? h("p", { class: "note" }, "ホール公演：開始時刻に1Fに集合") : null,
    pickedElsewhere,
    h("div", { class: "slots", role: "group", "aria-label": `${show.title}の回` }, slots),
  );
}

function walkIns() {
  const list = WALK_INS.filter((w) => w.days.includes(S.day));
  return h("details", { class: "walk" },
    h("summary", null, `予約不要で遊べるコンテンツ（${DAY_LABEL[S.day]}・${list.length}件）`),
    h("ul", null, list.map((w) =>
      h("li", null,
        h("b", null, w.title),
        h("p", { class: "meta" },
          h("span", null, w.group),
          h("span", null, w.how),
          h("span", null, `目安 ${w.time}`),
          h("span", null, w.price),
          h("span", null, `人数 ${w.people}`),
          h("span", null, w.difficulty != null ? `難易度 ${w.difficulty}` : "難易度 −"),
        ),
        h("p", { class: "tags" }, w.tags.join(" / ")),
      ))),
  );
}

function listView() {
  const shown = sorted(SHOWS.filter(matches));
  const total = SHOWS.filter((s) => s.slots[S.day]).length;
  return h("div", null,
    filters(),
    gapNote(),
    arrangeCta(),
    h("p", { class: "count", role: "status" }, `${DAY_LABEL[S.day]} ${total}公演のうち ${shown.length}件`),
    shown.length
      ? h("div", { class: "cards" }, shown.map(card))
      : h("div", { class: "none" }, "条件に合う公演がありません。絞り込みをゆるめてください。"),
    walkIns(),
  );
}

/* ---------------- 時間割 ---------------- */

const PPM = 1.5; // 1分あたりのpx
const PAD = 10; // 一番上の目盛りが見出しに隠れないよう、上にとる余白
function gridView() {
  const day = S.day;
  const O = toMinutes(OPEN);
  const C = toMinutes(CLOSE);
  const H = (C - O) * PPM + PAD * 2;
  // 列は「部屋＋レーン」。同じ部屋で日ごとに公演が変わるので、その日の公演から組む
  const cols = [];
  for (const s of SHOWS) {
    if (!s.slots[day]) continue;
    if (S.floor !== "all" && s.floor !== S.floor) continue;
    cols.push(s);
  }
  const axis = h("div", { class: "gaxis", style: `--h:${H}px` });
  const lines = [];
  for (let m = O; m <= C; m += 30) {
    const y = (m - O) * PPM + PAD;
    if (m % 60 === 0) axis.append(h("span", { style: `top:${y}px` }, toHHMM(m)));
    lines.push(y);
  }
  const header = [h("div", { class: "gh corner" })].concat(
    cols.map((s) => h("div", { class: "gh", style: floorStyle(s.floor) }, h("b", null, `${FLOORS[s.floor].label} ${s.room}`), s.title)),
  );
  const body = cols.map((s) => {
    const col = h("div", { class: "gcol", style: `--h:${H}px` },
      lines.map((y, i) => h("div", { class: `hline${i % 2 ? " half" : ""}`, style: `top:${y}px` })));
    for (const x of s.slots[day]) {
      const st = slotStatus(slotObj(s, day, x), S.plan, S.buffer);
      const outside = !!S.gap && !fitsGap(x, S.gap, S.buffer);
      const face = slotFace(st, x, { outside });
      const top = (toMinutes(x.start) - O) * PPM + PAD;
      const ht = (toMinutes(x.end) - toMinutes(x.start)) * PPM;
      col.append(h("button", {
        type: "button",
        id: `g-${s.id}-${day}-${x.start}`,
        class: `gb ${face.kind}`,
        style: `top:${top}px;height:${ht - 1}px`,
        "aria-pressed": String(st.state === "chosen"),
        "aria-label": slotLabel(s, day, x, st, outside),
        title: `${s.title} ${x.start}-${x.end}`,
        onclick: () => toggleSlot(s, day, x),
      }, `${x.start}–${x.end}`, face.kind === "free" ? null : h("small", null, face.word)));
    }
    return col;
  });
  // 階ごとに列を絞る。会場では階単位で動くので、スマホでも横に流しすぎないように
  const onDay = SHOWS.filter((s) => s.slots[day]);
  const floorBtn = (v, t) => {
    const n = v === "all" ? onDay.length : onDay.filter((s) => s.floor === v).length;
    return h("button", {
      type: "button", id: `gfl-${v}`, class: "gfl", "aria-pressed": String(S.floor === v), style: v === "all" ? null : floorStyle(v),
      onclick: () => { S.floor = v; render(); },
    }, v === "all" ? null : h("i", { "aria-hidden": "true" }), t, h("small", null, `${n}列`));
  };
  return h("div", null,
    h("div", { class: "gfloors", role: "group", "aria-label": "表示する階" },
      floorBtn("all", "すべて"), floorBtn("11F", "11F"), floorBtn("2F", "2F"), floorBtn("4F", "4F")),
    h("div", { class: "tools" },
      bufferField("buffer-m", "m-only"),
      h("span", { class: "count" }, "枠を押すと予定に入ります。重なる枠を押すと入れ替えます。横にスクロールすると、ほかの部屋が出ます。"),
    ),
    gapNote(),
    h("div", { class: "grid-wrap" },
      h("div", { class: "grid", style: `--cols:${cols.length}` }, header, axis, body)),
  );
}

/* ---------------- 予定 ---------------- */

/* ---------------- ★から組む ---------------- */

// 組んだ結果は、そのときの予定・★・移動時間・日が変わったら古くなる
const arrSig = () => JSON.stringify([S.plan.map((p) => [p.showId, p.day, p.start, p.label]), [...S.favorites].sort(), S.buffer, [...S.arrDays].sort()]);

function runArrange() {
  const days = DAYS.filter((d) => S.arrDays.has(d));
  const opts = { days, buffer: S.buffer, open: OPEN, close: CLOSE };
  const sig = arrSig();
  S.arr = { sig, busy: true };
  render();
  // 「考え中」を一度描いてから計算する（★が多いと0.5秒ほどかかる）
  setTimeout(() => {
    const result = arrange(SHOWS, [...S.favorites], S.plan, opts);
    const why = result.best < result.total && !result.tooMany ? explainMissing(SHOWS, [...S.favorites], S.plan, opts) : null;
    S.arr = { sig, busy: false, result, why };
    render();
    document.getElementById("arr-result")?.focus();
  }, 30);
}

// 一覧や下の帯の「★から組む」から来たとき。予定を開いて、組めるならそのまま計算まで進める
function openArrange() {
  const fs = favoriteState([...S.favorites], S.plan, byId);
  if (!window.matchMedia("(min-width:960px)").matches) S.sheet = true;
  const canRun = fs.left > 0 && S.arrDays.size > 0 && !S.arr?.busy;
  if (canRun) runArrange();
  else render();
  const box = document.getElementById("arr");
  box?.scrollIntoView({ block: "start" });
  if (!canRun) box?.focus({ preventScroll: true });
}

function arrangeCta() {
  const fs = favoriteState([...S.favorites], S.plan, byId);
  if (!fs.ready) return null;
  return h("section", { class: "arrcta", "aria-label": "★から組む" },
    h("span", { class: "arrcta-star", "aria-hidden": "true" }, "★"),
    h("p", null, h("b", null, `★ ${fs.count}公演`),
      fs.left < fs.count ? `（まだ予定にないのは${fs.left}公演）` : "",
      "を、重ならず待ち時間が少ない並べ方で最大3案つくれます"),
    h("button", { type: "button", id: "arrcta-go", class: "btn ink", onclick: openArrange }, "★から組む"),
  );
}

function applyArrangement(plan) {
  const before = S.plan;
  let next = S.plan;
  for (const p of plan.picks) next = choose(next, p).plan;
  S.arr = null;
  setPlan(next, `★の公演を${plan.picks.length}件、予定に入れました`, before);
}

function arrangeBox() {
  const favs = [...S.favorites].filter((id) => byId.has(id));
  const placed = new Set(S.plan.map((p) => p.showId));
  const left = favs.filter((id) => !placed.has(id));
  const box = h("section", { class: "arr", id: "arr", tabindex: "-1", "aria-labelledby": "arr-h" });
  box.append(h("h3", { id: "arr-h" }, "★から組む"));

  if (!favs.length) {
    box.append(h("p", { class: "arr-hint" }, "行きたい公演のカードで ☆ を押して印を付けると、回の組み合わせを考えて予定に入れられます。"));
    return box;
  }

  const dayChecks = FES.days.map((d) =>
    h("label", { class: "buy" },
      h("input", {
        type: "checkbox", checked: S.arrDays.has(d.id),
        onchange: (e) => {
          if (e.target.checked) S.arrDays.add(d.id);
          else S.arrDays.delete(d.id);
          render();
        },
      }), `${d.label}(${d.weekday})`));
  const noDay = S.arrDays.size === 0;
  box.append(
    h("p", { class: "arr-hint" },
      `★ ${favs.length}公演のうち、まだ予定に入っていないのは ${left.length}公演。`,
      "入れてある予定は動かさずに、残りの時間へ割り振ります。"),
    h("div", { class: "arr-row" },
      h("span", { class: "arr-lbl" }, "使う日"), dayChecks,
      h("button", {
        type: "button", class: "btn primary", disabled: noDay || !left.length || S.arr?.busy,
        onclick: runArrange,
      }, S.arr?.busy ? "考え中…" : "組み合わせを考える"),
    ),
  );
  if (noDay) box.append(h("p", { class: "err" }, "使う日を1つ以上選んでください。"));

  const a = S.arr;
  if (!a || a.busy) return box;
  if (a.sig !== arrSig()) {
    box.append(h("p", { class: "arr-hint" }, "予定や★が変わりました。もう一度「組み合わせを考える」を押してください。"));
    return box;
  }
  const r = a.result;
  const out = h("div", { class: "arr-out", id: "arr-result", tabindex: "-1", role: "region", "aria-label": "組み合わせの結果" });
  box.append(out);

  if (r.tooMany) {
    out.append(h("p", { class: "err" }, `★が多すぎて組めません（${r.total}公演）。まだ予定に入っていない★を${MAX_WANT}公演までにしぼってください。`));
    return box;
  }
  if (r.total === 0) {
    out.append(h("p", null, "★の公演は、もう全部予定に入っています。"));
    return box;
  }

  out.append(h("p", { class: "arr-sum" },
    r.best === r.total ? `★${r.total}公演、全部入ります。` : `★${r.total}公演のうち、入るのは最大${r.best}公演です。`));

  if (r.best < r.total && a.why) out.append(whyList(a.why, r));
  if (r.truncated) out.append(h("p", { class: "arr-hint" }, "組み合わせが多いため、並べ方は一部を比べた中から選んでいます（入る公演数は最大です）。"));

  r.plans.forEach((p, i) => {
    const byDay = DAYS.filter((d) => p.picks.some((x) => x.day === d));
    out.append(h("div", { class: "arr-plan" },
      h("p", { class: "arr-ph" }, h("b", null, `案${i + 1}`), `　待ち時間 合計${dur(p.idle)}`),
      byDay.map((d) => h("div", null,
        DAYS.length > 1 ? h("p", { class: "arr-day" }, DAY_LABEL[d]) : null,
        h("ul", null, p.picks.filter((x) => x.day === d).map((x) => {
          const s = byId.get(x.showId);
          return h("li", { style: floorStyle(s.floor) }, h("span", { class: "tm2" }, `${x.start}–${x.end}`), " ", s.title, " ",
            h("span", { class: "sub" }, h("span", { class: "fl" }, FLOORS[s.floor].label), ` ${s.room}`));
        })),
      )),
      p.missing.length ? h("p", { class: "arr-miss" }, `入らない：${p.missing.map((id) => byId.get(id).title).join("・")}`) : null,
      h("button", { type: "button", class: "btn", onclick: () => applyArrangement(p) }, `案${i + 1}を予定に入れる`),
    ));
  });
  out.append(h("button", { type: "button", class: "btn quiet", onclick: () => { S.arr = null; render(); } }, "結果を閉じる"));
  return box;
}

function whyList(why, r) {
  const t = (id) => byId.get(id).title;
  const lines = [];
  for (const id of why.noSlot) lines.push(`${t(id)}：選んだ日に回がありません`);
  for (const x of why.blockedByFixed) lines.push(`${t(x.id)}：どの回も、入れてある「${x.with.map(nameOf).join("・")}」とぶつかります`);
  if (why.dropOne.length) lines.push(`${why.dropOne.map(t).join("・")} のどれか1つをあきらめれば、残りは全部入ります`);
  else if (r.best < r.total - why.noSlot.length - why.blockedByFixed.length) lines.push("★どうしの時間がぶつかっていて、1つあきらめるだけでは全部は入りません");
  return h("ul", { class: "arr-why" }, lines.map((l) => h("li", null, l)));
}

function planPanel() {
  const day = S.day;
  const sum = summarize(S.plan, SHOWS);
  const d = sum.days[day] ?? { count: 0, price: 0, minutes: 0 };
  const items = S.plan.filter((p) => p.day === day);
  const gaps = gapsOf(S.plan, day, { open: OPEN, close: CLOSE });

  const tl = h("ol", { class: "tl", "aria-label": `${DAY_LABEL[day]}の予定` });
  const gapRow = (g) => {
    const len = g.b - g.a;
    const active = S.gap && S.gap.day === day && S.gap.a === g.a && S.gap.b === g.b;
    const room = len - (g.edgeA ? 0 : S.buffer) - (g.edgeB ? 0 : S.buffer);
    const tight = !g.edgeA && !g.edgeB && len < S.buffer;
    const li = h("li", { class: `gap${tight ? " warn" : ""}` });
    if (tight) li.append(`あき${len}分・移動がきつい`);
    else if (room >= 15) {
      li.append(h("button", {
        type: "button", class: "find", "aria-pressed": String(!!active),
        onclick: () => {
          S.gap = active ? null : { day, ...g };
          S.view = S.view === "grid" ? "grid" : "list";
          S.sheet = false;
          render();
          // 一覧の先頭（「〜の空きに入る回だけ」の表示）まで戻す。上の帯のぶん少し下げる
          const m = document.getElementById("main");
          if (!active && m) window.scrollTo({ top: Math.max(0, m.getBoundingClientRect().top + window.scrollY - 70) });
        },
      }, `${toHHMM(g.a)}〜${toHHMM(g.b)} あき${dur(len)}　${active ? "絞り込みを解除" : "→ 入る回を探す"}`));
    } else li.append(`あき${len}分`);
    return li;
  };

  // 予定と空きを時刻順に並べる
  const rows = [
    ...items.map((p) => ({ t: toMinutes(p.start), p })),
    ...gaps.map((g) => ({ t: g.a, g })),
  ].sort((x, y) => x.t - y.t || (x.g ? -1 : 1));
  // 予定どうしがくっついている（あき0分）場合は空きが出ないので、注意だけ挟む
  let prev = null;
  for (const r of rows) {
    if (r.g) {
      tl.append(gapRow(r.g));
      prev = null;
      continue;
    }
    if (prev && toMinutes(prev.end) === toMinutes(r.p.start)) tl.append(h("li", { class: "gap warn" }, "あき0分・移動がきつい"));
    tl.append(planItem(r.p));
    prev = r.p;
  }

  const both = DAYS.map((x) => {
    const v = sum.days[x];
    return `${DAY_LABEL[x]} ${v ? `${v.count}公演 ${yen(v.price)}` : "なし"}`;
  }).join(" ／ ");

  return h("aside", { class: `plan${S.sheet ? " open" : ""}`, id: "plan", "aria-label": "自分の予定" },
    h("div", { class: "plan-h" },
      h("h2", null, `${DAY_LABEL[day]}の予定`,
        h("button", { type: "button", class: "btn sheet-close", onclick: closeSheet }, "閉じる")),
      h("p", { class: "stats" },
        h("b", null, `${d.count}公演`), "・", h("b", null, yen(d.price)), `・謎解き ${dur(d.minutes)}`,
        sum.total.count ? `・購入済み ${sum.total.bought}/${sum.total.count}` : ""),
    ),
    arrangeBox(),
    items.length ? tl : h("p", { class: "empty" }, "まだ予定がありません。公演の時刻を押すと、ここに入ります。"),
    h("p", { class: "both" }, `2日間：${both}・合計 ${yen(sum.total.price)}`),
    addForm(),
    h("div", { class: "plan-f" },
      h("button", { type: "button", class: "btn", disabled: !S.plan.length, onclick: copyText }, "テキストでコピー"),
      h("button", { type: "button", class: "btn", disabled: !S.plan.length, onclick: copyLink }, "共有URLをコピー"),
      h("button", {
        type: "button", class: "btn quiet", disabled: !items.length,
        onclick: () => {
          if (!confirm(`${DAY_LABEL[day]}の予定を全部消します。よろしいですか？`)) return;
          const before = S.plan;
          setPlan(S.plan.filter((p) => p.day !== day), `${DAY_LABEL[day]}の予定を消しました`, before);
        },
      }, "この日の予定を全部消す"),
    ),
  );
}

function planItem(p) {
  const show = showOf(p);
  const before = () => S.plan;
  const rm = h("button", {
    type: "button", class: "rm",
    "aria-label": `${nameOf(p)} ${p.start} を予定から外す`,
    onclick: () => { const b = before(); setPlan(unchoose(S.plan, p), `${nameOf(p)} を外しました`, b); },
  }, "外す");
  if (!show) {
    return h("li", { class: "it mine" },
      h("div", { class: "tm" }, p.start, h("small", null, `〜${p.end}`)),
      h("div", null, h("div", { class: "ti" }, p.label)),
      h("div", { class: "acts" }, rm),
    );
  }
  const id = `buy-${p.showId}`;
  return h("li", { class: `it${p.bought ? " bought" : ""}`, style: floorStyle(show.floor) },
    h("div", { class: "tm" }, p.start, h("small", null, `〜${p.end}`)),
    h("div", null,
      h("div", { class: "ti" }, show.title),
      h("div", { class: "sub" }, h("span", { class: "fl" }, FLOORS[show.floor].label), ` ${show.room}・${yen(priceOf(show, p.start))}`),
      show.floor === "11F" ? h("div", { class: "hall" }, "開始時刻に1Fに集合") : null,
    ),
    h("div", { class: "acts" },
      h("label", { class: "buy", for: id },
        h("input", {
          id, type: "checkbox", checked: !!p.bought,
          onchange: (e) => {
            S.plan = S.plan.map((x) => (x === p ? { ...x, bought: e.target.checked || undefined } : x));
            persist();
            render();
          },
        }), "購入済み"),
      rm,
    ),
  );
}

function addForm() {
  const start = h("input", { type: "time", id: "add-start", step: 300, min: "09:00", max: "21:00", required: true });
  const end = h("input", { type: "time", id: "add-end", step: 300, min: "09:00", max: "21:00", required: true });
  const label = h("select", { id: "add-label" }, LABELS.map((l) => h("option", { value: l }, l)));
  const err = h("p", { class: "err", role: "alert" });
  const submit = (e) => {
    e.preventDefault();
    const a = start.value;
    const b = end.value;
    if (!a || !b) {
      err.textContent = "開始と終了の時刻を入れてください。";
      return;
    }
    const norm = (v) => v.replace(/^0(\d):/, "$1:");
    const item = { day: S.day, start: norm(a), end: norm(b), label: label.value };
    if (toMinutes(item.start) >= toMinutes(item.end)) {
      err.textContent = "終了は開始より後の時刻にしてください。";
      return;
    }
    const st = slotStatus(item, S.plan, 0);
    if (st.state === "conflict") {
      err.textContent = `${st.with.map(nameOf).join("・")}と重なっています。時刻をずらすか、先にそちらを外してください。`;
      return;
    }
    const before = S.plan;
    setPlan(choose(S.plan, item).plan, `${item.label} ${item.start}〜${item.end} を足しました`, before);
  };
  return h("form", { class: "addform", onsubmit: submit },
    h("fieldset", null,
      h("legend", null, "ごはん・休憩・予約不要コンテンツなどを足す"),
      h("div", { class: "row" },
        h("label", { class: "sr", for: "add-label" }, "種類"), label,
        h("label", { class: "sr", for: "add-start" }, "開始"), start, "〜",
        h("label", { class: "sr", for: "add-end" }, "終了"), end,
        h("button", { type: "submit", class: "btn" }, "足す"),
      ),
      err,
    ),
  );
}

async function copy(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    say(okMsg);
  } catch {
    prompt("コピーできませんでした。下の文字を選んでコピーしてください。", text);
  }
}
function copyText() {
  copy(`${FES.title} 予定\n\n${planToText(S.plan, SHOWS, FES.days)}`, "予定をテキストでコピーしました");
}
function copyLink() {
  const url = `${location.origin}${location.pathname}#p=${encodePlan(S.plan, CTX)}`;
  copy(url, "共有URLをコピーしました（購入済みの印は含みません）");
}

/* ---------------- スマホの帯 ---------------- */

function dock() {
  const sum = summarize(S.plan, SHOWS);
  const d = sum.days[S.day] ?? { count: 0, price: 0 };
  const fs = favoriteState([...S.favorites], S.plan, byId);
  return h("div", { class: "dock" },
    h("div", { class: "sum" }, h("b", null, `${DAY_LABEL[S.day]} ${d.count}公演`), h("br"), `${yen(d.price)}・2日間で${sum.total.count}公演`),
    fs.ready ? h("button", { type: "button", id: "dock-arr", class: "btn", onclick: openArrange }, "★から組む") : null,
    h("button", {
      type: "button", id: "open-plan", class: "btn primary", "aria-controls": "plan", "aria-expanded": String(S.sheet),
      onclick: () => { S.sheet = true; render(); document.querySelector("#plan .sheet-close")?.focus(); },
    }, "予定を見る"),
  );
}

/* ---------------- 描画 ---------------- */

// 読み上げを確実にするため、お知らせの領域は1度だけ作って使い回す（描き直しで作り直さない）
let toastEl;
function renderToast() {
  if (!toastEl) return;
  toastEl.replaceChildren();
  if (!S.toast) {
    toastEl.hidden = true;
    return;
  }
  toastEl.hidden = false;
  toastEl.append(h("span", null, S.toast.text));
  if (S.toast.undo) {
    const undo = S.toast.undo;
    toastEl.append(h("button", {
      type: "button",
      onclick: () => {
        S.plan = undo;
        S.toast = null;
        persist();
        render();
        renderToast();
      },
    }, "元に戻す"));
  }
}

let mainEl;
function renderMain() {
  // 検索の入力中はフォーカスを失わないよう、一覧だけを描き直す
  const cards = mainEl?.querySelector(".cards, .none");
  const countEl = mainEl?.querySelector(".count");
  if (!cards || S.view !== "list") return render();
  const shown = sorted(SHOWS.filter(matches));
  const total = SHOWS.filter((s) => s.slots[S.day]).length;
  countEl.textContent = `${DAY_LABEL[S.day]} ${total}公演のうち ${shown.length}件`;
  cards.replaceWith(
    shown.length
      ? h("div", { class: "cards" }, shown.map(card))
      : h("div", { class: "none" }, "条件に合う公演がありません。絞り込みをゆるめてください。"),
  );
}

function render() {
  const app = document.getElementById("app");
  const scroll = window.scrollY;
  const active = document.activeElement?.id;
  mainEl = h("main", { id: "main", "aria-label": "公演" }, S.view === "grid" ? gridView() : listView());
  const parts = [
    topbar(),
    banners(),
    h("div", { class: "layout" }, mainEl, planPanel()),
    h("footer", { class: "foot" },
      h("p", null, "非公式のファンツールです。時間割は公式タイムテーブルから書き写したもので、誤りがあるかもしれません。満席状況は反映されません。"),
      h("p", null, "最新情報は ", h("a", { href: FES.url, target: "_blank", rel: "noopener noreferrer" }, "公式サイト"), "、チケットは ",
        h("a", { href: FES.ticketUrl, target: "_blank", rel: "noopener noreferrer" }, "ESCAPE.ID"), " で確認してください。"),
    ),
    dock(),
  ];
  app.replaceChildren(...parts.filter(Boolean));
  if (!toastEl) {
    toastEl = h("div", { class: "toast", role: "status", "aria-live": "polite", hidden: true });
    document.body.append(toastEl);
  }
  renderToast();
  // スマホで予定シートを開いている間は、裏の画面をフォーカス・読み上げの対象から外す
  if (S.sheet) for (const el of app.children) if (el !== app.querySelector(".layout")) el.inert = true;
  if (S.sheet) mainEl.inert = true;
  document.body.style.overflow = S.sheet ? "hidden" : "";
  window.scrollTo(0, scroll);
  if (active) document.getElementById(active)?.focus({ preventScroll: true });
}

function closeSheet() {
  S.sheet = false;
  render();
  document.getElementById("open-plan")?.focus();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && S.sheet) closeSheet();
});

// 共有URLを開いたまま別の共有URLを貼られたとき
window.addEventListener("hashchange", () => {
  takeShared();
  render();
});

takeShared();
render();
