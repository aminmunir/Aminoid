const REST_BASES = [
  'https://data-api.binance.vision/api/v3',
  'https://api.binance.com/api/v3',
];
const WS_BASES = ['wss://stream.binance.com:9443/stream?streams=', 'wss://stream.binance.com:443/stream?streams='];
const FUTURES_BASES = ['https://fapi.binance.com', 'https://fapi1.binance.com'];
const LIMITS = { '15m': 180, '1h': 180, '4h': 260 };

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchJson(path, params = {}, timeoutMs = 12000) {
  let lastError;
  for (const base of REST_BASES) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = new URL(base + path);
      Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
        if (response.status === 429 || response.status === 418) {
          const pause = Math.min(15000, 1000 * (attempt + 1) * (base === REST_BASES[0] ? 1 : 2));
          await sleep(pause);
          throw new Error(`Binance rate limited request (${response.status}); backing off.`);
        }
        if (!response.ok) throw new Error(`Binance REST returned ${response.status}`);
        return await response.json();
      } catch (err) {
        lastError = err;
        if (attempt === 0) await sleep(250);
      } finally {
        clearTimeout(timeout);
      }
    }
  }
  throw lastError || new Error('Could not reach Binance Spot REST API');
}

export async function getSpotExchangeInfo() {
  const data = await fetchJson('/exchangeInfo', {}, 18000);
  const symbols = new Map();
  for (const s of data.symbols || []) {
    if (s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.isSpotTradingAllowed !== false) {
      symbols.set(s.symbol, { symbol: s.symbol, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset, status: s.status });
    }
  }
  return symbols;
}

async function getKlines(symbol, interval, limit) {
  const rows = await fetchJson('/klines', { symbol, interval, limit }, 15000);
  const now = Date.now();
  return (Array.isArray(rows) ? rows : []).filter(row => Array.isArray(row) && Number(row[6]) < now);
}

async function withConcurrency(items, limit, worker) {
  const output = new Array(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      try { output[i] = await worker(items[i], i); }
      catch (error) { output[i] = { error: error?.message || String(error) }; }
      // Gentle spacing limits bursts from a single browser refresh.
      await sleep(100);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
  return output;
}

export async function loadSpotHistory(markets, onProgress = () => {}) {
  const supported = markets.filter(m => m.supported);
  const results = await withConcurrency(supported, 4, async (market, index) => {
    const [c15m, c1h, c4h] = await Promise.all([
      getKlines(market.binance, '15m', LIMITS['15m']),
      getKlines(market.binance, '1h', LIMITS['1h']),
      getKlines(market.binance, '4h', LIMITS['4h']),
    ]);
    onProgress({ done: index + 1, total: supported.length, symbol: market.symbol });
    if (c4h.length < 200 || c1h.length < 35 || c15m.length < 10) {
      throw new Error(`Not enough closed candles (15m ${c15m.length}, 1h ${c1h.length}, 4h ${c4h.length})`);
    }
    return {
      symbol: market.symbol,
      binance: market.binance,
      tier: market.tier,
      supported: true,
      ready: true,
      candles: { '15m': c15m, '1h': c1h, '4h': c4h },
      forming: { '15m': null, '1h': null, '4h': null },
      livePrice: Number(c15m.at(-1)?.[4] || c1h.at(-1)?.[4] || c4h.at(-1)?.[4]),
      bookImbalancePct: null,
      lastUpdate: Date.now(),
      error: null,
    };
  });
  const map = new Map();
  supported.forEach((m, i) => {
    const r = results[i];
    if (r && !r.error) map.set(m.binance, r);
    else map.set(m.binance, { symbol: m.symbol, binance: m.binance, tier: m.tier, supported: true, ready: false, error: r?.error || 'Failed to load candles', candles: { '15m': [], '1h': [], '4h': [] }, forming: {}, livePrice: null, bookImbalancePct: null });
  });
  for (const m of markets) {
    if (!m.supported) map.set(m.binance, { symbol: m.symbol, binance: m.binance, tier: m.tier, supported: false, ready: false, error: 'Not available as a trading Binance Spot USDT pair', candles: { '15m': [], '1h': [], '4h': [] }, forming: {}, livePrice: null, bookImbalancePct: null });
  }
  return map;
}

function klineEventToRow(k) {
  return [k.t, k.o, k.h, k.l, k.c, k.v, k.T, k.q, k.n, k.V, k.Q, '0'];
}

export function connectSpotStreams(markets, callbacks = {}) {
  const supported = markets.filter(m => m.supported);
  let ws = null, stopped = false, retryTimer = null, currentUrlIndex = 0;
  const streamSet = new Set();
  for (const market of supported) {
    const s = market.binance.toLowerCase();
    for (const interval of ['15m', '1h', '4h']) streamSet.add(`${s}@kline_${interval}`);
    streamSet.add(`${s}@bookTicker`);
  }
  const streams = [...streamSet];

  function connect() {
    if (stopped || !streams.length) return;
    const base = WS_BASES[currentUrlIndex % WS_BASES.length];
    const url = base + streams.join('/');
    try { ws = new WebSocket(url); }
    catch (err) { callbacks.onStatus?.('reconnecting', err?.message); retry(); return; }
    ws.onopen = () => callbacks.onStatus?.('connected');
    ws.onmessage = event => {
      let envelope;
      try { envelope = JSON.parse(event.data); } catch { return; }
      const payload = envelope.data || envelope;
      if (payload.e === 'kline' && payload.k) {
        const k = payload.k;
        callbacks.onKline?.({ symbol: k.s, interval: k.i, candle: klineEventToRow(k), closed: Boolean(k.x), eventTime: payload.E, livePrice: Number(k.c) });
      } else if (payload.e === 'bookTicker' || (payload.s && payload.b !== undefined && payload.a !== undefined && payload.B !== undefined && payload.A !== undefined)) {
        const bidQty = Number(payload.B), askQty = Number(payload.A), denom = bidQty + askQty;
        const imbalance = denom > 0 ? (bidQty - askQty) / denom * 100 : null;
        callbacks.onBook?.({ symbol: payload.s, bidPrice: Number(payload.b), askPrice: Number(payload.a), bidQty, askQty, imbalancePct: imbalance, eventTime: payload.u || Date.now() });
      }
    };
    ws.onerror = () => callbacks.onStatus?.('reconnecting', 'WebSocket error; trying a backup endpoint.');
    ws.onclose = () => {
      callbacks.onStatus?.('reconnecting', 'Stream disconnected. Reconnecting automatically.');
      currentUrlIndex++;
      retry();
    };
  }
  function retry() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 2200);
  }
  connect();
  return {
    close() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      try { ws?.close(); } catch {}
    },
    get connected() { return ws?.readyState === WebSocket.OPEN; },
    streamCount: streams.length,
  };
}


async function fetchFuturesJson(path, params = {}, timeoutMs = 12000) {
  let lastError;
  for (const base of FUTURES_BASES) {
    const url = new URL(base + path);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (response.status === 429 || response.status === 418) {
        await sleep(1500);
        throw new Error(`Binance USDⓈ-M Futures rate limited request (${response.status}); backing off.`);
      }
      if (!response.ok) {
        let detail = '';
        try { detail = (await response.json())?.msg || ''; } catch {}
        throw new Error(`Binance USDⓈ-M Futures returned ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      return await response.json();
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('Could not reach Binance USDⓈ-M Futures market-data API');
}

async function withFuturesConcurrency(items, limit, worker) {
  const output = new Array(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      try { output[i] = await worker(items[i], i); }
      catch (error) { output[i] = { error: error?.message || String(error) }; }
      await sleep(120);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
  return output;
}

/**
 * Gets settled USDⓈ-M futures funding history for the configured spot symbols.
 * The scoring thresholds mirror the original Aminoid workflow exactly.
 */
export async function loadFuturesFunding(markets, onProgress = () => {}) {
  const supported = markets.filter(m => m.supported);
  const results = await withFuturesConcurrency(supported, 4, async (market, index) => {
    const rows = await fetchFuturesJson('/fapi/v1/fundingRate', { symbol: market.binance, limit: 8 }, 12000);
    const valid = Array.isArray(rows) ? rows.filter(row => row && row.fundingRate !== undefined && Number.isFinite(Number(row.fundingRate))) : [];
    if (!valid.length) throw new Error('No funding history returned for this USDⓈ-M Futures symbol');
    const latest = Number(valid.at(-1).fundingRate);
    const funding24h = valid.slice(-3).reduce((sum, row) => sum + Number(row.fundingRate), 0);
    onProgress({ done: index + 1, total: supported.length, symbol: market.symbol });
    return { symbol: market.symbol, binance: market.binance, fundingRate: latest, funding24h, fundingTime: Number(valid.at(-1).fundingTime) || null, error: null };
  });
  const map = new Map();
  supported.forEach((m, i) => {
    const r = results[i];
    map.set(m.binance, r && !r.error ? r : { symbol: m.symbol, binance: m.binance, fundingRate: null, funding24h: null, fundingTime: null, error: r?.error || 'Funding rate unavailable' });
  });
  for (const m of markets) if (!m.supported) map.set(m.binance, { symbol: m.symbol, binance: m.binance, fundingRate: null, funding24h: null, fundingTime: null, error: 'Spot pair unavailable' });
  return map;
}

/** Gets a fresh current open-interest observation for each matching USDⓈ-M contract. */
export async function loadFuturesOpenInterest(markets, onProgress = () => {}) {
  const supported = markets.filter(m => m.supported);
  const results = await withFuturesConcurrency(supported, 4, async (market, index) => {
    const result = await fetchFuturesJson('/fapi/v1/openInterest', { symbol: market.binance }, 12000);
    const openInterest = Number(result?.openInterest);
    if (!Number.isFinite(openInterest) || openInterest <= 0) throw new Error('Open-interest response did not contain a valid value');
    onProgress({ done: index + 1, total: supported.length, symbol: market.symbol });
    return { symbol: market.symbol, binance: market.binance, openInterest, exchangeTime: Number(result?.time) || null, error: null };
  });
  const map = new Map();
  supported.forEach((m, i) => {
    const r = results[i];
    map.set(m.binance, r && !r.error ? r : { symbol: m.symbol, binance: m.binance, openInterest: null, exchangeTime: null, error: r?.error || 'Open interest unavailable' });
  });
  for (const m of markets) if (!m.supported) map.set(m.binance, { symbol: m.symbol, binance: m.binance, openInterest: null, exchangeTime: null, error: 'Spot pair unavailable' });
  return map;
}

export async function fetchBtcDominance() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/global', { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`Global market context returned ${response.status}`);
    const json = await response.json();
    const value = Number(json?.data?.market_cap_percentage?.btc);
    if (!Number.isFinite(value)) throw new Error('BTC dominance not present in global response');
    return value;
  } finally { clearTimeout(timeout); }
}
