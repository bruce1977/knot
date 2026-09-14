const fs = require("fs");
const path = require("path");
const { llmChat, extractJSON, getModelTemperature } = require("./lib/llm");
const { sleep, toNum, writeJsonFile, validateWithSchema } = require("./lib/common");

// ─── Constants ───────────────────────────────────────────────────────────────

const MODEL = process.env.KB_LLM_RATE_MODEL || process.env.KB_LLM_MODEL || "qwen2.5:3b";
const SCRIPT_DIR = path.dirname(__filename || __dirname);
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_PROMPT_DIR = path.join(SKILL_DIR, "prompts");
const DEFAULT_SCHEMA_DIR = path.join(SKILL_DIR, "schemas");
const MAX_ATTEMPTS = 3;

// Resolve custom dirs from profile (lazy: called after KB_PROFILE_DIR is set)
let _dirsCache = null;
function getCustomDirs() {
    if (_dirsCache) return _dirsCache;
    const profileDir = process.env.KB_PROFILE_DIR;
    if (!profileDir) {
        _dirsCache = { promptDir: DEFAULT_PROMPT_DIR, schemaDir: DEFAULT_SCHEMA_DIR };
        return _dirsCache;
    }
    const cfgDir = path.join(profileDir, ".config");
    const promptDir = path.join(cfgDir, "prompts");
    const schemaDir = path.join(cfgDir, "schema");
    _dirsCache = {
        promptDir: fs.existsSync(promptDir) ? promptDir : DEFAULT_PROMPT_DIR,
        schemaDir: fs.existsSync(schemaDir) ? schemaDir : DEFAULT_SCHEMA_DIR,
    };
    return _dirsCache;
}

// Load prompts (custom or default)
function loadPrompt(name) {
    return require(path.join(getCustomDirs().promptDir, name + ".json"));
}

// Load schema (custom or default)
function loadSchema(name) {
    return path.join(getCustomDirs().schemaDir, name + ".json");
}

// Lazy: loaded after KB_PROFILE_DIR is set
let _schemaPathCache = null;
function getSchemaPath() {
    if (!_schemaPathCache) _schemaPathCache = loadSchema("rate");
    return _schemaPathCache;
}

let _promptsCache = null;
function getPrompts() {
    if (!_promptsCache) _promptsCache = loadPrompt("rate");
    return _promptsCache;
}

// Per-process nonce: unique per invocation, defeats Ollama serving cached completions.
function genNonce() {
    return Math.random().toString(36).slice(2, 12);
}

// ─── Prompt Building ─────────────────────────────────────────────────────────

function buildPrompt(content) {
    const userPrompt = getPrompts().user.replace("{{content}}", content.slice(0, 6000));

    return `[run-id:${genNonce()}]\n\n${userPrompt}`;
}

function buildRetryPrompt(retryTag, errors) {
    const errorList = errors.map((e) => `- ${e}`).join("\n");
    return getPrompts().retry
        .replace("{{retry_tag}}", retryTag)
        .replace("{{errors}}", errorList);
}

// ─── Rating Construction ─────────────────────────────────────────────────────

function buildRate(parsed) {
    const ratings = {
        value: toNum(parsed.value),
        tech: toNum(parsed.tech),
        public: toNum(parsed.public),
        academic: toNum(parsed.academic),
        ethics: toNum(parsed.ethics),
    };

    // Compute score as average of all rating dimensions
    const values = Object.values(ratings).filter((v) => v !== null);
    const score = values.length > 0
        ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
        : null;

    return { ratings, score };
}

// ─── LLM Extraction with Retry ──────────────────────────────────────────────

async function extractWithRetry(content) {
    let lastErrors = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let userPrompt = buildPrompt(content);

        // Prepend error feedback on retries.
        if (attempt > 1 && lastErrors.length > 0) {
            const retryTag = attempt === 2 ? "2nd retry" : "3rd retry";
            const errorBlock = buildRetryPrompt(retryTag, lastErrors);
            userPrompt = `${errorBlock}\n\n${userPrompt}`;
        }

        // Temperature from model-specific scheme.
        const temperature = getModelTemperature(MODEL, attempt);

        if (attempt > 1) {
            console.log(`... [rate] requesting LLM (attempt ${attempt}/${MAX_ATTEMPTS})...`);
        }

        let raw;
        try {
            raw = await llmChat(getPrompts().system, userPrompt, MODEL, { temperature });
        } catch (e) {
            if (attempt < MAX_ATTEMPTS) {
                await sleep(1000);
            }

            continue;
        }

        let candidate;
        try {
            candidate = buildRate(extractJSON(raw.trim()));
        } catch (e) {
            lastErrors = [`Output is not valid JSON: ${e.message}`];
            continue;
        }

        // Schema validation
        const schemaPath = getSchemaPath();
        const schemaErrors = validateWithSchema(candidate, schemaPath);
        if (schemaErrors.length > 0) {
            console.log(`... [rate] schema path: ${schemaPath}`);
            lastErrors = schemaErrors;
            continue;
        }

        return candidate;
    }

    throw new Error(`Validation failed after ${MAX_ATTEMPTS} attempts: ${lastErrors.join("; ")}`);
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

// Extract rating from content and write to target file.
// @param {string} content - markdown content to rate
// @param {string} targetFile - path to write .rate.json output
// @returns {Promise<void>}
// @throws {Error} if extraction or validation fails
async function processFile(content, targetFile) {
    const rate = await extractWithRetry(content);
    writeJsonFile(targetFile, rate);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = { processFile };
