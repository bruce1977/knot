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
const MIN_FILE_SIZE = 1024;        // 1KB
const MIN_TEXT_LENGTH = 200;       // minimum 200 characters of plain text
const MIN_CHINESE_RATIO = 0.1;    // Chinese character ratio >= 10%

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

// Simple JSON Schema validator supporting subset of draft-07.
// Supports: type, required, properties, additionalProperties,
//           minLength, minItems, maxItems, minimum, maximum, items
function validateSchema(data, schema) {
    const errors = [];

    function validate(obj, schemaNode, currentPath) {
        // Type check
        if (schemaNode.type) {
            const actualType = Array.isArray(obj) ? "array" : typeof obj;
            if (actualType !== schemaNode.type) {
                errors.push(`${currentPath}: expected type ${schemaNode.type}, got ${actualType}`);
                return;
            }
        }

        // Required properties
        if (schemaNode.required && typeof obj === "object" && !Array.isArray(obj)) {
            for (const key of schemaNode.required) {
                if (obj[key] === undefined || obj[key] === null) {
                    errors.push(`${currentPath}.${key}: required property is missing`);
                }
            }
        }

        // Property validation
        if (schemaNode.properties && typeof obj === "object" && !Array.isArray(obj)) {
            for (const [key, propSchema] of Object.entries(schemaNode.properties)) {
                if (obj[key] !== undefined && obj[key] !== null) {
                    validate(obj[key], propSchema, `${currentPath}.${key}`);
                }
            }
        }

        // String validations
        if (typeof obj === "string") {
            if (schemaNode.minLength !== undefined && obj.length < schemaNode.minLength) {
                errors.push(`${currentPath}: string length ${obj.length} < minLength ${schemaNode.minLength}`);
            }
        }

        // Array validations
        if (Array.isArray(obj)) {
            if (schemaNode.minItems !== undefined && obj.length < schemaNode.minItems) {
                errors.push(`${currentPath}: array length ${obj.length} < minItems ${schemaNode.minItems}`);
            }
            if (schemaNode.maxItems !== undefined && obj.length > schemaNode.maxItems) {
                errors.push(`${currentPath}: array length ${obj.length} > maxItems ${schemaNode.maxItems}`);
            }
            if (schemaNode.items) {
                obj.forEach((item, index) => validate(item, schemaNode.items, `${currentPath}[${index}]`));
            }
        }

        // Number validations
        if (typeof obj === "number") {
            if (schemaNode.minimum !== undefined && obj < schemaNode.minimum) {
                errors.push(`${currentPath}: value ${obj} < minimum ${schemaNode.minimum}`);
            }
            if (schemaNode.maximum !== undefined && obj > schemaNode.maximum) {
                errors.push(`${currentPath}: value ${obj} > maximum ${schemaNode.maximum}`);
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
};
