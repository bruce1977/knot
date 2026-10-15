const fs = require("fs");
const path = require("path");
const { moveFile, resolveProfile } = require("./lib/common");

// ─── Constants ───────────────────────────────────────────────────────────────

const MS_PER_DAY = 86400 * 1000;

// ─── Argument Parsing ────────────────────────────────────────────────────────

const [, , profileArg] = process.argv;
const { profileDir, sectionConfig } = resolveProfile(profileArg, "archive", {
    source_folder: "weknora",
    target_folder: "archived",
    days: 90,
});

// Source lives in the pipeline tree, target in the archive tree - they may be
// on different volumes, so they are resolved against different base directories.
const archiveBasePath = process.env.KB_ARCHIVE_BASE_PATH;
if (!archiveBasePath) {
    console.error("Error: KB_ARCHIVE_BASE_PATH environment variable is required");
    process.exit(1);
}

const sourceDir = path.join(profileDir, sectionConfig.source_folder);
const targetDir = path.join(archiveBasePath, sectionConfig.target_folder);
const DAYS = Number(sectionConfig.days);

if (isNaN(DAYS) || DAYS < 0) {
    console.error(`Error: invalid days "${sectionConfig.days}"`);
    process.exit(1);
}

// days = 0 means "archive everything now": skip the mtime comparison entirely.
const skipMtimeCheck = DAYS === 0;
const cutoff = Date.now() - DAYS * MS_PER_DAY;

// ─── Directory Validation ────────────────────────────────────────────────────

if (!fs.existsSync(sourceDir)) {
    console.error(`Error: source directory not found: ${sourceDir}`);
    process.exit(1);
}

if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

// ─── Main Processing ─────────────────────────────────────────────────────────

const files = fs.readdirSync(sourceDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

if (files.length === 0) {
    console.log("No .md files found");
    process.exit(0);
}

let archived = 0;
let kept = 0;

for (const f of files) {
    const srcPath = path.join(sourceDir, f);

    if (skipMtimeCheck) {
        moveFile(srcPath, path.join(targetDir, f));
        console.log(`  ARCHIVED ${f}`);
        archived++;
        continue;
    }

    const stat = fs.statSync(srcPath);

    if (stat.mtimeMs < cutoff) {
        moveFile(srcPath, path.join(targetDir, f));
        console.log(`  ARCHIVED ${f} (mtime ${stat.mtime.toISOString().slice(0, 10)})`);
        archived++;
    } else {
        kept++;
    }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

const summary = skipMtimeCheck
    ? `Done. ${archived} archived, mtime check skipped (days = 0)`
    : `Done. ${archived} archived, ${kept} kept (threshold ${DAYS} days)`;

console.log(`\n${summary}`);
