import "./toast.js?v=20260404a";
import { initTheme, toggleTheme } from "./theme.js?v=20260404a";
import { createGunlukPdfActions } from "./gunluk-pdf.js";
import { createGunlukLiveChat } from "./gunluk-live-chat.js";
import { createGunlukDataService } from "./gunluk-data-service.js";
import { createGunlukReminderNotificationModule } from "./gunluk-reminders.js";
import { evaluateAttendanceScore, haversineMeters } from "./attendance-score.js";
import { getAttendancePolicyFromDoc, isPlannedDateByPolicy, getAttendancePolicyDateError as getPolicyDateError } from "./attendance-policy.js";
import { reportAppError } from "./error-center.js";
import {
  escapeHTML,
  sanitizeFileName,
  sanitizeExternalUrl,
  startOfDay,
  daysDiff,
  toYmd,
  notifySuccess,
  notifyWarn,
  notifyError
} from "./gunluk-utils.js";
import { auth, db } from "./firebase-config.js?v=20260404appcheck";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  doc,
  getDocs,
  collection,
  onSnapshot,
  query,
  orderBy,
  limit
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const diaryId = new URLSearchParams(window.location.search).get("id");
if (!diaryId) window.location.href = "panel.html";

const state = {
  diary: null,
  logs: {},
  weeklyLogs: {},
  weeklyDraftFiles: [],
  weeklyExistingUrls: [],
  weeklyPendingDeleteUrls: [],
  activeWeekStart: "",
  officialDocs: {},
  notifications: [],
  meetings: [],
  reminders: [],
  reminderNotifications: [],
  reminderAlertedIds: new Set(),
  reminderAlertRows: [],
  liveChat: {
    minimized: false,
    messages: []
  },
  chatUnsub: null,
  presenceUnsub: null,
  presenceTimer: null,
  counterpartEmail: "",
  counterpartOnline: false,
  counterpartLastSeenMs: 0,
  shiftUiReadOnly: false,
  shiftCooldownTimer: null,
  noteImageDraftFiles: [],
  noteImageExistingUrls: [],
  noteImagePendingDeleteUrls: [],
  deletedPhotos: [],
  noteImageDragIndex: -1,
  revisionsExpanded: false,
  shiftDraft: {
    morning: { file: null, location: null },
    evening: { file: null, location: null }
  },
  currentDate: new Date(),
  isReadOnlyMode: false,
  isInstructor: false,
  isPersonal: false,
  loadedLogMonths: new Set()
};

const $ = (id) => document.getElementById(id);
const setHidden = (id, hidden) => $(id)?.classList.toggle("hidden", !!hidden);
const setBtnBusy = (id, busyText, normalText, isBusy) => {
  const btn = $(id);
  if (!btn) return;
  btn.innerText = isBusy ? busyText : normalText;
  btn.disabled = !!isBusy;
};

// Theme toggle must be available even if later bootstrap steps fail.
window.toggleTheme = toggleTheme;
initTheme();

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",").pop() || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadDiaryFile(folder, file, options = {}) {
  if (!file) throw new Error("Dosya bulunamadi.");
  const dataBase64 = await fileToBase64(file);
  return await callBackend(`/api/diaries/${encodeURIComponent(diaryId)}/upload`, {
    method: "POST",
    body: JSON.stringify({
      folder,
      subdir: options.subdir || "",
      fileName: options.fileName || file.name || "file",
      contentType: file.type || options.contentType || "application/octet-stream",
      dataBase64
    })
  });
}
async function callBackend(path, options = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error("Oturum bulunamadi.");
  const token = await user.getIdToken();
  const headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${token}`
  };
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

  const response = await fetch(path, { ...options, headers });
  const raw = await response.text().catch(() => "");
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_) {
    data = {};
  }
  if (!response.ok) {
    throw new Error(data.error || raw.slice(0, 180) || "Backend istegi basarisiz.");
  }
  return data;
}

function ensureImageLightbox() {
  let box = $("image-lightbox");
  if (box) return box;

  const host = document.createElement("div");
  host.id = "image-lightbox";
  host.className = "image-lightbox hidden";
  host.innerHTML = `
    <button type="button" class="image-lightbox-close" aria-label="Kapat" onclick="closeImageLightbox()">&times;</button>
    <img id="image-lightbox-img" class="image-lightbox-img" alt="Buyuk fotograf">
  `;
  host.addEventListener("click", (e) => {
    if (e.target === host) window.closeImageLightbox();
  });
  document.body.appendChild(host);
  return host;
}

window.openImageLightbox = (src, alt = "Fotograf") => {
  if (!src) return;
  const box = ensureImageLightbox();
  const img = $("image-lightbox-img");
  if (!img) return;
  img.src = src;
  img.alt = alt || "Fotograf";
  box.classList.remove("hidden");
  document.body.classList.add("lightbox-open");
};

window.closeImageLightbox = () => {
  const box = $("image-lightbox");
  const img = $("image-lightbox-img");
  if (!box || !img) return;
  box.classList.add("hidden");
  img.src = "";
  document.body.classList.remove("lightbox-open");
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.closeImageLightbox();
});

document.addEventListener("click", (e) => {
  const img = e.target.closest("img[data-zoom-src]");
  if (!img) return;
  const src = img.getAttribute("data-zoom-src");
  if (!src) return;
  window.openImageLightbox(src, img.getAttribute("alt") || "Fotograf");
});

window.handleLogout = async () => {
  try {
    liveChat.cleanupLiveChatSubs();
    if (!state.isPersonal && state.counterpartEmail) await liveChat.setOwnPresence(false);
    await signOut(auth);
  } finally {
    window.location.href = "index.html";
  }
};

function hidePageLoadingOverlay() {
  const overlay = $("page-loading-overlay");
  if (!overlay) return;
  overlay.style.opacity = "0";
  overlay.style.transition = "opacity 220ms ease";
  window.setTimeout(() => overlay.remove(), 240);
}

async function optimizeImageFile(file, options = {}) {
  if (!file || !String(file.type || "").startsWith("image/")) return file;

  const maxWidth = Number(options.maxWidth || 1600);
  const maxHeight = Number(options.maxHeight || 1600);
  const quality = Math.max(0.4, Math.min(0.92, Number(options.quality || 0.78)));
  const outputType = "image/jpeg";

  let objectUrl = "";
  try {
    const img = await new Promise((resolve, reject) => {
      objectUrl = URL.createObjectURL(file);
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = objectUrl;
    });

    const ratio = Math.min(1, maxWidth / img.width, maxHeight / img.height);
    const width = Math.max(1, Math.round(img.width * ratio));
    const height = Math.max(1, Math.round(img.height * ratio));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, width, height);

    const blob = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b), outputType, quality);
    });
    if (!blob) return file;

    const baseName = String(file.name || `photo_${Date.now()}`).replace(/\.[a-zA-Z0-9]+$/, "");
    return new File([blob], `${baseName}.jpg`, {
      type: outputType,
      lastModified: Date.now()
    });
  } catch (e) {
    console.warn("Fotograf optimize edilemedi, orijinal dosya kullaniliyor:", e);
    return file;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function loadImageAsDataUrl(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        let w = img.width;
        let h = img.height;
        if (w > 800) {
          h *= 800 / w;
          w = 800;
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, w, h);
        resolve({ dataUrl: canvas.toDataURL("image/jpeg", 0.8), width: w, height: h });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function getLogImageUrls(log = {}) {
  const arr = Array.isArray(log.imageUrls) ? log.imageUrls.filter(Boolean) : [];
  if (arr.length) return arr.slice(0, MAX_NOTE_IMAGES);
  return log.imageUrl ? [log.imageUrl] : [];
}

function clearNoteImageDrafts() {
  (state.noteImageDraftFiles || []).forEach((item) => {
    if (item?.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(item.previewUrl);
  });
  state.noteImageDraftFiles = [];
}

function normalizePendingDeleteEntry(entry) {
  if (!entry) return null;
  if (typeof entry === "string") return { url: entry, logDate: $("modal-date-label")?.innerText || "" };
  if (typeof entry === "object" && entry.url) return { url: entry.url, logDate: entry.logDate || $("modal-date-label")?.innerText || "" };
  return null;
}


function getCombinedNoteImages() {
  const existing = (state.noteImageExistingUrls || []).map((url) => ({ kind: "existing", url }));
  const drafts = (state.noteImageDraftFiles || []).map((item) => ({ kind: "draft", file: item.file, previewUrl: item.previewUrl }));
  return [...existing, ...drafts];
}

function setCombinedNoteImages(items) {
  state.noteImageExistingUrls = items.filter((i) => i.kind === "existing").map((i) => i.url);
  state.noteImageDraftFiles = items
    .filter((i) => i.kind === "draft")
    .map((i) => ({ file: i.file, previewUrl: i.previewUrl }));
}

function renderLogImagePreview(readOnly = false) {
  const wrap = $("log-image-preview-list");
  if (!wrap) return;

  const items = getCombinedNoteImages();
  const cards = [];
  items.forEach((item, idx) => {
    const url = item.kind === "existing" ? item.url : item.previewUrl;
    cards.push(`
      <div style="position:relative; border:1px solid var(--border); border-radius:8px; overflow:hidden; min-height:84px;">
        <div
          draggable="${readOnly ? "false" : "true"}"
          ondragstart="handleNoteImageDragStart(${idx})"
          ondragover="handleNoteImageDragOver(event)"
          ondrop="handleNoteImageDrop(${idx})"
          ondragend="handleNoteImageDragEnd()"
          style="cursor:${readOnly ? "default" : "grab"};"
        >
          <img src="${url}" data-zoom-src="${url}" class="zoomable-image" alt="Gunluk fotograf" style="width:100%; height:90px; object-fit:cover;">
        </div>
        ${readOnly ? "" : `<button type="button" onclick="removeLogPhoto(${idx})" style="position:absolute; top:4px; right:4px; border:none; background:rgba(15,23,42,0.7); color:#fff; border-radius:999px; width:22px; height:22px; cursor:pointer;">x</button>`}
      </div>
    `);
  });

  wrap.innerHTML = cards.length
    ? cards.join("")
    : `<div class="muted-text" style="grid-column:1 / -1;">Fotograf yok</div>`;
  if (!readOnly && cards.length > 1) {
    wrap.innerHTML += `<div class="muted-text" style="grid-column:1 / -1; font-size:0.8rem;">Siralamak icin fotograflari surukleyip birakin.</div>`;
  }

  const total = items.length;
  const fileNameEl = $("file-name");
  if (fileNameEl) fileNameEl.innerText = `${total}/${MAX_NOTE_IMAGES} fotograf`;
}

window.removeLogPhoto = (index) => {
  const items = getCombinedNoteImages();
  const target = items[index];
  if (target?.kind === "draft" && target.previewUrl?.startsWith("blob:")) {
    URL.revokeObjectURL(target.previewUrl);
  } else if (target?.kind === "existing" && target.url) {
    state.noteImagePendingDeleteUrls = [
      ...(state.noteImagePendingDeleteUrls || []),
      { url: target.url, logDate: $("modal-date-label")?.innerText || "" }
    ];
  }
  const next = items.filter((_, i) => i !== index);
  setCombinedNoteImages(next);
  renderLogImagePreview(!!$("log-input")?.readOnly);
};

window.handleNoteImageDragStart = (index) => {
  state.noteImageDragIndex = index;
};

window.handleNoteImageDragOver = (e) => {
  e.preventDefault();
};

window.handleNoteImageDrop = (targetIndex) => {
  const fromIndex = Number(state.noteImageDragIndex);
  if (!Number.isInteger(fromIndex) || fromIndex < 0) return;
  if (fromIndex === targetIndex) return;
  const items = getCombinedNoteImages();
  const [moved] = items.splice(fromIndex, 1);
  items.splice(targetIndex, 0, moved);
  setCombinedNoteImages(items);
  renderLogImagePreview(!!$("log-input")?.readOnly);
  state.noteImageDragIndex = -1;
};

window.handleNoteImageDragEnd = () => {
  state.noteImageDragIndex = -1;
};


const SHIFT_COOLDOWN_MS = 5 * 60 * 1000;
const MORNING_LAST_HOUR = 10;
const EVENING_FIRST_HOUR = 16;
const WORK_DISTANCE_LIMIT_METERS = 250;
const WORKPLACE_BONUS_PER_SHIFT = 5;
const META_DRIFT_LIMIT_MS = 15 * 60 * 1000;
const MAX_NOTE_IMAGES = 3;
const PRESENCE_HEARTBEAT_MS = 30000;
const PRESENCE_ONLINE_WINDOW_MS = 70000;

const liveChat = createGunlukLiveChat({
  state,
  $,
  setHidden,
  db,
  auth,
  diaryId,
  doc,
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  getDocs,
  escapeHTML,
  heartbeatMs: PRESENCE_HEARTBEAT_MS,
  onlineWindowMs: PRESENCE_ONLINE_WINDOW_MS,
  callBackend
});

const dataService = createGunlukDataService({
  diaryId,
  callBackend
});

const reminderCenter = createGunlukReminderNotificationModule({
  state,
  auth,
  diaryId,
  dataService,
  $,
  setHidden,
  toYmd,
  escapeHTML,
  renderCalendar
});

const fetchNotifications = reminderCenter.fetchNotifications;
const markNotificationsRead = reminderCenter.markNotificationsRead;
const hasReminderOnDate = reminderCenter.hasReminderOnDate;

window.openReminderModal = reminderCenter.openReminderModal;
window.closeReminderModal = reminderCenter.closeReminderModal;
window.addReminder = reminderCenter.addReminder;
window.deleteReminder = reminderCenter.deleteReminder;
window.openReminderForDate = reminderCenter.openReminderForDate;
window.closeReminderAlertModal = reminderCenter.closeReminderAlertModal;

function formatMeetingDate(value) {
  const d = new Date(value || "");
  if (Number.isNaN(d.getTime())) return String(value || "");
  return d.toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" });
}

function renderMeetings() {
  const box = $("meetings-container");
  const list = $("meetings-list");
  if (!box || !list) return;
  const rows = Array.isArray(state.meetings) ? state.meetings : [];
  if (!rows.length) {
    setHidden("meetings-container", true);
    return;
  }
  setHidden("meetings-container", false);
  const today = toYmd(new Date());
  list.innerHTML = rows.map((m) => {
    const dateKey = String(m.dateKey || "");
    const isToday = dateKey === today;
    const url = sanitizeExternalUrl(m.meetingUrl || "");
    return `
      <div class="student-card" style="cursor:default; margin-bottom:10px; border-color:${isToday ? '#f59e0b' : 'var(--border)'};">
        <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:flex-start;">
          <div>
            <h4 style="margin:0 0 6px 0;">${escapeHTML(m.title || "Toplanti")}</h4>
            <div class="muted-text">${escapeHTML(formatMeetingDate(m.startsAt))}${isToday ? " | Bugun" : ""}</div>
            ${m.description ? `<p style="margin:8px 0 0 0;">${escapeHTML(m.description)}</p>` : ""}
          </div>
          ${url ? `<a class="btn-main" style="width:auto; text-decoration:none;" href="${url}" target="_blank" rel="noopener">Toplantiya Git</a>` : ""}
        </div>
      </div>
    `;
  }).join("");
}

async function fetchMeetings() {
  const data = await callBackend(`/api/diaries/${encodeURIComponent(diaryId)}/meetings`);
  state.meetings = Array.isArray(data.rows) ? data.rows : [];
  renderMeetings();
}

onAuthStateChanged(auth, async (user) => {
  if (!user) return (window.location.href = "index.html");
  try {
    await loadDiaryData();
    try {
      await fetchMeetings();
    } catch (e) {
      console.error("Toplantilar yuklenemedi:", e);
    }
    const results = await Promise.allSettled([fetchLogs(), fetchOfficialDocs(), fetchNotifications()]);
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        const names = ["fetchLogs", "fetchOfficialDocs", "fetchNotifications"];
        console.error(`Baslatma alt adimi hata verdi (${names[i]}):`, r.reason);
      }
    });
    liveChat.initLiveChat();
    hidePageLoadingOverlay();
  } catch (err) {
    reportAppError({
      code: "ERR_BOOT_01",
      error: err,
      notifyError,
      fallbackMessage: "Sistem yuklenirken bir hata olustu.",
      timeoutMs: 6000
    });
    hidePageLoadingOverlay();
  }
});

async function loadDiaryData() {
  const data = await dataService.readDiaryData();
  if (!data) return;
  state.diary = { id: diaryId, ...data };

  const myEmail = (auth.currentUser?.email || "").toLowerCase().trim();
  const instEmail = (state.diary.instructorEmail || "").toLowerCase().trim();
  const stuEmail = (state.diary.studentEmail || "").toLowerCase().trim();

  state.isPersonal = ["Kisisel", "Bireysel Gunlukler"].includes(state.diary.className) || !instEmail;
  state.isReadOnlyMode = stuEmail !== myEmail;
  state.isInstructor = !state.isPersonal && instEmail === myEmail;
  reminderCenter.syncFromDiary(Array.isArray(state.diary?.reminders) ? state.diary.reminders : []);

  if ($("diary-title-label")) $("diary-title-label").innerText = state.diary.title || (state.isPersonal ? "Kisisel Gunluk" : "Staj Gunlugu");
  applyRoleUI();
  if (!state.isPersonal) await loadMonthlySuggestion();
}

function applyRoleUI() {
  const canSeeReminderButton = !state.isReadOnlyMode && !(state.isInstructor && !state.isPersonal);
  const canStudentSetWorkLocation = !state.isPersonal && !state.isInstructor && !state.isReadOnlyMode;

  if (state.isPersonal) {
    setHidden("student-send-btn", true);
    setHidden("instructor-approve-btn", true);
    setHidden("instructor-reject-btn", true);
    setHidden("monthly-suggestion-container", true);
    setHidden("settings-btn", true);
    setHidden("reminder-btn", !canSeeReminderButton);
    setHidden("deleted-photos-btn", true);
    setHidden("official-docs-container", true);
    setHidden("temp-unlock-bar", true);
    return;
  }

  const canManage = state.isInstructor || state.diary.creatorId === auth.currentUser?.uid;
  const status = state.diary.status || "active";

  setHidden("settings-btn", !(canManage || canStudentSetWorkLocation));
  setHidden("student-send-btn", state.isReadOnlyMode || status !== "active");
  setHidden("instructor-approve-btn", !state.isInstructor || status !== "pending");
  setHidden("instructor-reject-btn", !state.isInstructor || status !== "pending");
  setHidden("add-suggestion-btn", !state.isInstructor);
  setHidden("deleted-photos-btn", !state.isInstructor);
  setHidden("reminder-btn", !canSeeReminderButton);
  setHidden("monthly-suggestion-container", false);
  updateStatusUI(status);
}

function getPrimaryLogImageUrl(log = {}) {
  if (Array.isArray(log.imageUrls) && log.imageUrls.length) return log.imageUrls[0];
  return log.imageUrl || "";
}

function maybeShowMissingAttendanceReminder() {
  if (state.isInstructor || state.isReadOnlyMode || state.isPersonal) return;
  if (!state.diary || state.diary.status !== "active") return;

  const now = new Date();
  if (now.getHours() < EVENING_FIRST_HOUR) return;

  const today = (() => {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  })();

  const attendance = state.logs[today]?.attendance || {};
  const hasMorning = !!attendance.morning?.imageUrl && !!attendance.morning?.location;
  const hasEvening = !!attendance.evening?.imageUrl && !!attendance.evening?.location;
  if (!hasMorning || hasEvening) return;

  const reminderKey = `attendance-reminder:${diaryId}:${today}`;
  if (localStorage.getItem(reminderKey) === "1") return;
  localStorage.setItem(reminderKey, "1");
  notifyWarn("Sabah yoklamasi alindi. Aksam yoklamasi hala eksik, mesai cikisinda kayit girmeyi unutma.", 5200);
}

function getMonthKey(dateObj = state.currentDate) {
  return `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}`;
}


function getWeekBoundsFromDate(dateValue) {
  const base = startOfDay(dateValue);
  const day = base.getDay() || 7;
  const start = new Date(base);
  start.setDate(base.getDate() - day + 1);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start, end, startKey: toYmd(start), endKey: toYmd(end) };
}

function canEditWeeklyLog(bounds) {
  if (state.isInstructor || state.isReadOnlyMode || state.isPersonal) return false;
  const today = startOfDay(new Date());
  const friday = new Date(bounds.start);
  friday.setDate(bounds.start.getDate() + 4);
  return today >= friday && today <= startOfDay(bounds.end);
}

function getWeeklyLogEditMessage(bounds) {
  if (state.isPersonal) return "Kisisel gunlukte haftalik staj kaydi yok.";
  if (state.isInstructor || state.isReadOnlyMode) return "Bu haftalik kaydi sadece ogrenci duzenleyebilir.";
  const today = startOfDay(new Date());
  const friday = new Date(bounds.start);
  friday.setDate(bounds.start.getDate() + 4);
  if (today < friday) return "Haftalik kayit en erken o haftanin cuma gunu yapilabilir.";
  if (today > startOfDay(bounds.end)) return "Bu haftanin haftalik kayit suresi doldu.";
  return "";
}

function clearWeeklyDrafts() {
  (state.weeklyDraftFiles || []).forEach((item) => {
    if (item?.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(item.previewUrl);
  });
  state.weeklyDraftFiles = [];
}

function getCombinedWeeklyImages() {
  const existing = (state.weeklyExistingUrls || []).map((url) => ({ kind: "existing", url }));
  const drafts = (state.weeklyDraftFiles || []).map((item) => ({ kind: "draft", ...item }));
  return [...existing, ...drafts].slice(0, 5);
}

function renderWeeklyImagePreview() {
  const wrap = $("weekly-image-preview-list");
  if (!wrap) return;
  const readOnly = !canEditWeeklyLog(getWeekBoundsFromDate(state.activeWeekStart || new Date()));
  wrap.innerHTML = getCombinedWeeklyImages().map((item, idx) => {
    const url = item.kind === "existing" ? item.url : item.previewUrl;
    return `<div style="position:relative; border:1px solid var(--border); border-radius:10px; overflow:hidden; background:var(--card);">
      <img src="${url}" data-zoom-src="${url}" class="zoomable-image" alt="Haftalik fotograf" style="width:100%; height:82px; object-fit:cover;">
      ${readOnly ? "" : `<button type="button" onclick="removeWeeklyPhoto(${idx})" style="position:absolute; top:4px; right:4px; border:none; background:rgba(15,23,42,0.7); color:#fff; border-radius:999px; width:22px; height:22px; cursor:pointer;">x</button>`}
    </div>`;
  }).join("");
  const count = getCombinedWeeklyImages().length;
  if ($("weekly-file-name")) $("weekly-file-name").innerText = `${count}/5 fotograf`;
}

async function fetchLogs() {
  if (!state.loadedWeeklyLogs) {
    try {
      const weeklyRows = await dataService.listWeeklyLogs();
      state.weeklyLogs = {};
      weeklyRows.forEach((row) => { const { id, ...rest } = row; state.weeklyLogs[id] = rest; });
      state.loadedWeeklyLogs = true;
    } catch (e) { console.warn("Haftalik kayitlar alinamadi:", e); }
  }
  const year = state.currentDate.getFullYear();
  const month = state.currentDate.getMonth();
  const monthKey = getMonthKey(state.currentDate);
  if (state.loadedLogMonths.has(monthKey)) {
    renderCalendar();
    maybeShowMissingAttendanceReminder();
    return;
  }

  try {
    const rows = await dataService.listLogsByMonth(year, month);
    rows.forEach((row) => {
      const { id, ...rest } = row;
      state.logs[id] = rest;
    });
    state.loadedLogMonths.add(monthKey);
    renderCalendar();
    maybeShowMissingAttendanceReminder();
  } catch (e) {
    reportAppError({
      code: "ERR_LOGS_FETCH_01",
      error: e,
      notifyError,
      fallbackMessage: "Gunluk kayitlari alinamadi."
    });
    renderCalendar();
  }
}

function isOfficialDocsLocked() {
  if (!state.diary) return true;
  return state.diary.status === "approved" || state.isInstructor || state.isReadOnlyMode;
}

async function fetchOfficialDocs() {
  try {
    const rows = await dataService.listOfficialDocs();
    state.officialDocs = {};
    rows.forEach((d) => { state.officialDocs[d.id] = d; });
    renderOfficialDocs();
  } catch (e) {
    reportAppError({
      code: "ERR_DOC_LIST_01",
      error: e,
      notifyError,
      fallbackMessage: "Resmi evraklar alinamadi."
    });
  }
}

function renderOfficialDocs() {
  const list = $("official-docs-list");
  if (!list) return;

  const isLocked = isOfficialDocsLocked();
  setHidden("official-doc-upload-box", isLocked);
  setHidden("official-doc-lock-text", !isLocked || state.isInstructor);

  const docs = Object.values(state.officialDocs)
    .sort((a, b) => new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0));

  if (!docs.length) {
    list.innerHTML = `<div class="empty-doc-box">Henuz yuklenmis resmi evrak yok.</div>`;
    return;
  }

  list.innerHTML = docs.map((item) => {
    const dateStr = item.uploadedAt ? new Date(item.uploadedAt).toLocaleString("tr-TR") : "";
    const encodedPath = encodeURIComponent(String(item.storagePath || ""));
    const encodedUrl = encodeURIComponent(String(item.url || ""));
    const safeUrl = sanitizeExternalUrl(item.url || "");
    const delBtn = isLocked ? "" : `<button class="btn-delete-doc" onclick="handleDeleteOfficialDoc('${item.id}', '${encodedPath}', '${encodedUrl}')">Kaldir</button>`;
    return `
      <div class="official-doc-item">
        <div>
          <div style="font-weight:bold; color:#1e293b;">${escapeHTML(item.type || "Belge")}</div>
          <div style="font-size:0.92rem; color:#64748b; margin-top:4px;">${escapeHTML(item.fileName || "Dosya")}</div>
          <div style="font-size:0.8rem; color:#94a3b8; margin-top:4px;">${dateStr}</div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <a href="${safeUrl || "#"}" target="_blank" rel="noopener noreferrer" class="btn-link-doc">Goruntule</a>
          <a href="${safeUrl || "#"}" download class="btn-link-doc">Indir</a>
          ${delBtn}
        </div>
      </div>
    `;
  }).join("");
}

window.handleUploadOfficialDoc = async () => {
  if (isOfficialDocsLocked()) return notifyWarn("Bu gunluk onaylandigi icin yeni evrak ekleyemezsiniz.");

  const fileInput = $("official-doc-file");
  const type = $("official-doc-type")?.value || "Diger";
  const file = fileInput?.files?.[0];
  if (!file) return notifyWarn("Lutfen bir dosya secin.");

  setBtnBusy("upload-official-doc-btn", "Yukleniyor...", "Yukle", true);
  try {
    const uploaded = await uploadDiaryFile("officialDocs", file, {
      fileName: file.name,
      contentType: file.type || "application/octet-stream"
    });
    const { url, storagePath } = uploaded;

    await dataService.addOfficialDoc({
      type,
      fileName: file.name,
      fileType: file.type,
      url,
      storagePath,
      uploadedAt: new Date().toISOString(),
      uploadedBy: auth.currentUser?.email || ""
    });

    if (fileInput) fileInput.value = "";
    await fetchOfficialDocs();
    notifySuccess("Evrak basariyla yuklendi.");
  } catch (e) {
    reportAppError({
      code: "ERR_DOC_UPLOAD_01",
      error: e,
      notifyError,
      fallbackMessage: "Evrak yuklenirken hata olustu."
    });
  } finally {
    setBtnBusy("upload-official-doc-btn", "Yukleniyor...", "Yukle", false);
  }
};

window.handleDeleteOfficialDoc = async (docId, storagePathEnc, fileUrlEnc = "") => {
  if (isOfficialDocsLocked()) return notifyWarn("Bu gunluk onaylandigi icin evrak silemezsiniz.");
  if (!confirm("Bu evragi kaldirmak istiyor musunuz?")) return;

  try {
    await dataService.deleteOfficialDoc(docId);
    await fetchOfficialDocs();
  } catch (e) {
    reportAppError({
      code: "ERR_DOC_DELETE_01",
      error: e,
      notifyError,
      fallbackMessage: "Evrak silinirken hata olustu."
    });
  }
};

function renderCalendar() {
  const grid = $("calendar-grid");
  if (!grid) return;
  grid.innerHTML = "";
  const canUseReminderUi = !state.isReadOnlyMode && !(state.isInstructor && !state.isPersonal);
  const attendancePolicy = getAttendancePolicyFromDoc(state.diary || {});
  const isAttendancePlannedDay = (dateStr) => {
    if (state.isPersonal) return false;
    if (!attendancePolicy.enabled) return false;
    if (attendancePolicy.weeklyFlexible) return false;
    if (!isPlannedDateByPolicy(attendancePolicy, dateStr)) return false;
    return true;
  };

  const y = state.currentDate.getFullYear();
  const m = state.currentDate.getMonth();
  if ($("month-year")) {
    $("month-year").innerText = new Intl.DateTimeFormat("tr-TR", { month: "long", year: "numeric" }).format(state.currentDate);
  }

  const firstDay = new Date(y, m, 1).getDay();
  const skipDays = firstDay === 0 ? 6 : firstDay - 1;
  for (let i = 0; i < skipDays; i++) grid.innerHTML += `<div class="day empty-day"></div>`;

  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const today = new Date();
  const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const jsDay = new Date(y, m, d).getDay();
    const isWeekend = jsDay === 0 || jsDay === 6;
    const isToday = dateStr === todayYmd;
    const isPast = dateStr < todayYmd;
    const hasLog = !!state.logs[dateStr];
    const hasReminder = canUseReminderUi ? hasReminderOnDate(dateStr) : false;
    const isAbsent = isPast && !hasLog && isAttendancePlannedDay(dateStr);
    const weekBounds = getWeekBoundsFromDate(new Date(y, m, d));
    const hasWeeklyLog = !!state.weeklyLogs?.[weekBounds.startKey];
    const showWeeklyButton = !state.isPersonal && jsDay === 0;
    const day = document.createElement("div");
    day.className = `day${hasLog ? " has-content" : ""}${hasReminder ? " has-reminder" : ""}${isWeekend ? " weekend" : ""}${isToday ? " today" : ""}${isPast ? " past" : ""}${isAbsent ? " absent-day" : ""}`;
    day.innerHTML = `
      <span>${d}</span>
      ${isPast || !canUseReminderUi ? "" : `<button type="button" class="day-reminder-btn" onclick="openReminderForDate('${dateStr}', event)" title="Hatirlatici">${hasReminder ? "Hat" : "+"}</button>`}
      ${showWeeklyButton ? `<button type="button" class="day-weekly-btn${hasWeeklyLog ? " has-weekly" : ""}" onclick="openWeeklyModal('${weekBounds.startKey}', event)" title="Haftalik Notlar">H</button>` : ""}
    `;
    day.onclick = () => window.openLogModal(dateStr);
    grid.appendChild(day);
  }
}

async function fetchDeletedPhotos() {
  if (!state.isInstructor) return [];
  try {
    const rows = await dataService.listDeletedPhotos();
    state.deletedPhotos = rows;
    return rows;
  } catch (e) {
    console.error("Silinen fotograflar alinamadi:", e);
    state.deletedPhotos = [];
    return [];
  }
}
function renderDeletedPhotosList() {
  const list = $("deleted-photos-list");
  if (!list) return;
  const rows = state.deletedPhotos || [];
  if (!rows.length) {
    list.innerHTML = `<div class="muted-text">Silinen fotograf kaydi yok.</div>`;
    return;
  }
  list.innerHTML = rows.map((row) => {
    const when = row.deletedAt ? new Date(row.deletedAt).toLocaleString("tr-TR") : "";
    return `
      <div style="border:1px solid var(--border); border-radius:10px; padding:10px; margin-bottom:10px; background:var(--hover);">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
          <div>
            <div style="font-weight:700;">Tarih: ${escapeHTML(row.logDate || "-")}</div>
            <div class="muted-text" style="font-size:0.82rem; margin-top:2px;">Silinme: ${escapeHTML(when)}</div>
            <div class="muted-text" style="font-size:0.82rem;">Silen: ${escapeHTML(row.deletedByEmail || "-")}</div>
          </div>
          <img src="${row.imageUrl}" data-zoom-src="${row.imageUrl}" class="zoomable-image" alt="Silinen fotograf" style="width:90px; height:90px; object-fit:cover; border-radius:8px; border:1px solid var(--border);">
        </div>
      </div>
    `;
  }).join("");
}

window.openDeletedPhotosModal = async () => {
  if (!state.isInstructor) return;
  const list = $("deleted-photos-list");
  if (list) list.innerHTML = `<div class="muted-text">Yukleniyor...</div>`;
  setHidden("deleted-photos-modal", false);
  await fetchDeletedPhotos();
  renderDeletedPhotosList();
};

window.closeDeletedPhotosModal = () => setHidden("deleted-photos-modal", true);

function getTempBypass(dateStr, diffDays) {
  const until = state.diary?.tempUnlockUntil;
  if (!until || new Date(until) <= new Date()) return false;
  const type = state.diary.tempUnlockType;
  const value = state.diary.tempUnlockValue;
  if (type === "all") return true;
  if (type === "range") return diffDays <= Number(value);
  if (type === "date") return dateStr === value;
  if (type === "shift-today") return dateStr === value;
  return false;
}

function getShiftTodayBypass(dateStr = $("modal-date-label")?.innerText || "") {
  const until = state.diary?.tempUnlockUntil;
  if (!until || new Date(until) <= new Date()) return false;
  const today = toYmd(new Date());
  return state.diary?.tempUnlockType === "shift-today" && String(dateStr || "") === today && String(state.diary?.tempUnlockValue || "") === today;
}

function getLogEditState(dateStr) {
  const selected = startOfDay(dateStr);
  const today = startOfDay(new Date());
  const isFuture = selected > today;

  if (isFuture) return { readOnly: true, message: "Gelecekteki bir tarihe not ekleyemezsiniz." };
  if (state.isPersonal) return { readOnly: false, message: "" };
  if (state.isInstructor) return { readOnly: true, message: "Ogretmenler gunluk metnini degistiremez." };
  if (state.isReadOnlyMode) return { readOnly: true, message: "" };

  const diff = daysDiff(today, selected);
  const bypass = getTempBypass(dateStr, diff);
  if (!bypass && state.diary.status !== "active") {
    return { readOnly: true, message: "Bu tarih duzenlemeye kapatilmistir." };
  }

  const lockDays = Number(state.diary.lockDays || 0);
  const lockEnabled = state.diary.isLocked === true && lockDays > 0;
  if (!bypass && lockEnabled && diff >= lockDays) {
    return { readOnly: true, message: "Bu tarih duzenlemeye kapatilmistir." };
  }
  return { readOnly: false, message: "" };
}

function formatLocationText(location) {
  if (!location || typeof location.lat !== "number" || typeof location.lng !== "number") return "Konum yok";
  const acc = Number.isFinite(location.accuracy) ? ` | +/-${Math.round(location.accuracy)}m` : "";
  return `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}${acc}`;
}

function setShiftPreview(type, imageUrl) {
  const img = $(`${type}-photo-preview`);
  const empty = $(`${type}-photo-empty`);
  if (!img || !empty) return;
  if (imageUrl) {
    img.src = imageUrl;
    img.setAttribute("data-zoom-src", imageUrl);
    img.classList.add("zoomable-image");
    img.classList.remove("hidden");
    empty.classList.add("hidden");
  } else {
    img.src = "";
    img.removeAttribute("data-zoom-src");
    img.classList.remove("zoomable-image");
    img.classList.add("hidden");
    empty.classList.remove("hidden");
  }
}

function setShiftLocationText(type, location) {
  const el = $(`${type}-location-text`);
  if (el) el.innerText = formatLocationText(location);
}


function formatRevisionTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("tr-TR");
}

async function loadAndRenderLogRevisions(dateStr) {
  const box = $("log-revisions-box");
  const list = $("log-revisions-list");
  const toggle = $("log-revisions-toggle");
  const count = $("log-revisions-count");
  if (!box || !list || !toggle || !count) return;

  try {
    const items = await dataService.listLogRevisions(dateStr);

    if (!items.length) {
      box.classList.add("hidden");
      list.innerHTML = "";
      return;
    }

    box.classList.remove("hidden");
    count.innerText = `${items.length} kayit`;
    toggle.innerText = state.revisionsExpanded ? "Revizyon Gecmisi (Gizle)" : "Revizyon Gecmisi (Goster)";
    list.innerHTML = items.slice(0, 8).map((item) => {
      const fields = Array.isArray(item.changedFields) ? item.changedFields.join(", ") : "-";
      return `
        <div style="padding:8px 10px; border:1px solid var(--border); border-radius:8px; margin-top:8px; background:var(--card-bg);">
          <div style="font-size:0.82rem; color:var(--secondary);">${formatRevisionTime(item.createdAt)}</div>
          <div style="font-weight:600; font-size:0.9rem; margin-top:2px;">${escapeHTML(item.actorEmail || "-")}</div>
          <div style="font-size:0.82rem; color:var(--secondary); margin-top:2px;">Degisenler: ${escapeHTML(fields)}</div>
        </div>
      `;
    }).join("");
    list.classList.toggle("hidden", !state.revisionsExpanded);
  } catch (e) {
    console.error("Revizyonlar yuklenemedi:", e);
    box.classList.add("hidden");
    list.innerHTML = "";
  }
}

window.toggleLogRevisions = () => {
  state.revisionsExpanded = !state.revisionsExpanded;
  const list = $("log-revisions-list");
  const toggle = $("log-revisions-toggle");
  if (list) list.classList.toggle("hidden", !state.revisionsExpanded);
  if (toggle) toggle.innerText = state.revisionsExpanded ? "Revizyon Gecmisi (Gizle)" : "Revizyon Gecmisi (Goster)";
};


function renderShiftMetaWarning(type, entry) {
  const el = $(`${type}-meta-warning`);
  if (!el) return;
  const meta = entry?.meta || {};
  if (meta.flagged) {
    const min = typeof meta.driftMinutes === "number" ? ` (~${meta.driftMinutes} dk)` : "";
    el.innerText = `Meta uyari: cekim-yukleme zaman farki yuksek${min}.`;
    el.classList.remove("hidden");
    return;
  }
  el.innerText = "";
  el.classList.add("hidden");
}

function renderShiftProofSection(log, readOnly) {
  const required = !!state.diary?.requireShiftProof;
  const dateError = getDateEligibilityError();
  const shiftReadOnly = !!readOnly || !!dateError;
  const badge = $("shift-proof-badge");
  const hint = $("shift-proof-hint");
  if (badge) {
    badge.innerText = required ? "Zorunlu" : "Opsiyonel";
    badge.style.background = required ? "#fee2e2" : "#e2e8f0";
    badge.style.color = required ? "#991b1b" : "#334155";
  }
  if (hint) {
    const base = required
      ? "Kaydetmeden once sabah/aksam fotograf ve konum doldurulmalidir. Sabah en gec 10:00, aksam en erken 16:00."
      : "Bu alan ogrencide her zaman gorunur. Sabah en gec 10:00, aksam en erken 16:00. Tekrar cekim: 5 dk. Ilk cekim referans konum kabul edilir.";
    hint.innerText = dateError ? `${base} ${dateError}` : base;
  }

  const attendance = log?.attendance || {};
  const morning = attendance.morning || {};
  const evening = attendance.evening || {};

  state.shiftDraft.morning = { file: null, location: morning.location || null, capturedAt: morning.capturedAt || null };
  state.shiftDraft.evening = { file: null, location: evening.location || null, capturedAt: evening.capturedAt || null };

  setShiftPreview("morning", morning.imageUrl || "");
  setShiftPreview("evening", evening.imageUrl || "");
  setShiftLocationText("morning", state.shiftDraft.morning.location);
  setShiftLocationText("evening", state.shiftDraft.evening.location);
  renderShiftMetaWarning("morning", morning);
  renderShiftMetaWarning("evening", evening);

  ["morning", "evening"].forEach((type) => {
    const input = $(`${type}-photo-input`);
    if (input) input.disabled = !!shiftReadOnly;
  });
  startShiftCooldownTicker(shiftReadOnly);
}

function getSelectedLogDate() {
  const raw = $("modal-date-label")?.innerText;
  return raw ? startOfDay(raw) : null;
}

function isTodayDate(dateObj) {
  if (!dateObj) return false;
  return dateObj.getTime() === startOfDay(new Date()).getTime();
}

function getAttendancePolicyDateError(selectedDate) {
  const policy = getAttendancePolicyFromDoc(state.diary || {});
  return getPolicyDateError(selectedDate, policy);
}

function getDateEligibilityError() {
  const selectedDate = getSelectedLogDate();
  if (!selectedDate) return "Tarih bilgisi alinamadi.";
  if (!isTodayDate(selectedDate)) {
    return "Yoklama fotograflari yalnizca bugunun tarihi icin eklenebilir.";
  }
  const policyError = getAttendancePolicyDateError(selectedDate);
  if (policyError) return policyError;
  return "";
}

function getCaptureTimeError(type, now = new Date()) {
  const dateError = getDateEligibilityError();
  if (dateError) return dateError;
  if (getShiftTodayBypass()) return "";

  const hour = now.getHours();
  const minute = now.getMinutes();
  const minutesOfDay = hour * 60 + minute;

  if (type === "morning" && minutesOfDay > MORNING_LAST_HOUR * 60) {
    return "Sabah ise giris fotografi en gec 10:00'a kadar cekilebilir.";
  }
  if (type === "evening" && minutesOfDay < EVENING_FIRST_HOUR * 60) {
    return "Aksam isten cikis fotografi en erken 16:00'dan sonra cekilebilir.";
  }
  return "";
}

function getLastCapturedAt(type) {
  const draftCaptured = state.shiftDraft?.[type]?.capturedAt;
  if (draftCaptured) return new Date(draftCaptured);
  const dateStr = $("modal-date-label")?.innerText;
  const existing = dateStr ? state.logs?.[dateStr]?.attendance?.[type]?.capturedAt : null;
  return existing ? new Date(existing) : null;
}

function getCooldownError(type, now = new Date()) {
  if (getShiftTodayBypass()) return "";
  const last = getLastCapturedAt(type);
  if (!last || Number.isNaN(last.getTime())) return "";
  const elapsed = now.getTime() - last.getTime();
  if (elapsed <= SHIFT_COOLDOWN_MS) return "";
  return "Bu alan icin degistirme suresi doldu (5 dk).";
}

function getCooldownRemainingMs(type, now = new Date()) {
  const last = getLastCapturedAt(type);
  if (!last || Number.isNaN(last.getTime())) return 0;
  const elapsed = now.getTime() - last.getTime();
  return Math.max(0, SHIFT_COOLDOWN_MS - elapsed);
}

function formatRemaining(ms) {
  const sec = Math.ceil(ms / 1000);
  const mm = String(Math.floor(sec / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function updateShiftCooldownUI() {
  ["morning", "evening"].forEach((type) => {
    const last = getLastCapturedAt(type);
    const remain = getCooldownRemainingMs(type);
    const expired = !!last && remain <= 0;
    const textEl = $(`${type}-cooldown-text`);
    const input = $(`${type}-photo-input`);
    if (textEl) {
      if (!last) textEl.innerText = "";
      else if (remain > 0) textEl.innerText = `Degistirme suresi kalan: ${formatRemaining(remain)}`;
      else textEl.innerText = "Degistirme suresi doldu.";
    }
    if (input) {
      const dateBlocked = !!getDateEligibilityError();
      const shiftBypass = getShiftTodayBypass();
      input.disabled = !!state.shiftUiReadOnly || dateBlocked || (expired && !shiftBypass);
    }
  });
}

function startShiftCooldownTicker(readOnly) {
  state.shiftUiReadOnly = !!readOnly;
  if (state.shiftCooldownTimer) clearInterval(state.shiftCooldownTimer);
  updateShiftCooldownUI();
  state.shiftCooldownTimer = window.setInterval(updateShiftCooldownUI, 1000);
}

function stopShiftCooldownTicker() {
  if (state.shiftCooldownTimer) {
    clearInterval(state.shiftCooldownTimer);
    state.shiftCooldownTimer = null;
  }
}

function getAttendanceScore(logData) {
  const attendance = logData?.attendance || {};
  const workplace = state.diary?.workLocation || null;
  const workplaceRadius = Math.max(30, Number(state.diary?.workRadiusMeters || WORK_DISTANCE_LIMIT_METERS));
  const evaluated = evaluateAttendanceScore(attendance, {
    morningPoints: 45,
    eveningPoints: 45,
    metaPenalty: 7,
    accuracyPenalty: 8,
    accuracyWarn: 80,
    useDistancePenalty: true,
    distancePenalty: 15,
    distanceLimitMeters: workplaceRadius,
    baseLocation: attendance.baseLocation || attendance.morning?.location || attendance.evening?.location || null
  });

  let bonus = 0;
  if (workplace) {
    const morningLoc = attendance.morning?.location || null;
    const eveningLoc = attendance.evening?.location || null;
    if (attendance.morning?.imageUrl && morningLoc && haversineMeters(workplace, morningLoc) <= workplaceRadius) {
      bonus += WORKPLACE_BONUS_PER_SHIFT;
    }
    if (attendance.evening?.imageUrl && eveningLoc && haversineMeters(workplace, eveningLoc) <= workplaceRadius) {
      bonus += WORKPLACE_BONUS_PER_SHIFT;
    }
  }
  const score = Math.max(0, Math.min(100, evaluated.score + bonus));
  const locationLabel = workplace && bonus > 0 ? "is yerine yakin" : evaluated.locationLabel;
  return { score, locationLabel };
}

function renderWorkLocationStatusText() {
  const statusEl = $("work-location-status-text");
  if (!statusEl) return;
  const loc = state.diary?.workLocation;
  const radius = Math.max(30, Number(state.diary?.workRadiusMeters || WORK_DISTANCE_LIMIT_METERS));
  if (!loc || !Number.isFinite(Number(loc.lat)) || !Number.isFinite(Number(loc.lng))) {
    statusEl.innerText = "Henuz kayitli is yeri konumu yok.";
    return;
  }
  const lat = Number(loc.lat).toFixed(5);
  const lng = Number(loc.lng).toFixed(5);
  statusEl.innerText = `Kayitli merkez: ${lat}, ${lng} | Yaricap: ${Math.round(radius)}m`;
}

window.openLogModal = (dateStr) => {
  const log = state.logs[dateStr] || {};
  clearNoteImageDrafts();
  state.noteImageExistingUrls = getLogImageUrls(log);
  state.noteImagePendingDeleteUrls = [];
  state.revisionsExpanded = false;
  $("modal-date-label").innerText = dateStr;
  $("log-input").value = log.content || "";
  $("log-input").placeholder = state.isPersonal ? "Bugun neler yazmak istiyorsun?" : "Bugun neler yaptin?";
  const fileInput = $("image-input");
  if (fileInput) fileInput.value = "";

  const { readOnly, message } = getLogEditState(dateStr);
  $("log-input").readOnly = readOnly;
  setHidden("save-btn", readOnly);
  setHidden("upload-section", readOnly);
  renderLogImagePreview(readOnly);
  setHidden("shift-proof-box", state.isPersonal);
  if (!state.isPersonal) renderShiftProofSection(log, readOnly);
  else stopShiftCooldownTicker();

  const warn = $("lock-warning-text");
  if (warn) {
    warn.innerText = message;
    warn.classList.toggle("hidden", !message);
  }

  loadAndRenderLogRevisions(dateStr);
  setHidden("log-modal", false);
};


window.openWeeklyModal = async (weekStartKey, event) => {
  if (event) event.stopPropagation();
  if (state.isPersonal) return;
  const bounds = getWeekBoundsFromDate(weekStartKey);
  state.activeWeekStart = bounds.startKey;
  clearWeeklyDrafts();
  const current = state.weeklyLogs[bounds.startKey] || await dataService.readWeeklyLog(bounds.startKey) || {};
  state.weeklyLogs[bounds.startKey] = current;
  state.weeklyExistingUrls = Array.isArray(current.imageUrls) ? current.imageUrls.slice(0, 5) : [];
  state.weeklyPendingDeleteUrls = [];
  if ($("weekly-title")) $("weekly-title").innerText = "Haftalik Notlar";
  if ($("weekly-range")) $("weekly-range").innerText = `${bounds.startKey} - ${bounds.endKey} haftasi`;
  if ($("weekly-input")) $("weekly-input").value = current.content || "";
  const canEdit = canEditWeeklyLog(bounds);
  const msg = getWeeklyLogEditMessage(bounds);
  if ($("weekly-input")) $("weekly-input").readOnly = !canEdit;
  setHidden("weekly-save-btn", !canEdit);
  setHidden("weekly-upload-section", !canEdit);
  setHidden("weekly-image-input", !canEdit);
  if ($("weekly-lock-warning")) {
    $("weekly-lock-warning").innerText = msg;
    setHidden("weekly-lock-warning", !msg);
  }
  renderWeeklyImagePreview();
  setHidden("weekly-modal", false);
};

window.closeWeeklyModal = () => {
  clearWeeklyDrafts();
  setHidden("weekly-modal", true);
};

window.previewWeeklyImages = (event) => {
  const files = Array.from(event.target.files || []).filter((f) => f.type?.startsWith("image/"));
  const remaining = Math.max(0, 5 - getCombinedWeeklyImages().length);
  files.slice(0, remaining).forEach((file) => {
    state.weeklyDraftFiles.push({ file, previewUrl: URL.createObjectURL(file) });
  });
  event.target.value = "";
  renderWeeklyImagePreview();
};

window.removeWeeklyPhoto = (idx) => {
  const existingCount = state.weeklyExistingUrls.length;
  if (idx < existingCount) {
    const [removed] = state.weeklyExistingUrls.splice(idx, 1);
    if (removed) state.weeklyPendingDeleteUrls.push(removed);
  } else {
    const draftIdx = idx - existingCount;
    const [removed] = state.weeklyDraftFiles.splice(draftIdx, 1);
    if (removed?.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(removed.previewUrl);
  }
  renderWeeklyImagePreview();
};

window.handleSaveWeeklyLog = async () => {
  const bounds = getWeekBoundsFromDate(state.activeWeekStart || new Date());
  if (!canEditWeeklyLog(bounds)) return notifyWarn(getWeeklyLogEditMessage(bounds) || "Haftalik kayit su an duzenlenemez.");
  const content = $("weekly-input")?.value || "";
  const finalImageUrls = [...(state.weeklyExistingUrls || [])].slice(0, 5);
  try {
    for (const item of state.weeklyDraftFiles || []) {
      if (finalImageUrls.length >= 5) break;
      const optimizedFile = await optimizeImageFile(item.file, { maxWidth: 1600, maxHeight: 1600, quality: 0.78 });
      const safeName = sanitizeFileName(optimizedFile.name || item.file.name || "weekly.jpg");
      const uploaded = await uploadDiaryFile("weeklyLogs", optimizedFile, { subdir: bounds.startKey, fileName: safeName, contentType: optimizedFile.type || "image/jpeg" });
      finalImageUrls.push(uploaded.url);
    }
    await dataService.saveWeeklyLog(bounds.startKey, {
      content,
      imageUrls: finalImageUrls,
      selectedPdfImageUrls: finalImageUrls.slice(0, 3),
      weekStart: bounds.startKey,
      weekEnd: bounds.endKey
    });
    state.weeklyLogs[bounds.startKey] = { content, imageUrls: finalImageUrls, selectedPdfImageUrls: finalImageUrls.slice(0, 3), weekStart: bounds.startKey, weekEnd: bounds.endKey };
    clearWeeklyDrafts();
    state.weeklyExistingUrls = [];
    notifySuccess("Haftalik not kaydedildi.");
    setHidden("weekly-modal", true);
    renderCalendar();
  } catch (e) {
    reportAppError({ code: "ERR_WEEKLY_SAVE_01", error: e, notifyError, fallbackMessage: "Haftalik not kaydedilemedi." });
  }
};

window.handleSaveLog = async () => {
  if (!state.isPersonal && (state.isInstructor || state.isReadOnlyMode)) return;
  const dateStr = $("modal-date-label").innerText;
  if (startOfDay(dateStr) > startOfDay(new Date())) return notifyWarn("Gelecekteki bir tarihe not kaydedilemez.");

  const content = $("log-input").value;
  const combinedItems = getCombinedNoteImages();
  setBtnBusy("save-btn", "Kaydediliyor...", "Kaydet", true);

  try {
    const prevLog = state.logs[dateStr] || null;
    const finalImageUrls = [];
    const existingAttendance = state.logs[dateStr]?.attendance || {};
    for (const item of combinedItems) {
      if (finalImageUrls.length >= MAX_NOTE_IMAGES) break;
      if (item.kind === "existing") {
        finalImageUrls.push(item.url);
        continue;
      }
      setBtnBusy("save-btn", "Fotograflar optimize ediliyor...", "Kaydet", true);
      const optimizedFile = await optimizeImageFile(item.file);
      const safeName = sanitizeFileName(optimizedFile.name || "note.jpg");
      const uploaded = await uploadDiaryFile("notePhotos", optimizedFile, { subdir: dateStr, fileName: safeName, contentType: optimizedFile.type || "image/jpeg" });
      finalImageUrls.push(uploaded.url);
    }
    const imageUrl = finalImageUrls[0] || "";

    if (state.isPersonal) {
      const nextLog = {
        content,
        imageUrl,
        imageUrls: finalImageUrls,
        updatedAt: new Date().toISOString()
      };
      await callBackend(`/api/diaries/${encodeURIComponent(diaryId)}/logs/${encodeURIComponent(dateStr)}`, {
        method: "POST",
        body: JSON.stringify({
          ...nextLog,
          merge: true,
          removedPhotos: (state.noteImagePendingDeleteUrls || []).map(normalizePendingDeleteEntry).filter((x) => x?.url)
        })
      });
      stopShiftCooldownTicker();
      clearNoteImageDrafts();
      state.noteImageExistingUrls = [];
      state.noteImagePendingDeleteUrls = [];
      if ($("image-input")) $("image-input").value = "";
      if ($("file-name")) $("file-name").innerText = "";
      setHidden("log-modal", true);
      await fetchLogs();
      notifySuccess("Kisisel not kaydedildi.");
      return;
    }

    const buildShiftEntry = async (type) => {
      const existing = existingAttendance[type] || {};
      const draft = state.shiftDraft[type] || {};
      const justCaptured = !!draft.file;
      if (!justCaptured) {
        return {
          imageUrl: existing.imageUrl || "",
          location: draft.location || existing.location || null,
          capturedAt: existing.capturedAt || null,
          uploadedAt: existing.uploadedAt || existing.capturedAt || null,
          meta: existing.meta || {
            driftMs: 0,
            driftMinutes: 0,
            flagged: false
          },
          _justCaptured: false
        };
      }

      setBtnBusy("save-btn", `${type === "morning" ? "Sabah" : "Aksam"} fotografi optimize ediliyor...`, "Kaydet", true);
      const optimized = await optimizeImageFile(draft.file);
      const safeName = `${type}_${sanitizeFileName(optimized.name || "shift.jpg")}`;
      const uploaded = await uploadDiaryFile("shiftProof", optimized, { subdir: dateStr, fileName: safeName, contentType: optimized.type || "image/jpeg" });
      const shiftImageUrl = uploaded.url;

      const uploadedAtIso = new Date().toISOString();
      const capturedAtIso = draft.capturedAt || uploadedAtIso;
      const driftMs = Math.abs(new Date(uploadedAtIso).getTime() - new Date(capturedAtIso).getTime());
      const driftMinutes = Math.round(driftMs / 60000);
      return {
        imageUrl: shiftImageUrl,
        location: draft.location || existing.location || null,
        capturedAt: capturedAtIso,
        uploadedAt: uploadedAtIso,
        meta: {
          driftMs,
          driftMinutes,
          flagged: driftMs > META_DRIFT_LIMIT_MS
        },
        _justCaptured: justCaptured
      };
    };

    const attendance = {
      morning: await buildShiftEntry("morning"),
      evening: await buildShiftEntry("evening")
    };
    const morningJustCaptured = !!attendance.morning?._justCaptured;
    const eveningJustCaptured = !!attendance.evening?._justCaptured;

    const existingBase = state.diary?.workLocation
      || existingAttendance.baseLocation
      || existingAttendance.morning?.location
      || existingAttendance.evening?.location
      || null;

    let baseLocation = existingBase ? { ...existingBase } : null;
    const distanceWarnings = [];

    const applyDistanceRule = (type) => {
      const entry = attendance[type];
      if (!entry?._justCaptured || !entry.imageUrl || !entry.location) return;

      if (!baseLocation) {
        baseLocation = { ...entry.location };
        return;
      }

      const distance = haversineMeters(baseLocation, entry.location);
      if (distance <= WORK_DISTANCE_LIMIT_METERS) return;

      const prev = existingAttendance[type] || {};
      if (prev.imageUrl && prev.location) {
        attendance[type] = { ...prev, _justCaptured: false };
      } else {
        attendance[type] = { imageUrl: "", location: null, capturedAt: entry.capturedAt, _justCaptured: false };
      }
      distanceWarnings.push(
        `${type === "morning" ? "Sabah" : "Aksam"} cekimi referans konumdan ${Math.round(distance)}m uzak oldugu icin yoklama eksik birakildi.`
      );
    };

    applyDistanceRule("morning");
    applyDistanceRule("evening");

    attendance.baseLocation = baseLocation ? {
      lat: baseLocation.lat,
      lng: baseLocation.lng,
      accuracy: baseLocation.accuracy ?? null,
      savedAt: new Date().toISOString()
    } : null;

    delete attendance.morning._justCaptured;
    delete attendance.evening._justCaptured;

    const nextLog = {
      content,
      imageUrl,
      imageUrls: finalImageUrls,
      attendance,
      updatedAt: new Date().toISOString()
    };

    await callBackend(`/api/diaries/${encodeURIComponent(diaryId)}/logs/${encodeURIComponent(dateStr)}`, {
      method: "POST",
      body: JSON.stringify({
        ...nextLog,
        merge: false,
        removedPhotos: (state.noteImagePendingDeleteUrls || []).map(normalizePendingDeleteEntry).filter((x) => x?.url)
      })
    });

    const hasMorning = !!attendance.morning.imageUrl && !!attendance.morning.location;
    const hasEvening = !!attendance.evening.imageUrl && !!attendance.evening.location;
    const metaWarnings = [];
    if (morningJustCaptured && attendance.morning?.meta?.flagged) {
      metaWarnings.push(`Sabah fotografinda cekim-yukleme zaman farki yuksek (~${attendance.morning.meta.driftMinutes} dk).`);
    }
    if (eveningJustCaptured && attendance.evening?.meta?.flagged) {
      metaWarnings.push(`Aksam fotografinda cekim-yukleme zaman farki yuksek (~${attendance.evening.meta.driftMinutes} dk).`);
    }

    if (distanceWarnings.length) {
      notifyWarn(distanceWarnings.join("\n"), 7000);
    } else if (metaWarnings.length) {
      notifyWarn(metaWarnings.join("\n"), 6500);
    } else if (hasMorning && !hasEvening) {
      notifySuccess("Sabah yoklamasi alindi. Aksam yoklamasini daha sonra ekleyebilirsin.");
    } else if (!hasMorning && hasEvening) {
      notifySuccess("Aksam yoklamasi alindi.");
    } else if (hasMorning && hasEvening) {
      notifySuccess("Sabah ve aksam yoklamasi alindi.");
    } else {
      notifySuccess("Gunluk kaydedildi.");
    }

    stopShiftCooldownTicker();
    clearNoteImageDrafts();
    state.noteImageExistingUrls = [];
    state.noteImagePendingDeleteUrls = [];
    if ($("image-input")) $("image-input").value = "";
    if ($("file-name")) $("file-name").innerText = "";
    setHidden("log-modal", true);
    state.loadedLogMonths.delete(getMonthKey(new Date(`${dateStr}T00:00:00`)));
    await fetchLogs();
  } catch (e) {
    reportAppError({
      code: "ERR_LOG_SAVE_01",
      error: e,
      notifyError,
      fallbackMessage: "Hata olustu, not kaydedilemedi."
    });
  } finally {
    setBtnBusy("save-btn", "Kaydediliyor...", "Kaydet", false);
  }
};

window.changeMonth = async (offset) => {
  state.currentDate.setMonth(state.currentDate.getMonth() + offset);
  await fetchLogs();
  if (!state.isPersonal) await loadMonthlySuggestion();
};

window.closeLogModal = () => {
  stopShiftCooldownTicker();
  clearNoteImageDrafts();
  state.noteImageExistingUrls = [];
  state.noteImagePendingDeleteUrls = [];
  setHidden("log-modal", true);
};

window.previewImage = (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  const currentCount = (state.noteImageExistingUrls?.length || 0) + (state.noteImageDraftFiles?.length || 0);
  const remaining = Math.max(0, MAX_NOTE_IMAGES - currentCount);
  if (remaining <= 0) {
    e.target.value = "";
    return notifyWarn(`En fazla ${MAX_NOTE_IMAGES} fotograf ekleyebilirsiniz.`);
  }
  const toUse = files.filter((f) => f.type?.startsWith("image/")).slice(0, remaining);
  if (!toUse.length) {
    e.target.value = "";
    return;
  }
  toUse.forEach((file) => {
    state.noteImageDraftFiles.push({
      file,
      previewUrl: URL.createObjectURL(file)
    });
  });
  if (files.length > remaining) {
    notifyWarn(`Sadece ${MAX_NOTE_IMAGES} fotografa kadar izin veriliyor.`);
  }
  e.target.value = "";
  renderLogImagePreview(!!$("log-input")?.readOnly);
};

window.previewShiftPhoto = (e, type) => {
  const file = e.target.files?.[0];
  if (!file || !["morning", "evening"].includes(type)) return;

  const now = new Date();
  const timeError = getCaptureTimeError(type, now);
  if (timeError) {
    e.target.value = "";
    return notifyWarn(timeError);
  }

  const cooldownError = getCooldownError(type, now);
  if (cooldownError) {
    e.target.value = "";
    return notifyWarn(cooldownError);
  }

  state.shiftDraft[type].file = file;
  state.shiftDraft[type].capturedAt = now.toISOString();
  setShiftPreview(type, URL.createObjectURL(file));
  window.captureShiftLocation(type, { silent: true });
  updateShiftCooldownUI();
};

window.captureShiftLocation = (type, options = {}) => {
  if (!["morning", "evening"].includes(type)) return;
  const dateError = getDateEligibilityError();
  if (dateError) {
    if (!options.silent) notifyWarn(dateError);
    return;
  }
  if (!navigator.geolocation) {
    if (!options.silent) notifyWarn("Bu tarayici konum bilgisini desteklemiyor.");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.shiftDraft[type].location = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        capturedAt: state.shiftDraft[type].capturedAt || new Date().toISOString()
      };
      setShiftLocationText(type, state.shiftDraft[type].location);
    },
    (err) => {
      console.error(err);
      if (!options.silent) notifyError("Konum alinamadi. Lutfen konum izni verdiginizden emin olun.");
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
};

function updateStatusUI(status) {
  const badge = $("approval-badge");
  if (!badge) return;
  const map = {
    approved: { text: "ONAYLANDI", color: "#166534" },
    pending: { text: "BEKLEMEDE", color: "#854d0e" },
    active: { text: "AKTIF", color: "#1e40af" }
  };
  const entry = map[status] || map.active;
  badge.innerText = entry.text;
  badge.style.color = entry.color;
}

async function loadMonthlySuggestion() {
  try {
    const mId = `${state.currentDate.getFullYear()}-${state.currentDate.getMonth() + 1}`;
    const row = await dataService.readMonthlyEvaluation(mId);
    const text = row?.content ? row.content : "Henuz bir degerlendirme yapilmadi.";
    if ($("suggestion-text")) $("suggestion-text").innerText = text;
  } catch (e) {
    reportAppError({
      code: "ERR_MONTHLY_EVAL_READ_01",
      error: e,
      notifyError,
      fallbackMessage: "Aylik degerlendirme yuklenemedi."
    });
  }
}

window.openSuggestionModal = () => {
  const currentText = $("suggestion-text")?.innerText || "";
  $("suggestion-input").value = currentText.includes("degerlendirme yapilmadi") ? "" : currentText;
  setHidden("suggestion-modal", false);
};

window.closeSuggestionModal = () => setHidden("suggestion-modal", true);

window.handleSaveSuggestion = async () => {
  try {
    const mId = `${state.currentDate.getFullYear()}-${state.currentDate.getMonth() + 1}`;
    await callBackend(`/api/diaries/${encodeURIComponent(diaryId)}/monthly-evaluations/${encodeURIComponent(mId)}`, {
      method: "POST",
      body: JSON.stringify({ content: $("suggestion-input").value })
    });
    window.closeSuggestionModal();
    await loadMonthlySuggestion();
  } catch (e) {
    reportAppError({
      code: "ERR_MONTHLY_EVAL_SAVE_01",
      error: e,
      notifyError,
      fallbackMessage: "Degerlendirme kaydedilemedi."
    });
  }
};

window.handleSendToApproval = async () => {
  if (!confirm("Bu gunlugu hocanin onayina gondermek istiyor musunuz?")) return;
  try {
    await callBackend(`/api/diaries/${encodeURIComponent(diaryId)}/submit`, { method: "POST" });
    location.reload();
  } catch (e) {
    console.error(e);
  }
};

window.handleApproveDiary = async () => {
  if (!confirm("Bu ogrencinin gunlugunu onayliyor musunuz? (Evrak ekleme kilitlenecektir)")) return;
  try {
    await callBackend(`/api/diaries/${encodeURIComponent(diaryId)}/approve`, { method: "POST" });
    location.reload();
  } catch (e) {
    console.error(e);
  }
};

window.openRejectModal = () => setHidden("reject-modal", false);
window.closeRejectModal = () => setHidden("reject-modal", true);

window.submitRejection = async () => {
  const reason = $("reject-reason-input").value.trim();
  if (!reason) return notifyWarn("Lutfen bir ret sebebi girin.");

  try {
    await callBackend(`/api/diaries/${encodeURIComponent(diaryId)}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason })
    });
    location.reload();
  } catch (e) {
    reportAppError({
      code: "ERR_REJECT_NOTIFY_01",
      error: e,
      notifyError,
      fallbackMessage: "Islem sirasinda hata olustu."
    });
  }
};

window.openSettingsModal = () => {
  const canManage = state.isInstructor || state.diary?.creatorId === auth.currentUser?.uid;
  const canStudentSetWorkLocation = !state.isPersonal && !state.isInstructor && !state.isReadOnlyMode;

  setHidden("settings-admin-lock-box", !canManage);
  setHidden("settings-admin-shift-box", !canManage);
  setHidden("settings-admin-temp-box", !canManage);
  setHidden("settings-student-work-box", !canStudentSetWorkLocation);
  setHidden("settings-save-btn", !canManage);

  $("edit-is-locked").checked = !!state.diary?.isLocked;
  $("edit-lock-days").value = state.diary?.lockDays || 0;
  if ($("edit-require-shift-proof")) $("edit-require-shift-proof").checked = !!state.diary?.requireShiftProof;
  if ($("work-radius-meters")) $("work-radius-meters").value = Math.max(30, Number(state.diary?.workRadiusMeters || WORK_DISTANCE_LIMIT_METERS));
  renderWorkLocationStatusText();
  setHidden("settings-modal", false);
};

window.closeSettingsModal = () => setHidden("settings-modal", true);

window.handleUpdateSettings = async () => {
  try {
    const canManage = state.isInstructor || state.diary?.creatorId === auth.currentUser?.uid;
    if (!canManage) return;

    await callBackend(`/api/diaries/${encodeURIComponent(diaryId)}/settings`, {
      method: "POST",
      body: JSON.stringify({
        isLocked: $("edit-is-locked").checked,
        lockDays: Number($("edit-lock-days").value),
        requireShiftProof: !!$("edit-require-shift-proof")?.checked
      })
    });
    location.reload();
  } catch (e) {
    reportAppError({
      code: "ERR_SETTINGS_UPDATE_01",
      error: e,
      notifyError,
      fallbackMessage: "Ayarlar guncellenemedi."
    });
  }
};

window.captureWorkplaceLocation = () => {
  if (state.isPersonal || state.isInstructor || state.isReadOnlyMode) return;
  if (!navigator.geolocation) return notifyWarn("Bu tarayici konum bilgisini desteklemiyor.");

  const radiusInput = Math.max(30, Math.min(2000, Number($("work-radius-meters")?.value || WORK_DISTANCE_LIMIT_METERS)));
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const patch = {
          workLocation: {
            lat: Number(pos.coords.latitude),
            lng: Number(pos.coords.longitude),
            accuracy: Number(pos.coords.accuracy || 0),
            savedAt: new Date().toISOString(),
            savedBy: (auth.currentUser?.email || "").toLowerCase().trim()
          },
          workRadiusMeters: radiusInput
        };
        await callBackend(`/api/diaries/${encodeURIComponent(diaryId)}/work-location`, {
          method: "POST",
          body: JSON.stringify(patch)
        });
        state.diary = { ...(state.diary || {}), ...patch };
        renderWorkLocationStatusText();
        notifySuccess("Is yeri konumu kaydedildi.");
      } catch (e) {
        reportAppError({
          code: "ERR_WORK_LOCATION_SAVE_01",
          error: e,
          notifyError,
          fallbackMessage: "Is yeri konumu kaydedilemedi."
        });
      }
    },
    () => notifyError("Konum alinamadi. Lutfen konum izni verin."),
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
};

window.toggleTempInputs = () => {
  const type = $("temp-unlock-type").value;
  setHidden("temp-range-input", type !== "range");
  setHidden("temp-date-input", type !== "date");
};

window.handleTempUnlock = async () => {
  const type = $("temp-unlock-type").value;
  const minutes = parseInt($("temp-unlock-min").value, 10) || 5;
  const value = type === "range" ? $("temp-value-range").value : (type === "date" ? $("temp-value-date").value : "");

  try {
    await callBackend(`/api/diaries/${encodeURIComponent(diaryId)}/temp-unlock`, {
      method: "POST",
      body: JSON.stringify({ type, value, minutes })
    });
    notifySuccess("Gecici izin basariyla tanimlandi.");
    location.reload();
  } catch (e) {
    reportAppError({
      code: "ERR_TEMP_UNLOCK_01",
      error: e,
      notifyError,
      fallbackMessage: "Gecici izin tanimlanamadi."
    });
  }
};

window.handleTodayShiftBypass = async () => {
  const minutes = Math.max(1, Math.min(120, parseInt($("temp-unlock-min")?.value, 10) || 10));
  try {
    await callBackend(`/api/diaries/${encodeURIComponent(diaryId)}/temp-unlock`, {
      method: "POST",
      body: JSON.stringify({ type: "shift-today", minutes })
    });
    notifySuccess(`Bugunun mesai konum/fotograf izni ${minutes} dk acildi.`);
    location.reload();
  } catch (e) {
    reportAppError({
      code: "ERR_SHIFT_TODAY_BYPASS_01",
      error: e,
      notifyError,
      fallbackMessage: "Anlik mesai izni tanimlanamadi."
    });
  }
};

window.toggleLiveChat = liveChat.toggleLiveChat;
window.handleSendLiveMessage = liveChat.handleSendLiveMessage;

window.toggleNotiPanel = async (e) => {
  e.stopPropagation();
  const dropdown = $("noti-dropdown");
  if (!dropdown) return;
  const willOpen = !dropdown.classList.contains("active");
  dropdown.classList.toggle("active");
  if (willOpen) {
    await markNotificationsRead();
  }
};

window.addEventListener("click", (e) => {
  const dropdown = $("noti-dropdown");
  const container = e.target?.closest?.(".noti-container");
  if (dropdown && !container) dropdown.classList.remove("active");
});

document.addEventListener("visibilitychange", () => {
  liveChat.handleVisibilityChange();
});

window.addEventListener("beforeunload", () => {
  liveChat.handleBeforeUnload();
});

const gunlukPdfActions = createGunlukPdfActions({
  state,
  $,
  getAttendanceScore,
  getPrimaryLogImageUrl,
  loadImageAsDataUrl,
  sanitizeFileName,
  dataService
});
window.togglePdfMenu = (event) => {
  if (event) event.stopPropagation();
  const menu = $("pdf-menu");
  if (!menu) return;
  menu.classList.toggle("hidden");
};

window.addEventListener("click", (event) => {
  if (!event.target?.closest?.(".split-action")) {
    $("pdf-menu")?.classList.add("hidden");
  }
});

window.generatePDF = gunlukPdfActions.generatePDF;
window.generateWeeklyStudentNotesPDF = gunlukPdfActions.generateWeeklyStudentNotesPDF;





















