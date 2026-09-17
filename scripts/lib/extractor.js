const fs = require("fs");
const path = require("path");
const { llmChat, extractJSON, getModelTemperature } = require("./llm");
const { sleep, writeJsonFile, validateSchema } = require("./common");

// Plugin directory: every plugin keeps its prompt + schema in <plugin>_config.json.
const PLUGIN_DIR = path.resolve(__dirname, "..", "plugins");

// ─── Base Extractor ──────────────────────────────────────────────────────────
// Base class for all extractors (meta, rate, original, etc.)
// Subclasses must implement: transform(parsed, options)

const MAX_ATTEMPTS = 3;

class BaseExtractor {
    /**
     * @param {Object} config
     * @param {string} config.type - Extractor type ("meta", "rate", "original", etc.)
     * @param {string} config.modelEnvVar - Environment variable for model name (null for non-LLM extractors)
     * @param {number} config.contentSlice - Max content length for prompt
     * @param {boolean} config.usesCache - Whether this extractor keeps a per-hash temp cache file
     */
    constructor(config) {
        this.type = config.type;
        // Plugin file name, set by the loader; defaults to the extractor_<type> convention.
        this.pluginName = config.pluginName || `extractor_${config.type}`;
        this.modelEnvVar = config.modelEnvVar !== undefined ? config.modelEnvVar : `KB_LLM_${config.type.toUpperCase()}_MODEL`;
        this.contentSlice = config.contentSlice || 8000;
        this.usesCache = config.usesCache !== undefined ? config.usesCache : true;

        this.profileDir = null;
        this._configCache = null;
    }

    // ─── Lazy Loaders ─────────────────────────────────────────────────────

    getModel() {
        if (this.modelEnvVar === null) return null;
        return process.env[this.modelEnvVar] || process.env.KB_LLM_MODEL || "qwen2.5:3b";
    }

    // Profile override: ${profile}/$config/<plugin>_config.json, if it exists.
    // Otherwise the built-in one shipped next to the plugin.
    getConfigPath() {
        const fileName = `${this.pluginName}_config.json`;
        if (this.profileDir) {
            const profilePath = path.join(this.profileDir, "$config", fileName);
            if (fs.existsSync(profilePath)) return profilePath;
        }
        return path.join(PLUGIN_DIR, fileName);
    }

    // Loads { prompt: {system, user, retry}, schema: {...} } for this plugin.
    getConfig() {
        if (!this._configCache) this._configCache = JSON.parse(fs.readFileSync(this.getConfigPath(), "utf-8"));
        return this._configCache;
    }

    getPrompts() {
        return this.getConfig().prompt;
    }

    getSchema() {
        return this.getConfig().schema || {};
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    genNonce() {
        return Math.random().toString(36).slice(2, 12);
    }

    buildPrompt(content) {
        const userPrompt = this.getPrompts().user.replace("{{content}}", content.slice(0, this.contentSlice));
        return `[run-id:${this.genNonce()}]\n\n${userPrompt}`;
    }

    buildRetryPrompt(retryTag, errors) {
        const errorList = errors.map((e) => `- ${e}`).join("\n");
        return this.getPrompts().retry
            .replace("{{retry_tag}}", retryTag)
            .replace("{{errors}}", errorList);
    }

    // ─── Transform (subclasses must implement) ────────────────────────────
    // @param {Object} parsed - Parsed JSON from LLM output
    // @param {Object} options - { hash, filename, sourceDir, ... }
    // @returns {Object} Transformed result

    transform(parsed, options) {
        return parsed;
    }

    // ─── Extract with Retry ───────────────────────────────────────────────

    async extract(content, options) {
        let lastErrors = [];
        const model = this.getModel();

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            let userPrompt = this.buildPrompt(content);

            if (attempt > 1 && lastErrors.length > 0) {
                const retryTag = attempt === 2 ? "2nd retry" : "3rd retry";
                const errorBlock = this.buildRetryPrompt(retryTag, lastErrors);
                userPrompt = `${errorBlock}\n\n${userPrompt}`;
            }

            const temperature = getModelTemperature(model, attempt);

            let raw;
            try {
                raw = await llmChat(this.getPrompts().system, userPrompt, model, { temperature });
            } catch (e) {
                if (attempt < MAX_ATTEMPTS) await sleep(1000);
                continue;
            }

            try {
                const parsed = extractJSON(raw.trim());
                const schemaErrors = validateSchema(parsed, this.getSchema());
                if (schemaErrors.length > 0) {
                    lastErrors = schemaErrors;
                    continue;
                }
                return this.transform(parsed, options);
            } catch (e) {
                lastErrors = [`Output is not valid JSON: ${e.message}`];
                continue;
            }
        }

        throw new Error(`Validation failed after ${MAX_ATTEMPTS} attempts: ${lastErrors.join("; ")}`);
    }

    // ─── Cache ─────────────────────────────────────────────────────────────
    // Each extractor owns its own temp cache file. Extractors that keep no temp
    // file (usesCache=false) simply skip both read/write and cleanup.

    getCachePath(options) {
        return path.join(options.sourceDir, `${options.hash}.${this.type}.json`);
    }

    // ─── Process File ─────────────────────────────────────────────────────
    // @param {string} body - Cleaned markdown content
    // @param {Object} options - { hash, filename, sourceDir, ... }

    async processFile(body, options) {
        if (!this.usesCache) return this.extract(body, options);

        const cachePath = this.getCachePath(options);
        if (fs.existsSync(cachePath)) {
            return JSON.parse(fs.readFileSync(cachePath, "utf-8"));
        }

        const result = await this.extract(body, options);
        writeJsonFile(cachePath, result);
        return result;
    }

    // Remove the cache file this extractor created. No-op when it has none.
    cleanup(options) {
        if (!this.usesCache) return;

        const cachePath = this.getCachePath(options);
        if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
    }
}

module.exports = { BaseExtractor };
