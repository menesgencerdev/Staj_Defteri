import { onRequest } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldPath, FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { randomUUID } from "crypto";

initializeApp();

const db = getFirestore();
const adminAuth = getAuth();
const adminStorage = getStorage();
const allowedRoles = new Set(["student", "instructor", "admin"]);
const deletedClassLabel = "Silinen Gunlukler";

function json(res, status, payload) {
  res.status(status).json(payload);
}

function normalizeRole(role) {
  const value = String(role || "student").toLowerCase().trim();
  return allowedRoles.has(value) ? value : "student";
}

function validPublicSignupRole(role) {
  const value = String(role || "student").toLowerCase().trim();
  return value === "instructor" ? "instructor" : "student";
}

function cleanText(value, max = 300) {
  return String(value || "").trim().slice(0, max);
}

function cleanEmail(value) {
  return String(value || "").toLowerCase().trim().slice(0, 180);
}

function presenceDocId(email = "") {
  return cleanEmail(email).replace(/[^a-z0-9]/g, "_").slice(0, 120) || "unknown";
}

function isInstructorLike(actor) {
  return actor.role === "instructor" || actor.role === "admin";
}

function publicUser(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    email: String(data.email || ""),
    fullName: String(data.fullName || data.name || ""),
    role: normalizeRole(data.role),
    createdAt: data.createdAt || "",
    roleUpdatedAt: data.roleUpdatedAt || "",
    roleUpdatedByEmail: data.roleUpdatedByEmail || ""
  };
}

function getPath(req) {
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  return url.pathname.replace(/^\/api/, "") || "/";
}

async function requireSignedUser(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const err = new Error("Oturum tokeni eksik.");
    err.status = 401;
    throw err;
  }

  const decoded = await adminAuth.verifyIdToken(match[1]);
  const userRef = db.collection("users").doc(decoded.uid);
  const userSnap = await userRef.get();
  const profile = userSnap.exists ? userSnap.data() : {};
  return {
    uid: decoded.uid,
    email: cleanEmail(decoded.email || profile.email || ""),
    role: normalizeRole(profile.role),
    fullName: String(profile.fullName || profile.name || ""),
    profile
  };
}

function requireAdmin(actor) {
  if (actor.role !== "admin") {
    const err = new Error("Bu islem icin admin yetkisi gerekir.");
    err.status = 403;
    throw err;
  }
}

function requireInstructor(actor) {
  if (!isInstructorLike(actor)) {
    const err = new Error("Bu islem icin hoca/admin yetkisi gerekir.");
    err.status = 403;
    throw err;
  }
}

function canAccessDiary(actor, data = {}) {
  return actor.role === "admin" ||
    data.ownerId === actor.uid ||
    data.studentId === actor.uid ||
    data.creatorId === actor.uid ||
    data.createdBy === actor.uid ||
    data.instructorId === actor.uid ||
    cleanEmail(data.studentEmail) === actor.email ||
    cleanEmail(data.instructorEmail) === actor.email;
}

async function getDiaryForActor(actor, diaryId) {
  const ref = db.collection("diaries").doc(diaryId);
  const snap = await ref.get();
  if (!snap.exists) {
    const err = new Error("Gunluk bulunamadi.");
    err.status = 404;
    throw err;
  }
  const data = snap.data() || {};
  if (!canAccessDiary(actor, data)) {
    const err = new Error("Bu gunluk icin yetkiniz yok.");
    err.status = 403;
    throw err;
  }
  return { ref, snap, data };
}

function isDiaryStudent(data = {}, actor = {}) {
  return cleanEmail(data.studentEmail) === actor.email
    || data.studentId === actor.uid
    || data.ownerId === actor.uid
    || data.creatorId === actor.uid;
}

function isDiaryManager(data = {}, actor = {}) {
  return actor.role === "admin"
    || data.instructorId === actor.uid
    || cleanEmail(data.instructorEmail) === actor.email
    || data.creatorId === actor.uid;
}

function readAttendancePolicy(body = {}) {
  const weekdays = Array.isArray(body.attendanceWeekdays)
    ? body.attendanceWeekdays.map(Number).filter((d) => d >= 0 && d <= 6)
    : [1, 2, 3, 4, 5];
  const holidays = Array.isArray(body.attendanceHolidays)
    ? body.attendanceHolidays.map((d) => cleanText(d, 12)).filter(Boolean).slice(0, 80)
    : [];

  return {
    attendancePolicyEnabled: !!body.attendancePolicyEnabled,
    attendanceStartDate: cleanText(body.attendanceStartDate, 12),
    attendanceEndDate: cleanText(body.attendanceEndDate, 12),
    attendanceDaysPerWeek: Math.max(0, Math.min(7, Number(body.attendanceDaysPerWeek || 5))),
    attendanceIncludeWeekends: !!body.attendanceIncludeWeekends,
    attendanceWeekdays: weekdays.length ? weekdays : [1, 2, 3, 4, 5],
    attendanceHolidays: holidays
  };
}

async function saveOwnUserProfile(req, res, actor) {
  const fullName = cleanText(req.body?.fullName || req.body?.name, 160);
  if (!fullName) return json(res, 400, { error: "Ad soyad eksik." });

  const ref = db.collection("users").doc(actor.uid);
  const snap = await ref.get();
  const existing = snap.exists ? (snap.data() || {}) : {};
  const patch = {
    fullName,
    email: actor.email,
    updatedAt: FieldValue.serverTimestamp()
  };
  if (!snap.exists) {
    patch.role = validPublicSignupRole(req.body?.role);
    patch.createdAt = FieldValue.serverTimestamp();
  } else if (!existing.role) {
    patch.role = validPublicSignupRole(req.body?.role);
  }

  await ref.set(patch, { merge: true });
  json(res, 200, { ok: true, user: publicUser(await ref.get()) });
}

async function listUsers(req, res, actor) {
  requireAdmin(actor);
  const snap = await db.collection("users").get();
  const users = snap.docs
    .map(publicUser)
    .sort((a, b) => String(a.email || "").localeCompare(String(b.email || ""), "tr"));
  json(res, 200, { users });
}

async function updateUserRole(req, res, actor, targetUid) {
  requireAdmin(actor);
  if (!targetUid) return json(res, 400, { error: "Kullanici id eksik." });
  if (targetUid === actor.uid) return json(res, 400, { error: "Admin kendi rolunu buradan degistiremez." });

  const nextRole = normalizeRole(req.body?.role);
  if (!allowedRoles.has(nextRole)) return json(res, 400, { error: "Gecersiz rol." });

  const targetRef = db.collection("users").doc(targetUid);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) return json(res, 404, { error: "Kullanici bulunamadi." });

  await targetRef.set({
    role: nextRole,
    roleUpdatedAt: FieldValue.serverTimestamp(),
    roleUpdatedBy: actor.uid,
    roleUpdatedByEmail: actor.email
  }, { merge: true });

  json(res, 200, { ok: true, user: publicUser(await targetRef.get()) });
}

async function createPersonalDiary(req, res, actor) {
  const title = cleanText(req.body?.title, 120);
  if (!title) return json(res, 400, { error: "Baslik eksik." });

  const ref = await db.collection("diaries").add({
    className: "Kisisel",
    title,
    studentEmail: actor.email,
    instructorEmail: "",
    creatorId: actor.uid,
    createdBy: actor.uid,
    ownerId: actor.uid,
    status: "active",
    isLocked: false,
    isDeleted: false,
    createdAt: FieldValue.serverTimestamp()
  });
  json(res, 201, { ok: true, id: ref.id });
}

async function createAssignedDiary(req, res, actor) {
  requireInstructor(actor);
  const className = cleanText(req.body?.className, 120) || "Bagimsiz Ogrenciler";
  const title = cleanText(req.body?.title, 160);
  const studentEmail = cleanEmail(req.body?.studentEmail);
  if (!title || !studentEmail) return json(res, 400, { error: "Ogrenci e-posta ve baslik gerekli." });

  const payload = {
    className,
    title,
    studentEmail,
    instructorEmail: actor.email,
    instructorId: actor.uid,
    creatorId: actor.uid,
    createdBy: actor.uid,
    status: "active",
    isDeleted: false,
    isLocked: !!req.body?.isLocked,
    lockDays: Math.max(0, Number(req.body?.lockDays || 0)),
    requireShiftProof: !!req.body?.requireShiftProof,
    ...readAttendancePolicy(req.body || {}),
    createdAt: FieldValue.serverTimestamp()
  };

  const ref = await db.collection("diaries").add(payload);
  json(res, 201, { ok: true, id: ref.id });
}

async function bulkCreateDiaries(req, res, actor) {
  requireInstructor(actor);
  const className = cleanText(req.body?.className, 120);
  const students = Array.isArray(req.body?.students) ? req.body.students.slice(0, 500) : [];
  if (!className || !students.length) return json(res, 400, { error: "Sinif adi veya ogrenci listesi eksik." });

  const base = {
    className,
    instructorEmail: actor.email,
    instructorId: actor.uid,
    creatorId: actor.uid,
    createdBy: actor.uid,
    status: "active",
    isDeleted: false,
    isLocked: Number(req.body?.lockDays || 0) > 0,
    lockDays: Math.max(0, Number(req.body?.lockDays || 0)),
    requireShiftProof: !!req.body?.requireShiftProof,
    ...readAttendancePolicy(req.body || {})
  };

  let count = 0;
  let batch = db.batch();
  let batchOps = 0;
  const commitBatch = async () => {
    if (!batchOps) return;
    await batch.commit();
    batch = db.batch();
    batchOps = 0;
  };

  for (const row of students) {
    const studentEmail = cleanEmail(row.email || row["e-posta"]);
    if (!studentEmail) continue;
    const title = cleanText(row.title || `${row.no || ""}_${row.ad || ""}_${row.soyad || row.soyisim || ""}`.replace(/\s+/g, "_"), 160) || studentEmail;
    const ref = db.collection("diaries").doc();
    batch.set(ref, {
      ...base,
      title,
      studentEmail,
      createdAt: FieldValue.serverTimestamp()
    });
    count++;
    batchOps++;
    if (batchOps >= 450) await commitBatch();
  }
  await commitBatch();

  json(res, 201, { ok: true, count });
}

async function deletePersonalDiary(req, res, actor, diaryId) {
  const { ref, data } = await getDiaryForActor(actor, diaryId);
  const isPersonal = cleanEmail(data.instructorEmail) === "" || String(data.className || "").toLowerCase().includes("kisisel");
  if (!isPersonal && actor.role !== "admin") return json(res, 403, { error: "Bu islem sadece kisisel gunluk icin yapilabilir." });
  await ref.delete();
  json(res, 200, { ok: true });
}

async function softDeleteAssignedDiary(req, res, actor, diaryId) {
  requireInstructor(actor);
  const { ref, data } = await getDiaryForActor(actor, diaryId);
  const originalClassName = cleanText(req.body?.originalClassName || data.originalClassName || data.className || "Bagimsiz Ogrenciler", 120);
  await ref.set({
    isDeleted: true,
    originalClassName,
    className: deletedClassLabel,
    deletedAt: FieldValue.serverTimestamp(),
    deletedByUid: actor.uid,
    deletedByEmail: actor.email
  }, { merge: true });
  json(res, 200, { ok: true });
}

async function restoreAssignedDiary(req, res, actor, diaryId) {
  requireInstructor(actor);
  const { ref, data } = await getDiaryForActor(actor, diaryId);
  const restoredClass = cleanText(data.originalClassName || req.body?.className || "Bagimsiz Ogrenciler", 120);
  await ref.set({
    isDeleted: false,
    className: restoredClass,
    deletedAt: "",
    deletedByUid: "",
    deletedByEmail: ""
  }, { merge: true });
  json(res, 200, { ok: true });
}

async function hardDeleteClass(req, res, actor) {
  requireInstructor(actor);
  const ids = Array.isArray(req.body?.diaryIds) ? req.body.diaryIds.filter(Boolean).slice(0, 500) : [];
  if (!ids.length) return json(res, 400, { error: "Silinecek gunluk bulunamadi." });

  let batch = db.batch();
  let batchOps = 0;
  let count = 0;
  const commitBatch = async () => {
    if (!batchOps) return;
    await batch.commit();
    batch = db.batch();
    batchOps = 0;
  };

  for (const id of ids) {
    const { ref } = await getDiaryForActor(actor, id);
    batch.delete(ref);
    count++;
    batchOps++;
    if (batchOps >= 450) await commitBatch();
  }
  await commitBatch();

  json(res, 200, { ok: true, count });
}



function normalizeLogForRevision(log) {
  if (!log) return null;
  return {
    content: cleanText(log.content, 10000),
    imageUrl: cleanText(log.imageUrl, 1200),
    imageUrls: Array.isArray(log.imageUrls) ? log.imageUrls.map((x) => cleanText(x, 1200)).filter(Boolean).slice(0, 3) : [],
    attendance: log.attendance || null
  };
}

function revisionChangedFields(before, after) {
  if (!before) return ["content", "imageUrls", "attendance"].filter((k) => after?.[k] != null);
  const fields = [];
  for (const key of ["content", "imageUrl", "imageUrls", "attendance"]) {
    if (JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null)) fields.push(key);
  }
  return fields;
}

function hasTempUnlock(data, dateId) {
  const until = data?.tempUnlockUntil;
  if (!until || new Date(until) <= new Date()) return false;
  const type = data.tempUnlockType;
  const value = data.tempUnlockValue;
  if (type === "all") return true;
  if (type === "date") return String(value || "") === String(dateId || "");
  if (type === "shift-today") return String(value || "") === String(dateId || "");
  if (type === "range") {
    const selected = new Date(`${dateId}T00:00:00`);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffDays = Math.floor((today.getTime() - selected.getTime()) / 86400000);
    return diffDays <= Number(value || 0);
  }
  return false;
}

function isDateLockedByPolicy(data, dateId) {
  const lockDays = Number(data?.lockDays || 0);
  if (data?.isLocked !== true || lockDays <= 0) return false;
  const selected = new Date(`${dateId}T00:00:00`);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((today.getTime() - selected.getTime()) / 86400000);
  return diffDays >= lockDays;
}

async function saveDiaryLog(req, res, actor, diaryId, dateId) {
  const { ref, data } = await getDiaryForActor(actor, diaryId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateId)) return json(res, 400, { error: "Gecersiz tarih." });
  const bypass = hasTempUnlock(data, dateId);
  if (data.status && data.status !== "active" && !bypass) return json(res, 400, { error: "Bu gunluk duzenlemeye kapali." });
  if (!bypass && isDateLockedByPolicy(data, dateId)) return json(res, 400, { error: "Bu tarih duzenlemeye kapatilmistir." });
  const isStudent = cleanEmail(data.studentEmail) === actor.email || data.studentId === actor.uid || data.ownerId === actor.uid || data.creatorId === actor.uid;
  if (!isStudent && actor.role !== "admin") return json(res, 403, { error: "Gunluk notunu sadece ilgili ogrenci kaydedebilir." });

  const body = req.body || {};
  const imageUrls = Array.isArray(body.imageUrls) ? body.imageUrls.map((x) => cleanText(x, 1200)).filter(Boolean).slice(0, 3) : [];
  const nextLog = {
    content: cleanText(body.content, 10000),
    imageUrl: cleanText(body.imageUrl || imageUrls[0] || "", 1200),
    imageUrls,
    updatedAt: FieldValue.serverTimestamp()
  };
  if (body.attendance && typeof body.attendance === "object") nextLog.attendance = body.attendance;

  const logRef = ref.collection("logs").doc(dateId);
  const prevSnap = await logRef.get();
  const prevLog = prevSnap.exists ? (prevSnap.data() || null) : null;
  await logRef.set(nextLog, { merge: !!body.merge });

  const prevNorm = normalizeLogForRevision(prevLog);
  const afterForRevision = { ...nextLog, updatedAt: new Date().toISOString() };
  const nextNorm = normalizeLogForRevision(afterForRevision);
  const changedFields = revisionChangedFields(prevNorm, nextNorm);
  if (changedFields.length) {
    await logRef.collection("revisions").add({
      action: prevNorm ? "update" : "create",
      changedFields,
      actorEmail: actor.email,
      actorUid: actor.uid,
      createdAt: FieldValue.serverTimestamp(),
      before: prevNorm,
      after: nextNorm
    });
  }

  const removedPhotos = Array.isArray(body.removedPhotos) ? body.removedPhotos.slice(0, 20) : [];
  const archiveRows = removedPhotos
    .map((x) => typeof x === "string" ? { url: x } : x)
    .map((x) => ({
      imageUrl: cleanText(x?.url || x?.imageUrl, 1200),
      logDate: dateId,
      source: "log-note",
      diaryId,
      deletedAt: new Date().toISOString(),
      deletedByEmail: actor.email,
      deletedByUid: actor.uid
    }))
    .filter((x) => x.imageUrl);
  if (archiveRows.length) {
    await ref.set({ deletedPhotosArchive: FieldValue.arrayUnion(...archiveRows) }, { merge: true });
  }

  await ref.set({ studentUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
  json(res, 200, { ok: true });
}

function sanitizeWeeklyLogPayload(body) {
  const imageUrls = Array.isArray(body?.imageUrls)
    ? body.imageUrls.map((x) => cleanText(x, 1200)).filter(Boolean).slice(0, 5)
    : [];
  return {
    content: cleanText(body?.content, 15000),
    imageUrls,
    selectedPdfImageUrls: Array.isArray(body?.selectedPdfImageUrls)
      ? body.selectedPdfImageUrls.map((x) => cleanText(x, 1200)).filter(Boolean).slice(0, 3)
      : imageUrls.slice(0, 3),
    weekStart: cleanText(body?.weekStart, 20),
    weekEnd: cleanText(body?.weekEnd, 20),
    updatedAt: FieldValue.serverTimestamp()
  };
}

async function saveWeeklyLog(req, res, actor, diaryId, weekStartId) {
  const { ref, data } = await readDiaryForActor(diaryId, actor);
  if (data.isPersonal) return json(res, 400, { error: "Kisisel gunlukte haftalik staj kaydi kullanilmaz." });
  if (actor.uid !== data.ownerId && actor.email !== data.studentEmail) return json(res, 403, { error: "Haftalik kaydi sadece ogrenci yazabilir." });
  const payload = sanitizeWeeklyLogPayload(req.body || {});
  if (!payload.content && !payload.imageUrls.length) return json(res, 400, { error: "Haftalik not veya fotograf gerekli." });
  await ref.collection("weeklyLogs").doc(weekStartId).set({ ...payload, weekStart: weekStartId }, { merge: true });
  await ref.set({ studentUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
  json(res, 200, { ok: true });
}

async function submitDiaryForApproval(req, res, actor, diaryId) {
  const { ref, data } = await getDiaryForActor(actor, diaryId);
  const isStudent = cleanEmail(data.studentEmail) === actor.email || data.studentId === actor.uid || data.ownerId === actor.uid || data.creatorId === actor.uid;
  if (!isStudent && actor.role !== "admin") return json(res, 403, { error: "Bu gunlugu onaya sadece ogrenci gonderebilir." });
  if (data.status && data.status !== "active") return json(res, 400, { error: "Gunluk aktif durumda degil." });
  await ref.set({
    status: "pending",
    submittedAt: FieldValue.serverTimestamp(),
    submittedBy: actor.uid,
    submittedByEmail: actor.email
  }, { merge: true });
  json(res, 200, { ok: true });
}

async function approveDiary(req, res, actor, diaryId) {
  requireInstructor(actor);
  const { ref } = await getDiaryForActor(actor, diaryId);
  await ref.set({
    status: "approved",
    approvedAt: FieldValue.serverTimestamp(),
    approvedBy: actor.uid,
    approvedByEmail: actor.email
  }, { merge: true });
  await ref.collection("notifications").add({
    title: "Gunluk onaylandi",
    message: "Gunlugunuz hoca tarafindan onaylandi.",
    type: "diary_approved",
    createdAt: FieldValue.serverTimestamp(),
    isRead: false,
    senderEmail: actor.email
  });
  json(res, 200, { ok: true });
}

async function rejectDiary(req, res, actor, diaryId) {
  requireInstructor(actor);
  const reason = cleanText(req.body?.reason, 600);
  if (!reason) return json(res, 400, { error: "Ret sebebi gerekli." });
  const { ref } = await getDiaryForActor(actor, diaryId);
  await ref.set({
    status: "active",
    rejectedAt: FieldValue.serverTimestamp(),
    rejectedBy: actor.uid,
    rejectedByEmail: actor.email,
    rejectionReason: reason
  }, { merge: true });
  await ref.collection("notifications").add({
    title: "Gunluk reddedildi",
    message: `Gunlugunuz reddedildi: ${reason}`,
    type: "diary_rejected",
    createdAt: FieldValue.serverTimestamp(),
    isRead: false,
    senderEmail: actor.email
  });
  json(res, 200, { ok: true });
}

async function saveMonthlyEvaluation(req, res, actor, diaryId, evalId) {
  requireInstructor(actor);
  const content = cleanText(req.body?.content, 5000);
  if (!evalId) return json(res, 400, { error: "Degerlendirme donemi eksik." });
  const { ref } = await getDiaryForActor(actor, diaryId);
  await ref.collection("monthlyEvaluations").doc(evalId).set({
    content,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: actor.uid,
    updatedByEmail: actor.email
  }, { merge: true });
  await ref.set({ instructorUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
  json(res, 200, { ok: true });
}

async function updateDiarySettings(req, res, actor, diaryId) {
  const { ref, data } = await getDiaryForActor(actor, diaryId);
  if (!isDiaryManager(data, actor)) return json(res, 403, { error: "Ayar degistirme yetkiniz yok." });
  const patch = {
    isLocked: !!req.body?.isLocked,
    lockDays: Math.max(0, Number(req.body?.lockDays || 0)),
    requireShiftProof: !!req.body?.requireShiftProof
  };
  await ref.set(patch, { merge: true });
  json(res, 200, { ok: true, patch });
}

async function saveTempUnlock(req, res, actor, diaryId) {
  const { ref, data } = await getDiaryForActor(actor, diaryId);
  if (!isDiaryManager(data, actor)) return json(res, 403, { error: "Gecici izin yetkiniz yok." });
  const type = ["all", "range", "date", "shift-today"].includes(String(req.body?.type || "")) ? String(req.body.type) : "all";
  const minutes = Math.max(1, Math.min(1440, Number(req.body?.minutes || 5)));
  const today = new Date().toISOString().slice(0, 10);
  const value = type === "range"
    ? String(Math.max(0, Number(req.body?.value || 0)))
    : (type === "shift-today" ? today : cleanText(req.body?.value || "", 20));
  const patch = {
    tempUnlockUntil: new Date(Date.now() + minutes * 60000).toISOString(),
    tempUnlockType: type,
    tempUnlockValue: value
  };
  await ref.set(patch, { merge: true });
  json(res, 200, { ok: true, patch });
}

async function saveWorkLocation(req, res, actor, diaryId) {
  const { ref, data } = await getDiaryForActor(actor, diaryId);
  if (!isDiaryStudent(data, actor)) return json(res, 403, { error: "Is yeri konumunu sadece ogrenci kaydedebilir." });
  const loc = req.body?.workLocation || {};
  const lat = Number(loc.lat);
  const lng = Number(loc.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json(res, 400, { error: "Gecersiz konum." });
  const patch = {
    workLocation: {
      lat,
      lng,
      accuracy: Math.max(0, Number(loc.accuracy || 0)),
      savedAt: new Date().toISOString(),
      savedBy: actor.email
    },
    workRadiusMeters: Math.max(30, Math.min(2000, Number(req.body?.workRadiusMeters || 150)))
  };
  await ref.set(patch, { merge: true });
  json(res, 200, { ok: true, patch });
}

async function saveReminders(req, res, actor, diaryId) {
  const { ref, data } = await getDiaryForActor(actor, diaryId);
  if (!isDiaryStudent(data, actor) && actor.role !== "admin") return json(res, 403, { error: "Hatirlaticilari sadece ilgili ogrenci yonetebilir." });
  const today = new Date().toISOString().slice(0, 10);
  const reminders = Array.isArray(req.body?.reminders) ? req.body.reminders : [];
  const clean = reminders.map((r) => ({
    id: cleanText(r?.id, 80),
    date: cleanText(r?.date, 12),
    text: cleanText(r?.text, 300),
    dailyAlert: !!r?.dailyAlert,
    createdAt: cleanText(r?.createdAt || new Date().toISOString(), 40),
    createdBy: cleanEmail(r?.createdBy || actor.email)
  })).filter((r) => r.id && r.date >= today && r.text).slice(0, 80);
  await ref.set({ reminders: clean }, { merge: true });
  json(res, 200, { ok: true, reminders: clean });
}

async function addOfficialDocRecord(req, res, actor, diaryId) {
  const { ref, data } = await getDiaryForActor(actor, diaryId);
  if (!isDiaryStudent(data, actor) && actor.role !== "admin") return json(res, 403, { error: "Evrak ekleme yetkiniz yok." });
  if (data.status === "approved") return json(res, 400, { error: "Onayli gunlukte evrak eklenemez." });
  const payload = {
    type: cleanText(req.body?.type || "Diger", 80),
    fileName: cleanText(req.body?.fileName || "Dosya", 180),
    fileType: cleanText(req.body?.fileType || "", 120),
    url: cleanText(req.body?.url || "", 1600),
    storagePath: cleanText(req.body?.storagePath || "", 900),
    uploadedAt: new Date().toISOString(),
    uploadedBy: actor.email
  };
  if (!payload.url || !payload.storagePath) return json(res, 400, { error: "Evrak dosya bilgisi eksik." });
  const docRef = await ref.collection("officialDocs").add(payload);
  json(res, 201, { ok: true, id: docRef.id });
}

function cleanFolder(value) {
  const folder = cleanText(value, 60);
  const allowed = new Set(["officialDocs", "weeklyLogs", "notePhotos", "shiftProof"]);
  return allowed.has(folder) ? folder : "";
}

function cleanPathPart(value, fallback = "file") {
  return cleanText(value, 160)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/, "") || fallback;
}

async function uploadDiaryFile(req, res, actor, diaryId) {
  const { ref, data } = await getDiaryForActor(actor, diaryId);
  const folder = cleanFolder(req.body?.folder);
  if (!folder) return json(res, 400, { error: "Gecersiz dosya klasoru." });

  if (folder === "officialDocs" && data.status === "approved") {
    return json(res, 403, { error: "Onaylanmis gunlukte evrak yuklenemez." });
  }
  if ((folder === "weeklyLogs" || folder === "notePhotos" || folder === "shiftProof") && isInstructorLike(actor) && actor.role !== "admin") {
    return json(res, 403, { error: "Bu dosyayi sadece ogrenci yukleyebilir." });
  }

  const rawBase64 = String(req.body?.dataBase64 || "");
  if (!rawBase64) return json(res, 400, { error: "Dosya verisi eksik." });
  const buffer = Buffer.from(rawBase64, "base64");
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) {
    return json(res, 400, { error: "Dosya boyutu gecersiz veya cok buyuk." });
  }

  const contentType = cleanText(req.body?.contentType || "application/octet-stream", 120) || "application/octet-stream";
  const fileName = cleanPathPart(req.body?.fileName || `${Date.now()}_file`, "file");
  const subdir = cleanPathPart(req.body?.subdir || "", "");
  const parts = ["diaries", diaryId, folder];
  if (subdir) parts.push(subdir);
  parts.push(`${Date.now()}_${fileName}`);
  const storagePath = parts.join("/");

  const token = randomUUID();
  const bucket = adminStorage.bucket();
  await bucket.file(storagePath).save(buffer, {
    resumable: false,
    metadata: {
      contentType,
      metadata: { firebaseStorageDownloadTokens: token }
    }
  });

  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
  await ref.set({ lastFileUploadAt: FieldValue.serverTimestamp(), lastFileUploadBy: actor.uid }, { merge: true });
  return json(res, 200, { ok: true, url, storagePath, contentType, size: buffer.length });
}
async function deleteOfficialDocRecord(req, res, actor, diaryId, docId) {
  const { ref, data } = await getDiaryForActor(actor, diaryId);
  if (!isDiaryStudent(data, actor) && actor.role !== "admin") return json(res, 403, { error: "Evrak silme yetkiniz yok." });
  if (data.status === "approved") return json(res, 400, { error: "Onayli gunlukte evrak silinemez." });
  const docRef = ref.collection("officialDocs").doc(docId);
  const snap = await docRef.get();
  const storagePath = cleanText(snap.exists ? snap.data()?.storagePath : "", 900);
  if (storagePath && storagePath.startsWith(`diaries/${diaryId}/`)) {
    try {
      await adminStorage.bucket().file(storagePath).delete({ ignoreNotFound: true });
    } catch (err) {
      console.warn("Official doc storage delete failed", { diaryId, docId, storagePath, message: err?.message });
    }
  }
  await docRef.delete();
  json(res, 200, { ok: true });
}

async function markDiaryNotificationsRead(req, res, actor, diaryId) {
  const { ref } = await getDiaryForActor(actor, diaryId);
  const ids = Array.from(new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map((id) => cleanText(id, 120)).filter(Boolean))).slice(0, 100);
  const readAt = new Date().toISOString();
  const batch = db.batch();
  ids.forEach((id) => batch.set(ref.collection("notifications").doc(id), { isRead: true, readAt }, { merge: true }));
  if (ids.length) await batch.commit();
  json(res, 200, { ok: true, count: ids.length });
}

async function updateDiaryTitle(req, res, actor, diaryId) {
  const { ref, data } = await getDiaryForActor(actor, diaryId);
  if (!isDiaryManager(data, actor) && !isDiaryStudent(data, actor)) return json(res, 403, { error: "Baslik degistirme yetkiniz yok." });
  const title = cleanText(req.body?.title, 160);
  if (!title) return json(res, 400, { error: "Baslik bos olamaz." });
  await ref.set({ title, titleUpdatedAt: FieldValue.serverTimestamp(), titleUpdatedBy: actor.uid }, { merge: true });
  json(res, 200, { ok: true, title });
}

async function updateClassSettings(req, res, actor) {
  requireInstructor(actor);
  const ids = Array.from(new Set((Array.isArray(req.body?.diaryIds) ? req.body.diaryIds : []).map((id) => cleanText(id, 120)).filter(Boolean))).slice(0, 500);
  if (!ids.length) return json(res, 400, { error: "Guncellenecek gunluk yok." });
  const patch = {
    isLocked: !!req.body?.isLocked,
    lockDays: Math.max(0, Number(req.body?.lockDays || 0)),
    requireShiftProof: !!req.body?.requireShiftProof,
    ...readAttendancePolicy(req.body || {})
  };

  let count = 0;
  let batch = db.batch();
  let ops = 0;
  const commitBatch = async () => {
    if (!ops) return;
    await batch.commit();
    batch = db.batch();
    ops = 0;
  };

  for (const id of ids) {
    const { ref, data } = await getDiaryForActor(actor, id);
    if (!isDiaryManager(data, actor)) continue;
    batch.set(ref, { ...patch, settingsUpdatedAt: FieldValue.serverTimestamp(), settingsUpdatedBy: actor.uid }, { merge: true });
    count++;
    ops++;
    if (ops >= 450) await commitBatch();
  }
  await commitBatch();
  json(res, 200, { ok: true, count, patch });
}

async function savePresence(req, res, actor) {
  const isOnline = !!req.body?.isOnline;
  const ref = db.collection("presence").doc(presenceDocId(actor.email));
  await ref.set({
    email: actor.email,
    uid: actor.uid,
    role: actor.role,
    isOnline,
    lastSeenMs: Date.now(),
    updatedAt: new Date().toISOString(),
    updatedAtServer: FieldValue.serverTimestamp()
  }, { merge: true });
  json(res, 200, { ok: true });
}

async function sendChatMessage(req, res, actor, diaryId) {
  const { ref, data } = await getDiaryForActor(actor, diaryId);
  const text = cleanText(req.body?.text, 2000);
  if (!text) return json(res, 400, { error: "Mesaj bos olamaz." });
  const isStudent = isDiaryStudent(data, actor);
  const isManager = isDiaryManager(data, actor);
  if (!isStudent && !isManager) return json(res, 403, { error: "Mesaj gonderme yetkiniz yok." });
  const senderRole = isManager ? "instructor" : "student";
  const messageRef = await ref.collection("chatMessages").add({
    text,
    senderEmail: actor.email,
    senderUid: actor.uid,
    senderRole,
    createdAt: new Date().toISOString(),
    createdAtServer: FieldValue.serverTimestamp(),
    createdAtMs: Date.now(),
    readByInstructor: senderRole === "instructor",
    readByStudent: senderRole === "student"
  });
  json(res, 201, { ok: true, id: messageRef.id });
}

function publicChatMessage(id, data = {}) {
  return {
    id,
    text: String(data.text || ""),
    senderEmail: cleanEmail(data.senderEmail),
    senderUid: String(data.senderUid || ""),
    senderRole: String(data.senderRole || ""),
    createdAt: data.createdAt || "",
    createdAtMs: Number(data.createdAtMs || 0),
    readByInstructor: !!data.readByInstructor,
    readByStudent: !!data.readByStudent
  };
}

async function listChatMessages(req, res, actor, diaryId) {
  const { ref, data } = await getDiaryForActor(actor, diaryId);
  const isStudent = isDiaryStudent(data, actor);
  const isManager = isDiaryManager(data, actor);
  if (!isStudent && !isManager) return json(res, 403, { error: "Mesaj okuma yetkiniz yok." });
  const max = Math.max(1, Math.min(100, Number(req.query?.limit || 100)));
  const snap = await ref.collection("chatMessages").orderBy("createdAtMs", "desc").limit(max).get();
  const rows = [];
  snap.forEach((doc) => rows.push(publicChatMessage(doc.id, doc.data() || {})));
  return json(res, 200, { rows });
}
async function markChatMessagesRead(req, res, actor, diaryId) {
  const { ref, data } = await getDiaryForActor(actor, diaryId);
  const isStudent = isDiaryStudent(data, actor);
  const isManager = isDiaryManager(data, actor);
  if (!isStudent && !isManager) return json(res, 403, { error: "Mesaj okuma yetkiniz yok." });
  const who = req.body?.who === "instructor" || (!isStudent && isManager) ? "instructor" : "student";
  const snap = await ref.collection("chatMessages").orderBy("createdAtMs", "desc").limit(100).get();
  const batch = db.batch();
  let count = 0;
  snap.forEach((docSnap) => {
    const m = docSnap.data() || {};
    if (who === "student" && m.senderRole === "instructor" && !m.readByStudent) {
      batch.set(docSnap.ref, { readByStudent: true, readAtStudent: new Date().toISOString() }, { merge: true });
      count++;
    }
    if (who === "instructor" && m.senderRole === "student" && !m.readByInstructor) {
      batch.set(docSnap.ref, { readByInstructor: true, readAtInstructor: new Date().toISOString() }, { merge: true });
      count++;
    }
  });
  if (count) await batch.commit();
  json(res, 200, { ok: true, count });
}

function publicDiaryData(id, data = {}) {
  return {
    id,
    title: String(data.title || ""),
    className: String(data.className || ""),
    studentEmail: cleanEmail(data.studentEmail),
    instructorEmail: cleanEmail(data.instructorEmail),
    ownerId: String(data.ownerId || ""),
    studentId: String(data.studentId || ""),
    creatorId: String(data.creatorId || ""),
    createdBy: String(data.createdBy || ""),
    instructorId: String(data.instructorId || ""),
    status: String(data.status || "active"),
    isLocked: !!data.isLocked,
    lockDays: Number(data.lockDays || 0),
    requireShiftProof: !!data.requireShiftProof,
    isDeleted: !!data.isDeleted,
    deletedByUid: String(data.deletedByUid || ""),
    settings: data.settings || {},
    reminders: Array.isArray(data.reminders) ? data.reminders : [],
    tempUnlock: data.tempUnlock || null,
    workLocation: data.workLocation || null,
    attendancePolicyEnabled: !!data.attendancePolicyEnabled,
    attendanceStartDate: String(data.attendanceStartDate || ""),
    attendanceEndDate: String(data.attendanceEndDate || ""),
    attendanceDaysPerWeek: Number(data.attendanceDaysPerWeek || 0),
    attendanceIncludeWeekends: !!data.attendanceIncludeWeekends,
    attendanceWeekdays: Array.isArray(data.attendanceWeekdays) ? data.attendanceWeekdays : [],
    attendanceHolidays: Array.isArray(data.attendanceHolidays) ? data.attendanceHolidays : [],
    createdAt: data.createdAt || "",
    updatedAt: data.updatedAt || ""
  };
}

function publicOfficialDoc(id, data = {}) {
  return {
    id,
    type: String(data.type || ""),
    fileName: String(data.fileName || ""),
    fileType: String(data.fileType || ""),
    url: String(data.url || ""),
    storagePath: String(data.storagePath || ""),
    uploadedAt: data.uploadedAt || "",
    uploadedBy: String(data.uploadedBy || "")
  };
}

function publicNotification(id, data = {}) {
  return {
    id,
    title: String(data.title || ""),
    message: String(data.message || ""),
    type: String(data.type || ""),
    createdAt: data.createdAt || "",
    isRead: !!data.isRead,
    senderEmail: cleanEmail(data.senderEmail)
  };
}

function publicRevision(id, data = {}) {
  return {
    id,
    before: data.before || null,
    after: data.after || null,
    createdAt: data.createdAt || "",
    actorEmail: cleanEmail(data.actorEmail),
    actorUid: String(data.actorUid || "")
  };
}

async function listLogRevisions(req, res, actor, diaryId, dateId) {
  const { ref, data } = await getDiaryForActor(actor, diaryId);
  if (!isDiaryManager(data, actor) && !isDiaryStudent(data, actor)) return json(res, 403, { error: "Revizyon gecmisi icin yetkiniz yok." });
  const snap = await ref.collection("logs").doc(dateId).collection("revisions").get();
  const rows = [];
  snap.forEach((doc) => rows.push(publicRevision(doc.id, doc.data() || {})));
  rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return json(res, 200, { rows });
}

async function listDeletedPhotos(req, res, actor, diaryId) {
  const { ref, data } = await getDiaryForActor(actor, diaryId);
  if (!isDiaryManager(data, actor)) return json(res, 403, { error: "Silinen fotograflar icin hoca/admin yetkisi gerekir." });
  const rows = [];
  const archive = Array.isArray(data.deletedPhotosArchive) ? data.deletedPhotosArchive : [];
  rows.push(...archive);

  const legacySnap = await ref.collection("deletedPhotos").orderBy("deletedAt", "desc").limit(200).get().catch(() => null);
  legacySnap?.forEach((doc) => rows.push({ id: doc.id, ...(doc.data() || {}) }));

  const logsSnap = await ref.collection("logs").get();
  const dateIds = logsSnap.docs.map((doc) => doc.id);
  await Promise.all(dateIds.map(async (dateId) => {
    const revSnap = await ref.collection("logs").doc(dateId).collection("revisions").get().catch(() => null);
    revSnap?.forEach((doc) => {
      const item = doc.data() || {};
      const beforeArr = Array.isArray(item.before?.imageUrls) ? item.before.imageUrls.filter(Boolean) : [];
      const afterArr = Array.isArray(item.after?.imageUrls) ? item.after.imageUrls.filter(Boolean) : [];
      beforeArr.filter((url) => !afterArr.includes(url)).forEach((url) => rows.push({
        id: `rev_${doc.id}_${String(url).slice(-16)}`,
        imageUrl: String(url),
        logDate: dateId,
        source: "revision_fallback",
        deletedAt: item.createdAt || "",
        deletedByEmail: cleanEmail(item.actorEmail),
        deletedByUid: String(item.actorUid || "")
      }));
    });
  }));

  const merged = [];
  const seen = new Set();
  for (const row of rows) {
    const imageUrl = String(row?.imageUrl || "");
    const key = `${imageUrl}|${row?.logDate || ""}|${row?.deletedAt || ""}`;
    if (!imageUrl || seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  merged.sort((a, b) => new Date(b.deletedAt || 0) - new Date(a.deletedAt || 0));
  return json(res, 200, { rows: merged });
}
async function listPanelData(req, res, actor) {
  const myEmail = actor.email;
  const myUid = actor.uid;
  const collect = async (queryRef, map) => {
    const snap = await queryRef.get();
    snap.forEach((doc) => map.set(doc.id, publicDiaryData(doc.id, doc.data() || {})));
  };

  const studentMap = new Map();
  await Promise.all([
    collect(db.collection("diaries").where("studentEmail", "==", myEmail), studentMap),
    collect(db.collection("diaries").where("studentId", "==", myUid), studentMap),
    collect(db.collection("diaries").where("ownerId", "==", myUid), studentMap)
  ]);

  const teacherMap = new Map();
  if (isInstructorLike(actor)) {
    await Promise.all([
      collect(db.collection("diaries").where("creatorId", "==", myUid), teacherMap),
      collect(db.collection("diaries").where("createdBy", "==", myUid), teacherMap),
      collect(db.collection("diaries").where("instructorEmail", "==", myEmail), teacherMap),
      collect(db.collection("diaries").where("instructorId", "==", myUid), teacherMap)
    ]);
  }

  const sortRows = (rows) => rows.sort((a, b) => String(a.title || a.studentEmail || "").localeCompare(String(b.title || b.studentEmail || ""), "tr"));
  return json(res, 200, {
    user: { uid: actor.uid, email: actor.email, role: actor.role, fullName: actor.fullName || "" },
    studentDiaries: sortRows([...studentMap.values()]),
    teacherDiaries: sortRows([...teacherMap.values()])
  });
}
async function getDiaryData(req, res, actor, diaryId) {
  const { data } = await getDiaryForActor(actor, diaryId);
  return json(res, 200, { diary: publicDiaryData(diaryId, data) });
}

async function listDiaryLogs(req, res, actor, diaryId) {
  const { ref } = await getDiaryForActor(actor, diaryId);
  const first = cleanText(req.query?.first || "", 12);
  const last = cleanText(req.query?.last || "", 12);
  let snap;
  if (first && last) {
    snap = await ref.collection("logs").where(FieldPath.documentId(), ">=", first).where(FieldPath.documentId(), "<=", last).get();
  } else {
    snap = await ref.collection("logs").get();
  }
  const rows = [];
  snap.forEach((doc) => rows.push({ id: doc.id, ...publicPdfLog(doc.data() || {}) }));
  rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return json(res, 200, { rows });
}

async function readDiaryWeeklyLog(req, res, actor, diaryId, weekId) {
  const { ref } = await getDiaryForActor(actor, diaryId);
  const snap = await ref.collection("weeklyLogs").doc(weekId).get();
  return json(res, 200, { row: snap.exists ? publicWeeklyLog(snap.id, snap.data() || {}) : null });
}

async function listDiaryWeeklyLogs(req, res, actor, diaryId) {
  const { ref } = await getDiaryForActor(actor, diaryId);
  const snap = await ref.collection("weeklyLogs").get();
  const rows = [];
  snap.forEach((doc) => rows.push(publicWeeklyLog(doc.id, doc.data() || {})));
  rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return json(res, 200, { rows });
}

async function listDiaryOfficialDocs(req, res, actor, diaryId) {
  const { ref } = await getDiaryForActor(actor, diaryId);
  const snap = await ref.collection("officialDocs").get();
  const rows = [];
  snap.forEach((doc) => rows.push(publicOfficialDoc(doc.id, doc.data() || {})));
  rows.sort((a, b) => String(b.uploadedAt || "").localeCompare(String(a.uploadedAt || "")));
  return json(res, 200, { rows });
}

async function readDiaryMonthlyEvaluation(req, res, actor, diaryId, monthId) {
  const { ref } = await getDiaryForActor(actor, diaryId);
  const snap = await ref.collection("monthlyEvaluations").doc(monthId).get();
  return json(res, 200, { row: snap.exists ? { id: snap.id, content: String(snap.data()?.content || "") } : null });
}


function dateKeyFromStartsAt(value) {
  const raw = cleanText(value, 40);
  if (!raw) return "";
  const direct = raw.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return direct;
  return d.toISOString().slice(0, 10);
}

function publicMeeting(id, data = {}) {
  return {
    id,
    title: String(data.title || ""),
    description: String(data.description || ""),
    meetingUrl: String(data.meetingUrl || ""),
    startsAt: String(data.startsAt || ""),
    dateKey: String(data.dateKey || ""),
    className: String(data.className || ""),
    status: String(data.status || "active"),
    createdAt: data.createdAt || "",
    instructorEmail: cleanEmail(data.instructorEmail)
  };
}

async function ensureDueMeetingNotificationsForDiary(ref, diaryId) {
  const today = new Date().toISOString().slice(0, 10);
  const snap = await db.collection("meetings").where("diaryIds", "array-contains", diaryId).get();
  const batch = db.batch();
  let ops = 0;
  snap.forEach((doc) => {
    const data = doc.data() || {};
    if (String(data.status || "active") !== "active") return;
    if (String(data.dateKey || "") !== today) return;
    const nRef = ref.collection("notifications").doc(`meeting_due_${doc.id}_${today}`);
    batch.set(nRef, {
      title: "Toplanti bugun",
      message: `${String(data.title || "Toplanti")} bugun.${data.meetingUrl ? ` Link: ${String(data.meetingUrl || "")}` : " Link daha sonra eklenecek."}`,
      type: "meeting_due",
      meetingId: doc.id,
      meetingUrl: String(data.meetingUrl || ""),
      startsAt: String(data.startsAt || ""),
      createdAt: FieldValue.serverTimestamp(),
      isRead: false,
      senderEmail: cleanEmail(data.instructorEmail)
    }, { merge: true });
    ops++;
  });
  if (ops) await batch.commit();
}

async function listDiaryMeetings(req, res, actor, diaryId) {
  const { ref } = await getDiaryForActor(actor, diaryId);
  await ensureDueMeetingNotificationsForDiary(ref, diaryId);
  const snap = await db.collection("meetings").where("diaryIds", "array-contains", diaryId).get();
  const rows = [];
  snap.forEach((doc) => {
    const row = publicMeeting(doc.id, doc.data() || {});
    if (row.status === "active") rows.push(row);
  });
  rows.sort((a, b) => String(a.startsAt || "").localeCompare(String(b.startsAt || "")));
  return json(res, 200, { rows });
}

async function createClassMeeting(req, res, actor) {
  requireInstructor(actor);
  const title = cleanText(req.body?.title, 160);
  const description = cleanText(req.body?.description, 1200);
  const meetingUrl = cleanText(req.body?.meetingUrl, 600);
  const startsAt = cleanText(req.body?.startsAt, 40);
  const className = cleanText(req.body?.className, 160);
  const diaryIds = Array.from(new Set((Array.isArray(req.body?.diaryIds) ? req.body.diaryIds : []).map((id) => cleanText(id, 140)).filter(Boolean))).slice(0, 500);
  if (!title) return json(res, 400, { error: "Toplanti basligi gerekli." });
  if (meetingUrl && !/^https?:\/\//i.test(meetingUrl)) return json(res, 400, { error: "Toplanti linki bos olabilir ama doluysa http/https ile baslamali." });
  if (!startsAt) return json(res, 400, { error: "Toplanti tarihi gerekli." });
  if (!diaryIds.length) return json(res, 400, { error: "Toplanti atanacak gunluk yok." });

  const allowedIds = [];
  for (const id of diaryIds) {
    await getDiaryForActor(actor, id);
    allowedIds.push(id);
  }

  const meetingRef = db.collection("meetings").doc();
  const dateKey = dateKeyFromStartsAt(startsAt);
  await meetingRef.set({
    title,
    description,
    meetingUrl,
    startsAt,
    dateKey,
    className,
    diaryIds: allowedIds,
    instructorId: actor.uid,
    instructorEmail: actor.email,
    status: "active",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });

  let count = 0;
  let batch = db.batch();
  let ops = 0;
  const commitBatch = async () => {
    if (!ops) return;
    await batch.commit();
    batch = db.batch();
    ops = 0;
  };
  for (const id of allowedIds) {
    const ref = db.collection("diaries").doc(id);
    const nRef = ref.collection("notifications").doc();
    batch.set(nRef, {
      title: "Yeni toplanti",
      message: `${title}\nTarih: ${startsAt}\n${meetingUrl ? `Link: ${meetingUrl}` : "Link daha sonra eklenecek."}${description ? `\n${description}` : ""}`,
      type: "meeting_created",
      meetingId: meetingRef.id,
      meetingUrl,
      startsAt,
      createdAt: FieldValue.serverTimestamp(),
      isRead: false,
      senderEmail: actor.email
    });
    count++;
    ops++;
    if (ops >= 450) await commitBatch();
  }
  await commitBatch();
  return json(res, 201, { ok: true, id: meetingRef.id, count });
}
async function listDiaryNotifications(req, res, actor, diaryId) {
  const { ref } = await getDiaryForActor(actor, diaryId);
  await ensureDueMeetingNotificationsForDiary(ref, diaryId);
  const snap = await ref.collection("notifications").get();
  const rows = [];
  snap.forEach((doc) => rows.push(publicNotification(doc.id, doc.data() || {})));
  rows.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return json(res, 200, { rows });
}
function publicPdfLog(data = {}) {
  return {
    content: String(data.content || ""),
    imageUrl: String(data.imageUrl || ""),
    imageUrls: Array.isArray(data.imageUrls) ? data.imageUrls.map(String).slice(0, 5) : [],
    attendance: data.attendance || {}
  };
}

function publicWeeklyLog(id, data = {}) {
  return {
    id,
    weekStart: String(data.weekStart || id || ""),
    weekEnd: String(data.weekEnd || ""),
    content: String(data.content || ""),
    imageUrls: Array.isArray(data.imageUrls) ? data.imageUrls.map(String).slice(0, 5) : [],
    selectedPdfImageUrls: Array.isArray(data.selectedPdfImageUrls) ? data.selectedPdfImageUrls.map(String).slice(0, 3) : []
  };
}

async function getDiaryPdfData(req, res, actor, diaryId) {
  const { ref, data } = await getDiaryForActor(actor, diaryId);
  if (!isDiaryManager(data, actor) && !isDiaryStudent(data, actor)) {
    return json(res, 403, { error: "PDF verisi icin yetkiniz yok." });
  }

  const monthId = cleanText(req.query?.month || `${new Date().getFullYear()}-${new Date().getMonth() + 1}`, 16);
  const [evalSnap, logsSnap, weeklySnap] = await Promise.all([
    ref.collection("monthlyEvaluations").doc(monthId).get(),
    ref.collection("logs").get(),
    ref.collection("weeklyLogs").get()
  ]);

  const logs = {};
  logsSnap.forEach((doc) => { logs[doc.id] = publicPdfLog(doc.data() || {}); });
  const weeklyLogs = [];
  weeklySnap.forEach((doc) => weeklyLogs.push(publicWeeklyLog(doc.id, doc.data() || {})));
  weeklyLogs.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  return json(res, 200, {
    diary: {
      id: diaryId,
      title: String(data.title || ""),
      studentEmail: cleanEmail(data.studentEmail),
      instructorEmail: cleanEmail(data.instructorEmail),
      className: String(data.className || "")
    },
    monthlyEvaluation: evalSnap.exists ? String(evalSnap.data()?.content || "") : "",
    logs,
    weeklyLogs
  });
}
async function sendClassNotification(req, res, actor) {
  requireInstructor(actor);
  const title = cleanText(req.body?.title, 160);
  const message = cleanText(req.body?.message, 2000);
  const ids = Array.isArray(req.body?.diaryIds) ? req.body.diaryIds.filter(Boolean).slice(0, 500) : [];
  if (!message) return json(res, 400, { error: "Bildirim mesaji gerekli." });
  if (!ids.length) return json(res, 400, { error: "Bildirim gonderilecek gunluk yok." });

  let count = 0;
  let batch = db.batch();
  let ops = 0;
  const commitBatch = async () => {
    if (!ops) return;
    await batch.commit();
    batch = db.batch();
    ops = 0;
  };

  for (const id of ids) {
    const { ref } = await getDiaryForActor(actor, id);
    const nRef = ref.collection("notifications").doc();
    batch.set(nRef, {
      title,
      message: title ? `${title}\n${message}` : message,
      type: "class_broadcast",
      createdAt: FieldValue.serverTimestamp(),
      isRead: false,
      senderEmail: actor.email
    });
    count++;
    ops++;
    if (ops >= 450) await commitBatch();
  }
  await commitBatch();
  json(res, 200, { ok: true, count });
}
export const api = onRequest({ region: "europe-west1", cors: true }, async (req, res) => {
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});

    const actor = await requireSignedUser(req);
    const path = getPath(req);

    if (req.method === "POST" && path === "/presence") return await savePresence(req, res, actor);
    if (req.method === "POST" && path === "/users/profile") return await saveOwnUserProfile(req, res, actor);

    if (req.method === "GET" && path === "/admin/users") return await listUsers(req, res, actor);
    if (req.method === "GET" && path === "/panel-data") return await listPanelData(req, res, actor);

    const roleMatch = path.match(/^\/admin\/users\/([^/]+)\/role$/);
    if (req.method === "POST" && roleMatch) return await updateUserRole(req, res, actor, decodeURIComponent(roleMatch[1]));

    if (req.method === "POST" && path === "/diaries/personal") return await createPersonalDiary(req, res, actor);
    if (req.method === "POST" && path === "/diaries/assigned") return await createAssignedDiary(req, res, actor);
    if (req.method === "POST" && path === "/diaries/bulk") return await bulkCreateDiaries(req, res, actor);
    if (req.method === "POST" && path === "/classes/delete") return await hardDeleteClass(req, res, actor);
    if (req.method === "POST" && path === "/classes/settings") return await updateClassSettings(req, res, actor);
    if (req.method === "POST" && path === "/classes/meetings") return await createClassMeeting(req, res, actor);

    const diaryAction = path.match(/^\/diaries\/([^/]+)\/(delete-personal|delete-assigned|restore)$/);
    if (diaryAction) {
      const diaryId = decodeURIComponent(diaryAction[1]);
      const action = diaryAction[2];
      if (req.method === "DELETE" && action === "delete-personal") return await deletePersonalDiary(req, res, actor, diaryId);
      if (req.method === "POST" && action === "delete-assigned") return await softDeleteAssignedDiary(req, res, actor, diaryId);
      if (req.method === "POST" && action === "restore") return await restoreAssignedDiary(req, res, actor, diaryId);
    }

    const statusAction = path.match(/^\/diaries\/([^/]+)\/(submit|approve|reject)$/);
    if (statusAction) {
      const diaryId = decodeURIComponent(statusAction[1]);
      const action = statusAction[2];
      if (req.method === "POST" && action === "submit") return await submitDiaryForApproval(req, res, actor, diaryId);
      if (req.method === "POST" && action === "approve") return await approveDiary(req, res, actor, diaryId);
      if (req.method === "POST" && action === "reject") return await rejectDiary(req, res, actor, diaryId);
    }

    const diaryReadMatch = path.match(/^\/diaries\/([^/]+)$/);
    if (req.method === "GET" && diaryReadMatch) return await getDiaryData(req, res, actor, decodeURIComponent(diaryReadMatch[1]));

    const deletedPhotosMatch = path.match(/^\/diaries\/([^/]+)\/deleted-photos$/);
    if (req.method === "GET" && deletedPhotosMatch) return await listDeletedPhotos(req, res, actor, decodeURIComponent(deletedPhotosMatch[1]));

    const logRevisionsMatch = path.match(/^\/diaries\/([^/]+)\/logs\/([^/]+)\/revisions$/);
    if (req.method === "GET" && logRevisionsMatch) return await listLogRevisions(req, res, actor, decodeURIComponent(logRevisionsMatch[1]), decodeURIComponent(logRevisionsMatch[2]));
    const logListMatch = path.match(/^\/diaries\/([^/]+)\/logs$/);
    if (req.method === "GET" && logListMatch) return await listDiaryLogs(req, res, actor, decodeURIComponent(logListMatch[1]));

    const weeklyListMatch = path.match(/^\/diaries\/([^/]+)\/weekly-logs$/);
    if (req.method === "GET" && weeklyListMatch) return await listDiaryWeeklyLogs(req, res, actor, decodeURIComponent(weeklyListMatch[1]));

    const weeklyReadMatch = path.match(/^\/diaries\/([^/]+)\/weekly-logs\/([^/]+)$/);
    if (req.method === "GET" && weeklyReadMatch) return await readDiaryWeeklyLog(req, res, actor, decodeURIComponent(weeklyReadMatch[1]), decodeURIComponent(weeklyReadMatch[2]));

    const officialDocsListMatch = path.match(/^\/diaries\/([^/]+)\/official-docs$/);
    if (req.method === "GET" && officialDocsListMatch) return await listDiaryOfficialDocs(req, res, actor, decodeURIComponent(officialDocsListMatch[1]));

    const monthlyReadMatch = path.match(/^\/diaries\/([^/]+)\/monthly-evaluations\/([^/]+)$/);
    if (req.method === "GET" && monthlyReadMatch) return await readDiaryMonthlyEvaluation(req, res, actor, decodeURIComponent(monthlyReadMatch[1]), decodeURIComponent(monthlyReadMatch[2]));

    const notificationsListMatch = path.match(/^\/diaries\/([^/]+)\/notifications$/);
    if (req.method === "GET" && notificationsListMatch) return await listDiaryNotifications(req, res, actor, decodeURIComponent(notificationsListMatch[1]));
    const meetingsListMatch = path.match(/^\/diaries\/([^/]+)\/meetings$/);
    if (req.method === "GET" && meetingsListMatch) return await listDiaryMeetings(req, res, actor, decodeURIComponent(meetingsListMatch[1]));
    const pdfDataMatch = path.match(/^\/diaries\/([^/]+)\/pdf-data$/);
    if (req.method === "GET" && pdfDataMatch) return await getDiaryPdfData(req, res, actor, decodeURIComponent(pdfDataMatch[1]));
    const settingsMatch = path.match(/^\/diaries\/([^/]+)\/(settings|title|temp-unlock|work-location|reminders|notifications-read)$/);
    if (req.method === "POST" && settingsMatch) {
      const id = decodeURIComponent(settingsMatch[1]);
      const action = settingsMatch[2];
      if (action === "settings") return await updateDiarySettings(req, res, actor, id);
      if (action === "title") return await updateDiaryTitle(req, res, actor, id);
      if (action === "temp-unlock") return await saveTempUnlock(req, res, actor, id);
      if (action === "work-location") return await saveWorkLocation(req, res, actor, id);
      if (action === "reminders") return await saveReminders(req, res, actor, id);
      if (action === "notifications-read") return await markDiaryNotificationsRead(req, res, actor, id);
    }

    const uploadMatch = path.match(/^\/diaries\/([^/]+)\/upload$/);
    if (req.method === "POST" && uploadMatch) return await uploadDiaryFile(req, res, actor, decodeURIComponent(uploadMatch[1]));
    const officialDocMatch = path.match(/^\/diaries\/([^/]+)\/official-docs(?:\/([^/]+))?$/);
    if (officialDocMatch) {
      const id = decodeURIComponent(officialDocMatch[1]);
      const docId = officialDocMatch[2] ? decodeURIComponent(officialDocMatch[2]) : "";
      if (req.method === "POST" && !docId) return await addOfficialDocRecord(req, res, actor, id);
      if (req.method === "DELETE" && docId) return await deleteOfficialDocRecord(req, res, actor, id, docId);
    }

    const chatMatch = path.match(/^\/diaries\/([^/]+)\/(chat|chat-read)$/);
    if (chatMatch) {
      const id = decodeURIComponent(chatMatch[1]);
      const action = chatMatch[2];
      if (req.method === "GET" && action === "chat") return await listChatMessages(req, res, actor, id);
      if (req.method === "POST" && action === "chat") return await sendChatMessage(req, res, actor, id);
      if (req.method === "POST" && action === "chat-read") return await markChatMessagesRead(req, res, actor, id);
    }


    const weeklyLogMatch = path.match(/^\/diaries\/([^/]+)\/weekly-logs\/([^/]+)$/);
    if (req.method === "POST" && weeklyLogMatch) {
      return await saveWeeklyLog(req, res, actor, decodeURIComponent(weeklyLogMatch[1]), decodeURIComponent(weeklyLogMatch[2]));
    }

    const logMatch = path.match(/^\/diaries\/([^/]+)\/logs\/([^/]+)$/);
    if (req.method === "POST" && logMatch) {
      return await saveDiaryLog(req, res, actor, decodeURIComponent(logMatch[1]), decodeURIComponent(logMatch[2]));
    }

    const evalMatch = path.match(/^\/diaries\/([^/]+)\/monthly-evaluations\/([^/]+)$/);
    if (req.method === "POST" && evalMatch) {
      return await saveMonthlyEvaluation(req, res, actor, decodeURIComponent(evalMatch[1]), decodeURIComponent(evalMatch[2]));
    }

    if (req.method === "POST" && path === "/classes/notify") return await sendClassNotification(req, res, actor);
    return json(res, 404, { error: "API yolu bulunamadi." });
  } catch (error) {
    console.error("API error", error);
    return json(res, error.status || 500, { error: error.message || "Sunucu hatasi." });
  }
});













