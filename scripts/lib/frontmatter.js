const fs = require("fs");

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

// Write a single key-value pair to YAML lines.
// Handles nested objects and arrays.
function writeYamlEntry(key, value, lines, indent = 0) {
    if (value === null || value === undefined) return;
    if (Array.isArray(value) && value.length === 0) return;
    if (typeof value === "string" && value === "") return;

    const prefix = "  ".repeat(indent);

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        // Nested object
        const entries = Object.entries(value).filter(([, v]) => v !== null && v !== undefined);
        if (entries.length === 0) return;
        lines.push(`${prefix}${key}:`);
        for (const [subKey, subValue] of entries) {
            writeYamlEntry(subKey, subValue, lines, indent + 1);
        }
    } else if (Array.isArray(value)) {
        lines.push(`${prefix}${key}: ${yamlArr(value)}`);
    } else {
        lines.push(`${prefix}${key}: ${yamlStr(value)}`);
    }
}

// Generate YAML frontmatter header from merged extraction results.
// @param {Object} results - Merged results from all plugins
// @returns {string} YAML frontmatter string (with --- delimiters)
function generateYamlHeader(results) {
    const lines = ["---"];

    // Write all fields from merged results
    for (const [key, value] of Object.entries(results)) {
        writeYamlEntry(key, value, lines);
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

module.exports = { generateYamlHeader, sanitizeTitle, loadJSON, parseFrontmatter, writeYamlEntry };
