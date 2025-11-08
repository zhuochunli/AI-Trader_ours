/**
 * Live 5-Min Trading Auto-Loader
 * Automatically detects and loads agent data from agent_data_5min directory
 */

// Auto-refresh interval (in milliseconds)
const REFRESH_INTERVAL = 60000; // 60 seconds (1 minute)
let refreshTimer = null;
let currentLoadFunction = null;
let lastRefreshTime = 0;

/**
 * Load agent configuration from agent_config.json
 */
async function loadLiveAgentConfig(marketConfig, agentFolder) {
    try {
        const configPath = `./data/${marketConfig.data_dir}/${agentFolder}/agent_config.json`;
        const response = await fetch(configPath);
        if (!response.ok) {
            return null;
        }
        
        const config = await response.json();
        return config;
    } catch (error) {
        return null;
    }
}

/**
 * Auto-detect agents from agent_data_5min directory
 * by checking which folders have agent_config.json
 */
async function autoDetectLiveAgents(marketConfig) {
    const agents = [];
    
    // Try to detect agents by checking for position.jsonl files
    // This is more reliable than checking for specific folder names
    const possibleAgents = [
        'gpt-4o-mini',
        'gpt-4o',
        'gpt-4',
        'claude-3.7-sonnet',
        'gemini-2.5-flash',
        'deepseek-chat',
        'qwen3-max',
        'gpt-4o-5min',
        'gpt-4-5min',
        'claude-3.7-sonnet-5min',
        'gemini-2.5-flash-5min',
        'deepseek-chat-v3.1-5min',
        'qwen3-max-5min'
    ];
    
    for (const agentFolder of possibleAgents) {
        try {
            // Try to load agent_config.json first
            const config = await loadLiveAgentConfig(marketConfig, agentFolder);
            if (config) {
                agents.push({
                    folder: agentFolder,
                    display_name: config.display_name || agentFolder,
                    icon: getIconForModel(config.basemodel),
                    color: config.color || '#3a86ff',
                    stock_symbols: config.stock_symbols || [],
                    live_mode: config.live_mode || false,
                    start_time: config.start_time,
                    enabled: true
                });
            }
        } catch (error) {
            // Agent doesn't exist, skip
        }
    }
    
    console.log(`🔴 Found ${agents.length} live agent(s)`);
    return agents;
}

/**
 * Get icon path based on model name
 */
function getIconForModel(modelName) {
    const model = (modelName || '').toLowerCase();
    if (model.includes('gpt') || model.includes('openai')) {
        return './figs/openai.svg';
    } else if (model.includes('claude') || model.includes('anthropic')) {
        return './figs/claude-color.svg';
    } else if (model.includes('gemini') || model.includes('google')) {
        return './figs/google.svg';
    } else if (model.includes('deepseek')) {
        return './figs/deepseek.svg';
    } else if (model.includes('qwen')) {
        return './figs/qwen.svg';
    }
    return './figs/stock.svg';
}

/**
 * Start auto-refresh for live data
 * Handles tab switching using Page Visibility API
 */
function startLiveRefresh(loadDataFunction) {
    // Store the load function for visibility change handler
    currentLoadFunction = loadDataFunction;
    
    // Clear existing timer
    if (refreshTimer) {
        clearInterval(refreshTimer);
    }
    
    // Set up new refresh timer
    refreshTimer = setInterval(() => {
        console.log('🔄 Auto-refreshing live data...');
        loadDataFunction();
        lastRefreshTime = Date.now();
    }, REFRESH_INTERVAL);
    
    // Handle tab switching - refresh immediately when user returns to the tab
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    console.log(`✅ Live refresh enabled (every ${REFRESH_INTERVAL/1000}s)`);
    console.log('✅ Tab switch detection enabled - will refresh when you return to this tab');
}

/**
 * Handle visibility change - refresh data when tab becomes visible
 */
function handleVisibilityChange() {
    if (!document.hidden && currentLoadFunction) {
        const timeSinceLastRefresh = Date.now() - lastRefreshTime;
        
        // Only refresh if it's been more than 5 seconds since last refresh
        // This prevents double-refreshing if the interval just fired
        if (timeSinceLastRefresh > 5000) {
            console.log('👀 Tab became visible - refreshing data...');
            currentLoadFunction();
            lastRefreshTime = Date.now();
        }
    }
}

/**
 * Stop auto-refresh
 */
function stopLiveRefresh() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
        console.log('⏸️ Live refresh stopped');
    }
    
    // Remove visibility change listener
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    currentLoadFunction = null;
}


/**
 * Show last update time
 */
function updateLastRefreshTime() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString();
    
    // Add/update last refresh indicator
    let refreshIndicator = document.getElementById('lastRefresh');
    if (!refreshIndicator) {
        refreshIndicator = document.createElement('div');
        refreshIndicator.id = 'lastRefresh';
        refreshIndicator.style.cssText = 'position: fixed; bottom: 20px; right: 20px; background: rgba(0,0,0,0.7); color: white; padding: 8px 12px; border-radius: 4px; font-size: 12px; z-index: 1000;';
        document.body.appendChild(refreshIndicator);
    }
    
    refreshIndicator.textContent = `Last updated: ${timeStr}`;
}

// Export functions
window.LiveLoader = {
    autoDetectLiveAgents,
    loadLiveAgentConfig,
    startLiveRefresh,
    stopLiveRefresh,
    updateLastRefreshTime
};

