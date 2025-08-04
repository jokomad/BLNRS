const ChartGenerator = require('./chartGenerator');

class SignalDetector {
    constructor(api, telegram, tickers, telegramGroupId, messageCallback = null) {
        this.api = api;
        this.telegram = telegram;
        this.tickers = tickers;
        this.telegramGroupId = telegramGroupId;
        this.lastTelegramSent = null;
        this.messageCallback = messageCallback; // Callback to store messages
    }

    calculateLinearRegression(values) {
        // Validate input
        if (!Array.isArray(values) || values.length < 2) {
            return {
                slope: 0,
                intercept: 0,
                getUpperY: () => 0,
                getLowerY: () => 0
            };
        }

        // Create x values array (0 to length-1)
        const x = Array.from({length: values.length}, (_, i) => i);
        
        // Calculate means
        const meanX = x.reduce((a, b) => a + b, 0) / x.length;
        const meanY = values.reduce((a, b) => a + b, 0) / values.length;

        // Calculate slope
        let numerator = 0;
        let denominator = 0;
        
        for (let i = 0; i < values.length; i++) {
            numerator += (x[i] - meanX) * (values[i] - meanY);
            denominator += Math.pow(x[i] - meanX, 2);
        }

        const slope = denominator !== 0 ? numerator / denominator : 0;
        const intercept = meanY - slope * meanX;

        // Calculate standard error
        let sumSquareResiduals = 0;
        for (let i = 0; i < values.length; i++) {
            const yHat = slope * x[i] + intercept;
            sumSquareResiduals += Math.pow(values[i] - yHat, 2);
        }
        const standardError = Math.sqrt(sumSquareResiduals / (values.length - 2));

        // Return regression object with channel calculation methods
        return {
            slope,
            intercept,
            getUpperY: (x) => slope * x + intercept + 2 * standardError,
            getLowerY: (x) => slope * x + intercept - 2 * standardError
        };
    }

    checkChannelCrossUp(symbol, candles) {
        // Need minimum 10 candles for meaningful regression
        if (candles.length < 10) return false;
        
        // Map all available candles
        const orderedCandles = candles.map(candle => ({
            timestamp: parseInt(candle[0]),
            open: parseFloat(candle[1]),
            high: parseFloat(candle[2]), 
            low: parseFloat(candle[3]),
            close: parseFloat(candle[4]),
            volume: parseFloat(candle[5])
        }));
        
        // Calculate regression using all available close prices
        const closePrices = orderedCandles.map(c => c.close);
        const regression = this.calculateLinearRegression(closePrices);
        
        // Check the most recent completed candle (index 1, since 0 is current incomplete)
        const completedCandle = orderedCandles[1];
        const channelY = regression.getLowerY(1); // Use position 1 for completed candle

        if (completedCandle.low < channelY && completedCandle.close > channelY) {
            return true;
        }

        return false;
    }

    checkChannelCrossDown(symbol, candles) {
        if (candles.length < 10) return false;

        const orderedCandles = candles.map(candle => ({
            timestamp: parseInt(candle[0]),
            open: parseFloat(candle[1]),
            high: parseFloat(candle[2]),
            low: parseFloat(candle[3]),
            close: parseFloat(candle[4]),
            volume: parseFloat(candle[5])
        }));

        const closePrices = orderedCandles.map(c => c.close);
        const regression = this.calculateLinearRegression(closePrices);

        const completedCandle = orderedCandles[1];
        const channelY = regression.getLowerY(1);

        if (completedCandle.high > channelY && completedCandle.close < channelY) {
            return true;
        }

        return false;
    }

    async sendSignalAlert(symbol, candles, signalType = 'UP', isLastSignal = false) {
        // Get symbol info from tickers data
        const ticker = this.tickers.find(t => t.symbol === symbol);
        const currentPrice = parseFloat(ticker?.lastPrice || candles[0][4]); // Use lastPrice from ticker, fallback to candle
        const tickSize = ticker?.priceScale || '4'; // Default to 4 decimals if not found
        const decimals = parseInt(tickSize);

        const lowPrice = (currentPrice * 0.2).toFixed(decimals);
        const highPrice = (currentPrice * 1.8).toFixed(decimals);

        const chartGen = new ChartGenerator();
        const channelWidth = chartGen.calculateChannelWidth(candles);

        // Calculate average candle movement
        const candleObjects = candles.map(candle => ({
            timestamp: parseInt(candle[0]),
            open: parseFloat(candle[1]),
            high: parseFloat(candle[2]),
            low: parseFloat(candle[3]),
            close: parseFloat(candle[4]),
            volume: parseFloat(candle[5])
        }));

        const candlePercentages = chartGen.calculateCandlePercentages(candleObjects);
        const avgCandleMovement = (candlePercentages.reduce((sum, p) => sum + Math.abs(p.bodyPercentage), 0) / candlePercentages.length).toFixed(2);

        const chartBuffer = await chartGen.generateChartBuffer(candles);

        let message = `${symbol}\nLP ${lowPrice} - HP ${highPrice}\nAvg candle: ${avgCandleMovement}%\nPotential gain: ${channelWidth}%`;

        // Add scan finished message if this is the last signal
        if (isLastSignal) {
            message += `\n\n                 🔍 Scan finished                    `;
        }

        try {
            await this.telegram.sendPhoto(this.telegramGroupId, chartBuffer, {
                caption: message,
                parse_mode: 'Markdown'
            });

            // Store message in memory if callback provided (include image buffer)
            if (this.messageCallback) {
                this.messageCallback(message, chartBuffer);
            }

            this.lastTelegramSent = Date.now();
        } catch (error) {
            console.error(`Error sending Telegram alert: ${error.message}`);
        }
    }





    async checkSymbol(symbol) {
        try {
            const candles = await this.api.getCandles(symbol);
            const isUpCross = this.checkChannelCrossUp(symbol, candles);
            const isDownCross = this.checkChannelCrossDown(symbol, candles);

            // Return signal data if crossing detected
            if (isUpCross || isDownCross) {
                return {
                    symbol,
                    candles,
                    isUpCross,
                    isDownCross
                };
            }

            return null; // No signal detected
        } catch (error) {
            console.error(`Error checking ${symbol}: ${error.message}`);
            return null;
        }
    }

    async checkSymbolsWithCandleData(candleResults) {
        const signals = [];

        console.log(`Checking ${candleResults.length} symbols for crossing signals...`);

        // Check all symbols for crossings using pre-fetched candle data
        for (const result of candleResults) {
            const symbol = result.symbol;
            const candles = result.data.result.list;

            const isUpCross = this.checkChannelCrossUp(symbol, candles);
            const isDownCross = this.checkChannelCrossDown(symbol, candles);

            if (isUpCross || isDownCross) {
                console.log(`✅ Signal found: ${symbol} - ${isUpCross ? 'UP' : 'DOWN'} crossing`);
                signals.push({
                    symbol,
                    candles,
                    isUpCross,
                    isDownCross
                });
            }
        }

        console.log(`Found ${signals.length} total crossing signals`);

        // Check if we're in quiet hours (00:00 to 06:00 UTC+2)
        const now = new Date();
        const utcPlus2 = new Date(now.getTime() + (2 * 60 * 60 * 1000));
        const currentHour = utcPlus2.getUTCHours();
        const isQuietHours = currentHour >= 0 && currentHour < 6;

        if (isQuietHours) {
            console.log(`🌙 Quiet hours (${currentHour.toString().padStart(2, '0')}:${utcPlus2.getUTCMinutes().toString().padStart(2, '0')} UTC+2) - Skipping Telegram messages`);
            console.log(`Found ${signals.length} crossing signals but not sending due to quiet hours`);
            return;
        }

        // Send alerts immediately (no delisting check needed since already filtered)
        if (signals.length > 0) {
            // Calculate potential gain for each signal and sort from lowest to highest
            console.log('Calculating potential gains for sorting...');
            const signalsWithGains = signals.map(signal => {
                const chartGen = new ChartGenerator();
                const channelWidth = parseFloat(chartGen.calculateChannelWidth(signal.candles));
                return {
                    ...signal,
                    potentialGain: channelWidth
                };
            });

            // Sort by potential gain (lowest to highest)
            signalsWithGains.sort((a, b) => a.potentialGain - b.potentialGain);

            console.log('Sending alerts in order from lowest to highest potential gain:');
            signalsWithGains.forEach(signal => {
                console.log(`  ${signal.symbol}: ${signal.potentialGain}%`);
            });

            let alertsSent = 0;
            const totalSignals = signalsWithGains.length;

            for (let i = 0; i < signalsWithGains.length; i++) {
                const signal = signalsWithGains[i];
                const isLastSignal = (i === totalSignals - 1);

                console.log(`📤 Sending alert for ${signal.symbol} (${signal.potentialGain}% gain)${isLastSignal ? ' - FINAL' : ''}`);
                await this.sendSignalAlert(
                    signal.symbol,
                    signal.candles,
                    signal.isUpCross ? 'UP' : 'DOWN',
                    isLastSignal
                );
                alertsSent++;
            }
            console.log(`📨 Sent ${alertsSent} alerts via Telegram (highest gain: ${signalsWithGains[signalsWithGains.length - 1].symbol} at ${signalsWithGains[signalsWithGains.length - 1].potentialGain}%)`);
            console.log('📨 Scan finished message included with last signal');
        } else {
            console.log('No crossing signals found in this scan.');

            // Send scan finished message even when no signals found
            const finishedMessage = `                    🔍 Scan finished                    \n\nNo crossing signals found in this scan.`;
            try {
                await this.telegram.sendMessage(this.telegramGroupId, finishedMessage);

                // Store message in memory if callback provided
                if (this.messageCallback) {
                    this.messageCallback(finishedMessage);
                }

                console.log('📨 Sent scan finished message (no signals)');
            } catch (error) {
                console.error('Error sending scan finished message:', error);
            }
        }

        return signals;
    }
}

module.exports = SignalDetector;
