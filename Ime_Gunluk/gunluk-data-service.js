export function createGunlukDataService({ diaryId, callBackend }) {
  const apiDiary = `/api/diaries/${encodeURIComponent(diaryId)}`;

  const monthBounds = (year, monthIndex) => {
    const y = Number(year);
    const m = Number(monthIndex);
    const first = `${y}-${String(m + 1).padStart(2, "0")}-01`;
    const endDay = new Date(y, m + 1, 0).getDate();
    const last = `${y}-${String(m + 1).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;
    return { first, last };
  };

  const requireBackend = () => {
    if (!callBackend) throw new Error("DATA_SERVICE_BACKEND_ROUTE_MISSING");
  };

  return {
    async readDiaryData() {
      requireBackend();
      const data = await callBackend(apiDiary);
      return data.diary || null;
    },

    async mergeDiaryData(patch) {
      requireBackend();
      if (Object.prototype.hasOwnProperty.call(patch || {}, "reminders")) {
        await callBackend(`${apiDiary}/reminders`, {
          method: "POST",
          body: JSON.stringify({ reminders: patch.reminders || [] })
        });
        return;
      }
      throw new Error("DATA_SERVICE_BACKEND_ROUTE_MISSING");
    },

    async listLogsByMonth(year, monthIndex) {
      requireBackend();
      const { first, last } = monthBounds(year, monthIndex);
      const data = await callBackend(`${apiDiary}/logs?first=${encodeURIComponent(first)}&last=${encodeURIComponent(last)}`);
      return Array.isArray(data.rows) ? data.rows : [];
    },

    async upsertLog(dateYmd, patch) {
      requireBackend();
      await callBackend(`${apiDiary}/logs/${encodeURIComponent(dateYmd)}`, {
        method: "POST",
        body: JSON.stringify({ ...(patch || {}), merge: true })
      });
    },

    async readWeeklyLog(weekStartYmd) {
      requireBackend();
      const data = await callBackend(`${apiDiary}/weekly-logs/${encodeURIComponent(weekStartYmd)}`);
      return data.row || null;
    },

    async listWeeklyLogs() {
      requireBackend();
      const data = await callBackend(`${apiDiary}/weekly-logs`);
      return Array.isArray(data.rows) ? data.rows : [];
    },

    async saveWeeklyLog(weekStartYmd, payload) {
      requireBackend();
      await callBackend(`${apiDiary}/weekly-logs/${encodeURIComponent(weekStartYmd)}`, {
        method: "POST",
        body: JSON.stringify(payload || {})
      });
    },

    async listOfficialDocs() {
      requireBackend();
      const data = await callBackend(`${apiDiary}/official-docs`);
      return Array.isArray(data.rows) ? data.rows : [];
    },

    async addOfficialDoc(payload) {
      requireBackend();
      await callBackend(`${apiDiary}/official-docs`, {
        method: "POST",
        body: JSON.stringify(payload || {})
      });
    },

    async deleteOfficialDoc(id) {
      requireBackend();
      await callBackend(`${apiDiary}/official-docs/${encodeURIComponent(id)}`, { method: "DELETE" });
    },

    async readMonthlyEvaluation(id) {
      requireBackend();
      const data = await callBackend(`${apiDiary}/monthly-evaluations/${encodeURIComponent(id)}`);
      return data.row || null;
    },

    async saveMonthlyEvaluation(id, payload) {
      requireBackend();
      await callBackend(`${apiDiary}/monthly-evaluations/${encodeURIComponent(id)}`, {
        method: "POST",
        body: JSON.stringify(payload || {})
      });
    },

    async addNotification() {
      throw new Error("DATA_SERVICE_BACKEND_ROUTE_MISSING");
    },

    async listDeletedPhotos() {
      requireBackend();
      const data = await callBackend(`${apiDiary}/deleted-photos`);
      return Array.isArray(data.rows) ? data.rows : [];
    },

    async listLogRevisions(dateYmd) {
      requireBackend();
      const data = await callBackend(`${apiDiary}/logs/${encodeURIComponent(dateYmd)}/revisions`);
      return Array.isArray(data.rows) ? data.rows : [];
    },

    async listNotifications() {
      requireBackend();
      const data = await callBackend(`${apiDiary}/notifications`);
      return Array.isArray(data.rows) ? data.rows : [];
    },

    async markNotificationsRead(ids = [], readAtIso = new Date().toISOString()) {
      requireBackend();
      const uniqIds = Array.from(new Set((ids || []).filter(Boolean)));
      await callBackend(`${apiDiary}/notifications-read`, {
        method: "POST",
        body: JSON.stringify({ ids: uniqIds, readAt: readAtIso })
      });
    }
  };
}

