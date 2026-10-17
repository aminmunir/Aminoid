/*
 * Aminoid Spot — browser-side indicator and scoring engine.
 * Spot candles drive the chart and Layers 1–4. Layer 5 uses matching public
 * Binance USDⓈ-M Futures funding and open-interest data, matching the original
 * Aminoid Alpha executable scoring rules. The website is independent of n8n.
 */

export const SCORE_MAX = 11.5;
export const SCORE_GATE = 3.3;
export const DEFAULT_WATCHLIST = [
  { symbol: 'BTC', binance: 'BTCUSDT', tier: 1 },
  { symbol: 'ETH', binance: 'ETHUSDT', tier: 1 },
  { symbol: 'SOL', binance: 'SOLUSDT', tier: 1 },
  { symbol: 'ZEC', binance: 'ZECUSDT', tier: 2 },
  { symbol: 'NEAR', binance: 'NEARUSDT', tier: 2 },
  { symbol: 'TAO', binance: 'TAOUSDT', tier: 2 },
  { symbol: 'WLD', binance: 'WLDUSDT', tier: 2 },
  { symbol: 'AAVE', binance: 'AAVEUSDT', tier: 2 },
  { symbol: 'LINK', binance: 'LINKUSDT', tier: 1 },
  { symbol: 'PENDLE', binance: 'PENDLEUSDT', tier: 2 },
  { symbol: 'INJ', binance: 'INJUSDT', tier: 2 },
  { symbol: 'UNI', binance: 'UNIUSDT', tier: 2 },
  { symbol: 'AVAX', binance: 'AVAXUSDT', tier: 1 },
  { symbol: 'ARB', binance: 'ARBUSDT', tier: 2 },
  { symbol: 'HYPE', binance: 'HYPEUSDT', tier: 2 },
];

const HALF = 0.5;
const PENALTY_PER_DISAGREEMENT = 0.25;
const round = (value, digits = 4) => Number.isFinite(value)
  ? Math.round(value * 10 ** digits) / 10 ** digits : null;
const n = (row, idx) => Number(row?.[idx]);
const open = row => n(row, 1);
const high = row => n(row, 2);
const low = row => n(row, 3);
const close = row => n(row, 4);
const volume = row => n(row, 5);
const validRows = rows => Array.isArray(rows) ? rows.filter(r => Array.isArray(r) && r.length >= 6 && [1,2,3,4,5].every(i => Number.isFinite(Number(r[i])))) : [];
const cap = (v, min, max) => Math.min(Math.max(v, min), max);

export function ema(values, period) {
  if (!values || values.length < period || period < 1) return [];
  const k = 2 / (period + 1);
  let current = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = Array(period - 1).fill(null);
  out.push(current);
  for (let i = period; i < values.length; i++) {
    current = values[i] * k + current * (1 - k);
    out.push(current);
  }
  return out;
}

export function rsi(values, period = 14) {
  if (!values || values.length < period + 1) return [];
  const out = Array(period).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return out;
}

function macd(values) {
  const fast = ema(values, 12), slow = ema(values, 26);
  const line = values.map((_, i) => fast[i] != null && slow[i] != null ? fast[i] - slow[i] : null);
  const nonNull = line.filter(v => v != null);
  const signalValues = ema(nonNull, 9);
  const pad = line.length - nonNull.length;
  const signal = [...Array(pad).fill(null), ...signalValues];
  return { line, signal, hist: line.map((v, i) => v != null && signal[i] != null ? v - signal[i] : null) };
}

function bollinger(values, period = 20) {
  const upper = [], mid = [], lower = [], bandwidth = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { upper.push(null); mid.push(null); lower.push(null); bandwidth.push(null); continue; }
    const slice = values.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a,b) => a+b, 0) / period;
    const sd = Math.sqrt(slice.reduce((a,b) => a + (b-mean) ** 2, 0) / period);
    upper.push(mean + 2 * sd); mid.push(mean); lower.push(mean - 2 * sd);
    bandwidth.push(mean > 0 ? 4 * sd / mean * 100 : null);
  }
  return { upper, mid, lower, bandwidth };
}

function atr(candles, period = 14) {
  if (!candles || candles.length < period + 1) return [];
  const tr = [null];
  for (let i = 1; i < candles.length; i++) {
    const h = high(candles[i]), l = low(candles[i]), pc = close(candles[i - 1]);
    tr.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
  }
  const out = Array(period).fill(null);
  let current = tr.slice(1, period + 1).reduce((a,b) => a+b, 0) / period;
  out.push(current);
  for (let i = period + 1; i < tr.length; i++) {
    current = (current * (period - 1) + tr[i]) / period;
    out.push(current);
  }
  return out;
}

function adx(candles, period = 14) {
  if (!candles || candles.length < period * 2) return { adx: null, pdi: null, ndi: null };
  const plusDM = [], minusDM = [], trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = high(candles[i]), ph = high(candles[i-1]);
    const l = low(candles[i]), pl = low(candles[i-1]);
    const prevClose = close(candles[i-1]);
    const up = h-ph, down = pl-l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(h-l, Math.abs(h-prevClose), Math.abs(l-prevClose)));
  }
  const smooth = list => {
    const s = [list.slice(0, period).reduce((a,b)=>a+b,0)];
    for (let i = period; i < list.length; i++) s.push(s.at(-1) - s.at(-1)/period + list[i]);
    return s;
  };
  const sTR = smooth(trs), sP = smooth(plusDM), sN = smooth(minusDM);
  const pDI = sP.map((v,i)=>sTR[i] > 0 ? 100*v/sTR[i] : 0);
  const nDI = sN.map((v,i)=>sTR[i] > 0 ? 100*v/sTR[i] : 0);
  const dx = pDI.map((v,i)=>(v+nDI[i]) > 0 ? 100*Math.abs(v-nDI[i])/(v+nDI[i]) : 0);
  let latest = dx.slice(0, period).reduce((a,b)=>a+b,0)/period;
  for (let i = period; i < dx.length; i++) latest = (latest*(period-1)+dx[i])/period;
  return { adx: latest, pdi: pDI.at(-1), ndi: nDI.at(-1) };
}

function stochRsi(values, rPeriod = 14, stochPeriod = 14) {
  const rv = rsi(values, rPeriod).filter(v => v != null);
  if (rv.length < stochPeriod + 1) return { k:null, d:null, prevK:null, prevD:null };
  const ks = [];
  for (let i = stochPeriod - 1; i < rv.length; i++) {
    const slice = rv.slice(i-stochPeriod+1, i+1);
    const min = Math.min(...slice), max = Math.max(...slice);
    ks.push(max-min === 0 ? 50 : 100*(rv[i]-min)/(max-min));
  }
  const k = ks.at(-1), prevK = ks.length >= 2 ? ks.at(-2) : null;
  const d = ks.length >= 3 ? ks.slice(-3).reduce((a,b)=>a+b,0)/3 : k;
  const prevD = ks.length >= 4 ? ks.slice(-4,-1).reduce((a,b)=>a+b,0)/3 : null;
  return { k, d, prevK, prevD };
}

function supportResistance(candles, lookback = 10) {
  const supports = [], resistances = [];
  for (let i=lookback; i<candles.length-lookback; i++) {
    const h=high(candles[i]), l=low(candles[i]);
    let isHigh=true, isLow=true;
    for (let j=i-lookback; j<=i+lookback; j++) {
      if (j===i) continue;
      if (high(candles[j]) >= h) isHigh=false;
      if (low(candles[j]) <= l) isLow=false;
    }
    if (isHigh) resistances.push(round(h,6));
    if (isLow) supports.push(round(l,6));
  }
  return { supports:supports.slice(-8), resistances:resistances.slice(-8) };
}

function rsiDivergence(candles, rsiValues, lookback = 30, pivotN = 3) {
  let pairs = [];
  for (let i=0; i<candles.length && i<rsiValues.length; i++) {
    if (rsiValues[i] != null) pairs.push({ priceHigh:high(candles[i]), priceLow:low(candles[i]), rsi:rsiValues[i] });
  }
  if (pairs.length > lookback) pairs = pairs.slice(-lookback);
  if (pairs.length < pivotN*2+2) return 'none';
  const lows=[], highs=[];
  for (let i=pivotN; i<pairs.length-pivotN; i++) {
    let isLow=true, isHigh=true;
    for (let j=i-pivotN; j<=i+pivotN; j++) {
      if (j===i) continue;
      if (pairs[j].priceLow <= pairs[i].priceLow) isLow=false;
      if (pairs[j].priceHigh >= pairs[i].priceHigh) isHigh=false;
    }
    if (isLow) lows.push({ price:pairs[i].priceLow, rsi:pairs[i].rsi });
    if (isHigh) highs.push({ price:pairs[i].priceHigh, rsi:pairs[i].rsi });
  }
  if (lows.length>=2) {
    const a=lows.at(-2), b=lows.at(-1);
    if (b.price<a.price && b.rsi>a.rsi) return 'bullish';
  }
  if (highs.length>=2) {
    const a=highs.at(-2), b=highs.at(-1);
    if (b.price>a.price && b.rsi<a.rsi) return 'bearish';
  }
  return 'none';
}

function candlePattern(candles) {
  if (!candles || candles.length<2) return 'none';
  const c=candles.at(-1), p=candles.at(-2);
  const o=open(c), h=high(c), l=low(c), cl=close(c), po=open(p), pcl=close(p);
  const body=Math.abs(cl-o), range=h-l;
  if (range<0.0001) return 'none';
  const upperWick=h-Math.max(o,cl), lowerWick=Math.min(o,cl)-l;
  if (body/range<0.35 && lowerWick>=body*2 && upperWick<=body*0.5 && cl>=o) return 'hammer';
  if (body/range<0.35 && upperWick>=body*2 && lowerWick<=body*0.5 && cl<=o) return 'shooting_star';
  if (cl>o && pcl<po && cl>po && o<pcl) return 'bullish_engulfing';
  if (cl<o && pcl>po && cl<po && o>pcl) return 'bearish_engulfing';
  if (body/range<0.1) return 'doji';
  return 'none';
}

function marketStructure(candles, lookback = 30) {
  if (!candles || candles.length<lookback) return 'unclear';
  const rows=candles.slice(-lookback), split=Math.floor(rows.length/2);
  const hs=rows.map(high), ls=rows.map(low);
  const hh=Math.max(...hs.slice(split))>Math.max(...hs.slice(0,split));
  const hl=Math.min(...ls.slice(split))>Math.min(...ls.slice(0,split));
  const lh=Math.max(...hs.slice(split))<Math.max(...hs.slice(0,split));
  const ll=Math.min(...ls.slice(split))<Math.min(...ls.slice(0,split));
  if (hh && hl) return 'bullish';
  if (lh && ll) return 'bearish';
  return 'unclear';
}

function volumeRatio(candles, period=20) {
  if (!candles || candles.length<period+1) return null;
  const prev=candles.slice(-period-1,-1).map(volume);
  const avg=prev.reduce((a,b)=>a+b,0)/period;
  return avg>0 ? round(volume(candles.at(-1))/avg,3) : null;
}

function bbInfo(bandwidth, price, upper, lower) {
  const values=bandwidth.filter(v=>v!=null);
  if (values.length<25) return { isSqueeze:false, isExpanding:false, atLower:false, atUpper:false };
  const recent=values.slice(-5), prior=values.slice(-25,-5);
  const recentMin=Math.min(...recent), priorMin=Math.min(...prior);
  const isSqueeze=recentMin<=priorMin;
  const isExpanding=recent.at(-1)>recentMin*1.2 && recent.at(-1)>recent.at(-2);
  return { isSqueeze, isExpanding,
    atLower:price!=null && lower!=null && price<=lower*1.005 && isSqueeze,
    atUpper:price!=null && upper!=null && price>=upper*0.995 && isSqueeze };
}

function threeBarMomentum(candles) {
  if (!candles || candles.length<4) return { bullish:false, bearish:false };
  const last=candles.at(-1), previous=candles.slice(-4,-1), c=close(last);
  return { bullish:previous.every(r=>c>high(r)), bearish:previous.every(r=>c<low(r)) };
}

function rsi7Cross(values) {
  if (!values || values.length<10) return { crossUp:false, crossDown:false };
  const rv=rsi(values,7).filter(v=>v!=null);
  if (rv.length<2) return { crossUp:false, crossDown:false };
  const curr=rv.at(-1), prev=rv.at(-2);
  return { crossUp:prev<30 && curr>=30, crossDown:prev>70 && curr<=70 };
}

function candleBodyRatio(candles) {
  if (!candles?.length) return { ratio:null, strongBull:false, strongBear:false };
  const c=candles.at(-1), o=open(c), h=high(c), l=low(c), cl=close(c), range=h-l;
  if (range===0) return { ratio:null, strongBull:false, strongBear:false };
  const ratio=round(Math.abs(cl-o)/range,3);
  return { ratio, strongBull:ratio>=0.7 && cl>o, strongBear:ratio>=0.7 && cl<o };
}

function consecutiveCandleDirection(candles) {
  if (!candles || candles.length<4) return { bullStreak:0, bearStreak:0, bullSignal:false, bearSignal:false };
  let bull=0, bear=0;
  for (let i=candles.length-1; i>=0; i--) {
    const c=close(candles[i]), o=open(candles[i]);
    if (c>o) { if (bear>0) break; bull++; }
    else if (c<o) { if (bull>0) break; bear++; }
    else break;
  }
  return { bullStreak:bull, bearStreak:bear, bullSignal:bull>=3, bearSignal:bear>=3 };
}

function vwap(candles, now=Date.now()) {
  if (!candles || candles.length<10) return null;
  const dayStart=now-(now%86400000);
  const session=candles.filter(c=>Number(c[0])>=dayStart);
  const used=session.length>=3 ? session : candles.slice(-24);
  let tpv=0, total=0;
  for (const c of used) {
    const typical=(high(c)+low(c)+close(c))/3, v=volume(c);
    tpv+=typical*v; total+=v;
  }
  return total>0 ? tpv/total : null;
}

function volumeStrength(candles, recentN=10, baselineN=20) {
  const total=recentN+baselineN;
  if (!candles || candles.length<total) return null;
  const recent=candles.slice(-recentN), baseline=candles.slice(-total,-recentN);
  const recentAvg=recent.reduce((s,c)=>s+volume(c),0)/recentN;
  const baseAvg=baseline.reduce((s,c)=>s+volume(c),0)/baselineN;
  return baseAvg>0 ? round(recentAvg/baseAvg*100,1) : null;
}

export function calculateSupertrend(candles, period=10, multiplier=2.5) {
  if (!candles || candles.length<period+3) return { direction:null, value:null, flipped:false, atr:null };
  const tr=[], src=[];
  for (let i=0;i<candles.length;i++) {
    const h=high(candles[i]), l=low(candles[i]);
    src.push((h+l)/2);
    if (i===0) tr.push(h-l);
    else {
      const pc=close(candles[i-1]);
      tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
    }
  }
  const atrVals=Array(candles.length).fill(null);
  for (let i=period-1;i<candles.length;i++) {
    if (i===period-1) atrVals[i]=tr.slice(0,i+1).reduce((a,b)=>a+b,0)/period;
    else atrVals[i]=(atrVals[i-1]*(period-1)+tr[i])/period;
  }
  const upper=Array(candles.length).fill(null), lower=Array(candles.length).fill(null), trend=Array(candles.length).fill(null);
  for (let i=0;i<candles.length;i++) {
    if (atrVals[i]===null) continue;
    const basicUpper=src[i]+multiplier*atrVals[i], basicLower=src[i]-multiplier*atrVals[i];
    if (i===0 || upper[i-1]===null) {
      upper[i]=basicUpper; lower[i]=basicLower; trend[i]=close(candles[i])>basicUpper ? 1 : -1;
    } else {
      upper[i]=(basicUpper<upper[i-1] || close(candles[i-1])>upper[i-1]) ? basicUpper : upper[i-1];
      lower[i]=(basicLower>lower[i-1] || close(candles[i-1])<lower[i-1]) ? basicLower : lower[i-1];
      trend[i-1] = trend[i-1];
      if (trend[i-1]===1) trend[i]=close(candles[i])<lower[i] ? -1 : 1;
      else trend[i]=close(candles[i])>upper[i] ? 1 : -1;
    }
  }
  const last=candles.length-1;
  return { direction:trend[last], value:trend[last]===1 ? lower[last] : upper[last], flipped:trend[last]!=null && trend[last-1]!=null && trend[last]!==trend[last-1], atr:atrVals[last] };
}

function nearestBelow(levels, price) {
  const vals=(levels||[]).filter(v=>v<price);
  return vals.length ? vals.reduce((a,b)=>(price-a)<(price-b)?a:b) : null;
}
function nearestAbove(levels, price) {
  const vals=(levels||[]).filter(v=>v>price);
  return vals.length ? vals.reduce((a,b)=>(price-a)>(price-b)?a:b) : null;
}
function ratioRewardRisk(entry, stop, target) {
  if (entry==null || stop==null || target==null) return null;
  const risk=Math.abs(entry-stop), reward=Math.abs(target-entry);
  return risk>0 ? round(reward/risk,2) : null;
}

function calculateTargets(price, currentATR, sr4h, sr1h) {
  let stopPct=null, t1Pct=null, t2Pct=null;
  if (currentATR!=null && price>0) {
    stopPct=cap(currentATR*1.5/price*100,1.5,8);
    t1Pct=cap(currentATR*2/price*100,2,12);
    t2Pct=cap(currentATR*4/price*100,4,25);
  }
  const entryPct=currentATR!=null && price>0 ? cap(currentATR/price*100*0.5,0.8,1.5) : 0.8;
  const entryL=price ? round(price*(1-entryPct/100),6) : null;
  const entryH=price ? round(price*(1+entryPct/100),6) : null;
  let slLong=null,slShort=null,t1Long=null,t1Short=null;
  let slSource='atr_fallback',t1Source='atr_fallback';
  if (price>0 && currentATR!=null) {
    const minPct=currentATR*0.75/price*100, maxPct=currentATR*3/price*100;
    const sup4=nearestBelow(sr4h.supports,price);
    if (sup4!=null) {
      const candidate=sup4*0.998, dist=(price-candidate)/price*100;
      if (dist>=minPct && dist<=maxPct) { slLong=round(candidate,6); slSource='sr_4h'; }
    }
    if (slLong==null && stopPct!=null) slLong=round(price*(1-stopPct/100),6);
    const res1=nearestAbove(sr1h.resistances,price);
    t1Long=res1!=null ? round(res1,6) : (t1Pct!=null ? round(price*(1+t1Pct/100),6) : null);
    if (res1!=null) t1Source='sr_1h';
    const res4=nearestAbove(sr4h.resistances,price);
    if (res4!=null) {
      const candidate=res4*1.002, dist=(candidate-price)/price*100;
      if (dist>=minPct && dist<=maxPct) slShort=round(candidate,6);
    }
    if (slShort==null && stopPct!=null) slShort=round(price*(1+stopPct/100),6);
    const sup1=nearestBelow(sr1h.supports,price);
    t1Short=sup1!=null ? round(sup1,6) : (t1Pct!=null ? round(price*(1-t1Pct/100),6) : null);
  } else {
    slLong=price && stopPct!=null ? round(price*(1-stopPct/100),6) : null;
    t1Long=price && t1Pct!=null ? round(price*(1+t1Pct/100),6) : null;
    slShort=price && stopPct!=null ? round(price*(1+stopPct/100),6) : null;
    t1Short=price && t1Pct!=null ? round(price*(1-t1Pct/100),6) : null;
  }
  let t2Long=price && t2Pct!=null ? round(price*(1+t2Pct/100),6) : null;
  let t2Short=price && t2Pct!=null ? round(price*(1-t2Pct/100),6) : null;
  if (t1Long!=null && entryH!=null && t1Long<=entryH) { t1Long=t1Pct!=null?round(price*(1+t1Pct/100),6):null; t1Source='atr_fallback'; }
  if (t1Long!=null && t2Long!=null && t2Long<=t1Long) t2Long=round(t1Long*(1+(t2Pct||4)/100),6);
  if (slLong!=null && entryL!=null && slLong>=entryL) { slLong=stopPct!=null?round(price*(1-stopPct/100),6):null; slSource='atr_fallback'; }
  if (t1Short!=null && entryL!=null && t1Short>=entryL) t1Short=t1Pct!=null?round(price*(1-t1Pct/100),6):null;
  if (t1Short!=null && t2Short!=null && t2Short>=t1Short) t2Short=round(t1Short*(1-(t2Pct||4)/100),6);
  if (slShort!=null && entryH!=null && slShort<=entryH) slShort=stopPct!=null?round(price*(1+stopPct/100),6):null;
  return { entryL,entryH,slLong,t1Long,t2Long,slShort,t1Short,t2Short,
    rrLong:ratioRewardRisk(price,slLong,t1Long),rrShort:ratioRewardRisk(price,slShort,t1Short),
    stopPct:round(stopPct,3),t1Pct:round(t1Pct,3),t2Pct:round(t2Pct,3),slSource,t1Source,entryPct:round(entryPct,3) };
}

function directionalLayerStatuses(ind) {
  const S=(longFlag,shortFlag,available=true)=>!available?'unavailable':longFlag?'bullish':shortFlag?'bearish':'neutral';
  const emaAvailable=ind.ema200!=null;
  const stAvailable=ind.supertrendDirection!=null;
  return [
    { key:'ema200',layer:1,label:'EMA 200 · 4H',status:S(ind.aboveE200,emaAvailable && !ind.aboveE200,emaAvailable),scoreable:true },
    { key:'supertrend',layer:1,label:'Supertrend · 10 / 2.5 · 4H',status:ind.supertrendDirection===1?'bullish':ind.supertrendDirection===-1?'bearish':'unavailable',scoreable:true },
    { key:'macd4h',layer:1,label:'MACD histogram · 4H',status:S(ind.macdGrowing,ind.macdShrinking,ind.macdHist4h!=null),scoreable:true },
    { key:'structure',layer:1,label:'Market structure · 4H',status:S(ind.structure==='bullish',ind.structure==='bearish',ind.structure!=='unavailable'),scoreable:true },
    { key:'rsiExtreme',layer:2,label:'RSI extreme · 1H',status:S(ind.rsiOS,ind.rsiOB,ind.rsi1h!=null),scoreable:true },
    { key:'rsiDiv',layer:2,label:'RSI divergence · 1H',status:S(ind.rsiDiv==='bullish',ind.rsiDiv==='bearish',ind.rsiDiv!=null && ind.rsiDiv!=='unavailable'),scoreable:true },
    { key:'bb',layer:2,label:'Bollinger squeeze / band touch · 4H',status:S(ind.bbSqueezeBounceL,ind.bbSqueezeBounceS,ind.bbUpper!=null),scoreable:true },
    { key:'pattern',layer:2,label:'Candle pattern · 1H',status:S(['hammer','bullish_engulfing'].includes(ind.pattern),['shooting_star','bearish_engulfing'].includes(ind.pattern),ind.pattern!=='unavailable'),scoreable:true },
    { key:'sr',layer:2,label:'Support / resistance proximity · 4H',status:S(ind.nearSup,ind.nearRes,ind.supports!=null && ind.resistances!=null),scoreable:true },
    { key:'volSurge',layer:3,label:'Volume surge · 1H',status:S(ind.volSurge&&ind.lastGreen,ind.volSurge&&ind.lastRed,ind.volRatio!=null),scoreable:true },
    { key:'macd1h',layer:3,label:'MACD histogram · 1H',status:S(ind.macd1hGrowing,ind.macd1hShrinking,ind.macdHist1h!=null),scoreable:true },
    { key:'stoch',layer:3,label:'Stochastic RSI cross · 1H',status:S(ind.stochCrossUp,ind.stochCrossDown,ind.stochK!=null),scoreable:true },
    { key:'vwap',layer:3,label:'VWAP deviation · 1H',status:S(ind.vwapLong,ind.vwapShort,ind.vwap!=null),scoreable:true },
    { key:'tbm',layer:4,label:'Three-bar momentum · 15m',status:S(ind.tbmBullish,ind.tbmBearish,ind.tbmBullish||ind.tbmBearish||ind.has15mData),scoreable:true },
    { key:'rsi7',layer:4,label:'RSI 7 threshold cross · 15m',status:S(ind.rsi7CrossUp,ind.rsi7CrossDown,ind.has15mData),scoreable:true },
    { key:'body',layer:4,label:'Candle-body strength · 15m',status:S(ind.strongBullCandle,ind.strongBearCandle,ind.bodyRatio!=null),scoreable:true },
    { key:'ccd',layer:4,label:'Consecutive candle direction · 15m',status:S(ind.ccdBull,ind.ccdBear,ind.has15mData),scoreable:true },
    { key:'funding',layer:5,label:'Funding rate · USDⓈ-M Futures',status:S(ind.fundBullish,ind.fundBearish,ind.fundingRate!=null),scoreable:true },
  ];
}

export function calculateIndicators(candles15mRaw, candles1hRaw, candles4hRaw, market = {}, context = {}) {
  // These input arrays contain confirmed/closed candles only. The Binance adapter
  // keeps the still-forming candle separate so unstable candles never score.
  const c15=validRows(candles15mRaw), c1=validRows(candles1hRaw), c4=validRows(candles4hRaw);
  const dataQuality={ has4h:c4.length>=200, has1h:c1.length>=35, has15m:c15.length>=10 };
  if (!dataQuality.has4h || !dataQuality.has1h || !dataQuality.has15m) {
    return { error:'Insufficient closed spot candles for full indicator calculation', symbol:market.symbol,
      dataQuality, lengths:{c15m:c15.length,c1h:c1.length,c4h:c4.length}, ind:null, targets:null, price:null };
  }
  const cls4=c4.map(close), cls1=c1.map(close), cls15=c15.map(close);
  const price=cls4.at(-1);
  const btcCloses=context.btcCloses1h||[];
  const btcChange12h=btcCloses.length>=13 ? (btcCloses.at(-1)-btcCloses.at(-13))/btcCloses.at(-13)*100 : null;
  const coinChange12h=cls1.length>=13 ? (cls1.at(-1)-cls1.at(-13))/cls1.at(-13)*100 : null;
  const rsBtc12h=coinChange12h!=null&&btcChange12h!=null ? round(coinChange12h-btcChange12h,3) : null;

  // Layer 1: original four-hour trend layer. EMA 200 replaces EMA 180;
  // Supertrend (ATR 10, multiplier 2.5, HL2 source) is a new 0.5-point vote.
  const ema200Values=ema(cls4,200), ema200=ema200Values.at(-1) ?? null;
  const aboveE200=ema200!=null && price>ema200;
  const st=calculateSupertrend(c4,10,2.5);
  const adx4=adx(c4,14), adxTrending=adx4.adx!=null&&adx4.adx>25;
  const m4=macd(cls4), h4=m4.hist.filter(v=>v!=null);
  const macdGrowing=h4.length>=3&&h4.at(-1)>h4.at(-2)&&h4.at(-2)>h4.at(-3);
  const macdShrinking=h4.length>=3&&h4.at(-1)<h4.at(-2)&&h4.at(-2)<h4.at(-3);
  const structure=marketStructure(c4,30);

  // Layer 2: exact executable-code timeframe usage: RSI/divergence/pattern use
  // 1H candles; Bollinger and S/R signals are calculated from 4H candles.
  const rsi1=rsi(cls1,14), rsiValid=rsi1.filter(v=>v!=null), rsi1h=rsiValid.at(-1)??null;
  const rsiOS=rsi1h!=null&&rsi1h<30, rsiOB=rsi1h!=null&&rsi1h>70;
  const rsiDiv=rsiDivergence(c1,rsi1,30,3);
  const bb=bollinger(cls4,20), bbUpper=bb.upper.at(-1), bbLower=bb.lower.at(-1), bbMid=bb.mid.at(-1);
  const bbState=bbInfo(bb.bandwidth,price,bbUpper,bbLower);
  const bbSqueezeBounceL=bbState.atLower, bbSqueezeBounceS=bbState.atUpper;
  const bbBreakoutL=price!=null&&bbUpper!=null&&price>=bbUpper*0.99&&bbState.isExpanding;
  const bbBreakoutS=price!=null&&bbLower!=null&&price<=bbLower*1.01&&bbState.isExpanding;
  const pattern=candlePattern(c1);
  const sr4=supportResistance(c4,10), sr1=supportResistance(c1,10);
  const nearSup=sr4.supports.some(s=>Math.abs(price-s)/price<0.008);
  const nearRes=sr4.resistances.some(s=>Math.abs(price-s)/price<0.008);

  // Layer 3: momentum; ADX is Layer 1 context; ATR expansion is confirmation.
  const volRatio=volumeRatio(c1,20), volSurge=volRatio!=null&&volRatio>=1.8;
  const lastC1=c1.at(-1), lastGreen=lastC1?close(lastC1)>open(lastC1):false, lastRed=lastC1?close(lastC1)<open(lastC1):false;
  const m1=macd(cls1), h1=m1.hist.filter(v=>v!=null);
  const macd1hGrowing=h1.length>=3&&h1.at(-1)>h1.at(-2)&&h1.at(-2)>h1.at(-3);
  const macd1hShrinking=h1.length>=3&&h1.at(-1)<h1.at(-2)&&h1.at(-2)<h1.at(-3);
  const srsi=stochRsi(cls1);
  const stochCrossUp=srsi.k!=null&&srsi.prevK!=null&&srsi.k<20&&srsi.prevK<=srsi.prevD&&srsi.k>srsi.d;
  const stochCrossDown=srsi.k!=null&&srsi.prevK!=null&&srsi.k>80&&srsi.prevK>=srsi.prevD&&srsi.k<srsi.d;
  const atrValues=atr(c4,14).filter(v=>v!=null), currentATR=atrValues.at(-1)??null;
  const atrExp=atrValues.length>=3&&atrValues.at(-1)>atrValues.at(-2)&&atrValues.at(-2)>atrValues.at(-3);
  const vwap1=vwap(c1), vwapDev=vwap1!=null&&vwap1>0?round((price-vwap1)/vwap1*100,4):null;
  const vwapLong=vwapDev!=null&&vwapDev>=0.3, vwapShort=vwapDev!=null&&vwapDev<=-0.3;
  const volStrengthPct=volumeStrength(c1,10,20);

  // Layer 4: entry timing on closed 15m spot candles.
  const tbm=threeBarMomentum(c15), r7=rsi7Cross(cls15), body=candleBodyRatio(c15), ccd=consecutiveCandleDirection(c15);

  // Layer 5 — actual USDⓈ-M Futures market context, fed separately from
  // the Spot candles. Missing futures data stays null and never becomes 0.
  const fundingRate=market.fundingRate!=null&&Number.isFinite(Number(market.fundingRate))?Number(market.fundingRate):null;
  const funding24h=market.funding24h!=null&&Number.isFinite(Number(market.funding24h))?Number(market.funding24h):null;
  const fundBullish=fundingRate!=null&&fundingRate < -0.0001;
  const fundBearish=fundingRate!=null&&fundingRate > 0.0001;
  const openInterest=market.openInterest!=null&&Number.isFinite(Number(market.openInterest))?Number(market.openInterest):null;
  const oiChangePct=market.oiChangePct!=null&&Number.isFinite(Number(market.oiChangePct))?Number(market.oiChangePct):null;
  const oiIncreasing=market.oiIncreasing===true?true:market.oiIncreasing===false?false:null;
  const oiStatus=market.oiStatus||'unavailable';
  // Spot order-book imbalance is retained as auxiliary context only; it is
  // deliberately excluded from directional score, route, and layer totals.
  const bookImbalancePct=Number.isFinite(market.bookImbalancePct)?market.bookImbalancePct:null;

  const btcdNow=context.btcdNow??null, btcdChg=context.btcdChg??null;
  const btcShock=Math.abs(context.btcChange2h??0)>4;
  const regime=adx4.adx==null?'UNCERTAIN':bbState.isSqueeze&&bbState.isExpanding?'BREAKOUT':adx4.adx>25?'TRENDING':adx4.adx<20?'RANGING':'UNCERTAIN';
  const ind={
    aboveE200, ema200:round(ema200,6), supertrendDirection:st.direction, supertrend:round(st.value,6), supertrendFlipped:st.flipped, supertrendATR:round(st.atr,6),
    adx:round(adx4.adx,2), adxTrending, macdGrowing, macdShrinking, macdHist4h:round(h4.at(-1),8), structure,
    rsi1h:round(rsi1h,2), rsiOS, rsiOB, rsiDiv,
    bbUpper:round(bbUpper,6), bbMid:round(bbMid,6), bbLower:round(bbLower,6), bbSqueeze:bbState.isSqueeze, bbExpanding:bbState.isExpanding,
    bbSqueezeBounceL, bbSqueezeBounceS, bbBreakoutL, bbBreakoutS, pattern, nearSup, nearRes, supports:sr4.supports, resistances:sr4.resistances,
    volRatio, volSurge, lastGreen, lastRed, macd1hGrowing, macd1hShrinking, macdHist1h:round(h1.at(-1),8), stochK:round(srsi.k,2), stochD:round(srsi.d,2), stochCrossUp, stochCrossDown,
    atr:round(currentATR,6), atrExp, vwap:round(vwap1,6), vwapDev, vwapLong, vwapShort,
    volBuyPct:null, volSellPct:null, volStrengthPct,
    tbmBullish:tbm.bullish, tbmBearish:tbm.bearish, rsi7CrossUp:r7.crossUp, rsi7CrossDown:r7.crossDown,
    bodyRatio:body.ratio, strongBullCandle:body.strongBull, strongBearCandle:body.strongBear,
    bullStreak:ccd.bullStreak,bearStreak:ccd.bearStreak,ccdBull:ccd.bullSignal,ccdBear:ccd.bearSignal,
    fundingRate, funding24h, fundBullish, fundBearish, openInterest, oiChangePct, oiIncreasing, oiStatus,
    bookImbalancePct, has15mData:dataQuality.has15m,
  };
  const targets=calculateTargets(price,currentATR,sr4,sr1);
  const layerStatuses=directionalLayerStatuses(ind);
  return {symbol:market.symbol, binance:market.binance, tier:market.tier||2, price:round(price,8), livePrice:market.livePrice??price,
    regime, btcShock, rsBtc12h, btcdNow, btcdChg, dataQuality, ind, targets, layerStatuses,
    btcChange2h:context.btcChange2h??null, candleCounts:{c15m:c15.length,c1h:c1.length,c4h:c4.length}};
}

function addScore(score, side, halfKey, label) {
  if (side==='LONG') { score.longScore+=halfKey; score.longHits.push(label); }
  else if (side==='SHORT') { score.shortScore+=halfKey; score.shortHits.push(label); }
}

export function scoreSignal(data) {
  if (!data || data.error || !data.ind || !data.targets) return { passesGate:false, error:data?.error||'No indicator data', symbol:data?.symbol };
  const d=data, ind=d.ind;
  let longScore=0, shortScore=0; const longHits=[], shortHits=[];
  const hit=(side,key,weight=HALF)=>{
    if(side==='LONG'){longScore+=weight;longHits.push(key);} else if(side==='SHORT'){shortScore+=weight;shortHits.push(key);}
  };

  // Layer 1: EMA 200 replaces EMA 180; Supertrend is a new 0.5-point vote.
  if(ind.aboveE200) hit('LONG','ema200'); else hit('SHORT','ema200');
  if(ind.supertrendDirection===1) hit('LONG','supertrend'); else if(ind.supertrendDirection===-1) hit('SHORT','supertrend');
  if(ind.macdGrowing) hit('LONG','macd4h'); if(ind.macdShrinking) hit('SHORT','macd4h');
  if(ind.structure==='bullish') hit('LONG','structure'); if(ind.structure==='bearish') hit('SHORT','structure');
  // Layer 2
  if(ind.rsiOS) hit('LONG','rsiExtreme'); if(ind.rsiOB) hit('SHORT','rsiExtreme');
  if(ind.rsiDiv==='bullish') hit('LONG','rsiDiv'); if(ind.rsiDiv==='bearish') hit('SHORT','rsiDiv');
  if(ind.bbSqueezeBounceL) hit('LONG','bb'); if(ind.bbSqueezeBounceS) hit('SHORT','bb');
  if(['hammer','bullish_engulfing'].includes(ind.pattern)) hit('LONG','pattern');
  if(['shooting_star','bearish_engulfing'].includes(ind.pattern)) hit('SHORT','pattern');
  if(ind.nearSup) hit('LONG','sr'); if(ind.nearRes) hit('SHORT','sr');
  // Layer 3
  if(ind.volSurge&&ind.lastGreen) hit('LONG','volSurge'); if(ind.volSurge&&ind.lastRed) hit('SHORT','volSurge');
  if(ind.macd1hGrowing) hit('LONG','macd1h'); if(ind.macd1hShrinking) hit('SHORT','macd1h');
  if(ind.stochCrossUp) hit('LONG','stoch'); if(ind.stochCrossDown) hit('SHORT','stoch');
  if(ind.vwapLong) hit('LONG','vwap'); if(ind.vwapShort) hit('SHORT','vwap');
  // Layer 4
  if(ind.tbmBullish) hit('LONG','tbm'); if(ind.tbmBearish) hit('SHORT','tbm');
  if(ind.rsi7CrossUp) hit('LONG','rsi7'); if(ind.rsi7CrossDown) hit('SHORT','rsi7');
  if(ind.strongBullCandle) hit('LONG','body'); if(ind.strongBearCandle) hit('SHORT','body');
  if(ind.ccdBull) hit('LONG','ccd'); if(ind.ccdBear) hit('SHORT','ccd');
  // Layer 5 directional vote: original USDⓈ-M Futures funding thresholds.
  if(ind.fundBullish) hit('LONG','funding'); if(ind.fundBearish) hit('SHORT','funding');

  // Nondirectional confirmation bonus: ADX, ATR expansion, and actual
  // open-interest increase, exactly as in the executable workflow.
  let confirmationBonus=0; const confirmationHits=[];
  if(ind.adxTrending){confirmationBonus+=HALF;confirmationHits.push('adx');}
  if(ind.atrExp){confirmationBonus+=HALF;confirmationHits.push('atr');}
  if(ind.oiIncreasing===true){confirmationBonus+=HALF;confirmationHits.push('oi');}
  if(longScore>=shortScore) longScore+=confirmationBonus; else shortScore+=confirmationBonus;

  const RS_BTC_WEIGHT=1.0;
  if(d.rsBtc12h!=null){if(d.rsBtc12h>2){longScore+=RS_BTC_WEIGHT;longHits.push('rsBtc_leader');} if(d.rsBtc12h< -2){shortScore+=RS_BTC_WEIGHT;shortHits.push('rsBtc_laggard');}}
  longScore=round(longScore,1); shortScore=round(shortScore,1);
  const direction=longScore>=shortScore?'LONG':'SHORT';
  const winningScore=Math.max(longScore,shortScore), losingScore=Math.min(longScore,shortScore);
  const margin=round(winningScore-losingScore,1);
  const btcdVetoApplied=direction==='LONG'&&(d.tier===2||d.tier===3)&&d.btcdChg!=null&&d.btcdChg>0.3;
  const btcdVetoPenalty=btcdVetoApplied?2.0:0;
  const rawTotal=winningScore;
  let total=rawTotal-btcdVetoPenalty;
  const disagreementHits=direction==='LONG'?shortHits:longHits;
  const disagreementCount=disagreementHits.length;
  const disagreementPenalty=Math.min(disagreementCount*PENALTY_PER_DISAGREEMENT,rawTotal/2);
  total=round(Math.max(0,total-disagreementPenalty),1);
  const winningHits=direction==='LONG'?longHits:shortHits;
  const passesScore=total>=SCORE_GATE;
  const trendRouteMomentum=['volSurge','macd1h','stoch','vwap'].some(k=>winningHits.includes(k));
  const hasDivergence=winningHits.includes('rsiDiv');
  const hasReversalExtreme=['sr','bb','rsiExtreme'].some(k=>winningHits.includes(k));
  const hasReversalTrigger=['stoch','rsi7'].some(k=>winningHits.includes(k));
  const reversalRouteQualifies=hasDivergence&&hasReversalExtreme&&hasReversalTrigger;
  const route=trendRouteMomentum?'trend':reversalRouteQualifies?'reversal':'none';
  const layerMap={ema200:1,supertrend:1,macd4h:1,structure:1,rsiExtreme:2,rsiDiv:2,bb:2,pattern:2,sr:2,
    volSurge:3,macd1h:3,stoch:3,vwap:3,tbm:4,rsi7:4,body:4,ccd:4,funding:5};
  const hitLayers=new Set(winningHits.map(k=>layerMap[k]).filter(Boolean));
  const layersHit=hitLayers.size;
  const passesLayers=layersHit>=3, passesDisagreement=disagreementCount<=3;
  const passesGate=passesScore&&(trendRouteMomentum||reversalRouteQualifies)&&passesLayers&&passesDisagreement;
  let strength='Tier D';
  if(total>=5.0) strength='Tier A'; else if(total>=4.3) strength='Tier B'; else if(total>=3.8) strength='Tier C';
  let confidence=(total/SCORE_MAX)*100;
  if(ind.rsiDiv==='bullish'||ind.rsiDiv==='bearish') confidence+=5;
  if(layersHit>=4) confidence+=5;
  if(margin>=3) confidence+=5;
  if(d.btcShock) confidence-=10;
  if(layersHit<3) confidence-=10;
  if(d.regime==='UNCERTAIN') confidence-=5;
  confidence-=disagreementCount*2;
  if(btcdVetoApplied) confidence-=10;
  confidence=Math.round(cap(confidence,45,92));
  const displayScore=round(total/SCORE_MAX*100,1);
  const longDisplayScore=round(longScore/SCORE_MAX*100,1), shortDisplayScore=round(shortScore/SCORE_MAX*100,1);
  const layerScores={};
  for(let layer=1;layer<=5;layer++){
    const items=d.layerStatuses.filter(x=>x.layer===layer&&x.status!=='unavailable');
    const bullish=items.filter(x=>x.status==='bullish').length, bearish=items.filter(x=>x.status==='bearish').length;
    const denominator=items.length;
    layerScores[layer]={label:['','Trend · 4H','Reversal','Momentum · 1H','Entry timing · 15m','Futures microstructure'][layer],
      bullish,bearish,neutral:denominator-bullish-bearish,total:denominator,
      bullishPct:denominator?round(bullish/denominator*100,1):null,
      bearishPct:denominator?round(bearish/denominator*100,1):null};
  }
  const reasons=winningHits.filter(k=>!['rsBtc_leader','rsBtc_laggard'].includes(k));
  const warnings=[];
  if(d.btcShock) warnings.push('BTC 2-hour move exceeds 4%; confidence reduced.');
  if(btcdVetoApplied) warnings.push('BTC dominance rising quickly; Tier 2/3 LONG veto penalty applied.');
  if(disagreementCount>0) warnings.push(`${disagreementCount} indicator vote(s) disagree with the selected direction.`);
  if(route==='reversal') warnings.push('Reversal route: early setup, so treat it with additional caution.');
  if(d.btcdNow==null) warnings.push('BTC dominance context unavailable; its veto was not applied.');
  if(!d.dataQuality?.has1h||!d.dataQuality?.has15m) warnings.push('Some timeframe data is incomplete.');
  return {...d, direction, longScore, shortScore, rawTotal:round(rawTotal,1), total, displayScore, longDisplayScore, shortDisplayScore,
    margin, longHits, shortHits, winningHits, confirmationHits, confirmationBonus:round(confirmationBonus,1),
    disagreementHits, disagreementCount, disagreementPenalty:round(disagreementPenalty,2), btcdVetoApplied, btcdVetoPenalty,
    passesScore, trendRouteMomentum, reversalRouteQualifies, route, layersHit, layerScores, passesLayers, passesDisagreement, passesGate,
    strength, confidence, gateChecks:{score:passesScore,route:route!=='none',layers:passesLayers,disagreement:passesDisagreement}, reasons, warnings};
}

export const layerLabels = {
  1:'Trend · 4H',2:'Reversal',3:'Momentum · 1H',4:'Entry Timing · 15m',5:'Futures Microstructure'
};
