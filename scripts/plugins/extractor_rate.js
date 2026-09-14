const { BaseExtractor } = require("../lib/extractor");

class RateExtractor extends BaseExtractor {
    constructor() {
        super({
            type: "rate",
            modelEnvVar: "KB_LLM_RATE_MODEL",
            contentSlice: 6000,
        });
    }

    toNum(value) {
        if (typeof value === "number") return value;
        if (typeof value === "string") {
            const n = parseFloat(value);
            if (!isNaN(n)) return n;
        }
        return null;
    }

    transform(parsed, options) {
        // Dynamic: pass through all rating fields from LLM output
        const ratings = {};
        for (const [key, value] of Object.entries(parsed)) {
            ratings[key] = this.toNum(value);
        }

        // Compute score as average of all numeric fields
        const values = Object.values(ratings).filter((v) => v !== null);
        const score = values.length > 0
            ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
            : null;

        // Single dimension: a nested ratings node adds nothing, score alone carries it.
        if (Object.keys(ratings).length === 1) return { score };

        return { ratings, score };
    }
}

module.exports = new RateExtractor();
