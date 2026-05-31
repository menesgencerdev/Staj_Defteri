import "./toast.js";
import { auth, db } from "./firebase-config.js?v=20260404appcheck";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { initTheme, toggleTheme } from "./theme.js";
import { createPanelPdfActions } from "./panel-pdf.js";
import { normalizeClassNameDisplay, normalizeClassNameKey, isPersonalClassName } from "./panel-classname.js";
import { evaluateAttendanceScore } from "./attendance-score.js";
import { reportAppError } from "./error-center.js";
import {
    DEFAULT_ATTENDANCE_POLICY,
    uniqSortedDates,
    normalizeDateYmd,
    getAttendancePolicyFromDoc,
    isPlannedDateByPolicy,
    countPlannedDays
} from "./attendance-policy.js";
import { collection, query, onSnapshot, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

let groupedClasses = {}; 
let classDisplayNames = {};
let activeDiaryForEdit = null;
let activeClassForEdit = null;
let activeChatDiaryId = null;
let activeChatStudentEmail = "";
let activeChatUnsub = null;
let activeChatClassName = "";
let activeChatStudents = [];
const holidayDraft = { bulk: [], edit: [] };
const DELETED_CLASS_LABEL = "Silinen Gunlukler";
const DELETED_CLASS_KEY = normalizeClassNameKey(DELETED_CLASS_LABEL);

window.toggleTheme = toggleTheme;

function initializePanelBootUI() {
    try {
        initTheme();
    } catch (e) {
        console.error("Tema baslatma hatasi:", e);
    }

    try {
        bindAttendanceSummary("bulk");
        bindAttendanceSummary("edit");
    } catch (e) {
        console.error("Yoklama ozet baglama hatasi:", e);
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializePanelBootUI, { once: true });
} else {
    initializePanelBootUI();
}

function getClassLabel(classKey) {
    return classDisplayNames[classKey] || normalizeClassNameDisplay(classKey);
}

function ensureIndependentClassState() {
    const classKey = normalizeClassNameKey("Bagimsiz Ogrenciler");
    if (!groupedClasses[classKey]) groupedClasses[classKey] = [];
    if (!classDisplayNames[classKey]) classDisplayNames[classKey] = "Bagimsiz Ogrenciler";
    return classKey;
}

const todayKeyTR = () => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
};

function setWeekdayChecks(prefix, weekdays = []) {
    for (const d of [0, 1, 2, 3, 4, 5, 6]) {
        const el = document.getElementById(`${prefix}-weekday-${d}`);
        if (el) el.checked = weekdays.includes(d);
    }
}

function renderHolidayList(mode) {
    const listId = mode === "bulk" ? "bulk-holiday-list" : "bulk-edit-holiday-list";
    const list = document.getElementById(listId);
    if (!list) return;
    const arr = holidayDraft[mode] || [];
    list.innerHTML = arr
        .map((d) => `<span class="holiday-chip">${d}<button type="button" onclick="removeHolidayDate('${mode}','${d}')" style="border:none; background:none; cursor:pointer;">x</button></span>`)
        .join("");
}

function normalizeWeeklyTargetByWeekend(prefix) {
    const weekendsEnabled = !!document.getElementById(`${prefix}-include-weekends`)?.checked;
    const daysEl = document.getElementById(`${prefix}-attendance-days-per-week`);
    if (!daysEl) return;
    const max = weekendsEnabled ? 7 : 5;
    const min = 1;
    const value = Number(daysEl.value || 0);
    const normalized = Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
    daysEl.max = String(max);
    daysEl.value = String(normalized);
}

function readAttendancePolicyDraftFromForm(mode) {
    const isEdit = mode === "edit";
    const prefix = isEdit ? "bulk-edit" : "bulk";
    normalizeWeeklyTargetByWeekend(prefix);
    const enabled = !!document.getElementById(`${prefix}-attendance-policy-enabled`)?.checked;
    const startDate = normalizeDateYmd(document.getElementById(`${prefix}-attendance-start-date`)?.value || "");
    const endDate = normalizeDateYmd(document.getElementById(`${prefix}-attendance-end-date`)?.value || "");
    const daysPerWeek = Math.max(1, Math.min(7, Number(document.getElementById(`${prefix}-attendance-days-per-week`)?.value || 5)));
    const includeWeekends = !!document.getElementById(`${prefix}-include-weekends`)?.checked;
    const weekdays = includeWeekends ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5];
    return {
        enabled,
        startDate,
        endDate,
        daysPerWeek,
        weeklyFlexible: true,
        includeWeekends,
        weekdays,
        holidays: uniqSortedDates(holidayDraft[mode] || [])
    };
}

function updateAttendanceSummary(mode) {
    const el = document.getElementById(mode === "edit" ? "bulk-edit-attendance-summary" : "bulk-attendance-summary");
    if (!el) return;

    const draft = readAttendancePolicyDraftFromForm(mode);

    if (!draft.startDate || !draft.endDate) {
        el.innerHTML = draft.enabled
            ? "Staj baslangic ve bitis tarihi secilmelidir."
            : "Yoklama plani kapali. Tarih secilince toplam staj suresi gorunur.";
        return;
    }
    if (draft.endDate < draft.startDate) {
        el.innerHTML = "Bitis tarihi baslangictan once olamaz.";
        return;
    }
    const maxPerWeek = draft.includeWeekends ? 7 : 5;
    if (draft.daysPerWeek > maxPerWeek) {
        el.innerHTML = draft.includeWeekends
            ? "Haftalik hedef en fazla 7 gun olabilir."
            : "Hafta sonlari kapaliyken haftalik hedef en fazla 5 gun olabilir.";
        return;
    }

    const totalDays = countPlannedDays(draft);
    const planState = draft.enabled ? "Yoklama plani aktif" : "Yoklama plani kapali (onizleme)";
    el.innerHTML = `${planState}<br>Haftalik hedef: <b>${draft.daysPerWeek}</b> gun (7 gun icinde)<br>Toplam staj suresi: <b>${totalDays}</b> gun (${draft.startDate} - ${draft.endDate})`;
}

function bindAttendanceSummary(mode) {
    const isEdit = mode === "edit";
    const prefix = isEdit ? "bulk-edit" : "bulk";
    const ids = [
        `${prefix}-attendance-policy-enabled`,
        `${prefix}-attendance-start-date`,
        `${prefix}-attendance-end-date`,
        `${prefix}-attendance-days-per-week`,
        `${prefix}-include-weekends`
    ];
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (!el || el.dataset.summaryBound === "1") return;
        el.dataset.summaryBound = "1";
        el.addEventListener("change", () => {
            normalizeWeeklyTargetByWeekend(prefix);
            updateAttendanceSummary(mode);
        });
        el.addEventListener("input", () => {
            normalizeWeeklyTargetByWeekend(prefix);
            updateAttendanceSummary(mode);
        });
    });
    normalizeWeeklyTargetByWeekend(prefix);
    updateAttendanceSummary(mode);
}

window.addHolidayDate = (mode) => {
    const inpId = mode === "bulk" ? "bulk-holiday-date" : "bulk-edit-holiday-date";
    const inp = document.getElementById(inpId);
    const date = normalizeDateYmd(inp?.value);
    if (!date) return;
    holidayDraft[mode] = uniqSortedDates([...(holidayDraft[mode] || []), date]);
    if (inp) inp.value = "";
    renderHolidayList(mode);
    updateAttendanceSummary(mode);
};

window.removeHolidayDate = (mode, date) => {
    holidayDraft[mode] = (holidayDraft[mode] || []).filter(d => d !== date);
    renderHolidayList(mode);
    updateAttendanceSummary(mode);
};

let xlsxLoadPromise = null;
function ensureXlsxLoaded() {
    if (window.XLSX) return Promise.resolve();
    if (xlsxLoadPromise) return xlsxLoadPromise;
    xlsxLoadPromise = new Promise((resolve, reject) => {
        const src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
        const existing = document.querySelector(`script[src="${src}"]`);
        if (existing) {
            existing.addEventListener("load", () => resolve(), { once: true });
            existing.addEventListener("error", () => reject(new Error("XLSX load failed")), { once: true });
            return;
        }
        const s = document.createElement("script");
        s.src = src;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("XLSX load failed"));
        document.head.appendChild(s);
    });
    return xlsxLoadPromise;
}

function readAttendancePolicyFromForm(mode) {
    const { enabled, startDate, endDate, daysPerWeek, includeWeekends, weekdays } = readAttendancePolicyDraftFromForm(mode);

    if (enabled) {
        if (!startDate || !endDate) throw new Error("Yoklama plani aktifken staj baslangic ve bitis tarihlerini secmelisiniz.");
        if (endDate < startDate) throw new Error("Staj bitis tarihi, baslangic tarihinden once olamaz.");
        if (!includeWeekends && daysPerWeek > 5) throw new Error("Hafta sonlari kapaliyken haftalik hedef en fazla 5 gun olabilir.");
        if (includeWeekends && daysPerWeek > 7) throw new Error("Haftalik hedef en fazla 7 gun olabilir.");
    }

    return {
        attendancePolicyEnabled: enabled,
        attendanceStartDate: startDate,
        attendanceEndDate: endDate,
        attendanceDaysPerWeek: daysPerWeek,
        attendanceWeeklyTargetDays: daysPerWeek,
        attendanceWeeklyFlexible: true,
        attendanceIncludeWeekends: includeWeekends,
        attendanceWeekdays: weekdays,
        attendanceHolidays: uniqSortedDates(holidayDraft[mode] || [])
    };
}

function applyAttendancePolicyToForm(mode, policy = DEFAULT_ATTENDANCE_POLICY) {
    const isEdit = mode === "edit";
    const prefix = isEdit ? "bulk-edit" : "bulk";
    const normalized = { ...DEFAULT_ATTENDANCE_POLICY, ...policy };
    const enabledEl = document.getElementById(`${prefix}-attendance-policy-enabled`);
    const daysEl = document.getElementById(`${prefix}-attendance-days-per-week`);
    const weekendsEl = document.getElementById(`${prefix}-include-weekends`);
    const startEl = document.getElementById(`${prefix}-attendance-start-date`);
    const endEl = document.getElementById(`${prefix}-attendance-end-date`);
    if (enabledEl) enabledEl.checked = !!normalized.enabled;
    if (startEl) startEl.value = normalizeDateYmd(normalized.startDate || "");
    if (endEl) endEl.value = normalizeDateYmd(normalized.endDate || "");
    if (daysEl) daysEl.value = Number(normalized.daysPerWeek || 5);
    if (weekendsEl) weekendsEl.checked = !!normalized.includeWeekends;
    normalizeWeeklyTargetByWeekend(prefix);
    setWeekdayChecks(prefix, normalized.weekdays || []);
    holidayDraft[mode] = uniqSortedDates(normalized.holidays || []);
    renderHolidayList(mode);
    updateAttendanceSummary(mode);
}

async function getTodayAttendanceInfo(diaryId) {
    try {
        const today = todayKeyTR();
        const data = await callBackend(`/api/diaries/${encodeURIComponent(diaryId)}/logs?first=${encodeURIComponent(today)}&last=${encodeURIComponent(today)}`);
        const row = Array.isArray(data.rows) ? data.rows[0] : null;
        if (!row) {
            return {
                hasMorning: false,
                hasEvening: false,
                score: 0,
                statusLabel: "Bugun kayit yok",
                statusTone: "neutral",
                notes: ["Sabah yoklama yok", "Aksam yoklama yok"],
                flags: { missingMorning: true, missingEvening: true, metaWarning: false, accuracyWarning: false }
            };
        }

        const attendance = row.attendance || {};
        const evaluated = evaluateAttendanceScore(attendance, {
            morningPoints: 50,
            eveningPoints: 50,
            metaPenalty: 15,
            accuracyPenalty: 10,
            accuracyWarn: 80,
            useDistancePenalty: false
        });
        const hasMorning = evaluated.hasMorning;
        const hasEvening = evaluated.hasEvening;
        const score = evaluated.score;

        let statusLabel = "Tamam";
        let statusTone = "ok";
        if (!hasMorning && !hasEvening) { statusLabel = "Yoklama Eksik"; statusTone = "bad"; }
        else if (!hasMorning || !hasEvening) { statusLabel = "Kismi Yoklama"; statusTone = "warn"; }

        const notes = [];
        if (!hasMorning) notes.push("Sabah yoklama yok");
        if (!hasEvening) notes.push("Aksam yoklama yok");
        if (evaluated.flags.metaWarning) notes.push("Meta uyari var");
        if (evaluated.flags.accuracyWarning) notes.push("GPS dogrulugu dusuk");

        return { hasMorning, hasEvening, score, statusLabel, statusTone, notes, flags: evaluated.flags };
    } catch {
        return {
            hasMorning: false,
            hasEvening: false,
            score: 0,
            statusLabel: "Yuklenemedi",
            statusTone: "neutral",
            notes: ["Veri alinamadi"],
            flags: { missingMorning: true, missingEvening: true, metaWarning: false, accuracyWarning: false }
        };
    }
}
function getAttendanceScoreFromLog(log = {}) {
    const evaluated = evaluateAttendanceScore(log?.attendance || {}, {
        morningPoints: 50,
        eveningPoints: 50,
        metaPenalty: 15,
        accuracyPenalty: 10,
        accuracyWarn: 80,
        useDistancePenalty: false
    });
    return {
        score: evaluated.score,
        hasMorning: evaluated.hasMorning,
        hasEvening: evaluated.hasEvening
    };
}

function mondayStart(d = new Date()) {
    const x = new Date(d);
    const day = x.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    x.setDate(x.getDate() + diff);
    x.setHours(0, 0, 0, 0);
    return x;
}

function ymdLocal(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

function getWeekDatesYmd(ref = new Date()) {
    const start = mondayStart(ref);
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        dates.push(ymdLocal(d));
    }
    return dates;
}

async function getClassPlanSummary(students) {
    if (!students?.length) return { enabled: false };
    const sample = students[0] || {};
    const policy = getAttendancePolicyFromDoc(sample);
    if (!policy.enabled) return { enabled: false };

    const weekDates = getWeekDatesYmd(new Date());
    const first = weekDates[0];
    const last = weekDates[weekDates.length - 1];
    const plannedDates = weekDates.filter((d) => isPlannedDateByPolicy(policy, d));
    const holidays = new Set(policy.holidays || []);

    let plannedTotal = 0;
    let actualTotal = 0;
    let holidayViolations = 0;
    let outsideViolations = 0;
    const violationRows = [];

    await Promise.all(students.map(async (student) => {
        const data = await callBackend(`/api/diaries/${encodeURIComponent(student.id)}/logs?first=${encodeURIComponent(first)}&last=${encodeURIComponent(last)}`).catch(() => ({ rows: [] }));
        const byDate = {};
        (Array.isArray(data.rows) ? data.rows : []).forEach((row) => { byDate[row.id] = row; });

        for (const d of weekDates) {
            const log = byDate[d] || {};
            const dayObj = new Date(`${d}T00:00:00`);
            const day = dayObj.getDay();
            const scoreInfo = getAttendanceScoreFromLog(log);
            const hasAttendance = scoreInfo.hasMorning || scoreInfo.hasEvening;
            const isPlanned = plannedDates.includes(d);

            if (isPlanned) {
                plannedTotal += 1;
                if (hasAttendance) actualTotal += 1;
            } else if (hasAttendance) {
                if (holidays.has(d)) {
                    holidayViolations += 1;
                    violationRows.push(`${student.studentEmail} | ${d} | Tatil gununde giris`);
                } else if (!policy.includeWeekends && (day === 0 || day === 6)) {
                    outsideViolations += 1;
                    violationRows.push(`${student.studentEmail} | ${d} | Hafta sonu giris`);
                } else {
                    outsideViolations += 1;
                    violationRows.push(`${student.studentEmail} | ${d} | Plan disi giris`);
                }
            }
        }
    }));

    const plannedRatio = plannedTotal ? Math.round((actualTotal / plannedTotal) * 100) : 0;
    return {
        enabled: true,
        plannedTotal,
        actualTotal,
        plannedDatesCount: plannedDates.length,
        plannedRatio,
        holidayViolations,
        outsideViolations,
        violationRows
    };
}
function clearClassInsights() {
    const wrap = document.getElementById("class-insights");
    const summary = document.getElementById("class-summary-card");
    const suspicious = document.getElementById("class-suspicious-card");
    const plan = document.getElementById("class-plan-card");
    if (wrap) wrap.classList.add("hidden");
    if (summary) summary.innerHTML = "";
    if (suspicious) suspicious.innerHTML = "";
    if (plan) plan.innerHTML = "";
}
function renderClassInsights(students, planSummary = null) {
    const wrap = document.getElementById("class-insights");
    const summary = document.getElementById("class-summary-card");
    const suspicious = document.getElementById("class-suspicious-card");
    const plan = document.getElementById("class-plan-card");
    if (!wrap || !summary || !suspicious || !plan) return;

    wrap.classList.remove("hidden");
    const total = students.length || 1;
    const complete = students.filter(s => s.attendanceInfo?.hasMorning && s.attendanceInfo?.hasEvening).length;
    const partial = students.filter(s => (s.attendanceInfo?.hasMorning || s.attendanceInfo?.hasEvening) && !(s.attendanceInfo?.hasMorning && s.attendanceInfo?.hasEvening)).length;
    const missing = students.filter(s => !s.attendanceInfo?.hasMorning && !s.attendanceInfo?.hasEvening).length;
    const avg = Math.round(students.reduce((acc, s) => acc + (s.attendanceInfo?.score || 0), 0) / total);

    summary.innerHTML = `
        <h4 style="margin:0 0 8px 0;">Bugunku Ozet</h4>
        <div style="display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:8px;">
            <div style="padding:8px; border:1px solid #e2e8f0; border-radius:8px;">Tamam: <b>${complete}</b></div>
            <div style="padding:8px; border:1px solid #e2e8f0; border-radius:8px;">Kismi: <b>${partial}</b></div>
            <div style="padding:8px; border:1px solid #e2e8f0; border-radius:8px;">Eksik: <b>${missing}</b></div>
            <div style="padding:8px; border:1px solid #e2e8f0; border-radius:8px;">Ort. Skor: <b>${avg}</b></div>
        </div>
    `;

    const rows = students
        .map((s) => ({ ...s, reasons: getSuspiciousReasons(s.attendanceInfo) }))
        .filter(s => s.reasons.length > 0)
        .sort((a, b) => (a.attendanceInfo?.score || 0) - (b.attendanceInfo?.score || 0));

    if (!rows.length) {
        suspicious.innerHTML = `<h4 style="margin:0 0 8px 0;">Supheli Kayitlar</h4><p style="margin:0; color:#64748b;">Bugun supheli kayit bulunmuyor.</p>`;
    } else {
        suspicious.innerHTML = `<h4 style="margin:0 0 8px 0;">Supheli Kayitlar (${rows.length})</h4>` + rows.slice(0, 12).map((s) => `
            <div style="padding:8px; border:1px solid #e2e8f0; border-radius:8px; margin-bottom:8px;">
                <div style="font-weight:700; color:#0f172a;">${escapeHTML(s.studentEmail || "")}</div>
                <div style="font-size:0.82rem; color:#475569;">Skor: ${Number(s.attendanceInfo?.score || 0)} | ${s.reasons.join(", ")}</div>
                <a href="gunluk.html?id=${s.id}" style="font-size:0.8rem;">Gunluge git</a>
            </div>
        `).join("");
    }

    if (!planSummary?.enabled) {
        plan.innerHTML = `<h4 style="margin:0 0 8px 0;">Yoklama Plani</h4><p style="margin:0; color:#64748b;">Bu sinifta yoklama plani etkin degil.</p>`;
    } else {
        const violationHtml = (planSummary.violationRows || []).length
            ? planSummary.violationRows.map((v) => `<div style="font-size:0.8rem; color:#475569; margin-top:4px;">${escapeHTML(v)}</div>`).join("")
            : `<p style="margin:6px 0 0 0; color:#16a34a;">Bu hafta plan ihlali yok.</p>`;

        plan.innerHTML = `
            <h4 style="margin:0 0 8px 0;">Yoklama Plani Ozeti</h4>
            <div style="font-size:0.86rem; color:#334155;">Planlanan gun: <b>${planSummary.plannedDatesCount}</b></div>
            <div style="font-size:0.86rem; color:#334155;">Gerceklesen yoklama: <b>${planSummary.actualTotal}/${planSummary.plannedTotal}</b> (%${planSummary.plannedRatio})</div>
            <div style="font-size:0.86rem; color:#334155;">Plan disi giris: <b>${planSummary.outsideViolations}</b></div>
            <div style="font-size:0.86rem; color:#334155;">Tatil gunu girisi: <b>${planSummary.holidayViolations}</b></div>
            <div style="margin-top:8px; border-top:1px solid #e2e8f0; padding-top:8px;">
                <div style="font-size:0.82rem; font-weight:700; color:#0f172a;">Ihlal Detayi</div>
                ${violationHtml}
            </div>
        `;
    }
}

function hideLoadingScreenNow() {
    const loadingScreen = document.getElementById("loading-screen");
    if (!loadingScreen) return;
    loadingScreen.style.opacity = "0";
    window.setTimeout(() => loadingScreen.classList.add("hidden"), 220);
}

const BOOT_LOADING_FAILSAFE_MS = 12000;
window.setTimeout(() => {
    const loadingScreen = document.getElementById("loading-screen");
    if (!loadingScreen || loadingScreen.classList.contains("hidden")) return;
    console.warn("Panel acilisinda timeout fallback devreye girdi.");
    hideLoadingScreenNow();
}, BOOT_LOADING_FAILSAFE_MS);

let userAdminRows = [];
let currentPanelUser = null;

function roleLabel(role) {
    return role === "admin" ? "Admin" : role === "instructor" ? "Hoca" : "Ogrenci";
}

function normalizeUserRole(role) {
    const r = String(role || "student").toLowerCase(); return r === "admin" ? "admin" : r === "instructor" ? "instructor" : "student";
}
async function callBackend(path, options = {}) {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error("Oturum bulunamadi.");
    const timeoutMs = Number(options.timeoutMs || 12000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
    try {
        const response = await fetch(path, {
            ...fetchOptions,
            signal: fetchOptions.signal || controller.signal,
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + token,
                ...(fetchOptions.headers || {})
            }
        });
        const rawText = await response.text().catch(() => "");
        let data = {};
        try { data = rawText ? JSON.parse(rawText) : {}; } catch (_) { data = {}; }
        if (!response.ok) {
            const detail = data.error || rawText?.slice?.(0, 160) || "Backend istegi basarisiz.";
            throw new Error("Backend " + response.status + ": " + detail);
        }
        return data;
    } catch (e) {
        if (e?.name === "AbortError") throw new Error("Backend istegi zaman asimina ugradi.");
        throw e;
    } finally {
        clearTimeout(timer);
    }
}


function renderProfilePanel(userData = {}) {
    currentPanelUser = userData || currentPanelUser || {};
    const nameInput = document.getElementById("profile-full-name");
    const info = document.getElementById("profile-email-role");
    if (nameInput) nameInput.value = currentPanelUser.fullName || auth.currentUser?.displayName || "";
    if (info) {
        info.innerHTML = `<b>${escapeHTML(currentPanelUser.email || auth.currentUser?.email || "")}</b><br><span class="muted-text">Rol: ${roleLabel(normalizeUserRole(currentPanelUser.role))}</span>`;
    }
}


window.toggleProfileTab = () => {
    renderProfilePanel(currentPanelUser || {});
    document.getElementById("profile-modal")?.classList.remove("hidden");
};

window.closeProfileTab = () => {
    document.getElementById("profile-modal")?.classList.add("hidden");
};
window.saveProfileInfo = async () => {
    const input = document.getElementById("profile-full-name");
    const fullName = (input?.value || "").trim();
    if (!fullName) return alert("Ad soyad bos olamaz.");
    try {
        const result = await callBackend("/api/users/profile", {
            method: "POST",
            body: JSON.stringify({ fullName })
        });
        currentPanelUser = { ...(currentPanelUser || {}), ...(result.user || {}), fullName };
        renderProfilePanel(currentPanelUser);
        window.notify?.("Profil guncellendi.", "success", 3200);
    } catch (e) {
        console.error("Profil guncellenemedi:", e);
        window.notify?.(e.message || "Profil guncellenemedi.", "error", 4500);
    }
};
function renderUserAdminRows(rows = userAdminRows) {
    const list = document.getElementById("user-admin-list");
    const summary = document.getElementById("user-admin-summary");
    if (!list) return;

    const currentUid = auth.currentUser?.uid || "";
    const students = rows.filter((u) => normalizeUserRole(u.role) === "student").length;
    const instructors = rows.filter((u) => normalizeUserRole(u.role) === "instructor").length;
    const admins = rows.filter((u) => normalizeUserRole(u.role) === "admin").length;
    if (summary) summary.innerHTML = `Toplam <b>${rows.length}</b> kullanici | Ogrenci: <b>${students}</b> | Hoca: <b>${instructors}</b> | Admin: <b>${admins}</b>`;

    if (!rows.length) {
        list.innerHTML = "<p class='muted-text'>Kayitli kullanici bulunamadi.</p>";
        return;
    }

    list.innerHTML = rows.map((u) => {
        const role = normalizeUserRole(u.role);
        const self = u.id === currentUid;
        const name = escapeHTML(u.fullName || "Isimsiz kullanici");
        const email = escapeHTML(u.email || "E-posta yok");
        const created = u.createdAt ? formatTimeTr(u.createdAt) : "";
        return `
            <div class="student-card user-admin-card" style="cursor:default;">
                <div>
                    <h4 style="margin:0 0 6px 0;">${name}</h4>
                    <div class="muted-text" style="font-size:0.9rem; word-break:break-word;">${email}</div>
                    <div style="margin-top:8px; font-size:0.82rem; color:var(--muted);">Mevcut rol: <b>${roleLabel(role)}</b>${created ? ` | Kayit: ${created}` : ""}</div>
                </div>
                <div style="margin-top:12px; display:flex; gap:8px; align-items:center;">
                    <select class="input-field" style="margin:0;" ${self ? "disabled" : ""} onchange="handleUserRoleChange('${u.id}', this.value)">
                        <option value="student" ${role === "student" ? "selected" : ""}>Ogrenci</option>
                        <option value="instructor" ${role === "instructor" ? "selected" : ""}>Hoca</option>
                        <option value="admin" ${role === "admin" ? "selected" : ""}>Admin</option>
                    </select>
                    ${self ? `<span class="muted-text" style="font-size:0.78rem; white-space:nowrap;">Kendi rolun</span>` : ""}
                </div>
            </div>
        `;
    }).join("");
}

async function renderUserAdminPanel(force = false) {
    const section = document.getElementById("user-admin-section");
    const list = document.getElementById("user-admin-list");
    if (!section || !list) return;
    section.classList.remove("hidden");
    if (!force && userAdminRows.length) {
        renderUserAdminRows();
        return;
    }
    list.innerHTML = "<p class='muted-text'>Kullanicilar yukleniyor...</p>";
    try {
        const data = await callBackend("/api/admin/users");
        userAdminRows = (data.users || [])
            .sort((a, b) => String(a.email || "").localeCompare(String(b.email || ""), "tr"));
        renderUserAdminRows();
    } catch (e) {
        console.error("Kullanici listesi alinamadi:", e);
        list.innerHTML = `<p class='danger-text'>Kullanicilar yuklenemedi. ${escapeHTML(e.message || "Backend yetkisini kontrol edin.")}</p>`;
    }
}

window.refreshUserAdminPanel = () => renderUserAdminPanel(true);

window.handleUserRoleChange = async (uid, role) => {
    const nextRole = normalizeUserRole(role);
    if (!uid || uid === auth.currentUser?.uid) return;
    const row = userAdminRows.find((u) => u.id === uid);
    const label = row?.email || row?.fullName || uid;
    if (!confirm(`${label} kullanicisinin rolunu ${roleLabel(nextRole)} yapalim mi?`)) {
        renderUserAdminRows();
        return;
    }
    try {
        await callBackend(`/api/admin/users/${encodeURIComponent(uid)}/role`, {
            method: "POST",
            body: JSON.stringify({ role: nextRole })
        });
        window.notify?.("Kullanici rolu guncellendi.", "success", 3500);
        await renderUserAdminPanel(true);
    } catch (e) {
        console.error("Rol guncellenemedi:", e);
        window.notify?.(e.message || "Rol guncellenemedi. Backend yetkisini kontrol edin.", "error", 5000);
        renderUserAdminRows();
    }
};
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = "index.html";
        return;
    }

    try {
        const emailEl = document.getElementById("user-email");
        if (emailEl) emailEl.innerText = user.email || "";
        await fetchAllData();
    } catch (e) {
        reportAppError({
            code: "ERR_PANEL_BOOT_01",
            error: e,
            notifyError: (msg) => window.notify ? window.notify(msg, "error", 5200) : alert(msg),
            fallbackMessage: "Panel verileri yuklenemedi."
        });
        hideLoadingScreenNow();
    }
});

window.handleLogout = async () => { await signOut(auth); window.location.href = "index.html"; };

async function fetchAllData() {
    try {
        const data = await callBackend("/api/panel-data");
        const myUid = auth.currentUser?.uid || data.user?.uid || "";
        const myRole = String(data.user?.role || "").toLowerCase();
        renderProfilePanel(data.user || {});
        const assignedGrid = document.getElementById("assigned-diaries-grid");
        const personalGrid = document.getElementById("personal-diaries-grid");

        if (assignedGrid) assignedGrid.innerHTML = "";
        if (personalGrid) personalGrid.innerHTML = "";

        let hasAssigned = false;
        let hasPersonal = false;

        (Array.isArray(data.studentDiaries) ? data.studentDiaries : []).forEach((row) => {
            if (row.isDeleted) return;
            if (!isPersonalClassName(row.className) && row.instructorEmail !== "") {
                if (assignedGrid) assignedGrid.appendChild(createStudentCard(row, true, false));
                hasAssigned = true;
            }
        });

        groupedClasses = {};
        classDisplayNames = {};
        let hasTeacherDiaries = false;

        (Array.isArray(data.teacherDiaries) ? data.teacherDiaries : []).forEach((row) => {
            if (row.isDeleted) {
                if (row.deletedByUid !== myUid) return;
                const cKey = DELETED_CLASS_KEY;
                if (!groupedClasses[cKey]) groupedClasses[cKey] = [];
                classDisplayNames[cKey] = DELETED_CLASS_LABEL;
                groupedClasses[cKey].push({ ...row, className: DELETED_CLASS_LABEL });
                hasTeacherDiaries = true;
                return;
            }
            if (isPersonalClassName(row.className) || row.instructorEmail === "") {
                if (personalGrid) personalGrid.appendChild(createStudentCard(row, true, true));
                hasPersonal = true;
            } else {
                hasTeacherDiaries = true;
                const cLabel = normalizeClassNameDisplay(row.className);
                const cKey = normalizeClassNameKey(cLabel);
                if (!groupedClasses[cKey]) groupedClasses[cKey] = [];
                if (!classDisplayNames[cKey]) classDisplayNames[cKey] = cLabel;
                groupedClasses[cKey].push({ ...row, className: cLabel });
            }
        });

        if (!hasAssigned && assignedGrid) assignedGrid.innerHTML = "<p style='color:#64748b; font-size:0.9rem;'>Okul tarafindan atanan bir staj gunlugunuz bulunmuyor.</p>";
        if (!hasPersonal && personalGrid) personalGrid.innerHTML = "<p style='color:#64748b; font-size:0.9rem;'>Henuz kisisel bir gunluk olusturmadiniz.</p>";

        renderTeacherFolders();

        const studentSection = document.getElementById("student-section");
        const teacherSection = document.getElementById("teacher-section");
        const userAdminSection = document.getElementById("user-admin-section");
        const shouldShowTeacher = hasTeacherDiaries || myRole === "instructor";
        const shouldShowUserAdmin = myRole === "admin";

        if (hasAssigned) studentSection?.classList.remove("hidden");
        else studentSection?.classList.add("hidden");

        if (shouldShowTeacher) teacherSection?.classList.remove("hidden");
        else teacherSection?.classList.add("hidden");

        if (shouldShowUserAdmin) await renderUserAdminPanel();
        else userAdminSection?.classList.add("hidden");
    } catch (e) {
        reportAppError({
            code: "ERR_PANEL_FETCH_01",
            error: e,
            notifyError: (msg) => window.notify ? window.notify(msg, "error", 5200) : alert(msg),
            fallbackMessage: "Panel verileri islenirken hata olustu."
        });
    } finally {
        setTimeout(() => hideLoadingScreenNow(), 300);
    }
}function formatTimeTr(value) {
    if (!value) return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("tr-TR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    });
}

function normalizeEmail(value = "") {
    return String(value || "").toLowerCase().trim();
}

function isPanelOwnChatMessage(message = {}) {
    const myEmail = normalizeEmail(auth.currentUser?.email || "");
    const senderEmail = normalizeEmail(message.senderEmail || "");
    return (!!myEmail && senderEmail === myEmail) || message.senderRole === "instructor";
}

function panelChatSenderLabel(message = {}) {
    return isPanelOwnChatMessage(message) ? "Sen" : "Ogrenci";
}

async function getDiaryMessageStats(diaryId) {
    try {
        const data = await callBackend(`/api/diaries/${encodeURIComponent(diaryId)}/chat?limit=30`);
        const rows = Array.isArray(data.rows) ? data.rows : [];
        const myEmail = normalizeEmail(auth.currentUser?.email || "");
        const latestStudent = rows.find((m) => m.senderRole === "student" && normalizeEmail(m.senderEmail || "") !== myEmail);
        const unreadCount = rows.filter((m) => m.senderRole === "student" && normalizeEmail(m.senderEmail || "") !== myEmail && !m.readByInstructor).length;
        return { latestStudent, unreadCount };
    } catch (e) {
        console.error("Mesaj istatistikleri alinamadi:", e);
        return { latestStudent: null, unreadCount: 0 };
    }
}
async function renderClassMessageHub(students = []) {
    const list = document.getElementById("class-messages-list");
    const launcher = document.getElementById("panel-chat-launcher");
    if (!list) return;
    if (!students.length) {
        list.innerHTML = "<div class='muted-text'>Bu sinifta ogrenci yok.</div>";
        if (launcher) launcher.innerText = "Mesaj Merkezi";
        return;
    }

    list.innerHTML = "<div class='muted-text'>Mesajlar kontrol ediliyor...</div>";
    const rows = await Promise.all(students.map(async (s) => {
        const stats = await getDiaryMessageStats(s.id);
        return { ...s, ...stats };
    }));

    const withMessages = rows.filter((r) => r.latestStudent);
    const totalUnread = rows.reduce((acc, r) => acc + Number(r.unreadCount || 0), 0);
    if (launcher) launcher.innerText = totalUnread > 0 ? `Mesaj Merkezi (${totalUnread} yeni)` : "Mesaj Merkezi";
    if (!withMessages.length) {
        list.innerHTML = "<div class='muted-text'>Ogrencilerden henuz mesaj gelmedi.</div>";
        return;
    }

    withMessages.sort((a, b) => {
        const ta = Number(a.latestStudent?.createdAtMs || 0);
        const tb = Number(b.latestStudent?.createdAtMs || 0);
        return tb - ta;
    });

    list.innerHTML = withMessages.map((r) => {
        const msg = r.latestStudent || {};
        const when = formatTimeTr(msg.createdAtMs || msg.createdAt);
        const unread = Number(r.unreadCount || 0);
        return `
            <div style="padding:10px 0; border-bottom:1px solid var(--border); display:flex; gap:10px; align-items:flex-start;">
                <div style="flex:1;">
                    <div style="font-weight:700;">${escapeHTML(r.studentEmail || "")}</div>
                    <div style="font-size:0.85rem; color:var(--text); margin-top:4px;">${escapeHTML(String(msg.text || "").slice(0, 140))}</div>
                    <div style="font-size:0.76rem; color:var(--muted); margin-top:4px;">${when}</div>
                </div>
                <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
                    ${unread ? `<span style="background:#fee2e2; color:#991b1b; border-radius:999px; padding:2px 8px; font-size:0.72rem; font-weight:700;">${unread} yeni</span>` : ""}
                    <button class="btn-main" style="width:auto; padding:6px 10px; font-size:0.8rem;" onclick="openChatModal('${r.id}', '${escapeHTML(r.studentEmail || "").replace(/'/g, "\\'")}')">Mesajlar</button>
                </div>
            </div>
        `;
    }).join("");
}

function closeActiveChatSubscription() {
    if (typeof activeChatUnsub === "function") {
        activeChatUnsub();
        activeChatUnsub = null;
    }
}

function setupPanelChatWidget(students = [], className = "") {
    activeChatStudents = Array.isArray(students) ? [...students] : [];
    const widget = document.getElementById("panel-chat-widget");
    const launcher = document.getElementById("panel-chat-launcher");
    const classEl = document.getElementById("panel-chat-class");
    const select = document.getElementById("panel-chat-student-select");
    if (!widget || !launcher || !classEl || !select) return;

    classEl.innerText = `Sinif: ${className || "-"}`;
    widget.classList.add("hidden");
    launcher.classList.remove("hidden");

    if (!activeChatStudents.length) {
        select.innerHTML = `<option value="">Ogrenci yok</option>`;
        document.getElementById("panel-chat-feed").innerHTML = "<div class='muted-text'>Mesajlasacak ogrenci bulunmuyor.</div>";
        launcher.innerText = "Mesaj Merkezi";
        return;
    }

    select.innerHTML = activeChatStudents.map((s) => {
        const label = `${escapeHTML(s.studentEmail || "")} - ${escapeHTML(s.title || "")}`;
        return `<option value="${s.id}">${label}</option>`;
    }).join("");

    const firstId = String(activeChatStudents[0].id || "");
    if (firstId) select.value = firstId;
    const first = activeChatStudents.find((s) => s.id === firstId) || activeChatStudents[0];
    activeChatDiaryId = first?.id || null;
    activeChatStudentEmail = first?.studentEmail || "";
    const studentEl = document.getElementById("panel-chat-student");
    const diaryLink = document.getElementById("panel-chat-diary-link");
    if (studentEl) studentEl.innerText = activeChatStudentEmail || "Ogrenci";
    if (diaryLink && activeChatDiaryId) diaryLink.href = `gunluk.html?id=${activeChatDiaryId}`;
    document.getElementById("panel-chat-feed").innerHTML = "<div class='muted-text'>Mesajlari gormek icin Mesaj Merkezi'ni acin.</div>";
}

window.openPanelChatWidget = () => {
    const widget = document.getElementById("panel-chat-widget");
    const launcher = document.getElementById("panel-chat-launcher");
    if (!widget || !launcher) return;
    widget.classList.remove("hidden");
    launcher.classList.add("hidden");
    if (activeChatDiaryId) {
        const student = activeChatStudents.find((s) => s.id === activeChatDiaryId);
        window.openChatModal(activeChatDiaryId, student?.studentEmail || activeChatStudentEmail || "");
    }
};

window.minimizePanelChatWidget = () => {
    const widget = document.getElementById("panel-chat-widget");
    const launcher = document.getElementById("panel-chat-launcher");
    if (!widget || !launcher) return;
    widget.classList.add("hidden");
    launcher.classList.remove("hidden");
};

window.handlePanelChatStudentChange = () => {
    const select = document.getElementById("panel-chat-student-select");
    const diaryId = String(select?.value || "");
    if (!diaryId) return;
    const student = activeChatStudents.find((s) => s.id === diaryId);
    window.openChatModal(diaryId, student?.studentEmail || "");
};

async function markInstructorMessagesRead(diaryId) {
    try {
        await callBackend(`/api/diaries/${encodeURIComponent(diaryId)}/chat-read`, {
            method: "POST",
            body: JSON.stringify({ who: "instructor" })
        });
    } catch (e) {
        console.error("Mesajlar okundu guncellenemedi:", e);
    }
}
window.openChatModal = async (diaryId, studentEmail) => {
    activeChatDiaryId = diaryId;
    activeChatStudentEmail = studentEmail || "";
    activeChatClassName = document.getElementById("view-title")?.innerText || activeClassForEdit || "";

    const classEl = document.getElementById("panel-chat-class");
    const studentEl = document.getElementById("panel-chat-student");
    const diaryLink = document.getElementById("panel-chat-diary-link");
    if (classEl) classEl.innerText = `Sinif: ${activeChatClassName || "-"}`;
    if (studentEl) studentEl.innerText = studentEmail || "Ogrenci";
    if (diaryLink) diaryLink.href = `gunluk.html?id=${diaryId}`;
    const select = document.getElementById("panel-chat-student-select");
    const launcher = document.getElementById("panel-chat-launcher");
    if (select && select.value !== diaryId) select.value = diaryId;
    document.getElementById("panel-chat-feed").innerHTML = "<div class='muted-text'>Mesajlar yukleniyor...</div>";
    document.getElementById("panel-chat-widget").classList.remove("hidden");
    if (launcher) launcher.classList.add("hidden");

    closeActiveChatSubscription();
    const qMsg = query(collection(db, "diaries", diaryId, "chatMessages"), orderBy("createdAtMs", "asc"), limit(200));
    activeChatUnsub = onSnapshot(qMsg, (snap) => {
        const rows = [];
        snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
        const feed = document.getElementById("panel-chat-feed");
        if (!feed) return;
        if (!rows.length) {
            feed.innerHTML = "<div class='muted-text'>Henuz mesaj yok.</div>";
            return;
        }
        feed.innerHTML = rows.map((m) => {
            const mine = isPanelOwnChatMessage(m);
            const label = panelChatSenderLabel(m);
            const when = formatTimeTr(m.createdAtMs || m.createdAt);
            return `
                <div style="display:flex; ${mine ? "justify-content:flex-end;" : ""} margin-bottom:8px;">
                    <div style="max-width:80%; background:${mine ? "#dbeafe" : "var(--card)"}; border:1px solid var(--border); border-radius:10px; padding:8px 10px; color:${mine ? "#0f172a" : "var(--text)"};">
                        <div style="font-size:0.88rem; color:${mine ? "#0f172a" : "var(--text)"};">${escapeHTML(m.text || "")}</div>
                        <div style="font-size:0.74rem; color:${mine ? "#334155" : "var(--muted)"}; margin-top:4px;">${label}${when ? ` - ${when}` : ""}</div>
                    </div>
                </div>
            `;
        }).join("");
        feed.scrollTop = feed.scrollHeight;
    });

    await markInstructorMessagesRead(diaryId);
    const classKey = activeClassForEdit;
    if (classKey && groupedClasses[classKey]) {
        renderClassMessageHub(groupedClasses[classKey]);
    }
};

window.sendPanelChatMessage = async () => {
    const input = document.getElementById("panel-chat-input");
    const btn = document.getElementById("panel-chat-send-btn");
    const text = (input?.value || "").trim();
    if (!activeChatDiaryId) return alert("Gorusme secili degil.");
    if (!text) return;
    if (btn) { btn.disabled = true; btn.innerText = "Gonderiliyor..."; }
    try {
        await callBackend(`/api/diaries/${encodeURIComponent(activeChatDiaryId)}/chat`, {
            method: "POST",
            body: JSON.stringify({ text })
        });
        if (input) input.value = "";
        const classKey = activeClassForEdit;
        if (classKey && groupedClasses[classKey]) {
            renderClassMessageHub(groupedClasses[classKey]);
        }
    } catch (e) {
        console.error(e);
        alert("Mesaj gonderilemedi.");
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = "Gonder"; }
    }
};

function getSuspiciousReasons(attendanceInfo = {}) {
    const flags = attendanceInfo?.flags || {};
    const reasons = [];
    if (flags.missingMorning) reasons.push("Sabah yok");
    if (flags.missingEvening) reasons.push("Aksam yok");
    if (flags.metaWarning) reasons.push("Meta uyari");
    if (flags.accuracyWarning) reasons.push("GPS dusuk");
    if (flags.distanceWarning) reasons.push("Konum uzak");
    return reasons;
}

function attendanceBlockHTML(attendanceInfo = null) {
    const info = attendanceInfo || {
        score: 0,
        statusLabel: "Yoklama bekleniyor",
        statusTone: "neutral",
        notes: ["Veri henuz yuklenmedi"],
        flags: { missingMorning: false, missingEvening: false, metaWarning: false, accuracyWarning: false }
    };
    const tone = info.statusTone || "neutral";
    const colors = {
        ok: { bg: "#dcfce7", text: "#166534", border: "#86efac" },
        warn: { bg: "#fef3c7", text: "#92400e", border: "#fbbf24" },
        bad: { bg: "#fee2e2", text: "#991b1b", border: "#fca5a5" },
        neutral: { bg: "#f1f5f9", text: "#475569", border: "#cbd5e1" }
    };
    const c = colors[tone] || colors.neutral;
    const notes = Array.isArray(info.notes) && info.notes.length ? info.notes : ["Not yok"];
    return `
        <div style="border:1px solid ${c.border}; background:${c.bg}; color:${c.text}; border-radius:10px; padding:8px; margin:8px 0; font-size:0.82rem;">
            <div style="display:flex; justify-content:space-between; gap:8px; font-weight:700;">
                <span>${escapeHTML(info.statusLabel || "Yoklama")}</span>
                <span>${Number(info.score || 0)}/100</span>
            </div>
            <div style="margin-top:4px; color:${c.text}; opacity:.9;">${notes.map((n) => escapeHTML(n)).join(" | ")}</div>
        </div>
    `;
}
function createStudentCard(data, isStudentView, isPersonal = false, attendanceInfo = null) {
    const statusColors = {
        'active': { bg: '#eff6ff', text: '#1d4ed8', label: 'Aktif' },
        'pending': { bg: '#fef9c3', text: '#854d0e', label: 'Beklemede' },
        'approved': { bg: '#dcfce7', text: '#166534', label: 'Onaylandi' },
        'deleted': { bg: '#fee2e2', text: '#991b1b', label: 'Silindi' },
        'rejected': { bg: '#fee2e2', text: '#991b1b', label: 'Reddedildi' }
    };
    const sData = statusColors[data.status || 'active'] || statusColors.active;
    const instEmail = data.instructorEmail ? escapeHTML(data.instructorEmail) : "Yok";
    const studentEmail = escapeHTML(data.studentEmail);

    const card = document.createElement("div");
    card.className = "student-card";

    let roleInfo = "";
    if (isStudentView) {
        roleInfo = isPersonal
            ? `<p style="font-size: 0.85rem; color: #ea580c; font-weight:bold; margin: 0;">Kimse Goremez</p>`
            : `<p style="font-size: 0.9rem; color: #64748b; margin: 0;">Hoca: <b>${instEmail}</b></p>`;
    } else {
        roleInfo = `<p style="color:#3b82f6; font-weight:bold; margin-bottom: 5px;">${studentEmail}</p>`;
    }

    let actionBtns = "";
    if (isPersonal) {
        actionBtns = `
            <button onclick="openDiarySettingsModal('${data.id}', '${escapeHTML(data.title).replace(/'/g, "\\'")}')" class="btn-warning" style="padding: 6px 10px; font-size: 0.8rem; margin-right: 5px;">Ayarlar</button>
            <button onclick="handleDeletePersonalDiary('${data.id}')" class="btn-danger" style="padding: 6px 10px; font-size: 0.8rem; margin-right: 5px;">Sil</button>
        `;
    } else if (!isStudentView) {
        if (data.isDeleted) {
            actionBtns = `
                <button onclick="handleRestoreAssignedDiary('${data.id}')" class="btn-success" style="padding: 6px 10px; font-size: 0.8rem; margin-right: 5px;">Geri Getir</button>
            `;
        } else {
            actionBtns = `
                <button onclick="handleDeleteAssignedDiary('${data.id}')" class="btn-danger" style="padding: 6px 10px; font-size: 0.8rem; margin-right: 5px;">Sil</button>
            `;
        }
    }

    const attendanceHtml = !isStudentView ? attendanceBlockHTML(attendanceInfo) : "";

    card.innerHTML = `
        <div>
            <h4>${escapeHTML(data.title)}</h4>
            ${roleInfo}
            ${attendanceHtml}
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #f1f5f9; padding-top: 15px;">
            <span style="background: ${isPersonal ? '#ffedd5' : sData.bg}; color: ${isPersonal ? '#c2410c' : sData.text}; padding: 5px 10px; border-radius: 6px; font-size: 0.8rem; font-weight: bold;">${isPersonal ? 'Kisisel' : sData.label}</span>
            <div>
                ${actionBtns}
                <button onclick="window.location.href='gunluk.html?id=${data.id}'" class="btn-main" style="padding: 6px 12px; font-size: 0.9rem; ${isPersonal ? 'background:#ea580c;' : ''}">Gunluge Git</button>
            </div>
        </div>
    `;
    return card;
}
// --- TEKIL OGRENCI EKLEME (HOCA ICIN) ---
window.openAddStudentModal = (classKey) => {
    activeClassForEdit = classKey;
    document.getElementById("add-student-class-name").innerText = `Sinif: ${getClassLabel(classKey)}`;
    document.getElementById("new-student-email").value = "";
    document.getElementById("new-student-title").value = "";
    document.getElementById("add-student-modal").classList.remove("hidden");
};

window.openQuickIndependentAddModal = () => {
    const classKey = ensureIndependentClassState();
    openAddStudentModal(classKey);
};

window.closeAddStudentModal = () => {
    document.getElementById("add-student-modal").classList.add("hidden");
};

window.handleAddStudent = async () => {
    if (activeClassForEdit === DELETED_CLASS_KEY) return alert("Silinen Gunlukler sinifina ogrenci eklenemez.");
    const email = document.getElementById("new-student-email").value.trim().toLowerCase();
    const rawTitle = document.getElementById("new-student-title").value.trim();

    if (!email || !rawTitle) return alert("Lutfen ogrenci e-posta adresini ve dosya ismini girin!");

    const title = rawTitle.replace(/\s+/g, '_');
    const btn = document.querySelector('#add-student-modal .btn-success');
    btn.innerText = "Ekleniyor...";
    btn.disabled = true;

    try {
        const myEmail = auth.currentUser.email.toLowerCase().trim();
        const myUid = auth.currentUser.uid;

        let classLocked = false;
        let classLockDays = 0;
        let classRequireShiftProof = false;
        let classAttendancePolicy = {
            attendancePolicyEnabled: false,
            attendanceStartDate: "",
            attendanceEndDate: "",
            attendanceDaysPerWeek: 5,
            attendanceIncludeWeekends: false,
            attendanceWeekdays: [1, 2, 3, 4, 5],
            attendanceHolidays: []
        };
        if (groupedClasses[activeClassForEdit] && groupedClasses[activeClassForEdit].length > 0) {
            const sample = groupedClasses[activeClassForEdit][0];
            classLocked = sample.isLocked || false;
            classLockDays = sample.lockDays || 0;
            classRequireShiftProof = !!sample.requireShiftProof;
            classAttendancePolicy = {
                attendancePolicyEnabled: !!sample.attendancePolicyEnabled,
                attendanceStartDate: normalizeDateYmd(sample.attendanceStartDate || ""),
                attendanceEndDate: normalizeDateYmd(sample.attendanceEndDate || ""),
                attendanceDaysPerWeek: Number(sample.attendanceDaysPerWeek || 5),
                attendanceIncludeWeekends: !!sample.attendanceIncludeWeekends,
                attendanceWeekdays: Array.isArray(sample.attendanceWeekdays) ? sample.attendanceWeekdays : [1, 2, 3, 4, 5],
                attendanceHolidays: Array.isArray(sample.attendanceHolidays) ? sample.attendanceHolidays : []
            };
        }

        await callBackend("/api/diaries/assigned", {
            method: "POST",
            body: JSON.stringify({
                className: getClassLabel(activeClassForEdit),
                title,
                studentEmail: email,
                isLocked: classLocked,
                lockDays: classLockDays,
                requireShiftProof: classRequireShiftProof,
                ...classAttendancePolicy
            })
        });

        alert("Ogrenci basariyla eklendi!");
        closeAddStudentModal();
        await fetchAllData();
        openClassFolder(activeClassForEdit);
    } catch (err) {
        console.error(err);
        alert("Ogrenci eklenirken hata olustu.");
    } finally {
        btn.innerText = "Ogrenciyi Ekle";
        btn.disabled = false;
    }
};

window.handleDeletePersonalDiary = async (id) => {
    if (confirm("Bu gunlugu kalici olarak silmek istediginize emin misiniz?")) {
        try {
            await callBackend(`/api/diaries/${encodeURIComponent(id)}/delete-personal`, { method: "DELETE" });
            location.reload();
        } catch (e) {
            alert("Silinemedi!");
        }
    }
};

window.handleDeleteAssignedDiary = async (id) => {
    if (!confirm("Bu ogrenciye atanmis gunlugu silmek istediginize emin misiniz?")) return;
    try {
        const current = Object.values(groupedClasses).flat().find((x) => x.id === id) || {};
        const originalClassName = current.className || getClassLabel(activeClassForEdit) || "Bagimsiz Ogrenciler";
        await callBackend(`/api/diaries/${encodeURIComponent(id)}/delete-assigned`, {
            method: "POST",
            body: JSON.stringify({ originalClassName })
        });
        await fetchAllData();
        if (activeClassForEdit && groupedClasses[activeClassForEdit]) {
            await openClassFolder(activeClassForEdit);
        } else {
            goBackToFolders();
        }
    } catch (e) {
        console.error(e);
        alert("Gunluk silinemedi.");
    }
};

window.handleRestoreAssignedDiary = async (id) => {
    if (!confirm("Bu gunlugu eski sinifina geri getirmek istiyor musunuz?")) return;
    try {
        const current = Object.values(groupedClasses).flat().find((x) => x.id === id) || {};
        const restoredClass = current.originalClassName || "Bagimsiz Ogrenciler";
        await callBackend(`/api/diaries/${encodeURIComponent(id)}/restore`, {
            method: "POST",
            body: JSON.stringify({ className: restoredClass })
        });
        await fetchAllData();
        if (activeClassForEdit && groupedClasses[activeClassForEdit]) {
            await openClassFolder(activeClassForEdit);
        } else {
            goBackToFolders();
        }
    } catch (e) {
        console.error(e);
        alert("Gunluk geri getirilemedi.");
    }
};

window.openDiarySettingsModal = (id, currentTitle) => {
    activeDiaryForEdit = id;
    document.getElementById("edit-diary-title").value = currentTitle;
    document.getElementById("diary-settings-modal").classList.remove("hidden");
};
window.closeDiarySettingsModal = () => document.getElementById("diary-settings-modal").classList.add("hidden");

window.handleUpdateDiaryTitle = async () => {
    const newTitle = document.getElementById("edit-diary-title").value.trim();
    if (!newTitle) return alert("Baslik bos olamaz!");
    try {
        await callBackend(`/api/diaries/${encodeURIComponent(activeDiaryForEdit)}/title`, {
            method: "POST",
            body: JSON.stringify({ title: newTitle })
        });
        closeDiarySettingsModal();
        fetchAllData();
    } catch (e) {
        alert("Hata!");
    }
};

function renderTeacherFolders() {
    const grid = document.getElementById('folder-grid');
    if (!grid) return;
    grid.innerHTML = "";
    const classNames = Object.keys(groupedClasses);
    if (classNames.length === 0) return;

    classNames.forEach(classKey => {
        const studentCount = groupedClasses[classKey].length;
        const classLabel = getClassLabel(classKey);
        const folderDiv = document.createElement("div");
        folderDiv.className = "folder-card";
        folderDiv.onclick = () => openClassFolder(classKey);
        folderDiv.innerHTML = `<div class="folder-icon">&#128193;</div><div class="folder-title">${escapeHTML(classLabel)}</div><div style="color: #64748b; font-size: 0.9rem;">${studentCount} Ogrenci</div>`;
        grid.appendChild(folderDiv);
    });
}

function appendStudentCardSafe(list, student, attendanceInfo = null) {
    try {
        list.appendChild(createStudentCard(student, false, false, attendanceInfo));
        return true;
    } catch (e) {
        console.error("Ogrenci karti olusturulamadi:", student, e);
        const fallback = document.createElement("div");
        fallback.className = "student-card";
        fallback.innerHTML = `
            <div>
                <h4>${escapeHTML(student?.title || "Baslik yok")}</h4>
                <p style="color:#3b82f6; font-weight:bold; margin-bottom:5px;">${escapeHTML(student?.studentEmail || "E-posta yok")}</p>
                <p class="danger-text" style="margin:6px 0 0 0;">Kart detaylari yuklenemedi, temel bilgiler gosteriliyor.</p>
            </div>
            <div style="display:flex; justify-content:flex-end; border-top:1px solid #f1f5f9; padding-top:15px;">
                <button onclick="window.location.href='gunluk.html?id=${student?.id || ""}'" class="btn-main" style="padding:6px 12px; font-size:0.9rem;">Gunluge Git</button>
            </div>
        `;
        list.appendChild(fallback);
        return false;
    }
}

window.openClassFolder = async (classKey) => {
    activeClassForEdit = classKey;
    const classLabel = getClassLabel(classKey);
    const isDeletedClass = classKey === DELETED_CLASS_KEY;
    document.getElementById('view-title').innerText = classLabel;
    document.getElementById('folders-view').classList.add('hidden');
    document.getElementById('students-view').classList.remove('hidden');
    
    document.getElementById('delete-class-btn').onclick = () => handleDeleteClass(classKey);
    document.getElementById('class-settings-btn').onclick = () => openClassSettingsModal(classKey);
    document.getElementById('class-pdf-btn').onclick = (event) => { event.stopPropagation(); document.getElementById('class-pdf-menu')?.classList.toggle('hidden'); };
    document.getElementById('class-pdf-daily-btn').onclick = () => generateClassPDF(classKey, classLabel, 'daily');
    document.getElementById('class-pdf-weekly-btn').onclick = () => generateClassPDF(classKey, classLabel, 'weekly');
    document.getElementById('add-student-btn').onclick = () => openAddStudentModal(classKey);
    document.getElementById('class-notify-btn').onclick = () => openClassNotifyModal(classKey);
    document.getElementById('class-meeting-btn').onclick = () => openClassMeetingModal(classKey);
    const addBtn = document.getElementById('add-student-btn');
    const notifyBtn = document.getElementById('class-notify-btn');
    const settingsBtn = document.getElementById('class-settings-btn');
    const meetingBtn = document.getElementById('class-meeting-btn');
    if (addBtn) addBtn.disabled = isDeletedClass;
    if (notifyBtn) notifyBtn.disabled = isDeletedClass;
    if (settingsBtn) settingsBtn.disabled = isDeletedClass;
    if (meetingBtn) meetingBtn.disabled = isDeletedClass;

    const list = document.getElementById('student-list');
    const note = document.getElementById('student-list-note');
    const rawStudents = groupedClasses[classKey] || [];
    const students = Array.isArray(rawStudents) ? rawStudents : Object.values(rawStudents || {}).filter(Boolean);
    if (note) note.innerText = `${students.length} gunluk bulundu.`;
    clearClassInsights();

    const renderStudents = (rows, withAttendance = false) => {
        if (!list) return;
        list.innerHTML = "";
        if (!rows.length) {
            list.innerHTML = "<p style='color:#64748b;'>Bu sinifta ogrenci yok.</p>";
            return;
        }
        rows.forEach(student => appendStudentCardSafe(list, student, withAttendance ? student.attendanceInfo : null));
        if (!list.children.length) {
            list.innerHTML = "<p class='danger-text'>Gunlukler bulundu ama kartlar olusturulamadi. Konsolu kontrol edin.</p>";
        }
    };

    renderStudents(students, false);
    setupPanelChatWidget(students, classLabel);

    Promise.all(students.map(async (student) => {
        const attendanceInfo = await getTodayAttendanceInfo(student.id);
        return { ...student, attendanceInfo };
    })).then(async (enriched) => {
        const planSummary = await getClassPlanSummary(students).catch((e) => {
            console.error("Yoklama plani ozeti alinamadi:", e);
            return { enabled: false };
        });
        if (activeClassForEdit !== classKey) return;
        renderStudents(enriched, true);
        renderClassInsights(enriched, planSummary);
    }).catch((e) => {
        console.error("Sinif ogrenci/yoklama verisi yuklenemedi:", e);
        if (activeClassForEdit === classKey && list) {
            const warn = document.createElement("p");
            warn.className = "danger-text";
            warn.textContent = "Yoklama verileri yuklenemedi. Ogrenci listesi temel bilgilerle gosteriliyor.";
            list.prepend(warn);
        }
    });

    renderClassMessageHub(students).catch((e) => {
        console.error("Sinif mesaj merkezi yuklenemedi:", e);
        const msgList = document.getElementById("class-messages-list");
        if (msgList) msgList.innerHTML = "<div class='danger-text'>Mesajlar yuklenemedi. Backend veya rules yetkisini kontrol edin.</div>";
    });
};
window.goBackToFolders = () => {
    document.getElementById('folders-view').classList.remove('hidden');
    document.getElementById('students-view').classList.add('hidden');
    clearClassInsights();
    closeActiveChatSubscription();
    document.getElementById("panel-chat-widget")?.classList.add("hidden");
    document.getElementById("panel-chat-launcher")?.classList.add("hidden");
};


window.openClassMeetingModal = (classKey) => {
    if (classKey === DELETED_CLASS_KEY) return alert("Silinen Gunlukler sinifina toplanti eklenemez.");
    activeClassForEdit = classKey;
    const students = groupedClasses[classKey] || [];
    if (!students.length) return alert("Bu sinifta toplanti atanacak ogrenci bulunamadi.");
    const nameEl = document.getElementById("class-meeting-name");
    if (nameEl) nameEl.innerText = `Sinif: ${getClassLabel(classKey)} | ${students.length} gunluk`;
    const titleEl = document.getElementById("class-meeting-title");
    const startEl = document.getElementById("class-meeting-start");
    const urlEl = document.getElementById("class-meeting-url");
    const descEl = document.getElementById("class-meeting-description");
    if (titleEl) titleEl.value = "";
    if (urlEl) urlEl.value = "";
    if (descEl) descEl.value = "";
    if (startEl) {
        const d = new Date(Date.now() + 60 * 60 * 1000);
        const pad = (n) => String(n).padStart(2, "0");
        startEl.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    document.getElementById("class-meeting-modal")?.classList.remove("hidden");
};

window.closeClassMeetingModal = () => {
    document.getElementById("class-meeting-modal")?.classList.add("hidden");
};

window.handleCreateClassMeeting = async () => {
    const classKey = activeClassForEdit;
    const students = groupedClasses[classKey] || [];
    const title = (document.getElementById("class-meeting-title")?.value || "").trim();
    const startsAt = (document.getElementById("class-meeting-start")?.value || "").trim();
    const meetingUrl = (document.getElementById("class-meeting-url")?.value || "").trim();
    const description = (document.getElementById("class-meeting-description")?.value || "").trim();
    const btn = document.getElementById("class-meeting-save-btn");
    if (!classKey || !students.length) return alert("Sinif secimi bulunamadi.");
    if (!title) return alert("Toplanti basligi gerekli.");
    if (!startsAt) return alert("Toplanti tarihi gerekli.");
    if (meetingUrl && !/^https?:\/\//i.test(meetingUrl)) return alert("Toplanti linki bos olabilir ama doluysa http/https ile baslamali.");
    try {
        if (btn) { btn.disabled = true; btn.innerText = "Olusturuluyor..."; }
        const result = await callBackend("/api/classes/meetings", {
            method: "POST",
            body: JSON.stringify({
                className: getClassLabel(classKey),
                diaryIds: students.map((student) => student.id),
                title,
                startsAt,
                meetingUrl,
                description
            })
        });
        window.notify?.(`${result.count || students.length} gunluge toplanti bildirimi gonderildi.`, "success", 4200);
        closeClassMeetingModal();
    } catch (e) {
        console.error("Toplanti olusturulamadi:", e);
        window.notify?.(e.message || "Toplanti olusturulamadi.", "error", 5200);
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = "Toplantiyi Olustur"; }
    }
};
window.openClassNotifyModal = (classKey) => {
    if (classKey === DELETED_CLASS_KEY) return alert("Silinen Gunlukler sinifina bildirim gonderilemez.");
    activeClassForEdit = classKey;
    const nameEl = document.getElementById("class-notify-name");
    const titleEl = document.getElementById("class-notify-title");
    const msgEl = document.getElementById("class-notify-message");
    if (nameEl) nameEl.innerText = `Sinif: ${getClassLabel(classKey)}`;
    if (titleEl) titleEl.value = "";
    if (msgEl) msgEl.value = "";
    document.getElementById("class-notify-modal")?.classList.remove("hidden");
};

window.closeClassNotifyModal = () => {
    document.getElementById("class-notify-modal")?.classList.add("hidden");
};

window.handleSendClassNotification = async () => {
    const className = activeClassForEdit;
    const title = (document.getElementById("class-notify-title")?.value || "").trim();
    const message = (document.getElementById("class-notify-message")?.value || "").trim();
    const btn = document.getElementById("class-notify-send-btn");

    if (!className) return alert("Sinif secimi bulunamadi.");
    if (!message) return alert("Lutfen bildirim mesaji yazin.");

    const students = groupedClasses[className] || [];
    if (!students.length) return alert("Bu sinifta bildirim gonderilecek ogrenci bulunamadi.");

    const fullMessage = title ? `${title}\n${message}` : message;
    if (btn) { btn.disabled = true; btn.innerText = "Gonderiliyor..."; }

    try {
        const result = await callBackend("/api/classes/notify", {
            method: "POST",
            body: JSON.stringify({
                diaryIds: students.map((student) => student.id),
                title: title || "",
                message
            })
        });

        alert(`${result.count || students.length} ogrenciye bildirim gonderildi.`);
        closeClassNotifyModal();
    } catch (e) {
        reportAppError("class_notify_send", e, { className, studentCount: students.length });
        alert("Bildirim gonderilirken hata olustu.");
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = "Bildirimi Gonder"; }
    }
};

window.handleDeleteClass = async (classKey) => {
    const classLabel = getClassLabel(classKey);
    const confirmation = prompt(`DIKKAT! "${classLabel}" sinifini SILIYORSUNUZ.\nOnaylamak icin sinifin tam adini yazin:`);
    if (confirmation !== classLabel) return;
    const btn = document.getElementById('delete-class-btn');
    if (btn) {
        btn.innerText = "Siliniyor...";
        btn.disabled = true;
    }
    try {
        const studentsInClass = groupedClasses[classKey] || [];
        await callBackend("/api/classes/delete", {
            method: "POST",
            body: JSON.stringify({ diaryIds: studentsInClass.map((student) => student.id) })
        });
        alert("Sinif basariyla silindi!");
        location.reload();
    } catch (err) {
        reportAppError("delete_class", err, { classKey, classLabel });
        alert("Sinif silinirken hata olustu.");
        if (btn) {
            btn.innerText = "Sinifi Sil";
            btn.disabled = false;
        }
    }
};

window.openClassSettingsModal = (classKey) => {
    if (classKey === DELETED_CLASS_KEY) return alert("Silinen Gunlukler sinifinda ayar degisikligi yapilamaz.");
    activeClassForEdit = classKey;
    document.getElementById("class-settings-name").innerText = `Secilen Sinif: ${getClassLabel(classKey)}`;
    const studentsInClass = groupedClasses[classKey] || [];
    const sample = studentsInClass[0] || {};
    document.getElementById("bulk-edit-is-locked").checked = !!sample.isLocked;
    document.getElementById("bulk-edit-lock-days").value = Number(sample.lockDays || 0);
    const reqEl = document.getElementById("bulk-edit-require-shift-proof");
    if (reqEl) reqEl.checked = !!sample.requireShiftProof;
    applyAttendancePolicyToForm("edit", getAttendancePolicyFromDoc(sample));
    document.getElementById("class-settings-modal").classList.remove("hidden");
};
window.closeClassSettingsModal = () => document.getElementById("class-settings-modal").classList.add("hidden");

window.handleUpdateClassSettings = async () => {
    const isLocked = document.getElementById("bulk-edit-is-locked").checked;
    const lockDays = parseInt(document.getElementById("bulk-edit-lock-days").value) || 0;
    const requireShiftProof = !!document.getElementById("bulk-edit-require-shift-proof")?.checked;
    try {
        const attendancePolicy = readAttendancePolicyFromForm("edit");
        const studentsInClass = groupedClasses[activeClassForEdit] || [];
        if (!studentsInClass.length) throw new Error("Bu sinifta guncellenecek ogrenci bulunamadi.");
        await callBackend("/api/classes/settings", {
            method: "POST",
            body: JSON.stringify({
                diaryIds: studentsInClass.map((student) => student.id),
                isLocked,
                lockDays,
                requireShiftProof,
                ...attendancePolicy
            })
        });
        alert("Sinifin ayarlari basariyla guncellendi!");
        closeClassSettingsModal(); fetchAllData();
    } catch (e) {
        reportAppError("update_class_settings", e, { classKey: activeClassForEdit });
        alert(e?.message || "Guncelleme hatasi!");
    }
};

const panelPdfActions = createPanelPdfActions({
    groupedClassesRef: () => groupedClasses,
    getAttendanceScoreFromLog,
    callBackend
});
window.generateClassPDF = panelPdfActions.generateClassPDF;

window.openCreateDiaryModal = () => document.getElementById('create-diary-modal').classList.remove('hidden');
window.closeCreateDiaryModal = () => document.getElementById('create-diary-modal').classList.add('hidden');
window.handleCreateDiary = async () => {
    const t = document.getElementById('new-diary-title').value.trim();
    if (!t) return alert("Baslik girin!");
    try {
        await callBackend("/api/diaries/personal", {
            method: "POST",
            body: JSON.stringify({ title: t })
        });
        closeCreateDiaryModal();
        fetchAllData();
    } catch (e) {
        alert(e.message || "Hata!");
    }
};
window.openBulkModal = () => {
    document.getElementById('bulk-modal').classList.remove('hidden');
    applyAttendancePolicyToForm("bulk", DEFAULT_ATTENDANCE_POLICY);
};
window.closeBulkModal = () => document.getElementById('bulk-modal').classList.add('hidden');
window.handleBulkUpload = async () => {
    const fInp = document.getElementById('excel-file');
    const cName = document.getElementById('bulk-class-name').value.trim();
    const lDays = parseInt(document.getElementById('bulk-lock-days').value) || 0;
    const btn = document.getElementById('bulk-submit-btn');
    if (!cName || !fInp.files.length) return alert("Eksik bilgi!");
    const r = new FileReader();
    btn.innerText = "Okunuyor...";
    btn.disabled = true;
    r.onload = async (e) => {
        try {
            await ensureXlsxLoaded();
            const attendancePolicy = readAttendancePolicyFromForm("bulk");
            const d = new Uint8Array(e.target.result);
            const wb = XLSX.read(d, { type: 'array' });
            const js = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
            if (!js.length) throw new Error("Bos!");
            const uId = auth.currentUser.uid;
            const mEm = auth.currentUser.email.toLowerCase().trim();
            btn.innerText = "Olusturuluyor...";
            const students = js.map((row) => {
                const cr = {};
                Object.keys(row).forEach(k => cr[k.toString().toLowerCase().trim()] = row[k]);
                const em = cr['email'] || cr['e-posta'] || "";
                const no = cr['no'] || "";
                const ad = cr['ad'] || "";
                const sy = cr['soyad'] || cr['soyisim'] || "";
                return {
                    email: String(em).toLowerCase().trim(),
                    no,
                    ad,
                    soyad: sy,
                    title: `${no}_${ad}_${sy}`.replace(/\s+/g, '_')
                };
            }).filter((row) => row.email);
            const result = await callBackend("/api/diaries/bulk", {
                method: "POST",
                body: JSON.stringify({
                    className: cName,
                    lockDays: lDays,
                    requireShiftProof: false,
                    ...attendancePolicy,
                    students
                })
            });
            alert(`${result.count || 0} ogrenci eklendi.`);
            closeBulkModal();
            fetchAllData();
        } catch(err) {
            alert(err?.message || "Hata olustu.");
        } finally {
            btn.innerText = "Yukle";
            btn.disabled = false;
        }
    };
    r.readAsArrayBuffer(fInp.files[0]);
};
const escapeHTML = (s) => { if (!s) return ""; return String(s).replace(/[&<>'"]/g, (t) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[t])); };
















window.addEventListener('click', (event) => { if (!event.target?.closest?.('.split-action')) document.getElementById('class-pdf-menu')?.classList.add('hidden'); });












