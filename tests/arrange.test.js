import { describe, it, expect } from "vitest";
import { arrange, explainMissing } from "../arrange.js";
import { SHOWS } from "../shows.js";
import { slotStatus } from "../planner.js";

const sl = (s) => s.split(" ").map((p) => ({ start: p.split("-")[0], end: p.split("-")[1] }));
const show = (id, d1, d2) => ({ id, title: id.toUpperCase(), slots: { ...(d1 ? { d1: sl(d1) } : {}), ...(d2 ? { d2: sl(d2) } : {}) } });

const OPTS = { days: ["d1"], buffer: 10, open: "10:00", close: "20:00" };

describe("arrange", () => {
  it("全部入るなら全部入れた案を返す", () => {
    const shows = [show("a", "10:00-11:00 13:00-14:00"), show("b", "10:30-11:30 11:20-12:20")];
    const r = arrange(shows, ["a", "b"], [], OPTS);
    expect(r.total).toBe(2);
    expect(r.plans[0].picks).toHaveLength(2);
    expect(r.plans[0].missing).toEqual([]);
  });

  it("待ち時間（最初から最後までのあき）が少ない案を先に出す", () => {
    const shows = [show("a", "10:00-11:00 13:00-14:00"), show("b", "11:20-12:20 15:00-16:00")];
    const r = arrange(shows, ["a", "b"], [], OPTS);
    const first = r.plans[0].picks.map((p) => `${p.showId}${p.start}`).sort();
    expect(first).toEqual(["a10:00", "b11:20"]);
    expect(r.plans[0].idle).toBe(20);
    for (let i = 1; i < r.plans.length; i++) expect(r.plans[i].idle).toBeGreaterThanOrEqual(r.plans[i - 1].idle);
  });

  it("最大3案まで、すべて違う組み合わせで返す", () => {
    const shows = [show("a", "10:00-10:30 11:00-11:30 12:00-12:30 13:00-13:30")];
    const r = arrange(shows, ["a"], [], OPTS);
    expect(r.plans).toHaveLength(3);
    expect(new Set(r.plans.map((p) => p.picks[0].start)).size).toBe(3);
  });

  it("移動時間より短い間隔の組み合わせは作らない", () => {
    const shows = [show("a", "10:00-11:00"), show("b", "11:05-12:00")];
    const r = arrange(shows, ["a", "b"], [], OPTS);
    expect(r.plans[0].picks).toHaveLength(1);
  });

  it("すでに入れた予定は動かさず、その予定とも重ならないようにする", () => {
    const shows = [show("a", "10:00-11:00 12:00-13:00")];
    const fixed = [{ day: "d1", start: "10:30", end: "11:30", label: "ごはん" }];
    const r = arrange(shows, ["a"], fixed, OPTS);
    expect(r.plans.map((p) => p.picks[0].start)).toEqual(["12:00"]);
    expect(r.plans[0].idle).toBe(30); // ごはん 11:30 → a 12:00
  });

  it("★の公演がすでに予定に入っていれば、組み直さずに対象から外す", () => {
    const shows = [show("a", "10:00-11:00 12:00-13:00"), show("b", "12:00-13:00")];
    const fixed = [{ showId: "a", day: "d1", start: "12:00", end: "13:00" }];
    const r = arrange(shows, ["a", "b"], fixed, OPTS);
    expect(r.total).toBe(1);
    expect(r.plans).toEqual([]); // b は a の 12:00 と重なって入らない → 入る案なし
    expect(r.best).toBe(0);
  });

  it("選んだ日の回だけを使う。2日とも選べばどちらの日の回でもよい", () => {
    const shows = [show("a", "10:00-11:00", "10:00-11:00"), show("b", "10:30-11:30", "15:00-16:00")];
    expect(arrange(shows, ["a", "b"], [], OPTS).plans[0].picks).toHaveLength(1);
    const both = arrange(shows, ["a", "b"], [], { ...OPTS, days: ["d1", "d2"] });
    expect(both.plans[0].picks).toHaveLength(2);
  });

  it("全部は入らないとき、入る数が最大の案を返し、入らなかった公演を missing に入れる", () => {
    const shows = [show("a", "10:00-12:00"), show("b", "11:00-12:00"), show("c", "14:00-15:00")];
    const r = arrange(shows, ["a", "b", "c"], [], OPTS);
    expect(r.best).toBe(2);
    expect(r.plans.every((p) => p.picks.length === 2)).toBe(true);
    expect(r.plans.map((p) => p.missing.join())).toEqual(expect.arrayContaining(["b", "a"]));
  });

  it("返した案はどれも、組み込んだ時点で重なり・移動不足がない", () => {
    const want = ["vs", "endless-train", "kanae", "stop", "makki", "merikuri", "theres-answer", "cube-world"];
    const r = arrange(SHOWS, want, [], { days: ["12-12", "12-13"], buffer: 10, open: "10:00", close: "20:00" });
    expect(r.best).toBe(want.length);
    for (const p of r.plans) {
      const acc = [];
      for (const x of p.picks) {
        expect(["free"]).toContain(slotStatus(x, acc, 10).state);
        acc.push(x);
      }
    }
  });

  it("実データで★20公演・2日でも、すぐに答えを返す", () => {
    const want = SHOWS.filter((s) => s.slots["12-12"] && s.slots["12-13"]).slice(0, 20).map((s) => s.id);
    const t = performance.now();
    const r = arrange(SHOWS, want, [], { days: ["12-12", "12-13"], buffer: 10, open: "10:00", close: "20:00" });
    expect(performance.now() - t).toBeLessThan(1500);
    expect(r.plans.length).toBeGreaterThan(0);
  });
});

describe("arrange の上限", () => {
  it("★が多すぎるときは組まずに tooMany を返す", () => {
    const shows = Array.from({ length: 21 }, (_, i) => show(`s${i}`, "10:00-10:20"));
    const r = arrange(shows, shows.map((s) => s.id), [], OPTS);
    expect(r).toMatchObject({ tooMany: true, plans: [] });
  });

  it("数だけ知りたいとき（countOnly）は並べ方を作らない", () => {
    const shows = [show("a", "10:00-11:00"), show("b", "12:00-13:00")];
    expect(arrange(shows, ["a", "b"], [], { ...OPTS, countOnly: true })).toMatchObject({ best: 2, plans: [] });
  });
});

describe("explainMissing", () => {
  it("選んだ日に回がない公演を noSlot にする", () => {
    const shows = [show("a", null, "10:00-11:00")];
    expect(explainMissing(shows, ["a"], [], OPTS).noSlot).toEqual(["a"]);
  });

  it("すでに入れた予定とだけぶつかる公演は blockedByFixed にする", () => {
    const shows = [show("a", "10:00-11:00")];
    const fixed = [{ day: "d1", start: "10:30", end: "11:30", label: "ごはん" }];
    expect(explainMissing(shows, ["a"], fixed, OPTS).blockedByFixed.map((x) => x.id)).toEqual(["a"]);
  });

  it("どれか1つをあきらめれば残りが全部入るなら、その公演を dropOne に挙げる", () => {
    const shows = [show("a", "10:00-12:00"), show("b", "11:00-12:00"), show("c", "14:00-15:00")];
    expect(explainMissing(shows, ["a", "b", "c"], [], OPTS).dropOne.sort()).toEqual(["a", "b"]);
  });
});
