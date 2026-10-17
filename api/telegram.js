const requestTimes = new Map();
const recentSignals = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 6;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Method not allowed' });
  }
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return send(res, 503, { error: 'Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in deployment environment variables.' });
  }

  const expectedOrigin = process.env.APP_ORIGIN;
  const origin = req.headers.origin;
  if (expectedOrigin && origin !== expectedOrigin) {
    return send(res, 403, { error: 'Origin not allowed' });
  }
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  for (const [knownIp, knownTimes] of requestTimes.entries()) {
    if (!knownTimes.some(t => now - t < WINDOW_MS)) requestTimes.delete(knownIp);
  }
  const times = (requestTimes.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (times.length >= MAX_PER_WINDOW) return send(res, 429, { error: 'Telegram alert rate limit exceeded' });
  times.push(now); requestTimes.set(ip, times);

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return send(res, 400, { error: 'Invalid JSON body' }); }
  }
  if (!body || typeof body !== 'object') return send(res, 400, { error: 'Missing alert payload' });
  const symbol = String(body.symbol || '').toUpperCase();
  const direction = String(body.direction || '').toUpperCase();
  const score = Number(body.score), confidence = Number(body.confidence), price = Number(body.price), timestamp = Number(body.timestamp);
  if (!/^[A-Z0-9]{2,15}$/.test(symbol) || !['LONG','SHORT'].includes(direction) || !Number.isFinite(score) || score < 0 || score > 100 || !Number.isFinite(price) || price <= 0 || !Number.isFinite(timestamp)) {
    return send(res, 400, { error: 'Invalid signal fields' });
  }
  const dayStart = (() => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); })();
  if (timestamp < dayStart || timestamp > now + 60_000) return send(res, 400, { error: 'Only signals generated on the current UTC day may be relayed' });
  if (Number.isFinite(confidence) && (confidence < 0 || confidence > 100)) return send(res, 400, { error: 'Invalid confidence value' });

  const duplicateKey = `${symbol}:${direction}:${timestamp}`;
  for (const [key, t] of recentSignals.entries()) if (now - t > 2 * 60 * 60_000) recentSignals.delete(key);
  if (recentSignals.has(duplicateKey)) return send(res, 200, { ok: true, duplicate: true });

  const fmt = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 8 }) : '—';
  const time = new Date(timestamp).toISOString().replace('T', ' ').replace('Z', ' UTC');
  const lines = [
    `AMINOID SPOT · ${direction} SIGNAL`,
    `${symbol}/USDT · Binance SPOT`,
    `Score: ${score.toFixed(1)}/100 | ${String(body.tier || 'Tier D')}`,
    `Workflow confidence: ${Number.isFinite(confidence) ? `${Math.round(confidence)}%` : '—'}`,
    `Route: ${String(body.route || 'none').toUpperCase()}`,
    `Reference: ${fmt(price)}`,
    `Stop: ${fmt(body.stop)} | TP1: ${fmt(body.tp1)} | TP2: ${fmt(body.tp2)}`,
    time,
    'Spot market analysis only — not financial advice.',
  ];
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: lines.join('\n'), disable_web_page_preview: true }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) return send(res, 502, { error: result.description || 'Telegram rejected the alert' });
    recentSignals.set(duplicateKey, now);
    return send(res, 200, { ok: true });
  } catch (error) {
    return send(res, 502, { error: 'Telegram API request failed' });
  }
};
