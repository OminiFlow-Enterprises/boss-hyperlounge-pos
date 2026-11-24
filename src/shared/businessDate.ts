const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const BUSINESS_DAY_HOUR = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

export function businessDate(now = new Date(), hour = BUSINESS_DAY_HOUR) {
  return new Date(now.getTime() + IST_OFFSET_MS - hour * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function billDateTime(now = new Date()) {
  const date = businessDate(now);
  return date === businessDate(now, 0) ? now : new Date(`${date}T23:58:00+05:30`);
}

const billDateFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric",
});
const billTimeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true,
});

export function billDateParts(iso: string) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return { date: iso.slice(0, 10), time: "" };
  return { date: billDateFormat.format(when), time: billTimeFormat.format(when).toUpperCase() };
}

export function businessDayStart(now = new Date(), hour = BUSINESS_DAY_HOUR) {
  return new Date(Date.parse(`${businessDate(now, hour)}T00:00:00.000Z`) + hour * 60 * 60 * 1000 - IST_OFFSET_MS);
}

export function businessDateRange(from?: string, to?: string) {
  const start = from || businessDate();
  const end = to || start;
  return {
    start,
    end,
    from: `${start}T00:30:00.000Z`,
    to: new Date(Date.parse(`${end}T00:30:00.000Z`) + DAY_MS - 1).toISOString(),
  };
}
