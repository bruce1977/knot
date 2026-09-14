const fs = require("fs");

// ─── Constants ───────────────────────────────────────────────────────────────

// Fields to skip from meta in YAML output (internal use only)
const META_SKIP_FIELDS = new Set(["model"]);

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
function yamlStr(value) {
    if (value == null) return '""';
    return JSON.stringify(String(value));
}

// Format an array as a YAML array.
function yamlArr(arr) {
    if (!Array.isArray(arr)) arr = [];
    return "[" + arr.map((item) => JSON.stringify(String(item))).join(", ") + "]";
}

// ─── YAML Frontmatter Generation ─────────────────────────────────────────────

// Generate YAML frontmatter header from metadata and rating.
// @param {Object} meta - metadata object
// @param {Object} rate - rating object
// @param {string} hash - content hash
// @returns {string} YAML frontmatter string (with --- delimiters)
function generateYamlHeader(meta, rate, hash) {
    const lines = ["---"];

    // Hash
    lines.push(`hash: ${yamlStr(hash)}`);

    // Meta fields (dynamic)
    if (meta && typeof meta === "object") {
        for (const [key, value] of Object.entries(meta)) {
            if (META_SKIP_FIELDS.has(key)) continue;
            if (Array.isArray(value)) {
                lines.push(`${key}: ${yamlArr(value)}`);
            } else {
                lines.push(`${key}: ${yamlStr(value)}`);
            }
        }
    }

    // Rate fields (dynamic)
    if (rate && typeof rate === "object") {
        for (const [key, value] of Object.entries(rate)) {
            if (key === "model") continue;
            if (typeof value === "object" && value !== null && !Array.isArray(value)) {
                // Nested object like ratings
                lines.push(`${key}:`);
                for (const [subKey, subValue] of Object.entries(value)) {
                    lines.push(`  ${subKey}: ${subValue}`);
                }
            } else {
                lines.push(`${key}: ${value}`);
            }
        }
    }

    lines.push("---");
    return lines.join("\n");
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

module.exports = { generateYamlHeader, sanitizeTitle, loadJSON, META_SKIP_FIELDS };
