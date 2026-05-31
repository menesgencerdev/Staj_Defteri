function replaceTR(text = "") {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0131/g, "i")
    .replace(/\u0130/g, "I");
}

let jsPdfLoadPromise = null;
function ensureJsPdfLoaded() {
  if (window.jspdf?.jsPDF || window.jsPDF) return Promise.resolve();
  if (jsPdfLoadPromise) return jsPdfLoadPromise;
  jsPdfLoadPromise = new Promise((resolve, reject) => {
    const src = "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("jsPDF load failed")), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("jsPDF load failed"));
    document.head.appendChild(s);
  });
  return jsPdfLoadPromise;
}

export function createGunlukPdfActions(deps) {
  const { state, $, getAttendanceScore, getPrimaryLogImageUrl, loadImageAsDataUrl, sanitizeFileName, dataService } = deps;

  function toYmd(date) {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function formatDateTr(date) {
    return new Date(date).toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  function getWeekBounds(baseDate = new Date()) {
    const base = new Date(baseDate);
    base.setHours(0, 0, 0, 0);
    const jsDay = base.getDay();
    const mondayOffset = jsDay === 0 ? -6 : 1 - jsDay;
    const start = new Date(base);
    start.setDate(base.getDate() + mondayOffset);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start, end, startKey: toYmd(start), endKey: toYmd(end) };
  }

  async function generatePDF() {
    const btn = document.querySelector('button[onclick*="generatePDF"]');
    try {
      if (btn) { btn.innerText = "Veriler aliniyor..."; btn.disabled = true; }

      await ensureJsPdfLoaded();
      const JsPdfCtor = window.jspdf?.jsPDF || window.jsPDF;
      if (!JsPdfCtor) throw new Error("jsPDF kutuphanesi bulunamadi.");

      const latestLogs = { ...(state.logs || {}) };
      const dates = Object.keys(latestLogs).sort();
      if (!dates.length) return alert("Indirilecek veri bulunamadi.");

      const avgScore = Math.round(
        dates.reduce((acc, date) => acc + (getAttendanceScore(latestLogs[date]).score || 0), 0) / dates.length
      );
      const estimatedContinuation = Math.max(0, Math.min(100, avgScore));

      if (btn) btn.innerText = "Gorseller hazirlaniyor...";
      const imageMap = {};
      for (const date of dates) {
        const imgUrl = getPrimaryLogImageUrl(latestLogs[date]);
        if (imgUrl) imageMap[date] = await loadImageAsDataUrl(imgUrl);
      }

      if (btn) btn.innerText = "PDF olusturuluyor...";
      const pdf = new JsPdfCtor({ orientation: "portrait", unit: "mm", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 12;
      const usableWidth = pageWidth - margin * 2;
      const imageAreaWidth = 55;
      const gap = 5;
      let y = 15;

      const addPageIfNeeded = (need = 10) => {
        if (y + need > pageHeight - 15) { pdf.addPage(); y = 15; }
      };
      const drawLines = (lines, x, yStart, lineHeight = 5) => {
        lines.forEach((line, i) => pdf.text(line, x, yStart + i * lineHeight));
        return lines.length * lineHeight;
      };

      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(18);
      pdf.setTextColor(79, 70, 229);
      pdf.text(replaceTR(state.isPersonal ? "KISESEL NOTLARIM" : "STAJ RAPORU"), pageWidth / 2, y, { align: "center" });
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(9);
      pdf.setTextColor(30, 41, 59);
      pdf.text(replaceTR(`Tahmini Devam: %${estimatedContinuation}`), pageWidth - margin, y - 1, { align: "right" });
      y += 8;

      pdf.setDrawColor(79, 70, 229);
      pdf.setLineWidth(0.8);
      pdf.line(margin, y - 2, pageWidth - margin, y - 2);
      pdf.setFontSize(12);
      pdf.setTextColor(100, 116, 139);
      pdf.text(replaceTR(String(state.diary?.title || "Staj Gunlugu")), pageWidth / 2, y + 4, { align: "center" });
      y += 14;

      if (!state.isPersonal) {
        const note = $("suggestion-text")?.innerText || "Henuz degerlendirme yapilmadi.";
        pdf.setFontSize(11);
        pdf.setTextColor(30, 64, 175);
        pdf.text(replaceTR("Hoca Degerlendirmesi:"), margin, y);
        y += 6;

        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(10);
        pdf.setTextColor(51, 65, 85);
        const noteLines = pdf.splitTextToSize(replaceTR(String(note)), usableWidth);
        addPageIfNeeded(noteLines.length * 5 + 8);
        y += drawLines(noteLines, margin, y, 5) + 6;
      }

      pdf.setFontSize(9);
      pdf.setTextColor(148, 163, 184);
      pdf.text(replaceTR(`Ogrenci: ${String(state.diary?.studentEmail || "")}`), margin, y);
      pdf.text(replaceTR(`Rapor Tarihi: ${new Date().toLocaleDateString("tr-TR")}`), pageWidth - margin, y, { align: "right" });
      y += 5;
      pdf.setDrawColor(220, 220, 220);
      pdf.setLineWidth(0.3);
      pdf.line(margin, y, pageWidth - margin, y);
      y += 8;

      for (const date of dates) {
        const logItem = latestLogs[date] || {};
        const content = String(logItem?.content || "Icerik girilmemis.").trim();
        const imgObj = imageMap[date];
        const hasImage = !!imgObj?.dataUrl;
        const textWidth = hasImage ? usableWidth - imageAreaWidth - gap : usableWidth;
        const lines = pdf.splitTextToSize(replaceTR(content), textWidth);
        const attendanceScore = getAttendanceScore(logItem);

        let imgW = 0;
        let imgH = 0;
        const scoreLabelHeight = 6;
        const scoreGap = 2;
        if (hasImage) {
          imgW = imageAreaWidth;
          imgH = (imgObj.height / imgObj.width) * imgW;
          if (imgH > 60) { imgH = 60; imgW = (imgObj.width / imgObj.height) * imgH; }
        }

        const textH = Math.max(lines.length * 5, 8);
        const contentH = hasImage ? Math.max(textH, imgH + scoreLabelHeight + scoreGap) : textH + scoreLabelHeight + scoreGap;
        const blockH = 8 + contentH + 8;
        addPageIfNeeded(blockH);

        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(12);
        pdf.setTextColor(79, 70, 229);
        pdf.text(replaceTR(`TARIH: ${date}`), margin, y);
        y += 7;

        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(10.5);
        pdf.setTextColor(30, 41, 59);
        drawLines(lines, margin, y, 5);

        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(8);
        pdf.setTextColor(51, 65, 85);

        if (hasImage) {
          try {
            const imgX = pageWidth - margin - imgW;
            const imgY = y - 4;
            pdf.addImage(imgObj.dataUrl, "JPEG", imgX, imgY, imgW, imgH);
            pdf.text(replaceTR(`Yoklama Skoru: ${attendanceScore.score}/100 (${attendanceScore.locationLabel})`), pageWidth - margin, imgY + imgH + 4, { align: "right" });
          } catch (imgErr) {
            console.warn("Gorsel PDF'e eklenemedi:", imgErr);
          }
        } else {
          pdf.text(replaceTR(`Yoklama Skoru: ${attendanceScore.score}/100 (${attendanceScore.locationLabel})`), pageWidth - margin, y + textH + scoreLabelHeight, { align: "right" });
        }

        y += contentH + 4;
        pdf.setDrawColor(241, 245, 249);
        pdf.setLineWidth(0.5);
        pdf.line(margin, y, pageWidth - margin, y);
        y += 8;
      }

      pdf.save(`${sanitizeFileName(state.diary?.title || "Rapor")}_Rapor.pdf`);
    } catch (e) {
      console.error("PDF hatasi:", e);
      alert("PDF olusturulurken hata olustu.");
    } finally {
      if (btn) { btn.innerText = "PDF Al"; btn.disabled = false; }
    }
  }

  async function generateWeeklyStudentNotesPDF() {
    const btn = document.querySelector('button[onclick*="generateWeeklyStudentNotesPDF"]');
    try {
      if (btn) { btn.innerText = "Hafta hazirlaniyor..."; btn.disabled = true; }
      await ensureJsPdfLoaded();
      const JsPdfCtor = window.jspdf?.jsPDF || window.jsPDF;
      if (!JsPdfCtor) throw new Error("jsPDF kutuphanesi bulunamadi.");
      const activeStart = state.activeWeekStart || getWeekBounds(state.currentDate || new Date()).startKey;
      const weekly = state.weeklyLogs?.[activeStart] || await dataService?.readWeeklyLog?.(activeStart);
      if (!weekly || (!String(weekly.content || "").trim() && !(weekly.imageUrls || []).length)) return alert("Bu hafta icin haftalik ogrenci notu bulunamadi.");
      const bounds = getWeekBounds(new Date(`${activeStart}T00:00:00`));
      const images = (Array.isArray(weekly.selectedPdfImageUrls) && weekly.selectedPdfImageUrls.length ? weekly.selectedPdfImageUrls : (weekly.imageUrls || [])).slice(0, 3);
      if (btn) btn.innerText = "Gorseller hazirlaniyor...";
      const imageObjs = [];
      for (const url of images) {
        const img = await loadImageAsDataUrl(url);
        if (img?.dataUrl) imageObjs.push(img);
      }
      if (btn) btn.innerText = "PDF olusturuluyor...";
      const pdf = new JsPdfCtor({ orientation: "portrait", unit: "mm", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 14;
      const usableWidth = pageWidth - margin * 2;
      const imageAreaWidth = imageObjs.length ? 58 : 0;
      const gap = imageObjs.length ? 7 : 0;
      let y = 16;
      const addPageIfNeeded = (need = 10) => { if (y + need > pageHeight - 15) { pdf.addPage(); y = 16; } };
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(18);
      pdf.setTextColor(79, 70, 229);
      pdf.text(replaceTR("HAFTALIK STAJ NOTU"), pageWidth / 2, y, { align: "center" });
      y += 8;
      pdf.setDrawColor(79, 70, 229);
      pdf.setLineWidth(0.7);
      pdf.line(margin, y - 2, pageWidth - margin, y - 2);
      pdf.setFontSize(11);
      pdf.setTextColor(71, 85, 105);
      pdf.text(replaceTR(`${formatDateTr(bounds.start)} - ${formatDateTr(bounds.end)} haftasi`), pageWidth / 2, y + 5, { align: "center" });
      y += 15;
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9.5);
      pdf.setTextColor(100, 116, 139);
      pdf.text(replaceTR(`Ogrenci: ${String(state.diary?.studentEmail || "")}`), margin, y);
      pdf.text(replaceTR(`Rapor Tarihi: ${new Date().toLocaleDateString("tr-TR")}`), pageWidth - margin, y, { align: "right" });
      y += 10;
      const content = String(weekly.content || "").trim();
      const textWidth = usableWidth - imageAreaWidth - gap;
      const lines = pdf.splitTextToSize(replaceTR(content || "Haftalik not girilmedi."), textWidth);
      const imagesHeight = imageObjs.reduce((acc, img) => {
        let h = (img.height / img.width) * imageAreaWidth;
        if (h > 55) h = 55;
        return acc + h + 5;
      }, 0);
      addPageIfNeeded(Math.max(lines.length * 5 + 10, imagesHeight + 8));
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(12);
      pdf.setTextColor(30, 64, 175);
      pdf.text(replaceTR("Ogrenci Haftalik Notu:"), margin, y);
      y += 7;
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(10.5);
      pdf.setTextColor(30, 41, 59);
      lines.forEach((line, i) => pdf.text(line, margin, y + i * 5));
      let imgY = y - 3;
      const imgX = pageWidth - margin - imageAreaWidth;
      for (const img of imageObjs) {
        let imgW = imageAreaWidth;
        let imgH = (img.height / img.width) * imgW;
        if (imgH > 55) { imgH = 55; imgW = (img.width / img.height) * imgH; }
        pdf.addImage(img.dataUrl, "JPEG", imgX + (imageAreaWidth - imgW), imgY, imgW, imgH);
        imgY += imgH + 5;
      }
      pdf.save(`${sanitizeFileName(state.diary?.title || "Gunluk")}_Haftalik_${bounds.startKey}_${bounds.endKey}.pdf`);
    } catch (e) {
      console.error("Haftalik PDF hatasi:", e);
      alert("Haftalik not PDFi olusturulurken hata olustu.");
    } finally {
      if (btn) { btn.innerText = "Haftalik PDF"; btn.disabled = false; }
    }
  }

  return { generatePDF, generateWeeklyStudentNotesPDF };
}


