## SOL（可扩展至 BTC、ETH）K 线＋AI 新闻信号＋交易买卖点可视化方案

### 1. 目标与范围
- 在同一张目标币种（默认 SOL/USDT，可扩展至 BTC/USDT、ETH/USDT 等）的价格 K 线图上叠加 AI 新闻信号与真实交易买卖点，支撑实时监控、盘后复盘和策略分析。
- 初期聚焦现有自动交易框架（单个 trader），方案完成后可扩展至多币种或多账号对比。

### 2. 现有能力梳理
- 后端：Gin API 已运行；`market.Get()` 可从 Binance Futures 获取指定币种（如 SOL、BTC、ETH）的 K 线及指标；`DecisionLogger` 按周期记录 AI 决策与执行动作。
- 前端：`web` 前端具备 Recharts 曲线对比组件，可复用数据拉取与轮询模式。
- 数据栈：暂无 AI 新闻信号接入；用户提供的 Supabase `ai_signals` 表可作为信号来源。

### 3. 数据来源与结构
| 模块 | 来源 | 核心字段 | 备注 |
|---|---|---|---|
| K 线行情 | `market.Get()` → Binance | open_time, open, high, low, close, volume | 需新增 API 暴露（支持 SOL/BTC/ETH 等） |
| 交易记录 | `DecisionLogger` → `DecisionAction` | timestamp, symbol, action, price, quantity, leverage | 需过滤/聚合，按 symbol 筛选 |
| AI 新闻信号 | Supabase `ai_signals` | created_at, assets/asset_names, summary_cn, direction, confidence, links, price_snapshot | 需新增 Supabase 集成，支持多资产筛选 |

### 4. 后端改造计划（Go）
1. **K 线接口**
   - 新增 `GET /api/market/kline`：参数 `symbol`（默认 SOL，可传 BTC/ETH）、`interval`（默认 3m）、`limit`（默认 500）。
   - 复用 `market.Get()` 与 `getKlines`，返回 `[]Kline` JSON；增加 30 秒缓存，避免频繁命中 Binance。

2. **AI 新闻信号接口**
   - 引入 Supabase Go SDK 或 REST 客户端，读取 `ai_signals` 表。
   - 新增 `GET /api/ai-signals`：参数 `symbol`（支持 SOL/BTC/ETH 等）、`since`、`limit`；过滤 `assets`/`asset_names` 包含目标币种的数据。
   - 返回结构：`timestamp`, `summary_cn`, `direction`, `confidence`, `links`, `price_snapshot`, `model_name`, `event_type`。

3. **交易买卖点接口**
   - 基于 `DecisionLogger.GetLatestRecords()` 聚合 `DecisionAction` 中的 `open_*` / `close_*`。
   - 新增 `GET /api/trades`：参数 `symbol`（默认 SOL，可选 BTC/ETH）、`limit`, `from`, `to`。
   - 输出字段：`timestamp`, `action`, `price`, `quantity`, `confidence`, `cycle_number`, `pnl`, `pnl_pct`, `duration`（若成功配对）。
   - 逻辑：
     - 过滤目标币种。
     - 维护 `symbol+side` 的开仓缓存，遇到平仓即计算盈亏与持仓时长。
     - 未匹配成功时仅返回开仓点。

4. **错误处理与鉴权**
   - Supabase 凭证放置于 `config.json` 新字段（如 `SupabaseURL`, `SupabaseKey`）。
   - 后端加载配置时注入；必要时限制接口访问来源（如仅供前端/Poly 内网调用）。

### 5. （可选增强）数据落地与脚本
- 当前阶段专注于实时 API 与前端可视化，实现后若需要离线缓存、回放或向外部系统批量推送数据，可在后续迭代中补充脚本化方案。
- 备选实现：使用 `uvx --with-requirements requirements.txt python scripts/ingest_markets.py --symbols SOL,BTC,ETH`（或等价的 Bash/Go 定时任务）周期性拉取 `/api/market/kline`、`/api/trades`、`/api/ai-signals` 数据，并写入本地时序库或 Poly 所需数据源。
- 建议在确认实时方案稳定后再评估是否需要该增强功能。

### 6. 前端与 Poly 展示
1. **Web 前端**
   - 新增 `web/src/components/MarketKline.tsx`（支持 symbol 参数）：
     - 使用 `useSWR` 拉取 K 线、交易、信号接口。
     - 采用 `lightweight-charts` 绘制蜡烛图；`series.setMarkers` 标注交易点（多箭头绿色，空箭头红色）。
     - AI 信号采用文本/图标标记，可 hover 展示 `summary_cn`、`confidence`、`links`。
   - 将组件接入现有竞赛面板或新建页面，支持用户选择 SOL/BTC/ETH。

2. **Poly 仪表板**
   - 配置 REST 数据源指向上述三个接口。
   - 主图：K 线与成交量。
   - 叠加层：
     - scatter/arrow：交易买卖点；支持点击查看详情。
     - 注释或标签：AI 新闻信号，按 `direction/strength` 配色。
   - 提供时间区间、信号类型过滤器。

### 7. 数据对齐
- K 线时间使用 Binance 毫秒时间戳；`DecisionRecord.Timestamp` 与 `DecisionAction.Timestamp` 均为 Go `time.Time`，保持 UTC 存储。
- 前端统一转换为用户时区（+08:00）。
- AI 信号若仅有 `created_at`，对齐最近的 K 线收盘时间；若 `price_snapshot` 包含价格，可作为标注点。

### 8. 测试与验收
- 单元测试：
  - K 线接口缓存与参数校验。
  - 交易接口的开平仓配对逻辑。
  - Supabase 查询的过滤条件（模拟数据）。
- 集成测试：
  - 使用测试 Supabase 项目写入样例信号；通过 API 验证响应。
  - 前端页面在本地联调，确认图表渲染与 tooltip 正常。

### 9. 运维与监控
- 记录接口调用耗时、Supabase 请求错误；必要时接入现有日志系统。
- 若部署在生产环境，考虑为 `/api/market/kline` 设置速率限制，以防被滥用。
- 定期检查 Supabase 信号同步延迟（可利用 `latency_ms` 字段）。

### 10. 里程碑建议
1. 后端接口开发与配置（K 线 / 交易 / 信号）。
2. Web 前端或 Poly Dashboard 原型调通。
3. 增加历史回放脚本及数据验证。
4. 上线前压测与监控接入。


