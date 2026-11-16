/**
 * Working-time arithmetic for SLA / escalation timers (TSK-补10): a task blocked on Friday
 * evening must not escalate to admins over the weekend. Pure, timezone-aware via Intl.
 */
export interface WorkingHours {
  /** ISO weekdays that are working days, 1 = Monday … 7 = Sunday. */
  days: number[];
  /** Local start/end hour, [start, end). */
  startHour: number;
  endHour: number;
}

export const DEFAULT_WORKING_HOURS: WorkingHours = { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function localParts(d: Date, tz: string): { weekday: number; hour: number; minute: number } {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" });
    fmtCache.set(tz, f);
  }
  const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(String(parts.weekday)) + 1;
  return { weekday: wd, hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

function isWorking(d: Date, tz: string, wh: WorkingHours) {
  const p = localParts(d, tz);
  return wh.days.includes(p.weekday) && p.hour >= wh.startHour && p.hour < wh.endHour;
}

const STEP = 15 * 60_000;

/** Working milliseconds between two instants (15-minute resolution). */
export function workingMsBetween(start: Date, end: Date, tz: string, wh: WorkingHours = DEFAULT_WORKING_HOURS): number {
  if (end <= start) return 0;
  let total = 0;
  let t = start.getTime();
  const e = end.getTime();
  // Cap the scan at ~1 year to bound cost.
  const limit = t + 366 * 86_400_000;
  while (t < e && t < limit) {
    const next = Math.min(t + STEP, e);
    if (isWorking(new Date(t), tz, wh)) total += next - t;
    t = next;
  }
  return total;
}

/** The instant when `ms` working milliseconds have elapsed after `start`. */
export function addWorkingMs(start: Date, ms: number, tz: string, wh: WorkingHours = DEFAULT_WORKING_HOURS): Date {
  let left = ms;
  let t = start.getTime();
  const limit = t + 366 * 86_400_000;
  while (left > 0 && t < limit) {
    if (isWorking(new Date(t), tz, wh)) {
      const take = Math.min(STEP, left);
      left -= take;
      t += take;
    } else t += STEP;
  }
  return new Date(t);
}
