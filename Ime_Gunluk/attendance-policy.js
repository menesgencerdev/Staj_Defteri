export const DEFAULT_ATTENDANCE_POLICY = Object.freeze({
  enabled: false,
  startDate: "",
  endDate: "",
  daysPerWeek: 5,
  weeklyFlexible: true,
  includeWeekends: false,
  weekdays: [1, 2, 3, 4, 5],
  holidays: []
});

export function normalizeDateYmd(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "";
}

export function uniqSortedDates(arr) {
  return [...new Set((arr || []).filter(Boolean))].sort();
}

export function toYmdLocal(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function getAttendancePolicyFromDoc(data = {}) {
  const weekdaysRaw = Array.isArray(data.attendanceWeekdays)
    ? data.attendanceWeekdays.map((n) => Number(n)).filter((n) => n >= 0 && n <= 6)
    : DEFAULT_ATTENDANCE_POLICY.weekdays;
  const holidays = Array.isArray(data.attendanceHolidays)
    ? data.attendanceHolidays.map(normalizeDateYmd).filter(Boolean)
    : [];

  return {
    enabled: !!data.attendancePolicyEnabled,
    startDate: normalizeDateYmd(data.attendanceStartDate || ""),
    endDate: normalizeDateYmd(data.attendanceEndDate || ""),
    daysPerWeek: Math.max(1, Math.min(7, Number(data.attendanceWeeklyTargetDays || data.attendanceDaysPerWeek || DEFAULT_ATTENDANCE_POLICY.daysPerWeek))),
    weeklyFlexible: data.attendanceWeeklyFlexible !== false,
    includeWeekends: !!data.attendanceIncludeWeekends,
    weekdays: weekdaysRaw.length ? [...new Set(weekdaysRaw)] : [...DEFAULT_ATTENDANCE_POLICY.weekdays],
    holidays: uniqSortedDates(holidays)
  };
}

export function isPlannedDateByPolicy(policy, dateOrYmd) {
  if (!policy?.enabled) return false;
  const ymd = typeof dateOrYmd === "string" ? dateOrYmd : toYmdLocal(dateOrYmd);
  if (policy.startDate && ymd < policy.startDate) return false;
  if (policy.endDate && ymd > policy.endDate) return false;
  const holidays = new Set(policy.holidays || []);
  if (holidays.has(ymd)) return false;

  const d = typeof dateOrYmd === "string" ? new Date(`${ymd}T00:00:00`) : dateOrYmd;
  const day = d.getDay();
  if (!policy.includeWeekends && (day === 0 || day === 6)) return false;
  if (policy.weeklyFlexible) return true;
  const weekdays = Array.isArray(policy.weekdays) ? policy.weekdays : [];
  if (weekdays.length && !weekdays.includes(day)) return false;
  return true;
}

export function getAttendancePolicyDateError(selectedDate, policy) {
  if (!policy?.enabled) return "";
  const ymd = toYmdLocal(selectedDate);
  if (policy.startDate && ymd < policy.startDate) return `Bu tarih staj baslangicindan once (${policy.startDate}).`;
  if (policy.endDate && ymd > policy.endDate) return `Bu tarih staj bitisinden sonra (${policy.endDate}).`;
  if ((policy.holidays || []).includes(ymd)) return "Bu tarih sinifta tatil olarak isaretlenmis.";
  const day = selectedDate.getDay();
  if (!policy.includeWeekends && (day === 0 || day === 6)) return "Hafta sonu yoklamasi bu sinifta kapali.";
  if (!policy.weeklyFlexible && (policy.weekdays || []).length && !(policy.weekdays || []).includes(day)) {
    return "Bu gun, hoca tarafindan yoklama plani disinda birakilmis.";
  }
  return "";
}

export function countPlannedDays(policy) {
  if (!policy?.startDate || !policy?.endDate) return 0;
  const start = new Date(`${policy.startDate}T00:00:00`);
  const end = new Date(`${policy.endDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;

  if (policy.weeklyFlexible) {
    const target = Math.max(1, Math.min(7, Number(policy.daysPerWeek || 5)));
    let total = 0;
    let blockEligible = 0;
    let blockCount = 0;

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const ymd = toYmdLocal(d);
      if (isPlannedDateByPolicy({ ...policy, weeklyFlexible: false, weekdays: [] }, ymd)) {
        blockEligible += 1;
      }
      blockCount += 1;
      if (blockCount === 7) {
        total += Math.min(target, blockEligible);
        blockEligible = 0;
        blockCount = 0;
      }
    }
    if (blockCount > 0) total += Math.min(target, blockEligible);
    return total;
  }

  let total = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (isPlannedDateByPolicy(policy, d)) total += 1;
  }
  return total;
}
