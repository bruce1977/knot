const fs = require("fs");
const path = require("path");
const extractMeta = require("./analyze_extract_meta");
const extractRate = require("./analyze_extract_rate");
const { generateYamlHeader, sanitizeTitle, loadJSON } = require("./analyze_frontmatter");
const { stripFrontmatter, cleanWechatContent, getLlmStats } = require("./lib/llm");
const { contentHash, writeJsonFile, getProfileDir, validateMd, moveToError } = require("./lib/common");

// ─── Config ──────────────────────────────────────────────────────────────────
const [, , sourceDirArg, targetDirArg, batchSizeArg] = process.argv;
const profileDir = getProfileDir();

// Try to load config from profile if not provided via args
let sourceDir = sourceDirArg;
let targetDir = targetDirArg;
let batchSize = batchSizeArg ? Number(batchSizeArg) : null;

if ((!sourceDir || !targetDir || !batchSize) && profileDir) {
    const configPath = `${profileDir}/.config/config.json`;
    if (fs.existsSync(configPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            const analyzeConfig = config.analyze || {};
            if (!sourceDir) sourceDir = `${profileDir}/${analyzeConfig.source_folder || "inbox"}`;
            if (!targetDir) targetDir = `${profileDir}/${analyzeConfig.target_folder || "marked"}`;
            if (!batchSize && analyzeConfig.batch_size) batchSize = analyzeConfig.batch_size;
        } catch (e) {
            // Ignore config loading errors
        }
    }
}

// Fallback to defaults
if (!sourceDir) sourceDir = profileDir ? `${profileDir}/inbox` : null;
if (!targetDir) targetDir = profileDir ? `${profileDir}/marked` : null;

if (!sourceDir || !targetDir) {
    console.error("Usage: node analyze_start.js <source_dir> <target_dir> [batch_size]");
    console.error("  Or set KB_DEFAULT_PROFILE environment variable to use default directories");
    process.exit(1);
}

process.env.KB_PROFILE_DIR = profileDir;

const BATCH_SIZE = batchSize || 30;
const BATCH_TIMEOUT_MS = 300000 * BATCH_SIZE;

// ─── Helpers ─────────────────────────────────────────────────────────────────
const pad = (n, len) => String(n).padStart(len, " ");
const fmtMs = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

function cleanupFiles(files) {
    for (const file of files) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
    }
}

// ─── File Selection ──────────────────────────────────────────────────────────
function selectFiles() {
    const dir = path.resolve(sourceDir);
    if (!fs.existsSync(dir)) {
        console.error(`Error: source directory not found: ${dir}`);
        process.exit(1);
    }

    const files = fs.readdirSync(dir).filter((name) => name.endsWith(".md"));
    if (files.length === 0) {
        console.log("No .md files in source directory");
        process.exit(0);
    }

    const dateOf = (name) => name.replace(/\.md$/, "").split("_")[2] || "";
    return files.sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
}

// ─── File Processing ─────────────────────────────────────────────────────────
async function processFile(filename) {
    const filePath = path.join(sourceDir, filename);
    const fileStart = Date.now();

    const track = async (phase, fn) => {
        const start = Date.now();
        try {
            return await fn();
        } finally {
            console.log(`... ${phase.padEnd(10)} ${fmtMs(Date.now() - start)}`);
        }
    };

    // PREP: read file, strip frontmatter and clean scraping residue
    const cleanBody = await track("PREP", () => {
        const raw = fs.readFileSync(filePath, "utf-8");
        return cleanWechatContent(stripFrontmatter(raw));
    });

    const hash = contentHash(cleanBody);
    const metaPath = path.join(sourceDir, `${hash}.meta.json`);
    const ratePath = path.join(sourceDir, `${hash}.rate.json`);

    try {
        // META: extract metadata
        if (!fs.existsSync(metaPath)) {
            await track("META", () => extractMeta.processFile(cleanBody, metaPath));
            const meta = loadJSON(metaPath);
            meta.source = filename;
            writeJsonFile(metaPath, meta);
        }

        // RATE: extract rating
        if (!fs.existsSync(ratePath)) {
            await track("RATE", () => extractRate.processFile(cleanBody, ratePath));
        }

        // ASSEMBLE: generate output file
        await track("ASSEMBLE", () => {
            const meta = loadJSON(metaPath);
            if (!meta) throw new Error(`failed to load ${metaPath}`);

            const rate = loadJSON(ratePath);
            if (!rate) throw new Error(`failed to load ${ratePath}`);

            const metaHeader = generateYamlHeader(meta, rate, hash);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            const baseName = sanitizeTitle(meta.title);
            let targetFile = path.join(targetDir, `${baseName}.md`);
            if (fs.existsSync(targetFile)) {
                const existingContent = fs.readFileSync(targetFile, "utf-8");
                const hm = existingContent.match(/^hash:\s*(.+)$/m);
                const existingHash = hm ? hm[1].trim().replace(/^["']|["']$/g, "") : "";
                if (existingHash !== hash) {
                    let n = 1, candidate;
                    do {
                        candidate = path.join(targetDir, `${baseName}(${n}).md`);
                        n++;
                    } while (fs.existsSync(candidate));
                    targetFile = candidate;
                }
            }
            fs.writeFileSync(targetFile, `${metaHeader}\n\n${cleanBody}`, "utf-8");
        });

        const ms = Date.now() - fileStart;
        console.log(`... Processed file: ${filename}, spent ${fmtMs(ms)}`);

        return { status: "done", ms };
    } finally {
        // Clean up intermediate files
        cleanupFiles([metaPath, ratePath]);
    }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

function printSummary(results) {
    const entries = Object.values(results);
    const done = entries.filter((r) => r.status === "done").length;
    const failed = entries.filter((r) => r.status === "failed").length;
    const skipped = entries.filter((r) => r.status === "skipped").length;
    const totalMs = entries.reduce((sum, r) => sum + (r.ms || 0), 0);
    const avg = entries.length ? (totalMs / entries.length / 1000).toFixed(1) : "0.0";
    const llm = getLlmStats();

    console.log([
        "",
        "=".repeat(60),
        `Done: ${done}  Failed: ${failed}  Skipped: ${skipped}  Total: ${fmtMs(totalMs)}  Avg: ${avg}s/file`,
        `LLM: ${llm.calls} calls, ${llm.retries} retries`,
        "=".repeat(60),
    ].join("\n"));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    // Get all eligible files from source directory
    const allFiles = selectFiles();
    const batch = allFiles.slice(0, BATCH_SIZE);

    console.log(`\nKnowledge Analysis  ${batch.length}/${allFiles.length} files  timeout ${BATCH_TIMEOUT_MS / 1000}s`);

    // Process each file
    const results = {};
    const batchStart = Date.now();
    for (const filename of batch) {
        // Check timeout
        const fileStart = Date.now();
        if (fileStart - batchStart > BATCH_TIMEOUT_MS) {
            console.log("\nBatch timeout reached, stopping");
            break;
        }

        console.log(`\n[${pad(Object.keys(results).length + 1, String(batch.length).length)}/${batch.length}] ${filename}`);

        try {
            // Validate document format before processing
            const filePath = path.join(sourceDir, filename);
            const validationErrors = validateMd(filePath);
            if (validationErrors.length > 0) {
                const errorDir = path.join(sourceDir, "error");
                const moved = moveToError(filePath, errorDir);
                console.log(`... SKIP ${filename}: ${validationErrors.join("; ")}`);
                console.log(`... Moved to ${path.relative(sourceDir, moved)}`);
                results[filename] = { status: "skipped", error: validationErrors.join("; "), ms: 0 };
                continue;
            }

            // Process file
            const result = await processFile(filename);

            // Delete source file on success
            if (result) {
                if (result.status === "done") {
                    fs.unlinkSync(path.join(sourceDir, filename));
                }
                result.ms = Date.now() - fileStart;
            }

            results[filename] = result;
        } catch (err) {
            console.error(`... Processing ${filename} failed, details: ${err.message}`);

            results[filename] = { status: "failed", error: err.message, ms: Date.now() - fileStart };
        }
    }

    // Print summary report
    printSummary(results);
}

main().catch((err) => {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
});
