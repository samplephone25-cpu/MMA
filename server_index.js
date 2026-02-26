/**
 * MakeMyAlgo.in — Backend Server
 * 
 * Features:
 * - Real market data from Yahoo Finance (15-min delay)
 * - Technical indicator computation (RSI, EMA, SMA, MACD, Bollinger Bands, SuperTrend, VWAP, ATR)
 * - Backtesting engine with equity curve, trade log, performance stats
 * - Live signal scanner based on user-defined algo rules
 * 
 * Yahoo Finance uses .NS suffix for NSE stocks (e.g., RELIANCE.NS)
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Yahoo Finance Data Fetcher ─────────────────────────────────────

let yahooFinance;

async function initYahoo() {
  yahooFinance = await import('yahoo-finance2').then(m => m.default || m);
}

/**
 * Fetch historical OHLCV data for an NSE stock
 * @param {string} symbol - NSE symbol (e.g., "RELIANCE")
 * @param {string} interval - Candle interval: "1m","5m","15m","1h","1d"
 * @param {string} range - Data range: "1d","5d","1mo","3mo","6mo","1y","2y","5y"
 */
async function fetchStockData(symbol, interval = '1d', range = '1y') {
  try {
    const nseSymbol = symbol.includes('.') ? symbol : `${symbol}.NS`;
    
    const result = await yahooFinance.chart(nseSymbol, {
      period1: getStartDate(range),
      interval: interval,
    });

    if (!result || !result.quotes || result.quotes.length === 0) {
      throw new Error(`No data returned for ${nseSymbol}`);
    }

    const candles = result.quotes
      .filter(q => q.open != null && q.high != null && q.low != null && q.close != null)
      .map(q => ({
        date: new Date(q.date).toISOString(),
        open: +q.open.toFixed(2),
        high: +q.high.toFixed(2),
        low: +q.low.toFixed(2),
        close: +q.close.toFixed(2),
        volume: q.volume || 0,
      }));

    return {
      symbol,
      interval,
      range,
      candles,
      meta: {
        name: result.meta?.shortName || symbol,
        exchange: result.meta?.exchangeName || 'NSE',
        currency: result.meta?.currency || 'INR',
        regularMarketPrice: result.meta?.regularMarketPrice,
        previousClose: result.meta?.chartPreviousClose,
      }
    };
  } catch (err) {
    console.error(`Error fetching ${symbol}:`, err.message);
    throw err;
  }
}

function getStartDate(range) {
  const now = new Date();
  const map = {
    '1d': 1, '5d': 5, '1mo': 30, '3mo': 90,
    '6mo': 180, '1y': 365, '2y': 730, '5y': 1825,
  };
  const days = map[range] || 365;
  return new Date(now.getTime() - days * 86400000).toISOString().split('T')[0];
}

// ─── Technical Indicators Engine ────────────────────────────────────

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
      avgGain += gain;
      avgLoss += loss;
      if (i < period) { result.push(null); continue; }
      avgGain /= period;
      avgLoss /= period;
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
  
  const validMacd = macdLine.filter(v => v !== null);
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
    const mean = sma[i];
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    const sd = Math.sqrt(variance) * stdDev;
    upper.push(+(mean + sd).toFixed(2));
    lower.push(+(mean - sd).toFixed(2));
  }

  return { upper, middle: sma, lower };
}

function computeATR(candles, period = 14) {
  const result = [];
  const trueRanges = [];

  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      trueRanges.push(candles[i].high - candles[i].low);
      result.push(null);
      continue;
    }
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    trueRanges.push(tr);

    if (i < period) { result.push(null); continue; }
    if (i === period) {
      result.push(+(trueRanges.slice(0, period + 1).reduce((a, b) => a + b, 0) / (period + 1)).toFixed(2));
    } else {
      const prevATR = result[result.length - 1];
      result.push(+((prevATR * (period - 1) + tr) / period).toFixed(2));
    }
  }
  return result;
}

function computeSuperTrend(candles, period = 10, multiplier = 3) {
  const atr = computeATR(candles, period);
  const result = [];
  let prevST = null, prevUpperBand = null, prevLowerBand = null, prevClose = null, trend = 1;

  for (let i = 0; i < candles.length; i++) {
    if (atr[i] === null) { result.push({ value: null, trend: 1 }); continue; }

    const hl2 = (candles[i].high + candles[i].low) / 2;
    let upperBand = hl2 + multiplier * atr[i];
    let lowerBand = hl2 - multiplier * atr[i];

    if (prevLowerBand !== null) {
      lowerBand = lowerBand > prevLowerBand || prevClose < prevLowerBand ? lowerBand : prevLowerBand;
      upperBand = upperBand < prevUpperBand || prevClose > prevUpperBand ? upperBand : prevUpperBand;
    }

    if (prevST === null) {
      trend = 1;
    } else if (prevST === prevUpperBand) {
      trend = candles[i].close > upperBand ? 1 : -1;
    } else {
      trend = candles[i].close < lowerBand ? -1 : 1;
    }

    const st = trend === 1 ? lowerBand : upperBand;
    result.push({ value: +st.toFixed(2), trend });

    prevST = st; prevUpperBand = upperBand; prevLowerBand = lowerBand; prevClose = candles[i].close;
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

/**
 * Compute any indicator for given candle data
 */
function computeIndicator(candles, indicator, params) {
  const closes = candles.map(c => c.close);
  
  switch (indicator) {
    case 'sma': return { values: computeSMA(closes, parseInt(params.Period) || 20), type: 'line' };
    case 'ema': return { values: computeEMA(closes, parseInt(params.Period) || 20), type: 'line' };
    case 'rsi': return { values: computeRSI(closes, parseInt(params.Period) || 14), type: 'oscillator', min: 0, max: 100 };
    case 'macd': {
      const m = computeMACD(closes, parseInt(params.Fast) || 12, parseInt(params.Slow) || 26, parseInt(params.Signal) || 9);
      return { values: m.macdLine, signal: m.signalLine, histogram: m.histogram, type: 'oscillator' };
    }
    case 'bb': {
      const bb = computeBollingerBands(closes, parseInt(params.Period) || 20, parseFloat(params.StdDev) || 2);
      return { upper: bb.upper, middle: bb.middle, lower: bb.lower, type: 'band' };
    }
    case 'supertrend': {
      const st = computeSuperTrend(candles, parseInt(params.Period) || 10, parseFloat(params.Multiplier) || 3);
      return { values: st.map(s => s.value), trends: st.map(s => s.trend), type: 'line' };
    }
    case 'vwap': return { values: computeVWAP(candles), type: 'line' };
    case 'atr': return { values: computeATR(candles, parseInt(params.Period) || 14), type: 'oscillator' };
    default: return { values: [], type: 'line' };
  }
}

// ─── Backtesting Engine ─────────────────────────────────────────────

/**
 * Run backtest on historical data with given rules
 * 
 * Rules format:
 * [
 *   { indicator: "rsi", params: { Period: "14" }, condition: "Crosses Below", value: "30", action: "BUY" },
 *   { indicator: "rsi", params: { Period: "14" }, condition: "Crosses Above", value: "70", action: "SELL" }
 * ]
 */
function runBacktest(candles, buyRules, sellRules, config = {}) {
  const {
    initialCapital = 100000,
    positionSize = 0.1, // 10% of capital per trade
    stopLossPercent = 2,
    targetPercent = 4,
  } = config;

  // Pre-compute all indicators
  const indicatorCache = {};
  const allRules = [...buyRules, ...sellRules];
  
  for (const rule of allRules) {
    const key = `${rule.indicator}_${JSON.stringify(rule.params)}`;
    if (!indicatorCache[key]) {
      indicatorCache[key] = computeIndicator(candles, rule.indicator, rule.params || {});
    }
  }

  // Get indicator value at index
  function getIndicatorValue(rule, index) {
    const key = `${rule.indicator}_${JSON.stringify(rule.params)}`;
    const data = indicatorCache[key];
    if (!data) return null;

    if (data.type === 'band') {
      // For Bollinger Bands, use middle by default, or specify in params
      return data.middle[index];
    }
    return data.values ? data.values[index] : null;
  }

  // Check if condition met
  function checkCondition(rule, index) {
    const currentVal = getIndicatorValue(rule, index);
    const prevVal = index > 0 ? getIndicatorValue(rule, index - 1) : null;
    const targetVal = parseFloat(rule.value);

    if (currentVal === null) return false;

    switch (rule.condition) {
      case 'Crosses Above':
        return prevVal !== null && prevVal <= targetVal && currentVal > targetVal;
      case 'Crosses Below':
        return prevVal !== null && prevVal >= targetVal && currentVal < targetVal;
      case 'Is Above':
        return currentVal > targetVal;
      case 'Is Below':
        return currentVal < targetVal;
      case 'Equals':
        return Math.abs(currentVal - targetVal) < 0.01;
      default:
        return false;
    }
  }

  // Run simulation
  const trades = [];
  let capital = initialCapital;
  let position = null; // { type, entryPrice, entryDate, qty, entryIndex }
  const equityCurve = [{ index: 0, date: candles[0]?.date, equity: capital }];

  const startIndex = 50; // skip initial indicator warmup period

  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];

    // Check exit conditions if in position
    if (position) {
      const pnlPercent = position.type === 'BUY'
        ? ((candle.close - position.entryPrice) / position.entryPrice) * 100
        : ((position.entryPrice - candle.close) / position.entryPrice) * 100;

      let exitReason = null;

      // Stop loss
      if (pnlPercent <= -stopLossPercent) {
        exitReason = 'Stop Loss';
      }
      // Target
      else if (pnlPercent >= targetPercent) {
        exitReason = 'Target Hit';
      }
      // Sell rules
      else {
        const sellTriggered = sellRules.length > 0 && sellRules.every(rule => checkCondition(rule, i));
        if (sellTriggered) exitReason = 'Signal Exit';
      }

      if (exitReason) {
        const pnl = position.type === 'BUY'
          ? (candle.close - position.entryPrice) * position.qty
          : (position.entryPrice - candle.close) * position.qty;

        capital += pnl;

        trades.push({
          id: trades.length + 1,
          type: position.type,
          stock: candle.symbol || 'Stock',
          entryPrice: position.entryPrice,
          exitPrice: candle.close,
          entryDate: position.entryDate,
          exitDate: candle.date,
          qty: position.qty,
          pnl: +pnl.toFixed(0),
          pnlPercent: +pnlPercent.toFixed(2),
          exitReason,
          holdingPeriod: i - position.entryIndex,
        });

        position = null;
      }
    }
    // Check buy entry if no position
    else if (buyRules.length > 0) {
      const buyTriggered = buyRules.every(rule => checkCondition(rule, i));
      if (buyTriggered) {
        const qty = Math.floor((capital * positionSize) / candle.close);
        if (qty > 0) {
          position = {
            type: 'BUY',
            entryPrice: candle.close,
            entryDate: candle.date,
            qty,
            entryIndex: i,
          };
        }
      }
    }

    // Track equity
    const unrealizedPnl = position
      ? (position.type === 'BUY'
          ? (candle.close - position.entryPrice) * position.qty
          : (position.entryPrice - candle.close) * position.qty)
      : 0;

    equityCurve.push({
      index: i,
      date: candle.date,
      equity: +(capital + unrealizedPnl).toFixed(0),
    });
  }

  // Close any open position
  if (position && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const pnl = position.type === 'BUY'
      ? (lastCandle.close - position.entryPrice) * position.qty
      : (position.entryPrice - lastCandle.close) * position.qty;
    capital += pnl;
    trades.push({
      id: trades.length + 1,
      type: position.type,
      stock: 'Stock',
      entryPrice: position.entryPrice,
      exitPrice: lastCandle.close,
      entryDate: position.entryDate,
      exitDate: lastCandle.date,
      qty: position.qty,
      pnl: +pnl.toFixed(0),
      pnlPercent: +(((lastCandle.close - position.entryPrice) / position.entryPrice) * 100).toFixed(2),
      exitReason: 'End of Data',
      holdingPeriod: candles.length - position.entryIndex,
    });
  }

  // Compute stats
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
  const equityValues = equityCurve.map(e => e.equity);
  
  let maxDrawdown = 0, peak = equityValues[0];
  for (const eq of equityValues) {
    if (eq > peak) peak = eq;
    const dd = ((peak - eq) / peak) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Sharpe ratio (annualized, assuming daily returns)
  const returns = [];
  for (let i = 1; i < equityValues.length; i++) {
    returns.push((equityValues[i] - equityValues[i - 1]) / equityValues[i - 1]);
  }
  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdReturn = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1))
    : 0;
  const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const profitFactor = Math.abs(avgLoss) > 0
    ? Math.abs(wins.reduce((s, t) => s + t.pnl, 0) / (losses.reduce((s, t) => s + t.pnl, 0) || 1))
    : wins.length > 0 ? Infinity : 0;

  return {
    trades: trades.slice(-100), // Last 100 trades for display
    equityCurve,
    stats: {
      totalTrades: trades.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: trades.length > 0 ? +((wins.length / trades.length) * 100).toFixed(1) : 0,
      totalPnL: +totalPnL.toFixed(0),
      netReturn: +(((capital - initialCapital) / initialCapital) * 100).toFixed(2),
      maxDrawdown: +maxDrawdown.toFixed(2),
      sharpeRatio: +sharpe.toFixed(2),
      avgWin: +avgWin.toFixed(0),
      avgLoss: +avgLoss.toFixed(0),
      profitFactor: +profitFactor.toFixed(2),
      initialCapital,
      finalCapital: +capital.toFixed(0),
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

      // Check each rule at the last candle
      const allMet = rules.every(rule => {
        const indData = computeIndicator(candles, rule.indicator, rule.params || {});
        const currentVal = indData.values ? indData.values[lastIdx] : null;
        const prevVal = indData.values && lastIdx > 0 ? indData.values[lastIdx - 1] : null;
        const targetVal = parseFloat(rule.value);

        if (currentVal === null) return false;

        switch (rule.condition) {
          case 'Crosses Above': return prevVal !== null && prevVal <= targetVal && currentVal > targetVal;
          case 'Crosses Below': return prevVal !== null && prevVal >= targetVal && currentVal < targetVal;
          case 'Is Above': return currentVal > targetVal;
          case 'Is Below': return currentVal < targetVal;
          default: return false;
        }
      });

      if (allMet) {
        const lastCandle = candles[lastIdx];
        const atr = computeATR(candles, 14);
        const atrVal = atr[lastIdx] || lastCandle.close * 0.02;

        signals.push({
          symbol,
          name: data.meta?.name || symbol,
          price: lastCandle.close,
          signal: rules[0]?.condition?.includes('Above') ? 'BUY' : 'SELL',
          target: +(lastCandle.close + atrVal * 2).toFixed(2),
          stopLoss: +(lastCandle.close - atrVal).toFixed(2),
          confidence: Math.min(95, Math.floor(60 + Math.random() * 30)),
          time: new Date(lastCandle.date).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
          indicator: rules[0]?.indicator?.toUpperCase() || 'CUSTOM',
          change: data.meta?.previousClose
            ? +(((lastCandle.close - data.meta.previousClose) / data.meta.previousClose) * 100).toFixed(2)
            : 0,
        });
      }
    } catch (err) {
      // Skip stocks that fail — log but don't crash
      console.log(`Scan skip ${symbol}: ${err.message}`);
    }
  }

  return signals;
}

// ─── API Routes ─────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Fetch stock data
app.get('/api/stock/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { interval = '1d', range = '1y' } = req.query;
    const data = await fetchStockData(symbol, interval, range);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Compute indicator
app.post('/api/indicator', async (req, res) => {
  try {
    const { symbol, indicator, params = {}, interval = '1d', range = '1y' } = req.body;
    const data = await fetchStockData(symbol, interval, range);
    const result = computeIndicator(data.candles, indicator, params);
    res.json({ symbol, indicator, params, ...result, candles: data.candles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run backtest
app.post('/api/backtest', async (req, res) => {
  try {
    const { symbol, buyRules = [], sellRules = [], config = {}, interval = '1d', range = '1y' } = req.body;
    const data = await fetchStockData(symbol, interval, range);
    const result = runBacktest(data.candles, buyRules, sellRules, config);
    result.symbol = symbol;
    result.meta = data.meta;
    result.candles = data.candles;
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scan live signals
app.post('/api/scan', async (req, res) => {
  try {
    const { stocks, rules } = req.body;
    const stockList = stocks || [
      'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
      'HINDUNILVR', 'ITC', 'SBIN', 'BHARTIARTL', 'KOTAKBANK',
      'LT', 'AXISBANK', 'MARUTI', 'TITAN', 'SUNPHARMA',
      'BAJFINANCE', 'WIPRO', 'HCLTECH', 'TATAMOTORS', 'NTPC',
    ];
    const signals = await scanLiveSignals(stockList, rules || []);
    res.json({ signals, scannedCount: stockList.length, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get quote for a stock
app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const nseSymbol = `${req.params.symbol}.NS`;
    const quote = await yahooFinance.quote(nseSymbol);
    res.json({
      symbol: req.params.symbol,
      price: quote.regularMarketPrice,
      change: quote.regularMarketChange,
      changePercent: quote.regularMarketChangePercent,
      high: quote.regularMarketDayHigh,
      low: quote.regularMarketDayLow,
      open: quote.regularMarketOpen,
      previousClose: quote.regularMarketPreviousClose,
      volume: quote.regularMarketVolume,
      marketCap: quote.marketCap,
      name: quote.shortName || quote.longName,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search stocks
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    const results = await yahooFinance.search(q + ' NSE');
    const stocks = (results.quotes || [])
      .filter(r => r.exchange === 'NSI' || r.exchDisp === 'NSE')
      .map(r => ({
        symbol: r.symbol.replace('.NS', ''),
        name: r.shortname || r.longname,
        exchange: 'NSE',
      }));
    res.json(stocks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Nifty 50 list
app.get('/api/nifty50', (req, res) => {
  res.json({
    stocks: [
      'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'HINDUNILVR',
      'ITC', 'SBIN', 'BHARTIARTL', 'KOTAKBANK', 'LT', 'AXISBANK',
      'ASIANPAINT', 'MARUTI', 'TITAN', 'SUNPHARMA', 'BAJFINANCE', 'WIPRO',
      'ULTRACEMCO', 'NESTLEIND', 'TATAMOTORS', 'POWERGRID', 'NTPC',
      'HCLTECH', 'TECHM', 'ONGC', 'TATASTEEL', 'JSWSTEEL', 'ADANIENT',
      'BAJAJFINSV', 'DRREDDY', 'CIPLA', 'EICHERMOT', 'DIVISLAB',
      'APOLLOHOSP', 'BRITANNIA', 'COALINDIA', 'GRASIM', 'HEROMOTOCO',
      'HINDALCO', 'INDUSINDBK', 'M&M', 'SBILIFE', 'TATACONSUM',
      'LTIM', 'BAJAJ-AUTO', 'BPCL', 'HDFCLIFE', 'SHRIRAMFIN', 'WIPRO'
    ]
  });
});

// Serve frontend for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── Start Server ───────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

initYahoo().then(() => {
  app.listen(PORT, () => {
    console.log(`\n⚡ MakeMyAlgo.in server running on http://localhost:${PORT}\n`);
    console.log(`  📊 API: http://localhost:${PORT}/api/health`);
    console.log(`  🌐 App: http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('Failed to initialize Yahoo Finance:', err);
  process.exit(1);
});
