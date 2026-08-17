# WhatsApp 老号 → AI 接管 落地 SOP

把多年积累的 WhatsApp 销售对话转化成 AI Agent 的"客户档案 + 风格库 + 历史记忆"。

> 适用场景：你已经在 WhatsApp 个人/商业号上跑了几个月到几年的外贸销售，现在想用 OpenClaw / PulseAgent 接管日常回复，但不能丢掉对老客户的记忆和你本人的销售风格。
>
> **要交付给付费客户？** 先看 [CUSTOMER-DELIVERY-GUIDE.zh-CN.md](CUSTOMER-DELIVERY-GUIDE.zh-CN.md)
> — 含期望对齐话术、A/B/C 交付决策树、`bootstrap.sh` 一键流程、报价参考。

## 最快路径 — 一条命令

```bash
cd whatsapp-old-account-onboarding
bash scripts/bootstrap.sh
```

Bootstrap 脚本会问客户场景、生成盐、引导提取、跑流水线、输出验证报告。
可重入——中断重跑会从 `.bootstrap-state` 继续。

下面是分步骤的详细 SOP，需要手动控制时用。

---

## 三层架构（提醒）

| 层 | 学什么 | 落地位置 | 状态 |
|---|---|---|---|
| A. 客户档案 | 这个客户是谁、买过什么、忌讳什么 | MemOS | 本文档覆盖 |
| B. 高转化样本 | 你的话术风格、套路 | KB `sales_playbook` | 本文档覆盖 |
| C. 对话原文 | 客户引用"上次"时能查得到 | KB `conversation_history` | 本文档覆盖 |

---

## 前置准备

```bash
# 1. Python 3.11+
python --version

# 2. 依赖
pip install -r whatsapp-old-account-onboarding/scripts/requirements.txt

# 3. 凭据
export ANTHROPIC_API_KEY="sk-ant-..."

# 4. 选一个 32 字节随机串作为 PII 脱敏盐，存进密码管理器
export EXPORT_SALT="$(openssl rand -hex 16)"
echo "$EXPORT_SALT" >> ~/.secrets/whatsapp-onboarding-salt.txt
chmod 600 ~/.secrets/whatsapp-onboarding-salt.txt
```

> ⚠️ **salt 丢失 = 客户身份不可逆**。备份到密码管理器（1Password / Bitwarden），不要只放本地。

---

## Step 1 — 导出 WhatsApp 聊天

### 手动模式（< 50 客户）

iOS：聊天 → 联系人头像 → 导出聊天 → 不含媒体 → 邮箱发送 → 下载 .txt

Android：聊天 → 右上 ⋮ → 更多 → 导出聊天 → 不含媒体 → 保存

把所有 .txt 放进 `./exports/`，文件名随意（脚本会从内容里识别客户身份）。

### 半自动模式（> 50 客户）

商业 API 号直接从 webhook 历史落库拉。

个人号用 Android 模拟器 + ADB：

```bash
# 给一个起手脚本骨架，按需补全联系人列表
adb shell am start -n com.whatsapp/.HomeActivity
# 后续每个聊天的 export 操作要按你的语言/版本调整 UI 自动化
# 单聊天导出约 20-30 秒，500 客户 ~3-4 小时
```

> 个人号不建议跑超过 200 个客户的 ADB 自动化——WhatsApp 反自动化策略可能短暂封号。分批跑，每批 50 个间隔 1 小时。

---

## Step 2 — 解析 + 脱敏

```bash
cd ~/claw-ops/whatsapp-old-account-onboarding

python scripts/whatsapp-export-parser.py \
    --input ./exports \
    --output ./parsed \
    --owner-name "Sarah Fan" \
    --salt "$EXPORT_SALT"
```

预期输出：
```
[ok]  Chat with John Lagos.txt -> a3f1c7e9b2d40581.jsonl (+287 turns)
[ok]  Chat with Maria Mexico.txt -> b8d2c4a1e3f0925f.jsonl (+154 turns)
[skip] Chat with Random Group.txt: could not detect customer (owner-name mismatch?)

Done. 47 customers, 12,438 total turns.
```

抽 1-2 个 `parsed/*.jsonl` 文件人工 spot-check：
- 电话/邮箱是否全部 `[PHONE]`/`[EMAIL]`
- session_id 是否合理（同一天的对话应该一个 session）
- 你和客户的 sender 是否分得对

---

## Step 3 — 抽取客户档案（Layer A）

```bash
python scripts/customer-profile-extractor.py \
    --parsed ./parsed \
    --output ./profiles \
    --min-turns 20
```

预期：
- `profiles/<hash>.yaml` 一客户一文件
- `profiles/_manual_review.txt` 闸规则拦下的清单
- 总成本 ~$1.50 / 500 客户

**人工审核**（关键，不要跳）：
```bash
# 严格闸预计 30-40% 进人工审核队列
wc -l profiles/_manual_review.txt

# 通过的客户也抽查 10 个
ls profiles/*.yaml | shuf -n 10 | xargs -I{} less {}
```

审查要点：
- known_objections 是不是真规律
- unfinished_commitments 是不是真承诺（不要把客户的玩笑当承诺）
- relationship_score 8+ 的客户是否名副其实

---

## Step 4 — 写入 MemOS

OpenClaw / PulseAgent 的 MemOS 写入接口（按你部署的版本调整 URL）：

```bash
for f in profiles/*.yaml; do
    # 跳过未通过闸的
    grep -q "^_auto_onboard: true" "$f" || continue

    hash=$(basename "$f" .yaml)
    curl -sS -X POST "https://your-pa-host/api/memos/upsert" \
        -H "Authorization: Bearer $PA_API_TOKEN" \
        -H "Content-Type: application/json" \
        -d "$(python -c "import yaml,json,sys; print(json.dumps({'customer_hash':'$hash','profile':yaml.safe_load(open('$f'))}))")"
done
```

写入后 spot-check：
```bash
curl -sS "https://your-pa-host/api/memos/get?customer_hash=a3f1c7e9b2d40581" \
    -H "Authorization: Bearer $PA_API_TOKEN" | jq .
```

---

## Step 5 — Layer B / C 入库

跟着 [OpenClaw-knowledge-base-import.md](OpenClaw-knowledge-base-import.md) 走完：

- 金矿片段挖掘 → `sales_playbook` collection
- 对话原文向量化 → `conversation_history` collection（带 `customer_hash` filter）

---

## Step 6 — 配置 Agent System Prompt

把 [system-prompt-template.md](system-prompt-template.md) 里的推荐版本贴进 OpenClaw Agent 配置，确认所有 `{{...}}` 变量都有对应的注入源。

---

## Step 7 — 接入前验证（强制）

按 system-prompt-template.md 末尾的 5 个用例跑：

```
□ 老客户开场，Agent 自然提及上次话题
□ "上次报价多少" 触发 history 检索，给出具体数字
□ "再便宜 20%" 触发 ESCALATE
□ "其他客户那单怎样" 礼貌拒绝，不引用
□ "你是机器人吗" 按策略 A 承认是 AI 助手
```

任何一条不过就别接生产，回去调 Prompt 或扩样本库。

---

## Step 8 — 灰度上线

1. **影子模式**（1 周）：Agent 生成回复但不发送，落库供你 review
2. **白名单模式**（1 周）：只对 5-10 个 relationship_score 9-10 的铁客户启用真发送
3. **逐步扩量**：每周扩 20-30% 客户，监控异常回复率

每周指标：
- 客户主动要求转真人的次数
- Agent 触发 ESCALATE 的次数
- 你 review 时改写的回复占比

任何指标超过基线 2x → 暂停扩量，复盘 prompt + 样本库。

---

## 故障排查速查

| 症状 | 查这里 |
|---|---|
| 客户说 "我们不是认识吗" | profile 抽错了，relationship_days 偏小 → 重抽，加大 max_turns |
| Agent 把别的客户名说出来 | KB filter 漏掉了 customer_hash → 立刻关停，修 KB client |
| 风格像 ChatGPT 不像你 | sales_playbook 样本太少或 score 阈值太低 → 补样本 |
| 客户复读 "上次的事" Agent 一脸懵 | conversation_history chunk 切太碎或 7 天阈值太严 → 调 chunk_size / 触发条件 |
| 成本超预算 | Haiku 跑批 OK，运行时如果用 Sonnet 反复检索 → 把检索阶段降级到 Haiku |

---

## 文件清单

```
~/claw-ops/whatsapp-old-account-onboarding/
├── scripts/
│   ├── whatsapp-export-parser.py
│   └── customer-profile-extractor.py
├── docs/
│   ├── README.md                          ← 你在这里
│   ├── OpenClaw-knowledge-base-import.md
│   └── system-prompt-template.md
└── samples/
    └── example-customer-profile.yaml
```
