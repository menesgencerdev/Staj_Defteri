export function createGunlukReminderNotificationModule({
  state,
  auth,
  diaryId,
  dataService,
  $,
  setHidden,
  toYmd,
  escapeHTML,
  renderCalendar
}) {
  state.reminderAlertMode = "day";
  state.reminderAlertRows = [];
  state.reminderAlertQueue = [];
  const toast = (message, type = "info", timeoutMs = 3800) => {
    if (typeof window !== "undefined" && typeof window.notify === "function") {
      window.notify(String(message || ""), type, timeoutMs);
      return;
    }
    if (typeof window !== "undefined" && typeof window.alert === "function") {
      window.alert(String(message || ""));
    }
  };

  function remindersVisibleForCurrentRole() {
    return !(state.isInstructor && !state.isPersonal);
  }

  function reminderStorageKey(reminderId, type = "read") {
    return `reminder:${type}:${diaryId}:${reminderId}`;
  }

  function dayMuteKeyForRow(row) {
    const rid = String(row?.reminderId || row?.id || "");
    return reminderStorageKey(`${rid}:${toYmd(new Date())}`, "mute");
  }

  function deletedReminderIdsKey() {
    const uid = auth.currentUser?.uid || "anon";
    return `reminder:deleted:${diaryId}:${uid}`;
  }

  function readDeletedReminderIds() {
    try {
      const raw = localStorage.getItem(deletedReminderIdsKey());
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? new Set(arr.map((x) => String(x || "")).filter(Boolean)) : new Set();
    } catch {
      return new Set();
    }
  }

  function writeDeletedReminderIds(setObj) {
    try {
      const arr = Array.from(setObj || []).filter(Boolean);
      localStorage.setItem(deletedReminderIdsKey(), JSON.stringify(arr));
    } catch (e) {
      console.warn("Silinen hatirlatici id listesi yazilamadi:", e);
    }
  }

  function reminderLocalStoreKey() {
    const uid = auth.currentUser?.uid || "anon";
    return `reminder:local:${diaryId}:${uid}`;
  }

  function readLocalReminders() {
    try {
      const raw = localStorage.getItem(reminderLocalStoreKey());
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function writeLocalReminders(reminders) {
    try {
      localStorage.setItem(reminderLocalStoreKey(), JSON.stringify(reminders || []));
    } catch (e) {
      console.warn("Yerel hatirlatici yazilamadi:", e);
    }
  }

  function mergeReminderSets(...sets) {
    const deletedIds = readDeletedReminderIds();
    const merged = [];
    const seen = new Set();
    for (const set of sets) {
      for (const r of (set || [])) {
        const id = String(r?.id || "");
        if (deletedIds.has(id)) continue;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        merged.push(r);
      }
    }
    return merged;
  }

  function formatYmdTr(ymd) {
    const s = String(ymd || "").trim();
    const parts = s.split("-");
    if (parts.length !== 3) return s;
    const [y, m, d] = parts;
    if (!y || !m || !d) return s;
    return `${d.padStart(2, "0")}.${m.padStart(2, "0")}.${y}`;
  }

  function getRemainingLabel(targetYmd) {
    const parts = String(targetYmd || "").split("-");
    if (parts.length !== 3) return "";
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    if (!y || !m || !d) return "";
    const target = new Date(y, m - 1, d, 0, 0, 0, 0);
    const now = new Date();
    const diffMs = target.getTime() - now.getTime();
    if (diffMs <= 0) return "Bugun";
    const totalHours = Math.floor(diffMs / 3600000);
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    if (days <= 0) return `${Math.max(1, hours)} saat kaldi`;
    return `${days} gun ${hours} saat kaldi`;
  }

  function getActiveReminders() {
    if (!remindersVisibleForCurrentRole()) return [];
    const today = toYmd(new Date());
    return (state.reminders || []).filter((r) => r?.date && r.date >= today);
  }

  function hasReminderOnDate(dateStr) {
    return getActiveReminders().some((r) => r?.date === dateStr);
  }

  function buildReminderNotifications() {
    if (!remindersVisibleForCurrentRole()) return [];
    const today = toYmd(new Date());
    const tomorrow = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      return toYmd(d);
    })();

    const dueToday = getActiveReminders().filter((r) => r?.date === today).map((r) => {
      const note = String(r.text || "Planlanan gorev").trim() || "Planlanan gorev";
      const title = `Bugun: ${formatYmdTr(today)} hatirlaticiniz`;
      const readKey = reminderStorageKey(r.id, "read");
      return {
        id: `rem_${r.id || r.createdAt || r.date}`,
        createdAt: `${today}T00:00:00`,
        isRead: localStorage.getItem(readKey) === "1",
        isReminder: true,
        kind: "today",
        reminderId: r.id,
        reminderDate: today,
        title,
        note,
        readKey,
        message: `${title}\n${note}`
      };
    });

    const todayLegacy = getActiveReminders()
      .filter((r) => r?.todayAlertDate === today && r?.date !== today)
      .map((r) => {
        const reminderDate = r.date;
        const note = String(r.text || "Planlanan gorev").trim() || "Planlanan gorev";
        const title = `Bugun hatirlatma: ${formatYmdTr(reminderDate)} tarihli gorev`;
        const readKey = reminderStorageKey(`${r.id}:today:${today}`, "read");
        return {
          id: `rem_today_${r.id || r.createdAt || r.date}`,
          createdAt: `${today}T00:00:00`,
          isRead: localStorage.getItem(readKey) === "1",
          isReminder: true,
          kind: "today",
          reminderId: r.id,
          reminderDate,
          title,
          note,
          readKey,
          message: `${title}\n${note}`
        };
      });

    const dailyRows = getActiveReminders()
      .filter((r) => r?.dailyAlert === true && r?.date > today)
      .map((r) => {
        const reminderDate = r.date;
        const note = String(r.text || "Planlanan gorev").trim() || "Planlanan gorev";
        const remaining = getRemainingLabel(reminderDate);
        const title = reminderDate === tomorrow
          ? `Yarin: ${formatYmdTr(reminderDate)}${remaining ? ` (${remaining})` : ""}`
          : `Yaklasan gorev: ${formatYmdTr(reminderDate)}${remaining ? ` (${remaining})` : ""}`;
        const readKey = reminderStorageKey(`${r.id}:daily:${today}:${reminderDate}`, "read");
        return {
          id: `rem_daily_${r.id || r.createdAt || r.date}_${today}_${reminderDate}`,
          createdAt: `${today}T00:00:00`,
          isRead: localStorage.getItem(readKey) === "1",
          isReminder: true,
          kind: reminderDate === tomorrow ? "tomorrow" : "daily",
          reminderId: r.id,
          reminderDate,
          title,
          note,
          readKey,
          message: `${title}\n${note}`
        };
      });

    return [...dueToday, ...todayLegacy, ...dailyRows].sort((a, b) => {
      const ta = new Date(a.reminderDate || a.createdAt || 0).getTime();
      const tb = new Date(b.reminderDate || b.createdAt || 0).getTime();
      return ta - tb;
    });
  }

  function renderNotifications() {
    const list = $("noti-list");
    if (!list) return;
    const rows = [...(state.reminderNotifications || []), ...(state.notifications || [])]
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    if (!rows.length) {
      list.innerHTML = `<div class="muted-text" style="font-size:0.9rem;">Yeni bildirim yok.</div>`;
      setHidden("noti-dot", true);
      return;
    }

    list.innerHTML = rows.slice(0, 30).map((n) => {
      const d = n.createdAt ? new Date(n.createdAt) : null;
      const when = d ? d.toLocaleString("tr-TR") : "";
      const unread = !n.isRead;
      const reminderTitle = n.isReminder
        ? (n.title || `Tarih: ${formatYmdTr(n.reminderDate || toYmd(new Date()))} icin hatirlaticiniz`)
        : "";
      const reminderNote = n.isReminder ? String(n.note || "").trim() : "";
      return `
        <div style="padding:8px 0; border-bottom:1px solid var(--border);">
          <div style="display:flex; gap:8px; align-items:flex-start;">
            <span style="margin-top:4px; width:8px; height:8px; border-radius:999px; background:${unread ? "#ef4444" : "#94a3b8"};"></span>
            <div style="flex:1;">
              <div style="font-size:0.9rem; font-weight:${unread ? "700" : "500"}; color:var(--text);">${escapeHTML(n.isReminder ? reminderTitle : (n.message || "Bildirim"))}</div>
              ${n.isReminder && reminderNote ? `<div style="font-size:0.86rem; color:var(--muted); margin-top:3px;">${escapeHTML(reminderNote)}</div>` : ""}
              <div style="font-size:0.78rem; color:var(--muted); margin-top:2px;">${when}</div>
            </div>
          </div>
        </div>
      `;
    }).join("");

    const hasUnread = rows.some((n) => !n.isRead);
    setHidden("noti-dot", !hasUnread);
  }

  function renderReminderAlertCurrent() {
    const list = $("reminder-alert-list");
    if (!list) return;
    const current = state.reminderAlertQueue?.[0];
    if (!current) {
      state.reminderAlertRows = [];
      setHidden("reminder-alert-modal", true);
      return;
    }

    state.reminderAlertRows = [current];
    const isToday = current?.kind === "today";
    state.reminderAlertMode = isToday ? "forever" : "day";

    const chk = $("reminder-alert-today-mute");
    const lbl = $("reminder-alert-today-label");
    setHidden("reminder-alert-today-row", false);
    if (chk) chk.checked = false;
    if (lbl) lbl.innerText = isToday ? "Bu bildirimi bir daha gosterme" : "Bu bildirimi bugunluk gosterme";

    list.innerHTML = `
      <div class="reminder-alert-item">
        <div class="reminder-alert-title">${escapeHTML(current.title || "Hatirlatici")}</div>
        <div class="reminder-alert-note">${escapeHTML(current.note || "")}</div>
      </div>
    `;

    setHidden("reminder-alert-modal", false);
  }

  function showReminderAlertModal(rows = []) {
    if (!remindersVisibleForCurrentRole()) return;
    const uniq = [];
    const seen = new Set();
    for (const n of rows) {
      const k = `${n?.reminderId || ""}_${n?.kind || ""}_${n?.reminderDate || ""}`;
      if (!n || seen.has(k)) continue;
      seen.add(k);
      uniq.push(n);
    }
    if (!uniq.length) return;
    uniq.sort((a, b) => new Date((a.reminderDate || a.createdAt || "")).getTime() - new Date((b.reminderDate || b.createdAt || "")).getTime());
    state.reminderAlertQueue = uniq;
    renderReminderAlertCurrent();
  }

  function closeReminderAlertModal() {
    const current = state.reminderAlertQueue?.[0] || null;
    const muteChecked = !!$("reminder-alert-today-mute")?.checked;

    if (muteChecked && current) {
      const mode = state.reminderAlertMode || "day";
      if (mode === "forever") {
        if (current?.kind === "today" && current?.readKey) localStorage.setItem(current.readKey, "1");
      } else {
        if (current?.readKey) localStorage.setItem(current.readKey, "1");
        localStorage.setItem(dayMuteKeyForRow(current), "1");
      }
      state.reminderNotifications = buildReminderNotifications();
      renderNotifications();
    }

    if (state.reminderAlertQueue?.length) state.reminderAlertQueue.shift();
    renderReminderAlertCurrent();
  }

  function maybeAlertDueReminders() {
    if (!remindersVisibleForCurrentRole()) return;
    const dueRows = state.reminderNotifications || [];
    const popupRows = [];

    dueRows.forEach((n) => {
      if (n?.isRead) return;
      if (localStorage.getItem(dayMuteKeyForRow(n)) === "1") return;
      const alertKey = String(n.id || `${n.reminderId || ""}_${n.title || ""}`);
      if (!alertKey) return;
      if (state.reminderAlertedIds.has(alertKey)) return;
      state.reminderAlertedIds.add(alertKey);
      popupRows.push(n);
    });

    showReminderAlertModal(popupRows);
  }

  async function readLatestReminders() {
    let cloud = [];
    let local = [];
    try {
      const data = await dataService.readDiaryData();
      cloud = Array.isArray(data?.reminders) ? data.reminders : [];
    } catch {
      // ignore
    }
    local = readLocalReminders();
    return mergeReminderSets(cloud, local);
  }

  async function saveReminders(next) {
    const today = toYmd(new Date());
    const reminders = (next || [])
      .filter((r) => r?.id && r?.date && r?.text && r.date >= today)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    writeLocalReminders(reminders);
    try {
      await dataService.mergeDiaryData({ reminders });
    } catch (e) {
      console.warn("Bulut hatirlatici kaydi basarisiz, yerel moda geciliyor:", e);
    }

    state.reminders = reminders;
    if (state.diary) state.diary.reminders = reminders;
    const deletedIds = readDeletedReminderIds();
    reminders.forEach((r) => deletedIds.delete(String(r.id || "")));
    writeDeletedReminderIds(deletedIds);
    state.reminderNotifications = buildReminderNotifications();
    renderNotifications();
  }

  function renderReminderList() {
    const list = $("reminder-list");
    if (!list) return;
    const uniq = [];
    const seen = new Set();
    for (const r of getActiveReminders()) {
      const id = String(r?.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      uniq.push(r);
    }
    const rows = uniq.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (!rows.length) {
      list.innerHTML = `<div class="muted-text">Hatirlatici yok.</div>`;
      return;
    }
    list.innerHTML = rows.map((r) => `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:8px 0; border-bottom:1px solid var(--border);">
        <div>
          <div style="font-weight:600;">${escapeHTML(r.text)}</div>
          <div class="muted-text" style="font-size:0.82rem;">
            ${escapeHTML(r.date)}
            ${r.dailyAlert ? " · Her gun hatirlat" : (r.todayAlertDate ? " · Bugun de hatirlat" : "")}
            ${r.date > toYmd(new Date()) ? ` · ${escapeHTML(getRemainingLabel(r.date))}` : ""}
          </div>
        </div>
        <button type="button" class="btn-danger" style="width:auto; padding:6px 10px;" onclick="deleteReminder('${r.id}')">Sil</button>
      </div>
    `).join("");
  }

  function openReminderModal(prefillDate = "") {
    if (!remindersVisibleForCurrentRole()) return;
    if (state.isReadOnlyMode) return;
    setHidden("reminder-modal", false);
    if ($("reminder-date")) $("reminder-date").value = prefillDate || toYmd(new Date());
    if ($("reminder-text")) $("reminder-text").value = "";
    if ($("reminder-today-toggle")) $("reminder-today-toggle").checked = false;
    renderReminderList();
  }

  function closeReminderModal() {
    setHidden("reminder-modal", true);
  }

  async function addReminder() {
    if (!remindersVisibleForCurrentRole()) return;
    if (state.isReadOnlyMode) return;
    const date = ($("reminder-date")?.value || "").trim();
    const text = ($("reminder-text")?.value || "").trim();
    const dailyToggle = !!$("reminder-today-toggle")?.checked;
    const today = toYmd(new Date());
    if (!date || !text) return toast("Tarih ve not girin.", "warn");
    if (date < today) return toast("Gecmis tarihe hatirlatici eklenemez.", "warn");

    const item = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      date,
      text,
      dailyAlert: dailyToggle,
      createdAt: new Date().toISOString(),
      createdBy: (auth.currentUser?.email || "").toLowerCase().trim()
    };

    try {
      const latest = await readLatestReminders();
      await saveReminders([...latest, item]);
    } catch (e) {
      console.error("Hatirlatici ekleme beklenmeyen hata:", e);
      const latest = Array.isArray(state.reminders) ? state.reminders : [];
      const next = [...latest, item];
      writeLocalReminders(next);
      state.reminders = next;
      if (state.diary) state.diary.reminders = next;
      state.reminderNotifications = buildReminderNotifications();
      renderNotifications();
    }

    if ($("reminder-text")) $("reminder-text").value = "";
    if ($("reminder-today-toggle")) $("reminder-today-toggle").checked = false;
    renderReminderList();
    renderCalendar();
    toast("Hatirlatici eklendi.", "success");
  }

  async function deleteReminder(id) {
    if (!remindersVisibleForCurrentRole()) return;
    if (!id) return;
    const deletedIds = readDeletedReminderIds();
    deletedIds.add(String(id));
    writeDeletedReminderIds(deletedIds);

    try {
      const latest = await readLatestReminders();
      const next = latest.filter((r) => r.id !== id);
      await saveReminders(next);
    } catch (e) {
      console.error("Hatirlatici silme beklenmeyen hata:", e);
      const latest = Array.isArray(state.reminders) ? state.reminders : [];
      const next = latest.filter((r) => r.id !== id);
      writeLocalReminders(next);
      state.reminders = next;
      if (state.diary) state.diary.reminders = next;
      state.reminderNotifications = buildReminderNotifications();
      renderNotifications();
    }

    localStorage.removeItem(reminderStorageKey(id, "read"));
    localStorage.removeItem(reminderStorageKey(`${id}:today:${toYmd(new Date())}`, "read"));
    renderReminderList();
    renderCalendar();
  }

  function openReminderForDate(dateStr, event) {
    if (!remindersVisibleForCurrentRole()) return;
    if (event?.stopPropagation) event.stopPropagation();
    if (state.isReadOnlyMode) return;
    if (dateStr < toYmd(new Date())) return;
    openReminderModal(dateStr);
  }

  async function fetchNotifications() {
    const list = $("noti-list");
    const dot = $("noti-dot");
    if (!list || !dot) return;

    try {
      const rows = (!state.isPersonal && !state.isInstructor)
        ? await dataService.listNotifications()
        : [];
      rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      state.notifications = rows;
      state.reminderNotifications = remindersVisibleForCurrentRole() ? buildReminderNotifications() : [];
      if (remindersVisibleForCurrentRole()) maybeAlertDueReminders();
      renderNotifications();
    } catch (e) {
      console.error("Bildirimler alinamadi:", e);
      list.innerHTML = `<div class="muted-text" style="font-size:0.9rem;">Bildirimler yuklenemedi.</div>`;
      setHidden("noti-dot", true);
    }
  }

  async function markNotificationsRead() {
    const unreadRemote = (!state.isInstructor && !state.isPersonal)
      ? (state.notifications || []).filter((n) => !n.isRead)
      : [];
    const unreadReminders = remindersVisibleForCurrentRole()
      ? (state.reminderNotifications || []).filter((n) => !n.isRead)
      : [];

    try {
      if (unreadRemote.length) {
        await dataService.markNotificationsRead(unreadRemote.map((n) => n.id));
        state.notifications = state.notifications.map((n) => ({ ...n, isRead: true }));
      }
      if (unreadReminders.length) {
        unreadReminders.forEach((n) => {
          const key = n.readKey || (n.reminderId ? reminderStorageKey(n.reminderId, "read") : "");
          if (key) localStorage.setItem(key, "1");
        });
        state.reminderNotifications = state.reminderNotifications.map((n) => ({ ...n, isRead: true }));
      }
      renderNotifications();
    } catch (e) {
      console.error("Bildirim okundu isaretleme hatasi:", e);
    }
  }

  function syncFromDiary(cloudReminders = []) {
    state.reminders = mergeReminderSets(cloudReminders, readLocalReminders());
    state.reminderNotifications = remindersVisibleForCurrentRole() ? buildReminderNotifications() : [];
  }

  return {
    syncFromDiary,
    hasReminderOnDate,
    openReminderModal,
    closeReminderModal,
    addReminder,
    deleteReminder,
    openReminderForDate,
    closeReminderAlertModal,
    fetchNotifications,
    markNotificationsRead,
    renderNotifications
  };
}

