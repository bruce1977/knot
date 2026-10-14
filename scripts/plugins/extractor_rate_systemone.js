const { BaseExtractor } = require("../lib/extractor");
const { sleep } = require("../lib/common");

// ─── System One (TypeSafe Jev) Rating Plugin ────────────────────────────────
// Replaces the chat-LLM rating flow with TypeSafe AI's System One decision
// model (Jev). Instead of asking a generative model to emit a JSON rating
// block, the article is sent to POST /v1/systemone as the "state" and scored
// by a single "score" question. Jev returns a position on the criteria scale,
// which this plugin maps onto a 1-based rating written to the "one-score" field.

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_ENDPOINT = "/v1/systemone";

const REQUEST_TIMEOUT_MS = Number(process.env.KB_SYSTEMONE_TIMEOUT_MS || 60000);
const MAX_ATTEMPTS = 3;

// Status codes that retrying cannot fix: bad key (401) or bad request (400/422).
const FATAL_STATUS_CODES = new Set([400, 401, 403, 422]);

class RateSystemOneExtractor extends BaseExtractor {
    constructor() {
        super({
            type: "rate_systemone",
            // The judge model is configured via KB_SYSTEMONE_* env vars and the
            // plugin config, not the chat-LLM model chain.
            modelEnvVar: null,
            contentSlice: 6000,
        });
    }

    // ─── Lazy Config Accessors ──────────────────────────────────────────

    getModel() {
        return process.env.KB_SYSTEMONE_MODEL || this.getConfig().model || "auto";
    }

    // The single scoring question: { id, type, instructions, criteria }.
    getQuestion() {
        return this.getConfig().question || {};
    }

    getApiUrl() {
        const baseUrl = (process.env.KB_SYSTEMONE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
        const endpoint = this.getConfig().endpoint || DEFAULT_ENDPOINT;
        return `${baseUrl}${endpoint}`;
    }

    // ─── System One Call ────────────────────────────────────────────────

    // One POST to /v1/systemone; returns the parsed response body.
    async callSystemOne(content, questionSpec, questionId, apiKey) {
        const body = {
            state: { message: content.slice(0, this.contentSlice) },
            questions: { [questionId]: questionSpec },
            model: this.getModel(),
        };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const res = await fetch(this.getApiUrl(), {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`,
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            const responseText = await res.text();
            if (!res.ok) {
                const error = new Error(`HTTP ${res.status}: ${responseText}`);
                error.fatal = FATAL_STATUS_CODES.has(res.status);
                throw error;
            }

            return JSON.parse(responseText);
        } finally {
            clearTimeout(timer);
        }
    }

    // Pull the numeric rating out of the answer object, e.g.
    // { one_score: { type: "score", score: 6.3, confidence: 0.9, ... } }.
    getAnswerRating(answers, questionId, criteriaCount) {
        const answer = answers && answers[questionId];
        if (!answer || typeof answer.score !== "number") {
            throw new Error(`Missing numeric score for question "${questionId}"`);
        }

        // Jev returns a 0-based position on the criteria scale; +1 turns it
        // into a 1-based rating (1..criteriaCount), matching the LLM rate
        // plugin's 1-10 convention.
        const rating = answer.score + 1;
        const capped = Math.min(rating, criteriaCount);
        return Math.round(capped * 10) / 10;
    }

    // ─── Extract (overrides the chat-LLM retry flow) ────────────────────
    // One HTTP round-trip per attempt; no prompt building or JSON extraction.

    async extract(content, options) {
        const apiKey = process.env.KB_SYSTEMONE_API_KEY;
        if (!apiKey) throw new Error("KB_SYSTEMONE_API_KEY is not set");

        const { id: questionId, ...questionSpec } = this.getQuestion();
        if (!questionId) throw new Error("Config question.id is missing");

        let lastError = null;
        let attemptsUsed = 0;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            attemptsUsed = attempt;
            try {
                const data = await this.callSystemOne(content, questionSpec, questionId, apiKey);
                const criteriaCount = questionSpec.criteria ? questionSpec.criteria.length : 10;
                const rating = this.getAnswerRating(data.answers, questionId, criteriaCount);
                return this.transform({ rating });
            } catch (error) {
                lastError = error;
                if (error.fatal || attempt >= MAX_ATTEMPTS) break;
                await sleep(1000 * attempt);
            }
        }

        throw new Error(`System One rating failed after ${attemptsUsed} attempts: ${lastError && lastError.message}`);
    }

    // Single dimension: only the judge's overall rating lands in frontmatter.
    transform(parsed) {
        return { "one-score": parsed.rating };
    }
}

module.exports = new RateSystemOneExtractor();
