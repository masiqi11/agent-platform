import { describe, expect, test } from "bun:test";
import { addWorkingMs, workingMsBetween } from "../src";

const H = 3_600_000;
const tz = "Asia/Shanghai";

describe("working time (TSK-补10)", () => {
  test("Friday 17:00 → Monday 10:00 counts only 2 working hours", () => {
    // 2026-11-13 is a Friday. 17:00 +08:00 = 09:00Z.
    expect(workingMsBetween(new Date("2026-11-13T09:00:00Z"), new Date("2026-11-16T02:00:00Z"), tz)).toBe(2 * H);
  });
  test("adding 4 working hours on Friday 16:00 lands on Monday 11:00 local", () => {
    const d = addWorkingMs(new Date("2026-11-13T08:00:00Z"), 4 * H, tz);
    expect(d.toISOString()).toBe("2026-11-16T03:00:00.000Z");
  });
  test("weekend span is zero; same instant is zero", () => {
    expect(workingMsBetween(new Date("2026-11-14T02:00:00Z"), new Date("2026-11-15T10:00:00Z"), tz)).toBe(0);
    const t = new Date();
    expect(workingMsBetween(t, t, tz)).toBe(0);
  });
  test("custom hours and other timezones", () => {
    expect(workingMsBetween(new Date("2026-11-16T14:00:00Z"), new Date("2026-11-16T18:00:00Z"), "UTC", { days: [1], startHour: 15, endHour: 17 })).toBe(2 * H);
  });
});
