const fs = require("fs");
const path = require("path");
const { sleep, moveFile, getProfileDir } = require("./lib/common");

// ─── Constants ───────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30000;
const SCRIPT_TIMEOUT_MS = parseInt(process.env.SYNC_SCRIPT_TIMEOUT_MS || "600000", 10);
const PER_ARTICLE_TIMEOUT_MS = 60000;
const PARSE_POLL_INTERVAL_MS = parseInt(process.env.SYNC_POLL_INTERVAL_MS || "1000", 10);
const PARSE_POLL_TIMEOUT_MS = parseInt(process.env.SYNC_POLL_TIMEOUT_MS || "60000", 10);

// ─── CLI Args & Config ──────────────────────────────────────────────────────

const [, , sourceDirArg, targetDirArg, configPathParam] = process.argv;
const profileDir = getProfileDir();
const sourceDir = sourceDirArg || (profileDir ? `${profileDir}/marked` : null);
const targetDir = targetDirArg || (profileDir ? `${profileDir}/weknora` : null);
let configPath = configPathParam;

if (!sourceDir || !targetDir) {
    console.error("Usage: node weknora_start_to_sync.js <source_dir> <target_dir> <config.json|kb_id>");
    console.error("  Or set KB_DEFAULT_PROFILE environment variable to use default directories");
    process.exit(1);
}

// Try to load config from default profile if not provided
if (!configPath && profileDir) {
    const profileConfigPath = `${profileDir}/.config/config.json`;
    if (fs.existsSync(profileConfigPath)) {
        configPath = profileConfigPath;
    }
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
const fallbackInterval = parseInt(syncCfg.submit_interval_ms || "100", 10);
const normalSubmitIntervalMs = parseInt(syncCfg.normal_submit_interval_ms || String(fallbackInterval), 10);
const wikiSubmitIntervalMs = parseInt(syncCfg.wiki_submit_interval_ms || String(fallbackInterval), 10);
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
    // 优先直接创建；weknora 本应在服务端幂等，这里仅在冲突(409)时补查
    try {
        const created = await wkRequest("POST", apiBase + "/knowledge-bases/" + targetKbId + "/tags", { name: tagName });
        const id = created.data.id;
        cache.set(tagName, id);
        return id;
    } catch (err) {
        // 已存在或并发冲突：全量拉取一次以定位已有 id（之后命中缓存不再拉取）
        const all = await loadAllTags(targetKbId);
        const map = new Map(all.map((t) => [t.name, t.id]));
        _tagCaches[targetKbId] = map;
        if (map.has(tagName)) {
            return map.get(tagName);
        }
        // 仍未找到：再尝试一次创建（应对瞬时失败）
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

async function waitForParse(knowledgeId) {
    const deadline = Date.now() + PARSE_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const res = await wkRequest("GET", apiBase + "/knowledge/" + knowledgeId);
        const status = res.data?.parse_status || "";
        if (status === "completed") return;
        if (status === "failed" || status === "cancelled") throw new Error("parse_status=" + status);
        await sleep(PARSE_POLL_INTERVAL_MS);
    }
    throw new Error("parse timed out");
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

async function processOne(file) {
    const srcPath = path.join(sourceDir, file);
    const content = fs.readFileSync(srcPath, "utf-8");
    const { fields, body } = parseFrontmatter(content);

    const title = typeof fields.title === "string" ? fields.title : "";
    const submitTitle = title || file.replace(/\.md$/i, "");

    const { score, target } = selectTarget(fields);
    const targetKbId = target.kbId;
    const intervalMs = target.label === "wiki" ? wikiSubmitIntervalMs : normalSubmitIntervalMs;

    try {
        // Upload to target KB
        const uploadStart = Date.now();
        const importRes = await wkRequest("POST", apiBase + "/knowledge-bases/" + targetKbId + "/knowledge/manual", {
            title: submitTitle, content: body, status: "publish",
        });
        const knowledgeId = importRes?.data?.id;
        if (!knowledgeId) throw new Error("no knowledge id returned");
        await waitForParse(knowledgeId);

        // PUT custom_metadata (do NOT put description, let WeKnora generate summary)
        const putBody = buildKnowledgeUpdateBody(fields);
        if (Object.keys(putBody).length) {
            await wkRequest("PUT", apiBase + "/knowledge/" + knowledgeId, putBody)
                .catch(err => console.error(`  META! ${file}: ${err.message}`));
        }

        const uploadMs = Date.now() - uploadStart;

        // Assign tags — throws on failure, preventing file move
        const tagCount = await assignKnowledgeTags(knowledgeId, targetKbId, fields);

        // Move local file
        moveFile(srcPath, path.join(targetDir, file));

        // Wait for WeKnora to generate summary before processing next article
        await sleep(intervalMs);

        console.log(`  SYNCED ${file} score=${score} tags=${tagCount} upload=${fmtMs(uploadMs)}`);
        return { status: "synced", file, score, label: target.label, tags: tagCount, uploadMs };
    } catch (err) {
        console.log(`  FAIL ${file}: ${err.message}`);
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
            results[i] = await fn(items[i]);
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
    const files = fs.readdirSync(sourceDir).filter(f => f.endsWith(".md")).sort();
    if (files.length === 0) {
        console.log("No .md files found, exiting.");
        process.exit(0);
    }
    return files;
}

function summarize(results) {
    let synced = 0, skipped = 0, failed = 0;
    for (const r of results) {
        if (r.status === "synced") synced++;
        else if (r.status === "dup") skipped++;
        else failed++;
    }
    return { synced, skipped, failed };
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

    console.log(`[sync] ${files.length} files, workers=${concurrency}, normal_interval=${fmtMs(normalSubmitIntervalMs)}, wiki_interval=${fmtMs(wikiSubmitIntervalMs)}, timeout=${fmtMs(scriptTimeoutMs)}`);

    try {
        const results = await runConcurrent(files, concurrency, (f) =>
            processOne(f)
                .catch(err => ({ status: "fail", file: f, error: err.message }))
        );

        const { synced, skipped, failed } = summarize(results);
        console.log(`\nDone. ${synced} synced, ${skipped} skipped, ${failed} failed (${fmtMs(Date.now() - startTime)})`);
        if (failed > 0) process.exitCode = 1;

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
