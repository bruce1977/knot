const fs = require("fs");
const path = require("path");
const { sleep, moveFile, resolveProfile } = require("./lib/common");
const { splitFrontmatter } = require("./lib/frontmatter");
const { WeknoraClient } = require("./lib/weknora");

const SCRIPT_TIMEOUT_MS = parseInt(process.env.SYNC_SCRIPT_TIMEOUT_MS || "600000", 10);
const PER_ARTICLE_TIMEOUT_MS = 60000;

// ─── Argument Parsing ────────────────────────────────────────────────────────

const [, , profileArg] = process.argv;
const { profileDir, sectionConfig: weknoraConfig } = resolveProfile(profileArg, "weknora", {
    source_folder: "marked",
    target_folder: "weknora",
    kb_id: "",
    wiki_kb_id: "",
    score_threshold: 0,
    concurrency: 1,
    submit_interval_ms: 15000,
    submit_wiki_interval_ms: 15000,
    batch_size: 0,
    dedup_enabled: false,
    custom_metas: {},
    max_consecutive_failures: 3,
    abort_grace_ms: 30000,
    rollback_on_publish_failure: true,
    submit_timeout_seconds: 0,
});

const sourceDir = path.join(profileDir, weknoraConfig.source_folder);
const targetDir = path.join(profileDir, weknoraConfig.target_folder);

// Load full config for custom_metas and other settings
const configPath = path.join(profileDir, ".config", "config.json");
let config;
try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
} catch (e) {
    console.error("FATAL: failed to load config " + configPath + ": " + e.message);
    process.exit(1);
}

const syncCfg = { ...config, ...weknoraConfig };
const kbId = syncCfg.kb_id || "";
const wikiKbId = syncCfg.wiki_kb_id || null;
const scoreThreshold = parseFloat(syncCfg.score_threshold || "0");
const concurrency = Math.max(1, parseInt(syncCfg.concurrency || "1", 10));
const normalSubmitIntervalMs = parseInt(syncCfg.submit_interval_ms || "15000", 10);
const wikiSubmitIntervalMs = parseInt(syncCfg.submit_wiki_interval_ms || "15000", 10);
const batch_size = parseInt(syncCfg.batch_size || "0", 10);
const dedupEnabled = !!syncCfg.dedup_enabled;
const customMetasCfg = syncCfg.custom_metas || {};

// Abort the run when this many articles fail in a row - usually a backend outage.
const maxConsecutiveFailures = Math.max(1, parseInt(syncCfg.max_consecutive_failures || "3", 10));
// How long in-flight requests may linger after the abort before the process is killed.
const abortGraceMs = parseInt(syncCfg.abort_grace_ms || "30000", 10);
// A publish failure leaves an unpublished draft behind, which dedup would later
// mistake for an already-processed article. Roll back unless asked otherwise.
const rollbackOnPublishFailure = syncCfg.rollback_on_publish_failure !== false;

if (!kbId) { console.error("FATAL: kb_id is required in config"); process.exit(1); }

const apiBase = process.env.WEKNORA_BASE_URL;
const apiKey = process.env.WEKNORA_API_KEY;
if (!apiBase) { console.error("FATAL: env WEKNORA_BASE_URL is not set"); process.exit(1); }
if (!apiKey) { console.error("FATAL: env WEKNORA_API_KEY is not set"); process.exit(1); }

const requestTimeoutMs = parseInt(syncCfg.submit_timeout_seconds || "0", 10) * 1000 || undefined;
const wk = new WeknoraClient(apiBase, apiKey, { timeoutMs: requestTimeoutMs });

function parseFrontmatter(content) {
    const { fields, body } = splitFrontmatter(content.trimStart());
    return { fields, body: body.trimStart() };
}

function buildCustomMetas(fields) {
    const metas = {};
    for (const [key, tpl] of Object.entries(customMetasCfg)) {
        const single = String(tpl).match(/^\$([\w.-]+)$/);
        let value;
        if (single) {
            const raw = fields[single[1]];
            value = (raw === undefined || raw === null || raw === "") ? null : (Array.isArray(raw) ? raw.join(", ") : String(raw));
        } else {
            const resolved = String(tpl).replace(/\$([\w.-]+)/g, (_, name) => {
                const raw = fields[name];
                if (raw === undefined || raw === null || raw === "") return "";
                return Array.isArray(raw) ? raw.join(", ") : String(raw);
            });
            value = resolved.trim() === "" ? null : resolved;
        }
        if (value !== null) metas[key] = value;
    }
    return metas;
}

function pickTargetKB(score) {
    if (wikiKbId && scoreThreshold < 10) {
        if (scoreThreshold === 0 || score >= scoreThreshold) {
            return { kbId: wikiKbId, label: "wiki" };
        }
    }
    return { kbId: kbId, label: "normal" };
}

const fmtMs = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

function selectTarget(fields) {
    const score = typeof fields.score === "number" ? fields.score : parseFloat(fields.score) || 0;
    return { score, target: pickTargetKB(score) };
}

const dedupDir = path.join(path.dirname(sourceDir), "dupl");

// An entry only counts as real content once its custom_metadata survived -
// the metas are written before publishing, so a missing block means the previous
// run died somewhere mid-pipeline and left a husk behind.
function hasStoredHash(record) {
    const metas = record?.custom_metadata;
    if (!metas || typeof metas !== "object") return false;
    const value = metas.hash;
    return typeof value === "string" && value.length > 0;
}

async function checkDuplicate(title, hash, targetKbId) {
    // Collect every existing entry that could collide with this article. The two
    // lookups can return the same row, so results are keyed by id.
    const existing = new Map();
    if (hash) {
        const hashedMatch = await wk.searchKnowledge(targetKbId, `${title}_${hash}`);
        if (hashedMatch?.id) existing.set(hashedMatch.id, hashedMatch);
    }
    const titleMatch = await wk.searchKnowledge(targetKbId, title);
    if (titleMatch?.id) existing.set(titleMatch.id, titleMatch);

    const survivors = [];
    for (const item of existing.values()) {
        if (hasStoredHash(item)) {
            survivors.push(item);
            continue;
        }
        // Leftover from an abandoned upload: no usable metadata, so it never
        // finished processing. Remove it and carry on as if it were absent.
        const removed = await wk.deleteKnowledge(item.id).then(() => true).catch(() => false);
        console.log(`  clean: ${removed ? "removed" : "FAILED to remove"} husk ${item.title} (${item.id})`);
        if (!removed) survivors.push(item);
    }

    const sameHash = survivors.find(item => item.custom_metadata?.hash === hash);
    if (sameHash) return { status: "dup", reason: "same title+hash" };

    const sameTitle = survivors.find(item => item.title === title);
    if (sameTitle) return { status: "ok", submitTitle: `${title}_${hash}` };

    return { status: "ok", submitTitle: title };
}

// Abort state shared by all workers: once the failure threshold is hit, no new
// article is picked up and the run stops for manual investigation.
let consecutiveFailures = 0;
let aborted = false;
const abortedFiles = [];

function registerFailure(file) {
    consecutiveFailures++;
    console.log(`  consecutive failures: ${consecutiveFailures}/${maxConsecutiveFailures} (${file} left in place for retry)`);
    if (consecutiveFailures >= maxConsecutiveFailures && !aborted) {
        aborted = true;
        console.error(`FATAL: ${maxConsecutiveFailures} consecutive failures - backend is likely down, aborting run`);
        console.error(`Remaining articles stay in ${sourceDir} for manual processing`);
        // Backstop: if a worker is stuck on a hung request it never returns, so
        // kill the process once the grace period expires instead of piling more
        // traffic onto a dead backend. unref() keeps it from holding the loop open
        // in the normal case where every worker returns promptly.
        setTimeout(() => {
            console.error(`FATAL: graceful stop exceeded ${fmtMs(abortGraceMs)}, forcing exit`);
            process.exit(1);
        }, abortGraceMs).unref();
    }
}

function registerSuccess() {
    consecutiveFailures = 0;
}

/**
 * Write custom_metadata onto a still-unpublished draft. Nothing else is running
 * against the row yet, so the write cannot be clobbered and there is no summary
 * to regenerate (summary_status is empty at this point).
 */
async function writeCustomMetas(knowledgeId, customMetas) {
    await wk.updateKnowledge(knowledgeId, { custom_metadata: customMetas });
    const record = await wk.getKnowledge(knowledgeId);
    const stored = record?.custom_metadata || {};
    const missingKeys = Object.keys(customMetas).filter(key => String(stored[key]) !== String(customMetas[key]));
    if (missingKeys.length > 0) {
        throw new Error("custom_metadata not persisted: " + missingKeys.join(", "));
    }
}

async function processFile(file, idx, total) {
    const prefix = `[${idx + 1}/${total}]`;
    const srcPath = path.join(sourceDir, file);

    const content = fs.readFileSync(srcPath, "utf-8");
    const { fields, body } = parseFrontmatter(content);

    const title = typeof fields.title === "string" ? fields.title : "";
    const hash = typeof fields.hash === "string" ? fields.hash : "";
    const submitTitle = title || file.replace(/\.md$/i, "");

    const { score, target } = selectTarget(fields);
    const targetKbId = target.kbId;

    let finalTitle = submitTitle;

    // Dedup check
    if (dedupEnabled && submitTitle) {
        const dupResult = await checkDuplicate(submitTitle, hash, targetKbId);
        if (dupResult.status === "dup") {
            console.log(`${prefix} DUP ${file}: ${dupResult.reason}`);
            if (!fs.existsSync(dedupDir)) fs.mkdirSync(dedupDir, { recursive: true });
            moveFile(srcPath, path.join(dedupDir, file));
            return { status: "dup", file, score, label: target.label };
        }
        finalTitle = dupResult.submitTitle;
    }

    const tagNames = Array.isArray(fields.tags) ? fields.tags : [];
    const tagIds = await wk.batchGetOrCreateTags(tagNames, targetKbId);

    const customMetas = buildCustomMetas(fields);

    try {
        const uploadStart = Date.now();

        // Step 1: create as draft. The row is untouched by the pipeline, so no
        // asynchronous write can race with anything we do next. Tags are attached
        // here exactly as before - publishing never rewrites them.
        const knowledgeId = await wk.createKnowledge(targetKbId, finalTitle, body, "draft", tagIds);
        if (!knowledgeId) throw new Error("no knowledge id returned");

        // Step 2: write custom_metadata onto the quiet draft. Because nothing has
        // parsed the entry yet, there is no summary to regenerate and no LLM cost.
        let metasLabel = "metas=none";
        if (Object.keys(customMetas).length > 0) {
            await writeCustomMetas(knowledgeId, customMetas);
            metasLabel = "metas=ok";
        }

        // Step 3: publish. Only now does the pipeline start, and it sees the
        // metadata already in place, so the first summary is generated with it.
        try {
            await wk.publishKnowledge(knowledgeId, finalTitle, body);
        } catch (publishError) {
            // Drop the unfinished draft so a later run retries this article instead
            // of dedup treating the leftover draft as an already-processed one.
            if (rollbackOnPublishFailure) {
                await wk.deleteKnowledge(knowledgeId).catch(() => {});
            }
            throw new Error(`publish failed (rolled back=${rollbackOnPublishFailure}): ${publishError.message}`);
        }

        const uploadMs = Date.now() - uploadStart;

        moveFile(srcPath, path.join(targetDir, file));
        const intervalMs = target.label === "wiki" ? wikiSubmitIntervalMs : normalSubmitIntervalMs;
        await sleep(intervalMs);

        console.log(`${prefix} SYNCED ${file} score=${score} tags=${tagIds.length} upload=${fmtMs(uploadMs)} ${metasLabel}`);
        return { status: "synced", file, score, label: target.label, tags: tagIds.length, uploadMs };
    } catch (err) {
        console.log(`${prefix} FAIL ${file}: ${err.message}`);
        throw err;
    }
}

async function runConcurrent(items, concurrency, fn) {
    const results = [];
    let idx = 0;
    async function worker() {
        // Stop claiming new work once the run has been aborted.
        while (!aborted && idx < items.length) {
            const i = idx++;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    // Articles never started because of the abort are reported as leftovers.
    for (let i = 0; i < items.length; i++) {
        if (!results[i]) abortedFiles.push(items[i]);
    }
    return results;
}

function loadFiles() {
    if (!fs.existsSync(sourceDir)) {
        console.error("Error: source directory not found: " + sourceDir);
        process.exit(1);
    }
    const allFiles = fs.readdirSync(sourceDir).filter(f => f.endsWith(".md")).sort();
    if (allFiles.length === 0) {
        console.log("No .md files found, exiting.");
        process.exit(0);
    }
    const files = batch_size > 0 ? allFiles.slice(0, batch_size) : allFiles;
    if (batch_size > 0 && allFiles.length > batch_size) {
        console.log(`  batch_size=${batch_size}, total=${allFiles.length}, processing first ${batch_size}`);
    }
    return files;
}

function summarize(results) {
    let normalSynced = 0, normalFailed = 0, normalDup = 0;
    let wikiSynced = 0, wikiFailed = 0, wikiDup = 0;
    let totalNormalSyncMs = 0;
    let totalWikiSyncMs = 0;

    for (const r of results) {
        if (!r) continue;
        const isWiki = r.label === "wiki";
        if (r.status === "synced") {
            if (isWiki) { wikiSynced++; totalWikiSyncMs += r.uploadMs || 0; }
            else { normalSynced++; totalNormalSyncMs += r.uploadMs || 0; }
        } else if (r.status === "dup") {
            if (isWiki) wikiDup++;
            else normalDup++;
        } else {
            if (isWiki) wikiFailed++;
            else normalFailed++;
        }
    }

    const avgNormalSyncMs = normalSynced > 0 ? Math.round(totalNormalSyncMs / normalSynced) : 0;
    const avgWikiSyncMs = wikiSynced > 0 ? Math.round(totalWikiSyncMs / wikiSynced) : 0;

    return { normalSynced, normalDup, normalFailed, avgNormalSyncMs, wikiSynced, wikiDup, wikiFailed, avgWikiSyncMs };
}

async function main() {
    const startTime = Date.now();
    const files = loadFiles();

    const scriptTimeoutMs = Math.max(files.length * PER_ARTICLE_TIMEOUT_MS, SCRIPT_TIMEOUT_MS);
    const timeout = setTimeout(() => {
        console.error("FATAL: script timed out after " + fmtMs(scriptTimeoutMs) + " (" + files.length + " files x " + fmtMs(PER_ARTICLE_TIMEOUT_MS) + ")");
        process.exitCode = 1;
    }, scriptTimeoutMs);

    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    console.log(`[sync] ${files.length} files, workers=${concurrency}, interval=${fmtMs(normalSubmitIntervalMs)}, timeout=${fmtMs(scriptTimeoutMs)}`);

    try {
        const results = await runConcurrent(files, concurrency, (f, idx) =>
            processFile(f, idx, files.length)
                .then(result => { registerSuccess(); return result; })
                .catch(err => {
                    registerFailure(f);
                    return { status: "fail", file: f, error: err.message };
                })
        );

        const summary = summarize(results);
        console.log(`\nDone (${fmtMs(Date.now() - startTime)}).`);
        console.log(`  normal: ${summary.normalSynced} synced (avg ${fmtMs(summary.avgNormalSyncMs)}), ${summary.normalDup} dup, ${summary.normalFailed} failed`);
        console.log(`  wiki:   ${summary.wikiSynced} synced (avg ${fmtMs(summary.avgWikiSyncMs)}), ${summary.wikiDup} dup, ${summary.wikiFailed} failed`);
        const totalFailed = summary.normalFailed + summary.wikiFailed;
        if (totalFailed > 0) process.exitCode = 1;

        if (abortedFiles.length > 0) {
            console.log(`\nAborted: ${abortedFiles.length} article(s) were never started and stay in ${sourceDir}:`);
            console.log(`  ${abortedFiles.join(", ")}`);
        }

        if (aborted) {
            console.error("Stopped after consecutive failures - fix the backend and re-run");
            process.exit(1);
        }
    } finally {
        clearTimeout(timeout);
    }
}

main()
    .catch(err => {
        console.error("FATAL:", err.message);
        process.exitCode = 1;
    });
