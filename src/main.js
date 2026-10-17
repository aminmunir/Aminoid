import { DEFAULT_WATCHLIST, calculateIndicators, scoreSignal, SCORE_MAX, SCORE_GATE, layerLabels } from './engine.js';
import { getSpotExchangeInfo, loadSpotHistory, connectSpotStreams, fetchBtcDominance, loadFuturesFunding, loadFuturesOpenInterest } from './binance.js';
import { loadMemory, saveMemory, addBtcDominanceReading, attemptSignalAcceptance, todaySignals, utcDayStart } from './memory.js';
import { evaluateOpenInterestSample } from './microstructure.js';

const $ = id => document.getElementById(id);
const state = {
  markets: DEFAULT_WATCHLIST.map(m => ({ ...m, supported: false })),
  exchangeSymbols: new Map(),
  marketData: new Map(),
  analyses: new Map(),
  scores: new Map(),
  memory: loadMemory(),
  selected: 'BTCUSDT',
  timeframe: '15m',
  stream: null,
  streamStatus: 'connecting',
  loading: false,
  scanning: false,
  lastRecalculation: 0,
  btcDominanceNow: null,
  btcDominanceChange: null,
  dominanceAvailable: false,
  lastBtcDominanceFetch: 0,
  lastFuturesFundingFetch: 0,
  lastFuturesOIFetch: 0,
  futuresFundingStatus: 'loading',
  futuresOIStatus: 'loading',
  toastShown: new Set(),
  telegramNoticeShown: false,
  refreshCounter: 0,
  closedScanTimer: null,
};

const COIN_LETTERS = { BTC:'₿', ETH:'Ξ', SOL:'S', ZEC:'Z', NEAR:'N', TAO:'T', WLD:'W', AAVE:'A', LINK:'L', PENDLE:'P', INJ:'I', UNI:'U', AVAX:'A', ARB:'A', HYPE:'H' };
const COIN_CLASSES = { BTC:'btc', ETH:'eth', SOL:'sol' };
const LAYER_DESCRIPTIONS = {
  1:'Trend direction from EMA 200, Supertrend, MACD and structure; ADX is confirmation.',
  2:'Oversold/overbought, divergence, squeeze touches, candle patterns and nearby levels.',
  3:'Volume surge, MACD, Stochastic RSI and VWAP; ATR expansion is confirmation.',
  4:'Fast 15-minute momentum and entry timing cues.',
  5:'Funding rate provides the directional vote; open interest adds confirmation only when it rises >1% alongside a rising closed 4H spot candle.',
};

function showToast(message, type = '') {
  const region = $('toast-region');
  if (!region) return;
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  region.append(node);
  setTimeout(() => node.remove(), 5200);
}

function fmtPrice(value) {
  if (!Number.isFinite(Number(value))) return '—';
  const v = Number(value);
  let digits = 2;
  if (v < 0.0001) digits = 8;
  else if (v < 0.01) digits = 6;
  else if (v < 1) digits = 4;
  else if (v < 100) digits = 3;
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(v);
}
function fmtScore(v) { return Number.isFinite(v) ? Number(v).toFixed(1) : '—'; }
function fmtPct(v, digits = 2) { return Number.isFinite(v) ? `${v > 0 ? '+' : ''}${Number(v).toFixed(digits)}%` : '—'; }
function fmtUtcTime(timestamp, seconds = false) {
  if (!Number.isFinite(timestamp)) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone:'UTC', hour:'2-digit', minute:'2-digit', ...(seconds ? { second:'2-digit' } : {}), hour12:false }).format(new Date(timestamp));
}
function fmtUtcDate(timestamp = Date.now()) {
  return new Intl.DateTimeFormat('en-US', { timeZone:'UTC', weekday:'long', month:'short', day:'2-digit', year:'numeric' }).format(new Date(timestamp)) + ' UTC';
}
function closeOf(row) { return Number(row?.[4]); }
function openOf(row) { return Number(row?.[1]); }
function utcOpenTime(row) { return Number(row?.[0]); }
function getMarketList() { return state.markets; }
function getSelectedMarket() { return state.marketData.get(state.selected) || null; }
function getSelectedScore() { return state.scores.get(state.selected) || null; }

function renderClock() {
  $('utc-clock').textContent = fmtUtcTime(Date.now(), true);
  $('utc-date').textContent = fmtUtcDate(Date.now());
  // Signals expire from the visible view at 00:00 UTC, without needing a reload.
  const before = state.memory.signals.length;
  state.memory.signals = todaySignals(state.memory);
  if (state.memory.signals.length !== before) saveMemory(state.memory);
  renderSignals();
}

function renderConnection() {
  const label = $('connection-label'), dot = $('connection-dot');
  const futuresState = state.futuresFundingStatus === 'loading' || state.futuresOIStatus === 'loading'
    ? 'Futures loading'
    : state.futuresFundingStatus === 'unavailable' && state.futuresOIStatus === 'unavailable'
      ? 'Futures unavailable'
      : state.futuresFundingStatus === 'connected' && state.futuresOIStatus === 'connected'
        ? 'Futures connected' : 'Futures partial';
  if (state.streamStatus === 'connected') {
    label.textContent = `Spot live · ${futuresState}`; dot.className = 'source-dot';
  } else if (state.streamStatus === 'reconnecting') {
    label.textContent = `Spot reconnecting · ${futuresState}`; dot.className = 'source-dot amber';
  } else if (state.streamStatus === 'loading') {
    label.textContent = 'Loading spot history'; dot.className = 'source-dot amber';
  } else {
    label.textContent = `Spot offline · ${futuresState}`; dot.className = 'source-dot red';
  }
}

function renderWatchlist() {
  const host = $('watchlist');
  const rows = getMarketList();
  const readyCount = rows.filter(m => state.marketData.get(m.binance)?.ready).length;
  $('watchlist-coverage').textContent = `${readyCount} / ${rows.length}`;
  host.innerHTML = '';
  for (const m of rows) {
    const md = state.marketData.get(m.binance);
    const score = state.scores.get(m.binance);
    const price = md?.livePrice;
    const rows1h = md?.candles?.['1h'] || [];
    const pct24 = rows1h.length >= 25 ? (closeOf(rows1h.at(-1)) - closeOf(rows1h.at(-25))) / closeOf(rows1h.at(-25)) * 100 : null;
    const button = document.createElement('button');
    button.className = `watch-row ${state.selected === m.binance ? 'active' : ''} ${m.supported ? '' : 'unsupported'}`;
    button.dataset.symbol = m.binance;
    button.title = m.supported ? `${m.symbol}/USDT${md?.ready ? '' : ' · Waiting for history'}` : `${m.symbol}/USDT is not available as a Binance Spot USDT pair`;
    const coinIcon = document.createElement('span');
    coinIcon.className = `coin-icon ${COIN_CLASSES[m.symbol] || ''}`;
    coinIcon.textContent = COIN_LETTERS[m.symbol] || m.symbol.slice(0,1);
    const name = document.createElement('span'); name.className = 'coin-name';
    name.innerHTML = `<strong>${m.symbol}</strong><small>${m.symbol}/USDT · T${m.tier}</small>`;
    const values = document.createElement('span'); values.className = 'watch-values';
    const scoreText = score && score.total != null ? `${score.displayScore.toFixed(1)} / 100` : (md?.ready ? '—' : '—');
    const pctClass = pct24 > 0 ? 'positive' : pct24 < 0 ? 'negative' : 'neutral-text';
    values.innerHTML = `<strong>${fmtPrice(price)}</strong><small class="${pctClass}">${pct24 == null ? (m.supported ? 'Loading…' : 'Not listed') : fmtPct(pct24)}</small>`;
    if (!m.supported) { name.querySelector('small').textContent = 'Spot pair unavailable'; }
    button.append(coinIcon, name, values);
    host.append(button);
  }
}

function getChartCandles(market) {
  if (!market) return [];
  const closed = market.candles?.[state.timeframe] || [];
  const forming = market.forming?.[state.timeframe];
  const view = closed.slice(-90);
  if (forming) view.push(forming);
  return view;
}

function drawChart() {
  const canvas = $('price-chart'), context = canvas.getContext('2d');
  const market = getSelectedMarket();
  if (!market || !market.ready) {
    $('chart-empty').classList.remove('hidden');
    context.clearRect(0,0,canvas.width,canvas.height);
    return;
  }
  const candles = getChartCandles(market);
  if (!candles.length) { $('chart-empty').classList.remove('hidden'); return; }
  $('chart-empty').classList.add('hidden');
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(rect.width*ratio));
  canvas.height = Math.max(1, Math.floor(rect.height*ratio));
  context.setTransform(ratio,0,0,ratio,0,0);
  const W=rect.width,H=rect.height, pad={l:12,r:73,t:12,b:23};
  context.clearRect(0,0,W,H);
  const plotW=W-pad.l-pad.r, plotH=H-pad.t-pad.b;
  const highs=candles.map(r=>Number(r[2])).filter(Number.isFinite), lows=candles.map(r=>Number(r[3])).filter(Number.isFinite);
  let max=Math.max(...highs), min=Math.min(...lows);
  if (!Number.isFinite(max)||!Number.isFinite(min)||max===min) return;
  const gap=(max-min)*0.08; max+=gap; min-=gap;
  const y=value=>pad.t+(max-value)/(max-min)*plotH;
  const xstep=plotW/candles.length, candleW=Math.max(2,Math.min(8,xstep*.54));
  context.font='9px "DM Mono", monospace'; context.textBaseline='middle';
  for(let i=0;i<5;i++){
    const val=min+(max-min)*i/4, yy=y(val);
    context.beginPath();context.strokeStyle='#1f2b38';context.lineWidth=1;context.moveTo(pad.l,yy);context.lineTo(W-pad.r+5,yy);context.stroke();
    context.fillStyle='#768698';context.textAlign='left';context.fillText(fmtPrice(val),W-pad.r+10,yy);
  }
  // Subtle bottom volume band from the visible candles.
  const volumes=candles.map(r=>Number(r[5])||0), vmax=Math.max(1,...volumes);
  for(let i=0;i<candles.length;i++){
    const row=candles[i], o=Number(row[1]), h=Number(row[2]), l=Number(row[3]), c=Number(row[4]);
    if (![o,h,l,c].every(Number.isFinite)) continue;
    const xx=pad.l+i*xstep+xstep/2, rising=c>=o, color=rising?'#4fe0b3':'#ff647c';
    context.strokeStyle=color;context.lineWidth=1;context.beginPath();context.moveTo(xx,y(h));context.lineTo(xx,y(l));context.stroke();
    context.fillStyle=color;const top=Math.min(y(o),y(c)), bodyH=Math.max(1,y(o)>y(c)?y(o)-y(c):y(c)-y(o));context.fillRect(xx-candleW/2,top,candleW,bodyH);
    const vh=(volumes[i]/vmax)*Math.min(30,plotH*.15);context.globalAlpha=.19;context.fillRect(xx-candleW/2,H-pad.b-vh,candleW,vh);context.globalAlpha=1;
  }
  const last=candles.at(-1), lastClose=Number(last[4]), ly=y(lastClose);
  context.setLineDash([3,3]);context.strokeStyle='#597d83';context.beginPath();context.moveTo(pad.l,ly);context.lineTo(W-pad.r+4,ly);context.stroke();context.setLineDash([]);
  context.fillStyle='#183e37';context.fillRect(W-pad.r+5,ly-9,pad.r-8,18);context.fillStyle='#7df0c8';context.textAlign='left';context.fillText(fmtPrice(lastClose),W-pad.r+10,ly);
  const labels=[candles[0],candles[Math.floor(candles.length/2)],candles.at(-1)];
  const indices=[0,Math.floor(candles.length/2),candles.length-1];context.fillStyle='#6f8090';context.textAlign='center';
  for(let j=0;j<labels.length;j++){
    const ts=Number(labels[j][0]);const d=new Date(ts);const label=state.timeframe==='4h'?`${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:00`:`${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
    context.fillText(label,pad.l+indices[j]*xstep+xstep/2,H-10);
  }
  const pair=market.symbol.replace('USDT','');
  $('chart-title').innerHTML='';
  const title=document.createElement('span');title.textContent=`${pair} / USDT `;
  const tag=document.createElement('span');tag.textContent='Spot';
  $('chart-title').append(title,tag);
  $('chart-last-close').textContent=`Last close ${fmtPrice(closeOf(market.candles[state.timeframe]?.at(-1)))}`;
  const lastTime=Number(candles.at(-1)?.[6]||candles.at(-1)?.[0]);
  $('chart-period').textContent=`${candles.length} candles · latest ${fmtUtcTime(lastTime) } UTC`;
}

function indicatorDetails(score) {
  const d=score, i=d.ind;
  const layerByKey=new Map((d.layerStatuses||[]).map(x=>[x.key,x]));
  const rows=[];
  const add=(key,label,detail,status,confirmation=false,contextOnly=false)=>rows.push({key,label,detail,status:confirmation?'confirm':(status||layerByKey.get(key)?.status||'neutral'),confirmation,contextOnly});
  add('ema200','EMA 200 · 4H',i.ema200!=null?`${fmtPrice(i.ema200)} · price ${i.aboveE200?'above':'below'}`:'Not enough history');
  add('supertrend','Supertrend · 10 / 2.5',i.supertrend!=null?`${i.supertrendDirection===1?'Uptrend':'Downtrend'} · ${fmtPrice(i.supertrend)}`:'Unavailable');
  add('macd4h','MACD histogram · 4H',i.macdHist4h!=null?`${i.macdGrowing?'Rising 2 bars':i.macdShrinking?'Falling 2 bars':'No confirmed slope'} · ${i.macdHist4h}`:'Unavailable');
  add('structure','Market structure · 4H',i.structure||'Unavailable');
  add('adx','ADX · 14',i.adx!=null?`${i.adx} · ${i.adxTrending?'trend strength confirmed':'not above 25'}`:'Unavailable','confirm',true);
  add('rsiExtreme','RSI · 14 / 1H',i.rsi1h!=null?`${i.rsi1h} · ${i.rsiOS?'oversold':i.rsiOB?'overbought':'inside range'}`:'Unavailable');
  add('rsiDiv','RSI divergence · 1H',i.rsiDiv||'Unavailable');
  add('bb','Bollinger squeeze / touch',i.bbUpper!=null?`${i.bbSqueeze?'Squeeze':'No squeeze'} · ${i.bbSqueezeBounceL?'lower touch':i.bbSqueezeBounceS?'upper touch':i.bbBreakoutL?'upper breakout':i.bbBreakoutS?'lower breakout':'no scoring touch'}`:'Unavailable');
  add('pattern','Candlestick pattern · 1H',i.pattern||'Unavailable');
  add('sr','4H support / resistance',`${i.nearSup?'Near support':i.nearRes?'Near resistance':'Not near level'} · 0.8% threshold`);
  add('volSurge','Volume surge · 1H',i.volRatio!=null?`${i.volRatio}× baseline · ${i.volSurge?(i.lastGreen?'green candle':i.lastRed?'red candle':'doji'):'below 1.8×'}`:'Unavailable');
  add('macd1h','MACD histogram · 1H',i.macd1hGrowing?'Rising 2 bars':i.macd1hShrinking?'Falling 2 bars':'No confirmed slope');
  add('stoch','Stochastic RSI · 1H',i.stochK!=null?`K ${i.stochK} / D ${i.stochD} · ${i.stochCrossUp?'bullish cross':i.stochCrossDown?'bearish cross':'no scoring cross'}`:'Unavailable');
  add('atr','ATR expansion · 4H',i.atr!=null?`${fmtPrice(i.atr)} · ${i.atrExp?'expanding 3 bars':'not expanding 3 bars'}`:'Unavailable','confirm',true);
  add('vwap','VWAP deviation · 1H',i.vwapDev!=null?`${i.vwapDev>0?'+':''}${i.vwapDev}% · ${i.vwapLong?'above +0.3%':i.vwapShort?'below −0.3%':'within ±0.3%'}`:'Unavailable');
  add('tbm','Three-bar momentum · 15m',i.tbmBullish?'Break above prior 3 highs':i.tbmBearish?'Break below prior 3 lows':'No confirmed break');
  add('rsi7','RSI 7 cross · 15m',i.rsi7CrossUp?'Crossed up through 30':i.rsi7CrossDown?'Crossed down through 70':'No scoring cross');
  add('body','Strong candle body · 15m',i.bodyRatio!=null?`${Math.round(i.bodyRatio*100)}% body/range · ${i.strongBullCandle?'strong bullish':i.strongBearCandle?'strong bearish':'below 70% threshold'}`:'Unavailable');
  add('ccd','Consecutive candles · 15m',`Bull ${i.bullStreak||0} · Bear ${i.bearStreak||0} · trigger at 3`);
  add('funding','USDⓈ-M Futures funding rate',i.fundingRate!=null?`${(i.fundingRate*100).toFixed(4)}% · latest settled rate${i.funding24h!=null?` · last 3 sum ${(i.funding24h*100).toFixed(4)}%`:''} · votes below −0.0100% LONG / above +0.0100% SHORT`:'Unavailable · futures funding endpoint or contract unavailable');
  let oiDetail='Unavailable';
  if(i.openInterest!=null){
    const oiSize=Number(i.openInterest).toLocaleString('en-US',{maximumFractionDigits:2});
    if(i.oiIncreasing===true) oiDetail=`${oiSize} OI units · +${Number(i.oiChangePct).toFixed(2)}% vs prior sample · rising with 4H spot close · +0.5 confirmation`;
    else if(i.oiIncreasing===false) oiDetail=`${oiSize} OI units · +${Number(i.oiChangePct).toFixed(2)}% vs prior sample · 4H spot close fell · no score bonus`;
    else if(i.oiStatus==='baseline-set'||i.oiStatus==='baseline-reset') oiDetail=`${oiSize} OI units · baseline set; waiting for the next 15-minute comparison`;
    else if(i.oiStatus==='waiting-next-sample') oiDetail=`${oiSize} OI units · waiting for a ≥14-minute comparison window`;
    else if(i.oiChangePct!=null) oiDetail=`${oiSize} OI units · ${Number(i.oiChangePct)>0?'+':''}${Number(i.oiChangePct).toFixed(2)}% · no bonus (requires OI rise >1% and rising 4H spot close)`;
    else oiDetail=`${oiSize} OI units · comparison pending`;
  }
  add('oi','USDⓈ-M Futures open interest',oiDetail,'confirm',true);
  add('spotVolume','Spot volume strength · context only',i.volStrengthPct!=null?`${i.volStrengthPct}% of previous baseline · informational only; does not change score`:'Unavailable','neutral',false,true);
  rows.push({key:'orderbook',label:'Spot order-book imbalance · context only',detail:i.bookImbalancePct!=null?`${i.bookImbalancePct>0?'+':''}${i.bookImbalancePct.toFixed(1)}% bid/ask quantity imbalance · informational only; does not change score`:'Waiting for Spot WebSocket',status:'neutral',confirmation:false,contextOnly:true});
  return rows;
}

function renderIndicatorList(score) {
  const host=$('indicator-list');
  if (!score?.ind) { host.innerHTML='<div class="empty-panel">Waiting for enough closed candles.</div>'; return; }
  host.innerHTML='';
  for (const row of indicatorDetails(score)) {
    const node=document.createElement('div');node.className='indicator-row';
    const status=row.status;
    const badgeLabel=row.contextOnly?'INFO':row.confirmation?'CONFIRM':status==='bullish'?'BULLISH':status==='bearish'?'BEARISH':status==='unavailable'?'N/A':'NEUTRAL';
    node.innerHTML=`<span class="indicator-status ${status}"></span><div class="indicator-text"><span class="indicator-name"></span><span class="indicator-detail"></span></div><span class="indicator-badge ${status}">${badgeLabel}</span>`;
    node.querySelector('.indicator-name').textContent=row.label;
    node.querySelector('.indicator-detail').textContent=row.detail;
    host.append(node);
  }
}

function renderLayerScores(score) {
  const host=$('layer-score-grid');
  if (!score?.layerScores) { host.innerHTML='<div class="empty-panel">Indicator layer results appear after enough candle history loads.</div>'; return; }
  host.innerHTML='';
  for(let i=1;i<=5;i++){
    const s=score.layerScores[i];
    const card=document.createElement('div');card.className='layer-card';
    const b=s.bullishPct??0, r=s.bearishPct??0;
    card.innerHTML=`<div class="layer-card-head"><div><div class="layer-card-title"></div><span class="layer-card-sub"></span></div><span class="layer-index">L${i}</span></div><div class="layer-pcts"><span class="bull">BULL ${s.bullishPct==null?'—':`${s.bullishPct.toFixed(0)}%`}</span><span class="bear">BEAR ${s.bearishPct==null?'—':`${s.bearishPct.toFixed(0)}%`}</span></div><div class="layer-track"><div class="bull-fill" style="width:${Math.max(0,Math.min(100,b))}%"></div><div class="bear-fill" style="width:${Math.max(0,Math.min(100,r))}%"></div></div><div class="layer-statline"><span class="neutral-count">Neutral —</span><strong>${s.total?`${s.total} indicators`:'No data'}</strong></div>`;
    card.querySelector('.layer-card-title').textContent=layerLabels[i];
    card.querySelector('.layer-card-sub').textContent=LAYER_DESCRIPTIONS[i];
    card.querySelector('.neutral-count').textContent=`${s.bullish} bullish · ${s.bearish} bearish · ${s.neutral} neutral`;
    host.append(card);
  }
}

function renderScorePanel(score) {
  const chosen=score;
  if (!chosen?.ind) {
    $('dial-score').textContent='—'; $('selected-score').textContent='—'; $('selected-score-label').textContent='Data not ready';
    $('long-score').textContent='—'; $('short-score').textContent='—'; $('score-dial').style.setProperty('--dial','0deg');
    $('long-meter').style.width='0%'; $('short-meter').style.width='0%';
    $('signal-result').className='signal-result neutral';
    $('signal-result').innerHTML='<span class="result-icon">◌</span><div><strong>NO ACTIVE SIGNAL</strong><small>Waiting for enough closed spot candles.</small></div>';
    $('gate-checks').querySelectorAll('.gate-check b').forEach(e=>{e.className='gate-wait';e.textContent='—'});
    $('selected-bias').textContent='NEUTRAL';$('selected-bias').className='bias-value';$('selected-layers').textContent='—';$('selected-gate').textContent='Gate not evaluated';
    $('strength-tier').textContent='—';$('confidence').textContent='—';$('gate-route').textContent='—';$('disagreement').textContent='—';
    $('target-reference').textContent='—';$('target-entry').textContent='—';$('target-stop').textContent='—';$('target-tp1').textContent='—';$('target-tp2').textContent='—';$('target-rr').textContent='—';
    $('context-rs').textContent='—';$('context-btcd').textContent='—';$('context-shock').textContent='—';$('context-book').textContent='—';$('context-futures').textContent='—';
    renderLayerScores(null);renderIndicatorList(null);return;
  }
  const display=chosen.displayScore||0;
  $('dial-score').textContent=display.toFixed(1);$('selected-score').textContent=display.toFixed(1);
  $('selected-score-label').textContent=`Raw ${chosen.total.toFixed(1)} / ${SCORE_MAX.toFixed(1)} · ${chosen.passesGate?'all gates pass':'gate not passed'}`;
  $('score-dial').style.setProperty('--dial',`${Math.max(0,Math.min(100,display))*3.6}deg`);
  $('long-score').textContent=chosen.longDisplayScore.toFixed(1);$('short-score').textContent=chosen.shortDisplayScore.toFixed(1);
  $('long-meter').style.width=`${Math.max(0,Math.min(100,chosen.longDisplayScore))}%`;
  $('short-meter').style.width=`${Math.max(0,Math.min(100,chosen.shortDisplayScore))}%`;
  const bias=$('selected-bias');
  bias.textContent=chosen.passesGate?chosen.direction:(chosen.direction==='LONG'?'LONG BIAS':'SHORT BIAS');
  bias.className=`bias-value ${chosen.passesGate?chosen.direction.toLowerCase():''}`;
  $('selected-regime').textContent=`Regime ${chosen.regime||'UNCERTAIN'}`;
  $('selected-layers').textContent=String(chosen.layersHit);
  $('selected-gate').textContent=chosen.passesGate?'All signal gates pass':'At least one signal gate failed';
  const result=$('signal-result');
  if (chosen.passesGate) {
    const cls=chosen.direction.toLowerCase();result.className=`signal-result ${cls}`;
    result.innerHTML=`<span class="result-icon">${chosen.direction==='LONG'?'↗':'↘'}</span><div><strong>${chosen.direction} SETUP · GATES PASSED</strong><small>${chosen.route.toUpperCase()} route · Tier ${chosen.strength.replace('Tier ','')} · ${chosen.confidence}% workflow confidence</small></div>`;
  } else {
    result.className='signal-result neutral';
    result.innerHTML=`<span class="result-icon">◌</span><div><strong>NO NEW SIGNAL</strong><small>Directional bias: ${chosen.direction} · ${chosen.gateChecks.score?'score ok':'score below gate'}; ${chosen.layersHit}/5 layers participate.</small></div>`;
  }
  const gateValues=[chosen.gateChecks.score,chosen.gateChecks.route,chosen.gateChecks.layers,chosen.gateChecks.disagreement];
  $('gate-checks').querySelectorAll('.gate-check b').forEach((e,i)=>{e.className=gateValues[i]?'pass':'fail';e.textContent=gateValues[i]?'PASS':'FAIL'});
  $('strength-tier').textContent=chosen.strength;$('confidence').textContent=`${chosen.confidence}%`;
  $('gate-route').textContent=chosen.route.toUpperCase();$('disagreement').textContent=String(chosen.disagreementCount);
  $('target-reference').textContent=fmtPrice(chosen.price);
  const target=chosen.targets||{};
  $('target-entry').textContent=target.entryL!=null&&target.entryH!=null?`${fmtPrice(target.entryL)} – ${fmtPrice(target.entryH)}`:'—';
  $('target-stop').textContent=fmtPrice(chosen.direction==='LONG'?target.slLong:target.slShort);
  $('target-tp1').textContent=fmtPrice(chosen.direction==='LONG'?target.t1Long:target.t1Short);
  $('target-tp2').textContent=fmtPrice(chosen.direction==='LONG'?target.t2Long:target.t2Short);
  $('target-rr').textContent=(chosen.direction==='LONG'?target.rrLong:target.rrShort)!=null?`${(chosen.direction==='LONG'?target.rrLong:target.rrShort).toFixed(2)} R`:'—';
  $('context-rs').textContent=chosen.rsBtc12h!=null?fmtPct(chosen.rsBtc12h,3):'—';
  $('context-btcd').textContent=chosen.btcdNow!=null?`${chosen.btcdNow.toFixed(2)}% (${fmtPct(chosen.btcdChg,2)})`:'Unavailable';
  $('context-shock').textContent=chosen.btcShock?'ACTIVE':chosen.btcChange2h==null?'—':'Clear';
  $('context-shock').className=chosen.btcShock?'negative':'';
  $('context-book').textContent=chosen.ind.bookImbalancePct!=null?fmtPct(chosen.ind.bookImbalancePct,1):'—';
  const fundingText=chosen.ind.fundingRate!=null?`Funding ${(chosen.ind.fundingRate*100).toFixed(4)}%`:'Funding N/A';
  const oiText=chosen.ind.oiIncreasing===true?`OI +${Number(chosen.ind.oiChangePct).toFixed(2)}% confirm`:chosen.ind.oiIncreasing===false?'OI rise; 4H down':chosen.ind.oiStatus==='baseline-set'||chosen.ind.oiStatus==='baseline-reset'?'OI baseline':chosen.ind.openInterest!=null?'OI comparison pending':'OI N/A';
  $('context-futures').textContent=`${fundingText} · ${oiText}`;
  renderLayerScores(chosen);renderIndicatorList(chosen);
}

function renderSelectedAsset() {
  const market=getSelectedMarket(), meta=getMarketList().find(m=>m.binance===state.selected);
  $('selected-asset-name').textContent=`${(meta?.symbol||state.selected.replace('USDT',''))} / USDT`;
  $('selected-asset-icon').textContent=COIN_LETTERS[meta?.symbol]||meta?.symbol?.slice(0,1)||'₿';
  $('selected-asset-icon').className=`coin-icon ${COIN_CLASSES[meta?.symbol]||''}`;
  $('selected-price').textContent=market?.livePrice!=null?fmtPrice(market.livePrice):'—';
  const rows1h=market?.candles?.['1h']||[];
  const pct24=rows1h.length>=25?(closeOf(rows1h.at(-1))-closeOf(rows1h.at(-25)))/closeOf(rows1h.at(-25))*100:null;
  $('selected-change').textContent=pct24==null?'Change 24h —':`Change 24h ${fmtPct(pct24)}`;
  $('selected-change').className=`stat-foot ${pct24>0?'positive':pct24<0?'negative':'neutral-text'}`;
  $('selected-asset-type').textContent=market?.ready?'BINANCE SPOT · LIVE':market?.supported===false?'SPOT PAIR NOT LISTED':'LOADING SPOT DATA';
  $('chart-title').textContent=`${meta?.symbol||'BTC'} / USDT Spot`;
  renderScorePanel(getSelectedScore());drawChart();renderWatchlist();
}

function renderSignals() {
  const signals=todaySignals(state.memory);
  $('today-signal-count').textContent=String(signals.length);
  $('signal-count-badge').textContent=String(signals.length);
  const host=$('signals-table-body');host.innerHTML='';
  if (!signals.length) {
    const row=document.createElement('tr');row.innerHTML='<td colspan="8" class="table-empty">No signal has passed all gates today. The table resets at 00:00 UTC.</td>';host.append(row);return;
  }
  for(const s of signals){
    const row=document.createElement('tr');row.dataset.symbol=s.binance;
    row.innerHTML=`<td class="table-time">${fmtUtcTime(s.timestamp)}</td><td class="table-pair"><span class="coin-icon ${COIN_CLASSES[s.symbol]||''}">${COIN_LETTERS[s.symbol]||s.symbol.slice(0,1)}</span><span>${s.symbol}/USDT</span></td><td><span class="signal-chip ${s.direction.toLowerCase()}">${s.direction==='LONG'?'↗':'↘'} ${s.direction}</span></td><td class="table-score">${Number(s.score100).toFixed(1)} / 100</td><td><span class="tier-chip">${s.strength.replace('Tier ','Tier ')}</span></td><td>${s.confidence}%</td><td>${String(s.gateRoute).toUpperCase()}</td><td class="table-price">${fmtPrice(s.price)}</td>`;
    host.append(row);
  }
}

function renderEverything() {
  renderConnection();renderSelectedAsset();renderSignals();
  $('last-update').textContent=`Updated ${fmtUtcTime(Date.now(),true)} UTC · market data streamed`;
}

function calculateBtcContext() {
  const btc=state.marketData.get('BTCUSDT');
  const closes=btc?.candles?.['1h']?.map(closeOf).filter(Number.isFinite)||[];
  let btcChange2h=null;
  if(closes.length>=3&&closes.at(-3)>0) btcChange2h=(closes.at(-1)-closes.at(-3))/closes.at(-3)*100;
  return { btcCloses1h:closes, btcChange2h, btcdNow:state.btcDominanceNow, btcdChg:state.btcDominanceChange };
}

async function scanAll(reason='periodic') {
  if(state.scanning || !state.marketData.size) return;
  state.scanning=true;
  try{
    const context=calculateBtcContext();
    const newScores=new Map();
    for(const meta of state.markets){
      const md=state.marketData.get(meta.binance);
      if(!md?.ready) continue;
      const analysis=calculateIndicators(md.candles['15m'],md.candles['1h'],md.candles['4h'],{
        symbol:meta.symbol,binance:meta.binance,tier:meta.tier,livePrice:md.livePrice,bookImbalancePct:md.bookImbalancePct,
        fundingRate:md.fundingRate,funding24h:md.funding24h,openInterest:md.openInterest,
        oiChangePct:md.oiChangePct,oiIncreasing:md.oiIncreasing,oiStatus:md.oiStatus,
      },context);
      state.analyses.set(meta.binance,analysis);
      const scored=scoreSignal(analysis);
      newScores.set(meta.binance,scored);
      if(scored.passesGate){
        const accepted=attemptSignalAcceptance(state.memory,scored,Date.now());
        if(accepted.accepted){
          saveMemory(state.memory);
          showToast(`${accepted.signal.symbol} ${accepted.signal.direction} signal · ${accepted.signal.score100.toFixed(1)}/100 · ${accepted.signal.strength}`, 'success');
          dispatchTelegramAlert(accepted.signal);
        }
      }
    }
    state.scores=newScores;
    saveMemory(state.memory);
    state.lastRecalculation=Date.now();
    if(reason==='closed-candle') showToast('Closed candle received. Indicators and gates recalculated.');
    renderEverything();
  }catch(err){
    console.error('[Aminoid Spot] scan failure',err);
    showToast(`Indicator scan issue: ${err?.message||err}`,'warn');
  }finally{state.scanning=false;}
}

async function dispatchTelegramAlert(signal){
  try{
    const response=await fetch('/api/telegram',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      symbol:signal.symbol, direction:signal.direction, score:signal.score100, tier:signal.strength,
      confidence:signal.confidence, route:signal.gateRoute, price:signal.price, stop:signal.targets.stop,
      tp1:signal.targets.tp1,tp2:signal.targets.tp2,timestamp:signal.timestamp, source:'Aminoid Spot',
    })});
    if(response.status===404){
      if(!state.telegramNoticeShown){showToast('Dashboard signal generated. Telegram alert is not configured on this deployment yet.','warn');state.telegramNoticeShown=true;}
      return;
    }
    if(!response.ok){
      const body=await response.json().catch(()=>({}));
      if(!state.telegramNoticeShown){showToast(body.error||'Dashboard signal generated, but Telegram delivery is not configured.','warn');state.telegramNoticeShown=true;}
    }
  }catch{
    // Local static preview has no serverless Telegram endpoint. Dashboard
    // and local signal memory remain fully functional without it.
    if(!state.telegramNoticeShown){showToast('Telegram endpoint unavailable here; the signal is saved in this browser.','warn');state.telegramNoticeShown=true;}
  }
}

function handleKline(update){
  const md=state.marketData.get(update.symbol);
  if(!md?.ready)return;
  const interval=update.interval;
  md.livePrice=update.livePrice;
  md.lastUpdate=Date.now();
  if(!md.forming)md.forming={};
  if(!md.candles[interval])md.candles[interval]=[];
  if(update.closed){
    const rows=md.candles[interval];
    const idx=rows.findIndex(r=>Number(r[0])===Number(update.candle[0]));
    if(idx>=0)rows[idx]=update.candle;
    else rows.push(update.candle);
    const maxLen=interval==='4h'?260:180;
    if(rows.length>maxLen)rows.splice(0,rows.length-maxLen);
    md.forming[interval]=null;
    if(interval==='1h'&&update.symbol==='BTCUSDT') { /* BTC context recalculated below */ }
    if (state.closedScanTimer) clearTimeout(state.closedScanTimer);
    state.closedScanTimer = setTimeout(()=>{state.closedScanTimer=null;scanAll('closed-candle');},450);
  }else{
    md.forming[interval]=update.candle;
  }
}

function handleBook(update){
  const md=state.marketData.get(update.symbol);
  if(!md?.ready)return;
  md.bookImbalancePct=update.imbalancePct;
  md.bookUpdatedAt=Date.now();
}

function applyFundingSnapshot(snapshot) {
  let available=0, total=0;
  for (const meta of state.markets) {
    const md=state.marketData.get(meta.binance);
    if(!md) continue;
    total++;
    const result=snapshot.get(meta.binance);
    md.fundingRate=result?.fundingRate??null;
    md.funding24h=result?.funding24h??null;
    md.fundingTime=result?.fundingTime??null;
    md.fundingError=result?.error??null;
    if(md.fundingRate!=null)available++;
  }
  state.lastFuturesFundingFetch=Date.now();
  state.futuresFundingStatus=available===0?'unavailable':available===total?'connected':'partial';
}

function applyOpenInterestSnapshot(snapshot) {
  const now=Date.now();
  let available=0, total=0;
  state.memory.oiSamples=state.memory.oiSamples||{};
  for (const meta of state.markets) {
    const md=state.marketData.get(meta.binance);
    if(!md) continue;
    total++;
    const result=snapshot.get(meta.binance);
    const current=Number(result?.openInterest);
    const valid=Number.isFinite(current)&&current>0;
    md.openInterest=valid?current:null;
    md.oiChangePct=null;
    md.oiIncreasing=null;
    md.oiStatus='unavailable';
    md.openInterestError=result?.error??null;
    if(!valid) continue;
    available++;
    const candles=md.candles?.['4h']||[];
    const priceRising=candles.length>=2&&closeOf(candles.at(-1))>closeOf(candles.at(-2));
    const comparison=evaluateOpenInterestSample(current,state.memory.oiSamples[meta.binance],priceRising,now);
    md.oiChangePct=comparison.changePct;
    md.oiIncreasing=comparison.oiIncreasing;
    md.oiStatus=comparison.status;
    if(comparison.nextSample)state.memory.oiSamples[meta.binance]=comparison.nextSample;
    else delete state.memory.oiSamples[meta.binance];
  }
  state.lastFuturesOIFetch=Date.now();
  state.futuresOIStatus=available===0?'unavailable':available===total?'connected':'partial';
  saveMemory(state.memory);
}

async function refreshFuturesFunding(force=false) {
  if(state.loading)return;
  const now=Date.now();
  if(!force&&now-state.lastFuturesFundingFetch<5*60_000)return;
  try{
    const result=await loadFuturesFunding(state.markets);
    applyFundingSnapshot(result);
    if(state.marketData.size)await scanAll('futures-funding');
  }catch(err){
    state.futuresFundingStatus='unavailable';
    console.warn('[Aminoid Spot] futures funding refresh failed',err);
  }
}

async function refreshFuturesOpenInterest(force=false) {
  if(state.loading)return;
  const now=Date.now();
  if(!force&&now-state.lastFuturesOIFetch<15*60_000)return;
  try{
    const result=await loadFuturesOpenInterest(state.markets);
    applyOpenInterestSnapshot(result);
    if(state.marketData.size)await scanAll('futures-open-interest');
  }catch(err){
    state.futuresOIStatus='unavailable';
    console.warn('[Aminoid Spot] futures open-interest refresh failed',err);
  }
}

async function refreshDominance(force=false){
  const now=Date.now();
  if(!force&&now-state.lastBtcDominanceFetch<5*60_000)return;
  state.lastBtcDominanceFetch=now;
  try{
    const value=await fetchBtcDominance();
    const result=addBtcDominanceReading(state.memory,value,now);
    state.btcDominanceNow=result.btcdNow;state.btcDominanceChange=result.btcdChg;state.dominanceAvailable=true;
    saveMemory(state.memory);
  }catch(err){
    state.dominanceAvailable=false;state.btcDominanceNow=null;state.btcDominanceChange=null;
    if(!state.toastShown.has('dominance')){
      showToast('BTC-dominance context is unavailable; that optional veto is disabled. Binance Spot price data continues normally.','warn');
      state.toastShown.add('dominance');
    }
  }
}

async function loadEverything(reload=false){
  if(state.loading)return;
  state.loading=true;
  $('refresh-button').disabled=true;
  state.stream?.close();state.stream=null;
  state.streamStatus='loading';renderConnection();
  try{
    let exchangeSymbols;
    try{exchangeSymbols=await getSpotExchangeInfo();}
    catch(err){
      console.warn('[Aminoid Spot] exchangeInfo unavailable; probing the configured pairs directly',err);
      exchangeSymbols=new Map(state.markets.map(m=>[m.binance,{symbol:m.binance,quoteAsset:'USDT',status:'UNKNOWN'}]));
      showToast('Could not verify the full Spot symbol list. Testing configured pairs directly.','warn');
    }
    state.exchangeSymbols=exchangeSymbols;
    state.markets=DEFAULT_WATCHLIST.map(m=>({...m,supported:exchangeSymbols.has(m.binance)}));
    renderWatchlist();
    const completed=await loadSpotHistory(state.markets,progress=>{
      $('last-update').textContent=`Loading spot candles ${progress.done}/${progress.total} · ${progress.symbol}`;
    });
    state.marketData=completed;
    // Spot REST/WebSocket drives candles and Layers 1–4. Futures endpoints are
    // a separate optional feed for Layer 5 funding and OI confirmation only.
    for(const meta of state.markets){
      const md=state.marketData.get(meta.binance);
      if(md?.ready){
        md.bookImbalancePct=null;md.fundingRate=null;md.funding24h=null;md.openInterest=null;
        md.oiChangePct=null;md.oiIncreasing=null;md.oiStatus='unavailable';
      }
    }
    const [fundingSnapshot,oiSnapshot]=await Promise.all([
      loadFuturesFunding(state.markets,progress=>{$('last-update').textContent=`Loading futures funding ${progress.done}/${progress.total} · ${progress.symbol}`;}),
      loadFuturesOpenInterest(state.markets,progress=>{$('last-update').textContent=`Loading open interest ${progress.done}/${progress.total} · ${progress.symbol}`;}),
    ]);
    applyFundingSnapshot(fundingSnapshot);
    applyOpenInterestSnapshot(oiSnapshot);
    await refreshDominance(true);
    state.stream=connectSpotStreams(state.markets,{
      onStatus:(status,detail)=>{state.streamStatus=status;renderConnection();if(detail)console.warn('[Aminoid Spot] stream:',detail);},
      onKline:handleKline,
      onBook:handleBook,
    });
    state.streamStatus='connecting';renderConnection();
    await scanAll('initial-load');
    renderEverything();
    const unsupported=state.markets.filter(m=>!m.supported).map(m=>m.symbol);
    if(unsupported.length){
      const id='unsupported';
      if(!state.toastShown.has(id)){
        showToast(`Not listed as Binance Spot USDT pairs: ${unsupported.join(', ')}. These stay visible in the watchlist but cannot be scored.`, 'warn');
        state.toastShown.add(id);
      }
    }
    if(reload)showToast('Spot market history refreshed. Browser-local cooldown memory was retained.','success');
  }catch(err){
    console.error('[Aminoid Spot] initial load error',err);
    state.streamStatus='offline';renderConnection();
    showToast(`Could not load Binance Spot data: ${err?.message||err}. Check the network and try refresh.`, 'warn');
  }finally{
    state.loading=false;$('refresh-button').disabled=false;
  }
}

function bindUi(){
  $('watchlist').addEventListener('click',event=>{
    const btn=event.target.closest('[data-symbol]');if(!btn)return;
    state.selected=btn.dataset.symbol;
    renderSelectedAsset();
  });
  $('signals-table-body').addEventListener('click',event=>{
    const row=event.target.closest('tr[data-symbol]');if(!row)return;
    state.selected=row.dataset.symbol;renderSelectedAsset();window.scrollTo({top:0,behavior:'smooth'});
  });
  $('timeframe-control').addEventListener('click',event=>{
    const btn=event.target.closest('button[data-timeframe]');if(!btn)return;
    state.timeframe=btn.dataset.timeframe;
    $('timeframe-control').querySelectorAll('button').forEach(b=>b.classList.toggle('selected',b===btn));
    drawChart();
  });
  $('refresh-button').addEventListener('click',()=>loadEverything(true));
  document.querySelectorAll('.side-nav .nav-item').forEach(a=>a.addEventListener('click',()=>{
    document.querySelectorAll('.side-nav .nav-item').forEach(n=>n.classList.remove('active'));a.classList.add('active');
  }));
  window.addEventListener('resize',()=>drawChart());
  window.addEventListener('online',()=>{if(state.streamStatus!=='connected')loadEverything(true);});
  window.addEventListener('beforeunload',()=>state.stream?.close());
}

function initialize(){
  bindUi();renderClock();renderWatchlist();renderSignals();
  setInterval(renderClock,1000);
  // WebSocket market updates are event driven; this 30-second pass recalculates
  // if top-of-book and dominance context have changed between candle closes.
  setInterval(()=>scanAll('periodic'),30_000);
  setInterval(()=>refreshDominance(false),60_000);
  setInterval(()=>refreshFuturesFunding(false),5*60_000);
  setInterval(()=>refreshFuturesOpenInterest(false),15*60_000);
  setInterval(()=>{renderWatchlist();renderSelectedAsset();},1800);
  loadEverything(false);
}

initialize();
