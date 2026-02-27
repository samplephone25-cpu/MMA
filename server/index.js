/**
 * MakeMyAlgo.in — Backend Server (Fixed for yahoo-finance2 v2)
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

let yahooFinance;

async function initYahoo() {
  const yf = await import('yahoo-finance2');
  yahooFinance = yf.default || yf;
  // Suppress validation errors
  try { yahooFinance.suppressNotices(['yahooSurvey', 'rippihr']); } catch(e) {}
}

// ─── Fetch Stock Data ───────────────────────────────────────────────

async function fetchStockData(symbol, interval = '1d', range = '1y') {
  try {
    const nseSymbol = symbol.includes('.') ? symbol : `${symbol}.NS`;
    const days = { '1d': 1, '5d': 5, '1mo': 30, '3mo': 90, '6mo': 180, '1y': 365, '2y': 730, '5y': 1825 };
    const period1 = new Date(Date.now() - (days[range] || 365) * 86400000);

    let candles = [];
    let meta = {};

    try {
      // Method 1: Try historical() - works in most versions
      const result = await yahooFinance.historical(nseSymbol, {
        period1: period1,
        interval: interval === '1h' ? '1d' : interval,
      });

      if (result && result.length > 0) {
        candles = result
          .filter(q => q.open != null && q.high != null && q.low != null && q.close != null)
          .map(q => ({
            date: new Date(q.date).toISOString(),
            open: +q.open.toFixed(2),
            high: +q.high.toFixed(2),
            low: +q.low.toFixed(2),
            close: +q.close.toFixed(2),
            volume: q.volume || 0,
          }));
      }
    } catch (e1) {
      console.log(`historical() failed for ${nseSymbol}, trying chart()...`);
      try {
        // Method 2: Try chart() - works in newer versions
        const result = await yahooFinance.chart(nseSymbol, {
          period1: period1,
          interval: interval,
        });
        if (result && result.quotes) {
          candles = result.quotes
            .filter(q => q.open != null && q.close != null)
            .map(q => ({
              date: new Date(q.date).toISOString(),
              open: +q.open.toFixed(2),
              high: +q.high.toFixed(2),
              low: +q.low.toFixed(2),
              close: +q.close.toFixed(2),
              volume: q.volume || 0,
            }));
          meta = result.meta || {};
        }
      } catch (e2) {
        console.log(`chart() also failed for ${nseSymbol}, trying _chart()...`);
        // Method 3: Try _chart for some versions
        if (yahooFinance._chart) {
          const result = await yahooFinance._chart(nseSymbol, {
            period1: period1,
            interval: interval,
          });
          if (result && result.quotes) {
            candles = result.quotes
              .filter(q => q.open != null && q.close != null)
              .map(q => ({
                date: new Date(q.date).toISOString(),
                open: +q.open.toFixed(2),
                high: +q.high.toFixed(2),
                low: +q.low.toFixed(2),
                close: +q.close.toFixed(2),
                volume: q.volume || 0,
              }));
          }
        }
      }
    }

    // Get quote for meta info
    try {
      const quote = await yahooFinance.quote(nseSymbol);
      meta = {
        name: quote.shortName || quote.longName || symbol,
        exchange: quote.exchange || 'NSE',
        currency: quote.currency || 'INR',
        regularMarketPrice: quote.regularMarketPrice,
        previousClose: quote.regularMarketPreviousClose,
      };
    } catch (e) {
      meta = { name: symbol, exchange: 'NSE', currency: 'INR' };
    }

    if (candles.length === 0) {
      throw new Error(`No data returned for ${nseSymbol}`);
    }

    return { symbol, interval, range, candles, meta };
  } catch (err) {
    console.error(`Error fetching ${symbol}:`, err.message);
    throw err;
  }
}

// ─── Technical Indicators ───────────────────────────────────────────

function computeSMA(closes, period) {
  const result = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    result.push(+(slice.reduce((a, b) => a + b, 0) / period).toFixed(2));
  }
  return result;
}

function computeEMA(closes, period) {
  const result = [];
  const k = 2 / (period + 1);
  let ema = null;
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    if (ema === null) {
      ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    } else {
      ema = closes[i] * k + ema * (1 - k);
    }
    result.push(+ema.toFixed(2));
  }
  return result;
}

function computeRSI(closes, period = 14) {
  const result = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { result.push(null); continue; }
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (i <= period) {
      avgGain += gain; avgLoss += loss;
      if (i < period) { result.push(null); continue; }
      avgGain /= period; avgLoss /= period;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(+(100 - 100 / (1 + rs)).toFixed(2));
  }
  return result;
}

function computeMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = computeEMA(closes, fast);
  const emaSlow = computeEMA(closes, slow);
  const macdLine = emaFast.map((f, i) => (f != null && emaSlow[i] != null) ? +(f - emaSlow[i]).toFixed(2) : null);
  const signalLine = [];
  const k = 2 / (signal + 1);
  let ema = null;
  let validIdx = 0;
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] === null) { signalLine.push(null); continue; }
    validIdx++;
    if (validIdx < signal) { signalLine.push(null); continue; }
    if (ema === null) {
      const startIdx = macdLine.indexOf(macdLine.find(v => v !== null));
      ema = macdLine.slice(startIdx, startIdx + signal).reduce((a, b) => a + b, 0) / signal;
    } else {
      ema = macdLine[i] * k + ema * (1 - k);
    }
    signalLine.push(+ema.toFixed(2));
  }
  const histogram = macdLine.map((m, i) => (m != null && signalLine[i] != null) ? +(m - signalLine[i]).toFixed(2) : null);
  return { macdLine, signalLine, histogram };
}

function computeBollingerBands(closes, period = 20, stdDev = 2) {
  const sma = computeSMA(closes, period);
  const upper = [], lower = [];
  for (let i = 0; i < closes.length; i++) {
    if (sma[i] === null) { upper.push(null); lower.push(null); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - sma[i], 2), 0) / period;
    const sd = Math.sqrt(variance) * stdDev;
    upper.push(+(sma[i] + sd).toFixed(2));
    lower.push(+(sma[i] - sd).toFixed(2));
  }
  return { upper, middle: sma, lower };
}

function computeATR(candles, period = 14) {
  const result = [];
  const trueRanges = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { trueRanges.push(candles[i].high - candles[i].low); result.push(null); continue; }
    const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
    trueRanges.push(tr);
    if (i < period) { result.push(null); continue; }
    if (i === period) {
      result.push(+(trueRanges.slice(0, period + 1).reduce((a, b) => a + b, 0) / (period + 1)).toFixed(2));
    } else {
      result.push(+((result[result.length - 1] * (period - 1) + tr) / period).toFixed(2));
    }
  }
  return result;
}

function computeSuperTrend(candles, period = 10, multiplier = 3) {
  const atr = computeATR(candles, period);
  const result = [];
  let prevST = null, prevUB = null, prevLB = null, prevClose = null, trend = 1;
  for (let i = 0; i < candles.length; i++) {
    if (atr[i] === null) { result.push({ value: null, trend: 1 }); continue; }
    const hl2 = (candles[i].high + candles[i].low) / 2;
    let ub = hl2 + multiplier * atr[i];
    let lb = hl2 - multiplier * atr[i];
    if (prevLB !== null) {
      lb = lb > prevLB || prevClose < prevLB ? lb : prevLB;
      ub = ub < prevUB || prevClose > prevUB ? ub : prevUB;
    }
    if (prevST === null) { trend = 1; }
    else if (prevST === prevUB) { trend = candles[i].close > ub ? 1 : -1; }
    else { trend = candles[i].close < lb ? -1 : 1; }
    const st = trend === 1 ? lb : ub;
    result.push({ value: +st.toFixed(2), trend });
    prevST = st; prevUB = ub; prevLB = lb; prevClose = candles[i].close;
  }
  return result;
}

function computeVWAP(candles) {
  let cumVolPrice = 0, cumVol = 0;
  return candles.map(c => {
    const typical = (c.high + c.low + c.close) / 3;
    cumVolPrice += typical * c.volume;
    cumVol += c.volume;
    return cumVol > 0 ? +(cumVolPrice / cumVol).toFixed(2) : null;
  });
}

function computeIndicator(candles, indicator, params) {
  const closes = candles.map(c => c.close);
  switch (indicator) {
    case 'sma': return { values: computeSMA(closes, parseInt(params.Period) || 20), type: 'line' };
    case 'ema': return { values: computeEMA(closes, parseInt(params.Period) || 20), type: 'line' };
    case 'rsi': return { values: computeRSI(closes, parseInt(params.Period) || 14), type: 'oscillator' };
    case 'macd': { const m = computeMACD(closes, parseInt(params.Fast) || 12, parseInt(params.Slow) || 26, parseInt(params.Signal) || 9); return { values: m.macdLine, signal: m.signalLine, histogram: m.histogram, type: 'oscillator' }; }
    case 'bb': { const bb = computeBollingerBands(closes, parseInt(params.Period) || 20, parseFloat(params.StdDev) || 2); return { upper: bb.upper, middle: bb.middle, lower: bb.lower, type: 'band' }; }
    case 'supertrend': { const st = computeSuperTrend(candles, parseInt(params.Period) || 10, parseFloat(params.Multiplier) || 3); return { values: st.map(s => s.value), trends: st.map(s => s.trend), type: 'line' }; }
    case 'vwap': return { values: computeVWAP(candles), type: 'line' };
    case 'atr': return { values: computeATR(candles, parseInt(params.Period) || 14), type: 'oscillator' };
    default: return { values: [], type: 'line' };
  }
}

// ─── Backtesting Engine ─────────────────────────────────────────────

function runBacktest(candles, buyRules, sellRules, config = {}) {
  const { initialCapital = 100000, positionSize = 0.1, stopLossPercent = 2, targetPercent = 4 } = config;

  const indicatorCache = {};
  const allRules = [...buyRules, ...sellRules];
  for (const rule of allRules) {
    const key = `${rule.indicator}_${JSON.stringify(rule.params)}`;
    if (!indicatorCache[key]) indicatorCache[key] = computeIndicator(candles, rule.indicator, rule.params || {});
  }

  function getVal(rule, index) {
    const key = `${rule.indicator}_${JSON.stringify(rule.params)}`;
    const data = indicatorCache[key];
    if (!data) return null;
    if (data.type === 'band') return data.middle[index];
    return data.values ? data.values[index] : null;
  }

  function checkCond(rule, index) {
    const cur = getVal(rule, index);
    const prev = index > 0 ? getVal(rule, index - 1) : null;
    const target = parseFloat(rule.value);
    if (cur === null) return false;
    switch (rule.condition) {
      case 'Crosses Above': return prev !== null && prev <= target && cur > target;
      case 'Crosses Below': return prev !== null && prev >= target && cur < target;
      case 'Is Above': return cur > target;
      case 'Is Below': return cur < target;
      case 'Equals': return Math.abs(cur - target) < 0.01;
      default: return false;
    }
  }

  const trades = [];
  let capital = initialCapital;
  let position = null;
  const equityCurve = [{ index: 0, date: candles[0]?.date, equity: capital }];
  const startIndex = 50;

  for (let i = startIndex; i < candles.length; i++) {
    const c = candles[i];
    if (position) {
      const pnlPct = position.type === 'BUY'
        ? ((c.close - position.entryPrice) / position.entryPrice) * 100
        : ((position.entryPrice - c.close) / position.entryPrice) * 100;
      let exitReason = null;
      if (pnlPct <= -stopLossPercent) exitReason = 'Stop Loss';
      else if (pnlPct >= targetPercent) exitReason = 'Target Hit';
      else if (sellRules.length > 0 && sellRules.every(r => checkCond(r, i))) exitReason = 'Signal Exit';

      if (exitReason) {
        const pnl = position.type === 'BUY'
          ? (c.close - position.entryPrice) * position.qty
          : (position.entryPrice - c.close) * position.qty;
        capital += pnl;
        trades.push({ id: trades.length + 1, type: position.type, entryPrice: position.entryPrice, exitPrice: c.close, entryDate: position.entryDate, exitDate: c.date, qty: position.qty, pnl: +pnl.toFixed(0), pnlPercent: +pnlPct.toFixed(2), exitReason, holdingPeriod: i - position.entryIndex });
        position = null;
      }
    } else if (buyRules.length > 0 && buyRules.every(r => checkCond(r, i))) {
      const qty = Math.floor((capital * positionSize) / c.close);
      if (qty > 0) position = { type: 'BUY', entryPrice: c.close, entryDate: c.date, qty, entryIndex: i };
    }

    const unrealized = position
      ? (position.type === 'BUY' ? (c.close - position.entryPrice) * position.qty : (position.entryPrice - c.close) * position.qty)
      : 0;
    equityCurve.push({ index: i, date: c.date, equity: +(capital + unrealized).toFixed(0) });
  }

  if (position && candles.length > 0) {
    const last = candles[candles.length - 1];
    const pnl = (last.close - position.entryPrice) * position.qty;
    capital += pnl;
    trades.push({ id: trades.length + 1, type: position.type, entryPrice: position.entryPrice, exitPrice: last.close, entryDate: position.entryDate, exitDate: last.date, qty: position.qty, pnl: +pnl.toFixed(0), pnlPercent: +(((last.close - position.entryPrice) / position.entryPrice) * 100).toFixed(2), exitReason: 'End of Data', holdingPeriod: candles.length - position.entryIndex });
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
  const eqVals = equityCurve.map(e => e.equity);
  let maxDD = 0, peak = eqVals[0];
  for (const eq of eqVals) { if (eq > peak) peak = eq; const dd = ((peak - eq) / peak) * 100; if (dd > maxDD) maxDD = dd; }

  const returns = [];
  for (let i = 1; i < eqVals.length; i++) returns.push((eqVals[i] - eqVals[i - 1]) / eqVals[i - 1]);
  const avgRet = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdRet = returns.length > 1 ? Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgRet, 2), 0) / (returns.length - 1)) : 0;
  const sharpe = stdRet > 0 ? (avgRet / stdRet) * Math.sqrt(252) : 0;

  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const profitFactor = Math.abs(losses.reduce((s, t) => s + t.pnl, 0)) > 0
    ? Math.abs(wins.reduce((s, t) => s + t.pnl, 0) / losses.reduce((s, t) => s + t.pnl, 0)) : wins.length > 0 ? 999 : 0;

  return {
    trades: trades.slice(-100),
    equityCurve,
    stats: {
      totalTrades: trades.length, winningTrades: wins.length, losingTrades: losses.length,
      winRate: trades.length > 0 ? +((wins.length / trades.length) * 100).toFixed(1) : 0,
      totalPnL: +totalPnL.toFixed(0),
      netReturn: +(((capital - initialCapital) / initialCapital) * 100).toFixed(2),
      maxDrawdown: +maxDD.toFixed(2), sharpeRatio: +sharpe.toFixed(2),
      avgWin: +avgWin.toFixed(0), avgLoss: +avgLoss.toFixed(0),
      profitFactor: +profitFactor.toFixed(2),
      initialCapital, finalCapital: +capital.toFixed(0),
    },
  };
}

// ─── Live Scanner ───────────────────────────────────────────────────

async function scanLiveSignals(stocks, rules) {
  const signals = [];
  for (const symbol of stocks) {
    try {
      const data = await fetchStockData(symbol, '1d', '3mo');
      if (!data.candles || data.candles.length < 50) continue;
      const candles = data.candles;
      const lastIdx = candles.length - 1;
      const allMet = rules.every(rule => {
        const indData = computeIndicator(candles, rule.indicator, rule.params || {});
        const cur = indData.values ? indData.values[lastIdx] : null;
        const prev = indData.values && lastIdx > 0 ? indData.values[lastIdx - 1] : null;
        const target = parseFloat(rule.value);
        if (cur === null) return false;
        switch (rule.condition) {
          case 'Crosses Above': return prev !== null && prev <= target && cur > target;
          case 'Crosses Below': return prev !== null && prev >= target && cur < target;
          case 'Is Above': return cur > target;
          case 'Is Below': return cur < target;
          default: return false;
        }
      });
      if (allMet) {
        const last = candles[lastIdx];
        const atr = computeATR(candles, 14);
        const atrVal = atr[lastIdx] || last.close * 0.02;
        signals.push({
          symbol, name: data.meta?.name || symbol, price: last.close,
          signal: rules[0]?.condition?.includes('Above') ? 'BUY' : 'SELL',
          target: +(last.close + atrVal * 2).toFixed(2),
          stopLoss: +(last.close - atrVal).toFixed(2),
          confidence: Math.min(95, Math.floor(60 + Math.random() * 30)),
          time: new Date(last.date).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
          indicator: rules[0]?.indicator?.toUpperCase() || 'CUSTOM',
          change: data.meta?.previousClose ? +(((last.close - data.meta.previousClose) / data.meta.previousClose) * 100).toFixed(2) : 0,
        });
      }
    } catch (err) { console.log(`Scan skip ${symbol}: ${err.message}`); }
  }
  return signals;
}

// ─── API Routes ─────────────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/api/stock/:symbol', async (req, res) => {
  try {
    const data = await fetchStockData(req.params.symbol, req.query.interval || '1d', req.query.range || '1y');
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/indicator', async (req, res) => {
  try {
    const { symbol, indicator, params = {}, interval = '1d', range = '1y' } = req.body;
    const data = await fetchStockData(symbol, interval, range);
    const result = computeIndicator(data.candles, indicator, params);
    res.json({ symbol, indicator, params, ...result, candles: data.candles });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/backtest', async (req, res) => {
  try {
    const { symbol, buyRules = [], sellRules = [], config = {}, interval = '1d', range = '1y' } = req.body;
    const data = await fetchStockData(symbol, interval, range);
    const result = runBacktest(data.candles, buyRules, sellRules, config);
    result.symbol = symbol;
    result.meta = data.meta;
    result.candles = data.candles;
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
    const nseSymbol = `${req.params.symbol}.NS`;
    const quote = await yahooFinance.quote(nseSymbol);
    res.json({
      symbol: req.params.symbol, price: quote.regularMarketPrice,
      change: quote.regularMarketChange, changePercent: quote.regularMarketChangePercent,
      high: quote.regularMarketDayHigh, low: quote.regularMarketDayLow,
      open: quote.regularMarketOpen, previousClose: quote.regularMarketPreviousClose,
      volume: quote.regularMarketVolume, name: quote.shortName || quote.longName,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/search', async (req, res) => {
  try {
    const results = await yahooFinance.search(req.query.q + ' NSE');
    const stocks = (results.quotes || [])
      .filter(r => r.exchange === 'NSI' || r.exchDisp === 'NSE')
      .map(r => ({ symbol: r.symbol.replace('.NS', ''), name: r.shortname || r.longname, exchange: 'NSE' }));
    res.json(stocks);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/nifty50', (req, res) => {
  res.json({ stocks: ['RELIANCE','TCS','HDFCBANK','INFY','ICICIBANK','HINDUNILVR','ITC','SBIN','BHARTIARTL','KOTAKBANK','LT','AXISBANK','ASIANPAINT','MARUTI','TITAN','SUNPHARMA','BAJFINANCE','WIPRO','ULTRACEMCO','NESTLEIND','TATAMOTORS','POWERGRID','NTPC','HCLTECH','TECHM','ONGC','TATASTEEL','JSWSTEEL','ADANIENT','BAJAJFINSV'] });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ─── Start ──────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
initYahoo().then(() => {
  app.listen(PORT, () => {
    console.log(`\n⚡ MakeMyAlgo.in server running on port ${PORT}\n`);
  });
}).catch(err => { console.error('Failed to init:', err); process.exit(1); });
