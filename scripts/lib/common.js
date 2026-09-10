const fs = require("fs");
const path = require("path");

// ─── Constants ───────────────────────────────────────────────────────────────

// Characters that act as word separators in titles but should NOT differentiate articles.
const TITLE_SEP_RE = /[|_\-,\，、:：;；·\/]/g;

// ─── Async Utilities ─────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Title Processing ────────────────────────────────────────────────────────

// Normalize a title: replace separator chars with space, collapse whitespace, trim.
function normalizeTitle(title) {
    return String(title || "")
        .replace(TITLE_SEP_RE, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// Produce a dedup-safe key from a title: aggressive normalization so that
// punctuation-only differences vanish.
function titleKey(title) {
    return normalizeTitle(title)
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .replace(/\s+/g, " ")
        .toLowerCase()
        .trim();
}

// ─── Data Helpers ────────────────────────────────────────────────────────────

// Coerce a parsed value into a string array.
// Handles JSON arrays and comma-separated strings.
function toStrArray(v) {
    if (Array.isArray(v)) return v.map(String).filter(Boolean);
    if (typeof v === "string") {
        return v.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    }
    return [];
}

// Coerce a parsed value to a number, or null when missing/invalid.
function toNum(v) {
    return typeof v === "number" ? v : null;
}

// ─── JSON Schema Validation ─────────────────────────────────────────────────

// Simple JSON Schema validator supporting subset of draft-07.
// Supports: type, required, properties, additionalProperties,
//           minLength, minItems, maxItems, minimum, maximum, items
function validateSchema(data, schema) {
    const errors = [];

    function validate(obj, s, path) {
        // Type check
        if (s.type) {
            const actualType = Array.isArray(obj) ? "array" : typeof obj;
            if (actualType !== s.type) {
                errors.push(`${path}: expected type ${s.type}, got ${actualType}`);
                return; // Skip further checks if type mismatches
            }
        }

        // Required properties
        if (s.required && typeof obj === "object" && !Array.isArray(obj)) {
            for (const key of s.required) {
                if (obj[key] === undefined || obj[key] === null) {
                    errors.push(`${path}.${key}: required property is missing`);
                }
            }
        }

        // Property validation
        if (s.properties && typeof obj === "object" && !Array.isArray(obj)) {
            for (const [key, propSchema] of Object.entries(s.properties)) {
                if (obj[key] !== undefined && obj[key] !== null) {
                    validate(obj[key], propSchema, `${path}.${key}`);
                }
            }
        }

        // String validations
        if (typeof obj === "string") {
            if (s.minLength !== undefined && obj.length < s.minLength) {
                errors.push(`${path}: string length ${obj.length} < minLength ${s.minLength}`);
            }
        }

        // Array validations
        if (Array.isArray(obj)) {
            if (s.minItems !== undefined && obj.length < s.minItems) {
                errors.push(`${path}: array length ${obj.length} < minItems ${s.minItems}`);
            }
            if (s.maxItems !== undefined && obj.length > s.maxItems) {
                errors.push(`${path}: array length ${obj.length} > maxItems ${s.maxItems}`);
            }
            if (s.items) {
                obj.forEach((item, i) => validate(item, s.items, `${path}[${i}]`));
            }
        }

        // Number validations
        if (typeof obj === "number") {
            if (s.minimum !== undefined && obj < s.minimum) {
                errors.push(`${path}: value ${obj} < minimum ${s.minimum}`);
            }
            if (s.maximum !== undefined && obj > s.maximum) {
                errors.push(`${path}: value ${obj} > maximum ${s.maximum}`);
            }
        }
    }

    validate(data, schema, "$");
    return errors;
}

// Load schema from file and validate data.
function validateWithSchema(data, schemaPath) {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
    return validateSchema(data, schema);
}

// ─── File Operations ─────────────────────────────────────────────────────────

// Move file with cross-volume fallback (copy + delete).
function moveFile(src, dst) {
    try {
        fs.renameSync(src, dst);
    } catch (err) {
        if (err.code === "EXDEV") {
            fs.writeFileSync(dst, fs.readFileSync(src));
            fs.unlinkSync(src);
        } else {
            throw err;
        }
    }
}

// Write JSON data to file, creating parent directory if needed.
function writeJsonFile(filePath, data) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ─── Profile Path ────────────────────────────────────────────────────────────

// Get the profile directory by combining KB_BASE_PATH and KB_DEFAULT_PROFILE.
// Returns null if neither is set.
function getProfileDir() {
    const basePath = process.env.KB_BASE_PATH;
    const defaultProfile = process.env.KB_DEFAULT_PROFILE;
    if (basePath && defaultProfile) {
        return path.join(basePath, defaultProfile);
    }
    return defaultProfile || null;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    // Constants
    TITLE_SEP_RE,

    // Async
    sleep,

    // Title
    normalizeTitle,
    titleKey,

    // Data
    toStrArray,
    toNum,

    // Validation
    validateSchema,
    validateWithSchema,

    // File
    moveFile,
    writeJsonFile,

    // Profile
    getProfileDir,
};
