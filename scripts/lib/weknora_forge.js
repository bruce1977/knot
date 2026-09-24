const crypto = require("crypto");

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const SEARCH_PAGE_SIZE = 20;

// Escape a value for use inside an FMQ single-quoted string literal.
// FMQ doubles the single quote to escape it (see FMQ.md).
function fmqStringLiteral(value) {
    return String(value).replace(/'/g, "''");
}

// Build a human-readable message from a Forge error response.
// Forge uses {success:false, error_id, error_message, details?}; FastAPI
// validation errors use {detail: string | [{msg}...]}; non-JSON bodies fall
// back to the raw text so nothing is swallowed.
function extractErrorMessage(data, response, rawBody) {
    const parts = [];
    if (data && data.error_id) parts.push(String(data.error_id));
    if (data && data.error_message) {
        parts.push(String(data.error_message));
    } else if (data && typeof data.detail === "string") {
        parts.push(data.detail);
    } else if (data && Array.isArray(data.detail) && data.detail.length > 0) {
        parts.push(data.detail.map((entry) => (entry && entry.msg) || JSON.stringify(entry)).join("; "));
    } else if (data && data.message) {
        parts.push(String(data.message));
    } else if (rawBody) {
        parts.push(rawBody);
    } else {
        parts.push(response.statusText || ("HTTP " + response.status));
    }
    if (data && data.details !== undefined && data.details !== null) {
        const details = typeof data.details === "string" ? data.details : JSON.stringify(data.details);
        if (details && details !== "{}") parts.push(details);
    }
    return parts.join(": ");
}

/**
 * Client for the WeKnora Forge API (v2 extension layer).
 *
 * Every request carries two auth headers:
 *   X-API-Key           = configured api key
 *   X-Forge-Signature   = hex(HMAC_SHA256(api_secret, METHOD + FULL_PATH))
 * where FULL_PATH is the request path exactly as sent, including the raw
 * query string (no normalisation, no decoding).
 */
class WeknoraForgeClient {
    constructor(baseUrl, apiKey, apiSecret, options = {}) {
        this.baseUrl = String(baseUrl).replace(/\/+$/, "");
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.timeoutMs = options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    }

    // Signature payload is METHOD + FULL_PATH concatenated without a separator.
    sign(method, fullPath) {
        const payload = method.toUpperCase() + fullPath;
        return crypto.createHmac("sha256", this.apiSecret).update(payload, "utf8").digest("hex");
    }

    /**
     * Send a signed JSON request.
     * @param {string} method - HTTP method
     * @param {string} fullPath - path starting with "/", including "?query" when present
     * @param {Object} [body] - JSON body (omitted when undefined)
     */
    async request(method, fullPath, body) {
        const url = this.baseUrl + fullPath;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await fetch(url, {
                method,
                headers: {
                    "X-API-Key": this.apiKey,
                    "X-Forge-Signature": this.sign(method, fullPath),
                    "Content-Type": "application/json",
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
            });
            const rawBody = await response.text().catch(() => "");
            let data = {};
            if (rawBody) {
                try { data = JSON.parse(rawBody); } catch { data = {}; }
            }
            if (!response.ok || data.success === false) {
                throw new Error("HTTP " + response.status + ": " + extractErrorMessage(data, response, rawBody));
            }
            return data;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * POST /api/v2/knowledge/search - find entries by custom_metadata.hash.
     * kb_ids may list several knowledge bases; results from all of them are
     * returned together.
     * @param {string[]} kbIds - knowledge base ids to search
     * @param {string} hash - content hash stored in custom_metadata.hash
     * @returns {Promise<Array<{id: string, title: string, metas: Object}>>}
     */
    async searchKnowledgeByHash(kbIds, hash) {
        const response = await this.request("POST", "/api/v2/knowledge/search", {
            kb_ids: kbIds,
            metas_query: "hash = '" + fmqStringLiteral(hash) + "'",
            page: 1,
            page_size: SEARCH_PAGE_SIZE,
        });
        const items = response && response.data && response.data.items;
        return Array.isArray(items) ? items : [];
    }

    /**
     * POST /api/v2/publish - one-shot publish: resolve tags, create draft,
     * write custom metas, set description, flip to publish (server rolls back
     * the draft on failure).
     * @param {Object} payload - {kb_id, title, content, description?, tag_names?, custom_metas?, channel?, sync?}
     * @returns {Promise<Object>} raw response, includes knowledge_id / tag_ids
     */
    async publish(payload) {
        try {
            return await this.request("POST", "/api/v2/publish", payload);
        } catch (err) {
            // Surface the Forge error envelope verbatim so the sync log shows
            // exactly why the article was not published.
            throw new Error("publish failed: " + err.message);
        }
    }
}

module.exports = { WeknoraForgeClient };
