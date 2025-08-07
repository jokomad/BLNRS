const https = require('https');
const express = require('express');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const SignalDetector = require('./signalDetector');

const PORT = process.env.PORT || 3000;
const app = express();

// Store messages in memory (last 100)
const telegramMessages = [];

// WebSocket clients
const wsClients = new Set();
const BYBIT_TICKERS_URL = 'https://api.bybit.com/v5/market/tickers?category=linear';

// Telegram configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '7670597940:AAFa701w9UEKrp5TMO2fhJJdPIQvNlbgt4o';
const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID || '-1002448457816';

// Signal filtering configuration
const MIN_GAIN_THRESHOLD = parseFloat(process.env.MIN_GAIN_THRESHOLD) || 4.0;

// Initialize Telegram bot
const telegram = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// Function to fetch tickers data from Bybit API
function fetchBybitTickers() {
    return new Promise((resolve, reject) => {
        https.get(BYBIT_TICKERS_URL, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const jsonData = JSON.parse(data);
                    resolve(jsonData);
                } catch (error) {
                    reject(new Error('Failed to parse JSON response'));
                }
            });
        }).on('error', (error) => {
            reject(error);
        });
    });
}

// Function to fetch candle data for a specific symbol
function fetchCandlesForSymbol(symbol) {
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=1&limit=1000`;
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const jsonData = JSON.parse(data);
                    resolve({ symbol, data: jsonData });
                } catch (error) {
                    reject(new Error(`Failed to parse JSON response for ${symbol}`));
                }
            });
        }).on('error', (error) => reject(error));
    });
}

// Function to process symbols in batches
async function processCandleBatches(symbols, batchSize = 120, delayMs = 10) {
    const results = [];
    for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        const batchPromises = batch.map(symbol => fetchCandlesForSymbol(symbol));
        
        try {
            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);
            console.log(`Processed batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(symbols.length/batchSize)}`);
            
            if (i + batchSize < symbols.length) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        } catch (error) {
            console.error(`Error processing batch: ${error.message}`);
        }
    }
    return results;
}

// Serve static files from public directory
app.use(express.static('public'));

// Function to add message to storage
function addTelegramMessage(text, imageBuffer = null) {
    const message = {
        id: Date.now(),
        text: text,
        timestamp: new Date().toISOString(),
        image: imageBuffer ? `data:image/png;base64,${imageBuffer.toString('base64')}` : null
    };

    // Add to beginning of array (newest first)
    telegramMessages.unshift(message);

    // Keep only last 100 messages
    if (telegramMessages.length > 100) {
        telegramMessages.splice(100);
    }

    // Also remove messages older than 24 hours (safety cleanup)
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const initialLength = telegramMessages.length;
    telegramMessages.splice(0, telegramMessages.length, ...telegramMessages.filter(msg =>
        new Date(msg.timestamp).getTime() > oneDayAgo
    ));

    if (telegramMessages.length < initialLength) {
        console.log(`🗑️ Cleaned up ${initialLength - telegramMessages.length} old messages (>24h)`);
    }

    // Broadcast to all WebSocket clients
    const wsMessage = JSON.stringify({
        type: 'new_message',
        message: message
    });

    // Clean up dead connections and broadcast
    const deadClients = [];
    wsClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(wsMessage);
            } catch (error) {
                console.log('📱 Failed to send to client, marking for removal');
                deadClients.push(client);
            }
        } else {
            deadClients.push(client);
        }
    });

    // Remove dead connections
    deadClients.forEach(client => wsClients.delete(client));

    console.log(`📝 Stored and broadcasted message: ${text.split('\n')[0]}`);
}

// API endpoint to get messages
app.get('/api/messages', (req, res) => {
    res.json({
        messages: telegramMessages,
        total: telegramMessages.length,
        timestamp: new Date().toISOString()
    });
});

// Express routes
app.get('/dashboard', (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Bybit Signal Detector</title>
        <style>
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                margin: 0;
                padding: 0;
                min-height: 100vh;
                display: flex;
                justify-content: center;
                align-items: center;
                color: white;
            }
            .container {
                text-align: center;
                background: rgba(255, 255, 255, 0.1);
                padding: 40px;
                border-radius: 20px;
                backdrop-filter: blur(10px);
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
                border: 1px solid rgba(255, 255, 255, 0.2);
            }
            h1 {
                font-size: 3em;
                margin-bottom: 20px;
                text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
            }
            .status {
                font-size: 1.2em;
                margin: 20px 0;
                padding: 15px;
                background: rgba(255, 255, 255, 0.1);
                border-radius: 10px;
                border-left: 4px solid #4CAF50;
            }
            .features {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 20px;
                margin-top: 30px;
            }
            .feature {
                background: rgba(255, 255, 255, 0.1);
                padding: 20px;
                border-radius: 10px;
                border-left: 4px solid #2196F3;
            }
            .emoji {
                font-size: 2em;
                margin-bottom: 10px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🚀 Welcome to Bybit Signal Detector</h1>
            <div class="status">
                ✅ Server is running and monitoring signals
            </div>
            <div class="features">
                <div class="feature">
                    <div class="emoji">📊</div>
                    <h3>Real-time Scanning</h3>
                    <p>Monitors 280+ USDT pairs every minute</p>
                </div>
                <div class="feature">
                    <div class="emoji">📈</div>
                    <h3>Regression Channels</h3>
                    <p>Detects channel breakouts and crossings</p>
                </div>
                <div class="feature">
                    <div class="emoji">📱</div>
                    <h3>Telegram Alerts</h3>
                    <p>Instant notifications with charts</p>
                </div>
                <div class="feature">
                    <div class="emoji">🌙</div>
                    <h3>Quiet Hours</h3>
                    <p>No alerts 00:00-06:00 UTC+2</p>
                </div>
            </div>
        </div>
    </body>
    </html>
    `;
    res.send(html);
});

app.get('/status', (req, res) => {
    res.json({
        status: 'running',
        message: 'Bybit Signal Detector is active',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: process.version,
        stats: {
            storedMessages: telegramMessages.length,
            wsClients: wsClients.size,
            lastMessage: telegramMessages.length > 0 ? telegramMessages[0].timestamp : null,
            minGainThreshold: MIN_GAIN_THRESHOLD
        }
    });
});

// Health check endpoint for Koyeb
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy' });
});

// Ping endpoint
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// Ticker scanner class
class TickerScanner {
    constructor() {
        this.isRunning = false;
        this.intervalId = null;
        this.filteredPairs = [];
        this.telegram = telegram; // Add telegram instance
        this.api = {
            getCandles: async (symbol) => {
                const result = await fetchCandlesForSymbol(symbol);
                return result.data.result.list; // Extract the candles array
            },
            get: async (url) => {
                return new Promise((resolve, reject) => {
                    const fullUrl = `https://api.bybit.com${url}`;
                    https.get(fullUrl, (res) => {
                        let data = '';
                        res.on('data', (chunk) => data += chunk);
                        res.on('end', () => {
                            try {
                                const jsonData = JSON.parse(data);
                                resolve(jsonData);
                            } catch (error) {
                                reject(new Error('Failed to parse JSON response'));
                            }
                        });
                    }).on('error', (error) => {
                        reject(error);
                    });
                });
            }
        }; // Create API object with getCandles and get methods
    }

    async filterOutDelistingPairs(tickers) {
        try {
            // Get ALL linear instruments info in one API call
            const response = await this.api.get('/v5/market/instruments-info?category=linear&limit=1000');

            if (response?.result?.list) {
                const allInstruments = response.result.list;
                console.log(`Retrieved ${allInstruments.length} instruments from API`);

                // Create a map for fast lookup of delisting status
                const instrumentMap = new Map();
                allInstruments.forEach(instrument => {
                    instrumentMap.set(instrument.symbol, instrument.deliveryTime > 0);
                });

                // Filter out delisting pairs
                const nonDelistingTickers = tickers.filter(ticker => {
                    const isDelisting = instrumentMap.get(ticker.symbol);
                    if (isDelisting) {
                        console.log(`⚠️ Filtering out delisting symbol: ${ticker.symbol}`);
                        return false;
                    }
                    return true;
                });

                console.log(`Filtered out ${tickers.length - nonDelistingTickers.length} delisting symbols`);
                return nonDelistingTickers;
            } else {
                console.error('Failed to get instruments info from API, keeping all symbols');
                return tickers; // Fallback: keep all symbols if API fails
            }
        } catch (error) {
            console.error(`Error checking delisting status: ${error.message}, keeping all symbols`);
            return tickers; // Fallback: keep all symbols if error
        }
    }

    async fetchTickers() {
        try {
            const tickersData = await fetchBybitTickers();

            if (tickersData.retCode === 0) {
                // Filter USDT pairs with turnover24h > 1,000,000
                const filteredTickers = tickersData.result.list
                    .filter(ticker =>
                        ticker.symbol.endsWith('USDT') &&
                        parseFloat(ticker.turnover24h) > 1000000
                    );

                const now = new Date();
                const timeString = now.toTimeString().split(' ')[0]; // HH:MM:SS format
                console.log(`\n[${timeString}] Fetched ${filteredTickers.length} USDT pairs with turnover > 1M`);

                // Check delisting status for all filtered pairs upfront
                console.log('Checking delisting status for all pairs...');
                const nonDelistingPairs = await this.filterOutDelistingPairs(filteredTickers);

                this.filteredPairs = nonDelistingPairs.map(ticker => ticker.symbol);
                console.log(`After filtering delisting: ${this.filteredPairs.length} pairs remaining`);
                
                // Create signal detector with current non-delisting tickers data
                this.signalDetector = new SignalDetector(this.api, this.telegram, nonDelistingPairs, TELEGRAM_GROUP_ID, (text, imageBuffer) => addTelegramMessage(text, imageBuffer), MIN_GAIN_THRESHOLD);

                // Fetch candles and check for signals
                console.log('Fetching candles for all pairs...');
                const candleResults = await processCandleBatches(this.filteredPairs);

                // Check for channel crosses using SignalDetector with pre-fetched candle data
                const validCandleResults = candleResults
                    .filter(result => result.data.retCode === 0 && result.data.result.list.length > 0);

                if (validCandleResults.length > 0) {
                    await this.signalDetector.checkSymbolsWithCandleData(validCandleResults);
                } else {
                    console.log('\nNo valid candle data found.');
                }
            }
        } catch (error) {
            console.error('Error in fetchTickers:', error.message);
        }
    }

    start() {
        if (!this.isRunning) {
            this.isRunning = true;
            console.log('Starting ticker scanner...');

            // Check every second for the right time (XX:XX:03)
            this.intervalId = setInterval(() => {
                const now = new Date();
                const seconds = now.getSeconds();

                // Execute at 3 seconds past every minute
                if (seconds === 3) {
                    const timeStr = now.toTimeString().split(' ')[0]; // HH:MM:SS format
                    console.log(`\n[${timeStr}] Starting ticker fetch...`);
                    this.fetchTickers();
                } else {
                    // Calculate countdown to next minute + 3 seconds
                    const secondsUntilNext = seconds < 3 ? (3 - seconds) : (63 - seconds);

                    if (secondsUntilNext > 0) {
                        process.stdout.write(`\rNext scan in ${secondsUntilNext}s `);
                    }
                }
            }, 1000); // Check every second
        }
    }

    stop() {
        if (this.isRunning && this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            this.isRunning = false;
            console.log('\nTicker scanner stopped');
        }
    }
}

// Create ticker scanner instance
const tickerScanner = new TickerScanner();

// Graceful shutdown handling
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...');
    tickerScanner.stop();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('🛑 SIGINT received, shutting down gracefully...');
    tickerScanner.stop();
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    tickerScanner.stop();
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit on unhandled rejections in production
});



// Start Express server and fetch data
const server = app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

    try {
        // Start ticker scanner with real-time checking
        tickerScanner.start();
        console.log('✅ Ticker scanner started successfully');
    } catch (error) {
        console.error('❌ Error starting ticker scanner:', error.message);
    }
}).on('error', (err) => {
    console.error('❌ Server failed to start:', err.message);
    process.exit(1);
});

// Setup WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('📱 New WebSocket client connected');
    wsClients.add(ws);

    ws.on('close', () => {
        console.log('📱 WebSocket client disconnected');
        wsClients.delete(ws);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        wsClients.delete(ws);
    });
});

console.log('🔌 WebSocket server initialized');
console.log('🛡️ 24/7 memory management active - cleanup every 10 minutes');
console.log(`🎯 Minimum gain threshold: ${MIN_GAIN_THRESHOLD}% (configurable via MIN_GAIN_THRESHOLD env var)`);

// Periodic cleanup and monitoring (every 10 minutes)
setInterval(() => {
    // Clean up dead WebSocket connections
    const deadClients = [];
    wsClients.forEach(client => {
        if (client.readyState !== WebSocket.OPEN) {
            deadClients.push(client);
        }
    });
    deadClients.forEach(client => wsClients.delete(client));

    // Log memory usage and stats
    const memUsage = process.memoryUsage();
    const memUsageMB = {
        rss: Math.round(memUsage.rss / 1024 / 1024),
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
        external: Math.round(memUsage.external / 1024 / 1024)
    };

    console.log(`🔧 Periodic cleanup - Memory: ${memUsageMB.heapUsed}MB/${memUsageMB.heapTotal}MB, Messages: ${telegramMessages.length}, WS Clients: ${wsClients.size}, Uptime: ${Math.round(process.uptime() / 3600)}h`);

    // Force garbage collection if available (only in development)
    if (global.gc && process.env.NODE_ENV !== 'production') {
        global.gc();
        console.log('🗑️ Forced garbage collection');
    }
}, 10 * 60 * 1000); // Every 10 minutes
