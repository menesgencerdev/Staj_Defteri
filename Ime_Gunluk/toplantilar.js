import "./toast.js";
import { auth } from "./firebase-config.js?v=20260404appcheck";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { initTheme, toggleTheme } from "./theme.js";
import { normalizeClassNameDisplay, normalizeClassNameKey, isPersonalClassName } from "./panel-classname.js";
import { sanitizeExternalUrl } from "./gunluk-utils.js";

const state = {
  user: null,
  role: "student",
  studentDiaries: [],
  teacherDiaries: [],
  classGroups: {},
  meetings: []
};

const $ = (id) => document.getElementById(id);
const setHidden = (id, hidden) => $(id)?.classList.toggle("hidden", !!hidden);

window.toggleTheme = toggleTheme;
window.handleLogout = async () => { await signOut(auth); window.location.href = "index.html"; };
window.goBackToPanel = () => { window.location.href = "panel.html"; };

initTheme();

function hideLoading() {
  const el = $("loading-screen");
  if (el) el.style.display = "none";
}

function escapeHTML(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toYmd(date = new Date()) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDateTime(value = "") {
  if (!value) return "Tarih belirtilmedi";
  const normalized = String(value).includes("T") ? String(value) : String(value).replace(" ", "T");
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" });
}

function meetingDateKey(row) {
  if (row?.dateKey) return String(row.dateKey);
  const raw = String(row?.startsAt || "");
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? "" : toYmd(d);
}

async function callBackend(path, options = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error("Oturum bulunamadi.");
  const token = await user.getIdToken();
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { ...options, headers });
  const raw = await response.text().catch(() => "");
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = {}; }
  if (!response.ok) throw new Error(data.error || raw.slice(0, 180) || "Backend istegi basarisiz.");
  return data;
}

function buildClassGroups() {
  const groups = {};
  (state.teacherDiaries || []).forEach((diary) => {
    if (diary.isDeleted || isPersonalClassName(diary.className) || !diary.instructorEmail) return;
    const label = normalizeClassNameDisplay(diary.className || "Bagimsiz Ogrenciler");
    const key = normalizeClassNameKey(label);
    if (!groups[key]) groups[key] = { key, label, diaries: [] };
    groups[key].diaries.push(diary);
  });
  state.classGroups = groups;
}

function renderClassSelect() {
  const select = $("meeting-class-select");
  if (!select) return;
  const canCreate = ["instructor", "admin"].includes(String(state.role || "").toLowerCase());
  const groups = Object.values(state.classGroups || {}).filter((g) => g.diaries.length);
  setHidden("meeting-create-section", !canCreate);
  if (!canCreate) return;
  select.innerHTML = groups.length
    ? groups.map((g) => `<option value="${escapeHTML(g.key)}">${escapeHTML(g.label)} (${g.diaries.length} gunluk)</option>`).join("")
    : `<option value="">Toplanti atanacak sinif yok</option>`;
}

async function fetchMeetingsForDiaries(diaries) {
  const uniqueDiaries = [];
  const seenDiary = new Set();
  (diaries || []).forEach((d) => {
    if (!d?.id || d.isDeleted || seenDiary.has(d.id)) return;
    seenDiary.add(d.id);
    uniqueDiaries.push(d);
  });

  const meetingMap = new Map();
  await Promise.all(uniqueDiaries.map(async (diary) => {
    const data = await callBackend(`/api/diaries/${encodeURIComponent(diary.id)}/meetings`).catch(() => ({ rows: [] }));
    (Array.isArray(data.rows) ? data.rows : []).forEach((row) => {
      const id = row.id || `${row.title}|${row.startsAt}|${row.meetingUrl}`;
      const existing = meetingMap.get(id) || { ...row, diaryTitles: [], diaryIds: [] };
      existing.diaryTitles.push(diary.title || diary.studentEmail || diary.id);
      existing.diaryIds.push(diary.id);
      meetingMap.set(id, existing);
    });
  }));
  return [...meetingMap.values()].sort((a, b) => String(a.startsAt || "").localeCompare(String(b.startsAt || "")));
}

function renderMeetings() {
  const list = $("meetings-page-list");
  if (!list) return;
  const rows = Array.isArray(state.meetings) ? state.meetings : [];
  if (!rows.length) {
    list.innerHTML = `<div class="student-card" style="cursor:default; padding:18px;">Henuz toplanti bulunmuyor.</div>`;
    return;
  }
  const today = toYmd();
  list.innerHTML = rows.map((m) => {
    const url = sanitizeExternalUrl(m.meetingUrl || "");
    const isToday = meetingDateKey(m) === today;
    const className = m.className || "";
    const diaryCount = Array.isArray(m.diaryIds) ? m.diaryIds.length : 0;
    return `
      <article class="meeting-card ${isToday ? "meeting-card-today" : ""}">
        <div class="meeting-card-header">
          <div>
            <h3 class="meeting-title">${escapeHTML(m.title || "Toplanti")}</h3>
            <div class="meeting-meta">
              <strong>${escapeHTML(formatDateTime(m.startsAt))}</strong>${isToday ? " | Bugun" : ""}<br>
              ${className ? `Sinif: ${escapeHTML(className)}<br>` : ""}
              ${diaryCount ? `${diaryCount} gunluk kapsamda` : ""}
            </div>
          </div>
          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
            ${isToday ? `<span class="meeting-badge">Bugunku toplanti</span>` : ""}
            ${url ? `<a class="btn-main" style="width:auto; text-decoration:none;" href="${url}" target="_blank" rel="noopener">Toplantiya Gir</a>` : `<span class="muted-text" style="font-weight:700;">Link bekleniyor</span>`}
          </div>
        </div>
        ${m.description ? `<p class="meeting-desc">${escapeHTML(m.description)}</p>` : ""}
      </article>
    `;
  }).join("");
}

window.loadMeetingsPage = async () => {
  const list = $("meetings-page-list");
  if (list) list.innerHTML = "Toplantilar yukleniyor...";
  const data = await callBackend("/api/panel-data");
  state.user = data.user || {};
  state.role = String(data.user?.role || "student").toLowerCase();
  state.studentDiaries = Array.isArray(data.studentDiaries) ? data.studentDiaries : [];
  state.teacherDiaries = Array.isArray(data.teacherDiaries) ? data.teacherDiaries : [];
  const emailEl = $("user-email");
  if (emailEl) emailEl.innerText = auth.currentUser?.email || state.user.email || "";
  buildClassGroups();
  renderClassSelect();
  state.meetings = await fetchMeetingsForDiaries([...state.studentDiaries, ...state.teacherDiaries]);
  renderMeetings();
};

window.createMeetingFromPage = async () => {
  const key = $("meeting-class-select")?.value || "";
  const group = state.classGroups[key];
  if (!group?.diaries?.length) return window.notify?.("Toplanti atanacak sinif secin.", "warn");
  const title = ($("meeting-title")?.value || "").trim();
  const startsAt = ($("meeting-start")?.value || "").trim();
  const meetingUrl = ($("meeting-url")?.value || "").trim();
  const description = ($("meeting-description")?.value || "").trim();
  if (!title) return window.notify?.("Toplanti basligi gerekli.", "warn");
  if (!startsAt) return window.notify?.("Toplanti tarihi gerekli.", "warn");
  if (meetingUrl && !/^https?:\/\//i.test(meetingUrl)) return window.notify?.("Toplanti linki bos olabilir ama doluysa http/https ile baslamali.", "warn");

  const btn = $("meeting-create-btn");
  try {
    if (btn) { btn.disabled = true; btn.innerText = "Olusturuluyor..."; }
    const result = await callBackend("/api/classes/meetings", {
      method: "POST",
      body: JSON.stringify({
        className: group.label,
        diaryIds: group.diaries.map((d) => d.id),
        title,
        startsAt,
        meetingUrl,
        description
      })
    });
    ["meeting-title", "meeting-start", "meeting-url", "meeting-description"].forEach((id) => { const el = $(id); if (el) el.value = ""; });
    window.notify?.(`${result.count || group.diaries.length} gunluge toplanti bildirimi gonderildi.`, "success", 4200);
    await window.loadMeetingsPage();
  } catch (e) {
    console.error(e);
    window.notify?.(e.message || "Toplanti olusturulamadi.", "error", 5200);
  } finally {
    if (btn) { btn.disabled = false; btn.innerText = "Toplantiyi Olustur"; }
  }
};

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }
  try {
    await window.loadMeetingsPage();
  } catch (e) {
    console.error(e);
    window.notify?.(e.message || "Toplantilar yuklenemedi.", "error", 5200);
  } finally {
    hideLoading();
  }
});
