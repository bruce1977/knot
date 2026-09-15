---
name: knowledge
description: "知识库管线技能：初始化目录、文档分析（元数据提取+评分+合并）、同步导入 WeKnora、归档旧文件。通过不同命令选择功能。"
---

# 知识库管线 (knowledge)

知识库管线的核心技能，提供四大功能：

| 功能 | 脚本 | 说明 |
|------|------|------|
| **init** | `init_start.js` | 初始化目录结构和 `.config/config.json` |
| **analyze** | `analyze_start.js` | 元数据提取 + 五维评分 + 合并 frontmatter |
| **sync** | `weknora_start_to_sync.js` | 将终稿导入 WeKnora 远程知识库 |
| **archive** | `archive_start.js` | 按文件年龄归档旧文件 |

> 本技能为**纯脚本驱动**，不依赖 LLM Agent。调用方通过不同命令选择功能。

---

## 目录结构

```
${profile}/
├── .config/
│   ├── config.json              ← 主配置文件
│   ├── extractor_meta_config.json   ← 可选：覆盖 meta 插件配置
│   └── extractor_rate_config.json   ← 可选：覆盖 rate 插件配置
├── inbox/                       ← 原始文档
├── marked/                      ← 已分析文档
├── weknora/                     ← 已同步文档
└── archive/                     ← 归档文档
```

---

## 功能一：初始化 (init)

创建知识库 profile 根目录下的目录结构和默认 `.config/config.json`。幂等操作——已存在的目录/文件不会被覆盖。

### 调用方式

```bash
node skills/knowledge/scripts/init_start.js <base_dir>
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<base_dir>` | 是 | 知识库 profile 根目录（如 `D:/knowledge/obsidian/ai`） |

### 默认 config.json

```json
{
  "weknora": {
    "source_folder": "marked",
    "target_folder": "weknora",
    "kb_id": "",
    "wiki_kb_id": "",
    "score_threshold": 3.5,
    "concurrency": 1,
    "normal_submit_interval_ms": 30000,
    "wiki_submit_interval_ms": 600000,
    "sync_enabled": true,
    "custom_metas": {
      "source": "$source",
      "author": "$auther",
      "aliases": "$aliases",
      "score": "$score",
      "channel": "wechat-mp"
    }
  },
  "archive": { "days": 90 },
  "analyze": { "batch_size": 30 }
}
```

---

## 功能二：文档分析 (analyze)

对源目录内的 `.md` 文章批量执行 **元数据提取 + 五维评分 + 合并 frontmatter**，终稿移动到目标目录。

### 调用方式

```bash
node skills/knowledge/scripts/analyze_start.js <source_dir> <target_dir> [batch_size]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<source_dir>` | 是 | 源文章目录（如 `inbox/`） |
| `<target_dir>` | 是 | 终稿输出目录（如 `marked/`） |
| `[batch_size]` | 否 | 批处理文件数上限，默认 30 |

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `KB_LLM_BASE_URL` | 否 | `http://localhost:11434/v1` | LLM API 地址（OpenAI 兼容） |
| `KB_LLM_API_KEY` | 否 | 空 | LLM API 密钥（Ollama 可留空） |
| `KB_LLM_MODEL` | 否 | `qwen2.5:3b` | 默认模型（meta 和 rate 共用） |
| `KB_LLM_META_MODEL` | 否 | 继承 `KB_LLM_MODEL` | 元数据提取专用模型（覆盖默认） |
| `KB_LLM_RATE_MODEL` | 否 | 继承 `KB_LLM_MODEL` | 评分提取专用模型（覆盖默认） |
| `KB_LLM_TIMEOUT_MS` | 否 | `120000` | 单次 LLM 请求超时（毫秒） |

### 插件配置：提示词 + 数据结构

每个插件的提示词与数据结构合并在**一个**配置文件里，默认随插件放在 `scripts/plugins/`：

```
scripts/plugins/
├── extractor_meta.js              ← 插件实现
├── extractor_meta_config.json     ← prompt + schema
├── extractor_rate.js
└── extractor_rate_config.json
```

文件结构（`prompt` 与 `schema` 两段）：

```json
{
  "prompt": {
    "system": "You are a structured metadata extractor. Output only valid JSON, no extra text.",
    "user": "Extract metadata ... {{content}}",
    "retry": "Validation failed (attempt {{retry_tag}}). Fix errors and output complete JSON:\n{{errors}}"
  },
  "schema": {
    "title": ["string", 1],
    "tags": ["array", 2, 5]
  }
}
```

要覆盖默认配置，在 profile 的 `.config/` 下放一个**同名**文件即可，无需在 `config.json` 里声明：

```
${profile}/.config/extractor_meta_config.json    ← 存在则覆盖，否则用插件目录默认文件
```

文件名固定为 `<插件名>_config.json`。覆盖文件是**整体替换**，需包含完整的 `prompt` 与 `schema` 两段。

### 脚本架构

```
analyze_start.js                 ← Main entry: orchestrates full pipeline
├── lib/llm.js                   ← LLM client + utility functions
├── lib/frontmatter.js           ← YAML frontmatter generation
├── lib/extractor.js             ← BaseExtractor: prompt/schema/cache/cleanup
└── plugins/                     ← Extractor plugins, loaded by config `plug-ins`
    ├── extractor_original.js    ← Original frontmatter (no LLM, no cache)
    ├── extractor_meta.js        ← Metadata extraction
    ├── extractor_meta_config.json   ← its prompt + schema
    ├── extractor_rate.js        ← Rating extraction
    └── extractor_rate_config.json   ← its prompt + schema
```

每个插件自行负责自己的临时缓存（写、读、清理）；`usesCache: false` 的插件不产生临时文件，主流程不做任何缓存管理。

### 插件列表

插件列表在 `.config/config.json` 的 `analyze` 节下配置，按数组顺序执行（后者覆盖前者）：

```json
{
  "analyze": {
    "batch_size": 30,
    "plug-ins": ["extractor_original", "extractor_meta", "extractor_rate"]
  }
}
```

未配置时使用上表全部三个插件。插件只服务于 analyze 场景，配置一律放在 `analyze` 节下，不设全局键。

### 处理流程

```
source_dir/*.md
  │
  ▼  Step 1: Strip existing frontmatter + clean content
  │
  ▼  Step 2: Compute content hash (3 rounds sha256, 12 hex)
  │
  ├──→ Step 3: Run extractor plugins in config order, merge outputs
  │         ├──→ ${hash}.original.json（无缓存，直接解析）
  │         ├──→ ${hash}.meta.json
  │         └──→ ${hash}.rate.json
  │
  ▼  Step 4: Generate YAML header
  │
  ▼  Step 5: Create target file → target_dir/${title}.md（同名按 hash 覆盖或加序号）
  │
  ▼  Step 6: Each plugin clears its own temp cache
  │
  done
```

### 输出日志

每个文件只占一行，分两次写出：开处理时立刻打印 `[进度] 文件名`，处理结束后再补 `结果  耗时  原因（可选）`。这样长耗时期间也能看到当前进度，不会误以为卡住。合并后的一行格式为 `[进度] 文件名  结果  耗时  原因（可选）`：

```
[1/30] article.md  DONE  12.4s
[2/30] too-short.md  SKIP  3ms  text too short: 42 chars < 200
[3/30] broken.md  FAIL  8.1s  LLM failed after 3 retries: fetch failed
```

LLM 重试等细节不逐条打印，统一汇总到结尾的 `LLM: N calls, M retries`。

### 元数据标准

LLM 产出的 `.meta.json`（`model` 由脚本后续注入，不在 LLM 输出中）：

```json
{
  "title": "MoE架构：稀疏激活与大模型容量",
  "date": "2026-07-31T10:30:00+08:00",
  "auther": "科技兽",
  "tags": ["大模型", "开源", "MoE"],
  "summary": "MoE架构通过稀疏激活在同等算力下实现更大模型容量。",
  "keywords": "MoE, 稀疏激活",
  "aliases": ["Mixture of Experts", "混合专家"]
}
```

| 字段 | 类型 | 必填 | 提取规则 |
|------|------|------|---------|
| `title` | string | 是 | 从 frontmatter 提取，回退正文首部标题 |
| `date` | string | 是 | **打标时刻**（ISO 8601 含时区），非文章发布时间 |
| `auther` | string | 否 | 从正文检索作者/公众号名；无则 `""` |
| `source` | string | 否 | 原始文档的文件名 |
| `tags` | string[] | 是 | 2-5 个标签，精准概括主题 |
| `summary` | string | 是 | 1-2 句核心摘要（80-150字） |
| `keywords` | string | 是 | 2-5 个关键词，逗号分隔 |
| `aliases` | string[] | 是 | 标题核心实体的别名（缩写/简称/同义术语/英文译名） |

`model` 不在此表中：它由 `MetaExtractor.transform()` 用 `getModel()` 注入，不属于 LLM 输出契约，因此**不要写进 schema**（校验发生在 transform 之前，写进去会导致 3 次重试必然失败）。

### 评分标准

每篇产出 `.rate.json`：

```json
{
  "ratings": { "value": 4, "tech": 5, "public": 3, "academic": 2, "ethics": 5 },
  "score": 3.8,
  "model": "qwen2.5:3b"
}
```

`ratings` 是透传的——schema 里定义几个维度就输出几个。`score` 恒为各维度均值，因此**只有一个维度时不返回 `ratings` 节点**，只写 `score`（避免 `ratings.value` 与 `score` 重复表达同一个数）：

| 维度 | 含义 | 评分范围 |
|------|------|---------|
| `value` | 商业与市场价值 | 1-10 |
| `tech` | 技术创新与工程实现 | 1-10 |
| `public` | 公众传播与社会影响力 | 1-10 |
| `academic` | 学术研究价值 | 1-10 |
| `ethics` | 伦理合规与社会责任 | 1-10 |

`score` 由脚本自动计算（五维平均值，保留一位小数），不由大模型产出。

### frontmatter 类型约定

生成 YAML 时无法获知字段类型，因此 **metas 统一按字符串写入**（`score: "3.8"` 而非 `score: 3.8`）。消费方需要数值时自行转换，sync 侧已按此约定处理：`score` 用 `parseFloat`、`score_threshold` 用 `parseFloat` 后再比较。新增消费方时不要依赖隐式类型转换。

### 缓存与幂等

- `${hash}.meta.json` 已存在 → 跳过元数据提取
- `${hash}.rate.json` 已存在 → 跳过评分
- 两个缓存文件都存在 → 跳过提取，直接合并
- 终稿文件名 `${title}.md`：**不再包含 hash**；hash 仅写入 frontmatter 与 WeKnora 的 `custom_metadata.hash`
- 同名策略：已存在同名文件时，hash 相同则覆盖，不同则追加序号 `${title}(1).md`

---

## 功能三：同步导入 WeKnora (sync)

将 `{source}` 目录中带 frontmatter 的终稿**逐篇**直接导入 WeKnora 的目标知识库（普通库或 wiki 库），**不再经临时库周转**，以便 WeKnora 直接为目标库内的文章生成摘要（临时库 move 后向量不跟随，会导致目标库无法检索）。

### 调用方式

```bash
node scripts/kb-weknora.js <profile>
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<profile>` | 是 | 知识库 profile 名称（如 `ai`） |

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `PB_KNOWLEDGE_BASE_PATH` | 是 | — | 知识库根目录 |
| `WEKNORA_BASE_URL` | 是 | — | WeKnora API 基础地址 |
| `WEKNORA_API_KEY` | 是 | — | API 密钥 |

### config.json 结构

脚本读取 `.config/config.json` 中的 `weknora` 节，完整默认配置见「功能一」；关键字段如下：

| 字段 | 必填 | 说明 |
|------|------|------|
| `kb_id` | ✅ | 普通库知识库 ID |
| `wiki_kb_id` | ❌ | wiki 知识库 ID（配了才启用评分分流） |
| `score_threshold` | ❌ | 评分阈值（score ≥ 阈值 → wiki） |
| `concurrency` | ❌ | 并发路数（默认 1，串行处理） |
| `normal_submit_interval_ms` | ❌ | 普通库每篇上传后的等待间隔（默认 30000，供 WeKnora 生成摘要） |
| `wiki_submit_interval_ms` | ❌ | wiki 库每篇上传后的等待间隔（默认 600000） |
| `submit_interval_ms` | ❌ | 等待间隔回退值 |
| `batch_size` | ❌ | 本次最多处理篇数（0 = 全部） |
| `dedup_enabled` | ❌ | 是否启用 title + hash 去重 |
| `custom_metas` | ✅ | 上传到 WeKnora custom_metadata 的字段映射 |
| `max_consecutive_failures` | ❌ | 连续失败多少篇后中止流程（默认 3） |
| `abort_grace_ms` | ❌ | 中止后在途请求的宽限期，超时强杀进程（默认 30000） |
| `rollback_on_publish_failure` | ❌ | 发布失败是否回滚删除草稿（默认 true） |

> 为兼容旧配置，未配置 `normal_submit_interval_ms` / `wiki_submit_interval_ms` 时，两者均回退到 `submit_interval_ms`（若也未配则 100ms）。脚本**不再 PUT `description`**，摘要完全由 WeKnora 生成。

### 执行步骤

每篇文章（按 `concurrency` 并发，默认 1 即串行）：
1. 读文件、解析 frontmatter，按 `score` 选择目标库（`wiki_kb_id` 已配且 `score ≥ score_threshold` → wiki，否则普通库）
2. 去重检查（可选）+ 分配 tags
3. **建草稿**：`POST /knowledge-bases/{target}/knowledge/manual`，`status=draft`，同时提交 `tag_ids`
4. **写元数据**：`PUT /knowledge/{id}` 只写 `custom_metadata`（含 `hash`），写完回读校验
5. **发布**：`PUT /knowledge/manual/{id}`，`status=publish` —— 到这一步才开始解析流水线
6. 三步全部成功后才移动本地文件到 `weknora/`，否则留在源目录等下次重试
7. 等待 `normal_submit_interval_ms` / `wiki_submit_interval_ms`，供 WeKnora 生成摘要

> 关键点：WeKnora 的创建接口（`ManualKnowledgePayload`）**结构上没有 `custom_metadata` 字段**，且 `publish` 入库会立即启动「按快照整行回写」的解析流水线，把随后 PUT 的 metas 冲掉。所以改为先建草稿——草稿不进流水线，写入零竞态、`summary_status` 为空不触发摘要重算（无额外 LLM 开销）；发布时 metas 已在库里，第一次摘要就带上了它们。tags 存在 `knowledge_tags` 关联表，发布接口与流水线都不写该表，因此不受影响。

### 流程图

```mermaid
graph TD
    S[源文件 位于 marked 目录的 md 文件, frontmatter 含 hash] --> A[按评分 score 选择目标库]
    A --> T[去重检查与分配标签 tags]
    T --> D[建草稿 status=draft, 同请求提交 tag_ids]
    D --> M[写 custom_metadata, PUT 后回读校验]
    M --> P[发布 status=publish, 启动解析流水线]
    P --> F[移动本地文件到 weknora 目录]
    F --> W[等待提交间隔, 供生成摘要]
    W --> S
    P -.-> E[任一步失败: 回滚草稿, 文件不移动, 留给下次重试]
```

> 连续失败达到 `max_consecutive_failures` 时中止整个流程，剩余文章留在源目录待人工处理。

### 错误处理

| 场景 | 处理 |
|------|------|
| 发布失败 | 默认**回滚删除草稿**（否则残留草稿会被去重当成「已处理过」而永久跳过），本地文件不移动 |
| 发现重复但无 custom_metadata | 判定为上次处理中途夭折的残废条目，**直接删除**后按无冲突继续上传 |
| 单篇其他环节失败 | 记录 FAIL，本地文件**不移动**，下次运行重新处理 |
| 连续失败 | 连续 `max_consecutive_failures`（默认 3）篇失败即判定后端异常，**停止领新文章并退出进程**，剩余文章留待人工处理 |
| 分配 tags 失败 | 抛出，本地文件**不移动**，下次运行重新处理 |
| 摘要生成较慢 | 通过等待间隔缓解，间隔按实际硬件在 config 中调优 |

---

## 功能四：归档 (archive)

将 `{source}` 中超过指定天数的旧文件移动到 `{target}` 目录。

### 调用方式

```bash
node skills/knowledge/scripts/archive_start.js <source_dir> <target_dir> [days]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<source_dir>` | 是 | 待归档目录（如 `weknora/`） |
| `<target_dir>` | 是 | 归档输出目录（如 `archive/`） |
| `[days]` | 否 | 文件年龄阈值（默认 90 天），按文件 mtime 计算 |

---

Base directory for this skill: skills/knowledge
