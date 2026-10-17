const STORAGE_KEY = 'aminoid-spot-static-memory-v1';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const CYCLE_MS = 900_000;
const MAX_SIGNALS_PER_UTC_DAY = 100;

export function utcDayStart(timestamp = Date.now()) {
  const d = new Date(timestamp);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function emptyMemory() {
  return { version: 1, cooldowns: {}, sentCycles: {}, signals: [], btcDominanceHistory: [], oiSamples: {}, updatedAt: Date.now() };
}

function prune(memory, now = Date.now()) {
  const cutoff48h = now - 2 * DAY_MS;
  memory.signals = (memory.signals || [])
    .filter(s => Number(s.timestamp) >= utcDayStart(now) && Number(s.timestamp) <= now + 60_000)
    .sort((a,b) => b.timestamp - a.timestamp)
    .slice(0, MAX_SIGNALS_PER_UTC_DAY);
  for (const [key, value] of Object.entries(memory.cooldowns || {})) {
    if (!value?.time || value.time < cutoff48h) delete memory.cooldowns[key];
  }
  for (const [key, timestamp] of Object.entries(memory.sentCycles || {})) {
    if (!Number.isFinite(timestamp) || timestamp < cutoff48h) delete memory.sentCycles[key];
  }
  memory.btcDominanceHistory = (memory.btcDominanceHistory || [])
    .filter(x => Number.isFinite(x.ts) && now - x.ts <= 70 * 60_000)
    .sort((a,b) => a.ts - b.ts);
  memory.oiSamples = memory.oiSamples || {};
  for (const [symbol, sample] of Object.entries(memory.oiSamples)) {
    if (!sample || !Number.isFinite(Number(sample.value)) || Number(sample.value) <= 0 ||
        !Number.isFinite(Number(sample.time)) || now - Number(sample.time) > 48 * HOUR_MS) {
      delete memory.oiSamples[symbol];
    }
  }
  memory.updatedAt = now;
  return memory;
}

export function loadMemory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyMemory();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1) return emptyMemory();
    return prune({ ...emptyMemory(), ...parsed }, Date.now());
  } catch {
    // Storage may be disabled. The app still functions in volatile page memory.
    return emptyMemory();
  }
}

export function saveMemory(memory) {
  prune(memory, Date.now());
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(memory)); return true; }
  catch { return false; }
}

export function addBtcDominanceReading(memory, value, now = Date.now()) {
  if (!Number.isFinite(value)) return { memory, btcdNow: null, btcdChg: null };
  const history = (memory.btcDominanceHistory || []).filter(x => now - x.ts <= 70 * 60_000);
  const lookback = 20 * 60_000;
  let previous = null, bestDiff = Infinity;
  for (const point of history) {
    const diff = Math.abs((now - point.ts) - lookback);
    if (diff < bestDiff) { bestDiff = diff; previous = point; }
  }
  const btcdChg = previous ? value - previous.value : 0;
  history.push({ ts: now, value });
  memory.btcDominanceHistory = history;
  return { memory, btcdNow: value, btcdChg };
}

export function attemptSignalAcceptance(memory, scored, now = Date.now()) {
  if (!scored?.passesGate) return { accepted: false, reason: 'gate_failed', memory };
  const symbol = scored.symbol;
  const direction = scored.direction;
  if (!symbol || !direction || !Number.isFinite(scored.price) || scored.price <= 0) {
    return { accepted: false, reason: 'invalid_signal_data', memory };
  }
  prune(memory, now);
  const cycleBucket = Math.floor(now / CYCLE_MS);
  const cycleKey = `sent_${symbol}_${cycleBucket}`;
  if (memory.sentCycles[cycleKey]) return { accepted: false, reason: 'same_15m_cycle', memory };

  const cooldownKey = `sig_${symbol}_${direction}`;
  const last = memory.cooldowns[cooldownKey] || null;
  if (last?.time) {
    const hoursSince = (now - last.time) / HOUR_MS;
    const t1Pct = scored.targets?.t1Pct || 5;
    const moveThresholdPct = Math.max(t1Pct * 0.6, 1.5);
    const moveSincePct = last.price > 0 ? Math.abs(scored.price - last.price) / last.price * 100 : moveThresholdPct;
    if (hoursSince <= 1) return { accepted: false, reason: 'cooldown_1h', memory };
    if (moveSincePct < moveThresholdPct) return { accepted: false, reason: 'price_has_not_moved_enough', memory };
  }

  const side = direction === 'LONG' ? 'long' : 'short';
  const targets = scored.targets || {};
  const entryLow = side === 'long' ? targets.entryL : targets.entryL;
  const entryHigh = side === 'long' ? targets.entryH : targets.entryH;
  const signal = {
    id: `${symbol}_${direction}_${now}`,
    timestamp: now,
    utcDay: utcDayStart(now),
    symbol,
    binance: scored.binance || `${symbol}USDT`,
    tier: scored.tier || 2,
    direction,
    price: scored.price,
    livePrice: scored.livePrice ?? scored.price,
    regime: scored.regime || 'UNCERTAIN',
    strength: scored.strength,
    rawScore: scored.total,
    score100: scored.displayScore,
    longScore100: scored.longDisplayScore,
    shortScore100: scored.shortDisplayScore,
    confidence: scored.confidence,
    gateRoute: scored.route,
    margin: scored.margin,
    layersHit: scored.layersHit,
    disagreementCount: scored.disagreementCount,
    targets: {
      entryL: entryLow, entryH: entryHigh,
      stop: direction === 'LONG' ? targets.slLong : targets.slShort,
      tp1: direction === 'LONG' ? targets.t1Long : targets.t1Short,
      tp2: direction === 'LONG' ? targets.t2Long : targets.t2Short,
      riskReward: direction === 'LONG' ? targets.rrLong : targets.rrShort,
      t1Pct: targets.t1Pct,
    },
    reasons: (scored.winningHits || []).slice(),
    warnings: (scored.warnings || []).slice(),
  };
  memory.sentCycles[cycleKey] = now;
  // Only commit the cooldown state after a signal is actually emitted. The
  // original n8n node updates this key before its downstream deduplication,
  // which can continually restart the cooldown while the same gate remains true.
  memory.cooldowns[cooldownKey] = { time: now, price: scored.price };
  memory.signals.unshift(signal);
  prune(memory, now);
  return { accepted: true, reason: 'accepted', signal, memory };
}

export function todaySignals(memory, now = Date.now()) {
  const start = utcDayStart(now);
  return (memory.signals || []).filter(s => s.timestamp >= start && s.timestamp <= now + 60_000).sort((a,b)=>b.timestamp-a.timestamp);
}

export function cooldownSummary(memory) {
  const now = Date.now();
  return Object.entries(memory.cooldowns || {}).map(([key, value]) => ({
    key, lastTime: value.time, ageHours: (now - value.time) / HOUR_MS, price: value.price,
  }));
}
