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
   - Generates default `.config/config.json`
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

4. **Archive** (`archive`):
   - Moves old files based on age (mtime)
   - Configurable retention period
   - Command: `node scripts/archive_start.js <source_dir> <target_dir> [days]`

**Environment Variables**:
- Profile: `KB_BASE_PATH`, `KB_DEFAULT_PROFILE`
- Analysis: `KB_LLM_BASE_URL`, `KB_LLM_API_KEY`, `KB_LLM_MODEL`, `KB_LLM_PROVIDER`
- Sync: `WEKNORA_BASE_URL`, `WEKNORA_API_KEY`

**Configuration Files**:
- `.config/config.json`: Main configuration
- `.config/prompts/`: Custom prompt templates
- `.config/schema/`: Custom JSON schemas

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
