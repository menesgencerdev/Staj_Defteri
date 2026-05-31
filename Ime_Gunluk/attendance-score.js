export function haversineMeters(a, b) {
  if (!a || !b) return 0;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad((b.lat || 0) - (a.lat || 0));
  const dLon = toRad((b.lng || 0) - (a.lng || 0));
  const lat1 = toRad(a.lat || 0);
  const lat2 = toRad(b.lat || 0);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export function evaluateAttendanceScore(attendance = {}, opts = {}) {
  const morning = attendance.morning || {};
  const evening = attendance.evening || {};
  const hasMorning = !!morning.imageUrl && !!morning.location;
  const hasEvening = !!evening.imageUrl && !!evening.location;
  const morningMeta = !!morning.meta?.flagged;
  const eveningMeta = !!evening.meta?.flagged;

  const accuracyWarn = Number(opts.accuracyWarn ?? 80);
  const morningAccBad = Number(morning.location?.accuracy || 0) > accuracyWarn;
  const eveningAccBad = Number(evening.location?.accuracy || 0) > accuracyWarn;

  let score = 0;
  score += hasMorning ? Number(opts.morningPoints ?? 50) : 0;
  score += hasEvening ? Number(opts.eveningPoints ?? 50) : 0;
  score -= morningMeta ? Number(opts.metaPenalty ?? 15) : 0;
  score -= eveningMeta ? Number(opts.metaPenalty ?? 15) : 0;
  score -= morningAccBad ? Number(opts.accuracyPenalty ?? 10) : 0;
  score -= eveningAccBad ? Number(opts.accuracyPenalty ?? 10) : 0;

  const distanceEnabled = !!opts.useDistancePenalty;
  const distanceLimitMeters = Number(opts.distanceLimitMeters ?? 400);
  const distancePenalty = Number(opts.distancePenalty ?? 15);
  const baseLocation = opts.baseLocation || attendance.baseLocation || morning.location || evening.location || null;

  let hasDistancePenalty = false;
  if (distanceEnabled && baseLocation) {
    const applyDistance = (entry) => {
      if (!entry?.location) return;
      const distance = haversineMeters(baseLocation, entry.location);
      if (distance > distanceLimitMeters) {
        hasDistancePenalty = true;
        score -= distancePenalty;
      }
    };
    applyDistance(morning);
    applyDistance(evening);
  }

  const minScore = Number(opts.minScore ?? 0);
  const maxScore = Number(opts.maxScore ?? 100);
  const roundScore = opts.roundScore !== false;
  const normalizedScore = Math.max(minScore, Math.min(maxScore, roundScore ? Math.round(score) : score));

  const locationLabel = (hasMorning || hasEvening)
    ? (hasDistancePenalty ? "konum uyumsuz" : "konum uygun")
    : "konum yok";

  return {
    score: normalizedScore,
    hasMorning,
    hasEvening,
    flags: {
      missingMorning: !hasMorning,
      missingEvening: !hasEvening,
      metaWarning: morningMeta || eveningMeta,
      accuracyWarning: morningAccBad || eveningAccBad,
      distanceWarning: hasDistancePenalty
    },
    locationLabel
  };
}
