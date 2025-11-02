# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**NOFX** is an Agentic Trading OS - an AI-powered cryptocurrency trading system that uses LLMs (DeepSeek/Qwen) to make autonomous trading decisions on multiple exchanges (Binance, Hyperliquid, Aster DEX). The system supports multi-agent competition where different AI models compete against each other in real-time trading.

**Core Architecture**: The system follows a multi-agent decision loop architecture where AI models analyze market data, make trading decisions, execute trades, and learn from performance feedback in a continuous cycle.

## Build & Development Commands

### Backend (Go)

```bash
# Build the backend binary
go build -o nofx

# Run the backend (uses config.json in root directory)
./nofx

# Download Go dependencies
go mod download

# Tidy dependencies
go mod tidy
```

### Frontend (React + TypeScript)

```bash
cd web

# Install dependencies
npm install

# Development server (http://localhost:3000)
npm run dev

# Production build
npm run build

# Preview production build
npm run preview
```

### Docker Deployment

```bash
# Quick start (builds and starts all services)
./start.sh start --build

# Or use docker compose directly
docker compose up -d --build

# View logs
./start.sh logs

# Stop all services
./start.sh stop

# Check status
./start.sh status
```

## High-Level Architecture

### Multi-Agent Trading Loop

The system runs multiple independent trader instances, each with its own AI model, exchange account, and decision logs. The main trading loop operates as follows:

1. **TraderManager** (manager/trader_manager.go) - Manages multiple AutoTrader instances
2. **AutoTrader** (trader/auto_trader.go) - Core trading controller for each agent
3. **Decision Engine** (decision/engine.go) - AI decision-making logic
4. **Market Data** (market/data.go) - Fetches and processes market data with technical indicators
5. **Trader Interface** (trader/interface.go) - Unified API across exchanges (Binance, Hyperliquid, Aster)
6. **Decision Logger** (logger/decision_logger.go) - Records decisions and calculates performance metrics

### AI Decision Flow

Each trading cycle (default: 3 minutes):

1. **Fetch Market Data**: Get price sequences, technical indicators (EMA20/50, MACD, RSI, ATR), open interest, volume
2. **Analyze Performance**: Load last 20 trades, calculate win rate, profit factor, Sharpe ratio
3. **Build Prompt**: Construct system prompt (trading rules) + user prompt (market data + account state + historical feedback)
4. **Call AI API**: Send prompts to DeepSeek/Qwen/Custom LLM via MCP client (mcp/client.go)
5. **Parse Decision**: Extract Chain of Thought (CoT) reasoning + structured JSON decisions
6. **Validate & Execute**: Check risk limits, position limits, leverage constraints → execute trades
7. **Record Results**: Save decision logs with full CoT, update performance database

### Exchange Abstraction

The `Trader` interface (trader/interface.go) provides a unified API across all exchanges:

- **Binance** (trader/binance_futures.go) - Centralized futures exchange
- **Hyperliquid** (trader/hyperliquid_trader.go) - Decentralized perpetual exchange (uses Ethereum wallet)
- **Aster DEX** (trader/aster_trader.go) - Binance-compatible decentralized exchange (Web3 wallet)

Each trader implements: GetBalance, GetPositions, OpenLong, OpenShort, CloseLong, CloseShort, SetLeverage, SetStopLoss, SetTakeProfit, CancelAllOrders, FormatQuantity

### Configuration System

**config.json** supports:
- **Multiple traders** with different AI models and exchange accounts
- **Per-trader settings**: exchange type, API keys, AI model, initial balance, scan interval
- **Global settings**: leverage limits (BTC/ETH vs altcoins), coin pool configuration, API server port
- **Leverage configuration**: Separate limits for BTC/ETH (max 50x) vs altcoins (max 20x), with Binance subaccount restrictions (≤5x)

Important: Binance subaccounts have a hard limit of 5x leverage. The system warns if config exceeds this.

### API & Frontend

**Backend API** (api/server.go) - Gin HTTP server providing RESTful endpoints:
- `/api/competition` - Multi-agent leaderboard
- `/api/traders` - List of all traders
- `/api/status?trader_id=xxx` - System status for specific trader
- `/api/account?trader_id=xxx` - Account balance and equity
- `/api/positions?trader_id=xxx` - Open positions
- `/api/equity-history?trader_id=xxx` - Historical equity data
- `/api/decisions/latest?trader_id=xxx` - Recent AI decisions
- `/api/statistics?trader_id=xxx` - Performance stats

**Frontend** (web/) - React + TypeScript dashboard with:
- **Competition Page**: Real-time leaderboard comparing multiple AI traders
- **Details Page**: Equity curves, position tables, decision logs with expandable CoT reasoning
- **Real-time updates**: SWR-based data fetching (5-10 second intervals)
- **Charts**: Recharts for equity curves and performance comparisons

### Performance Tracking & Self-Learning

The system implements a self-learning loop via historical feedback:

1. **Decision Logger** (logger/decision_logger.go) tracks every trade:
   - Stores: symbol, side (long/short), entry price, exit price, quantity, leverage, open time, close time
   - Calculates: PnL in USDT (position value × price change % × leverage), win rate, profit factor, Sharpe ratio
   - Uses `symbol_side` key (e.g., "BTCUSDT_long") to distinguish simultaneous long/short positions

2. **Performance Analysis** feeds back into AI prompts:
   - Last 20 trades summary (win rate, best/worst coins, consecutive losses)
   - Sharpe ratio (risk-adjusted returns) as primary success metric
   - Per-coin statistics (helps AI avoid repeating mistakes)

3. **AI Adaptation**:
   - System prompt enforces Sharpe ratio optimization (not trading frequency)
   - User prompt includes real-time Sharpe ratio and historical trade results
   - AI adjusts strategy based on feedback (e.g., reduce frequency if Sharpe < -0.5)

### Risk Management System

Hard constraints enforced in decision/engine.go:

1. **Position Limits**:
   - Altcoins: 0.8x - 1.5x account equity
   - BTC/ETH: 5x - 10x account equity
2. **Leverage Limits**:
   - Configurable per asset class (default: 5x for safety)
   - Subaccount restriction: ≤5x maximum
3. **Risk-Reward Ratio**: Must be ≥ 3:1 (risk 1% to gain 3%+)
4. **Margin Usage**: Total margin ≤ 90% of account equity
5. **Anti-Stacking**: Prevents duplicate positions in same symbol+direction
6. **Liquidity Filter**: Skips coins with Open Interest value < $15M USD

### Coin Pool Management

**pool/coin_pool.go** manages candidate trading symbols:

- **Default Mode** (use_default_coins: true): Fixed list of 8 major coins (BTC, ETH, SOL, BNB, XRP, DOGE, ADA, HYPE)
- **Advanced Mode**: Merges AI500 top coins + Open Interest growth leaders, deduplicates, filters by liquidity
- OI Top data provides additional context (net long/short, OI delta %, price change) for AI decision-making

## Key Implementation Details

### Precision Handling

All exchanges require exact precision for order quantities and prices:
- Binance: Uses LOT_SIZE filter from exchange info
- Hyperliquid: Auto-fetches szDecimals via API
- Aster: Uses Binance-compatible precision system

The `FormatQuantity()` method on each Trader implementation handles this automatically.

### Position Duration Tracking

System tracks how long each position has been held:
- Stored in `UpdateTime` field (milliseconds timestamp)
- Displayed in AI prompts (e.g., "持仓时长2小时15分钟")
- Helps AI make better exit timing decisions

### PnL Calculation

Accurate profit/loss calculation (fixed in v2.0.2):

```
PnL (USDT) = Position Value (USDT) × Price Change (%) × Leverage
```

Example: 1000 USDT position @ 20x leverage, 5% price change = 1000 USDT profit

This ensures performance statistics reflect real dollar amounts, not just percentages.

### AI Prompt Engineering

The system uses a two-part prompt strategy:

1. **System Prompt** (buildSystemPrompt): Fixed trading rules, risk constraints, output format requirements - can be cached
2. **User Prompt** (buildUserPrompt): Dynamic market data, account state, position info, historical feedback

This separation enables efficient LLM caching and reduces token costs.

### Multi-Exchange Support Pattern

When adding a new exchange:

1. Implement the `Trader` interface in trader/ directory
2. Add exchange-specific configuration fields to config/config.go
3. Update TraderManager in manager/trader_manager.go to instantiate the new trader type
4. Handle exchange-specific precision and API requirements

## Important Files

- **config.json** - Main configuration (not in repo, created from config.json.example)
- **main.go** - Entry point, initializes TraderManager and API server
- **decision/engine.go** - Core AI decision logic and prompt construction
- **logger/decision_logger.go** - Performance tracking and trade history
- **trader/binance_futures.go** - Binance exchange implementation (most complete reference)
- **manager/trader_manager.go** - Multi-trader orchestration
- **market/data.go** - Market data fetching and technical indicator calculation

## Common Development Workflows

### Adding a New Technical Indicator

1. Add indicator calculation to **market/data.go** in the `Get()` function
2. Update `FormatMarketData()` to include the indicator in AI prompts
3. Update system prompt in **decision/engine.go** to inform AI about the new indicator

### Modifying AI Trading Strategy

1. Edit **buildSystemPrompt()** in decision/engine.go for rule changes
2. Edit **buildUserPrompt()** to change data format or add context
3. Update **validateDecision()** to enforce new constraints
4. Test changes by monitoring decision_logs/ output

### Adding Support for a New Exchange

1. Create new file in trader/ implementing the Trader interface
2. Add exchange config fields to config/config.go TraderConfig struct
3. Update config validation in config/config.go Validate() method
4. Modify manager/trader_manager.go AddTrader() to handle new exchange type
5. Test with testnet/paper trading first

### Debugging AI Decisions

All decision logs are saved to `decision_logs/{trader_id}/`:
- Each log contains: full user prompt, AI's Chain of Thought, parsed decisions, execution results
- Logs are timestamped and include complete market data snapshots
- Check logs to understand why AI made specific decisions or failed validation

## External Dependencies

**Go Libraries**:
- `github.com/adshao/go-binance/v2` - Binance API client
- `github.com/sonirico/go-hyperliquid` - Hyperliquid DEX client
- `github.com/ethereum/go-ethereum` - Ethereum crypto utilities (for Hyperliquid/Aster signing)
- `github.com/gin-gonic/gin` - HTTP API framework
- TA-Lib (system library) - Technical analysis indicators (must be installed: `brew install ta-lib` on macOS, `apt-get install libta-lib0-dev` on Ubuntu)

**Frontend Libraries**:
- `react` + `react-dom` - UI framework
- `recharts` - Charting library
- `swr` - Data fetching and caching
- `tailwindcss` - CSS framework
- `vite` - Build tool

## Testing & Validation

**Currently no automated tests** - the system relies on:
- Manual testing with paper trading accounts
- Real-time monitoring via web dashboard
- Decision log analysis
- Performance metrics (Sharpe ratio, win rate, profit factor)

When testing new features:
1. Use small initial_balance (100-500 USDT)
2. Monitor decision_logs/ for AI reasoning
3. Check /api/statistics endpoint for performance
4. Watch for validation errors in backend logs

## Notes for Claude Code

- The codebase uses Chinese comments in some places - translate as needed for understanding
- Config validation is strict - ensure all required fields are present based on exchange and AI model selection
- The system has active git history - check recent commits for context on changes
- Decision logs can grow large - consider cleanup strategies for production deployments
- Frontend uses 5-10 second polling intervals - be mindful of API rate limits when adding new endpoints
- Always validate AI decisions before execution - the validateDecision() function is critical for risk management
