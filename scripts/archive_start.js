const fs = require("fs");
const path = require("path");
const { moveFile, getProfileDir } = require("./lib/common");

// ─── Constants ───────────────────────────────────────────────────────────────

const MS_PER_DAY = 86400 * 1000;

// ─── Argument Parsing ────────────────────────────────────────────────────────

const [, , sourceDirArg, targetDirArg, daysStr] = process.argv;
const profileDir = getProfileDir();

// Try to load config from profile if not provided
let sourceDir = sourceDirArg;
let targetDir = targetDirArg;
let days = daysStr ? parseInt(daysStr, 10) : 90;

if ((!sourceDir || !targetDir || !daysStr) && profileDir) {
    const configPath = `${profileDir}/.config/config.json`;
    if (fs.existsSync(configPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            const archiveConfig = config.archive || {};
            if (!sourceDir) sourceDir = `${profileDir}/${archiveConfig.source_folder || "weknora"}`;
            if (!targetDir) targetDir = `${profileDir}/${archiveConfig.target_folder || "archived"}`;
            if (!daysStr && archiveConfig.days) days = archiveConfig.days;
        } catch (e) {
            // Ignore config loading errors
        }
    }
}

// Fallback to defaults
if (!sourceDir) sourceDir = `${profileDir}/weknora`;
if (!targetDir) targetDir = `${profileDir}/archived`;

if (!sourceDir || !targetDir) {
    console.error("Usage: node archive_start.js <source_folder> <target_folder> [days]");
    console.error("  source_folder: directory of files to archive");
    console.error("  target_folder: destination for archived files");
    console.error("  days:          file age threshold in days (default 90), based on file mtime");
    console.error("  Or set KB_DEFAULT_PROFILE environment variable to use default directories");
    process.exit(1);
}

const DAYS = daysStr ? parseInt(daysStr, 10) : 90;
if (isNaN(DAYS) || DAYS < 0) {
    console.error(`Error: invalid days "${daysStr}"`);
    process.exit(1);
}

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

console.log(`\nDone. ${archived} archived, ${kept} kept (threshold ${DAYS} days)`);
