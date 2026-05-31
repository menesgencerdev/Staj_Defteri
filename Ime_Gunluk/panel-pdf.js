function replaceTR(t = "") {
  return String(t)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0131/g, "i")
    .replace(/\u0130/g, "I");
}

function loadImageAsDataUrl(url) {
  return new Promise((r) => {
    if (!url) return r(null);
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
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        r({ dataUrl: canvas.toDataURL("image/jpeg", 0.8), width: w, height: h });
      } catch {
        r(null);
      }
    };
    img.onerror = () => r(null);
    img.src = url;
  });
}

function getPrimaryLogImageUrl(log) {
  return (Array.isArray(log?.imageUrls) && log.imageUrls[0]) ? log.imageUrls[0] : (log?.imageUrl || "");
}

const scriptCache = new Map();
function loadScriptOnce(src) {
  if (scriptCache.has(src)) return scriptCache.get(src);
  const p = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "1") return resolve();
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`Script load failed: ${src}`)), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => {
      s.dataset.loaded = "1";
      resolve();
    };
    s.onerror = () => reject(new Error(`Script load failed: ${src}`));
    document.head.appendChild(s);
  });
  scriptCache.set(src, p);
  return p;
}

export function createPanelPdfActions(deps) {
  const { groupedClassesRef, getAttendanceScoreFromLog, callBackend } = deps;

  async function generateClassPDF(className, classLabel = "", mode = "daily") {
    const btn = document.getElementById("class-pdf-btn");
    if (btn) { btn.innerText = mode === "weekly" ? "Haftalik ZIP hazirlaniyor..." : "Sistem Hazirlaniyor..."; btn.disabled = true; }

    try {
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js");
      await loadScriptOnce("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
      const JsPdfCtor = window.jspdf && window.jspdf.jsPDF ? window.jspdf.jsPDF : window.jsPDF;
      if (!JsPdfCtor) throw new Error("jsPDF yuklenemedi!");
      if (!window.JSZip) throw new Error("JSZip Kutuphanesi Bulunamadi!");

      const zip = new JSZip();
      const grouped = groupedClassesRef();
      const students = grouped[className] || [];
      const displayName = String(classLabel || className || "Sinif");
      const mId = `${new Date().getFullYear()}-${new Date().getMonth() + 1}`;
      if (typeof callBackend !== "function") throw new Error("Backend PDF veri servisi bulunamadi.");

      for (let s = 0; s < students.length; s++) {
        const student = students[s];
        if (btn) btn.innerText = `${s + 1}/${students.length} PDF Hazirlaniyor...`;

        const pdf = new JsPdfCtor({ orientation: "portrait", unit: "mm", format: "a4" });
        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        const margin = 12;
        const usableWidth = pageWidth - margin * 2;
        const imageAreaWidth = 55;
        const gap = 5;

        let y = 15;
        const addPageIfNeeded = (neededHeight = 10) => {
          if (y + neededHeight > pageHeight - 15) {
            pdf.addPage();
            y = 15;
          }
        };
        const drawLines = (lines, x, startY, lineHeight = 5) => {
          for (let i = 0; i < lines.length; i++) pdf.text(lines[i], x, startY + i * lineHeight);
          return lines.length * lineHeight;
        };

        const pdfData = await callBackend(`/api/diaries/${encodeURIComponent(student.id)}/pdf-data?month=${encodeURIComponent(mId)}`);
        const hocaNotu = pdfData.monthlyEvaluation || "Henuz degerlendirme yapilmadi.";

        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(18);
        pdf.setTextColor(79, 70, 229);
        pdf.text(replaceTR("STAJ RAPORU"), pageWidth / 2, y, { align: "center" });
        y += 8;
        pdf.setDrawColor(79, 70, 229);
        pdf.setLineWidth(0.8);
        pdf.line(margin, y - 2, pageWidth - margin, y - 2);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(12);
        pdf.setTextColor(100, 116, 139);
        pdf.text(replaceTR(student.title), pageWidth / 2, y + 4, { align: "center" });
        y += 14;

        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(11);
        pdf.setTextColor(30, 64, 175);
        pdf.text(replaceTR("Hoca Degerlendirmesi:"), margin, y);
        y += 6;
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(10);
        pdf.setTextColor(51, 65, 85);
        const noteLines = pdf.splitTextToSize(replaceTR(hocaNotu), usableWidth);
        addPageIfNeeded((noteLines.length * 5) + 8);
        y += drawLines(noteLines, margin, y, 5);
        y += 6;

        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(9);
        pdf.setTextColor(148, 163, 184);
        pdf.text(replaceTR(`Ogrenci: ${student.studentEmail}`), margin, y);
        pdf.text(replaceTR(`Rapor Tarihi: ${new Date().toLocaleDateString("tr-TR")}`), pageWidth - margin, y, { align: "right" });
        y += 5;
        pdf.setDrawColor(220, 220, 220);
        pdf.setLineWidth(0.3);
        pdf.line(margin, y, pageWidth - margin, y);
        y += 8;

        if (mode === "weekly") {
          const weeklyRows = Array.isArray(pdfData.weeklyLogs) ? [...pdfData.weeklyLogs] : [];
          weeklyRows.sort((a, b) => String(a.id).localeCompare(String(b.id)));

          if (!weeklyRows.length) {
            pdf.setFont("helvetica", "italic");
            pdf.setFontSize(10);
            pdf.setTextColor(100, 100, 100);
            pdf.text(replaceTR("Bu ogrenci henuz haftalik not girmemis."), margin, y);
          } else {
            for (const row of weeklyRows) {
              const weekStart = String(row.weekStart || row.id || "");
              const weekEnd = String(row.weekEnd || "");
              const content = String(row.content || "").trim() || "Haftalik not girilmedi.";
              const images = (Array.isArray(row.selectedPdfImageUrls) && row.selectedPdfImageUrls.length ? row.selectedPdfImageUrls : (row.imageUrls || [])).slice(0, 3);
              const imageObjs = [];
              for (const url of images) {
                const img = await loadImageAsDataUrl(url);
                if (img?.dataUrl) imageObjs.push(img);
              }
              const hasImage = imageObjs.length > 0;
              const textWidth = hasImage ? usableWidth - imageAreaWidth - gap : usableWidth;
              const textLines = pdf.splitTextToSize(replaceTR(content), textWidth);
              addPageIfNeeded(Math.max(18 + textLines.length * 5, hasImage ? 72 : 20));
              pdf.setFont("helvetica", "bold");
              pdf.setFontSize(12);
              pdf.setTextColor(79, 70, 229);
              pdf.text(replaceTR(`${weekStart}${weekEnd ? " - " + weekEnd : ""} haftasi`), margin, y);
              y += 7;
              pdf.setFont("helvetica", "normal");
              pdf.setFontSize(10.5);
              pdf.setTextColor(30, 41, 59);
              drawLines(textLines, margin, y, 5);
              let imgY = y - 4;
              for (const img of imageObjs) {
                let imgW = imageAreaWidth;
                let imgH = (img.height / img.width) * imgW;
                if (imgH > 55) { imgH = 55; imgW = (img.width / img.height) * imgH; }
                try { pdf.addImage(img.dataUrl, "JPEG", pageWidth - margin - imgW, imgY, imgW, imgH); } catch {}
                imgY += imgH + 5;
              }
              y += Math.max(textLines.length * 5, hasImage ? Math.min(70, imgY - y) : 0) + 7;
              pdf.setDrawColor(241, 245, 249);
              pdf.line(margin, y, pageWidth - margin, y);
              y += 8;
            }
          }

          const pdfBlob = pdf.output("blob");
          zip.file(`${replaceTR(student.title)}_haftalik.pdf`, pdfBlob);
          continue;
        }

        const logs = pdfData.logs || {};
        const dates = Object.keys(logs).sort();
        const avgScore = dates.length
          ? Math.round(dates.reduce((acc, date) => acc + (getAttendanceScoreFromLog(logs[date]).score || 0), 0) / dates.length)
          : 0;
        const estimatedContinuation = Math.max(0, Math.min(100, avgScore));

        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(9);
        pdf.setTextColor(30, 41, 59);
        pdf.text(replaceTR(`Tahmini Devam: %${estimatedContinuation}`), pageWidth - margin, 12, { align: "right" });

        if (!dates.length) {
          pdf.setFont("helvetica", "italic");
          pdf.setFontSize(10);
          pdf.setTextColor(100, 100, 100);
          pdf.text("Bu ogrenci henuz gunluk girmemis.", margin, y);
        } else {
          const imageMap = {};
          for (const date of dates) {
            const imgUrl = getPrimaryLogImageUrl(logs[date]);
            if (imgUrl) imageMap[date] = await loadImageAsDataUrl(imgUrl);
          }

          for (const date of dates) {
            const log = logs[date];
            const content = String(log.content || "").trim() || "Icerik girilmemis.";
            const imgObj = imageMap[date];
            const hasImage = !!imgObj?.dataUrl;
            const textWidth = hasImage ? usableWidth - imageAreaWidth - gap : usableWidth;

            pdf.setFont("helvetica", "bold");
            pdf.setFontSize(12);
            pdf.setTextColor(79, 70, 229);
            const textLines = pdf.splitTextToSize(replaceTR(content), textWidth);
            let imgW = 0; let imgH = 0;
            if (hasImage) {
              imgW = imageAreaWidth;
              imgH = (imgObj.height / imgObj.width) * imgW;
              if (imgH > 60) { imgH = 60; imgW = (imgObj.width / imgObj.height) * imgH; }
            }

            const blockH = 8 + Math.max(textLines.length * 5, imgH) + 8;
            addPageIfNeeded(blockH);

            pdf.text(replaceTR(`TARIH: ${date}`), margin, y);
            y += 7;
            pdf.setFont("helvetica", "normal");
            pdf.setFontSize(10.5);
            pdf.setTextColor(30, 41, 59);
            drawLines(textLines, margin, y, 5);
            if (hasImage) {
              try { pdf.addImage(imgObj.dataUrl, "JPEG", pageWidth - margin - imgW, y - 4, imgW, imgH); } catch {}
            }
            y += Math.max(textLines.length * 5, imgH) + 4;
            pdf.setDrawColor(241, 245, 249);
            pdf.setLineWidth(0.5);
            pdf.line(margin, y, pageWidth - margin, y);
            y += 8;
          }
        }

        const pdfBlob = pdf.output("blob");
        zip.file(`${replaceTR(student.title)}.pdf`, pdfBlob);
      }

      if (btn) btn.innerText = "Sikistiriliyor...";
      const zipBlob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${replaceTR(displayName)}_${mode === "weekly" ? "haftalik" : "gunluk"}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      alert(mode === "weekly" ? "Butun sinifin haftalik notlari ZIP olarak indirildi!" : "Butun sinifin gunlukleri ayri dosyalar halinde ZIP olarak indirildi!");
    } catch (e) {
      alert("PDF olusturulurken bir hata olustu: " + e);
      console.error(e);
    } finally {
      if (btn) { btn.innerText = "ZIP Indir"; btn.disabled = false; }
    }
  }

  return { generateClassPDF };
}


