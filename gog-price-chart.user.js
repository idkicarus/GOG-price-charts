// ==UserScript==
// @name            GOG - Price Charts
// @namespace       https://github.com/idkicarus/
// @homepageURL     https://github.com/idkicarus/GOG-price-charts
// @supportURL      https://github.com/idkicarus/GOG-price-charts/issues
// @match           https://www.gog.com/*/game/*
// @description     Fetches price history from GOGDB.org to generate price charts for games on GOG
// @version         1.1
// @grant           GM.xmlHttpRequest
// @grant           unsafeWindow
// @require         https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js
// @require         https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0
// @updateURL       https://raw.githubusercontent.com/idkicarus/GOG-price-charts/main/gog-price-chart.user.js
// @downloadURL     https://raw.githubusercontent.com/idkicarus/GOG-price-charts/main/gog-price-chart.user.js
// @license MIT
// ==/UserScript==

/* global Chart */

(function() {
    "use strict";

    const DEBUG_MODE = false; // Enable debug mode for logging errors and status messages during script execution.
    const CACHE_KEY_PREFIX = "gogdb_price_"; // Define a prefix for cache keys used to store API responses. This helps uniquely identify data for specific products.
    const CACHE_LENGTH = 1000 * 60 * 60 * 24; // 24 hours in milliseconds (1,000 ms per second, 60 s per minute, 60 mins per hour, 24 hrs per day)

    /**
     * Writes a message to the console only when DEBUG_MODE is enabled.
     * This keeps normal console output clean while still making debugging easier.
     */
    function debugLog(...args) {
        if (DEBUG_MODE) {
            console.log("[GOG Price Charts]", ...args);
        }
    }

    /**
     * Writes a warning to the console only when DEBUG_MODE is enabled.
     */
    function debugWarn(...args) {
        if (DEBUG_MODE) {
            console.warn("[GOG Price Charts]", ...args);
        }
    }

    /**
     * Writes an error to the console only when DEBUG_MODE is enabled.
     */
    function debugError(...args) {
        if (DEBUG_MODE) {
            console.error("[GOG Price Charts]", ...args);
        }
    }

    /**
     * Injects static styles into the document for elements used by the script.
     * This ensures that the custom UI elements have consistent styling.
     */
    function addStaticStyles() {
        // Define a block of CSS styles to be applied to the page.
        const staticStyles = `
            .gog_ph_shadow {
                box-shadow: 0 1px 5px rgba(0, 0, 0, .15);
            }

            .gog_ph_whitebg {
                background-color: #e1e1e1;
            }

            #gog_ph_div {
                width: 100%;
                height: 300px;
                max-height: 300px;
                overflow: hidden;
                margin-top: 20px;
                margin-bottom: 20px;
            }

            #gog_ph_chart_canvas {
                width: 100%;
                max-height: 200px;
                visibility: hidden;
            }

            #gog_ph_placeholder {
                height: 200px;
                background-color: #e1e1e1;
                display: flex;
                justify-content: center;
                align-items: center;
                border-radius: 5px;
            }

            #gog_ph_div p {
                margin-top: 10px;
            }
        `;

        // Create a <style> element to hold the CSS styles.
        const styleTag = document.createElement("style");
        styleTag.textContent = staticStyles;
        document.head.appendChild(styleTag);
    }

    /**
     * Creates a container div for the price history chart and related elements.
     *
     * The container is first appended to the body so it exists immediately.
     * relocatePlaceholder() moves it to the correct location after GOG finishes rendering
     * the product page media area.
     */
    function createPriceHistoryContainer() {
        // Do not create a duplicate chart container if the script runs more than once.
        if (document.getElementById("gog_ph_div")) {
            return;
        }

        // Create a container div for the price history chart and related elements.
        const gog_ph_div = document.createElement("div");
        gog_ph_div.setAttribute("id", "gog_ph_div");
        gog_ph_div.innerHTML = `
            <div class="title">
                <div class="title__underline-text">Price history</div>
                <div class="title__additional-options"></div>
            </div>
            <div id="gog_ph_placeholder" class="gog_ph_whitebg gog_ph_shadow">Loading price history...</div>
            <canvas id="gog_ph_chart_canvas" class="gog_ph_whitebg gog_ph_shadow"></canvas>
            <p>
                <span id="gog_ph_lowest_price"></span>
                <span id="gog_ph_data_source"></span>
            </p>
        `;

        // Append the container div to the body of the document.
        // It will be moved into the correct product page section by relocatePlaceholder().
        document.body.appendChild(gog_ph_div);
    }

    /**
     * Moves the placeholder to a specific location in the DOM once the target is available.
     * This ensures the price history UI is displayed below the product thumbnails.
     *
     * The older selector, div.layout-container:nth-child(9), was too brittle because it
     * depended on GOG's exact layout order. This version targets the product thumbnail
     * section directly, then falls back to the Description section if needed.
     */
    function relocatePlaceholder() {
        const placeholderDiv = document.getElementById("gog_ph_div");

        if (!placeholderDiv) {
            return;
        }

        /**
         * Inserts the price history container after the selected target element.
         * This is used for the thumbnail slider and gallery fallback targets.
         */
        function insertAfter(targetElement) {
            if (!targetElement || !targetElement.parentNode) {
                return false;
            }

            // Avoid moving the chart again if it is already immediately after this target.
            if (placeholderDiv.previousElementSibling === targetElement) {
                return true;
            }

            targetElement.insertAdjacentElement("afterend", placeholderDiv);
            debugLog("Placed chart after:", targetElement);
            return true;
        }

        /**
         * Inserts the price history container before the selected target element.
         * This is used as a fallback when the thumbnail section cannot be found.
         */
        function insertBefore(targetElement) {
            if (!targetElement || !targetElement.parentNode) {
                return false;
            }

            // Avoid moving the chart again if it is already immediately before this target.
            if (placeholderDiv.nextElementSibling === targetElement) {
                return true;
            }

            targetElement.parentNode.insertBefore(placeholderDiv, targetElement);
            debugLog("Placed chart before:", targetElement);
            return true;
        }

        /**
         * Finds the product thumbnail slider.
         * This is the preferred target because inserting after it places the chart below
         * the product thumbnails instead of above them.
         */
        function findThumbnailSlider() {
            return document.querySelector(".productcard-thumbnails-slider");
        }

        /**
         * Finds a nearby thumbnail/gallery wrapper by starting from GOG's gallery tracking elements.
         * This is a fallback in case GOG changes the exact thumbnail slider class.
         */
        function findThumbnailWrapperFromGalleryEvents() {
            const galleryEventElement = document.querySelector("[gog-track-event*='productPageGallery']");

            return galleryEventElement?.closest(
                ".productcard-thumbnails-slider, " +
                ".productcard-thumbnails-slider-nav-wrapper, " +
                "[class*='productcard-thumbnails']"
            );
        }

        /**
         * Finds the Description section.
         * This is a last-resort placement target that should still keep the chart below
         * the main product media area.
         */
        function findDescriptionSection() {
            const descriptionSection = document.querySelector(
                "[content-summary-section-id='description'], " +
                "[selenium-id='ProductCardDescription']"
            );

            return descriptionSection?.closest(".layout-container") || descriptionSection;
        }

        /**
         * Finds the best available location for the price history UI.
         */
        function placePlaceholder() {
            // Prefer placing the chart after the thumbnail slider itself.
            // This fixes cases where placing it after a navigation wrapper still leaves it above the thumbnails.
            const thumbnailSlider = findThumbnailSlider();

            if (insertAfter(thumbnailSlider)) {
                return true;
            }

            // Fall back to gallery click-tracking elements if GOG changes the thumbnail container class.
            const thumbnailWrapper = findThumbnailWrapperFromGalleryEvents();

            if (insertAfter(thumbnailWrapper)) {
                return true;
            }

            // Last fallback: place the chart before the Description section.
            const descriptionContainer = findDescriptionSection();

            if (insertBefore(descriptionContainer)) {
                return true;
            }

            return false;
        }

        // Try to place the placeholder immediately in case the target is already available.
        if (placePlaceholder()) {
            return;
        }

        // Use a MutationObserver to monitor DOM changes and relocate the placeholder when possible.
        const observer = new MutationObserver(() => {
            if (placePlaceholder()) {
                observer.disconnect(); // Stop observing once the placeholder is relocated.
            }
        });

        /**
         * Starts watching the page for dynamically inserted GOG product page elements.
         */
        function startObserving() {
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true
            });

            // Stop observing after a reasonable amount of time so the observer does not run indefinitely.
            setTimeout(() => {
                observer.disconnect();
                debugWarn("Stopped observing before finding a placement target.");
            }, 10000);
        }

        // Check the document's readiness state and start observing accordingly.
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", startObserving, { once: true });
        } else {
            startObserving();
        }
    }

    /**
     * Waits for the product data to be loaded, then triggers the provided callback.
     * The product data is required to fetch the price history for a specific game.
     * @param {Function} callback - Function to call with the product ID once available.
     */
    function waitForProductData(callback) {
        let pollingInterval = null;

        /**
         * Tries to read the product ID from GOG's page data.
         * @returns {boolean} True if polling should stop, false if polling should continue.
         */
        function tryReadProductId() {
            try {
                // Check if the productcardData object is available and contains the product ID.
                const productId = unsafeWindow.productcardData?.cardProductId;

                if (productId) {
                    debugLog("Found product ID:", productId);
                    callback(productId);
                    return true;
                }
            } catch (error) {
                debugError("Error accessing productcardData:", error);
                return true;
            }

            return false;
        }

        /**
         * Starts polling for product data once the window has loaded.
         */
        function startPolling() {
            if (tryReadProductId()) {
                return;
            }

            pollingInterval = setInterval(() => {
                if (tryReadProductId()) {
                    clearInterval(pollingInterval); // Stop polling once the data is available.
                    pollingInterval = null;
                }
            }, 100); // Poll every 100ms.

            // Set a timeout to stop polling if the data is not loaded within 10 seconds.
            setTimeout(() => {
                if (pollingInterval) {
                    clearInterval(pollingInterval);
                    pollingInterval = null;
                    debugWarn("Timeout: Unable to load product data.");
                    setPlaceholderText("Unable to load product data.");
                }
            }, 10000);
        }

        if (document.readyState === "complete") {
            startPolling();
        } else {
            window.addEventListener("load", startPolling, { once: true });
        }
    }

    /**
     * Updates the placeholder text safely.
     * This avoids errors if the placeholder was already removed after the chart loaded.
     * @param {string} message - Message to display in the placeholder.
     */
    function setPlaceholderText(message) {
        const placeholder = document.getElementById("gog_ph_placeholder");

        if (placeholder) {
            placeholder.textContent = message;
        }
    }

    /**
     * Fetches price history data from the GOGDB API for a given product.
     * @param {string} cacheKey - Key to cache the API response.
     * @param {string} productId - Product ID to fetch data for.
     */
    function fetchPriceData(cacheKey, productId) {
        const cachedData = localStorage.getItem(cacheKey);
        const cacheTimestamp = Number(localStorage.getItem(`${cacheKey}_timestamp`) || 0);

        // Check if cached data is available and not expired (e.g., 24 hours).
        if (cachedData && cacheTimestamp && Date.now() - cacheTimestamp < CACHE_LENGTH) {
            try {
                const parsedCache = JSON.parse(cachedData);
                debugLog("Using cached data:", parsedCache);
                processPriceData(parsedCache, productId);
                return;
            } catch (error) {
                debugWarn("Cached price data was invalid. Fetching fresh data.", error);
                localStorage.removeItem(cacheKey);
                localStorage.removeItem(`${cacheKey}_timestamp`);
            }
        }

        // Fetch data from the API if no valid cache is found.
        GM.xmlHttpRequest({
            method: "GET",
            url: `https://www.gogdb.org/data/products/${productId}/prices.json`,
            onload: function(response) {
                if (response.status === 200) {
                    try {
                        const jsonData = JSON.parse(response.responseText);
                        debugLog("Fetched price data:", jsonData);

                        // Cache the response and timestamp.
                        localStorage.setItem(cacheKey, response.responseText);
                        localStorage.setItem(`${cacheKey}_timestamp`, String(Date.now()));

                        processPriceData(jsonData, productId);
                    } catch (error) {
                        debugError("Failed to parse price data:", error);
                        setPlaceholderText("Failed to parse price history.");
                    }

                    return;
                }

                setPlaceholderText(
                    response.status === 404
                        ? "No historical price data available."
                        : "Failed to load price history."
                );
            },
            onerror: function(error) {
                debugError("Price history request failed:", error);
                setPlaceholderText("Failed to load price history.");
            }
        });
    }

    /**
     * Processes the price history data and updates the UI with a chart and additional information.
     * @param {Object} jsonData - Raw price data fetched from the API.
     * @param {string} productId - Product ID associated with the data.
     */
    function processPriceData(jsonData, productId) {
        // Parse the price history data into labels (dates), prices, and key metrics.
        const {
            labels,
            prices,
            lowestPrice,
            highestBasePrice
        } = parsePriceHistory(jsonData);

        debugLog("Processed labels:", labels);
        debugLog("Processed prices:", prices);

        // Check if there is valid data to display.
        if (labels.length > 0 && prices.length > 0) {
            // Create the price history chart using Chart.js.
            createChart(labels, prices);

            const placeholder = document.getElementById("gog_ph_placeholder");

            if (placeholder) {
                placeholder.remove();
            }

            // Update the lowest price and data source information in the UI.
            const lowestPriceElement = document.getElementById("gog_ph_lowest_price");
            const dataSourceElement = document.getElementById("gog_ph_data_source");

            if (!lowestPriceElement || !dataSourceElement) {
                return;
            }

            if (lowestPrice > 0 && lowestPrice < highestBasePrice) {
                // Display the lowest price if it is valid and less than the highest base price.
                lowestPriceElement.textContent = `Historical low: $${lowestPrice.toFixed(2)}.`;
                dataSourceElement.innerHTML =
                    ` (Data retrieved from <a id="gog_ph_gogdb_link" class="un" href="https://www.gogdb.org/product/${productId}" target="_blank" rel="noopener noreferrer"><u>GOG Database</u></a>.)`;
            } else {
                lowestPriceElement.textContent = "";
                dataSourceElement.innerHTML =
                    `Data retrieved from <a id="gog_ph_gogdb_link" class="un" href="https://www.gogdb.org/product/${productId}" target="_blank" rel="noopener noreferrer"><u>GOG Database</u></a>.`;
            }

            return;
        }

        // Display a message if no price history data is available.
        setPlaceholderText("No historical price data available.");
    }

    /**
     * Parses the price history data into labels, prices, and key metrics.
     * @param {Object} jsonData - Raw price data from the API.
     * @returns {Object} Parsed data including labels, prices, lowest price, and highest base price.
     */
    function parsePriceHistory(jsonData) {
        const history = jsonData?.US?.USD || []; // Extract the price history for USD or default to an empty array.
        const labels = []; // Array to store dates for the x-axis of the chart.
        const prices = []; // Array to store prices for the y-axis of the chart.
        let lowestPrice = Infinity; // Initialize the lowest price to a very high value.
        let highestBasePrice = 0; // Initialize the highest base price to zero.

        // Handle the edge case where there is only one entry in the price history by creating a second data point at the current date.
        if (history.length === 1) {
            const singleEntry = history[0];
            const originalDate = new Date(singleEntry.date);
            const currentDate = new Date();

            labels.push(originalDate);
            labels.push(new Date(currentDate.getFullYear(), currentDate.getMonth(), 1));

            // Create constants for price_base and price_final converted to decimals.
            const singlePriceBase = Number(singleEntry.price_base || 0) / 100;
            const singlePriceFinal = Number(singleEntry.price_final || 0) / 100;

            // Determine the lowest price between price_base and price_final, then store it. Handles games with launch/pre-launch discounts.
            // Probably better than defaulting to price_final for all games with a single price entry.
            lowestPrice = Math.min(singlePriceBase, singlePriceFinal);
            highestBasePrice = singlePriceBase;

            prices.push(lowestPrice, lowestPrice); // Display the lower entry in the chart.

            return {
                labels,
                prices,
                lowestPrice,
                highestBasePrice
            };
        }

        // Process each entry in the price history.
        history.forEach(entry => {
            const date = new Date(entry.date); // Convert the entry date string to a Date object.
            const finalPrice = Number(entry.price_final || 0) / 100; // Convert the final price to a number if available.
            const basePrice = Number(entry.price_base || 0) / 100; // Convert the base price to a number if available.

            if (finalPrice > 0) {
                labels.push(date); // Add the date to the labels array.
                prices.push(finalPrice); // Add the price to the prices array.
                lowestPrice = Math.min(lowestPrice, finalPrice); // Update the lowest price if the current price is lower.
                highestBasePrice = Math.max(highestBasePrice, basePrice); // Update the highest base price.
            }
        });

        return {
            labels,
            prices,
            lowestPrice: lowestPrice === Infinity ? 0 : lowestPrice, // Handle the case where no valid prices are found.
            highestBasePrice
        };
    }

    /**
     * Creates a chart using Chart.js with multiple data points.
     * @param {Array} labels - Array of dates for the x-axis.
     * @param {Array} prices - Array of prices for the y-axis.
     */
    function createChart(labels, prices) {
        if (labels.length === 2) {
            // Handle the case where there are only two data points.
            createChartSingleEntry(labels, prices);
        } else {
            // Handle the case with multiple data points.
            createChartMultipleEntries(labels, prices);
        }
    }

    /**
     * Creates a chart for multiple price entries.
     * @param {Array} labels - Array of dates for the x-axis.
     * @param {Array} prices - Array of prices for the y-axis.
     */
    function createChartMultipleEntries(labels, prices) {
        const canvas = document.getElementById("gog_ph_chart_canvas");

        if (!canvas) {
            return;
        }

        const ctx = canvas.getContext("2d"); // Get the 2D rendering context for the canvas.

        new Chart(ctx, {
            type: "line", // Specify the chart type as a line chart.
            data: {
                labels, // Use the provided labels for the x-axis.
                datasets: [{
                    label: "Price", // Label for the dataset.
                    borderColor: "rgb(241, 142, 0)", // Set the line color.
                    backgroundColor: "rgba(241, 142, 0, 0.5)", // Set the fill color.
                    data: prices, // Use the provided prices for the y-axis.
                    stepped: true, // Use stepped lines to indicate discrete changes.
                    fill: false // Disable filling under the line.
                }]
            },
            options: {
                scales: {
                    x: {
                        type: "time", // Use a time scale for the x-axis.
                        time: {
                            tooltipFormat: "MMM d, yyyy", // Format for tooltips (i.e., short month, day, 4-digit year).
                            displayFormats: {
                                month: "MMM yyyy" // Format for month labels (i.e., short month, 4-digit year).
                            }
                        },
                        ticks: {
                            autoSkip: true, // Automatically skip ticks to avoid overcrowding.
                            maxTicksLimit: Math.max(2, Math.floor(labels.length / 3)) // Limit the number of ticks based on the data length, but keep at least two.
                        }
                    },
                    y: {
                        beginAtZero: true, // Start the y-axis at zero.
                        ticks: {
                            callback: value => `$${Number(value).toFixed(2)}` // Format the y-axis values as currency.
                        }
                    }
                },
                plugins: {
                    legend: {
                        display: false // Disable the legend for simplicity.
                    }
                },
                maintainAspectRatio: false // Allow the chart to resize dynamically.
            }
        });

        document.getElementById("gog_ph_chart_canvas").style.visibility = "visible"; // Make the chart visible after rendering.
    }

    /**
     * Creates a chart for a single price entry.
     * @param {Array} labels - Array of two dates for the x-axis.
     * @param {Array} prices - Array of two prices for the y-axis.
     */
    function createChartSingleEntry(labels, prices) {
        const canvas = document.getElementById("gog_ph_chart_canvas");

        if (!canvas) {
            return;
        }

        const ctx = canvas.getContext("2d"); // Get the 2D rendering context for the canvas.

        new Chart(ctx, {
            type: "line", // Specify the chart type as a line chart.
            data: {
                labels, // Use the provided labels for the x-axis.
                datasets: [{
                    label: "Price", // Label for the dataset.
                    borderColor: "rgb(241, 142, 0)", // Set the line color.
                    backgroundColor: "rgba(241, 142, 0, 0.5)", // Set the fill color.
                    data: prices, // Use the provided prices for the y-axis.
                    stepped: true, // Use stepped lines to indicate discrete changes.
                    fill: false // Disable filling under the line.
                }]
            },
            options: {
                scales: {
                    x: {
                        type: "category", // Use a category scale for the x-axis.
                        ticks: {
                            autoSkip: false, // Do not skip ticks.
                            callback: function(value, index) {
                                return labels[index].toLocaleDateString("en-US", {
                                    month: "short",
                                    year: "numeric"
                                }); // Format x-axis labels as short month and year.
                            }
                        }
                    },
                    y: {
                        beginAtZero: true, // Start the y-axis at zero.
                        ticks: {
                            callback: value => `$${Number(value).toFixed(2)}` // Format the y-axis values as currency.
                        }
                    }
                },
                plugins: {
                    legend: {
                        display: false // Disable the legend for simplicity.
                    },
                    tooltip: {
                        callbacks: {
                            title: function(context) {
                                const index = context[0].dataIndex;

                                // Format the tooltip title to display the date as "Month Day, Year".
                                return labels[index].toLocaleDateString("en-US", {
                                    month: "short",
                                    day: "numeric",
                                    year: "numeric"
                                });
                            }
                        }
                    }
                },
                maintainAspectRatio: false // Allow the chart to dynamically resize without distorting the aspect ratio.
            }
        });

        // Make the chart visible once rendering is complete.
        document.getElementById("gog_ph_chart_canvas").style.visibility = "visible";
    }

    // Add the necessary static styles to the page.
    addStaticStyles();

    // Create the price history container before trying to move it into place.
    createPriceHistoryContainer();

    // Relocate the placeholder element to its correct position on the page.
    relocatePlaceholder();

    // Wait for the product data to load and then fetch the price history data for the product.
    waitForProductData(productId => {
        fetchPriceData(`${CACHE_KEY_PREFIX}${productId}`, productId);
    });
})();