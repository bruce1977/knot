# 知识库管线 (knowledge)

知识库管线的核心技能，提供四大功能：初始化、文档分析、同步导入 WeKnora、归档旧文件。

## 功能一览

| 功能 | 脚本 | 说明 |
|------|------|------|
| init | `init_start.js` | 初始化目录结构和 `$config/config.json` |
| analyze | `analyze_start.js` | 元数据提取 + 五维评分 + 合并 frontmatter |
| sync | `weknora_start_to_sync.js` | 将终稿导入 WeKnora（直传普通库 / wiki 库） |
| sync:forge | `weknora_forge_start_to_sync.js` | 同步流程走 WeKnora Forge（HMAC 签名 + 一次性发布） |
| archive | `archive_start.js` | 按文件年龄归档旧文件 |

## 目录结构

```
${profile}/
├── $config/
│   ├── config.json              ← 主配置文件
│   ├── extractor_meta_config.json   ← 可选：覆盖 meta 插件配置
│   └── extractor_rate_config.json   ← 可选：覆盖 rate 插件配置
├── inbox/                       ← 原始文档
├── marked/                      ← 已分析文档
├── weknora/                     ← 已同步文档
└── archived/                    ← 归档文档
```

## 整体流程图

```mermaid
graph LR
    inbox[原始文档目录 inbox/] -->|分析脚本 analyze_start.js| marked[已分析目录 marked/]
    marked -->|同步脚本 weknora_start_to_sync.js| weknora[WeKnora 远程知识库]
    weknora -->|归档脚本 archive_start.js| archived[归档目录 archived/]
    cfg[配置文件 $config/config.json] -.->|初始化脚本 init_start.js| inbox
```

## 快速开始

### 初始化

```bash
node skills/knowledge/scripts/init_start.js <base_dir>
```

### 文档分析

```bash
node scripts/kb-analyze.js <profile> [batch_size]
```

### 同步到 WeKnora

```bash
node scripts/kb-weknora.js <profile>
```

### 通过 WeKnora Forge 同步

```bash
npm run sync:forge
# 或
node --env-file=.env scripts/weknora_forge_start_to_sync.js [profile]
```

需要环境变量 `WEKNORA_FORGE_BASE_URL`（以及 `WEKNORA_API_KEY` / `WEKNORA_API_SECRET`，或 profile 的 `weknora.api_key` / `weknora.api_secret`）。详见 [通过 WeKnora Forge 同步](#通过-weknora-forge-同步syncforge)。

### 归档

```bash
node scripts/kb-archive.js <profile> [days]
```

## 同步导入 WeKnora (sync)

将 `marked/` 中的终稿**逐篇**直接导入 WeKnora 的目标知识库（普通库或 wiki 库），**不再经临时库周转**。临时库方案下 move 后向量不跟随，会导致目标库文章无法检索；直传后 WeKnora 直接在目标库内解析并生成摘要。

### 每篇文章流程

1. 读文件、解析 frontmatter，按 `score` 选择目标库（`wiki_kb_id` 已配且 `score ≥ score_threshold` → wiki，否则普通库）
2. 去重检查（可选）+ 分配 tags
3. **建草稿**：`POST /knowledge-bases/{target}/knowledge/manual`，`status=draft`，同一次请求带上 `tag_ids`
4. **写元数据**：`PUT /knowledge/{id}`，仅写 `custom_metadata`（含 `hash`），写完回读校验
5. **发布**：`PUT /knowledge/manual/{id}`，`status=publish` —— 此时才开始解析流水线
6. 移动本地文件到 `weknora/`（三步全部成功后才移动，失败则留在原处等下次重试）
7. 按目标库类型等待 `normal_submit_interval_ms` / `wiki_submit_interval_ms`，确保 WeKnora 有足够时间生成摘要

### 为什么是「草稿 → 元数据 → 发布」

WeKnora 的创建接口（`ManualKnowledgePayload`）**结构上就没有 `custom_metadata` 字段**，所以 metas 只能在创建之后写。而一旦以 `publish` 直接入库，解析流水线会立刻启动，并**按内存快照整行回写**记录——此时再 PUT 的 `custom_metadata` 会被下一次回写冲掉，这就是「PUT 返回成功但数据没了」的原因。

草稿模式下这个竞态天然不存在：

| 阶段 | 流水线状态 | metas 写入 |
|------|-----------|-----------|
| `status=draft` | 完全不入流水线，`parse_status=draft`、`enable_status=disabled` | 没有任何异步写在竞争，写入必然留存 |
| `PUT /knowledge/{id}` | 同上 | 此时 `summary_status` 为空，**不会触发摘要重算**（也就没有额外 LLM 开销） |
| `status=publish` | 开始解析 + 生成摘要 | metas 已经在库里，第一次摘要就带上了它们 |

tags 不受影响：`POST .../manual` 在建草稿时就把 `tag_ids` 写进 `knowledge_tags` 关联表；而发布接口只读取 title / content / status / process_config，**不读也不改 tags**，流水线全程没有任何一处写那张关联表。

代价只是每篇多两次 HTTP 请求，换零竞态、零额外 LLM 调用。

### 失败处理

| 场景 | 处理 |
|------|------|
| 发布失败 | 默认**删除残留草稿**（`rollback_on_publish_failure`），否则下次去重会把它当成「已处理过」而永久跳过；本地文件不移动 |
| 发现重复但无 custom_metadata | 判定为上次处理中途夭折的残废条目，**直接删除**后按无冲突继续上传（自定义元数据是在发布前写入的，拿不到 hash 说明那次没跑完） |
| 单篇其他环节失败 | 记录 FAIL，本地文件**不移动**，下次运行重新处理 |
| 连续失败 | 连续 `max_consecutive_failures`（默认 3）篇失败 → 判定后端异常，**停止领新文章并以非 0 退出码终止进程**，剩余文章留在源目录待人工处理 |
| 分配 tags 失败 | 抛出，本地文件不移动 |
| 摘要生成较慢 | 通过等待间隔缓解，间隔可在 config 中调优 |

### weknora 配置字段

`config.json` 的 `weknora` 节关键字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `kb_id` | ✅ | 普通库知识库 ID |
| `wiki_kb_id` | ❌ | wiki 知识库 ID（配了才启用评分分流） |
| `score_threshold` | ❌ | 评分阈值（score ≥ 阈值 → wiki） |
| `concurrency` | ❌ | 并发路数（默认 1，串行） |
| `normal_submit_interval_ms` | ❌ | 普通库每篇上传后等待间隔（默认 30000） |
| `wiki_submit_interval_ms` | ❌ | wiki 库每篇上传后等待间隔（默认 600000） |
| `submit_interval_ms` | ❌ | 每篇发布后的等待间隔回退值 |
| `batch_size` | ❌ | 本次最多处理多少篇（0 = 全部） |
| `dedup_enabled` | ❌ | 仅旧脚本：是否启用 title + hash 去重（`sync:forge` 不读此项，有 `hash` 即始终去重） |
| `custom_metas` | ✅ | 写入 WeKnora custom_metadata 的字段映射 |
| `max_consecutive_failures` | ❌ | 连续失败多少篇后中止流程（默认 3） |
| `abort_grace_ms` | ❌ | 中止后在途请求的宽限期，超时强杀进程（默认 30000） |
| `rollback_on_publish_failure` | ❌ | 发布失败是否回滚删除草稿（默认 true） |

> 兼容性：未配置 `normal_submit_interval_ms` / `wiki_submit_interval_ms` 时，两者均回退到旧字段 `submit_interval_ms`（若也未配则 100ms）。两个间隔默认值（30s / 600s）是按摘要生成耗时估算的，可随硬件升级调整。

## 通过 WeKnora Forge 同步 (sync:forge)

`scripts/weknora_forge_start_to_sync.js` 与 `weknora_start_to_sync.js` 走同一套 profile / 配置 / 目标库分流 / 去重 / 移动文件流程，但改走 **WeKnora Forge** 扩展 API（原脚本保持不动）。

### 调用方式

```bash
npm run sync:forge [profile]
```

### 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `KB_BASE_PATH` / `KB_DEFAULT_PROFILE` | ❌ | Profile 根目录（也可用 CLI 传入 `<profile>`） |
| `WEKNORA_FORGE_BASE_URL` | ✅ | Forge 服务地址 |
| `WEKNORA_API_KEY` | ✅* | `X-API-Key`（*若已配 profile `weknora.api_key` 则以其为准） |
| `WEKNORA_API_SECRET` | ✅* | HMAC-SHA256 签名密钥（*若已配 profile `weknora.api_secret` 则以其为准） |

签名：`X-Forge-Signature = hex(HMAC_SHA256(api_secret, METHOD + FULL_PATH))`，`FULL_PATH` 含原始 query（不做规范化）。

### 认证 / 配置优先级

1. Profile `$config/config.json` → `weknora.api_key` / `weknora.api_secret`
2. 否则环境变量 `WEKNORA_API_KEY` / `WEKNORA_API_SECRET`

`WEKNORA_FORGE_BASE_URL` 始终从环境变量读取。

### 单篇发布

一次 Forge 调用取代「草稿 → 写元数据 → 发布」：

`POST .../knowledge/publish`，payload `{kb_id, title, content, description?, tag_names, custom_metas, sync}`。

`sync` 来自配置 `publish_sync`（默认 `false`）：为 true 时后端发布后立即建索引，不等异步管线。tags 在服务端解析；失败时服务端回滚。

### 去重（forge）

文件 frontmatter 含 `hash` 时**始终**去重（无开关）：

1. 仅按 `custom_metadata.hash = '<hash>'` 查询普通库 + wiki 库（**查询条件不含 title**）
2. 逐条比对命中结果的 `title === submitTitle`（`submitTitle` = frontmatter 的 `title`，缺省回退去 `.md` 的文件名）
3. 任一命中 title 完全一致 → `DUP`，移入 `marked/dupl/`；hash 存在但 title 均不同（或无命中）→ 正常发布

### 相关配置字段

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `publish_sync` | `false` | 发布 payload 的 `sync`（立即索引） |
| `api_key` / `api_secret` | `""` | Forge 凭证（非空时优先于环境变量） |

## 环境变量

### Profile 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KB_BASE_PATH` | - | 知识库根目录（如 `D:\knowledge\obsidian`） |
| `KB_DEFAULT_PROFILE` | - | 默认 profile 名称（如 `ai`），与 `KB_BASE_PATH` 拼接成完整路径 |

Profile 路径解析：`${KB_BASE_PATH}/${KB_DEFAULT_PROFILE}`（如 `D:\knowledge\obsidian\ai`）

### 分析功能

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KB_LLM_BASE_URL` | `http://localhost:11434` | LLM API 地址 |
| `KB_LLM_API_KEY` | 空 | LLM API 密钥 |
| `KB_LLM_MODEL` | `qwen2.5:3b` | 默认模型 |
| `KB_LLM_META_MODEL` | 继承 `KB_LLM_MODEL` | 元数据提取专用模型 |
| `KB_LLM_RATE_MODEL` | 继承 `KB_LLM_MODEL` | 评分提取专用模型 |
| `KB_LLM_TIMEOUT_MS` | `120000` | 单次 LLM 请求超时 |
| `KB_LLM_PROVIDER` | `auto` | 后端类型：`auto`/`ollama`/`openai` |

### 同步功能

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PB_KNOWLEDGE_BASE_PATH` | 必填 | 知识库根目录 |
| `WEKNORA_BASE_URL` | 必填 | WeKnora API 地址 |
| `WEKNORA_API_KEY` | 必填 | API 密钥 |
| `WEKNORA_FORGE_BASE_URL` | `sync:forge` 必填 | WeKnora Forge 地址 |
| `WEKNORA_API_SECRET` | `sync:forge` 必填* | Forge HMAC 密钥（profile `weknora.api_secret` 优先） |

\* `sync:forge` 同样需要 `WEKNORA_API_KEY` / profile `api_key`（见上）。

## 插件配置（提示词 + 数据结构）

每个插件的提示词与数据结构合并为**一个**配置文件，默认随插件放在 `scripts/plugins/`：

```
scripts/plugins/
├── extractor_meta.js              ← 插件实现
├── extractor_meta_config.json     ← prompt + schema
├── extractor_rate.js
└── extractor_rate_config.json
```

文件结构：

```json
{
  "prompt": { "system": "...", "user": "... {{content}}", "retry": "..." },
  "schema": { "title": ["string", 1], "tags": ["array", 2, 5] }
}
```

要覆盖默认配置，在 profile 的 `$config/` 下放一个**同名**文件即可，无需在 `config.json` 里声明：

```
${profile}/$config/extractor_meta_config.json    ← 存在则覆盖，否则用插件目录默认文件
```

文件名固定为 `<插件名>_config.json`。覆盖文件为**整体替换**，需包含完整的 `prompt` 与 `schema` 两段。

## 跨厂商配置（LLM 后端）

LLM 客户端（`scripts/lib/llm.js`）支持两种后端类型：

- **Ollama native API（`provider=ollama`）**：使用 `/api/chat` 端点，通过 `think:false` 禁用推理模式。推荐用于 Ollama 后端。
- **OpenAI 兼容（`provider=openai`）**：使用 `/v1/chat/completions` 端点。

### 重要说明

- **Qwen 3.5 模型**：默认开启思考模式，返回的 `content` 字段为空。使用 `provider=ollama` 可启用 `think:false` 参数。
- **Provider 检测**：当 `provider=auto` 时，通过 URL 自动检测（检查 URL 中是否包含 `11434` 或 `ollama`）。对于自定义端口，需显式设置 `provider=ollama`。

### 切换示例

**默认——本地 Ollama**

```bash
KB_LLM_PROVIDER=ollama
KB_LLM_BASE_URL=http://localhost:11434
KB_LLM_MODEL=qwen3.5:4b
```

**对接 OpenAI / Azure / 通义 / DeepSeek 等**

```bash
KB_LLM_PROVIDER=openai
KB_LLM_BASE_URL=https://<your-provider>/v1
KB_LLM_MODEL=gpt-4o-mini
KB_LLM_API_KEY=<your-api-key>
```

## 脚本结构

```
scripts/
├── init_start.js            ← 初始化
├── analyze_start.js         ← 分析主入口
├── analyze_extract_meta.js  ← 元数据提取模块
├── analyze_extract_rate.js  ← 评分提取模块
├── analyze_frontmatter.js   ← YAML frontmatter 生成
├── weknora_start_to_sync.js ← 同步 WeKnora
├── weknora_forge_start_to_sync.js ← 同步 WeKnora Forge
├── archive_start.js         ← 归档
└── lib/
    ├── llm.js               ← LLM 客户端
    ├── common.js            ← 通用工具函数（含 getProfileDir）
    ├── weknora.js           ← WeKnora HTTP 客户端
    ├── weknora_forge.js     ← WeKnora Forge 客户端（HMAC + 搜索 + 发布）
    ├── content_hash.js      ← 内容 hash
    └── validate_md.js       ← Markdown 格式校验
```

### Profile 路径解析

`lib/common.js` 中的 `getProfileDir()` 函数用于解析 profile 目录：

```javascript
function getProfileDir() {
    const basePath = process.env.KB_BASE_PATH;
    const defaultProfile = process.env.KB_DEFAULT_PROFILE;
    if (basePath && defaultProfile) {
        return path.join(basePath, defaultProfile);
    }
    return defaultProfile || null;
}
```

脚本中的用法：如果未提供命令行参数，脚本使用 `getProfileDir()` 解析默认路径（如 `${profileDir}/inbox`、`${profileDir}/marked`）。

## 缓存与幂等

- `.meta.json` 已存在 → 跳过元数据提取
- `.rate.json` 已存在 → 跳过评分
- 两个缓存文件都存在 → 跳过提取，直接合并
- 终稿文件名 `${title}.md`：**不再包含 hash**；hash 仅写入 frontmatter 的 `hash` 字段与 WeKnora 的 `custom_metadata.hash`
- 同名文件策略：已存在同名文件时，若 `hash` 相同则直接覆盖，不同则追加序号 `${title}(1).md`、`${title}(2).md` …
- 同步侧**不再做 hash 去重**，**不再经临时库周转**：文章直接上传到目标库（普通库或 wiki 库），摘要由 WeKnora 直接生成；重复检测留待后续通过 SQL 检索 WeKnora 知识库
- **例外 —— `sync:forge`：** frontmatter 有 `hash` 时始终远端仅按 `hash` 查询，命中结果逐条比对 title，完全一致才判 `DUP`（见 [通过 WeKnora Forge 同步](#通过-weknora-forge-同步syncforge)）
