# Codenames 接入页面 LLM 设置并移除作弊脚本

## Summary

让 Codenames 的 AI 决策真正走「页面设置」中的 LLM 配置，并彻底移除读取 `game["key"]` 的作弊回退脚本。当 LLM 失败或未配置时，回退到不接触钥匙信息的简单动作（随机猜词 / 默认提示词），保证游戏不卡死。

## Current State Analysis（根因）

1. **前端只在 chat 消息时推送设置**：`public/nori-ai-settings.js` 拦截 `WebSocket.send`，仅在 `cartridgeId === "chat"` 的玩家 dispatch 前注入 `nori.ai.config` 事件（[nori-ai-settings.js#L131-L140](file:///d:/PROGRAM/Nori.Web/public/nori-ai-settings.js#L131-L140)）。玩 Codenames 全程不发 chat 消息 → 服务端 ContextVar 永远为空 → LLM 无配置。
2. **world.py 只在 enabled=true 时快照配置**：[world.py#L345-L351](file:///d:/PROGRAM/Nori.Web/backend/session/world.py#L345-L351) 中 `cfg.get("enabled") is True` 才调用 `set_ai_config`，后台 agent 回合任务无法恢复页面设置。
3. **generate_structured 的门禁**：[llm_service.py#L231-L234](file:///d:/PROGRAM/Nori.Web/backend/services/llm_service.py#L231-L234) 要求 `enabled=True` 或服务端 `OPENAI_API_KEY`，否则直接返回空串。
4. **回退脚本是作弊脚本**：[codenames.py#L412-L461](file:///d:/PROGRAM/Nori.Web/backend/cartridges/codenames.py#L412-L461) `agent_next_command` 直接读 `game["key"]`：
   - 猜词时只挑「对方钥匙里是 AGENT」的格子（L445-447）；
   - SUDDEN_DEATH 时同样按对方钥匙挑（L452-460）。
   LLM 失败即回退到这里，表现为「作弊」。
5. **调试日志泄密风险**：[world.py#L294](file:///d:/PROGRAM/Nori.Web/backend/session/world.py#L294) `cfg=%r` 会把含 apiKey 的完整配置打进日志。

## 用户决策

- LLM 失败/未配置 → **非作弊回退**（随机猜/默认提示词），不读任何 key 信息。
- Codenames **始终使用页面设置**，无视页面里的「启用开关」（enabled）。

## Proposed Changes

### 1. `public/nori-ai-settings.js` — 让 Codenames 也推送页面设置

- 将 `isChatPlayerDispatch` 扩展为同时匹配 codenames 玩家 dispatch（`cartridgeId === "codenames"`、`type === "dispatch"`、`actor === "player"`，覆盖 `startGame` / `submitClue` / `submitGuess` / `endTurn`）。
- 匹配命中时按现有指纹机制（`wsFingerprints`）在 dispatch 前注入 `nori.ai.config` 事件。
- 不改 UI、不改存储结构；设置变化通过指纹差异自然重发。

### 2. `backend/services/llm_service.py` — generate_structured 尊重页面设置

- 修改 [generate_structured](file:///d:/PROGRAM/Nori.Web/backend/services/llm_service.py#L214-L260) 的门禁逻辑：
  - 若 ContextVar 中存在页面设置且 `baseUrl` 非空 → **始终使用页面设置**（忽略 `enabled`）；
  - 否则维持旧行为（服务端 `OPENAI_API_KEY` 可用时用服务端配置；都没有 → 返回 `""`）。
- `generate_reply`（chat 路径）不动，仍受 enabled 约束。

### 3. `backend/session/world.py` — 配置快照与日志

- `_schedule_follow_up`（L345-351）：去掉 `enabled is True` 门禁，只要 `cfg` 非空就 `set_ai_config(cfg)`（对 chat 无副作用，chat 的 generate_reply 仍自行判断 enabled）。
- 删除 L294 的 `cfg=%r` 调试日志（apiKey 泄漏风险）。

### 4. `backend/cartridges/codenames.py` — 非作弊回退 + LLM 清理

**重写 `agent_next_command`（完全不再读 `game["key"]`）**：
- NORMAL 且轮到 AI 出提示词：返回默认提示词（按 `wordLocale` 取「诺莉」/「ノリ」/「NORI」，count=1）。
- NORMAL 且 AI 猜词（提示词方为玩家）：
  - 若本回合已猜次数 ≥ 提示词目标数（int 且 ≥1 个已有猜测）→ `endTurn`；
  - 否则从未揭示格子中 `random.choice` 一个 `submitGuess`。
- SUDDEN_DEATH：从未揭示格子随机猜（不再按对方钥匙筛选）。
- 保留使用 `_remaining_agents(game, agent_side)`（自己队伍剩余数是公开信息，不算作弊）。

**`generate_agent_turn` 清理**：
- 删除两段 `logging.getLogger("codenames_llm").warning(...)` 调试块（提示词全文 dump 和 guess 调试日志），替换为失败时一条简洁的 `print` 诊断（不含配置）。
- JSON 解析失败时重试一次 LLM 调用（同一 prompt，仅一次），仍失败返回 `None` 走非作弊回退。

### 5. 不需要改动的部分

- `backend/services/ai_event_bridge.py`：收到 `nori.ai.config` 即安装，已满足需求。
- `backend/services/ai_runtime_config.py`：无需变更（enabled 字段保留，仅 Codenames 忽略它）。
- 前端 React 源码 `frontend-src/`：设置面板由 `public/nori-ai-settings.js` 注入，React 侧无感知。

## Assumptions & Decisions

- 「始终使用页面设置」的判定标准：ContextVar 中已安装配置且 `baseUrl` 非空（仅保存未填 baseUrl 的设置视为未配置）。
- 页面设置可能指向免鉴权端点（如 LM Studio），apiKey 为空仍允许调用（与 chat 的 browser_override 行为一致）。
- 随机猜词回退只影响 LLM 失败场景，正常路径仍是 LLM 决策。

## Verification

1. `uv run pytest tests/test_cartridges.py tests/test_ai_runtime_settings.py -q` — 修复受影响的既有断言；为以下场景补测试：
   - `agent_next_command` 在任意 phase 下返回的命令均不依赖 `game["key"]`（可构造 key 使随机候选与 AGENT 格子错位验证）；
   - 页面设置 installed 且 `enabled=False` 时 `generate_structured` 仍按页面 baseUrl 发起请求（monkeypatch `_openai_compatible_reply` 断言收到的 base_url/model）。
2. 重启后端（**单 worker 非 --reload 模式**，避免旧代码驻留 worker）。
3. 浏览器验证：设置页填 LM Studio / 任一 OpenAI 兼容端点（不开 enabled 开关）→ 开 Codenames → 观察：
   - 后端日志出现 LLM 决策路径（无 cfg dump、无 key 泄漏）；
   - AI 出提示词/猜词由模型决定，不再出现「连中多个己方词」的作弊行为；
   - 拔掉 LLM 端点后游戏仍可继续（随机猜/默认提示词）。
