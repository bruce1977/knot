# Agents Configuration

## Available Agents

### Knowledge Base Agent

**Role**: Manages the knowledge base pipeline for document processing and synchronization.

**Capabilities**:
- Initialize knowledge base directory structure
- Analyze documents (metadata extraction + 5-dimension rating)
- Sync documents to WeKnora knowledge base
- Archive old documents

**Workflow**:

1. **Initialization** (`init`):
   - Creates directory structure: `inbox/`, `marked/`, `weknora/`, `archived/`
   - Generates default `$config/config.json`
   - Command: `node scripts/init_start.js <base_dir>`

2. **Analysis** (`analyze`):
   - Processes `.md` files from `inbox/` to `marked/`
   - Extracts metadata using LLM
   - Generates 5-dimension ratings (value, tech, public, academic, ethics)
   - Merges frontmatter with content
   - Command: `node scripts/analyze_start.js <source_dir> <target_dir> [batch_size]`

3. **Sync** (`sync`):
   - Uploads documents to WeKnora knowledge base
   - Supports normal and wiki KB routing by score
   - Handles tags assignment and metadata
   - Command: `node scripts/weknora_start_to_sync.js <source_dir> <target_dir> <config.json>`

   **Forge variant** (`sync:forge`):
   - Same pipeline via WeKnora Forge (HMAC `X-API-Key` + `X-Forge-Signature`)
   - One-shot `publish` payload (`sync` flag from config `publish_sync`)
   - Dedup: always (when frontmatter has `hash`); query remote KBs by `custom_metadata.hash` only, then exact `title` match
   - Command: `node scripts/weknora_forge_start_to_sync.js [profile]`

4. **Archive** (`archive`):
   - Moves old files based on age (mtime)
   - Configurable retention period
   - Command: `node scripts/archive_start.js <source_dir> <target_dir> [days]`

**Environment Variables**:
- Profile: `KB_BASE_PATH`, `KB_DEFAULT_PROFILE`
- Analysis: `KB_LLM_BASE_URL`, `KB_LLM_API_KEY`, `KB_LLM_MODEL`, `KB_LLM_PROVIDER`
- Sync: `WEKNORA_BASE_URL`, `WEKNORA_API_KEY`
- Forge sync: `WEKNORA_FORGE_BASE_URL`, `WEKNORA_API_KEY`, `WEKNORA_API_SECRET` (or profile `weknora.api_key` / `weknora.api_secret`)

**Configuration Files**:
- `$config/config.json`: Main configuration
- `scripts/plugins/<plugin>_config.json`: Prompt + schema for each plugin (default)
- `$config/<plugin>_config.json`: Optional per-profile override, picked up automatically

## Interaction Patterns

### Task Execution Flow

1. User specifies task type (init/analyze/sync/archive)
2. Agent validates required parameters and environment
3. Agent executes corresponding script
4. Agent reports results and any errors

### Error Handling

- **Validation Errors**: Stop execution, report to user
- **LLM Failures**: Retry up to 2 times with backoff
- **API Errors**: Log and continue with next article
- **File Errors**: Report specific file issues

### State Management

- **Caching**: Intermediate results cached by content hash
- **Idempotency**: Safe to re-run operations
- **Progress**: Files moved through pipeline stages

## Notes

- All scripts are pure Node.js (no external dependencies)
- LLM backend uses OpenAI-compatible API protocol
- Supports both Ollama and OpenAI-compatible providers
- Default model: qwen2.5:3b

## Global Rules

### Code Style

1. **English Comments Only**: All code comments must be written in English. No Chinese or other non-English comments are allowed.

2. **Descriptive Variable Names**: Use clear, descriptive variable names. Avoid single-letter abbreviations (e.g., `t`, `fm`, `s`, `r`) and cryptic shorthand. Examples:
   - Use `timeout` instead of `t`
   - Use `formattedMessage` instead of `fm`
   - Use `source` instead of `src` (unless it's a well-known convention)
   - Use `destination` instead of `dst`
   - Use `index` instead of `i` (except in simple loop counters)
   - Use `result` instead of `r`
   - Use `error` instead of `err` is acceptable
   - Use `filename` instead of `f`

3. **Consistent Naming**: Follow existing naming conventions in the codebase:
   - Use `camelCase` for variables and functions
   - Use `PascalCase` for classes (if any)
   - Use `UPPER_SNAKE_CASE` for constants
