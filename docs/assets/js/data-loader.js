// Data Loader Utility
// Handles loading and processing all trading data

class DataLoader {
    constructor() {
        this.agentData = {};
        this.priceCache = {};
        this.intradayPriceCache = {};
        this.config = null;
        this.baseDataPath = './data';
        // Load market from localStorage or default to 'us_5min'
        this.currentMarket = this.loadMarketFromStorage() || 'us_5min';
        this.liveAgentMetadata = {};
        this.buyHoldSeries = null;
    }

    // Save market selection to localStorage
    saveMarketToStorage(market) {
        try {
            localStorage.setItem('ai-trader-market', market);
        } catch (e) {
            console.warn('Failed to save market to localStorage:', e);
        }
    }

    // Load market selection from localStorage
    loadMarketFromStorage() {
        try {
            return localStorage.getItem('ai-trader-market');
        } catch (e) {
            console.warn('Failed to load market from localStorage:', e);
            return null;
        }
    }

    // Switch market between US stocks and A-shares
    setMarket(market) {
        this.currentMarket = market;
        this.agentData = {};
        this.priceCache = {};
        this.intradayPriceCache = {};
        this.saveMarketToStorage(market);
    }

    // Get current market
    getMarket() {
        return this.currentMarket;
    }

    // Get current market configuration
    getMarketConfig() {
        return window.configLoader.getMarketConfig(this.currentMarket);
    }

    // Initialize with configuration
    async initialize() {
        if (!this.config) {
            this.config = await window.configLoader.loadConfig();
            this.baseDataPath = window.configLoader.getDataPath();
        }

        // Always clear caches for intraday trading to ensure fresh prices
        if (this.currentMarket === 'us_5min') {
            this.priceCache = {};
            this.intradayPriceCache = {};
        }
    }

    // Load all agent names from configuration
    async loadAgentList() {
        try {
            // Ensure config is loaded
            await this.initialize();

            const marketConfig = this.getMarketConfig();
            const agentDataDir = marketConfig ? marketConfig.data_dir : 'agent_data';
            const agents = [];
            
            // For live 5-min trading, auto-detect agents
            if (this.currentMarket === 'us_5min' && marketConfig.auto_detect_agents && window.LiveLoader) {
                console.log('🔴 Auto-detecting live 5-min agents...');
                const liveAgents = await window.LiveLoader.autoDetectLiveAgents(marketConfig);
                if (Array.isArray(liveAgents)) {
                    this.liveAgentMetadata = {};
                    for (const agentConfig of liveAgents) {
                        if (!agentConfig || !agentConfig.folder) continue;
                        agents.push(agentConfig.folder);
                        this.liveAgentMetadata[agentConfig.folder] = agentConfig;
                        console.log(`✅ Found live agent: ${agentConfig.folder}`);
                    }
                    if (window.configLoader && typeof window.configLoader.upsertLiveAgents === 'function') {
                        window.configLoader.upsertLiveAgents(this.currentMarket, liveAgents);
                    }
                }
                
                // Enable auto-refresh for live data
                if (agents.length > 0 && window.LiveLoader) {
                    window.LiveLoader.startLiveRefresh(() => {
                        // Reload the current page data
                        if (typeof window.loadAllData === 'function') {
                            window.loadAllData();
                        }
                    }, 60000);
                }
                
                return agents;
            }
            
            // For regular markets, use configured agents
            const enabledAgents = window.configLoader.getEnabledAgents(this.currentMarket);

            for (const agentConfig of enabledAgents) {
                try {
                    console.log(`Checking agent: ${agentConfig.folder} in ${agentDataDir}`);
                    const response = await fetch(`${this.baseDataPath}/${agentDataDir}/${agentConfig.folder}/position/position.jsonl`);
                    if (response.ok) {
                        agents.push(agentConfig.folder);
                        console.log(`Added agent: ${agentConfig.folder}`);
                    } else {
                        console.log(`Agent ${agentConfig.folder} not found (status: ${response.status})`);
                    }
                } catch (e) {
                    console.log(`Agent ${agentConfig.folder} error:`, e.message);
                }
            }

            // For live 5-min trading with manually configured agents, still enable auto-refresh
            if (this.currentMarket === 'us_5min' && agents.length > 0 && window.LiveLoader) {
                window.LiveLoader.startLiveRefresh(() => {
                    if (typeof window.loadAllData === 'function') {
                        window.loadAllData();
                    }
                }, 60000);
            }

            return agents;
        } catch (error) {
            console.error('Error loading agent list:', error);
            return [];
        }
    }

    // Load position data for a specific agent
    async loadAgentPositions(agentName) {
        try {
            const marketConfig = this.getMarketConfig();
            const agentDataDir = marketConfig ? marketConfig.data_dir : 'agent_data';
            const response = await fetch(`${this.baseDataPath}/${agentDataDir}/${agentName}/position/position.jsonl`);
            if (!response.ok) throw new Error(`Failed to load positions for ${agentName}`);

            const text = await response.text();
            const lines = text.trim().split('\n').filter(line => line.trim() !== '');
            const parsedPositions = lines.map(line => {
                try {
                    return JSON.parse(line);
                } catch (parseError) {
                    console.error(`Error parsing line for ${agentName}:`, line, parseError);
                    return null;
                }
            }).filter(pos => pos !== null)
              ;

            let tradingPositions = parsedPositions.filter(pos => {
                if (!pos) return false;
                if (pos.action_type === 'INIT' || (pos.action_id !== undefined && pos.id === undefined)) {
                    return false;
                }
                return true;
            });

            const positions = parsedPositions;
            console.log(`Loaded ${positions.length} positions for ${agentName} (${tradingPositions.length} trade records, ${positions.length - tradingPositions.length} non-trade entries)`);
            return positions;
        } catch (error) {
            console.error(`Error loading positions for ${agentName}:`, error);
            return [];
        }
    }

    // Load all A-share stock prices from merged.jsonl
    async loadAStockPrices() {
        if (Object.keys(this.priceCache).length > 0) {
            return this.priceCache;
        }

        try {
            const response = await fetch(`${this.baseDataPath}/A_stock/merged.jsonl`);
            if (!response.ok) throw new Error('Failed to load A-share prices');

            const text = await response.text();
            const lines = text.trim().split('\n');

            for (const line of lines) {
                if (!line.trim()) continue;
                const data = JSON.parse(line);
                const symbol = data['Meta Data']['2. Symbol'];
                this.priceCache[symbol] = data['Time Series (Daily)'];
            }

            console.log(`Loaded prices for ${Object.keys(this.priceCache).length} A-share stocks`);
            return this.priceCache;
        } catch (error) {
            console.error('Error loading A-share prices:', error);
            return {};
        }
    }

    // Load price data for a specific stock symbol
    async loadStockPrice(symbol) {
        if (this.currentMarket === 'us_5min') {
            return await this.loadIntradayPriceBars(symbol);
        }

        if (this.priceCache[symbol]) {
            return this.priceCache[symbol];
        }

        if (this.currentMarket === 'cn') {
            // For A-shares, load all prices at once
            await this.loadAStockPrices();
            return this.priceCache[symbol] || null;
        }

        // For US stocks, load individual JSON files
        try {
            const priceFilePrefix = window.configLoader.getPriceFilePrefix();
            const filePath = `${this.baseDataPath}/${priceFilePrefix}${symbol}.json`;
            const response = await fetch(filePath);
            if (!response.ok) {
                console.warn(`[loadStockPrice] ❌ ${symbol}: HTTP ${response.status}`);
                throw new Error(`Failed to load price for ${symbol}`);
            }

            const data = await response.json();
            // Support both hourly (60min) and daily data formats
            this.priceCache[symbol] = data['Time Series (60min)'] || data['Time Series (Daily)'];

            if (!this.priceCache[symbol]) {
                console.warn(`[loadStockPrice] ❌ ${symbol}: No time series data found`);
                return null;
            }

            const dataPointCount = Object.keys(this.priceCache[symbol]).length;
            const sampleDates = Object.keys(this.priceCache[symbol]).sort().slice(0, 3);
            console.log(`[loadStockPrice] ✅ ${symbol}: ${dataPointCount} points, samples: ${sampleDates.join(', ')}`);

            return this.priceCache[symbol];
        } catch (error) {
            console.error(`[loadStockPrice] ❌ ${symbol}:`, error.message);
            return null;
        }
    }

    // Load intraday 5-minute bars for a symbol
    async loadIntradayPriceBars(symbol, targetDate) {
        const cacheKey = targetDate ? `${symbol}:${targetDate}` : `${symbol}:latest`;
        if (this.currentMarket !== 'us_5min' && this.intradayPriceCache[cacheKey]) {
            return this.intradayPriceCache[cacheKey];
        }

        const datesToTry = [];
        if (targetDate) {
            datesToTry.push(targetDate);
        }

        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10);
        if (!datesToTry.includes(todayStr)) {
            datesToTry.push(todayStr);
        }

        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const yesterdayStr = yesterday.toISOString().slice(0, 10);
        if (!datesToTry.includes(yesterdayStr)) {
            datesToTry.push(yesterdayStr);
        }

        let bars = [];
        for (const dateStr of datesToTry) {
            try {
                const url = `${this.baseDataPath}/price_cache_5min/${symbol}/${dateStr}.json?v=${Date.now()}`;
                const response = await fetch(url);
                if (!response.ok) {
                    continue;
                }

                const data = await response.json();
                if (data && Array.isArray(data.bars)) {
                    bars = data.bars
                        .map(bar => ({
                            timestamp: bar.timestamp,
                            close: parseFloat(bar.close),
                            raw: bar
                        }))
                        .filter(bar => !isNaN(bar.close))
                        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

                    break;
                }
            } catch (error) {
                console.error(`[loadIntradayPriceBars] ❌ ${symbol} (${dateStr}):`, error.message);
            }
        }

        bars = bars || [];

        // Attempt to append live latest bar if available
        if (this.currentMarket === 'us_5min') {
            try {
                const latest = await this.loadLatestBar(symbol);
                if (latest && latest.bar && latest.bar.t) {
                    const latestTimestamp = new Date(latest.bar.t).getTime();
                    const lastTimestamp = bars.length > 0 ? new Date(bars[bars.length - 1].timestamp).getTime() : null;
                    if (!lastTimestamp || latestTimestamp > lastTimestamp) {
                        bars.push({
                            timestamp: latest.bar.t,
                            close: parseFloat(latest.bar.c),
                            raw: latest.bar,
                        });
                    }
                }
            } catch (error) {
                console.error(`[loadIntradayPriceBars] ❌ latest bar ${symbol}:`, error.message);
            }
        }

        this.intradayPriceCache[cacheKey] = bars;
        return bars;
    }

    async loadLatestBar(symbol) {
        try {
            const url = `${this.baseDataPath}/price_cache_5min/latest/${symbol}.json?v=${Date.now()}`;
            const response = await fetch(url);
            if (!response.ok) {
                return null;
            }
            const data = await response.json();
            return data;
        } catch (error) {
            console.error(`[loadLatestBar] ❌ ${symbol}:`, error.message);
            return null;
        }
    }

    // Parse datetime helper
    parseDateTime(input) {
        if (!input) return null;
        if (input instanceof Date) {
            return input;
        }

        let normalized = input;
        if (typeof input === 'string' && input.includes(' ') && !input.includes('T')) {
            normalized = input.replace(' ', 'T');
        }

        let parsed = new Date(normalized);
        if (!isNaN(parsed.getTime())) {
            return parsed;
        }

        if (typeof input === 'string') {
            const trimmed = input.split('.')[0];
            parsed = new Date(trimmed);
            if (!isNaN(parsed.getTime())) {
                return parsed;
            }
        }

        return null;
    }

    // Get closing price for a symbol on a specific date/time
    async getClosingPrice(symbol, dateOrTimestamp) {
        if (this.currentMarket === 'us_5min') {
            const targetDate = this.parseDateTime(dateOrTimestamp);
            const targetTimestamp = targetDate ? targetDate.getTime() : Date.now();
            const targetDateStr = targetDate ? targetDate.toISOString().slice(0, 10) : undefined;

            const bars = await this.loadIntradayPriceBars(symbol, targetDateStr);
            if (!bars || bars.length === 0) {
                return null;
            }

            let chosenBar = null;
            for (const bar of bars) {
                const barTimestamp = new Date(bar.timestamp).getTime();
                if (barTimestamp <= targetTimestamp) {
                    if (!chosenBar || barTimestamp > new Date(chosenBar.timestamp).getTime()) {
                        chosenBar = bar;
                    }
                }
            }

            if (!chosenBar) {
                chosenBar = bars[bars.length - 1];
            }

            return chosenBar ? chosenBar.close : null;
        }

        const prices = await this.loadStockPrice(symbol);
        if (!prices) {
            return null;
        }

        // Try exact match first (for hourly data like "2025-10-01 10:00:00")
        if (prices[dateOrTimestamp]) {
            const closePrice = prices[dateOrTimestamp]['4. close'] || prices[dateOrTimestamp]['4. sell price'];
            return closePrice ? parseFloat(closePrice) : null;
        }

        // For intraday (us_5min): Find the most recent price available
        if (this.currentMarket === 'us_5min') {
            const allTimestamps = Object.keys(prices).sort();
            // Find the latest timestamp that is <= the requested timestamp
            let latestTimestamp = null;
            for (let i = allTimestamps.length - 1; i >= 0; i--) {
                if (allTimestamps[i] <= dateOrTimestamp) {
                    latestTimestamp = allTimestamps[i];
                    break;
                }
            }
            
            // If no earlier timestamp found, use the latest available
            if (!latestTimestamp && allTimestamps.length > 0) {
                latestTimestamp = allTimestamps[allTimestamps.length - 1];
            }
            
            if (latestTimestamp) {
                const closePrice = prices[latestTimestamp]['4. close'] || prices[latestTimestamp]['4. sell price'];
                return closePrice ? parseFloat(closePrice) : null;
            }
        }

        // For A-shares: Extract date only for daily data matching
        if (this.currentMarket === 'cn') {
            const dateOnly = dateOrTimestamp.split(' ')[0]; // "2025-10-01 10:00:00" -> "2025-10-01"
            if (prices[dateOnly]) {
                const closePrice = prices[dateOnly]['4. close'] || prices[dateOnly]['4. sell price'];
                return closePrice ? parseFloat(closePrice) : null;
            }

            // If still not found, try to find the closest timestamp on the same date (for hourly data)
            const datePrefix = dateOnly;
            const matchingKeys = Object.keys(prices).filter(key => key.startsWith(datePrefix));

            if (matchingKeys.length > 0) {
                // Use the last (most recent) timestamp for that date
                const lastKey = matchingKeys.sort().pop();
                const closePrice = prices[lastKey]['4. close'] || prices[lastKey]['4. sell price'];
                return closePrice ? parseFloat(closePrice) : null;
            }
        }

        return null;
    }

    // Calculate total asset value for a position on a given date
    async calculateAssetValue(position, date) {
        let totalValue = position.positions.CASH || 0;
        let hasMissingPrice = false;

        // Get all stock symbols (exclude CASH)
        const symbols = Object.keys(position.positions).filter(s => s !== 'CASH');

        for (const symbol of symbols) {
            const shares = position.positions[symbol];
            if (shares > 0) {
                const price = await this.getClosingPrice(symbol, date);
                if (price && !isNaN(price)) {
                    totalValue += shares * price;
                } else {
                    console.warn(`Missing or invalid price for ${symbol} on ${date}`);
                    hasMissingPrice = true;
                }
            }
        }

        // For A-shares: If any stock price is missing, return null to skip this date
        if (this.currentMarket === 'cn' && hasMissingPrice) {
            return null;
        }

        return totalValue;
    }

    // Load complete data for an agent including asset values over time
    async loadAgentData(agentName) {
        console.log(`Starting to load data for ${agentName} in ${this.currentMarket} market...`);
        const positions = await this.loadAgentPositions(agentName);
        if (positions.length === 0) {
            console.log(`No positions found for ${agentName}`);
            // Continue so we can still show metadata (e.g., start time) even without trades yet
        }

        console.log(`Processing ${positions.length} positions for ${agentName}...`);

        const parseTimestampForSort = (value) => {
            if (!value) return Number.NaN;
            if (typeof value !== 'string') return Number.NaN;
            const normalized = value.includes('T') ? value : value.replace(' ', 'T');
            const parsed = Date.parse(normalized);
            return Number.isNaN(parsed) ? Number.NaN : parsed;
        };

        const positionsChronological = positions.slice().sort((a, b) => {
            const timeA = parseTimestampForSort(a?.date);
            const timeB = parseTimestampForSort(b?.date);

            if (!Number.isNaN(timeA) && !Number.isNaN(timeB) && timeA !== timeB) {
                return timeA - timeB;
            }

            if (!Number.isNaN(timeA) && Number.isNaN(timeB)) return -1;
            if (Number.isNaN(timeA) && !Number.isNaN(timeB)) return 1;

            const dateA = (a?.date || '').toString();
            const dateB = (b?.date || '').toString();
            const cmp = dateA.localeCompare(dateB);
            if (cmp !== 0) return cmp;

            const idA = (a?.id ?? a?.action_id ?? 0);
            const idB = (b?.id ?? b?.action_id ?? 0);
            return idA - idB;
        });

        let assetHistory = [];
        let serviceStartTime = null;
        let initialCash = null;

        // Load agent metadata if available (contains start_time, initial_cash, etc.)
        try {
            const marketConfig = this.getMarketConfig();
            const agentDataDir = marketConfig ? marketConfig.data_dir : 'agent_data';
            const metadataPath = `${this.baseDataPath}/${agentDataDir}/${agentName}/agent_config.json`;
            const metadataResponse = await fetch(metadataPath);
            if (metadataResponse.ok) {
                const metadata = await metadataResponse.json();
                serviceStartTime = metadata.start_time || null;
                initialCash = metadata.initial_cash ?? null;
            }
        } catch (error) {
            console.warn(`[loadAgentData] Unable to load metadata for ${agentName}:`, error.message);
        }

        if (initialCash === null) {
            const uiConfig = window.configLoader.getUIConfig();
            if (uiConfig && typeof uiConfig.initial_value === 'number') {
                initialCash = uiConfig.initial_value;
            }
        }

        if (this.currentMarket === 'cn') {
            // A-SHARES LOGIC: Handle multiple transactions per day AND fill date gaps

            // Detect if data is hourly or daily
            const firstDate = positions[0]?.date || '';
            const isHourlyData = firstDate.includes(':'); // Has time component

            console.log(`Detected ${isHourlyData ? 'hourly' : 'daily'} data format for ${agentName}`);

            // Group positions by DATE (for hourly data, group by date and take last entry)
            const positionsByDate = {};
            positions.forEach(position => {
                let dateKey;
                if (isHourlyData) {
                    // Extract date only: "2025-10-01 10:00:00" -> "2025-10-01"
                    dateKey = position.date.split(' ')[0];
                } else {
                    // Already in date format: "2025-10-01"
                    dateKey = position.date;
                }

                // Skip weekends when building position map
                const d = new Date(dateKey + 'T00:00:00');
                const dayOfWeek = d.getDay();
                if (dayOfWeek === 0 || dayOfWeek === 6) {
                    console.log(`Skipping weekend date ${dateKey} from position data`);
                    return; // Skip this position (it's a weekend)
                }

                // Keep the position with the highest ID for each date (most recent)
                if (!positionsByDate[dateKey] || position.id > positionsByDate[dateKey].id) {
                    positionsByDate[dateKey] = {
                        ...position,
                        dateKey: dateKey,  // Store normalized date for price lookup
                        originalDate: position.date  // Keep original for reference
                    };
                }
            });

            // Convert to array and sort by date
            const uniquePositions = Object.values(positionsByDate).sort((a, b) => {
                return a.dateKey.localeCompare(b.dateKey);
            });

            console.log(`Reduced from ${positions.length} to ${uniquePositions.length} unique daily positions for ${agentName}`);

            if (uniquePositions.length === 0) {
                console.warn(`No unique positions for ${agentName}`);
                return null;
            }

            // Get date range
            const startDate = new Date(uniquePositions[0].dateKey + 'T00:00:00');
            const endDate = new Date(uniquePositions[uniquePositions.length - 1].dateKey + 'T00:00:00');

            // Create a map of positions by date for quick lookup
            const positionMap = {};
            uniquePositions.forEach(pos => {
                positionMap[pos.dateKey] = pos;
            });

            // Fill all dates in range (skip weekends)
            let currentPosition = null;
            for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
                // Extract date string in local timezone (avoid UTC conversion issues)
                const year = d.getFullYear();
                const month = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                const dateStr = `${year}-${month}-${day}`;
                const dayOfWeek = d.getDay();

                // Skip weekends (Saturday = 6, Sunday = 0)
                if (dayOfWeek === 0 || dayOfWeek === 6) {
                    console.log(`Skipping weekend in gap-fill loop: ${dateStr} (day ${dayOfWeek})`);
                    continue;
                }

                // Use position for this date if exists, otherwise use last known position
                if (positionMap[dateStr]) {
                    currentPosition = positionMap[dateStr];
                }

                // Skip if we don't have any position yet
                if (!currentPosition) {
                    continue;
                }

                // Calculate asset value using current iteration date for price lookup
                // This ensures we get the price for the actual date we're calculating
                const assetValue = await this.calculateAssetValue(currentPosition, dateStr);

                // Only skip if we couldn't calculate asset value due to missing prices
                // Allow zero or negative values in case of losses
                if (assetValue === null || isNaN(assetValue)) {
                    console.warn(`Skipping date ${dateStr} for ${agentName} due to missing price data`);
                    continue;
                }

                assetHistory.push({
                    date: dateStr,
                    value: assetValue,
                    id: currentPosition.id,
                    action: positionMap[dateStr]?.this_action || null  // Only show action if position changed
                });
            }

        } else {
            // US STOCKS LOGIC: Keep original simple logic

            // Group positions by timestamp and take only the last position for each timestamp
            const positionsByTimestamp = {};
            positions.forEach(position => {
                const timestamp = position.date;
                if (!positionsByTimestamp[timestamp] || position.id > positionsByTimestamp[timestamp].id) {
                    positionsByTimestamp[timestamp] = position;
                }
            });

            // Convert to array and sort by timestamp
            const uniquePositions = Object.values(positionsByTimestamp).sort((a, b) => {
                if (a.date !== b.date) {
                    return a.date.localeCompare(b.date);
                }
                return a.id - b.id;
            });

            console.log(`Reduced from ${positions.length} to ${uniquePositions.length} unique positions for ${agentName}`);

            for (const position of uniquePositions) {
                const timestamp = position.date;
                const assetValue = await this.calculateAssetValue(position, timestamp);
                assetHistory.push({
                    date: timestamp,
                    value: assetValue,
                    id: position.id,
                    action: position.this_action || null
                });
            }
        }

        // Ensure asset history always starts at initial cash (for fair comparison)
        const fallbackInitial = initialCash ?? (positions[0]?.positions?.CASH ?? 10000);
        const timestampCandidates = [];
        if (serviceStartTime) timestampCandidates.push(serviceStartTime);
        if (positions[0]?.date) timestampCandidates.push(positions[0].date);
        const initialTimestamp = timestampCandidates.length > 0
            ? timestampCandidates.reduce((earliest, ts) => {
                  const currentValue = new Date(ts).valueOf();
                  const earliestValue = earliest !== null ? new Date(earliest).valueOf() : Number.POSITIVE_INFINITY;
                  return currentValue < earliestValue ? ts : earliest;
              }, timestampCandidates[0])
            : null;
        if (initialTimestamp) {
            const hasInitialEntry = assetHistory.some(entry => entry.date === initialTimestamp);
            if (hasInitialEntry) {
                assetHistory = assetHistory.map(entry =>
                    entry.date === initialTimestamp
                        ? { ...entry, value: fallbackInitial, id: `${agentName}-init`, action: null }
                        : entry
                );
            } else {
                assetHistory.push({
                    date: initialTimestamp,
                    value: fallbackInitial,
                    id: `${agentName}-init`,
                    action: null,
                });
            }
        }

        // Sort asset history chronologically after injecting initial entry
        if (assetHistory.length > 1) {
            assetHistory.sort((a, b) => a.date.localeCompare(b.date));
        }

        // Check if we have enough valid data
        if (assetHistory.length === 0) {
            console.error(`❌ ${agentName}: NO VALID ASSET HISTORY`);
            return null;
        }

        const assetValueMap = new Map(assetHistory.map(entry => [entry.date, entry.value]));
        const tradeMarkers = [];
        let prevEntryForTrade = null;
        let lastKnownAssetValue = assetHistory.length > 0 ? assetHistory[0].value : null;
        let lastKnownCash = initialCash ?? (positionsChronological[0]?.positions?.CASH ?? positions[0]?.positions?.CASH ?? null);

        positionsChronological.forEach(entry => {
            if (!entry) return;

            const assetKey = entry.dateKey || entry.date || null;
            const mappedValue = assetKey ? assetValueMap.get(assetKey) : undefined;

            if (!entry.this_action) {
                if (Number.isFinite(mappedValue)) {
                    lastKnownAssetValue = mappedValue;
                }
                if (typeof entry?.positions?.CASH === 'number') {
                    lastKnownCash = entry.positions.CASH;
                }
                prevEntryForTrade = entry;
                return;
            }

            const action = entry.this_action.action;
            if (!action || action === 'no_trade') {
                if (Number.isFinite(mappedValue)) {
                    lastKnownAssetValue = mappedValue;
                }
                if (typeof entry?.positions?.CASH === 'number') {
                    lastKnownCash = entry.positions.CASH;
                }
                prevEntryForTrade = entry;
                return;
            }

            const rawAmount = entry.this_action.amount;
            let amount = null;
            if (typeof rawAmount === 'number' && Number.isFinite(rawAmount)) {
                amount = rawAmount;
            } else if (typeof rawAmount === 'string') {
                const parsed = parseFloat(rawAmount);
                if (Number.isFinite(parsed)) {
                    amount = parsed;
                }
            }

            if (!amount || amount === 0) {
                if (Number.isFinite(mappedValue)) {
                    lastKnownAssetValue = mappedValue;
                }
                if (typeof entry?.positions?.CASH === 'number') {
                    lastKnownCash = entry.positions.CASH;
                }
                prevEntryForTrade = entry;
                return;
            }

            const prevPositionsSnapshot = prevEntryForTrade?.positions || null;
            const prevCash = (prevPositionsSnapshot && typeof prevPositionsSnapshot.CASH === 'number')
                ? prevPositionsSnapshot.CASH
                : (typeof lastKnownCash === 'number' ? lastKnownCash : null);

            const currentPositionsSnapshot = entry.positions || {};
            const currentCash = typeof currentPositionsSnapshot.CASH === 'number'
                ? currentPositionsSnapshot.CASH
                : null;

            if (typeof currentCash === 'number') {
                lastKnownCash = currentCash;
            }

            let executionPrice = null;
            if (prevCash !== null && currentCash !== null) {
                if (action === 'buy') {
                    const spent = prevCash - currentCash;
                    executionPrice = spent / amount;
                } else if (action === 'sell') {
                    const received = currentCash - prevCash;
                    executionPrice = received / amount;
                }
                if (!Number.isFinite(executionPrice)) {
                    executionPrice = null;
                }
            }

            const symbol = entry.this_action.symbol || entry.this_action.ticker || 'Unknown';
            const assetDate = assetKey || entry.date;

            const valueBefore = Number.isFinite(lastKnownAssetValue) ? lastKnownAssetValue : null;

            let valueAfter = mappedValue;
            if (valueAfter === undefined && assetDate && assetDate.includes(' ')) {
                const isoKey = assetDate.replace(' ', 'T');
                valueAfter = assetValueMap.get(isoKey);
            }
            if (valueAfter === undefined && entry.date && entry.date !== assetDate) {
                valueAfter = assetValueMap.get(entry.date);
            }
            if (valueAfter === undefined) {
                valueAfter = lastKnownAssetValue;
            }

            if (Number.isFinite(valueAfter)) {
                lastKnownAssetValue = valueAfter;
            }

            const sharesAfter = typeof currentPositionsSnapshot[symbol] === 'number'
                ? currentPositionsSnapshot[symbol]
                : null;

            tradeMarkers.push({
                id: entry.id ?? `${entry.date}-${action}-${symbol}-${amount}`,
                assetDate: assetDate,
                timestamp: entry.date,
                action,
                symbol,
                amount,
                price: executionPrice,
                cashAfter: currentCash,
                cashBefore: prevCash,
                sharesAfter,
                valueAfter: valueAfter ?? null,
                valueBefore: valueBefore ?? null,
                valueChange: (Number.isFinite(valueAfter) && Number.isFinite(valueBefore))
                    ? valueAfter - valueBefore
                    : null,
                positionsSnapshot: currentPositionsSnapshot,
                rawAction: entry.this_action
            });

            prevEntryForTrade = entry;
        });

        const mergedTradeMarkers = this.mergeTradeMarkers(tradeMarkers);
        console.log(`[loadAgentData] ${agentName} trade markers computed: ${tradeMarkers.length}, merged down to ${mergedTradeMarkers.length}`);

        const result = {
            name: agentName,
            positions: positions,
            assetHistory: assetHistory,
            initialValue: assetHistory[0]?.value ?? initialCash ?? 10000,
            currentValue: assetHistory[assetHistory.length - 1]?.value || 0,
            return: assetHistory.length > 0
                ? ((assetHistory[assetHistory.length - 1].value - assetHistory[0].value) / assetHistory[0].value * 100)
                : 0,
            startTime: serviceStartTime,
            initialCash: initialCash,
            tradeMarkers: mergedTradeMarkers,
        };

        console.log(`Successfully loaded data for ${agentName}:`, {
            positions: positions.length,
            assetHistory: assetHistory.length,
            initialValue: result.initialValue,
            currentValue: result.currentValue,
            return: result.return,
            dateRange: assetHistory.length > 0 ?
                `${assetHistory[0].date} to ${assetHistory[assetHistory.length - 1].date}` : 'N/A',
            sampleDates: assetHistory.slice(0, 5).map(h => h.date)
        });

        return result;
    }

    firstDefined(...values) {
        for (const value of values) {
            if (value !== undefined && value !== null) {
                return value;
            }
        }
        return undefined;
    }

    firstFinite(...values) {
        for (const value of values) {
            if (Number.isFinite(value)) {
                return value;
            }
        }
        return null;
    }

    computeWeightedPrice(signedExisting, existing, signedIncoming, incoming) {
        let totalNotional = 0;
        let totalAmount = 0;

        if (Number.isFinite(existing.price) && Number.isFinite(existing.amount)) {
            totalNotional += Math.abs(existing.price * signedExisting);
            totalAmount += Math.abs(signedExisting);
        }

        if (Number.isFinite(incoming.price) && Number.isFinite(incoming.amount)) {
            totalNotional += Math.abs(incoming.price * signedIncoming);
            totalAmount += Math.abs(signedIncoming);
        }

        if (totalAmount === 0) {
            return null;
        }

        const weighted = totalNotional / totalAmount;
        return Number.isFinite(weighted) ? weighted : null;
    }

    combineTradeMarkers(existing, incoming) {
        const existingAmount = Number.isFinite(existing.amount) ? existing.amount : 0;
        const incomingAmount = Number.isFinite(incoming.amount) ? incoming.amount : 0;

        const signedExisting = (existing.action === 'sell' ? -1 : 1) * existingAmount;
        const signedIncoming = (incoming.action === 'sell' ? -1 : 1) * incomingAmount;

        const netSigned = signedExisting + signedIncoming;
        if (!Number.isFinite(netSigned)) {
            return { ...existing };
        }

        const cashBefore = this.firstDefined(existing.cashBefore, incoming.cashBefore);
        const cashAfter = this.firstDefined(incoming.cashAfter, existing.cashAfter);

        const valueBefore = this.firstFinite(existing.valueBefore, incoming.valueBefore);
        const valueAfter = this.firstFinite(incoming.valueAfter, existing.valueAfter);

        const result = {
            ...existing,
            amount: Math.abs(netSigned),
            action: netSigned >= 0 ? 'buy' : 'sell',
            cashBefore: cashBefore !== undefined ? cashBefore : null,
            cashAfter: cashAfter !== undefined ? cashAfter : null,
            price: null,
            valueBefore: valueBefore !== null ? valueBefore : null,
            valueAfter: valueAfter !== null ? valueAfter : null,
            valueChange: null,
            positionsSnapshot: incoming.positionsSnapshot || existing.positionsSnapshot,
            rawAction:
                Array.isArray(existing.rawAction)
                    ? [...existing.rawAction, incoming.rawAction]
                    : existing.rawAction
                        ? [existing.rawAction, incoming.rawAction]
                        : incoming.rawAction,
        };

        if (result.valueBefore !== null && result.valueAfter !== null) {
            result.valueChange = result.valueAfter - result.valueBefore;
        }

        if (result.cashBefore !== null && result.cashAfter !== null && result.amount > 0) {
            if (result.action === 'buy') {
                const spent = result.cashBefore - result.cashAfter;
                const price = spent / result.amount;
                result.price = Number.isFinite(price) ? price : null;
            } else {
                const received = result.cashAfter - result.cashBefore;
                const price = received / result.amount;
                result.price = Number.isFinite(price) ? price : null;
            }
        }

        if (result.price === null) {
            result.price = this.computeWeightedPrice(
                signedExisting,
                existing,
                signedIncoming,
                incoming
            );
        }

        // Recalculate sharesAfter from the final positionsSnapshot
        const symbol = result.symbol || existing.symbol || incoming.symbol;
        if (symbol && result.positionsSnapshot) {
            result.sharesAfter = typeof result.positionsSnapshot[symbol] === 'number'
                ? result.positionsSnapshot[symbol]
                : null;
        } else {
            // Fallback to incoming sharesAfter if positionsSnapshot is not available
            result.sharesAfter = incoming.sharesAfter !== undefined ? incoming.sharesAfter : existing.sharesAfter;
        }

        result.id = `${result.timestamp || result.assetDate}-${result.action}-${result.symbol}-${result.amount}`;

        return result.amount > 0 ? result : null;
    }

    mergeTradeMarkers(markers) {
        if (!Array.isArray(markers) || markers.length === 0) {
            return [];
        }

        const merged = [];

        markers.forEach(marker => {
            if (!marker) {
                return;
            }

            const previous = merged[merged.length - 1];

            if (
                previous &&
                previous.timestamp === marker.timestamp &&
                previous.symbol === marker.symbol
            ) {
                const combined = this.combineTradeMarkers(previous, marker);
                if (combined) {
                    merged[merged.length - 1] = combined;
                } else {
                    merged.pop();
                }
            } else {
                merged.push({ ...marker });
            }
        });

        return merged;
    }

    // Load benchmark data (QQQ for US, SSE 50 for A-shares)
    async loadBenchmarkData() {
        const marketConfig = this.getMarketConfig();
        if (!marketConfig) {
            return await this.loadQQQData();
        }

        if (this.currentMarket === 'us') {
            return await this.loadQQQData();
        } else if (this.currentMarket === 'cn') {
            return await this.loadSSE50Data();
        }

        return null;
    }

    // Load SSE 50 Index data for A-shares
    async loadSSE50Data() {
        try {
            console.log('Loading SSE 50 Index data...');
            const marketConfig = this.getMarketConfig();
            const benchmarkFile = marketConfig ? marketConfig.benchmark_file : 'A_stock/index_daily_sse_50.json';

            const response = await fetch(`${this.baseDataPath}/${benchmarkFile}`);
            if (!response.ok) throw new Error('Failed to load SSE 50 Index data');

            const data = await response.json();
            const timeSeries = data['Time Series (Daily)'];

            if (!timeSeries) {
                console.warn('SSE 50 Index data not found');
                return null;
            }

            const benchmarkName = marketConfig ? marketConfig.benchmark_display_name : 'SSE 50';
            return this.createBenchmarkAssetHistory(benchmarkName, timeSeries, 'CNY');
        } catch (error) {
            console.error('Error loading SSE 50 data:', error);
            return null;
        }
    }

    // Load QQQ invesco data
    async loadQQQData() {
        try {
            console.log('Loading QQQ invesco data...');
            const benchmarkFile = window.configLoader.getBenchmarkFile();
            const response = await fetch(`${this.baseDataPath}/${benchmarkFile}`);
            if (!response.ok) throw new Error('Failed to load QQQ data');

            const data = await response.json();
            // Support both hourly (60min) and daily data formats
            const timeSeries = data['Time Series (60min)'] || data['Time Series (Daily)'];

            return this.createBenchmarkAssetHistory('QQQ Invesco', timeSeries, 'USD');
        } catch (error) {
            console.error('Error loading QQQ data:', error);
            return null;
        }
    }

    // Create benchmark asset history from time series data
    createBenchmarkAssetHistory(name, timeSeries, currency) {
        try {
            // Convert to asset history format
            const assetHistory = [];
            const dates = Object.keys(timeSeries).sort();

            // Calculate benchmark performance starting from first agent's initial value
            const agentNames = Object.keys(this.agentData);
            const uiConfig = window.configLoader.getUIConfig();
            let initialValue = uiConfig.initial_value; // Default initial value from config

            if (agentNames.length > 0) {
                const firstAgent = this.agentData[agentNames[0]];
                if (firstAgent && firstAgent.assetHistory.length > 0) {
                    initialValue = firstAgent.assetHistory[0].value;
                }
            }

            // Find the earliest start date and latest end date across all agents
            let startDate = null;
            let endDate = null;
            if (agentNames.length > 0) {
                agentNames.forEach(agentName => {
                    const agent = this.agentData[agentName];
                    if (agent && agent.assetHistory.length > 0) {
                        const agentStartDate = agent.assetHistory[0].date;
                        const agentEndDate = agent.assetHistory[agent.assetHistory.length - 1].date;

                        if (!startDate || agentStartDate < startDate) {
                            startDate = agentStartDate;
                        }
                        if (!endDate || agentEndDate > endDate) {
                            endDate = agentEndDate;
                        }
                    }
                });
            }

            let benchmarkStartPrice = null;
            let currentValue = initialValue;

            for (const date of dates) {
                if (startDate && date < startDate) continue;
                if (endDate && date > endDate) continue;

                // Support both US format ('4. close') and A-share format ('4. sell price')
                const closePrice = timeSeries[date]['4. close'] || timeSeries[date]['4. sell price'];
                if (!closePrice) continue;

                const price = parseFloat(closePrice);
                if (!benchmarkStartPrice) {
                    benchmarkStartPrice = price;
                }

                // Calculate benchmark performance relative to start
                const benchmarkReturn = (price - benchmarkStartPrice) / benchmarkStartPrice;
                currentValue = initialValue * (1 + benchmarkReturn);

                assetHistory.push({
                    date: date,
                    value: currentValue,
                    id: `${name.toLowerCase().replace(/\s+/g, '-')}-${date}`,
                    action: null
                });
            }

            const result = {
                name: name,
                positions: [],
                assetHistory: assetHistory,
                initialValue: initialValue,
                currentValue: assetHistory.length > 0 ? assetHistory[assetHistory.length - 1].value : initialValue,
                return: assetHistory.length > 0 ?
                    ((assetHistory[assetHistory.length - 1].value - assetHistory[0].value) / assetHistory[0].value * 100) : 0,
                currency: currency
            };

            console.log(`Successfully loaded ${name} data:`, {
                assetHistory: assetHistory.length,
                initialValue: result.initialValue,
                currentValue: result.currentValue,
                return: result.return
            });

            return result;
        } catch (error) {
            console.error(`Error creating benchmark asset history for ${name}:`, error);
            return null;
        }
    }

    // Load all agents data
    async loadAllAgentsData() {
        console.log('Starting to load all agents data...');
        const agents = await this.loadAgentList();
        console.log('Found agents:', agents);
        const allData = {};

        for (const agent of agents) {
            console.log(`Loading data for ${agent}...`);
            const data = await this.loadAgentData(agent);
            if (data) {
                allData[agent] = data;
                console.log(`Successfully added ${agent} to allData`);
            } else {
                console.log(`Failed to load data for ${agent}`);
            }
        }

        console.log('Final allData:', Object.keys(allData));
        this.agentData = allData;

        // Load benchmark data (QQQ for US, SSE 50 for A-shares)
        const benchmarkData = await this.loadBenchmarkData();
        if (benchmarkData) {
            allData[benchmarkData.name] = benchmarkData;
            console.log(`Successfully added ${benchmarkData.name} to allData`);
        }

        await this.computeBuyHoldBaseline(allData);

        console.log('Final allData (after baseline):', Object.keys(allData));
        return allData;
    }

    // Get current holdings for an agent (latest position)
    getCurrentHoldings(agentName) {
        const data = this.agentData[agentName];
        if (!data || !data.positions || data.positions.length === 0) return null;

        const latestPosition = data.positions[data.positions.length - 1];
        return latestPosition && latestPosition.positions ? latestPosition.positions : null;
    }

    async computeBuyHoldBaseline(allData) {
        try {
            if (this.getMarket() !== 'us_5min') {
                this.buyHoldSeries = null;
                return;
            }

            const entries = Object.entries(allData).filter(([name, data]) => {
                if (!data || !data.assetHistory || data.assetHistory.length === 0) {
                    return false;
                }
                const lower = name.toLowerCase();
                return !lower.includes('qqq') && !lower.includes('sse');
            });

            const referenceEntry = entries.find(([name]) => {
                return !/buy[- ]?and[- ]?hold/i.test(name);
            }) || entries[0];

            if (!referenceEntry) {
                console.warn('Buy-and-hold baseline: no reference agent found.');
                this.buyHoldSeries = null;
                return;
            }

            const [referenceName, referenceData] = referenceEntry;
            const initialValue = referenceData.initialValue ?? (referenceData.assetHistory[0]?.value ?? 10000);
            const candidatePositions = referenceData.positions || [];
            const explicitSymbols = referenceData.stockSymbols || [];
            let primarySymbol = explicitSymbols.find(symbol => !!symbol) || null;

            if (!primarySymbol) {
                for (const entry of candidatePositions) {
                    if (entry && entry.positions) {
                        const symbols = Object.keys(entry.positions).filter(key => key !== 'CASH');
                        if (symbols.length > 0) {
                            primarySymbol = symbols[0];
                            break;
                        }
                    }
                }
            }

            const series = [];
            let sharesHeld = null;
            let lastValue = initialValue;

            const computeBaselineValue = async (date) => {
                if (!primarySymbol) {
                    return lastValue;
                }

                const price = await this.getClosingPrice(primarySymbol, date);
                if (!price || !Number.isFinite(price) || price <= 0) {
                    return lastValue;
                }

                if (sharesHeld === null) {
                    sharesHeld = initialValue / price;
                }
                return sharesHeld * price;
            };

            for (const entry of referenceData.assetHistory) {
                const value = await computeBaselineValue(entry.date);
                lastValue = value ?? lastValue;

                series.push({
                    date: entry.date,
                    value: lastValue ?? initialValue
                });
            }

            if (series.length === 0) {
                console.warn('Buy-and-hold baseline: produced empty series.');
                this.buyHoldSeries = null;
                return;
            }

            this.buyHoldSeries = series;
            console.log(`Buy-and-hold baseline seeded from ${referenceName} with ${series.length} points.`);
        } catch (error) {
            console.warn('Failed to compute buy-and-hold baseline:', error);
            this.buyHoldSeries = null;
        }
    }

    getBuyHoldSeries() {
        return this.buyHoldSeries || [];
    }

    // Get trade history for an agent
    getTradeHistory(agentName) {
        const data = this.agentData[agentName];
        if (!data) {
            console.log(`[getTradeHistory] No data for agent: ${agentName}`);
            return [];
        }

        if (data.tradeMarkers && data.tradeMarkers.length > 0) {
            return data.tradeMarkers.map(marker => ({
                date: marker.timestamp || marker.assetDate,
                action: marker.action,
                symbol: marker.symbol,
                amount: marker.amount,
                positions: marker.positionsSnapshot,
                price: marker.price ?? undefined
            })).reverse();
        }

        console.log(`[getTradeHistory] Agent: ${agentName}, Total positions: ${data.positions.length}`);

        const allActions = data.positions.filter(p => p.this_action);
        console.log(`[getTradeHistory] Positions with this_action: ${allActions.length}`);

        const trades = [];
        let prevEntry = null;
        const initialCash = data.initialCash ?? (data.positions[0]?.positions?.CASH ?? 0);

        data.positions.forEach(entry => {
            if (!entry || !entry.this_action) {
                prevEntry = entry;
                return;
            }

            const action = entry.this_action.action;
            if (action === 'no_trade') {
                prevEntry = entry;
                return;
            }

            const rawAmount = entry.this_action.amount;
            let amount = 0;
            if (typeof rawAmount === 'number') {
                amount = rawAmount;
            } else if (typeof rawAmount === 'string') {
                const parsed = parseFloat(rawAmount);
                amount = Number.isFinite(parsed) ? parsed : 0;
            }
            if (!amount || amount === 0) {
                prevEntry = entry;
                return;
            }

            const symbol = entry.this_action.symbol;
            const currentPositions = entry.positions || {};
            const prevPositions = prevEntry?.positions || null;
            const prevCash = prevPositions && typeof prevPositions.CASH === 'number'
                ? prevPositions.CASH
                : initialCash;
            const currentCash = typeof currentPositions.CASH === 'number'
                ? currentPositions.CASH
                : null;

            let price = undefined;
            if (prevCash !== null && currentCash !== null) {
                if (action === 'buy') {
                    const spent = prevCash - currentCash;
                    price = spent / amount;
                } else if (action === 'sell') {
                    const received = currentCash - prevCash;
                    price = received / amount;
                }
                if (!Number.isFinite(price)) {
                    price = undefined;
                }
            }

            trades.push({
                date: entry.date,
                action,
                symbol,
                amount,
                positions: currentPositions,
                price
            });

            prevEntry = entry;
        });

        trades.reverse(); // Most recent first

        console.log(`[getTradeHistory] Actual trades (excluding no_trade): ${trades.length}`);
        console.log(`[getTradeHistory] First 3 trades:`, trades.slice(0, 3));

        return trades;
    }

    // Format number as currency
    formatCurrency(value) {
        const marketConfig = this.getMarketConfig();
        const currency = marketConfig ? marketConfig.currency : 'USD';
        const locale = this.currentMarket === 'us' ? 'en-US' : 'zh-CN';

        return new Intl.NumberFormat(locale, {
            style: 'currency',
            currency: currency,
            minimumFractionDigits: 2
        }).format(value);
    }

    // Format percentage
    formatPercent(value) {
        const sign = value >= 0 ? '+' : '';
        return `${sign}${value.toFixed(2)}%`;
    }

    // Get nice display name for agent
    getAgentDisplayName(agentName) {
        const liveMeta = this.liveAgentMetadata[agentName];
        if (liveMeta && liveMeta.display_name) {
            return liveMeta.display_name;
        }
        const displayName = window.configLoader.getDisplayName(agentName, this.currentMarket);
        if (displayName) return displayName;

        // Fallback to legacy names
        const names = {
            'gemini-2.5-flash': 'Gemini-2.5-flash',
            'qwen3-max': 'Qwen3-max',
            'MiniMax-M2': 'MiniMax-M2',
            'gpt-5': 'GPT-5',
            'deepseek-chat-v3.1': 'DeepSeek-v3.1',
            'claude-3.7-sonnet': 'Claude 3.7 Sonnet',
            'QQQ Invesco': 'QQQ ETF',
            'SSE 50 Index': 'SSE 50 Index'
        };
        return names[agentName] || agentName;
    }

    // Get icon for agent (SVG file path)
    getAgentIcon(agentName) {
        const liveMeta = this.liveAgentMetadata[agentName];
        if (liveMeta && liveMeta.icon) {
            return liveMeta.icon;
        }
        const icon = window.configLoader.getIcon(agentName, this.currentMarket);
        if (icon) return icon;

        // Fallback to legacy icons
        const icons = {
            'gemini-2.5-flash': './figs/google.svg',
            'qwen3-max': './figs/qwen.svg',
            'MiniMax-M2': './figs/minimax.svg',
            'gpt-5': './figs/openai.svg',
            'claude-3.7-sonnet': './figs/claude-color.svg',
            'deepseek-chat-v3.1': './figs/deepseek.svg',
            'QQQ Invesco': './figs/stock.svg',
            'SSE 50 Index': './figs/stock.svg',
            'buy-and-hold': './figs/buy-hold.svg'
        };
        return icons[agentName] || './figs/stock.svg';
    }

    // Get agent name without version suffix for icon lookup
    getAgentIconKey(agentName) {
        // This method is kept for backward compatibility
        return agentName;
    }

    // Get brand color for agent
    getAgentBrandColor(agentName) {
        const liveMeta = this.liveAgentMetadata[agentName];
        if (liveMeta && liveMeta.color) {
            return liveMeta.color;
        }
        const color = window.configLoader.getColor(agentName, this.currentMarket);
        console.log(`[getAgentBrandColor] agentName: ${agentName}, market: ${this.currentMarket}, color: ${color}`);
        if (color) return color;

        // Fallback to legacy colors
        const colors = {
            'gemini-2.5-flash': '#8A2BE2',
            'qwen3-max': '#0066ff',
            'MiniMax-M2': '#ff0000',
            'gpt-5': '#10a37f',
            'deepseek-chat-v3.1': '#4a90e2',
            'claude-3.7-sonnet': '#cc785c',
            'QQQ Invesco': '#ff6b00',
            'SSE 50 Index': '#e74c3c'
        };
        return colors[agentName] || null;
    }
}

// Export for use in other modules
window.DataLoader = DataLoader;