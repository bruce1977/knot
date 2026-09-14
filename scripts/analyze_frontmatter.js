const fs = require("fs");

// ─── Constants ───────────────────────────────────────────────────────────────

// Maps internal rating keys to YAML output keys.
const RATE_KEY_MAP = {
    value: "business",
    tech: "technical",
    public: "social",
    academic: "academic",
    ethics: "ethics",
};

// ─── String Helpers ──────────────────────────────────────────────────────────

// Sanitize a title for use as a filename: replace illegal chars and cap length.
function sanitizeTitle(title) {
    return String(title || "untitled")
        .replace(/[\\/:*?"<>|]/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80) || "untitled";
}

// Format a value as a YAML string.
function yamlStr(s) {
    if (s == null) return '""';
    return JSON.stringify(String(s));
}

// Format an array as a YAML array.
function yamlArr(arr) {
    if (!Array.isArray(arr)) arr = [];
    return "[" + arr.map((x) => JSON.stringify(String(x))).join(", ") + "]";
}

// ─── YAML Frontmatter Generation ─────────────────────────────────────────────

// Generate YAML frontmatter header from metadata and rating.
// @param {Object} meta - metadata object
// @param {Object} rate - rating object
// @param {string} hash - content hash
// @returns {string} YAML frontmatter string (with --- delimiters)
function generateYamlHeader(meta, rate, hash) {
    const raw = (rate && rate.ratings) || {};
    const ratings = {};

    for (const [k, v] of Object.entries(RATE_KEY_MAP)) {
        ratings[v] = typeof raw[k] === "number" ? raw[k] : null;
    }

    // Script-computed score (average), fallback for backward compat with old .rate.json
    let avg = rate?.score;
    if (typeof avg !== "number") {
        const vals = [ratings.business, ratings.technical, ratings.social, ratings.academic, ratings.ethics]
            .filter((v) => typeof v === "number");
        avg = vals.length > 0 ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
    }

    const lines = [
        "---",
        `hash: ${yamlStr(hash)}`,
        `title: ${yamlStr(meta.title || "")}`,
        `auther: ${yamlStr(meta.auther || "")}`,
        `date: ${yamlStr(meta.date || "")}`,
        `source: ${yamlStr(meta.source || "")}`,
        `tags: ${yamlArr(meta.tags)}`,
        `keywords: ${yamlStr(meta.keywords)}`,
        `aliases: ${yamlArr(meta.aliases)}`,
        `summary: ${yamlStr(meta.summary || "")}`,
        `model: ${yamlStr(meta.model || "")}`,
        `score: ${avg}`,
        "rating:",
        `  business: ${ratings.business}`,
        `  technical: ${ratings.technical}`,
        `  social: ${ratings.social}`,
        `  academic: ${ratings.academic}`,
        `  ethics: ${ratings.ethics}`,
        "---",
    ];

    return lines.join("\n");
}

// ─── File Utilities ──────────────────────────────────────────────────────────

// Load JSON file safely.
function loadJSON(p) {
    try {
        return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
        return null;
    }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = { generateYamlHeader, sanitizeTitle, loadJSON, RATE_KEY_MAP };
