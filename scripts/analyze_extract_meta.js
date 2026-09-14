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

// Resolve custom dirs from profile
function getCustomDirs() {
    const profileDir = process.env.KB_PROFILE_DIR;
    if (!profileDir) return { promptDir: DEFAULT_PROMPT_DIR, schemaDir: DEFAULT_SCHEMA_DIR };
    const cfgDir = path.join(profileDir, ".config");
    const promptDir = path.join(cfgDir, "prompts");
    const schemaDir = path.join(cfgDir, "schema");
    return {
        promptDir: fs.existsSync(promptDir) ? promptDir : DEFAULT_PROMPT_DIR,
        schemaDir: fs.existsSync(schemaDir) ? schemaDir : DEFAULT_SCHEMA_DIR,
    };
}

const _dirs = getCustomDirs();

// Load prompts (custom or default)
function loadPrompt(name) {
    return require(path.join(_dirs.promptDir, name + ".json"));
}

// Load schema (custom or default)
function loadSchema(name) {
    return path.join(_dirs.schemaDir, name + ".json");
}

const SCHEMA_PATH = loadSchema("meta");
const prompts = loadPrompt("meta");

// Per-process nonce: unique per invocation, defeats Ollama serving cached completions.
function genNonce() {
    return Math.random().toString(36).slice(2, 12);
}

// ─── Prompt Building ─────────────────────────────────────────────────────────

function buildPrompt(content) {
    const userPrompt = prompts.user.replace("{{content}}", content.slice(0, 8000));
    return `[run-id:${genNonce()}]\n\n${userPrompt}`;
}

function buildRetryPrompt(retryTag, errors) {
    const errorList = errors.map((e) => `- ${e}`).join("\n");
    return prompts.retry
        .replace("{{retry_tag}}", retryTag)
        .replace("{{errors}}", errorList);
}

// ─── Metadata Construction ───────────────────────────────────────────────────

function buildMeta(parsed) {
    // keywords: keep as comma-separated string (LLM outputs "word1,word2,word3")
    const rawKeywords = String(parsed.keywords || "").trim();

    return {
        title: normalizeTitle(parsed.title || ""),
        date: nowIso(),
        auther: String(parsed.auther || ""),
        tags: toStrArray(parsed.tags),
        summary: String(parsed.summary || ""),
        keywords: rawKeywords,
        aliases: toStrArray(parsed.aliases),
        model: MODEL,
    };
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
            raw = await llmChat(prompts.system, userPrompt, MODEL, { temperature });
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
        const schemaErrors = validateWithSchema(candidate, SCHEMA_PATH);
        if (schemaErrors.length > 0) {
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
