const { createCanvas } = require('canvas');
const fs = require('fs');

class CandlestickChart {
    constructor(width = 1280, height = 720) {
        this.width = width;
        this.height = height;
        this.canvas = createCanvas(width, height);
        this.ctx = this.canvas.getContext('2d');
        this.padding = { top: 40, right: 80, bottom: 120, left: 40 }; // Increased bottom padding for mini chart
        this.chartWidth = width - this.padding.left - this.padding.right;
        this.chartHeight = (height - this.padding.top - this.padding.bottom) * 0.875; // 87.5% for main chart
        this.miniChartHeight = (height - this.padding.top - this.padding.bottom) * 0.125; // 12.5% for mini chart (50% reduction from 25%)
        this.miniChartY = this.padding.top + this.chartHeight + 20; // Position mini chart below main chart
    }

    formatTime(timestamp) {
        // Convert to UTC+2 timezone
        const date = new Date(parseInt(timestamp));
        const utcPlus2 = new Date(date.getTime() + (2 * 60 * 60 * 1000));
        
        const hours = utcPlus2.getUTCHours().toString().padStart(2, '0');
        const minutes = utcPlus2.getUTCMinutes().toString().padStart(2, '0');
        const day = utcPlus2.getUTCDate().toString().padStart(2, '0');
        const month = (utcPlus2.getUTCMonth() + 1).toString().padStart(2, '0');
        
        return `${day}/${month} ${hours}:${minutes}`;
    }

    getDecimalPlaces(value) {
        const str = value.toString();
        if (str.indexOf('.') !== -1) {
            return str.split('.')[1].length;
        }
        return 0;
    }

    formatPrice(price, decimals) {
        return parseFloat(price).toFixed(decimals);
    }

    calculateLinearRegression(candles) {
        const n = candles.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;

        // Use close prices for regression
        candles.forEach((candle, index) => {
            const x = index;
            const y = candle.close;
            sumX += x;
            sumY += y;
            sumXY += x * y;
            sumXX += x * x;
        });

        // Calculate slope (m) and intercept (b) for y = mx + b
        const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
        const intercept = (sumY - slope * sumX) / n;

        // Calculate standard deviation for channel width
        let sumSquaredErrors = 0;
        candles.forEach((candle, index) => {
            const predictedY = slope * index + intercept;
            const error = candle.close - predictedY;
            sumSquaredErrors += error * error;
        });

        const standardDeviation = Math.sqrt(sumSquaredErrors / n);
        const channelWidth = standardDeviation * 2; // 2 standard deviations

        return {
            slope,
            intercept,
            channelWidth,
            getY: (x) => slope * x + intercept,
            getUpperY: (x) => slope * x + intercept + channelWidth,
            getLowerY: (x) => slope * x + intercept - channelWidth
        };
    }

    drawCandle(x, y, candleWidth, open, high, low, close) {
        const openPrice = parseFloat(open);
        const highPrice = parseFloat(high);
        const lowPrice = parseFloat(low);
        const closePrice = parseFloat(close);
        
        const isGreen = closePrice >= openPrice;
        const color = isGreen ? '#00ff00' : '#ff0000';
        
        // Calculate positions
        const bodyTop = Math.min(openPrice, closePrice);
        const bodyBottom = Math.max(openPrice, closePrice);
        const bodyHeight = Math.abs(closePrice - openPrice);
        
        // Convert prices to canvas coordinates
        const highY = this.priceToY(highPrice);
        const lowY = this.priceToY(lowPrice);
        const bodyTopY = this.priceToY(bodyTop);
        const bodyBottomY = this.priceToY(bodyBottom);
        
        this.ctx.strokeStyle = color;
        this.ctx.fillStyle = color;
        this.ctx.lineWidth = 1;
        
        // Draw wick (high-low line)
        this.ctx.beginPath();
        this.ctx.moveTo(x + candleWidth / 2, highY);
        this.ctx.lineTo(x + candleWidth / 2, lowY);
        this.ctx.stroke();
        
        // Draw body
        if (bodyHeight === 0) {
            // Doji - draw a line
            this.ctx.beginPath();
            this.ctx.moveTo(x, bodyTopY);
            this.ctx.lineTo(x + candleWidth, bodyTopY);
            this.ctx.stroke();
        } else {
            // Regular candle body
            this.ctx.fillRect(x, bodyTopY, candleWidth, bodyBottomY - bodyTopY);
        }
    }

    priceToY(price) {
        const priceRange = this.maxPrice - this.minPrice;
        const priceRatio = (price - this.minPrice) / priceRange;
        return this.padding.top + this.chartHeight - (priceRatio * this.chartHeight);
    }

    drawRegressionChannel(regression, candleCount) {
        const candleSpacing = this.chartWidth / candleCount;

        // Set line style for regression lines
        this.ctx.strokeStyle = '#4444ff'; // Blue color for regression lines
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash([5, 5]); // Dashed lines

        // Draw center line
        this.ctx.beginPath();
        const startX = this.padding.left;
        const endX = this.padding.left + this.chartWidth;
        const startY = this.priceToY(regression.getY(0));
        const endY = this.priceToY(regression.getY(candleCount - 1));

        this.ctx.moveTo(startX, startY);
        this.ctx.lineTo(endX, endY);
        this.ctx.stroke();

        // Draw upper channel line - solid white and thicker
        this.ctx.strokeStyle = '#ffffff'; // White color for channel boundaries
        this.ctx.lineWidth = 2; // Thicker line
        this.ctx.setLineDash([]); // Solid line (no dashes)
        this.ctx.beginPath();
        const upperStartY = this.priceToY(regression.getUpperY(0));
        const upperEndY = this.priceToY(regression.getUpperY(candleCount - 1));

        this.ctx.moveTo(startX, upperStartY);
        this.ctx.lineTo(endX, upperEndY);
        this.ctx.stroke();

        // Draw lower channel line - solid white and thicker
        this.ctx.beginPath();
        const lowerStartY = this.priceToY(regression.getLowerY(0));
        const lowerEndY = this.priceToY(regression.getLowerY(candleCount - 1));

        this.ctx.moveTo(startX, lowerStartY);
        this.ctx.lineTo(endX, lowerEndY);
        this.ctx.stroke();

        // Reset line dash and width
        this.ctx.setLineDash([]);
        this.ctx.lineWidth = 1;
    }

    generateChart(candleData) {
        // Clear canvas with black background
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, this.width, this.height);
        
        if (!candleData || candleData.length === 0) {
            console.log('No candle data provided');
            return;
        }
        
        // Parse and prepare data (reverse to get oldest first)
        const candles = candleData.reverse().map(candle => ({
            timestamp: candle[0],
            open: parseFloat(candle[1]),
            high: parseFloat(candle[2]),
            low: parseFloat(candle[3]),
            close: parseFloat(candle[4]),
            volume: parseFloat(candle[5])
        }));
        
        // Find price range
        this.minPrice = Math.min(...candles.map(c => c.low));
        this.maxPrice = Math.max(...candles.map(c => c.high));
        
        // Add some padding to price range
        const priceRange = this.maxPrice - this.minPrice;
        this.minPrice -= priceRange * 0.05;
        this.maxPrice += priceRange * 0.05;
        
        // Determine decimal places from the data
        const decimals = Math.max(...candles.map(c => 
            Math.max(
                this.getDecimalPlaces(c.open),
                this.getDecimalPlaces(c.high),
                this.getDecimalPlaces(c.low),
                this.getDecimalPlaces(c.close)
            )
        ));
        
        // Calculate linear regression
        const regression = this.calculateLinearRegression(candles);

        // Calculate candle width and spacing
        const candleWidth = Math.max(2, Math.floor(this.chartWidth / candles.length * 0.8));
        const candleSpacing = this.chartWidth / candles.length;

        // Draw regression channel first (behind candles)
        this.drawRegressionChannel(regression, candles.length);

        // Draw candles
        candles.forEach((candle, index) => {
            const x = this.padding.left + (index * candleSpacing) + (candleSpacing - candleWidth) / 2;
            this.drawCandle(x, 0, candleWidth, candle.open, candle.high, candle.low, candle.close);
        });
        
        // Draw price labels on the right
        this.ctx.fillStyle = '#ffffff';
        this.ctx.font = '12px Arial';
        this.ctx.textAlign = 'left';
        
        const priceSteps = 8;
        for (let i = 0; i <= priceSteps; i++) {
            const price = this.minPrice + (this.maxPrice - this.minPrice) * (i / priceSteps);
            const y = this.priceToY(price);
            const priceText = this.formatPrice(price, decimals);
            this.ctx.fillText(priceText, this.width - this.padding.right + 5, y + 4);
        }
        
        // Calculate candle percentage movements
        const candlePercentages = this.calculateCandlePercentages(candles);

        // Draw mini chart showing percentage movements
        const miniChartStats = this.drawMiniChart(candlePercentages, candles.length);

        // Calculate channel statistics
        const channelStats = this.calculateChannelPercentage(regression, candles.length);

        // Draw summary text below mini chart
        this.drawSummaryText(miniChartStats, channelStats);

        // Draw time labels on the bottom (adjusted for summary text)
        this.ctx.textAlign = 'center';
        const timeSteps = Math.min(10, candles.length);
        const timeInterval = Math.floor(candles.length / timeSteps);

        for (let i = 0; i < candles.length; i += timeInterval) {
            const candle = candles[i];
            const x = this.padding.left + (i * candleSpacing) + candleSpacing / 2;
            const timeText = this.formatTime(candle.timestamp);
            this.ctx.fillText(timeText, x, this.height - 15);
        }

        // Return regression data for further analysis
        return {
            regression,
            candleCount: candles.length,
            channelStats,
            miniChartStats,
            candlePercentages
        };
    }

    async generateChartBuffer(candleData, width = 1200, height = 800) {
        // Update canvas size if needed
        if (this.width !== width || this.height !== height) {
            this.width = width;
            this.height = height;
            this.canvas = createCanvas(width, height);
            this.ctx = this.canvas.getContext('2d');
            this.chartWidth = width - this.padding.left - this.padding.right;
            this.chartHeight = (height - this.padding.top - this.padding.bottom) * 0.875;
            this.miniChartHeight = (height - this.padding.top - this.padding.bottom) * 0.125;
            this.miniChartY = this.padding.top + this.chartHeight + 20;
        }

        // Use the existing generateChart method which works perfectly
        this.generateChart(candleData);

        // Return the buffer from the instance canvas (same as saveToFile but returns instead of saving)
        return this.canvas.toBuffer('image/png');
    }

    calculateChannelWidth(candles) {
        // Convert array format to candle objects for regression calculation
        const candleObjects = candles.map(candle => ({
            timestamp: parseInt(candle[0]),
            open: parseFloat(candle[1]),
            high: parseFloat(candle[2]),
            low: parseFloat(candle[3]),
            close: parseFloat(candle[4]),
            volume: parseFloat(candle[5])
        }));

        const regression = this.calculateLinearRegression(candleObjects);

        const currentPrice = parseFloat(candles[0][4]);
        const upperChannel = regression.getUpperY(0);
        const lowerChannel = regression.getLowerY(0);

        return (((upperChannel - lowerChannel) / currentPrice) * 100).toFixed(2);
    }



    calculateCandlePercentages(candles) {
        return candles.map(candle => {
            const open = candle.open;
            const close = candle.close;
            const high = candle.high;
            const low = candle.low;

            // Calculate percentage change from open to close
            const bodyPercentage = ((close - open) / open) * 100;

            // Calculate wick percentages
            const upperWickPercentage = ((high - Math.max(open, close)) / open) * 100;
            const lowerWickPercentage = ((Math.min(open, close) - low) / open) * 100;

            // Total candle range percentage
            const totalRangePercentage = ((high - low) / open) * 100;

            return {
                bodyPercentage,
                upperWickPercentage,
                lowerWickPercentage,
                totalRangePercentage,
                isGreen: close >= open
            };
        });
    }

    drawMiniChart(percentages, candleCount) {
        // Find max absolute percentage for scaling (since all bars go above zero line)
        const allAbsPercentages = percentages.map(p => Math.abs(p.bodyPercentage));
        const maxAbsPercentage = Math.max(...allAbsPercentages);

        // Add some padding to the max
        const paddedMax = maxAbsPercentage * 1.1;

        // Draw mini chart background
        this.ctx.fillStyle = '#111111';
        this.ctx.fillRect(this.padding.left, this.miniChartY, this.chartWidth, this.miniChartHeight);

        // Zero line is now at the bottom of the mini chart
        const zeroY = this.miniChartY + this.miniChartHeight;
        this.ctx.strokeStyle = '#444444';
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash([2, 2]);
        this.ctx.beginPath();
        this.ctx.moveTo(this.padding.left, zeroY);
        this.ctx.lineTo(this.padding.left + this.chartWidth, zeroY);
        this.ctx.stroke();
        this.ctx.setLineDash([]);

        // Calculate bar width and spacing
        const barWidth = Math.max(1, Math.floor(this.chartWidth / candleCount * 0.8));
        const barSpacing = this.chartWidth / candleCount;

        // Draw percentage bars (all above zero line)
        percentages.forEach((percentage, index) => {
            const x = this.padding.left + (index * barSpacing) + (barSpacing - barWidth) / 2;
            const bodyHeight = (Math.abs(percentage.bodyPercentage) / paddedMax) * this.miniChartHeight;

            // All bars drawn above zero line (which is now at bottom), extending upward
            const bodyY = zeroY - bodyHeight;

            // Color based on direction (green for positive, red for negative)
            this.ctx.fillStyle = percentage.isGreen ? '#00ff00' : '#ff0000';

            this.ctx.fillRect(x, bodyY, barWidth, bodyHeight);
        });

        // Draw volatility overlay
        this.drawVolatilityOverlay(percentages, candleCount, barSpacing, paddedMax, zeroY);

        // Draw labels
        this.ctx.fillStyle = '#ffffff';
        this.ctx.font = '10px Arial';
        this.ctx.textAlign = 'left';

        // Max percentage label (at top of mini chart)
        this.ctx.fillText(`${paddedMax.toFixed(2)}%`, this.padding.left + this.chartWidth + 5, this.miniChartY + 10);

        // Zero line label (at bottom of mini chart)
        this.ctx.fillText('0%', this.padding.left + this.chartWidth + 5, zeroY + 4);

        // Calculate highest up and down candle percentages
        const upCandles = percentages.filter(p => p.isGreen).map(p => p.bodyPercentage);
        const downCandles = percentages.filter(p => !p.isGreen).map(p => p.bodyPercentage);

        const highestUp = upCandles.length > 0 ? Math.max(...upCandles) : 0;
        const highestDown = downCandles.length > 0 ? Math.min(...downCandles) : 0;

        return {
            maxPercentage: paddedMax,
            minPercentage: 0, // Now minimum is always 0
            avgBodyPercentage: percentages.reduce((sum, p) => sum + Math.abs(p.bodyPercentage), 0) / percentages.length,
            highestUp,
            highestDown
        };
    }

    drawVolatilityOverlay(percentages, candleCount, barSpacing, paddedMax, zeroY) {
        // Calculate volatility zones using a sliding window
        const windowSize = Math.max(5, Math.floor(candleCount / 20)); // Adaptive window size
        const volatilityZones = [];

        for (let i = 0; i < candleCount; i++) {
            const start = Math.max(0, i - Math.floor(windowSize / 2));
            const end = Math.min(candleCount - 1, i + Math.floor(windowSize / 2));

            // Calculate average volatility in this window
            let totalVolatility = 0;
            let count = 0;

            for (let j = start; j <= end; j++) {
                totalVolatility += Math.abs(percentages[j].bodyPercentage);
                count++;
            }

            const avgVolatility = totalVolatility / count;
            volatilityZones.push(avgVolatility);
        }

        // Find min/max volatility for normalization
        const maxVolatility = Math.max(...volatilityZones);
        const minVolatility = Math.min(...volatilityZones);
        const volatilityRange = maxVolatility - minVolatility;

        // Draw volatility overlay
        this.ctx.globalCompositeOperation = 'source-over';

        for (let i = 0; i < candleCount; i++) {
            const x = this.padding.left + (i * barSpacing);

            // Normalize volatility to 0-1 range
            const normalizedVolatility = volatilityRange > 0 ?
                (volatilityZones[i] - minVolatility) / volatilityRange : 0;

            // Calculate opacity based on volatility level
            let opacity;
            if (normalizedVolatility > 0.7) {
                opacity = 0.5; // High volatility: 50% orange (hot)
            } else if (normalizedVolatility > 0.4) {
                opacity = 0.35; // Medium-high volatility: 35% orange (warm)
            } else if (normalizedVolatility > 0.2) {
                opacity = 0.25; // Medium volatility: 25% orange (moderate)
            } else {
                opacity = 0.1; // Low volatility: 10% orange (cool)
            }

            // Draw volatility overlay rectangle with orange heat map
            this.ctx.fillStyle = `rgba(255, 165, 0, ${opacity})`;
            this.ctx.fillRect(x, this.miniChartY, barSpacing, this.miniChartHeight);
        }

        // Reset composite operation
        this.ctx.globalCompositeOperation = 'source-over';
    }

    drawSummaryText(miniChartStats, channelStats) {
        // Position text below mini chart
        const textY = this.miniChartY + this.miniChartHeight + 30;

        // Prepare summary text
        const highestUpText = `Highest UP candle ${miniChartStats.highestUp.toFixed(2)}%`;
        const highestDownText = `Highest DOWN candle ${miniChartStats.highestDown.toFixed(2)}%`;
        const avgCandleText = `Average candle movement ${miniChartStats.avgBodyPercentage.toFixed(2)}%`;
        const channelText = `Channel Width Percentage: ${channelStats.percentageWidth.toFixed(2)}%`;

        const summaryText = `${highestUpText} - ${highestDownText} - ${avgCandleText} - ${channelText}`;

        // Set text style
        this.ctx.fillStyle = '#ffffff';
        this.ctx.font = '14px Arial';
        this.ctx.textAlign = 'center';

        // Draw text centered horizontally
        const textX = this.padding.left + this.chartWidth / 2;
        this.ctx.fillText(summaryText, textX, textY);
    }

    calculateChannelPercentage(regression, candleCount) {
        // Get the rightmost (latest) values
        const lastIndex = candleCount - 1;
        const centerPrice = regression.getY(lastIndex);
        const upperPrice = regression.getUpperY(lastIndex);
        const lowerPrice = regression.getLowerY(lastIndex);

        // Calculate the channel width as percentage of center price
        const channelWidth = upperPrice - lowerPrice;
        const percentageWidth = (channelWidth / centerPrice) * 100;

        return {
            centerPrice,
            upperPrice,
            lowerPrice,
            channelWidth,
            percentageWidth
        };
    }

    saveToFile(filename) {
        const buffer = this.canvas.toBuffer('image/png');
        fs.writeFileSync(filename, buffer);
    }
}

module.exports = CandlestickChart;
