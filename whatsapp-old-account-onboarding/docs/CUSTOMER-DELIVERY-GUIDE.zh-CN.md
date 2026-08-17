# 客户交付指南 — WhatsApp 老号接入

> 给付费客户交付前请先读这页。**最关键的是先纠正客户对 WhatsApp 历史
> 数据的认知**——这是合同争议的高发区。

English version: [CUSTOMER-DELIVERY-GUIDE.md](CUSTOMER-DELIVERY-GUIDE.md).

---

## ⚠️ 关键认知对齐（kick-off 会议必谈）

客户最常问：**"接入后 AI 是不是就能直接读我所有的 WhatsApp 聊天？"**

诚实回答：

| 账号类型 | 历史数据 | 上线后新消息 |
|---|---|---|
| **WhatsApp Business API** | ❌ **零历史**。Webhook 只推送接入后到达的消息 | ✅ 实时 |
| **WhatsApp Business App** | ⚠️ 历史在手机里，但只能通过单聊天"导出"或设备备份解析 | ✅ 可通过 Baileys 代理 |
| **个人号** | ⚠️ 同 Business App，加上更高封号风险 | ⚠️ 走 Baileys，ToS 灰色 |

**销售阶段就把这句话写进方案里**，不要等签完合同：

> "历史聊天通过你的 iCloud/iTunes/Google Drive 备份提取，不通过
> WhatsApp 官方 API。备份里没有的对话我们恢复不了。上线后所有新对话
> AI 全接管。"

---

## 交付决策树

```
Q1. 客户用 Business API / Business App / 个人号？
   ├─ Business API           → 路径 A
   ├─ Business App（手机）    → 路径 B
   └─ 个人号                  → 路径 C（同 B，但要加 ToS 免责）

Q2. （B 和 C 需要）客户手机系统？
   ├─ iOS    → B.1 / C.1   （iTunes 备份或 iMazing）
   └─ Android → B.2 / C.2  （msgstore.db.crypt15 提取）

Q3. 有最近的备份吗？
   ├─ 24 小时内    → 直接开始
   ├─ 超过 7 天    → 让客户先做一次新备份
   └─ 从来没做过   → 第 0 步就是教他备份
```

---

## 路径 A — Business API 客户

**没历史，别承诺**。交付聚焦 Layer B + 未来 Layer C 累积。

1. 确认 Cloud API / 自建 + BSP 身份
2. 接入观察期：30 / 60 / 90 天 webhook 累积 → 然后跑 extractor
3. Layer A 档案由销售自己填 `customer_profile_seed.yaml` 种子文件
   （每个 top 客户 5 分钟，v1 上限 30 个）
4. Layer B：从邮件/CRM 里手工挑 30-50 段优质对话样本

**时间表**：1 周搭好基础设施，30+ 天累积到 Layer C 真正有用。

---

## 路径 B/C — 手机账号（备份提取）

### 第 0 步 — 让客户做一次新备份（必做）

**客户自己操作，我们不碰他的手机**。

**B.1 / C.1（iOS）**
- WhatsApp → 设置 → 聊天 → 聊天备份 → 立即备份
- 包含视频：**关**（省 70% 时间，我们用不到）
- 连电脑 → iTunes / Finder → 加密备份（**让客户记住密码**——解密必需）

**B.2 / C.2（Android）**
- WhatsApp → 设置 → 聊天 → 聊天备份 → 备份
- 本地备份就够（Google Drive 备份需要客户提供专门 key）
- 客户还需要 64 字符**加密密钥**给 `msgstore.db.crypt15` 解密。
  WhatsApp 路径：设置 → 账户 → 端到端加密备份 → 管理 → 显示密钥

### 第 1 步 — 跑 bootstrap

```bash
cd whatsapp-old-account-onboarding
bash scripts/bootstrap.sh
```

脚本会：
1. 检测 Python + Anthropic SDK + 提取工具
2. 问客户场景（A/B/C 路径、iOS/Android 等）
3. 生成一次性 PII 盐，存到 `~/.secrets/`
4. 引导客户走他那条提取路径
5. 跑 parser → extractor → 输出到 `./out/`
6. 打印验证报告

### 第 2 步 — 人工审核（30-40% 档案进队列）

`./out/profiles/_manual_review.txt` 列出被严格闸拦下的客户。销售逐个看，
大部分一行注释就能放行。

### 第 3 步 — 推送 MemOS + KB

Bootstrap 脚本末尾会问 PulseAgent API 端点 + token，然后：
- MemOS upsert（Layer A）— 所有 `_auto_onboard: true` 自动推
- `sales_playbook` 导入（Layer B）— 进交互式 segment 评审 UI
- `conversation_history` embed（Layer C）— 后台跑

### 第 4 步 — 上线前验证

跑 `system-prompt-template.md` 末尾的 5 个验证用例。**全过才能开切流量**。

### 第 5 步 — 影子 → 白名单 → 灰度

按 `README.zh-CN.md` 的日程。默认：
- 第 1 周：影子模式
- 第 2 周：白名单 5-10 个高信任客户
- 第 3-6 周：每周扩 20-30%

---

## 交付清单（每客户）

- [ ] 签字版"历史数据范围"对齐段落
- [ ] 客户做了新备份，备份密码/密钥已记录
- [ ] Bootstrap 脚本端到端跑完，日志存到项目目录
- [ ] `_manual_review.txt` 全部处理完
- [ ] MemOS 内档案数 >= 通过审核客户数的 80%
- [ ] 5 个验证用例全过
- [ ] 客户签字确认影子模式样本，再开白名单
- [ ] 灰度日程书面确认
- [ ] 盐 + API token 交到客户密码管理器（不是我们的）

---

## 报价参考

不是固定价目，是起手锚点：

| 客户体量 | 建议费用 | 原因 |
|---|---|---|
| 历史 < 50 客户 | ¥3,500-¥10,000 | 1 天工作，主要是人工审核 |
| 50-300 客户 | ¥17,000-¥35,000 | 2-3 天，自动化真正出 ROI |
| 300-1000 客户 | ¥55,000-¥100,000 | 1 周，需要 ADB 自动化层 |
| > 1000 客户 | 定制报价 | 大概率要并行接 Business API |

订阅：¥1,400-¥3,500/月 持续 MemOS 更新 + KB 漂移调优。

---

## 明确不交付的范围

- WhatsApp 封号恢复（客户自担）
- 客户手机上做备份（客户自己做）
- iCloud / Google Drive 凭据托管（客户提取到本地）
- 多设备同步配置（不在范围）
- 语音 / 视频 / 表情包分析（仅文本）
- 群聊（仅 1 对 1 销售对话）

这几条写进合同附件。边界清晰才能防 scope creep。
