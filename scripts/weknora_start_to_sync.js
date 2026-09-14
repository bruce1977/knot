const fs = require("fs");
const path = require("path");
const { sleep, moveFile, getProfileDir } = require("./lib/common");

// ─── Constants ───────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30000;
const SCRIPT_TIMEOUT_MS = parseInt(process.env.SYNC_SCRIPT_TIMEOUT_MS || "600000", 10);
const PER_ARTICLE_TIMEOUT_MS = 60000;
const PARSE_POLL_INTERVAL_MS = parseInt(process.env.SYNC_POLL_INTERVAL_MS || "1000", 10);


// ─── CLI Args & Config ──────────────────────────────────────────────────────

const [, , sourceDirArg, targetDirArg, configPathParam] = process.argv;
const profileDir = getProfileDir();

// Try to load config from profile if not provided via args
let sourceDir = sourceDirArg;
let targetDir = targetDirArg;
let configPath = configPathParam;

if ((!sourceDir || !targetDir || !configPath) && profileDir) {
    const profileConfigPath = `${profileDir}/.config/config.json`;
    if (fs.existsSync(profileConfigPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(profileConfigPath, "utf-8"));
            const weknoraConfig = config.weknora || {};
            if (!sourceDir) sourceDir = `${profileDir}/${weknoraConfig.source_folder || "marked"}`;
            if (!targetDir) targetDir = `${profileDir}/${weknoraConfig.target_folder || "weknora"}`;
            if (!configPath) configPath = profileConfigPath;
        } catch (e) {
            // Ignore config loading errors
        }
    }
}

// Fallback to defaults
if (!sourceDir) sourceDir = profileDir ? `${profileDir}/marked` : null;
if (!targetDir) targetDir = profileDir ? `${profileDir}/weknora` : null;

if (!sourceDir || !targetDir) {
    console.error("Usage: node weknora_start_to_sync.js <source_dir> <target_dir> <config.json|kb_id>");
    console.error("  Or set KB_DEFAULT_PROFILE environment variable to use default directories");
    process.exit(1);
}

if (!configPath) {
    console.error("FATAL: config.json is required. Provide as argument or set KB_DEFAULT_PROFILE");
    process.exit(1);
}

let config;
try {
    if (!configPath.endsWith(".json") && !configPath.includes("/") && !configPath.includes("\\")) {
        const altPath = path.join(profileDir || "", ".config", "config.json");
        if (fs.existsSync(altPath)) configPath = altPath;
    }
    config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
} catch (e) {
    console.error("FATAL: failed to load config " + configPath + ": " + e.message);
    process.exit(1);
}

const syncCfg = { ...(config.weknora || {}), ...config };
const kbId = syncCfg.kb_id || "";
const wikiKbId = syncCfg.wiki_kb_id || null;
const scoreThreshold = parseFloat(syncCfg.score_threshold || "0");
const concurrency = Math.max(1, parseInt(syncCfg.concurrency || "1", 10));
const normalSubmitIntervalMs = parseInt(syncCfg.submit_interval_ms || "15000", 10);
const batch_size = parseInt(syncCfg.batch_size || "0", 10);
const submitTimeoutSec = parseInt(syncCfg.submit_timeout_seconds || "30", 10);
const submitWikiTimeoutSec = parseInt(syncCfg.submit_wiki_timeout_seconds || "120", 10);
const customMetasCfg = syncCfg.custom_metas || {};

if (!kbId) { console.error("FATAL: kb_id is required in config"); process.exit(1); }

const apiBase = process.env.WEKNORA_BASE_URL;
const apiKey = process.env.WEKNORA_API_KEY;
if (!apiBase) { console.error("FATAL: env WEKNORA_BASE_URL is not set"); process.exit(1); }
if (!apiKey) { console.error("FATAL: env WEKNORA_API_KEY is not set"); process.exit(1); }

// ─── API Helper ──────────────────────────────────────────────────────────────

async function wkRequest(method, url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method,
            headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.success === false) {
            throw new Error("HTTP " + res.status + ": " + (data.error?.message || data.message || res.statusText));
        }
        return data;
    } finally {
        clearTimeout(timer);
    }
}

// ─── Frontmatter Parsing ─────────────────────────────────────────────────────

function parseFrontmatter(content) {
    const t = content.trimStart();
    if (!t.startsWith("---")) return { fields: {}, body: t };
    const end = t.indexOf("---", 3);
    if (end === -1) return { fields: {}, body: t };
    const fm = t.slice(3, end).trim();
    const body = t.slice(end + 3).trimStart();
    const fields = {};
    let parentKey = null;
    for (const line of fm.split("\n")) {
        const nested = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/);
        if (nested && parentKey) {
            fields[parentKey + "." + nested[1]] = parseYamlValue(nested[2]);
            continue;
        }
        parentKey = null;
        const top = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        if (!top) continue;
        parentKey = top[1];
        fields[top[1]] = parseYamlValue(top[2]);
    }
    return { fields, body };
}

function parseYamlValue(raw) {
    const v = raw.trim();
    const arr = v.match(/^\[(.*)\]$/);
    if (arr) {
        return arr[1].split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
    }
    return v.replace(/^"|"$/g, "").trim();
}

// ─── Custom Metas ────────────────────────────────────────────────────────────

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

function buildKnowledgeUpdateBody(fields) {
    const metas = buildCustomMetas(fields);
    const customMetadata = { ...metas };
    if (typeof fields.hash === "string" && fields.hash) customMetadata.hash = fields.hash;
    if (!Object.keys(customMetadata).length) return {};
    return { custom_metadata: customMetadata };
}

// ─── Tags ────────────────────────────────────────────────────────────────────

const _tagCaches = {};
function parseTagList(res) {
    const d = arguments[0]?.data;
    if (Array.isArray(d)) return d;
    if (Array.isArray(d?.data)) return d.data;
    if (Array.isArray(d?.data?.list)) return d.data.list;
    if (Array.isArray(d?.data?.items)) return d.data.items;
    if (Array.isArray(d?.list)) return d.list;
    if (Array.isArray(d?.items)) return d.items;
    return [];
}
async function loadAllTags(targetKbId) {
    const all = [];
    let page = 1;
    while (true) {
        const listRes = await wkRequest("GET", apiBase + "/knowledge-bases/" + targetKbId + "/tags?page=" + page + "&page_size=200");
        const items = parseTagList(listRes);
        all.push(...items);
        if (items.length < 200) break;
        page++;
    }
    return all;
}
async function ensureTag(tagName, targetKbId) {
    if (!_tagCaches[targetKbId]) _tagCaches[targetKbId] = new Map();
    const cache = _tagCaches[targetKbId];
    if (cache.has(tagName)) return cache.get(tagName);
    // Try to create directly; WeKnora should be idempotent server-side.
    // Only fetch all tags on conflict (409) to find existing id.
    try {
        const created = await wkRequest("POST", apiBase + "/knowledge-bases/" + targetKbId + "/tags", { name: tagName });
        const id = created.data.id;
        cache.set(tagName, id);
        return id;
    } catch (err) {
        // Tag exists or concurrent conflict: fetch all tags to find existing id.
        // After this, cache will be used and no more fetches needed.
        const all = await loadAllTags(targetKbId);
        const map = new Map(all.map((t) => [t.name, t.id]));
        _tagCaches[targetKbId] = map;
        if (map.has(tagName)) {
            return map.get(tagName);
        }
        // Still not found: try creating once more (handle transient failure)
        try {
            const created = await wkRequest("POST", apiBase + "/knowledge-bases/" + targetKbId + "/tags", { name: tagName });
            const id = created.data.id;
            map.set(tagName, id);
            return id;
        } catch (err2) {
            console.error(`  TAG! ${tagName}: ${err2.message}`);
            return null;
        }
    }
}

async function batchSetTags(updates, targetKbId) {
    if (Object.keys(updates).length === 0) return;
    await wkRequest("PUT", apiBase + "/knowledge/tags", { kb_id: targetKbId, updates });
}

// ─── Parse Polling ───────────────────────────────────────────────────────────

async function waitForParse(knowledgeId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const res = await wkRequest("GET", apiBase + "/knowledge/" + knowledgeId);
        const status = res.data?.parse_status || "";
        if (status === "completed") return;
        if (status === "failed" || status === "cancelled") throw new Error("parse_status=" + status);
        await sleep(PARSE_POLL_INTERVAL_MS);
    }
    const res = await wkRequest("GET", apiBase + "/knowledge/" + knowledgeId).catch(() => ({}));
    throw new Error("parse timed out, last_status=" + (res.data?.parse_status || "unknown"));
}

// ─── Score ───────────────────────────────────────────────────────────────────

function pickTargetKB(score) {
    if (wikiKbId && scoreThreshold > 0 && score >= scoreThreshold) {
        return { kbId: wikiKbId, label: "wiki" };
    }
    return { kbId: kbId, label: "normal" };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const fmtMs = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

// ─── Single Article Pipeline ─────────────────────────────────────────────────

function selectTarget(fields) {
    const score = typeof fields.score === "number" ? fields.score : parseFloat(fields.score) || 0;
    return { score, target: pickTargetKB(score) };
}

async function assignKnowledgeTags(knowledgeId, targetKbId, fields) {
    const tags = Array.isArray(fields.tags) ? fields.tags : [];
    if (tags.length === 0) return 0;
    const tagIds = [];
    for (const t of tags) {
        const id = await ensureTag(t, targetKbId);
        if (id) tagIds.push(id);
    }
    if (tagIds.length === 0) return 0;
    try {
        await batchSetTags({ [knowledgeId]: tagIds }, targetKbId);
    } catch (err) {
        throw new Error("TAGS! " + knowledgeId + ": " + err.message);
    }
    return tagIds.length;
}

async function deleteKnowledge(knowledgeId) {
    await wkRequest("DELETE", apiBase + "/knowledge/" + knowledgeId);
}

async function processOne(file, idx, total) {
    const prefix = `[${idx + 1}/${total}]`;
    const srcPath = path.join(sourceDir, file);
    const content = fs.readFileSync(srcPath, "utf-8");
    const { fields, body } = parseFrontmatter(content);

    const title = typeof fields.title === "string" ? fields.title : "";
    const submitTitle = title || file.replace(/\.md$/i, "");

    const { score, target } = selectTarget(fields);
    const targetKbId = target.kbId;
    const intervalMs = normalSubmitIntervalMs;

    const hash = typeof fields.hash === "string" ? fields.hash : "";

    // Dedup: search by title
    if (submitTitle) {
        try {
            const searchRes = await wkRequest("GET", apiBase + "/knowledge-bases/" + targetKbId + "/knowledge?search=" + encodeURIComponent(submitTitle) + "&page_size=10");
            const items = searchRes.data || [];
            const match = items.find(item => item.title === submitTitle);
            if (match) {
                const existingHash = match.custom_metadata?.hash || "";
                if (existingHash === hash) {
                    // Hash matches → already uploaded, skip
                    console.log(`${prefix} DUP ${file}: hash=${hash}`);
                    moveFile(srcPath, path.join(targetDir, file));
                    return { status: "dup", file, score, label: target.label };
                }
                // No hash or hash mismatch → previous upload failed, delete and re-upload
                console.log(`${prefix} RETRY ${file}: deleting existing id=${match.id}`);
                await deleteKnowledge(match.id);
                await sleep(intervalMs);
            }
        } catch (err) {
            console.error(`${prefix} DEDUP! ${file}: ${err.message}`);
        }
    }

    try {
        const uploadStart = Date.now();

        // Upload to target KB
        const importRes = await wkRequest("POST", apiBase + "/knowledge-bases/" + targetKbId + "/knowledge/manual", {
            title: submitTitle, content: body, status: "publish",
        });
        const knowledgeId = importRes?.data?.id;
        if (!knowledgeId) throw new Error("no knowledge id returned");

        // Wait for vectorization to complete
        const parseTimeoutMs = target.label === "wiki" ? submitWikiTimeoutSec * 1000 : submitTimeoutSec * 1000;
        await waitForParse(knowledgeId, parseTimeoutMs);

        // PUT custom_metadata after vectorization
        const putBody = buildKnowledgeUpdateBody(fields);
        if (Object.keys(putBody).length) {
            try {
                await wkRequest("PUT", apiBase + "/knowledge/" + knowledgeId, putBody);
                // Verify metadata was written
                const verifyRes = await wkRequest("GET", apiBase + "/knowledge/" + knowledgeId);
                const savedMeta = verifyRes?.data?.custom_metadata || {};
                const expectedMeta = putBody.custom_metadata || {};
                const metaOk = Object.keys(expectedMeta).every(k => savedMeta[k] === expectedMeta[k]);
                if (!metaOk) {
                    console.error(`${prefix} META MISMATCH ${file}: expected=${JSON.stringify(expectedMeta)} saved=${JSON.stringify(savedMeta)}`);
                }
            } catch (err) {
                console.error(`${prefix} META! ${file}: ${err.message}`);
            }
        }

        const uploadMs = Date.now() - uploadStart;

        // Assign tags — throws on failure, preventing file move
        const tagCount = await assignKnowledgeTags(knowledgeId, targetKbId, fields);

        // Move local file
        moveFile(srcPath, path.join(targetDir, file));

        // Wait for WeKnora to generate summary before processing next article
        await sleep(intervalMs);

        console.log(`${prefix} SYNCED ${file} score=${score} tags=${tagCount} upload=${fmtMs(uploadMs)}`);
        return { status: "synced", file, score, label: target.label, tags: tagCount, uploadMs };
    } catch (err) {
        console.log(`${prefix} FAIL ${file}: ${err.message}`);
        throw err;
    }
}

// ─── Concurrency ─────────────────────────────────────────────────────────────

async function runConcurrent(items, concurrency, fn) {
    const results = [];
    let idx = 0;
    async function worker() {
        while (idx < items.length) {
            const i = idx++;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    return results;
}

// ─── Main ────────────────────────────────────────────────────────────────────

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
    let normalSynced = 0, normalSkipped = 0, normalFailed = 0;
    let wikiSynced = 0, wikiSkipped = 0, wikiFailed = 0;
    let totalNormalSyncMs = 0, totalNormalDupMs = 0;
    let totalWikiSyncMs = 0, totalWikiDupMs = 0;

    for (const r of results) {
        const isWiki = r.label === "wiki";
        if (r.status === "synced") {
            if (isWiki) {
                wikiSynced++;
                totalWikiSyncMs += r.uploadMs || 0;
            } else {
                normalSynced++;
                totalNormalSyncMs += r.uploadMs || 0;
            }
        } else if (r.status === "dup") {
            if (isWiki) {
                wikiSkipped++;
                totalWikiDupMs += r.uploadMs || 0;
            } else {
                normalSkipped++;
                totalNormalDupMs += r.uploadMs || 0;
            }
        } else {
            if (isWiki) wikiFailed++;
            else normalFailed++;
        }
    }

    const avgNormalSyncMs = normalSynced > 0 ? Math.round(totalNormalSyncMs / normalSynced) : 0;
    const avgNormalDupMs = normalSkipped > 0 ? Math.round(totalNormalDupMs / normalSkipped) : 0;
    const avgWikiSyncMs = wikiSynced > 0 ? Math.round(totalWikiSyncMs / wikiSynced) : 0;
    const avgWikiDupMs = wikiSkipped > 0 ? Math.round(totalWikiDupMs / wikiSkipped) : 0;

    return {
        normalSynced, normalSkipped, normalFailed, avgNormalSyncMs, avgNormalDupMs,
        wikiSynced, wikiSkipped, wikiFailed, avgWikiSyncMs, avgWikiDupMs,
    };
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
            processOne(f, idx, files.length)
                .catch(err => ({ status: "fail", file: f, error: err.message }))
        );

        const summary = summarize(results);
        console.log(`\nDone (${fmtMs(Date.now() - startTime)}).`);
        console.log(`  normal: ${summary.normalSynced} synced (avg ${fmtMs(summary.avgNormalSyncMs)}), ${summary.normalSkipped} skipped (avg ${fmtMs(summary.avgNormalDupMs)}), ${summary.normalFailed} failed`);
        console.log(`  wiki:   ${summary.wikiSynced} synced (avg ${fmtMs(summary.avgWikiSyncMs)}), ${summary.wikiSkipped} skipped (avg ${fmtMs(summary.avgWikiDupMs)}), ${summary.wikiFailed} failed`);
        const totalFailed = summary.normalFailed + summary.wikiFailed;
        if (totalFailed > 0) process.exitCode = 1;

    } finally {
        clearTimeout(timeout);
    }
}

// ─── Entry ───────────────────────────────────────────────────────────────────

main()
    .catch(err => {
        console.error("FATAL:", err.message);
        process.exitCode = 1;
    });
