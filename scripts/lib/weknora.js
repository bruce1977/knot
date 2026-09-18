const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

function parseTagList(res) {
    const d = res?.data;
    if (Array.isArray(d?.data)) return d.data;
    if (Array.isArray(d)) return d;
    return [];
}

class WeknoraClient {
    constructor(apiBase, apiKey, options = {}) {
        const base = apiBase.replace(/\/$/, "");
        this.apiBase = base.endsWith("/api/v1") ? base : base + "/api/v1";
        this.apiKey = apiKey;
        this.timeoutMs = options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
        this._tagCaches = {};
    }

    async request(method, url, body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const res = await fetch(url, {
                method,
                headers: { "X-API-Key": this.apiKey, "Content-Type": "application/json" },
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.success === false) {
                throw new Error("HTTP " + res.status + ": " + (data.error?.message || data.message || res.statusText));
            }
            return data;
        } finally {
            clearTimeout(timer);
        }
    }

    async _getTagByName(tagName, kbId) {
        const searchRes = await this.request("GET", this.apiBase + "/knowledge-bases/" + kbId + "/tags?keyword=" + encodeURIComponent(tagName) + "&page_size=5");
        const items = parseTagList(searchRes);
        return items.find(t => t.name === tagName) || null;
    }

    async ensureTag(tagName, kbId) {
        if (!this._tagCaches[kbId]) this._tagCaches[kbId] = new Map();
        const cache = this._tagCaches[kbId];
        if (cache.has(tagName)) return cache.get(tagName);

        try {
            const match = await this._getTagByName(tagName, kbId);
            if (match) {
                cache.set(tagName, match.id);
                return match.id;
            }
        } catch (err) {
            // search failed, fall through to create
        }

        try {
            const created = await this.request("POST", this.apiBase + "/knowledge-bases/" + kbId + "/tags", { name: tagName });
            const id = created.data.id;
            cache.set(tagName, id);
            return id;
        } catch (err) {
            if (err.message.includes("409")) {
                try {
                    const match = await this._getTagByName(tagName, kbId);
                    if (match) {
                        cache.set(tagName, match.id);
                        return match.id;
                    }
                } catch (retryErr) {
                    // ignore
                }
            }
            console.error(`  TAG! ${tagName}: ${err.message}`);
            return null;
        }
    }

    async batchGetOrCreateTags(tagNames, kbId) {
        const tagIds = [];
        for (const name of tagNames) {
            const id = await this.ensureTag(name, kbId);
            if (id) tagIds.push(id);
        }
        return tagIds;
    }

    async setTags(kbId, updates) {
        if (Object.keys(updates).length === 0) return;
        await this.request("PUT", this.apiBase + "/knowledge/tags", { kb_id: kbId, updates });
    }

    /**
     * Create a manual knowledge entry.
     * status is either "draft" (no pipeline, nothing parses it) or "publish".
     * The payload struct has no custom_metadata field, so metas must always be
     * written afterwards via PUT.
     */
    async createKnowledge(kbId, title, content, status, tagIds) {
        const body = { title, content, status };
        if (tagIds && tagIds.length > 0) body.tag_ids = tagIds;
        const res = await this.request("POST", this.apiBase + "/knowledge-bases/" + kbId + "/knowledge/manual", body);
        return res?.data?.id;
    }

    /**
     * Publish an existing manual knowledge entry, which starts the parse pipeline.
     * This endpoint reads only title/content/status/process_config - tags stored on
     * the entry are left untouched, so tags assigned at creation survive publishing.
     */
    async publishKnowledge(id, title, content) {
        const res = await this.request("PUT", this.apiBase + "/knowledge/manual/" + id, { title, content, status: "publish" });
        return res?.data?.id || id;
    }

    async updateKnowledge(id, body, retries = 2) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                await this.request("PUT", this.apiBase + "/knowledge/" + id, body);
                return;
            } catch (err) {
                if (attempt < retries) {
                    await new Promise(r => setTimeout(r, 100));
                } else {
                    throw err;
                }
            }
        }
    }

    async deleteKnowledge(id) {
        await this.request("DELETE", this.apiBase + "/knowledge/" + id);
    }

    async getKnowledge(id) {
        const res = await this.request("GET", this.apiBase + "/knowledge/" + id);
        return res?.data || null;
    }

    async searchKnowledge(kbId, title) {
        const res = await this.request("GET", this.apiBase + "/knowledge-bases/" + kbId + "/knowledge?search=" + encodeURIComponent(title) + "&page_size=10");
        const items = res?.data || [];
        return items.find(item => item.title === title) || null;
    }
}

module.exports = { WeknoraClient };
