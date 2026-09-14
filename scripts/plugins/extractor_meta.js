const { BaseExtractor } = require("../lib/extractor");

class MetaExtractor extends BaseExtractor {
    constructor() {
        super({
            type: "meta",
            modelEnvVar: "KB_LLM_META_MODEL",
            contentSlice: 8000,
        });
    }

    transform(parsed, options) {
        const { hash, filename } = options;

        // Pass through all fields from LLM output (dynamic based on schema)
        const result = { ...parsed };

        // Add extra fields
        result.model = this.getModel();
        result.hash = hash;
        result.source = filename;

        return result;
    }
}

module.exports = new MetaExtractor();
