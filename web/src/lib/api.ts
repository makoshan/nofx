import type {
  SystemStatus,
  AccountInfo,
  Position,
  DecisionRecord,
  Statistics,
  TraderInfo,
  CompetitionData,
  KlinePoint,
  AISignal,
  TradeEvent,
} from '../types';

const API_BASE = '/api';

export const api = {
  // 竞赛相关接口
  async getCompetition(): Promise<CompetitionData> {
    const res = await fetch(`${API_BASE}/competition`);
    if (!res.ok) throw new Error('获取竞赛数据失败');
    return res.json();
  },

  async getTraders(): Promise<TraderInfo[]> {
    const res = await fetch(`${API_BASE}/traders`);
    if (!res.ok) throw new Error('获取trader列表失败');
    return res.json();
  },

  // 获取系统状态（支持trader_id）
  async getStatus(traderId?: string): Promise<SystemStatus> {
    const url = traderId
      ? `${API_BASE}/status?trader_id=${traderId}`
      : `${API_BASE}/status`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('获取系统状态失败');
    return res.json();
  },

  // 获取账户信息（支持trader_id）
  async getAccount(traderId?: string): Promise<AccountInfo> {
    const url = traderId
      ? `${API_BASE}/account?trader_id=${traderId}`
      : `${API_BASE}/account`;
    const res = await fetch(url, {
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache',
      },
    });
    if (!res.ok) throw new Error('获取账户信息失败');
    const data = await res.json();
    console.log('Account data fetched:', data);
    return data;
  },

  // 获取持仓列表（支持trader_id）
  async getPositions(traderId?: string): Promise<Position[]> {
    const url = traderId
      ? `${API_BASE}/positions?trader_id=${traderId}`
      : `${API_BASE}/positions`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('获取持仓列表失败');
    return res.json();
  },

  // 获取决策日志（支持trader_id）
  async getDecisions(traderId?: string): Promise<DecisionRecord[]> {
    const url = traderId
      ? `${API_BASE}/decisions?trader_id=${traderId}`
      : `${API_BASE}/decisions`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('获取决策日志失败');
    return res.json();
  },

  // 获取最新决策（支持trader_id）
  async getLatestDecisions(traderId?: string): Promise<DecisionRecord[]> {
    const url = traderId
      ? `${API_BASE}/decisions/latest?trader_id=${traderId}`
      : `${API_BASE}/decisions/latest`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('获取最新决策失败');
    return res.json();
  },

  // 获取统计信息（支持trader_id）
  async getStatistics(traderId?: string): Promise<Statistics> {
    const url = traderId
      ? `${API_BASE}/statistics?trader_id=${traderId}`
      : `${API_BASE}/statistics`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('获取统计信息失败');
    return res.json();
  },

  // 获取收益率历史数据（支持trader_id）
  async getEquityHistory(traderId?: string): Promise<any[]> {
    const url = traderId
      ? `${API_BASE}/equity-history?trader_id=${traderId}`
      : `${API_BASE}/equity-history`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('获取历史数据失败');
    return res.json();
  },

  // 获取AI学习表现分析（支持trader_id）
  async getPerformance(traderId?: string): Promise<any> {
    const url = traderId
      ? `${API_BASE}/performance?trader_id=${traderId}`
      : `${API_BASE}/performance`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('获取AI学习数据失败');
    return res.json();
  },

  async getMarketKline(params: {
    symbol?: string;
    interval?: string;
    limit?: number;
  }): Promise<KlinePoint[]> {
    const { symbol = 'SOL', interval = '3m', limit = 500 } = params ?? {};
    const search = new URLSearchParams({
      symbol,
      interval,
      limit: String(limit),
    });

    const res = await fetch(`${API_BASE}/market/kline?${search.toString()}`, {
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('获取K线数据失败');
    return res.json();
  },

  async getAISignals(params: {
    symbol?: string;
    limit?: number;
    since?: string;
  }): Promise<AISignal[]> {
    const { symbol = 'SOL', limit = 50, since } = params ?? {};
    const search = new URLSearchParams({
      symbol,
      limit: String(limit),
    });
    if (since) {
      search.set('since', since);
    }

    const res = await fetch(`${API_BASE}/ai-signals?${search.toString()}`, {
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('获取AI新闻信号失败');
    return res.json();
  },

  async getTrades(params: {
    symbol?: string;
    traderId?: string;
    limit?: number;
    from?: string;
    to?: string;
  }): Promise<TradeEvent[]> {
    const { symbol = 'SOL', traderId, limit = 200, from, to } = params ?? {};
    const search = new URLSearchParams({
      symbol,
      limit: String(limit),
    });
    if (traderId) {
      search.set('trader_id', traderId);
    }
    if (from) {
      search.set('from', from);
    }
    if (to) {
      search.set('to', to);
    }

    const res = await fetch(`${API_BASE}/trades?${search.toString()}`, {
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('获取交易时间线失败');
    return res.json();
  },
};
