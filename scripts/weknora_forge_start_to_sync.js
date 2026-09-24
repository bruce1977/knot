const fs = require("fs");
const path = require("path");
const { sleep, moveFile, resolveProfile } = require("./lib/common");
const { splitFrontmatter } = require("./lib/frontmatter");
const { WeknoraForgeClient } = require("./lib/weknora_forge");

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
    custom_metas: {},
    max_consecutive_failures: 3,
    abort_grace_ms: 30000,
    submit_timeout_seconds: 0,
    api_key: "",
    api_secret: "",
    publish_sync: false,
});

const sourceDir = path.join(profileDir, weknoraConfig.source_folder);
const targetDir = path.join(profileDir, weknoraConfig.target_folder);

const syncCfg = weknoraConfig;
const kbId = syncCfg.kb_id || "";
const wikiKbId = syncCfg.wiki_kb_id || null;
const scoreThreshold = parseFloat(syncCfg.score_threshold || "0");
const concurrency = Math.max(1, parseInt(syncCfg.concurrency || "1", 10));
const normalSubmitIntervalMs = parseInt(syncCfg.submit_interval_ms || "15000", 10);
const wikiSubmitIntervalMs = parseInt(syncCfg.submit_wiki_interval_ms || "15000", 10);
const batch_size = parseInt(syncCfg.batch_size || "0", 10);
const customMetasCfg = syncCfg.custom_metas || {};
// Publish API "sync" flag: when true the backend indexes/syncs immediately
// after publish instead of leaving it to the async pipeline.
const publishSync = syncCfg.publish_sync === true || syncCfg.publish_sync === "true";

// Abort the run when this many articles fail in a row - usually a backend outage.
const maxConsecutiveFailures = Math.max(1, parseInt(syncCfg.max_consecutive_failures || "3", 10));
// How long in-flight requests may linger after the abort before the process is killed.
const abortGraceMs = parseInt(syncCfg.abort_grace_ms || "30000", 10);

if (!kbId) { console.error("FATAL: kb_id is required in config"); process.exit(1); }

const forgeBaseUrl = process.env.WEKNORA_FORGE_BASE_URL;
if (!forgeBaseUrl) { console.error("FATAL: env WEKNORA_FORGE_BASE_URL is not set"); process.exit(1); }

// Credential resolution: profile config wins over environment variables.
const apiKey = (syncCfg.api_key || "").trim() || (process.env.WEKNORA_API_KEY || "").trim();
const apiSecret = (syncCfg.api_secret || "").trim() || (process.env.WEKNORA_API_SECRET || "").trim();
if (!apiKey) {
    console.error("FATAL: api_key is not set (config weknora.api_key or env WEKNORA_API_KEY)");
    process.exit(1);
}
if (!apiSecret) {
    console.error("FATAL: api_secret is not set (config weknora.api_secret or env WEKNORA_API_SECRET)");
    process.exit(1);
}

const requestTimeoutMs = parseInt(syncCfg.submit_timeout_seconds || "0", 10) * 1000 || undefined;
const forge = new WeknoraForgeClient(forgeBaseUrl, apiKey, apiSecret, { timeoutMs: requestTimeoutMs });

// Dedup searches the normal KB and the wiki KB in one request: missing ids are
// skipped and an identical wiki id collapses into the normal one.
const dedupKbIds = [...new Set([kbId, wikiKbId].filter(Boolean))];

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

// Prefer an explicit description field, then fall back to the extracted summary.
function pickDescription(fields) {
    if (typeof fields.description === "string" && fields.description.trim()) return fields.description;
    if (typeof fields.summary === "string" && fields.summary.trim()) return fields.summary;
    return "";
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

const dedupDir = path.join(sourceDir, "dupl");

// Duplicate check via POST /api/v2/knowledge/search on custom_metadata.hash.
// The query only filters by hash; title is compared against each returned hit
// afterwards so a renamed article on either side is not mistaken for a new one.
async function checkDuplicate(title, hash) {
    if (!hash) return { status: "ok", reason: "no local hash" };
    const items = await forge.searchKnowledgeByHash(dedupKbIds, hash);
    for (const item of items) {
        if (item && item.title === title) {
            return { status: "dup", reason: "same title+hash" };
        }
    }
    return { status: "ok", reason: items.length > 0 ? "hash found, title differs" : "hash not found" };
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

    // Dedup: query by hash only, then match title against each hit.
    if (hash) {
        const dupResult = await checkDuplicate(submitTitle, hash);
        if (dupResult.status === "dup") {
            console.log(`${prefix} DUP ${file}: ${dupResult.reason}`);
            if (!fs.existsSync(dedupDir)) fs.mkdirSync(dedupDir, { recursive: true });
            moveFile(srcPath, path.join(dedupDir, file));
            return { status: "dup", file, score, label: target.label };
        }
    }

    const tagNames = Array.isArray(fields.tags) ? fields.tags : [];
    const customMetas = buildCustomMetas(fields);
    // Dedup searches custom_metadata.hash, so keep the content hash on every
    // published record even when custom_metas does not map it explicitly.
    if (hash && customMetas.hash === undefined) customMetas.hash = hash;
    const description = pickDescription(fields);
    const metasLabel = Object.keys(customMetas).length > 0 ? "metas=ok" : "metas=none";

    try {
        const uploadStart = Date.now();

        // One Forge call replaces the old draft -> write metas -> publish dance:
        // tags are resolved, the draft is created with custom metas and
        // description, then flipped to publish. Failures roll back server-side.
        const publishPayload = {
            kb_id: targetKbId,
            title: submitTitle,
            content: body,
            tag_names: tagNames,
            custom_metas: customMetas,
            sync: publishSync,
        };
        if (description) publishPayload.description = description;

        const publishResult = await forge.publish(publishPayload);
        if (!publishResult || !publishResult.knowledge_id) {
            throw new Error("no knowledge id returned");
        }

        const uploadMs = Date.now() - uploadStart;
        const tagCount = Array.isArray(publishResult.tag_ids)
            ? publishResult.tag_ids.length
            : tagNames.length;

        moveFile(srcPath, path.join(targetDir, file));
        const intervalMs = target.label === "wiki" ? wikiSubmitIntervalMs : normalSubmitIntervalMs;
        await sleep(intervalMs);

        console.log(`${prefix} SYNCED ${file} score=${score} tags=${tagCount} upload=${fmtMs(uploadMs)} ${metasLabel}`);
        return { status: "synced", file, score, label: target.label, tags: tagCount, uploadMs };
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

    console.log(`[sync:forge] ${files.length} files, workers=${concurrency}, interval=${fmtMs(normalSubmitIntervalMs)}, timeout=${fmtMs(scriptTimeoutMs)}`);

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
