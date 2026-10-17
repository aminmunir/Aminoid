import test from 'node:test';
import assert from 'node:assert/strict';
import { ema, calculateSupertrend, calculateIndicators, scoreSignal, SCORE_MAX, DEFAULT_WATCHLIST } from '../src/engine.js';
import { attemptSignalAcceptance, loadMemory, todaySignals, utcDayStart } from '../src/memory.js';
import { evaluateOpenInterestSample, OI_COMPARE_MIN_MS, OI_COMPARE_MAX_MS } from '../src/microstructure.js';

function makeCandles(count, intervalMs, slope = 0.1, startPrice = 100, baseTime = Date.now()) {
  const rows=[];
  for(let i=0;i<count;i++){
    const c=startPrice+i*slope;
    const o=c-slope*0.3;
    const h=Math.max(o,c)+Math.abs(slope)*0.9+0.2;
    const l=Math.min(o,c)-Math.abs(slope)*0.9-0.2;
    const openTime=baseTime-(count-i)*intervalMs;
    rows.push([openTime,String(o),String(h),String(l),String(c),String(1000+(i%9)*10),openTime+intervalMs-1,'1',10,'500','0.5','0']);
  }
  return rows;
}

function readyScored(timestamp, price=100) {
  return {
    passesGate:true, symbol:'BTC', binance:'BTCUSDT', direction:'LONG', price,
    targets:{entryL:price*.99,entryH:price*1.01,slLong:price*.97,t1Long:price*1.04,t2Long:price*1.08,rrLong:1.2,t1Pct:4},
    strength:'Tier A',total:5.5,displayScore:47.8,longDisplayScore:52,shortDisplayScore:17,
    confidence:72,route:'trend',layersHit:4,disagreementCount:1,regime:'TRENDING',winningHits:['ema200'],warnings:[],
  };
}

test('EMA 200 produces an output only when 200 values exist',()=>{
  assert.equal(ema(Array.from({length:199},(_,i)=>i+1),200).length,0);
  const output=ema(Array.from({length:200},(_,i)=>i+1),200);
  assert.equal(output.length,200);
  assert.ok(Number.isFinite(output.at(-1)));
});

test('Supertrend returns a direction using ATR 10 and multiplier 2.5',()=>{
  const rising=makeCandles(100,4*3600000,.7,100);
  const falling=makeCandles(100,4*3600000,-.7,200);
  const up=calculateSupertrend(rising,10,2.5), down=calculateSupertrend(falling,10,2.5);
  assert.equal(up.direction,1);
  assert.equal(down.direction,-1);
  assert.ok(Number.isFinite(up.value));
});

test('full indicator calculation returns the new EMA/Supertrend and normalized score',()=>{
  const now=Date.now();
  const c15=makeCandles(180,15*60000,.03,100,now);
  const c1=makeCandles(180,3600000,.15,100,now);
  const c4=makeCandles(260,4*3600000,.6,100,now);
  const context={btcCloses1h:c1.map(r=>Number(r[4])),btcChange2h:1,btcdNow:56,btcdChg:0.1};
  const data=calculateIndicators(c15,c1,c4,{symbol:'BTC',binance:'BTCUSDT',tier:1,livePrice:Number(c15.at(-1)[4]),bookImbalancePct:20,fundingRate:-0.0002,funding24h:-0.0003,openInterest:12345,oiChangePct:1.4,oiIncreasing:true,oiStatus:'confirm'},context);
  assert.equal(data.error,undefined);
  assert.ok(Number.isFinite(data.ind.ema200));
  assert.ok([1,-1].includes(data.ind.supertrendDirection));
  assert.equal(data.ind.bookImbalancePct,20);
  assert.equal(data.ind.fundBullish,true);
  assert.equal(data.ind.fundBearish,false);
  assert.equal(data.ind.oiIncreasing,true);
  const score=scoreSignal(data);
  assert.ok(Number.isFinite(score.displayScore));
  assert.ok(score.displayScore>=0 && score.displayScore<=100);
  assert.ok(Math.abs(score.displayScore-(score.total/SCORE_MAX*100))<0.11);
  assert.equal(score.layerScores[5].total,1);
  assert.ok(score.longHits.includes('funding'));
  assert.ok(score.confirmationHits.includes('oi'));
  assert.ok(!score.longHits.includes('orderbook') && !score.shortHits.includes('orderbook')); 
});

test('cooldown suppresses the same direction for one hour, then applies price movement floor',()=>{
  const memory={version:1,cooldowns:{},sentCycles:{},signals:[],btcDominanceHistory:[],updatedAt:0};
  const t=Date.now()-Date.now()%900000;
  const first=attemptSignalAcceptance(memory,readyScored(t,100),t+1000);
  assert.equal(first.accepted,true);
  const soon=attemptSignalAcceptance(memory,readyScored(t+1000,105),t+20*60000);
  assert.equal(soon.accepted,false);
  assert.equal(soon.reason,'cooldown_1h');
  const laterSame=attemptSignalAcceptance(memory,readyScored(t+1000,100.5),t+90*60000);
  assert.equal(laterSame.accepted,false);
  assert.equal(laterSame.reason,'price_has_not_moved_enough');
  const laterMoved=attemptSignalAcceptance(memory,readyScored(t+1000,103),t+120*60000);
  assert.equal(laterMoved.accepted,true);
});

test('Signals table only exposes records from current UTC calendar day',()=>{
  const now=Date.now();
  const start=utcDayStart(now);
  const memory={version:1,cooldowns:{},sentCycles:{},signals:[
    {id:'old',timestamp:start-1},{id:'today',timestamp:start+10},{id:'future',timestamp:now+3600000},
  ],btcDominanceHistory:[],updatedAt:now};
  const records=todaySignals(memory,now);
  assert.deepEqual(records.map(s=>s.id),['today']);
});

test('watchlist stays crypto-only and has 15 configured tokens',()=>{
  assert.equal(DEFAULT_WATCHLIST.length,15);
  assert.ok(DEFAULT_WATCHLIST.every(m=>m.binance.endsWith('USDT')));
});


test('funding rate preserves original direction thresholds and missing values stay unavailable',()=>{
  const now=Date.now();
  const c15=makeCandles(180,15*60000,.03,100,now);
  const c1=makeCandles(180,3600000,.15,100,now);
  const c4=makeCandles(260,4*3600000,.6,100,now);
  const context={btcCloses1h:c1.map(r=>Number(r[4])),btcChange2h:1,btcdNow:56,btcdChg:0.1};
  const down=calculateIndicators(c15,c1,c4,{symbol:'BTC',binance:'BTCUSDT',tier:1,fundingRate:0.0002},context);
  assert.equal(down.ind.fundBearish,true);
  assert.equal(down.ind.fundBullish,false);
  const threshold=calculateIndicators(c15,c1,c4,{symbol:'BTC',binance:'BTCUSDT',tier:1,fundingRate:0.0001},context);
  assert.equal(threshold.ind.fundBullish,false);
  assert.equal(threshold.ind.fundBearish,false);
  const missing=calculateIndicators(c15,c1,c4,{symbol:'BTC',binance:'BTCUSDT',tier:1,fundingRate:null},context);
  assert.equal(missing.ind.fundingRate,null);
  assert.equal(missing.layerStatuses.find(x=>x.key==='funding').status,'unavailable');
});

test('open-interest confirmation needs >1% increase, rising 4H spot close, and comparable samples',()=>{
  const now=2_000_000_000_000;
  const prior={value:1000,time:now-15*60_000};
  const bullish=evaluateOpenInterestSample(1020,prior,true,now);
  assert.equal(bullish.oiIncreasing,true);
  assert.equal(bullish.status,'confirm');
  assert.equal(bullish.changePct,2);
  const notBullish=evaluateOpenInterestSample(1020,prior,false,now);
  assert.equal(notBullish.oiIncreasing,false);
  assert.equal(notBullish.status,'rising-against-spot');
  const below=evaluateOpenInterestSample(1005,prior,true,now);
  assert.equal(below.oiIncreasing,null);
  assert.equal(below.status,'below-threshold');
  const tooSoon=evaluateOpenInterestSample(1020,{value:1000,time:now-OI_COMPARE_MIN_MS+1000},true,now);
  assert.equal(tooSoon.status,'waiting-next-sample');
  assert.equal(tooSoon.nextSample.time,now-OI_COMPARE_MIN_MS+1000);
  const stale=evaluateOpenInterestSample(1020,{value:1000,time:now-OI_COMPARE_MAX_MS-1000},true,now);
  assert.equal(stale.status,'baseline-reset');
  assert.equal(stale.oiIncreasing,null);
});

test('browser-local memory has a place for open-interest baselines without a database',()=>{
  assert.deepEqual(loadMemory().oiSamples,{});
});
