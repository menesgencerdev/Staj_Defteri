export function createGunlukLiveChat(deps) {
  const {
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
    heartbeatMs,
    onlineWindowMs,
    callBackend
  } = deps;
  const toast = (message, type = "info", timeoutMs = 3800) => {
    if (typeof window !== "undefined" && typeof window.notify === "function") {
      window.notify(String(message || ""), type, timeoutMs);
      return;
    }
    if (typeof window !== "undefined" && typeof window.alert === "function") {
      window.alert(String(message || ""));
    }
  };

  function getPresenceDocId(email = "") {
    return String(email || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]/g, "_")
      .slice(0, 120) || "unknown";
  }

  function formatTimeTr(value) {
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

  function isOwnChatMessage(message = {}) {
    const myEmail = normalizeEmail(auth.currentUser?.email || "");
    const senderEmail = normalizeEmail(message.senderEmail || "");
    return !!myEmail && senderEmail === myEmail;
  }

  function chatSenderLabel(message = {}, mine = false) {
    if (mine) return "Sen";
    const senderEmail = normalizeEmail(message.senderEmail || "");
    const instructorEmail = normalizeEmail(state.diary?.instructorEmail || "");
    const studentEmail = normalizeEmail(state.diary?.studentEmail || "");
    if (message.senderRole === "instructor" || (senderEmail && senderEmail === instructorEmail)) return "Hoca";
    if (message.senderRole === "student" || (senderEmail && senderEmail === studentEmail)) return "Ogrenci";
    return state.isInstructor ? "Ogrenci" : "Hoca";
  }

  function formatDateTimeTr(value) {
    if (!value) return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("tr-TR", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function updateLiveChatPresenceUI() {
    const dot = $("live-chat-status-dot");
    const txt = $("live-chat-status-text");
    if (!dot || !txt) return;
    const online = !!state.counterpartOnline;
    dot.classList.toggle("online", online);
    if (online) {
      txt.innerText = state.isInstructor
        ? "Ogrenci su an cevrimici. Yanit icin panel Mesaj Merkezi'ni kullanin."
        : "Hoca su an cevrimici.";
    } else if (state.counterpartLastSeenMs) {
      const t = formatDateTimeTr(state.counterpartLastSeenMs);
      txt.innerText = state.isInstructor
        ? `Son gorulme: ${t} (Yanit icin panel Mesaj Merkezi)`
        : `Son gorulme: ${t}`;
    } else {
      txt.innerText = state.isInstructor
        ? "Henuz cevrimici degil. Yanit icin panel Mesaj Merkezi."
        : "Henuz cevrimici degil.";
    }
  }

  function renderLiveChatMessages() {
    const wrap = $("live-chat-messages");
    if (!wrap) return;
    const rows = state.liveChat.messages || [];
    if (!rows.length) {
      wrap.innerHTML = `<div class="muted-text" style="font-size:0.86rem;">Henuz mesaj yok.</div>`;
      return;
    }
    wrap.innerHTML = rows.map((m) => {
      const mine = isOwnChatMessage(m);
      const sender = chatSenderLabel(m, mine);
      const tm = formatTimeTr(m.createdAtMs || m.createdAt);
      return `
        <div class="chat-row ${mine ? "mine" : ""}">
          <div class="chat-bubble">
            <div>${escapeHTML(m.text || "")}</div>
            <div class="chat-meta">${sender}${tm ? ` - ${tm}` : ""}</div>
          </div>
        </div>
      `;
    }).join("");
    wrap.scrollTop = wrap.scrollHeight;
  }

  async function setOwnPresence(isOnline) {
    const myEmail = auth.currentUser?.email?.toLowerCase().trim();
    if (!myEmail) return;
    try {
      if (!callBackend) throw new Error("LIVE_CHAT_BACKEND_MISSING");
      await callBackend("/api/presence", {
        method: "POST",
        body: JSON.stringify({ isOnline: !!isOnline })
      });
    } catch (e) {
      console.error("Presence yazilamadi:", e);
    }
  }

  function stopOwnPresenceHeartbeat() {
    if (state.presenceTimer) {
      clearInterval(state.presenceTimer);
      state.presenceTimer = null;
    }
  }

  function startOwnPresenceHeartbeat() {
    stopOwnPresenceHeartbeat();
    setOwnPresence(true);
    state.presenceTimer = window.setInterval(() => setOwnPresence(true), heartbeatMs);
  }

  function cleanupLiveChatSubs() {
    if (typeof state.chatUnsub === "function") {
      state.chatUnsub();
      state.chatUnsub = null;
    }
    if (typeof state.presenceUnsub === "function") {
      state.presenceUnsub();
      state.presenceUnsub = null;
    }
    stopOwnPresenceHeartbeat();
  }

  async function markMessagesRead(diaryIdArg, who) {
    try {
      if (!callBackend) throw new Error("LIVE_CHAT_BACKEND_MISSING");
      await callBackend(`/api/diaries/${encodeURIComponent(diaryIdArg)}/chat-read`, {
          method: "POST",
          body: JSON.stringify({ who })
        });
        return;
    } catch (e) {
      console.error("Mesaj okundu guncellenemedi:", e);
    }
  }

  function initLiveChat() {
    const widget = $("live-chat-widget");
    if (!widget || state.isPersonal) {
      setHidden("live-chat-widget", true);
      cleanupLiveChatSubs();
      return;
    }

    const counterpart = state.isInstructor
      ? (state.diary?.studentEmail || "")
      : (state.diary?.instructorEmail || "");
    state.counterpartEmail = String(counterpart || "").toLowerCase().trim();
    if (!state.counterpartEmail) {
      setHidden("live-chat-widget", true);
      cleanupLiveChatSubs();
      return;
    }

    setHidden("live-chat-widget", false);
    state.liveChat.minimized = true;
    const titleEl = $("live-chat-title");
    if (titleEl) titleEl.innerText = state.isInstructor ? "Ogrenci ile Canli Mesaj" : "Hoca ile Canli Mesaj";
    setHidden("live-chat-send-btn", state.isInstructor);
    setHidden("live-chat-input", state.isInstructor);
    const inputEl = $("live-chat-input");
    if (inputEl) {
      inputEl.disabled = !!state.isInstructor;
      inputEl.placeholder = state.isInstructor
        ? "Yanit icin panel Mesaj Merkezi'ni kullanin."
        : "Mesaj yaz...";
    }
    setHidden("live-chat-body", true);
    const toggleBtn = $("live-chat-toggle");
    if (toggleBtn) toggleBtn.innerText = "+";
    updateLiveChatPresenceUI();

    cleanupLiveChatSubs();
    startOwnPresenceHeartbeat();

    const presenceRef = doc(db, "presence", getPresenceDocId(state.counterpartEmail));
    state.presenceUnsub = onSnapshot(presenceRef, (snap) => {
      const d = snap.exists() ? snap.data() : {};
      const lastSeenMs = Number(d?.lastSeenMs || 0);
      const alive = !!d?.isOnline && (Date.now() - lastSeenMs) < onlineWindowMs;
      state.counterpartOnline = alive;
      state.counterpartLastSeenMs = lastSeenMs;
      updateLiveChatPresenceUI();
    });

    const chatQ = query(
      collection(db, "diaries", diaryId, "chatMessages"),
      orderBy("createdAtMs", "asc"),
      limit(120)
    );
    state.chatUnsub = onSnapshot(chatQ, (snap) => {
      const rows = [];
      snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
      state.liveChat.messages = rows;
      renderLiveChatMessages();
      if (state.isInstructor) markMessagesRead(diaryId, "instructor");
      else markMessagesRead(diaryId, "student");
    });
  }

  function toggleLiveChat() {
    const body = $("live-chat-body");
    const btn = $("live-chat-toggle");
    if (!body || !btn) return;
    state.liveChat.minimized = !state.liveChat.minimized;
    setHidden("live-chat-body", state.liveChat.minimized);
    btn.innerText = state.liveChat.minimized ? "+" : "-";
  }

  async function handleSendLiveMessage() {
    if (state.isInstructor) {
      toast("Hoca yanitlari sadece panel Mesaj Merkezi'nden gonderilir.", "warn");
      return;
    }
    const inp = $("live-chat-input");
    const btn = $("live-chat-send-btn");
    if (!inp || !btn) return;
    const text = String(inp.value || "").trim();
    if (!text) return;

    btn.disabled = true;
    try {
      if (!callBackend) throw new Error("LIVE_CHAT_BACKEND_MISSING");
      await callBackend(`/api/diaries/${encodeURIComponent(diaryId)}/chat`, {
        method: "POST",
        body: JSON.stringify({ text })
      });
      inp.value = "";
    } catch (e) {
      console.error(e);
      toast("Mesaj gonderilemedi.", "error");
    } finally {
      btn.disabled = false;
      inp.focus();
    }
  }

  function handleVisibilityChange() {
    if (state.isPersonal || !state.counterpartEmail) return;
    if (document.hidden) {
      stopOwnPresenceHeartbeat();
      setOwnPresence(false);
    } else {
      startOwnPresenceHeartbeat();
    }
  }

  function handleBeforeUnload() {
    if (!state.isPersonal && state.counterpartEmail) {
      stopOwnPresenceHeartbeat();
      setOwnPresence(false);
    }
  }

  return {
    initLiveChat,
    cleanupLiveChatSubs,
    setOwnPresence,
    toggleLiveChat,
    handleSendLiveMessage,
    handleVisibilityChange,
    handleBeforeUnload
  };
}
