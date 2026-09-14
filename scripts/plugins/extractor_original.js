const { BaseExtractor } = require("../lib/extractor");
const { parseFrontmatter } = require("../lib/frontmatter");

class OriginalExtractor extends BaseExtractor {
    constructor() {
        super({
            type: "original",
            modelEnvVar: null,  // No LLM needed
            contentSlice: 0,
            usesCache: false,   // Parsed straight from raw content, no temp file needed
        });
    }

    // Override extract - no LLM needed, just parse frontmatter
    async extract(content, options) {
        const { rawContent } = options;
        if (!rawContent) return {};

        const match = rawContent.match(/^---\n([\s\S]*?)\n---/);
        if (!match) return {};

        return parseFrontmatter(match[0]) || {};
    }

    transform(parsed, options) {
        return parsed;
    }
}

module.exports = new OriginalExtractor();
