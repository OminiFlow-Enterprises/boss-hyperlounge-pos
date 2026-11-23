const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const BUSINESS_DAY_HOUR = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

export function businessDate(now = new Date(), hour = BUSINESS_DAY_HOUR) {
  return new Date(now.getTime() + IST_OFFSET_MS - hour * 60 * 60 * 1000).toISOString().slice(0, 10);
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
