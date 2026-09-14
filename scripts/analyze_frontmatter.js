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

// ─── YAML Parsing ────────────────────────────────────────────────────────────

// Parse simple YAML frontmatter into an object.
// Supports: string, number, boolean, array, nested objects.
function parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const lines = match[1].split("\n");
    const result = {};
    let currentKey = null;
    let currentIndent = 0;
    let nestedObj = null;

    for (const line of lines) {
        const indentMatch = line.match(/^(\s*)/);
        const indent = indentMatch ? indentMatch[1].length : 0;

        // Handle nested objects
        if (currentKey && indent > currentIndent && nestedObj) {
            const kvMatch = line.match(/^\s+(\w+):\s*(.*)$/);
            if (kvMatch) {
                nestedObj[kvMatch[1]] = parseYamlValue(kvMatch[2]);
                continue;
            }
        }

        // Reset nested object if we're back to top level
        if (nestedObj && indent <= currentIndent) {
            result[currentKey] = nestedObj;
            nestedObj = null;
        }

        const kvMatch = line.match(/^(\w+):\s*(.*)$/);
        if (kvMatch) {
            const key = kvMatch[1];
            const value = kvMatch[2];

            // Check if this starts a nested object (value is empty)
            if (value === "" || value === "|") {
                currentKey = key;
                currentIndent = indent;
                nestedObj = {};
            } else {
                result[key] = parseYamlValue(value);
                currentKey = null;
                nestedObj = null;
            }
        }
    }

    // Don't forget the last nested object
    if (nestedObj && currentKey) {
        result[currentKey] = nestedObj;
    }

    return result;
}

// Parse a YAML value string into appropriate JS type.
function parseYamlValue(value) {
    const trimmed = value.trim();

    // Array
    if (trimmed.startsWith("[")) {
        try {
            return JSON.parse(trimmed);
        } catch {
            return trimmed;
        }
    }

    // Number
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        return Number(trimmed);
    }

    // Boolean
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;

    // Null
    if (trimmed === "null" || trimmed === "~") return null;

    // String (remove quotes)
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }

    return trimmed;
}

// ─── YAML Frontmatter Generation ─────────────────────────────────────────────

// Generate YAML frontmatter header from metadata and rating.
// Merges with existing frontmatter if provided (new fields override old ones).
// @param {Object} meta - metadata object
// @param {Object} rate - rating object
// @param {string} hash - content hash
// @param {Object|null} existingHeader - existing frontmatter object to merge
// @returns {string} YAML frontmatter string (with --- delimiters)
function generateYamlHeader(meta, rate, hash, existingHeader = null) {
    const lines = ["---"];
    const addedKeys = new Set();

    // 1. Hash first
    lines.push(`hash: ${yamlStr(hash)}`);
    addedKeys.add("hash");

    // 2. Meta fields
    if (meta && typeof meta === "object") {
        for (const [key, value] of Object.entries(meta)) {
            if (META_SKIP_FIELDS.has(key)) continue;
            if (value === null || value === undefined) continue;
            if (Array.isArray(value) && value.length === 0) continue;
            if (typeof value === "string" && value === "") continue;
            lines.push(Array.isArray(value) ? `${key}: ${yamlArr(value)}` : `${key}: ${yamlStr(value)}`);
            addedKeys.add(key);
        }
    }

    // 3. Rate fields
    if (rate && typeof rate === "object") {
        for (const [key, value] of Object.entries(rate)) {
            if (key === "model") continue;
            if (value === null || value === undefined) continue;
            if (typeof value === "object" && value !== null && !Array.isArray(value)) {
                // Nested object - skip if all values are null
                const nonNullValues = Object.values(value).filter((v) => v !== null);
                if (nonNullValues.length === 0) continue;
                lines.push(`${key}:`);
                for (const [subKey, subValue] of Object.entries(value)) {
                    lines.push(`  ${subKey}: ${subValue}`);
                }
            } else {
                lines.push(`${key}: ${value}`);
            }
            addedKeys.add(key);
        }
    }

    // 4. Existing fields (only those not already added)
    if (existingHeader && typeof existingHeader === "object") {
        for (const [key, value] of Object.entries(existingHeader)) {
            if (addedKeys.has(key)) continue;
            if (value === null || value === undefined) continue;
            if (Array.isArray(value) && value.length === 0) continue;
            if (typeof value === "string" && value === "") continue;
            if (typeof value === "object" && value !== null && !Array.isArray(value)) {
                const nonNullValues = Object.values(value).filter((v) => v !== null);
                if (nonNullValues.length === 0) continue;
                lines.push(`${key}:`);
                for (const [subKey, subValue] of Object.entries(value)) {
                    lines.push(`  ${subKey}: ${subValue}`);
                }
            } else {
                lines.push(Array.isArray(value) ? `${key}: ${yamlArr(value)}` : `${key}: ${yamlStr(value)}`);
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

module.exports = { generateYamlHeader, sanitizeTitle, loadJSON, parseFrontmatter, META_SKIP_FIELDS };
