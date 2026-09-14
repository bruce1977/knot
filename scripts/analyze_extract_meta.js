const fs = require("fs");
const path = require("path");
const { llmChat, extractJSON, nowIso, getModelTemperature } = require("./lib/llm");
const { sleep, normalizeTitle, toStrArray, writeJsonFile, validateWithSchema } = require("./lib/common");

// ─── Constants ───────────────────────────────────────────────────────────────

const MODEL = process.env.KB_LLM_META_MODEL || process.env.KB_LLM_MODEL || "qwen2.5:3b";
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
    if (!_schemaPathCache) _schemaPathCache = loadSchema("meta");
    return _schemaPathCache;
}

let _promptsCache = null;
function getPrompts() {
    if (!_promptsCache) _promptsCache = loadPrompt("meta");
    return _promptsCache;
}

// Per-process nonce: unique per invocation, defeats Ollama serving cached completions.
function genNonce() {
    return Math.random().toString(36).slice(2, 12);
}

// ─── Prompt Building ─────────────────────────────────────────────────────────

function buildPrompt(content) {
    const userPrompt = getPrompts().user.replace("{{content}}", content.slice(0, 8000));
    return `[run-id:${genNonce()}]\n\n${userPrompt}`;
}

function buildRetryPrompt(retryTag, errors) {
    const errorList = errors.map((e) => `- ${e}`).join("\n");
    return getPrompts().retry
        .replace("{{retry_tag}}", retryTag)
        .replace("{{errors}}", errorList);
}

// ─── Metadata Construction ───────────────────────────────────────────────────

function buildMeta(parsed) {
    // Dynamic: pass through all fields from LLM output
    // Skip empty strings for optional fields (LLM should omit, not output "")
    const result = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string" && value === "") continue;
        result[key] = value;
    }
    // Add model field
    result.model = MODEL;
    return result;
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
            console.log(`... [meta] requesting LLM (attempt ${attempt}/${MAX_ATTEMPTS})...`);
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
            candidate = buildMeta(extractJSON(raw.trim()));
        } catch (e) {
            lastErrors = [`Output is not valid JSON: ${e.message}`];
            continue;
        }

        // Schema validation
        const schemaPath = getSchemaPath();
        const schemaErrors = validateWithSchema(candidate, schemaPath);
        if (schemaErrors.length > 0) {
            console.log(`... [meta] schema path: ${schemaPath}`);
            lastErrors = schemaErrors;
            continue;
        }

        return candidate;
    }

    throw new Error(`Validation failed after ${MAX_ATTEMPTS} attempts: ${lastErrors.join("; ")}`);
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

// Extract metadata from content and write to target file.
// @param {string} content - markdown content to extract metadata from
// @param {string} targetFile - path to write .meta.json output
// @returns {Promise<void>}
// @throws {Error} if extraction or validation fails
async function processFile(content, targetFile) {
    const meta = await extractWithRetry(content);

    writeJsonFile(targetFile, meta);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = { processFile };
