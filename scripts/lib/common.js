const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ─── Constants ───────────────────────────────────────────────────────────────

// Characters that act as word separators in titles but should NOT differentiate articles.
const TITLE_SEP_RE = /[|_\-,\，、:：;；·\/]/g;

// Hash computation settings: 3 rounds of SHA-256, truncated to 12 hex chars.
const HASH_ROUNDS = 3;
const HASH_LENGTH = 12;

// Markdown validation thresholds.
const MIN_FILE_SIZE = 512;        // 1KB
const MIN_TEXT_LENGTH = 200;       // minimum 200 characters of plain text
const MIN_CHINESE_RATIO = 0;       // disabled: code-heavy docs fail this check

// ─── Async Utilities ─────────────────────────────────────────────────────────

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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

// ─── Content Hash ────────────────────────────────────────────────────────────

// Compute a stable content hash by iterating SHA-256 multiple times.
// Multiple rounds increase collision resistance for short hashes.
function contentHash(content) {
    let hash = content;
    for (let round = 0; round < HASH_ROUNDS; round++) {
        hash = crypto.createHash("sha256").update(hash).digest("hex");
    }
    return hash.slice(0, HASH_LENGTH);
}

// ─── Markdown Validation ────────────────────────────────────────────────────

// Strip HTML tags, CSS blocks, JS blocks, and Markdown formatting to get plain text.
function cleanContent(rawText) {
    let text = rawText;
    text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
    text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
    text = text.replace(/<[^>]+>/g, "");
    text = text.replace(/\/\*[\s\S]*?\*\//g, "");
    text = text.replace(/#[^{]*\{[^}]*\}/g, "");
    text = text.replace(/```[\s\S]*?```/g, "");
    text = text.replace(/`[^`]+`/g, "");
    text = text.replace(/!\[.*?\]\(.*?\)/g, "");
    text = text.replace(/\[([^\]]*)\]\(.*?\)/g, "$1");
    text = text.replace(/[-*_]{3,}/g, "");
    text = text.replace(/#+\s*/g, "");
    return text.trim();
}

// Validate a markdown file: check file size, text length, and Chinese ratio.
function validateMd(filePath) {
    const errors = [];

    // File size check
    const stat = fs.statSync(filePath);
    if (stat.size < MIN_FILE_SIZE) {
        errors.push(`file too small: ${stat.size} bytes < ${MIN_FILE_SIZE}`);
        return errors;
    }

    // Content cleaning and validation
    const raw = fs.readFileSync(filePath, "utf-8");
    const cleaned = cleanContent(raw);

    // Text length check
    if (cleaned.length < MIN_TEXT_LENGTH) {
        errors.push(`text too short: ${cleaned.length} chars < ${MIN_TEXT_LENGTH}`);
    }

    // Chinese character ratio check
    const chineseChars = cleaned.match(/[\u4e00-\u9fa5]/g) || [];
    const ratio = chineseChars.length / cleaned.length;
    if (ratio < MIN_CHINESE_RATIO) {
        errors.push(`chinese ratio too low: ${(ratio * 100).toFixed(1)}% < ${MIN_CHINESE_RATIO * 100}%`);
    }

    return errors;
}

// Move invalid file to error directory with timestamp suffix to avoid overwrite.
function moveToError(filePath, errorDir) {
    if (!fs.existsSync(errorDir)) {
        fs.mkdirSync(errorDir, { recursive: true });
    }

    const basename = path.basename(filePath);
    const destination = path.join(errorDir, basename);

    if (fs.existsSync(destination)) {
        const ext = path.extname(basename);
        const name = path.basename(basename, ext);
        const destinationWithTimestamp = path.join(errorDir, `${name}_${Date.now()}${ext}`);
        fs.renameSync(filePath, destinationWithTimestamp);
        return destinationWithTimestamp;
    }

    fs.renameSync(filePath, destination);
    return destination;
}

// ─── Data Helpers ────────────────────────────────────────────────────────────

// Coerce a parsed value into a string array.
// Handles JSON arrays and comma-separated strings.
function toStrArray(value) {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (typeof value === "string") {
        return value.split(/[,，、]/).map((item) => item.trim()).filter(Boolean);
    }
    return [];
}

// Coerce a parsed value to a number, or null when missing/invalid.
function toNum(value) {
    return typeof value === "number" ? value : null;
}

// ─── JSON Schema Validation ─────────────────────────────────────────────────

// Minimal schema validator.
// Format:
//   "string"                 - required string (minLength 1)
//   ["optional", "string"]   - optional string
//   ["string", min]          - required string with minLength
//   ["optional", "string", min] - optional string with minLength
//   ["number", min, max]     - required number with range
//   ["optional", "number", min, max] - optional number with range
//   ["array", min, max]      - required array with item count range
//   ["optional", "array", min, max] - optional array with item count range
//   { "key": ... }           - nested object (all keys required)
//   { "key?": ... }          - nested object with optional key
function validateSchema(data, schema) {
    const errors = [];

    function validate(obj, schemaNode, currentPath) {
        const isOptional = Array.isArray(schemaNode) && schemaNode[0] === "optional";
        const actual = isOptional ? schemaNode.slice(1) : schemaNode;

        // Check if value exists
        if (obj === undefined || obj === null) {
            if (!isOptional) {
                errors.push(`${currentPath}: required property is missing`);
            }
            return;
        }

        // String shorthand: "string" or ["string", minLength]
        if (actual === "string") {
            if (typeof obj !== "string") {
                errors.push(`${currentPath}: expected string, got ${typeof obj}`);
            } else if (obj.length === 0) {
                errors.push(`${currentPath}: string is empty`);
            }
            return;
        }
        if (Array.isArray(actual) && actual[0] === "string") {
            if (typeof obj !== "string") {
                errors.push(`${currentPath}: expected string, got ${typeof obj}`);
            } else if (actual[1] !== undefined && obj.length < actual[1]) {
                errors.push(`${currentPath}: string length ${obj.length} < ${actual[1]}`);
            }
            return;
        }

        // Number shorthand: ["number", min, max]
        if (Array.isArray(actual) && actual[0] === "number") {
            if (typeof obj !== "number") {
                errors.push(`${currentPath}: expected number, got ${typeof obj}`);
            } else {
                if (actual[1] !== undefined && obj < actual[1]) {
                    errors.push(`${currentPath}: value ${obj} < ${actual[1]}`);
                }
                if (actual[2] !== undefined && obj > actual[2]) {
                    errors.push(`${currentPath}: value ${obj} > ${actual[2]}`);
                }
            }
            return;
        }

        // Array shorthand: ["array", minItems, maxItems]
        if (Array.isArray(actual) && actual[0] === "array") {
            if (!Array.isArray(obj)) {
                errors.push(`${currentPath}: expected array, got ${typeof obj}`);
            } else {
                if (actual[1] !== undefined && obj.length < actual[1]) {
                    errors.push(`${currentPath}: array length ${obj.length} < ${actual[1]}`);
                }
                if (actual[2] !== undefined && obj.length > actual[2]) {
                    errors.push(`${currentPath}: array length ${obj.length} > ${actual[2]}`);
                }
            }
            return;
        }

        // Object: nested schema
        if (typeof actual === "object" && actual !== null && !Array.isArray(actual)) {
            if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
                errors.push(`${currentPath}: expected object, got ${typeof obj}`);
                return;
            }
            for (const [key, subSchema] of Object.entries(actual)) {
                const keyOptional = key.endsWith("?");
                const actualKey = keyOptional ? key.slice(0, -1) : key;
                if (keyOptional) {
                    // Optional field: skip if not present
                    if (obj[actualKey] !== undefined && obj[actualKey] !== null) {
                        validate(obj[actualKey], subSchema, `${currentPath}.${actualKey}`);
                    }
                } else {
                    if (obj[actualKey] === undefined || obj[actualKey] === null) {
                        errors.push(`${currentPath}.${actualKey}: required property is missing`);
                    } else {
                        validate(obj[actualKey], subSchema, `${currentPath}.${actualKey}`);
                    }
                }
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
function moveFile(source, destination) {
    try {
        fs.renameSync(source, destination);
    } catch (err) {
        if (err.code === "EXDEV") {
            fs.writeFileSync(destination, fs.readFileSync(source));
            fs.unlinkSync(source);
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

// Resolve profile from argument or environment, load config section, apply defaults.
// Exits with error if profile cannot be determined.
// @param {string} [profileArg] - Profile argument from command line
// @param {string} section - Config section name (e.g., 'analyze', 'archive', 'weknora')
// @param {Object} defaults - Default values for the section
// @returns {{ profileDir: string, sectionConfig: Object }}
function resolveProfile(profileArg, section, defaults = {}) {
    const profile = profileArg || process.env.KB_DEFAULT_PROFILE;
    if (!profile) {
        console.error("Error: profile is required");
        console.error("  Pass it as argument or set KB_DEFAULT_PROFILE environment variable");
        process.exit(1);
    }

    const basePath = process.env.KB_BASE_PATH;
    const profileDir = basePath ? path.join(basePath, profile) : profile;

    let sectionConfig = { ...defaults };
    const configPath = path.join(profileDir, "$config", "config.json");

    if (fs.existsSync(configPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            sectionConfig = { ...defaults, ...(config[section] || {}) };
        } catch (e) {
            // Ignore config loading errors
        }
    }

    return { profileDir, sectionConfig };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    // Constants
    TITLE_SEP_RE,
    HASH_ROUNDS,
    HASH_LENGTH,
    MIN_FILE_SIZE,
    MIN_TEXT_LENGTH,
    MIN_CHINESE_RATIO,

    // Async
    sleep,

    // Title
    normalizeTitle,
    titleKey,

    // Hash
    contentHash,

    // Validation
    validateMd,
    moveToError,
    cleanContent,
    validateSchema,
    validateWithSchema,

    // Data
    toStrArray,
    toNum,

    // File
    moveFile,
    writeJsonFile,

    // Profile
    getProfileDir,
    resolveProfile,
};
