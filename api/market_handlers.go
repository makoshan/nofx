package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"nofx/config"
	"nofx/logger"
	"nofx/market"

	"github.com/gin-gonic/gin"
)

type klineCacheEntry struct {
	expiresAt time.Time
	klines    []market.Kline
}

type klineCache struct {
	ttl  time.Duration
	mu   sync.RWMutex
	data map[string]klineCacheEntry
}

func newKlineCache(ttl time.Duration) *klineCache {
	return &klineCache{
		ttl:  ttl,
		data: make(map[string]klineCacheEntry),
	}
}

func (c *klineCache) Get(key string) ([]market.Kline, bool) {
	if c == nil {
		return nil, false
	}
	c.mu.RLock()
	entry, ok := c.data[key]
	c.mu.RUnlock()
	if !ok || time.Now().After(entry.expiresAt) {
		return nil, false
	}
	result := make([]market.Kline, len(entry.klines))
	copy(result, entry.klines)
	return result, true
}

func (c *klineCache) Set(key string, klines []market.Kline) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.data[key] = klineCacheEntry{
		expiresAt: time.Now().Add(c.ttl),
		klines:    append([]market.Kline(nil), klines...),
	}
	c.mu.Unlock()
}

type supabaseClient struct {
	baseURL         string
	apiKey          string
	schema          string
	aiSignalsTable  string
	httpClient      *http.Client
}

func newSupabaseClient(cfg *config.Config) *supabaseClient {
	if cfg == nil {
		return nil
	}
	if cfg.SupabaseURL == "" || cfg.SupabaseKey == "" {
		return nil
	}
	baseURL := strings.TrimRight(cfg.SupabaseURL, "/")
	schema := strings.TrimSpace(cfg.SupabaseSchema)
	table := strings.TrimSpace(cfg.SupabaseSignalsTable)
	if table == "" {
		table = "ai_signals"
	}

	return &supabaseClient{
		baseURL:        baseURL,
		apiKey:         cfg.SupabaseKey,
		schema:         schema,
		aiSignalsTable: table,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

type klineDTO struct {
	OpenTime  int64   `json:"open_time"`
	CloseTime int64   `json:"close_time"`
	Open      float64 `json:"open"`
	High      float64 `json:"high"`
	Low       float64 `json:"low"`
	Close     float64 `json:"close"`
	Volume    float64 `json:"volume"`
}

// handleMarketKline 返回K线数据（带缓存）
func (s *Server) handleMarketKline(c *gin.Context) {
	symbol := c.DefaultQuery("symbol", "SOL")
	interval := c.DefaultQuery("interval", "3m")
	limit := parseLimit(c.Query("limit"), 500, 1500)
	if limit <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "limit 参数必须为正整数"})
		return
	}

	cacheKey := strings.ToUpper(symbol) + "|" + strings.ToLower(interval) + "|" + strconv.Itoa(limit)
	if cached, ok := s.klineCache.Get(cacheKey); ok {
		c.JSON(http.StatusOK, adaptKlines(cached))
		return
	}

	klines, err := market.GetKlines(symbol, interval, limit)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("获取K线失败: %v", err)})
		return
	}

	s.klineCache.Set(cacheKey, klines)
	c.JSON(http.StatusOK, adaptKlines(klines))
}

func adaptKlines(klines []market.Kline) []klineDTO {
	result := make([]klineDTO, 0, len(klines))
	for _, k := range klines {
		result = append(result, klineDTO{
			OpenTime:  k.OpenTime,
			CloseTime: k.CloseTime,
			Open:      k.Open,
			High:      k.High,
			Low:       k.Low,
			Close:     k.Close,
			Volume:    k.Volume,
		})
	}
	return result
}

type AISignalResponse struct {
	Timestamp     time.Time   `json:"timestamp"`
	SummaryCN     string      `json:"summary_cn"`
	Direction     string      `json:"direction"`
	Confidence    float64     `json:"confidence,omitempty"`
	Links         []string    `json:"links,omitempty"`
	PriceSnapshot interface{} `json:"price_snapshot,omitempty"`
	ModelName     string      `json:"model_name,omitempty"`
	EventType     string      `json:"event_type,omitempty"`
	Assets        []string    `json:"assets,omitempty"`
	AssetNames    []string    `json:"asset_names,omitempty"`
}

// handleAISignals 返回Supabase中的AI新闻信号
func (s *Server) handleAISignals(c *gin.Context) {
	if s.supabase == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "未配置Supabase凭证"})
		return
	}

	symbol := strings.TrimSpace(c.DefaultQuery("symbol", "SOL"))
	limit := parseLimit(c.Query("limit"), 50, 200)
	if limit <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "limit 参数必须为正整数"})
		return
	}

	sinceParam := strings.TrimSpace(c.Query("since"))
	var since *time.Time
	if sinceParam != "" {
		parsed := parseTimeParam(sinceParam)
		if parsed == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "since 参数需为 RFC3339 时间格式"})
			return
		}
		since = parsed
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 12*time.Second)
	defer cancel()

	signals, err := s.supabase.fetchAISignals(ctx, symbol, since, limit)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("获取AI信号失败: %v", err)})
		return
	}

	c.JSON(http.StatusOK, signals)
}

// handleTrades 返回交易买卖点事件
func (s *Server) handleTrades(c *gin.Context) {
	_, traderID, err := s.getTraderFromQuery(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	trader, err := s.traderManager.GetTrader(traderID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	symbolParam := strings.TrimSpace(c.DefaultQuery("symbol", "SOL"))
	normalizedSymbol := market.Normalize(symbolParam)
	limit := parseLimit(c.Query("limit"), 200, 1000)
	if limit <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "limit 参数必须为正整数"})
		return
	}

	fromTime := parseTimeParam(strings.TrimSpace(c.Query("from")))
	toTime := parseTimeParam(strings.TrimSpace(c.Query("to")))

	// 为了匹配开平仓，放大读取窗口
	lookback := limit * 6
	if lookback < 600 {
		lookback = 600
	}
	if lookback > 5000 {
		lookback = 5000
	}
	records, err := trader.GetDecisionLogger().GetLatestRecords(lookback)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("读取交易记录失败: %v", err)})
		return
	}

	events := buildTradeEvents(records, normalizedSymbol, fromTime, toTime)
	if limit > 0 && len(events) > limit {
		// 只保留最新的 limit 条事件
		events = events[len(events)-limit:]
	}

	c.JSON(http.StatusOK, events)
}

type tradeEvent struct {
	Symbol      string     `json:"symbol"`
	Side        string     `json:"side"`
	Action      string     `json:"action"`
	Timestamp   time.Time  `json:"timestamp"`
	Price       float64    `json:"price"`
	Quantity    float64    `json:"quantity"`
	Leverage    int        `json:"leverage"`
	Confidence  int        `json:"confidence"`
	CycleNumber int        `json:"cycle_number"`
	PnL         *float64   `json:"pnl,omitempty"`
	PnLPct      *float64   `json:"pnl_pct,omitempty"`
	Duration    *string    `json:"duration,omitempty"`
}

type openPositionSnapshot struct {
	Price     float64
	Quantity  float64
	Leverage  int
	Timestamp time.Time
}

func buildTradeEvents(records []*logger.DecisionRecord, symbol string, from, to *time.Time) []tradeEvent {
	if len(records) == 0 {
		return []tradeEvent{}
	}
	filtered := make([]tradeEvent, 0, len(records))
	openPositions := make(map[string]openPositionSnapshot)

	for _, record := range records {
		for _, action := range record.Decisions {
			if !strings.EqualFold(action.Symbol, symbol) {
				continue
			}

			side := sideFromAction(action.Action)
			if side == "" {
				continue
			}

			actionTime := action.Timestamp
			if actionTime.IsZero() {
				actionTime = record.Timestamp
			}
			actionTime = actionTime.UTC()

			if from != nil && actionTime.Before(*from) {
				continue
			}
			if to != nil && actionTime.After(*to) {
				continue
			}

			event := tradeEvent{
				Symbol:      action.Symbol,
				Side:        side,
				Action:      action.Action,
				Timestamp:   actionTime,
				Price:       action.Price,
				Quantity:    action.Quantity,
				Leverage:    action.Leverage,
				Confidence:  action.Confidence,
				CycleNumber: record.CycleNumber,
			}
			posKey := event.Symbol + "_" + side

			switch action.Action {
			case "open_long", "open_short":
				if event.Quantity <= 0 {
					// 若日志缺少数量，跳过该开仓以免影响匹配
					continue
				}
				openPositions[posKey] = openPositionSnapshot{
					Price:     event.Price,
					Quantity:  event.Quantity,
					Leverage:  maxInt(event.Leverage, 1),
					Timestamp: event.Timestamp,
				}
				filtered = append(filtered, event)

			case "close_long", "close_short":
				openPos, ok := openPositions[posKey]
				if ok {
					if event.Quantity <= 0 {
						event.Quantity = openPos.Quantity
					}
					marginUsed := (openPos.Quantity * openPos.Price) / float64(maxInt(openPos.Leverage, 1))
					var pnl float64
					if side == "long" {
						pnl = openPos.Quantity * (event.Price - openPos.Price)
					} else {
						pnl = openPos.Quantity * (openPos.Price - event.Price)
					}

					pnlPct := 0.0
					if marginUsed > 0 {
						pnlPct = (pnl / marginUsed) * 100
					}

					duration := event.Timestamp.Sub(openPos.Timestamp).Round(time.Second).String()
					eventPnL := pnl
					eventPnLPct := pnlPct
					eventDuration := duration
					event.PnL = &eventPnL
					event.PnLPct = &eventPnLPct
					event.Duration = &eventDuration
					delete(openPositions, posKey)
				}
				filtered = append(filtered, event)
			}
		}
	}

	return filtered
}

func sideFromAction(action string) string {
	switch action {
	case "open_long", "close_long":
		return "long"
	case "open_short", "close_short":
		return "short"
	default:
		return ""
	}
}

func parseLimit(value string, defaultValue, maxValue int) int {
	if value == "" {
		return defaultValue
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return -1
	}
	if parsed <= 0 {
		return -1
	}
	if parsed > maxValue {
		return maxValue
	}
	return parsed
}

func parseTimeParam(value string) *time.Time {
	if value == "" {
		return nil
	}
	layouts := []string{
		time.RFC3339,
		"2006-01-02 15:04:05",
		"2006-01-02T15:04:05",
	}
	for _, layout := range layouts {
		if ts, err := time.Parse(layout, value); err == nil {
			utc := ts.UTC()
			return &utc
		}
	}
	return nil
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func (c *supabaseClient) fetchAISignals(ctx context.Context, symbol string, since *time.Time, limit int) ([]AISignalResponse, error) {
	if c == nil {
		return nil, fmt.Errorf("Supabase客户端未配置")
	}

	queryLimit := limit * 3
	if queryLimit < limit {
		queryLimit = limit
	}
	if queryLimit > 1000 {
		queryLimit = 1000
	}

	endpoint := fmt.Sprintf("%s/rest/v1/%s", c.baseURL, url.PathEscape(c.aiSignalsTable))
	params := url.Values{}
	params.Set("select", "*")
	params.Set("order", "created_at.desc")
	params.Set("limit", strconv.Itoa(queryLimit))
	if since != nil {
		params.Set("created_at", "gte."+since.UTC().Format(time.RFC3339))
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("apikey", c.apiKey)
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	if c.schema != "" {
		req.Header.Set("Accept-Profile", c.schema)
		req.Header.Set("Content-Profile", c.schema)
	}
	req.Header.Set("Prefer", "count=none")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("Supabase返回错误状态码 %d", resp.StatusCode)
	}

	decoder := json.NewDecoder(resp.Body)
	decoder.UseNumber()
	var raw []map[string]interface{}
	if err := decoder.Decode(&raw); err != nil {
		return nil, fmt.Errorf("解析Supabase响应失败: %w", err)
	}

	targets := buildSymbolVariants(symbol)
	results := make([]AISignalResponse, 0, len(raw))
	for _, entry := range raw {
		createdAtStr := stringValue(entry["created_at"])
		if createdAtStr == "" {
			continue
		}
		ts := parseTimeParam(createdAtStr)
		if ts == nil {
			continue
		}

		assets := parseStringSlice(entry["assets"])
		assetNames := parseStringSlice(entry["asset_names"])
		if symbol != "" && !matchSymbol(targets, assets, assetNames) {
			continue
		}

		signal := AISignalResponse{
			Timestamp:  ts.UTC(),
			SummaryCN:  stringValue(entry["summary_cn"]),
			Direction:  stringValue(entry["direction"]),
			Confidence: floatValue(entry["confidence"]),
			Links:      parseStringSlice(entry["links"]),
			ModelName:  stringValue(entry["model_name"]),
			EventType:  stringValue(entry["event_type"]),
			Assets:     assets,
			AssetNames: assetNames,
		}

		if snapshot := entry["price_snapshot"]; snapshot != nil {
			if value := normalizeSnapshot(snapshot); value != nil {
				signal.PriceSnapshot = value
			}
		}

		results = append(results, signal)
		if limit > 0 && len(results) >= limit {
			break
		}
	}

	return results, nil
}

func buildSymbolVariants(symbol string) []string {
	if symbol == "" {
		return nil
	}
	upper := strings.ToUpper(symbol)
	normalized := market.Normalize(upper)
	base := strings.TrimSuffix(normalized, "USDT")
	variants := []string{
		upper,
		normalized,
		base,
		base + "/USDT",
		base + "-USDT",
	}
	return variants
}

func matchSymbol(targets []string, arrays ...[]string) bool {
	if len(targets) == 0 {
		return true
	}
	for _, arr := range arrays {
		for _, val := range arr {
			candidate := strings.ToUpper(strings.TrimSpace(val))
			for _, target := range targets {
				if candidate == target || strings.Contains(candidate, target) {
					return true
				}
			}
		}
	}
	return false
}

func parseStringSlice(value interface{}) []string {
	switch v := value.(type) {
	case nil:
		return nil
	case json.Number:
		return []string{v.String()}
	case string:
		if v == "" {
			return nil
		}
		// 尝试解析JSON数组
		trimmed := strings.TrimSpace(v)
		if strings.HasPrefix(trimmed, "[") {
			var arr []string
			if err := json.Unmarshal([]byte(trimmed), &arr); err == nil {
				return arr
			}
		}
		parts := strings.FieldsFunc(trimmed, func(r rune) bool {
			return r == ',' || r == ';'
		})
		result := make([]string, 0, len(parts))
		for _, part := range parts {
			part = strings.TrimSpace(part)
			if part != "" {
				result = append(result, part)
			}
		}
		return result
	case []interface{}:
		result := make([]string, 0, len(v))
		for _, item := range v {
			if str := stringValue(item); str != "" {
				result = append(result, str)
			}
		}
		return result
	case []string:
		return v
	default:
		return []string{stringValue(v)}
	}
}

func floatValue(value interface{}) float64 {
	switch v := value.(type) {
	case nil:
		return 0
	case float64:
		return v
	case float32:
		return float64(v)
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case json.Number:
		if f, err := v.Float64(); err == nil {
			return f
		}
	case string:
		if f, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
			return f
		}
	}
	return 0
}

func stringValue(value interface{}) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(v)
	case json.Number:
		return v.String()
	case fmt.Stringer:
		return strings.TrimSpace(v.String())
	default:
		return strings.TrimSpace(fmt.Sprintf("%v", v))
	}
}

func normalizeSnapshot(value interface{}) interface{} {
	switch v := value.(type) {
	case nil:
		return nil
	case map[string]interface{}:
		return v
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			return nil
		}
		if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
			var decoded interface{}
			if err := json.Unmarshal([]byte(trimmed), &decoded); err == nil {
				return decoded
			}
		}
		return trimmed
	default:
		return v
	}
}

