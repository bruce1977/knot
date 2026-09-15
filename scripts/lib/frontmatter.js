const fs = require("fs");
const yaml = require("js-yaml");

// ─── String Helpers ──────────────────────────────────────────────────────────

// Sanitize a title for use as a filename: replace illegal chars and cap length.
function sanitizeTitle(title) {
    return String(title || "untitled")
        .replace(/[\\/:*?"<>|]/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80) || "untitled";
}

// ─── YAML Frontmatter Splitting / Parsing ────────────────────────────────────

// Frontmatter block: the opening --- must be the first line and the closing ---
// must sit on a line of its own. Content may use LF or CRLF.
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;

// Match a document's frontmatter block, or null when it has none.
function matchFrontmatter(content) {
    return typeof content === "string" ? content.match(FRONTMATTER_RE) : null;
}

// Load YAML text into an object, tolerating malformed input.
function loadYamlObject(raw) {
    try {
        const loaded = yaml.load(raw);
        return (loaded && typeof loaded === "object") ? loaded : {};
    } catch {
        // Malformed YAML is treated as empty rather than fatal: a broken header
        // should degrade to "no metadata", never abort a whole batch.
        return {};
    }
}

// Split a document into its frontmatter fields and remaining body.
// An absent or unparsable header degrades to an empty field set.
function splitFrontmatter(content) {
    const match = matchFrontmatter(content);
    if (!match) return { fields: {}, body: typeof content === "string" ? content : "" };
    return { fields: loadYamlObject(match[1]), body: content.slice(match[0].length) };
}

// Parse only the frontmatter fields. Returns null when there is no block at all.
function parseFrontmatter(content) {
    const match = matchFrontmatter(content);
    if (!match) return null;
    return loadYamlObject(match[1]);
}

// Strip the frontmatter block and return the body with leading blank lines removed.
function stripFrontmatter(content) {
    if (typeof content !== "string") return "";
    const match = matchFrontmatter(content);
    const body = match ? content.slice(match[0].length) : content;
    return body.replace(/^[\r\n]+/, "");
}

// ─── YAML Frontmatter Generation ─────────────────────────────────────────────

// Normalize a value for dumping: drop anything carrying no information and
// stringify the rest, so every emitted scalar keeps being read back as a string.
// Returns undefined for values that should be omitted entirely.
function toYamlSafe(value) {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
        if (value.length === 0) return undefined;
        return value.map(item => item === null || item === undefined ? "" : String(item));
    }
    if (typeof value === "object") {
        const nested = {};
        for (const [key, nestedValue] of Object.entries(value)) {
            const converted = toYamlSafe(nestedValue);
            if (converted === undefined) continue;
            nested[key] = converted;
        }
        return Object.keys(nested).length > 0 ? nested : undefined;
    }
    if (typeof value === "string" && value === "") return undefined;
    return String(value);
}

// Render options kept deliberately stable for downstream readers: top-level keys
// stay block-style, arrays and nested maps stay inline, nothing wraps.
const DUMP_OPTIONS = {
    flowLevel: 1,
    forceQuotes: true,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
};

// Generate YAML frontmatter header from merged extraction results.
// @param {Object} results - Merged results from all plugins
// @returns {string} YAML frontmatter string (with --- delimiters)
function generateYamlHeader(results) {
    const payload = toYamlSafe(results);
    if (!payload || Object.keys(payload).length === 0) return "---\n---";
    return `---\n${yaml.dump(payload, DUMP_OPTIONS).trimEnd()}\n---`;
}

// ─── File Utilities ──────────────────────────────────────────────────────────

// Load JSON file safely.
function loadJSON(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
        return null;
    }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    generateYamlHeader,
    sanitizeTitle,
    loadJSON,
    splitFrontmatter,
    stripFrontmatter,
    parseFrontmatter,
};
