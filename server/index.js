/**
 * MakeMyAlgo.in — Backend Server
 * Primary: Twelve Data API (800 free calls/day)
 * Fallback: Realistic demo data (always works)
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const TWELVE_DATA_KEY = process.env.TWELVE_DATA_KEY || 'fa3df679647f489a823db3a65f84a2f9';
const TWELVE_BASE = 'https://api.twelvedata.com';

// ─── Stock Prices (realistic base prices for demo) ─────────────────

const STOCK_PRICES = {
  'RELIANCE': 2450, 'TCS': 3800, 'HDFCBANK': 1650, 'INFY': 1550, 'ICICIBANK': 1100,
  'HINDUNILVR': 2350, 'ITC': 430, 'SBIN': 780, 'BHARTIARTL': 1620, 'KOTAKBANK': 1780,
  'LT': 3400, 'AXISBANK': 1050, 'ASIANPAINT': 2250, 'MARUTI': 11500, 'TITAN': 3200,
  'SUNPHARMA': 1750, 'BAJFINANCE': 6800, 'WIPRO': 480, 'ULTRACEMCO': 10200, 'NESTLEIND': 2300,
  'TATAMOTORS': 720, 'POWERGRID': 290, 'NTPC': 340, 'HCLTECH': 1650, 'TECHM': 1550,
  'ONGC': 240, 'TATASTEEL': 135, 'JSWSTEEL': 870, 'ADANIENT': 2400, 'BAJAJFINSV': 1580,
  'DRREDDY': 1200, 'CIPLA': 1450, 'EICHERMOT': 4600, 'DIVISLAB': 3800, 'APOLLOHOSP': 6200,
  'BRITANNIA': 5100, 'COALINDIA': 380, 'GRASIM': 2500, 'HEROMOTOCO': 4200, 'HINDALCO': 580,
  'INDUSINDBK': 960, 'M&M': 2700, 'SBILIFE': 1400, 'TATACONSUM': 950, 'LTIM': 5200,
  'BAJAJ-AUTO': 8500, 'BPCL': 290, 'HDFCLIFE': 620, 'SHRIRAMFIN': 2600, 'NIFTY50': 22500,
};

// ─── Twelve Data API Fetcher ────────────────────────────────────────

async function fetchFromTwelveData(endpoint, params) {
  const url = new URL(`${TWELVE_BASE}${endpoint}`);
  params.apikey = TWELVE_DATA_KEY;
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  
  const res = await fetch(url.toString());
  const data = await res.json();
  
  if (data.status === 'error' || data.code) {
    throw new Error(data.message || 'Twelve Data API error');
  }
  return data;
}

async function fetchStockData(symbol, interval = '1day', range = '1y') {
  const nseSymbol = symbol.includes(':') ? symbol : `${symbol}:NSE`;
  
  // Map range to outputsize
  const sizeMap = { '1mo': 30, '3mo': 90, '6mo': 180, '1y': 365, '2y': 730, '5y': 500 };
  const outputsize = sizeMap[range] || 365;
  
  // Map interval
  const intervalMap = { '1d': '1day', '1day': '1day', '1h': '1h', '15m': '15min', '5m': '5min' };
  const apiInterval = intervalMap[interval] || '1day';
  
  try {
    const data = await fetchFromTwelveData('/time_series', {
      symbol: nseSymbol,
      interval: apiInterval,
      outputsize: Math.min(outputsize, 500),
      format: 'JSON',
    });

    if (!data.values || data.values.length === 0) {
      throw new Error('No data from Twelve Data');
    }

    const candles = data.values
      .reverse()
      .filter(v => v.open && v.high && v.low && v.close)
      .map(v => ({
        date: new Date(v.datetime).toISOString(),
        open: +parseFloat(v.open).toFixed(2),
        high: +parseFloat(v.high).toFixed(2),
        low: +parseFloat(v.low).toFixed(2),
        close: +parseFloat(v.close).toFixed(2),
        volume: parseInt(v.volume) || 0,
      }));

    const last = candles[candles.length - 1];
    const first = candles[candles.length - 2];
    
    return {
      symbol, interval, range, candles,
      source: 'twelvedata',
      meta: {
        name: data.meta?.symbol || symbol,
        exchange: 'NSE',
        currency: 'INR',
        regularMarketPrice: last?.close,
        previousClose: first?.close,
      }
    };
  } catch (err) {
    console.log(`Twelve Data failed for ${symbol}: ${err.message}. Using demo data.`);
    return generateDemoData(symbol, interval, range);
  }
}

// ─── Demo Data Generator (Fallback) ────────────────────────────────

function generateDemoData(symbol, interval = '1day', range = '1y') {
  const basePrice = STOCK_PRICES[symbol] || 1500;
  const sizeMap = { '1mo': 22, '3mo': 65, '6mo': 130, '1y': 250, '2y': 500, '5y': 500 };
  const days = sizeMap[range] || 250;
  
  const candles = [];
  let price = basePrice * (0.85 + Math.random() * 0.3);
  const volatility = basePrice * 0.015;
  const trend = (Math.random() - 0.45) * 0.002;
  
  const now = Date.now();
  
  for (let i = days; i >= 0; i--) {
    const dayTrend = trend + (Math.random() - 0.5) * 0.003;
    const open = price;
    const change = price * dayTrend + (Math.random() - 0.5) * volatility * 2;
    const intraVol = volatility * (0.5 + Math.random());
    const high = Math.max(open, open + change) + Math.random() * intraVol;
    const low = Math.min(open, open + change) - Math.random() * intraVol;
    const close = open + change;
    const volume = Math.floor((Math.random() * 8000000 + 2000000) * (basePrice / 1000));

    candles.push({
      date: new Date(now - i * 86400000).toISOString(),
      open: +Math.max(open, 1).toFixed(2),
      high: +Math.max(high, 1).toFixed(2),
      low: +Math.max(low, 1).toFixed(2),
      close: +Math.max(close, 1).toFixed(2),
      volume,
    });
    price = Math.max(close, basePrice * 0.3);
  }

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  return {
    symbol, interval, range, candles,
    source: 'demo',
    meta: {
      name: symbol,
      exchange: 'NSE',
      currency: 'INR',
      regularMarketPrice: last?.close,
      previousClose: prev?.close,
    }
  };
}

// ─── Technical Indicators ───────────────────────────────────────────

function computeSMA(closes, period) {
  const r = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { r.push(null); continue; }
    r.push(+(closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period).toFixed(2));
  }
  return r;
}

function computeEMA(closes, period) {
  const r = []; const k = 2 / (period + 1); let ema = null;
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { r.push(null); continue; }
    if (ema === null) ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    else ema = closes[i] * k + ema * (1 - k);
    r.push(+ema.toFixed(2));
  }
  return r;
}

function computeRSI(closes, period = 14) {
  const r = []; let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { r.push(null); continue; }
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (i <= period) {
      avgGain += gain; avgLoss += loss;
      if (i < period) { r.push(null); continue; }
      avgGain /= period; avgLoss /= period;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    r.push(+(100 - 100 / (1 + rs)).toFixed(2));
  }
  return r;
}

function computeMACD(closes, fast = 12, slow = 26, signal = 9) {
  const ef = computeEMA(closes, fast);
  const es = computeEMA(closes, slow);
  const ml = ef.map((f, i) => (f != null && es[i] != null) ? +(f - es[i]).toFixed(2) : null);
  const sl = []; const k = 2 / (signal + 1); let ema = null; let vi = 0;
  for (let i = 0; i < ml.length; i++) {
    if (ml[i] === null) { sl.push(null); continue; }
    vi++;
    if (vi < signal) { sl.push(null); continue; }
    if (ema === null) { const si = ml.indexOf(ml.find(v => v !== null)); ema = ml.slice(si, si + signal).reduce((a, b) => a + b, 0) / signal; }
    else ema = ml[i] * k + ema * (1 - k);
    sl.push(+ema.toFixed(2));
  }
  return { macdLine: ml, signalLine: sl, histogram: ml.map((m, i) => (m != null && sl[i] != null) ? +(m - sl[i]).toFixed(2) : null) };
}

function computeBollingerBands(closes, period = 20, stdDev = 2) {
  const sma = computeSMA(closes, period);
  const upper = [], lower = [];
  for (let i = 0; i < closes.length; i++) {
    if (sma[i] === null) { upper.push(null); lower.push(null); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    const sd = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - sma[i], 2), 0) / period) * stdDev;
    upper.push(+(sma[i] + sd).toFixed(2));
    lower.push(+(sma[i] - sd).toFixed(2));
  }
  return { upper, middle: sma, lower };
}

function computeATR(candles, period = 14) {
  const r = []; const trs = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { trs.push(candles[i].high - candles[i].low); r.push(null); continue; }
    const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
    trs.push(tr);
    if (i < period) { r.push(null); continue; }
    if (i === period) r.push(+(trs.slice(0, period + 1).reduce((a, b) => a + b, 0) / (period + 1)).toFixed(2));
    else r.push(+((r[r.length - 1] * (period - 1) + tr) / period).toFixed(2));
  }
  return r;
}

function computeSuperTrend(candles, period = 10, multiplier = 3) {
  const atr = computeATR(candles, period);
  const r = []; let pST = null, pUB = null, pLB = null, pC = null, trend = 1;
  for (let i = 0; i < candles.length; i++) {
    if (atr[i] === null) { r.push({ value: null, trend: 1 }); continue; }
    const hl2 = (candles[i].high + candles[i].low) / 2;
    let ub = hl2 + multiplier * atr[i], lb = hl2 - multiplier * atr[i];
    if (pLB !== null) { lb = lb > pLB || pC < pLB ? lb : pLB; ub = ub < pUB || pC > pUB ? ub : pUB; }
    if (pST === null) trend = 1;
    else if (pST === pUB) trend = candles[i].close > ub ? 1 : -1;
    else trend = candles[i].close < lb ? -1 : 1;
    const st = trend === 1 ? lb : ub;
    r.push({ value: +st.toFixed(2), trend });
    pST = st; pUB = ub; pLB = lb; pC = candles[i].close;
  }
  return r;
}

function computeVWAP(candles) {
  let cvp = 0, cv = 0;
  return candles.map(c => { const t = (c.high + c.low + c.close) / 3; cvp += t * c.volume; cv += c.volume; return cv > 0 ? +(cvp / cv).toFixed(2) : null; });
}

function computeIndicator(candles, indicator, params) {
  const closes = candles.map(c => c.close);
  switch (indicator) {
    case 'sma': return { values: computeSMA(closes, parseInt(params.Period) || 20), type: 'line' };
    case 'ema': return { values: computeEMA(closes, parseInt(params.Period) || 20), type: 'line' };
    case 'rsi': return { values: computeRSI(closes, parseInt(params.Period) || 14), type: 'oscillator' };
    case 'macd': { const m = computeMACD(closes, parseInt(params.Fast) || 12, parseInt(params.Slow) || 26, parseInt(params.Signal) || 9); return { values: m.macdLine, signal: m.signalLine, histogram: m.histogram, type: 'oscillator' }; }
    case 'bb': { const b = computeBollingerBands(closes, parseInt(params.Period) || 20, parseFloat(params.StdDev) || 2); return { upper: b.upper, middle: b.middle, lower: b.lower, type: 'band' }; }
    case 'supertrend': { const s = computeSuperTrend(candles, parseInt(params.Period) || 10, parseFloat(params.Multiplier) || 3); return { values: s.map(x => x.value), trends: s.map(x => x.trend), type: 'line' }; }
    case 'vwap': return { values: computeVWAP(candles), type: 'line' };
    case 'atr': return { values: computeATR(candles, parseInt(params.Period) || 14), type: 'oscillator' };
    default: return { values: [], type: 'line' };
  }
}

// ─── Backtesting Engine ─────────────────────────────────────────────

function runBacktest(candles, buyRules, sellRules, config = {}) {
  const { initialCapital = 100000, positionSize = 0.1, stopLossPercent = 2, targetPercent = 4 } = config;
  const cache = {};
  [...buyRules, ...sellRules].forEach(rule => {
    const key = `${rule.indicator}_${JSON.stringify(rule.params)}`;
    if (!cache[key]) cache[key] = computeIndicator(candles, rule.indicator, rule.params || {});
  });

  function getVal(rule, idx) {
    const d = cache[`${rule.indicator}_${JSON.stringify(rule.params)}`];
    if (!d) return null;
    return d.type === 'band' ? d.middle[idx] : (d.values ? d.values[idx] : null);
  }

  function check(rule, idx) {
    const cur = getVal(rule, idx), prev = idx > 0 ? getVal(rule, idx - 1) : null, tgt = parseFloat(rule.value);
    if (cur === null) return false;
    switch (rule.condition) {
      case 'Crosses Above': return prev !== null && prev <= tgt && cur > tgt;
      case 'Crosses Below': return prev !== null && prev >= tgt && cur < tgt;
      case 'Is Above': return cur > tgt;
      case 'Is Below': return cur < tgt;
      case 'Equals': return Math.abs(cur - tgt) < 0.01;
      default: return false;
    }
  }

  const trades = []; let capital = initialCapital, pos = null;
  const eq = [{ index: 0, date: candles[0]?.date, equity: capital }];

  for (let i = 50; i < candles.length; i++) {
    const c = candles[i];
    if (pos) {
      const pp = ((c.close - pos.ep) / pos.ep) * 100;
      let exit = null;
      if (pp <= -stopLossPercent) exit = 'Stop Loss';
      else if (pp >= targetPercent) exit = 'Target Hit';
      else if (sellRules.length > 0 && sellRules.every(r => check(r, i))) exit = 'Signal Exit';
      if (exit) {
        const pnl = (c.close - pos.ep) * pos.qty;
        capital += pnl;
        trades.push({ id: trades.length + 1, type: 'BUY', entryPrice: pos.ep, exitPrice: c.close, entryDate: pos.ed, exitDate: c.date, qty: pos.qty, pnl: +pnl.toFixed(0), pnlPercent: +pp.toFixed(2), exitReason: exit });
        pos = null;
      }
    } else if (buyRules.length > 0 && buyRules.every(r => check(r, i))) {
      const qty = Math.floor((capital * positionSize) / c.close);
      if (qty > 0) pos = { ep: c.close, ed: c.date, qty, ei: i };
    }
    const unr = pos ? (candles[i].close - pos.ep) * pos.qty : 0;
    eq.push({ index: i, date: c.date, equity: +(capital + unr).toFixed(0) });
  }

  if (pos && candles.length > 0) {
    const l = candles[candles.length - 1];
    const pnl = (l.close - pos.ep) * pos.qty;
    capital += pnl;
    trades.push({ id: trades.length + 1, type: 'BUY', entryPrice: pos.ep, exitPrice: l.close, entryDate: pos.ed, exitDate: l.date, qty: pos.qty, pnl: +pnl.toFixed(0), pnlPercent: +(((l.close - pos.ep) / pos.ep) * 100).toFixed(2), exitReason: 'End of Data' });
  }

  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
  const eqV = eq.map(e => e.equity);
  let maxDD = 0, pk = eqV[0];
  for (const e of eqV) { if (e > pk) pk = e; const d = ((pk - e) / pk) * 100; if (d > maxDD) maxDD = d; }
  const rets = []; for (let i = 1; i < eqV.length; i++) rets.push((eqV[i] - eqV[i - 1]) / eqV[i - 1]);
  const avgR = rets.length > 0 ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const stdR = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + Math.pow(r - avgR, 2), 0) / (rets.length - 1)) : 0;
  const sharpe = stdR > 0 ? (avgR / stdR) * Math.sqrt(252) : 0;
  const pf = Math.abs(losses.reduce((s, t) => s + t.pnl, 0)) > 0 ? Math.abs(wins.reduce((s, t) => s + t.pnl, 0) / losses.reduce((s, t) => s + t.pnl, 0)) : wins.length > 0 ? 999 : 0;

  return {
    trades: trades.slice(-100), equityCurve: eq,
    stats: {
      totalTrades: trades.length, winningTrades: wins.length, losingTrades: losses.length,
      winRate: trades.length > 0 ? +((wins.length / trades.length) * 100).toFixed(1) : 0,
      totalPnL: +totalPnL.toFixed(0), netReturn: +(((capital - initialCapital) / initialCapital) * 100).toFixed(2),
      maxDrawdown: +maxDD.toFixed(2), sharpeRatio: +sharpe.toFixed(2),
      avgWin: +(wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0).toFixed(0),
      avgLoss: +(losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0).toFixed(0),
      profitFactor: +pf.toFixed(2), initialCapital, finalCapital: +capital.toFixed(0),
    },
  };
}

// ─── Live Scanner ───────────────────────────────────────────────────

async function scanLiveSignals(stocks, rules) {
  const signals = [];
  for (const symbol of stocks) {
    try {
      const data = await fetchStockData(symbol, '1day', '3mo');
      if (!data.candles || data.candles.length < 50) continue;
      const candles = data.candles;
      const li = candles.length - 1;
      const allMet = rules.every(rule => {
        const ind = computeIndicator(candles, rule.indicator, rule.params || {});
        const cur = ind.values ? ind.values[li] : null;
        const prev = ind.values && li > 0 ? ind.values[li - 1] : null;
        const tgt = parseFloat(rule.value);
        if (cur === null) return false;
        switch (rule.condition) {
          case 'Crosses Above': return prev !== null && prev <= tgt && cur > tgt;
          case 'Crosses Below': return prev !== null && prev >= tgt && cur < tgt;
          case 'Is Above': return cur > tgt;
          case 'Is Below': return cur < tgt;
          default: return false;
        }
      });
      if (allMet) {
        const last = candles[li];
        const atr = computeATR(candles, 14);
        const av = atr[li] || last.close * 0.02;
        signals.push({
          symbol, name: data.meta?.name || symbol, price: last.close,
          signal: rules[0]?.condition?.includes('Above') ? 'BUY' : 'SELL',
          target: +(last.close + av * 2).toFixed(2), stopLoss: +(last.close - av).toFixed(2),
          confidence: Math.min(95, Math.floor(60 + Math.random() * 30)),
          time: new Date(last.date).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
          indicator: rules[0]?.indicator?.toUpperCase() || 'CUSTOM',
          change: data.meta?.previousClose ? +(((last.close - data.meta.previousClose) / data.meta.previousClose) * 100).toFixed(2) : 0,
          source: data.source,
        });
      }
    } catch (err) { console.log(`Scan skip ${symbol}: ${err.message}`); }
  }
  return signals;
}

// ─── API Routes ─────────────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({ status: 'ok', engine: 'Twelve Data + Demo Fallback', timestamp: new Date().toISOString() }));

app.get('/api/stock/:symbol', async (req, res) => {
  try {
    const data = await fetchStockData(req.params.symbol, req.query.interval || '1day', req.query.range || '1y');
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/backtest', async (req, res) => {
  try {
    const { symbol, buyRules = [], sellRules = [], config = {}, interval = '1day', range = '1y' } = req.body;
    const data = await fetchStockData(symbol, interval, range);
    const result = runBacktest(data.candles, buyRules, sellRules, config);
    result.symbol = symbol;
    result.meta = data.meta;
    result.source = data.source;
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/scan', async (req, res) => {
  try {
    const stockList = req.body.stocks || [
      'RELIANCE','TCS','HDFCBANK','INFY','ICICIBANK','HINDUNILVR','ITC','SBIN',
      'BHARTIARTL','KOTAKBANK','LT','AXISBANK','MARUTI','TITAN','SUNPHARMA',
      'BAJFINANCE','WIPRO','HCLTECH','TATAMOTORS','NTPC',
    ];
    const signals = await scanLiveSignals(stockList, req.body.rules || []);
    res.json({ signals, scannedCount: stockList.length, timestamp: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const sym = req.params.symbol;
    const nseSymbol = sym.includes(':') ? sym : `${sym}:NSE`;
    const data = await fetchFromTwelveData('/quote', { symbol: nseSymbol });
    res.json({
      symbol: sym, price: parseFloat(data.close), change: parseFloat(data.change),
      changePercent: parseFloat(data.percent_change), high: parseFloat(data.high),
      low: parseFloat(data.low), open: parseFloat(data.open),
      previousClose: parseFloat(data.previous_close), volume: parseInt(data.volume),
      name: data.name || sym,
    });
  } catch (err) {
    // Fallback quote
    const bp = STOCK_PRICES[req.params.symbol] || 1500;
    const change = (Math.random() - 0.5) * bp * 0.03;
    res.json({
      symbol: req.params.symbol, price: +(bp + change).toFixed(2),
      change: +change.toFixed(2), changePercent: +((change / bp) * 100).toFixed(2),
      high: +(bp + Math.abs(change) + Math.random() * 20).toFixed(2),
      low: +(bp - Math.abs(change) - Math.random() * 20).toFixed(2),
      open: +(bp + (Math.random() - 0.5) * 10).toFixed(2),
      previousClose: +bp.toFixed(2), volume: Math.floor(Math.random() * 5000000 + 1000000),
      name: req.params.symbol, source: 'demo',
    });
  }
});

app.get('/api/nifty50', (req, res) => {
  res.json({ stocks: Object.keys(STOCK_PRICES).filter(s => s !== 'NIFTY50') });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ─── Start ──────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n⚡ MakeMyAlgo.in running on port ${PORT}`);
  console.log(`📊 Data: Twelve Data API + Demo Fallback`);
  console.log(`🔑 API Key: ${TWELVE_DATA_KEY ? 'Set' : 'Missing'}\n`);
});
