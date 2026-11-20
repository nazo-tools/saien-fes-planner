import { describe, it, expect } from "vitest";
import { encodeState, decodeState, encodePlan, decodePlan, loadState, saveState, STORAGE_KEY } from "../storage.js";
import { SHOWS, FES } from "../shows.js";

const days = FES.days.map((d) => d.id);
const labels = ["ごはん", "休憩", "予約不要", "移動", "その他"];
const ctx = { shows: SHOWS, days, labels };
const slotOf = (id, day, i) => {
  const s = SHOWS.find((x) => x.id === id).slots[day][i];
  return { showId: id, day, start: s.start, end: s.end };
};

describe("保存", () => {
  const state = {
    plan: [{ ...slotOf("kyonshi", "12-12", 0), bought: true }, { day: "12-12", start: "12:00", end: "12:45", label: "ごはん" }],
    favorites: new Set(["vs"]),
    buffer: 10,
    day: "12-13",
  };

  it("保存して読み戻すと同じ内容になる", () => {
    const back = decodeState(JSON.parse(JSON.stringify(encodeState(state))), ctx);
    expect(back.plan).toEqual(state.plan);
    expect(back.favorites).toEqual(["vs"]);
    expect(back.buffer).toBe(10);
    expect(back.day).toBe("12-13");
  });

  it("実在しない公演・回、壊れた時刻は捨てる", () => {
    const raw = encodeState(state);
    raw.plan.push({ showId: "nope", day: "12-12", start: "10:00", end: "11:00" });
    raw.plan.push({ showId: "kyonshi", day: "12-12", start: "10:05", end: "11:05" });
    raw.plan.push({ day: "12-12", start: "13:00", end: "12:00", label: "ごはん" });
    raw.favorites.push("nope");
    expect(decodeState(raw, ctx).plan).toHaveLength(2);
    expect(decodeState(raw, ctx).favorites).toEqual(["vs"]);
  });

  it("形が違うものは null", () => {
    expect(decodeState(null, ctx)).toBeNull();
    expect(decodeState({ v: 99 }, ctx)).toBeNull();
  });

  it("localStorage が使えなくても落ちない", () => {
    const broken = { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); } };
    expect(loadState(broken, ctx)).toBeNull();
    expect(saveState(broken, state)).toBe(false);
  });

  it("保存先のキーに書く", () => {
    const mem = new Map();
    const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
    saveState(store, state);
    expect(mem.has(STORAGE_KEY)).toBe(true);
    expect(loadState(store, ctx).plan).toHaveLength(2);
  });
});

describe("共有URL", () => {
  it("公演の回と自分の予定を往復できる（購入済みの印は渡さない）", () => {
    const plan = [
      { ...slotOf("vs", "12-12", 1), bought: true },
      slotOf("makki", "12-13", 17),
      { day: "12-13", start: "12:00", end: "12:45", label: "予約不要" },
    ];
    const s = encodePlan(plan, ctx);
    expect(s).toMatch(/^[0-9a-z-]+$/);
    expect(decodePlan(s, ctx)).toEqual([slotOf("vs", "12-12", 1), slotOf("makki", "12-13", 17), plan[2]]);
  });

  it("空なら空文字", () => {
    expect(encodePlan([], ctx)).toBe("");
  });

  it("読めない部分は飛ばして、読めたぶんだけ返す", () => {
    const good = encodePlan([slotOf("vs", "12-12", 0)], ctx);
    expect(decodePlan(good + "zz", ctx)).toHaveLength(1);
    expect(decodePlan("garbage", ctx)).toEqual([]);
  });
});
