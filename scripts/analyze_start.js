const fs = require("fs");
const path = require("path");
const { generateYamlHeader, sanitizeTitle } = require("./lib/frontmatter");
const { stripFrontmatter, cleanWechatContent, getLlmStats } = require("./lib/llm");
const { contentHash, getProfileDir, validateMd, moveToError } = require("./lib/common");

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Plugins used when config has no `plug-ins` entry.
const DEFAULT_EXTRACTOR_PLUGINS = ["extractor_original", "extractor_meta", "extractor_rate"];

const pad = (n, len) => String(n).padStart(len, " ");
const fmtMs = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

// ─── KnowledgeAnalyzer ───────────────────────────────────────────────────────

class KnowledgeAnalyzer {
    constructor() {
        this.analyzeConfig = {};
        this.sourceDir = null;
        this.targetDir = null;
        this.batchSize = 30;
        this.extractors = [];
    }

    // ─── Initialization ─────────────────────────────────────────────────

    async init() {
        const [, , sourceDirArg, targetDirArg, batchSizeArg] = process.argv;
        const profileDir = getProfileDir();

        this.sourceDir = sourceDirArg;
        this.targetDir = targetDirArg;
        this.batchSize = batchSizeArg ? Number(batchSizeArg) : null;

        // Load config from profile
        if (profileDir) {
            const configPath = path.join(profileDir, ".config", "config.json");
            if (fs.existsSync(configPath)) {
                try {
                    const profileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
                    this.analyzeConfig = profileConfig.analyze || {};
                    if (!this.sourceDir) this.sourceDir = path.join(profileDir, this.analyzeConfig.source_folder || "inbox");
                    if (!this.targetDir) this.targetDir = path.join(profileDir, this.analyzeConfig.target_folder || "marked");
                    if (!this.batchSize && this.analyzeConfig.batch_size) this.batchSize = this.analyzeConfig.batch_size;
                } catch (e) {
                    // Ignore config loading errors
                }
            }
            process.env.KB_PROFILE_DIR = profileDir;
        }

        // Apply defaults
        if (!this.sourceDir) this.sourceDir = profileDir ? path.join(profileDir, "inbox") : null;
        if (!this.targetDir) this.targetDir = profileDir ? path.join(profileDir, "marked") : null;
        if (!this.batchSize) this.batchSize = 30;

        // Validate
        if (!this.sourceDir || !this.targetDir) {
            console.error("Usage: node analyze_start.js <source_dir> <target_dir> [batch_size]");
            console.error("  Or set KB_DEFAULT_PROFILE environment variable to use default directories");
            process.exit(1);
        }

        // Load extractor plugins
        this.loadExtractorPlugins();
    }

    // Loads extractor plugins only; other plugin types get their own loader later.
    loadExtractorPlugins() {
        const pluginNames = this.analyzeConfig["plug-ins"] || DEFAULT_EXTRACTOR_PLUGINS;
        this.extractors = pluginNames.map((name) => {
            const pluginPath = path.join(__dirname, "plugins", name);
            try {
                const plugin = require(pluginPath);
                // Plugin name drives config lookup: .config/<name>_config.json wins
                // over the built-in plugins/<name>_config.json.
                plugin.pluginName = name;
                return plugin;
            } catch (e) {
                console.error(`Failed to load plugin: ${name}`, e.message);
                process.exit(1);
            }
        });
    }

    // ─── File Selection ─────────────────────────────────────────────────

    selectFiles() {
        const dir = path.resolve(this.sourceDir);
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

    // ─── File Processing ───────────────────────────────────────────────

    async processFile(filename) {
        const filePath = path.join(this.sourceDir, filename);

        // Read and clean content
        const rawContent = fs.readFileSync(filePath, "utf-8");
        const cleanBody = cleanWechatContent(stripFrontmatter(rawContent));
        const options = { hash: contentHash(cleanBody), filename, sourceDir: this.sourceDir, rawContent };

        // Run all extractors, merging outputs (later plugins override earlier ones)
        const merged = {};
        for (const extractor of this.extractors) {
            const data = await extractor.processFile(cleanBody, options);
            if (data && typeof data === "object") Object.assign(merged, data);
        }

        // Write output and delete source
        const metaHeader = generateYamlHeader(merged);
        const outputContent = `${metaHeader}\n\n${cleanBody}`;
        if (!fs.existsSync(this.targetDir)) {
            fs.mkdirSync(this.targetDir, { recursive: true });
        }

        const baseName = sanitizeTitle(merged.title || "untitled");
        const targetFile = this.resolveTargetFile(baseName, options.hash);
        fs.writeFileSync(targetFile, outputContent, "utf-8");
        fs.unlinkSync(filePath);

        // Each plugin clears its own temp files; plugins without any do nothing.
        this.extractors.forEach((extractor) => extractor.cleanup(options));
    }

    resolveTargetFile(baseName, hash) {
        let targetFile = path.join(this.targetDir, `${baseName}.md`);

        if (!fs.existsSync(targetFile)) {
            return targetFile;
        }

        // Check if existing file has same hash
        const existingContent = fs.readFileSync(targetFile, "utf-8");
        const hm = existingContent.match(/^hash:\s*(.+)$/m);
        const existingHash = hm ? hm[1].trim().replace(/^["']|["']$/g, "") : "";

        if (existingHash === hash) {
            return targetFile;
        }

        // Find next available sequence number
        let n = 1;
        do {
            targetFile = path.join(this.targetDir, `${baseName}(${n}).md`);
            n++;
        } while (fs.existsSync(targetFile));

        return targetFile;
    }

    // ─── Main Loop ─────────────────────────────────────────────────────

    async run() {
        await this.init();

        const allFiles = this.selectFiles();
        const batch = allFiles.slice(0, this.batchSize);
        const batchTimeoutMs = 300000 * this.batchSize;
        const indexWidth = String(batch.length).length;

        console.log(`\nKnowledge Analysis  ${batch.length}/${allFiles.length} files  timeout ${batchTimeoutMs / 1000}s`);

        const results = [];
        const batchStart = Date.now();

        for (let index = 0; index < batch.length; index++) {
            // Check timeout
            if (Date.now() - batchStart > batchTimeoutMs) {
                console.log("\nBatch timeout reached, stopping");
                break;
            }

            const filename = batch[index];
            const progress = `[${pad(index + 1, indexWidth)}/${batch.length}]`;
            const fileStart = Date.now();
            this.logFileStart(progress, filename);

            try {
                // Validate document format
                const filePath = path.join(this.sourceDir, filename);
                const validationErrors = validateMd(filePath);
                if (validationErrors.length > 0) {
                    moveToError(filePath, path.join(this.sourceDir, "error"));
                    this.logFileEnd("SKIP", fileStart, validationErrors.join("; "));
                    results.push({ status: "skipped", ms: Date.now() - fileStart });
                    continue;
                }

                await this.processFile(filename);
                this.logFileEnd("DONE", fileStart);
                results.push({ status: "done", ms: Date.now() - fileStart });

            } catch (err) {
                this.logFileEnd("FAIL", fileStart, err.message);
                results.push({ status: "failed", ms: Date.now() - fileStart });
            }
        }

        this.printSummary(results);
    }

    // One line per file, written in two steps: the progress + filename appear as
    // soon as the file starts, the result + elapsed time are appended when it ends.
    logFileStart(progress, filename) {
        process.stdout.write(`${progress} ${filename}`);
    }

    logFileEnd(status, startMs, detail) {
        const suffix = detail ? `  ${detail}` : "";
        console.log(`  ${status}  ${fmtMs(Date.now() - startMs)}${suffix}`);
    }

    // ─── Summary ───────────────────────────────────────────────────────

    printSummary(results) {
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
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

const analyzer = new KnowledgeAnalyzer();
analyzer.run().catch((err) => {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
});
