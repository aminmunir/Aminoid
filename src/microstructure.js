/**
 * Reproduces Aminoid's executable OI confirmation rule without a database.
 * The browser stores only the last observation in localStorage; scoring is
 * skipped until the two observations are about one 15-minute scan apart.
 */
export const OI_COMPARE_MIN_MS = 14 * 60_000;
export const OI_COMPARE_MAX_MS = 30 * 60_000;
export const OI_CHANGE_THRESHOLD_PCT = 1;

export function evaluateOpenInterestSample(currentValue, previousSample, priceRising, now = Date.now()) {
  const current = Number(currentValue);
  if (!Number.isFinite(current) || current <= 0) {
    return { openInterest: null, changePct: null, oiIncreasing: null, status: 'unavailable', nextSample: previousSample || null };
  }

  const previousValue = Number(previousSample?.value);
  const previousTime = Number(previousSample?.time);
  const elapsed = now - previousTime;
  const hasPrevious = Number.isFinite(previousValue) && previousValue > 0 && Number.isFinite(previousTime);

  if (!hasPrevious) {
    return { openInterest: current, changePct: null, oiIncreasing: null, status: 'baseline-set', nextSample: { value: current, time: now } };
  }
  if (elapsed < OI_COMPARE_MIN_MS) {
    return { openInterest: current, changePct: null, oiIncreasing: null, status: 'waiting-next-sample', nextSample: previousSample };
  }
  if (elapsed > OI_COMPARE_MAX_MS) {
    return { openInterest: current, changePct: null, oiIncreasing: null, status: 'baseline-reset', nextSample: { value: current, time: now } };
  }

  const changePct = (current - previousValue) / previousValue * 100;
  let oiIncreasing = null;
  let status = 'below-threshold';
  if (Math.abs(changePct) > OI_CHANGE_THRESHOLD_PCT) {
    if (changePct > 0) {
      // Original workflow: increasing OI confirms LONG bias only when the
      // latest closed 4H spot candle closed above its predecessor. If it did
      // not, it is a bearish-positioning observation but not a score bonus.
      oiIncreasing = Boolean(priceRising);
      status = oiIncreasing ? 'confirm' : 'rising-against-spot';
    } else {
      status = 'falling-or-noise';
    }
  }

  return {
    openInterest: current,
    changePct: Math.round(changePct * 1000) / 1000,
    oiIncreasing,
    status,
    nextSample: { value: current, time: now },
  };
}
