import { describe, it, expect } from "vitest";
import {
  toMinutes,
  toHHMM,
  slotStatus,
  choose,
  gapsOf,
  fitsGap,
  summarize,
  festivalNow,
  nowNext,
  planToText,
  slotFace,
} from "../planner.js";

const shows = [
  { id: "a", title: "A", room: "201", floor: "2F", price: 2000, slots: { d1: [{ start: "10:00", end: "11:00" }, { start: "13:00", end: "14:00" }] } },
  { id: "b", title: "B", room: "202", floor: "2F", price: 1500, slots: { d1: [{ start: "10:30", end: "11:15" }, { start: "11:05", end: "11:50" }, { start: "11:20", end: "12:05" }] } },
  { id: "c", title: "C", room: "ホール①", floor: "11F", price: 4000, slots: { d1: [{ start: "12:00", end: "14:00" }], d2: [{ start: "10:00", end: "12:00" }] } },
];
const pick = (showId, day, start) => {
  const s = shows.find((x) => x.id === showId).slots[day].find((x) => x.start === start);
  return { showId, day, start: s.start, end: s.end };
};

describe("時刻", () => {
  it("分に直して戻せる", () => {
    expect(toMinutes("9:05")).toBe(545);
    expect(toHHMM(545)).toBe("9:05");
    expect(() => toMinutes("25:00")).toThrow();
  });
});

describe("slotStatus", () => {
  const plan = [pick("a", "d1", "10:00")];

  it("選んだ回は chosen", () => {
    expect(slotStatus(pick("a", "d1", "10:00"), plan, 10).state).toBe("chosen");
  });

  it("同じ公演の別の回は moved（選ぶと入れ替わる）", () => {
    expect(slotStatus(pick("a", "d1", "13:00"), plan, 10).state).toBe("moved");
  });

  it("時間が重なる回は conflict で、相手を返す", () => {
    const r = slotStatus(pick("b", "d1", "10:30"), plan, 10);
    expect(r.state).toBe("conflict");
    expect(r.with.map((x) => x.showId)).toEqual(["a"]);
  });

  it("重ならないが移動時間より短い間隔は tight", () => {
    const r = slotStatus(pick("b", "d1", "11:05"), plan, 10);
    expect(r.state).toBe("tight");
    expect(r.gap).toBe(5);
  });

  it("移動時間ちょうど以上あけば free", () => {
    expect(slotStatus(pick("b", "d1", "11:20"), plan, 10).state).toBe("free");
  });

  it("終了と開始がぴったり同時刻は tight（0分）", () => {
    const r = slotStatus({ showId: "x", day: "d1", start: "11:00", end: "11:30" }, plan, 10);
    expect(r).toMatchObject({ state: "tight", gap: 0 });
  });

  it("別の日の予定とは干渉しない", () => {
    expect(slotStatus(pick("c", "d2", "10:00"), plan, 10).state).toBe("free");
  });

  it("自分で足した予定（ごはん等）とも重なりを見る", () => {
    const p = [{ day: "d1", start: "12:00", end: "13:00", label: "ごはん" }];
    expect(slotStatus(pick("c", "d1", "12:00"), p, 10).state).toBe("conflict");
  });
});

describe("slotFace（回ボタンの見た目の種類と2行目の言葉）", () => {
  const x = { start: "10:00", end: "11:00" };

  it("状態ごとに種類と言葉が決まる", () => {
    expect(slotFace({ state: "chosen" }, x)).toEqual({ kind: "chosen", word: "予定中" });
    expect(slotFace({ state: "free" }, x)).toEqual({ kind: "free", word: "〜11:00" });
    expect(slotFace({ state: "tight", gap: 5 }, x)).toEqual({ kind: "tight", word: "あき5分" });
    expect(slotFace({ state: "conflict", with: [] }, x)).toEqual({ kind: "conflict", word: "重なる" });
    expect(slotFace({ state: "moved" }, x)).toEqual({ kind: "moved", word: "入れ替え" });
  });

  it("空きで絞っていて外れる回は、状態より「時間外」を出す", () => {
    expect(slotFace({ state: "conflict", with: [] }, x, { outside: true })).toEqual({ kind: "outside", word: "時間外" });
    expect(slotFace({ state: "free" }, x, { outside: true })).toEqual({ kind: "outside", word: "時間外" });
  });

  it("選択中は空きの外でも選択中のまま", () => {
    expect(slotFace({ state: "chosen" }, x, { outside: true }).kind).toBe("chosen");
  });

  it("特別回の札は、入る回の言葉として出す", () => {
    expect(slotFace({ state: "free" }, x, { special: "初回" })).toEqual({ kind: "free", word: "初回" });
  });
});

describe("choose", () => {
  it("空いていれば足して時刻順に並べる", () => {
    const r = choose([pick("a", "d1", "13:00")], pick("b", "d1", "11:20"));
    expect(r.plan.map((x) => x.start)).toEqual(["11:20", "13:00"]);
    expect(r.removed).toEqual([]);
  });

  it("同じ公演の別の回を選ぶと入れ替える（日をまたいでも1公演1回）", () => {
    const r = choose([pick("c", "d1", "12:00")], pick("c", "d2", "10:00"));
    expect(r.plan).toEqual([pick("c", "d2", "10:00")]);
    expect(r.removed.map((x) => x.day)).toEqual(["d1"]);
  });

  it("重なる予定は外して入れる", () => {
    const r = choose([pick("a", "d1", "10:00"), pick("c", "d1", "12:00")], pick("b", "d1", "10:30"));
    expect(r.plan.map((x) => x.showId)).toEqual(["b", "c"]);
    expect(r.removed.map((x) => x.showId)).toEqual(["a"]);
  });

  it("購入済みの印は、同じ回を選び直しても消さない", () => {
    const r = choose([{ ...pick("a", "d1", "10:00"), bought: true }], pick("a", "d1", "10:00"));
    expect(r.plan[0].bought).toBe(true);
  });
});

describe("gapsOf / fitsGap", () => {
  const plan = [pick("a", "d1", "10:00"), pick("c", "d1", "12:00")];

  it("日の枠（open〜close）の中で、予定のあいだの空きを出す", () => {
    const g = gapsOf(plan, "d1", { open: "10:00", close: "20:00" });
    expect(g.map((x) => [toHHMM(x.a), toHHMM(x.b)])).toEqual([
      ["11:00", "12:00"],
      ["14:00", "20:00"],
    ]);
  });

  it("予定が無い日は丸ごと空き", () => {
    expect(gapsOf([], "d2", { open: "10:00", close: "20:00" })).toHaveLength(1);
  });

  it("前後に移動時間を取って入る回だけを fit とする", () => {
    const [g] = gapsOf(plan, "d1", { open: "10:00", close: "20:00" });
    expect(fitsGap({ start: "11:05", end: "11:50" }, g, 10)).toBe(false); // 前が5分
    expect(fitsGap({ start: "11:10", end: "11:50" }, g, 10)).toBe(true);
    expect(fitsGap({ start: "11:10", end: "11:55" }, g, 10)).toBe(false); // 後ろが5分
  });

  it("日の始まり・終わりの側には移動時間を求めない", () => {
    const [g] = gapsOf([], "d1", { open: "10:00", close: "20:00" });
    expect(fitsGap({ start: "10:00", end: "20:00" }, g, 10)).toBe(true);
  });
});

describe("summarize", () => {
  it("日ごとの公演数・料金・謎解き時間と、全体の合計・購入済みを数える", () => {
    const plan = [
      { ...pick("a", "d1", "10:00"), bought: true },
      pick("c", "d2", "10:00"),
      { day: "d1", start: "12:00", end: "13:00", label: "ごはん" },
    ];
    const s = summarize(plan, shows);
    expect(s.days.d1).toEqual({ count: 1, price: 2000, minutes: 60 });
    expect(s.days.d2).toEqual({ count: 1, price: 4000, minutes: 120 });
    expect(s.total).toEqual({ count: 2, price: 6000, bought: 1 });
  });

  it("特別料金の回はその料金で数える", () => {
    const sp = [{ id: "o", price: 2500, special: { "19:25": { price: 1000 } }, slots: { d1: [{ start: "19:25", end: "19:55" }] } }];
    expect(summarize([{ showId: "o", day: "d1", start: "19:25", end: "19:55" }], sp).total.price).toBe(1000);
  });
});

describe("当日", () => {
  const fes = { year: 2026, days: [{ id: "12-12" }, { id: "12-13" }] };
  it("会期中なら日と分を返す", () => {
    expect(festivalNow(new Date(2026, 11, 12, 10, 30), fes)).toEqual({ day: "12-12", min: 630 });
    expect(festivalNow(new Date(2026, 11, 14, 10, 30), fes)).toBeNull();
  });

  it("いま・次を分ける", () => {
    const plan = [pick("a", "d1", "10:00"), pick("c", "d1", "12:00")];
    const r = nowNext(plan, { day: "d1", min: toMinutes("10:30") });
    expect(r.current.showId).toBe("a");
    expect(r.next.showId).toBe("c");
    expect(r.untilNext).toBe(90);
  });
});

describe("planToText", () => {
  it("日ごとに時刻順のテキストにする", () => {
    const plan = [pick("c", "d1", "12:00"), pick("a", "d1", "10:00"), { day: "d1", start: "11:00", end: "11:30", label: "ごはん" }];
    const txt = planToText(plan, shows, [{ id: "d1", label: "12/12", weekday: "土" }]);
    expect(txt).toBe(
      ["■ 12/12(土)", "10:00-11:00 A（2F 201）", "11:00-11:30 ごはん", "12:00-14:00 C（11F ホール①）"].join("\n"),
    );
  });
});
