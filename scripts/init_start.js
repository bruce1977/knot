const fs = require("fs");
const path = require("path");
const { resolveProfile } = require("./lib/common");

// ─── Constants ───────────────────────────────────────────────────────────────

const DIRS = ["inbox", "marked", "weknora", "archived"];
const CONFIG_DIR = "$config";

const DEFAULT_CONFIG = {
    analyze: {
        source_folder: "inbox",
        target_folder: "marked",
        batch_size: 30,
        "plug-ins": ["extractor_original", "extractor_meta", "extractor_rate"],
    },
    weknora: {
        source_folder: "marked",
        target_folder: "weknora",
        kb_id: "",
        wiki_kb_id: "",
        score_threshold: 3.5,
        concurrency: 1,
        normal_submit_interval_ms: 30000,
        wiki_submit_interval_ms: 600000,
        sync_enabled: true,
        publish_sync: false,
        custom_metas: {
            source: "$source",
            author: "$auther",
            aliases: "$aliases",
            score: "$score",
            channel: "wechat-mp",
        },
    },
    archive: {
        orginal_folder: "archived",
        target_folder: "marked",
        days: 90,
    },
};

// ─── Argument Parsing ────────────────────────────────────────────────────────

const [, , profileArg] = process.argv;
const { profileDir: baseDir } = resolveProfile(profileArg, "init", {});

// ─── Directory Creation ──────────────────────────────────────────────────────

let created = 0;

for (const d of DIRS) {
    const p = path.join(baseDir, d);
    if (!fs.existsSync(p)) {
        fs.mkdirSync(p, { recursive: true });
        console.log(`  CREATED ${d}/`);
        created++;
    }
}

// ─── Config Directory Creation ───────────────────────────────────────────────

const configDir = path.join(baseDir, CONFIG_DIR);
if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    console.log(`  CREATED ${CONFIG_DIR}/`);
    created++;
}

// ─── Config File Creation ────────────────────────────────────────────────────

const configPath = path.join(configDir, "config.json");
if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    console.log(`  CREATED ${CONFIG_DIR}/config.json (default)`);
    created++;
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\nDone. ${created} items created in ${baseDir}`);
