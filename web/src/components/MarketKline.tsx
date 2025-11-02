import { useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import {
  createChart,
  ColorType,
  CrosshairMode,
  IChartApi,
  ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import { api } from '../lib/api';
import type { AISignal, KlinePoint, TradeEvent } from '../types';

const DEFAULT_SYMBOLS = ['SOL', 'BTC', 'ETH'];

type MarketKlineProps = {
  traderId?: string;
  defaultSymbol?: string;
  interval?: string;
  symbols?: string[];
};

type ChartRefs = {
  chart?: IChartApi;
  candleSeries?: ISeriesApi<'Candlestick'>;
  volumeSeries?: ISeriesApi<'Histogram'>;
};

const toUnixSeconds = (value: number | string | Date): Time => {
  const date = value instanceof Date ? value : new Date(value);
  return Math.floor(date.getTime() / 1000) as Time;
};

const directionColor = (direction?: string) => {
  if (!direction) return '#F0B90B';
  const normalized = direction.toLowerCase();
  if (normalized.includes('多') || normalized.includes('bull') || normalized === 'long') {
    return '#0ECB81';
  }
  if (normalized.includes('空') || normalized.includes('bear') || normalized === 'short') {
    return '#F6465D';
  }
  return '#F0B90B';
};

const actionLabel = (event: TradeEvent) => {
  return `${event.action.replace('_', ' ')} @ ${event.price.toFixed(4)}`;
};

export function MarketKline({
  traderId,
  defaultSymbol = 'SOL',
  interval = '3m',
  symbols = DEFAULT_SYMBOLS,
}: MarketKlineProps) {
  const [symbol, setSymbol] = useState(() => defaultSymbol.toUpperCase());
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRefs = useRef<ChartRefs>({});

  const {
    data: klines,
    isLoading: klineLoading,
    error: klineError,
  } = useSWR(['market-kline', symbol, interval], () =>
    api.getMarketKline({ symbol, interval, limit: 500 })
  , {
    refreshInterval: 30_000,
    revalidateOnFocus: false,
  });

  const {
    data: signals,
    isLoading: signalLoading,
  } = useSWR(['ai-signals', symbol], () =>
    api.getAISignals({ symbol, limit: 80 })
  , {
    refreshInterval: 60_000,
    revalidateOnFocus: false,
  });

  const {
    data: trades,
    isLoading: tradesLoading,
  } = useSWR(['trade-events', traderId ?? 'default', symbol], () =>
    api.getTrades({ symbol, traderId, limit: 400 })
  , {
    refreshInterval: 20_000,
    revalidateOnFocus: false,
  });

  // 初始化图表
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      height: 420,
      layout: {
        background: { type: ColorType.Solid, color: '#0B0E11' },
        textColor: '#C3CBD0',
      },
      grid: {
        vertLines: { color: 'rgba(42, 46, 57, 0.4)' },
        horzLines: { color: 'rgba(42, 46, 57, 0.4)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(197, 203, 206, 0.6)',
      },
      timeScale: {
        borderColor: 'rgba(197, 203, 206, 0.6)',
        minBarSpacing: 0.5,
        fixLeftEdge: true,
        fixRightEdge: false,
      },
      localization: {
        dateFormat: 'yyyy-MM-dd',
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#0ECB81',
      borderUpColor: '#0ECB81',
      wickUpColor: '#0ECB81',
      downColor: '#F6465D',
      borderDownColor: '#F6465D',
      wickDownColor: '#F6465D',
    });

    const volumeSeries = chart.addHistogramSeries({
      priceScaleId: '',
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
      color: '#2B3139',
    });

    chart.priceScale('').applyOptions({
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    });

    chartRefs.current = {
      chart,
      candleSeries,
      volumeSeries,
    };

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        const { clientWidth } = containerRef.current;
        chart.applyOptions({ width: clientWidth });
        chart.timeScale().fitContent();
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRefs.current = {};
    };
  }, []);

  // 更新图表数据
  useEffect(() => {
    if (!chartRefs.current.chart || !chartRefs.current.candleSeries || !klines) {
      return;
    }

    const candleData: CandlestickData[] = klines.map(toCandlestick);
    chartRefs.current.candleSeries.setData(candleData);

    if (chartRefs.current.volumeSeries) {
      const volumeData: HistogramData<Time>[] = klines.map((kline) => ({
        time: toUnixSeconds(kline.open_time),
        value: Number(kline.volume || 0),
        color: kline.close >= kline.open ? 'rgba(14, 203, 129, 0.5)' : 'rgba(246, 70, 93, 0.5)',
      }));
      chartRefs.current.volumeSeries.setData(volumeData);
    }

    chartRefs.current.chart.timeScale().fitContent();
  }, [klines]);

  // 设置标记
  useEffect(() => {
    if (!chartRefs.current.candleSeries) return;

    const tradeMarkers: SeriesMarker<Time>[] = (trades ?? []).map((event) => {
      const isOpen = event.action === 'open_long' || event.action === 'open_short';
      const shape = event.action === 'open_short' || event.action === 'close_long' ? 'arrowDown' : 'arrowUp';
      return {
        time: toUnixSeconds(event.timestamp),
        position: (isOpen ? 'belowBar' : 'aboveBar'),
        shape,
        color: event.side === 'long' ? '#0ECB81' : '#F6465D',
        text: `#${event.cycle_number} ${event.side.toUpperCase()}`,
        id: `trade-${event.timestamp}-${event.action}`,
        size: 2,
      };
    });

    const signalMarkers: SeriesMarker<Time>[] = (signals ?? []).map((signal) => ({
      time: toUnixSeconds(signal.timestamp),
      position: 'aboveBar',
      shape: 'circle',
      color: directionColor(signal.direction),
      text: signal.summary_cn?.slice(0, 20) || 'AI',
      id: `signal-${signal.timestamp}`,
    }));

    const markers: SeriesMarker<Time>[] = [...tradeMarkers, ...signalMarkers]
      .sort((a, b) => (a.time as number) - (b.time as number));

    chartRefs.current.candleSeries.setMarkers(markers);
  }, [signals, trades]);

  const latestUpdate = useMemo(() => {
    if (!klines || klines.length === 0) return '--';
    const latest = klines[klines.length - 1];
    return new Date(latest.close_time).toLocaleString();
  }, [klines]);

  const topSignals = useMemo(() => {
    if (!signals) return [];
    return signals.slice(0, 6);
  }, [signals]);

  const latestTrades = useMemo(() => {
    if (!trades) return [];
    return [...trades]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 6);
  }, [trades]);

  const loading = klineLoading || signalLoading || tradesLoading;

  return (
    <div className="binance-card p-6 space-y-5 animate-slide-in" style={{ animationDelay: '0.05s' }}>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2" style={{ color: '#EAECEF' }}>
            🕯️ 市场K线 · {symbol.toUpperCase()} / USDT
          </h2>
          <div className="text-xs" style={{ color: '#848E9C' }}>
            最近更新：{latestUpdate}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {symbols.map((item) => (
            <button
              key={item}
              onClick={() => setSymbol(item.toUpperCase())}
              className="px-3 py-1.5 rounded text-xs font-semibold transition-all"
              style={symbol === item.toUpperCase()
                ? { background: '#F0B90B', color: '#000' }
                : { background: '#1E2329', color: '#848E9C', border: '1px solid #2B3139' }
              }
            >
              {item.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={containerRef}
        className="rounded"
        style={{
          height: 420,
          border: '1px solid #2B3139',
          background: '#0B0E11',
        }}
      >
        {(!klines || klines.length === 0) && !loading && !klineError && (
          <div className="flex items-center justify-center h-full text-sm" style={{ color: '#848E9C' }}>
            暂无K线数据
          </div>
        )}
        {klineError && (
          <div className="flex items-center justify-center h-full text-sm" style={{ color: '#F6465D' }}>
            无法加载K线数据：{(klineError as Error).message}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SignalList signals={topSignals} loading={signalLoading} />
        <TradeList trades={latestTrades} loading={tradesLoading} />
      </div>
    </div>
  );
}

function toCandlestick(kline: KlinePoint): CandlestickData {
  return {
    time: toUnixSeconds(kline.open_time),
    open: kline.open,
    high: kline.high,
    low: kline.low,
    close: kline.close,
  };
}

function SignalList({ signals, loading }: { signals: AISignal[]; loading: boolean }) {
  return (
    <div className="rounded p-4" style={{ background: '#0B0E11', border: '1px solid #2B3139' }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold" style={{ color: '#EAECEF' }}>
          🔔 最新 AI 新闻信号
        </h3>
        {loading && <span className="text-xs" style={{ color: '#848E9C' }}>加载中...</span>}
      </div>
      <div className="space-y-3 max-h-56 overflow-y-auto pr-1">
        {signals.length === 0 ? (
          <div className="text-xs" style={{ color: '#848E9C' }}>
            暂无可用信号
          </div>
        ) : (
          signals.map((signal, idx) => (
            <div key={`${signal.timestamp}-${idx}`} className="border-l-2 pl-3" style={{ borderColor: directionColor(signal.direction) }}>
              <div className="text-xs font-semibold" style={{ color: directionColor(signal.direction) }}>
                {signal.direction || 'Neutral'} · 信心 {signal.confidence?.toFixed(0) ?? '--'}
              </div>
              <div className="text-xs" style={{ color: '#EAECEF' }}>
                {signal.summary_cn || '—'}
              </div>
              <div className="text-[10px] mt-1" style={{ color: '#848E9C' }}>
                {new Date(signal.timestamp).toLocaleString()}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function TradeList({ trades, loading }: { trades: TradeEvent[]; loading: boolean }) {
  return (
    <div className="rounded p-4" style={{ background: '#0B0E11', border: '1px solid #2B3139' }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold" style={{ color: '#EAECEF' }}>
          🎯 最新交易动作
        </h3>
        {loading && <span className="text-xs" style={{ color: '#848E9C' }}>加载中...</span>}
      </div>
      <div className="space-y-3 max-h-56 overflow-y-auto pr-1">
        {trades.length === 0 ? (
          <div className="text-xs" style={{ color: '#848E9C' }}>
            暂无交易记录
          </div>
        ) : (
          trades.map((trade, idx) => (
            <div key={`${trade.timestamp}-${idx}`} className="border-l-2 pl-3" style={{ borderColor: trade.side === 'long' ? '#0ECB81' : '#F6465D' }}>
              <div className="flex items-center justify-between text-xs" style={{ color: '#EAECEF' }}>
                <div className="font-semibold">
                  {trade.symbol} · {trade.side.toUpperCase()}
                </div>
                <div className="text-[10px]" style={{ color: '#848E9C' }}>
                  {new Date(trade.timestamp).toLocaleString()}
                </div>
              </div>
              <div className="text-xs" style={{ color: '#EAECEF' }}>
                {actionLabel(trade)} · {trade.quantity.toFixed(3)} · {trade.leverage}x
              </div>
              {trade.pnl !== undefined && trade.pnl_pct !== undefined && (
                <div className="text-[10px] font-mono" style={{ color: trade.pnl >= 0 ? '#0ECB81' : '#F6465D' }}>
                  PnL {trade.pnl >= 0 ? '+' : ''}{trade.pnl.toFixed(2)} ({trade.pnl >= 0 ? '+' : ''}{trade.pnl_pct.toFixed(2)}%)
                  {trade.duration && <span style={{ color: '#848E9C', marginLeft: 8 }}>持仓 {trade.duration}</span>}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

