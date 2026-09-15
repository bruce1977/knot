const fs = require("fs");
const { stripFrontmatter } = require("./frontmatter");

// ─── Configuration ───────────────────────────────────────────────────────────

const KB_LLM_BASE_URL = process.env.KB_LLM_BASE_URL || "http://localhost:11434/v1";
const KB_LLM_API_KEY = process.env.KB_LLM_API_KEY || "";
const DEFAULT_MODEL = "qwen2.5:3b";
const MODEL = process.env.KB_LLM_MODEL || DEFAULT_MODEL;

// Provider can be set explicitly to "ollama" | "openai"; defaults to auto-detect by base_url.
const KB_LLM_PROVIDER = (process.env.KB_LLM_PROVIDER || "auto").toLowerCase();

const REQUEST_TIMEOUT_MS = Number(process.env.KB_LLM_TIMEOUT_MS || 300000);

// Caller already retries 3x on validation failure; this only guards transport errors.
const MAX_RETRIES = 2;

// ─── Statistics ──────────────────────────────────────────────────────────────

// Module-level counters for LLM request accounting.
const _llmStats = { calls: 0, retries: 0 };

function getLlmStats() {
    return { ..._llmStats };
}

// ─── Model Profiles ──────────────────────────────────────────────────────────

// Per-model inference settings. Profiles are matched in order against the
// lowercased model name; the first match wins, otherwise DEFAULT_PROFILE is used.
const DEFAULT_PROFILE = {
    // temperature ramp for retries: attempt 1 -> 2 -> 3
    temperature: [0.1, 0.2, 0.5],
    params: {
        top_k: 20,
        top_p: 0.8,
        repeat_penalty: 1.0,
        presence_penalty: 1.5,
    },
};

const MODEL_PROFILES = [
    // Qwen 3.5 (non-thinking, respects think:false).
    {
        match: (m) => m.includes("qwen3.5"),
        temperature: [0.7, 0.8, 0.9],
        params: {
            top_k: 20,
            top_p: 0.8,
            repeat_penalty: 1.0,
            presence_penalty: 1.5,
        },
    },
    // Qwen 2.5.
    {
        match: (m) => m.includes("qwen2.5"),
        temperature: [0.1, 0.2, 0.5],
        params: {
            top_k: 40,
            top_p: 0.8,
            repeat_penalty: 1.1,
            presence_penalty: 0,
        },
    },
];

// Shared params for every backend.
const GEN_PARAMS = {
    temperature: 0.1,
    max_tokens: 4000,
};

// Ollama-only params, merged after the model profile so profile values win.
const OLLAMA_PARAMS = {
    num_predict: 4000,
    num_ctx: 8192,
    keep_alive: -1,
};

function getModelProfile(modelName) {
    const model = (modelName || "").toLowerCase();
    return MODEL_PROFILES.find((p) => p.match(model)) || DEFAULT_PROFILE;
}

// Return temperature for a given model and attempt number (1-based).
function getModelTemperature(modelName, attempt = 1) {
    const temps = getModelProfile(modelName).temperature;
    const index = Math.max(0, Math.min(attempt - 1, temps.length - 1));
    return temps[index];
}

// Return model-specific inference parameters for Ollama backends.
function getModelParams(modelName) {
    return { ...getModelProfile(modelName).params };
}

// ─── Provider Detection ──────────────────────────────────────────────────────

// Decide whether the target backend is Ollama.
function isOllamaTarget() {
    if (KB_LLM_PROVIDER === "ollama") return true;
    if (KB_LLM_PROVIDER === "openai") return false;
    return /(11434|ollama)/i.test(KB_LLM_BASE_URL);
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (KB_LLM_API_KEY) headers["Authorization"] = `Bearer ${KB_LLM_API_KEY}`;
    return headers;
}

// ─── Thinking Content Stripping ──────────────────────────────────────────────

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

// Strip <think>...</think> blocks from LLM output, returning everything after
// the last closing tag (or after the opening tag if never closed).
function stripThinking(text) {
    if (!text.includes(THINK_OPEN)) return text;

    const lastClose = text.lastIndexOf(THINK_CLOSE);
    const bodyStart =
        lastClose === -1
            ? text.indexOf(THINK_OPEN) + THINK_OPEN.length
            : lastClose + THINK_CLOSE.length;

    return text.slice(bodyStart).replace(/^\n+/, "");
}

// ─── LLM Chat ────────────────────────────────────────────────────────────────

// Derive Ollama native API base (e.g. "http://localhost:11434") from the
// configured base URL (which may include a /v1 OpenAI-compat suffix).
function ollamaNativeBaseUrl() {
    return KB_LLM_BASE_URL.replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

// Ollama native /api/chat: think:false reliably disables reasoning for Qwen3.5,
// whereas the OpenAI-compatible /v1/chat/completions endpoint ignores it.
async function callOllamaNativeChat(systemPrompt, userPrompt, useModel, params, signal) {
    const res = await fetch(`${ollamaNativeBaseUrl()}/api/chat`, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({
            model: useModel,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ],
            think: false,
            stream: false,
        }),
        signal,
    });

    if (!res.ok) {
        const errorText = await res.text().catch(() => "unable to read error");
        throw new Error(`HTTP ${res.status}: ${errorText}`);
    }

    const data = await res.json();
    const content = data.message?.content;
    if (!content) throw new Error("empty LLM response");

    return stripThinking(content);
}

// OpenAI-compatible /chat/completions. Qwen3.5 in thinking mode may leave
// content empty while reasoning holds the JSON; salvage it as a fallback.
async function callOpenAICompatChat(systemPrompt, userPrompt, useModel, params, signal) {
    const res = await fetch(`${KB_LLM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({
            model: useModel,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ],
            stream: false,
            chat_template_kwargs: { enable_thinking: false },
            ...params,
        }),
        signal,
    });

    if (!res.ok) {
        const errorText = await res.text().catch(() => "unable to read error");
        throw new Error(`HTTP ${res.status}: ${errorText}`);
    }

    const data = await res.json();
    const message = data.choices?.[0]?.message;
    let content = message?.content;

    if (!content && message?.reasoning) {
        const jsonMatch = message.reasoning.match(/\{[\s\S]*\}/);
        if (jsonMatch) content = jsonMatch[0];
    }

    if (!content) throw new Error("empty LLM response");

    return stripThinking(content);
}

async function llmChat(systemPrompt, userPrompt, model, opts = {}) {
    const useModel = model || MODEL;
    const temperature =
        typeof opts.temperature === "number"
            ? opts.temperature
            : getModelTemperature(useModel);

    const baseParams = isOllamaTarget()
        ? { ...GEN_PARAMS, ...OLLAMA_PARAMS, ...getModelParams(useModel) }
        : { ...GEN_PARAMS };
    const params = { ...baseParams, temperature };

    let lastErr;
    _llmStats.calls += 1;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            if (isOllamaTarget()) {
                return await callOllamaNativeChat(systemPrompt, userPrompt, useModel, params, controller.signal);
            }
            return await callOpenAICompatChat(
                systemPrompt,
                userPrompt,
                useModel,
                params,
                controller.signal
            );
        } catch (err) {
            lastErr = err;
            // Retries stay silent per file; counts surface in the run summary.
            if (attempt < MAX_RETRIES) {
                _llmStats.retries += 1;
                await sleep(1000 * attempt);
            }
        } finally {
            clearTimeout(timer);
        }
    }

    throw new Error(`LLM failed after ${MAX_RETRIES} retries: ${lastErr && lastErr.message}`);
}

// ─── JSON Extraction ─────────────────────────────────────────────────────────

// Extract the first JSON object from LLM output using brace counting.
function extractJSON(text) {
    const start = text.indexOf("{");
    if (start === -1) throw new Error("no JSON object in LLM output");

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i++) {
        const ch = text[i];

        if (escape) {
            escape = false;
            continue;
        }
        if (ch === "\\") {
            escape = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;

        if (ch === "{") {
            depth++;
        } else if (ch === "}") {
            depth--;
            if (depth === 0) {
                return JSON.parse(text.slice(start, i + 1));
            }
        }
    }

    throw new Error("no complete JSON object in LLM output");
}

// ─── Prompt Loading ──────────────────────────────────────────────────────────

// Load a prompt template and replace {{var}} placeholders.
function loadPrompt(templatePath, vars) {
    let tpl = fs.readFileSync(templatePath, "utf-8");
    for (const [key, value] of Object.entries(vars)) {
        tpl = tpl.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }
    return tpl;
}

// ─── Date Formatting ─────────────────────────────────────────────────────────

// Format current time as ISO 8601 with +08:00 timezone.
function nowIso() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}+08:00`;
}

// ─── Content Processing ──────────────────────────────────────────────────────

// stripFrontmatter now comes from lib/frontmatter, so every stage splits headers
// with the same YAML-aware logic.

// Remove WeChat article scraping residue: injected CSS, reader buttons, and
// javascript:void(0) links. When a cover_image marker exists, drop everything
// before it (the scraper injects CSS/HTML residue ahead of the cover).
function cleanWechatContent(content) {
    if (!content) return content;

    // Keep content from the cover image marker onward when present.
    let text = content.includes("![cover_image]")
        ? content.slice(content.indexOf("![cover_image]"))
        : content;

    // Drop any line that is (or contains) a CSS rule block, e.g.
    // "#js_row_immersive_stream_wrap { max-width: 667px; margin: 0 auto; }".
    const cssLineRe = /(?:^|\s)(?:[#.]|(?:[a-z]+\s*)?[a-z]{2,}\s)\S*\{[^}]*;[^}]*\}/;
    text = text
        // Drop javascript:void(0) markdown links (keep link text), including
        // escaped parentheses from the scraper.
        .replace(/\[([^\]]*)\]\(javascript:void[\\(]*[^)]*[)\\]*;?\)*/gi, "$1")
        // Drop reader UI button lines.
        .replace(/^\s*在小说阅读器读本章\s*$/gm, "")
        .replace(/^\s*在小说阅读器中沉浸阅读\s*$/gm, "")
        .replace(/^\s*去阅读\s*$/gm, "")
        // Drop CSS rule lines (may appear at the head or inside the body).
        .split("\n")
        .filter((line) => !cssLineRe.test(line))
        .join("\n")
        // Collapse 3+ blank lines into one.
        .replace(/\n{3,}/g, "\n\n")
        .replace(/^\n+/, "")
        .trim();

    return text;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    llmChat,
    extractJSON,
    loadPrompt,
    nowIso,
    stripFrontmatter,
    cleanWechatContent,
    stripThinking,
    MODEL,
    MAX_RETRIES,
    getLlmStats,
    getModelTemperature,
    getModelParams,
};
