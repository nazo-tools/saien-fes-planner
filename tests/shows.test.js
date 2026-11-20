// 公演データの検算。タイムテーブルから書き写したときの取り違えを拾う。
import { describe, it, expect } from "vitest";
import { SHOWS, FES, FLOORS } from "../shows.js";
import { toMinutes } from "../planner.js";

const DAY_IDS = FES.days.map((d) => d.id);

describe("SHOWS", () => {
  it("id がかぶっていない", () => {
    const ids = SHOWS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("階と日付が実在する", () => {
    for (const s of SHOWS) {
      expect(FLOORS[s.floor], s.id).toBeTruthy();
      for (const d of Object.keys(s.slots)) expect(DAY_IDS, s.id).toContain(d);
    }
  });

  it("回の数がタイムテーブルの公演数と一致する", () => {
    for (const s of SHOWS) {
      for (const d of DAY_IDS) {
        expect(s.slots[d]?.length ?? 0, `${s.id} ${d}`).toBe(s.count[d] ?? 0);
      }
    }
  });

  it("各回の長さが所要時間と一致する（特別枠を除く）", () => {
    for (const s of SHOWS) {
      for (const [d, list] of Object.entries(s.slots)) {
        for (const x of list) {
          if (s.special?.[x.start]) continue;
          expect(toMinutes(x.end) - toMinutes(x.start), `${s.id} ${d} ${x.start}`).toBe(s.durationMin);
        }
      }
    }
  });

  it("同じ部屋（同じ列）の回どうしは重ならず、時刻順に並んでいる", () => {
    const byRoom = new Map();
    for (const s of SHOWS) {
      for (const [d, list] of Object.entries(s.slots)) {
        const k = `${d} ${s.room}${s.lane ? " " + s.lane : ""}`; // ブース⑧は2列が同時に進む
        if (!byRoom.has(k)) byRoom.set(k, []);
        byRoom.get(k).push(...list.map((x) => [toMinutes(x.start), toMinutes(x.end), s.id]));
      }
    }
    for (const [k, list] of byRoom) {
      list.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < list.length; i++) {
        expect(list[i][0] >= list[i - 1][1], `${k} ${list[i - 1][2]} と ${list[i][2]}`).toBe(true);
      }
    }
  });

  it("両日で、公式の列数どおりの公演がある", () => {
    const perDay = (d) => SHOWS.filter((s) => s.slots[d]).length;
    expect(perDay("12-12")).toBe(35);
    expect(perDay("12-13")).toBe(31);
  });
});
