<div align="center">

# 🎯 bing-rewards-auto

**Microsoft Rewards 每日任务自动化 · 后台静默执行 · 可领取项当日提醒 · 多通道消息推送**

[![Version](https://img.shields.io/badge/version-4.5.0-blue)](https://github.com/Arimayuki03/bing-rewards-auto/releases/latest)
[![ScriptCat](https://img.shields.io/badge/ScriptCat-%E6%89%A9%E5%B1%95%E8%84%9A%E6%9C%AC-orange)](https://scriptcat.org/)
[![Tests](https://img.shields.io/badge/tests-108%2F108-brightgreen)](#-开发与测试)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](#-license)
[![Platform](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-%E5%9B%BD%E5%8C%BA%20Microsoft%20Rewards-9cf)](https://rewards.bing.com/)
[![GitHub Stars](https://img.shields.io/github/stars/Arimayuki03/bing-rewards-auto?style=social)](https://github.com/Arimayuki03/bing-rewards-auto/stargazers)
[![Last Commit](https://img.shields.io/github/last-commit/Arimayuki03/bing-rewards-auto/master)](https://github.com/Arimayuki03/bing-rewards-auto/commits/master)

</div>

---

## 📖 简介

基于 [ScriptCat（脚本猫）](https://scriptcat.org/) 的 Microsoft Rewards 国区自动任务脚本。每天在浏览器后台**静默完成签到、新闻阅读、PC 搜索、每日活动**等任务赚取积分；**活动卡片与欢迎积分**发现可领取时**当日提醒一次**（浏览器通知 + Webhook），打开 [rewards.bing.com](https://rewards.bing.com/) 手动领取即可。

项目经过 **38 轮真实抓包实证**迭代：

- **签到 / 阅读 / 每日活动** → 走 DAPI App 通道（Bing App UA + OAuth Token）后台自动完成；
- **活动卡片 / 欢迎积分** → 网页 Server Action 被浏览器扩展后台（Service Worker）边缘节点**结构性 503 拦截**（抓包实证：同一请求页面上下文 200 且入账、SW 直连 503），自动领取不可靠，v4.5.0 起改为**提醒模式**。

内置轮内请求缓存、跨实例运行锁、按日期隔离状态、随机延迟与 UA 轮换、当日一次提醒去重，长期无人值守运行稳定。

> [!WARNING]
> 本项目仅限个人学习交流使用，请自行评估并承担账号风控风险。内置国区锁定检测，非中国大陆 IP 自动停止，不适用于其他地区。

## ✨ 功能特性

| 功能 | 说明 | 方式 |
|---|---|---|
| ✅ 每日签入 | PC + App 双通道静默签入（+3 分/次） | 自动 |
| 📰 新闻阅读 | DAPI 接口领取阅读任务，App UA 上报 3 篇（+30 分） | 自动 |
| 🔍 PC 搜索 | 随机词 + 4 家热搜 API 补足搜索积分，间隔 ±15 秒抖动 | 自动 |
| 📅 每日活动 | dashboard 当日 3 张活动卡，flight 流解析 + DAPI App 上报 | 自动 |
| 🎯 活动卡片 | /earn 日常任务区 offer 发现与状态跟踪 | 🔔 当日提醒一次 |
| 🎁 欢迎积分 | dashboard「可领取」积分检测 | 🔔 当日提醒一次 |
| 🔗 连签检测 | 搜索/应用/活动连签进度跟踪 | 自动 |
| 🔔 积分通知 | 企业微信 / 钉钉 / 飞书 / PushMe / Bark + 浏览器通知 | 自选 |

**可靠性设计**：轮内请求缓存（同轮零重复请求）· 跨实例运行锁（心跳 + 三判据接管）· 按日期隔离状态与跨日自愈 · 随机延迟与 UA 轮换 · flight 流三级数据兜底 · action ID 随部署动态解析 · 当日一次提醒去重。

## 🧩 工作原理

```text
每 20 分钟一轮（ScriptCat @crontab 后台执行，不注入任何页面）
 │
 ├─ 签到 ──────── DAPI App 上报（OAuth Token）
 ├─ 阅读 ──────── DAPI 阅读任务上报
 ├─ 搜索 ──────── Bing 搜索 + 配额校验（服务端为准）
 ├─ 每日活动 ──── flight 流解析 → DAPI App 上报 → 复核落账
 ├─ 活动卡片 ──── flight 流扫描 → 发现可领 → 🔔 当日提醒
 ├─ 欢迎积分 ──── dashboard 检测 → 发现可领 → 🔔 当日提醒
 └─ 汇总通知 ──── 当日进度 + 积分变动推送
```

> [!NOTE]
> **为什么活动卡片不自动领取？** 站点 2026-09 改版后，领取动作（Next.js Server Action）只能从 rewards 页面上下文发起；浏览器扩展后台发起的同一请求会被边缘节点 503 拦截，且无法通过补头/开后台页稳定绕过。与其维护脆弱的代领链路，不如把确定性交还用户：脚本负责"发现 + 提醒"，一键领取由你在页面上完成。

## 📦 安装

### 1. 安装 ScriptCat 扩展

从 [官网](https://scriptcat.org/) 或 [Chrome / Edge 商店](https://microsoftedge.microsoft.com/addons/detail/%E8%84%9A%E6%9C%AC%E7%8C%AB/ndcooeabepamngnbjkkenojohadncemm) 安装脚本猫浏览器扩展。

### 2. 安装主脚本

- **方式 A（推荐）**：下载 [`微软积分商城签到（全能智能重构版）.user.js`](https://github.com/Arimayuki03/bing-rewards-auto/releases/latest) 后拖入浏览器，由 ScriptCat 接管安装；
- **方式 B**：ScriptCat 面板 →「新建脚本」→ 粘贴 `user.js` 全文保存。

### 3. 首次授权

1. 扩展面板打开主脚本 **菜单 → 🔑 手动授权**，浏览器跳转 `login.live.com`；
2. 登录微软账号后复制跳转后的**完整 URL**；
3. 粘贴进脚本设置 **「授权码链接」** 文本框保存，脚本自动换取并续期 Token（refresh_token 长期有效，续期全自动）。

> 授权遇到问题（如粘贴后不生效）请更新到 v4.4.3+，并可用菜单 **📊 Token状态** 查看授权码"可解析性"、**🔁 强制用授权码换取新Token** 自救。

## ⚙️ 配置

ScriptCat → 脚本 → 设置：

| 配置项 | 说明 | 默认 |
|---|---|---|
| `keep` | 全部完成后仍每 20 分钟检查（取消勾选 = 完成后停止循环） | 开 |
| `lock` | 锁定国区，非大陆 IP 自动停止 | 开 |
| `span` | 搜索间隔（秒），±15 秒抖动 | 30 |
| `api` | 搜索词接口：`offline` / hot.nntool.cc / hot.baiwumm.com / hot.cnxiaobai.com | offline |
| `code` | 授权码链接（首次使用必填） | — |
| `Tasks.*` | 任务开关：签入 / 阅读 / 活动卡片（提醒） / Quiz / PC 搜索 | 全开 |
| `Notice.*` | 通知开关与 Webhook 密钥（企业微信 / 钉钉 / 飞书 / PushMe / Bark） | 浏览器通知开 |

**运行方式**：主脚本为 `@crontab` 后台脚本，**不注入任何页面**——扩展面板「当前页运行脚本」显示 0/0 属正常现象。可随时通过菜单 **🚀 立即运行** 手动触发一轮。

## 📋 脚本菜单

| 菜单 | 说明 |
|---|---|
| 🔑 手动授权 / 📋 粘贴授权码 | 首次授权（后台环境会以系统通知指引粘贴位置） |
| 📊 Token状态 | Token 有效期 + 授权码可解析性 |
| 🚀 立即运行 | 手动执行一轮任务 |
| 🩺 日常卡片诊断 | 只读探测：每日活动清单、活动卡状态、cookie 链、提醒账本 |
| 🔁 强制用授权码换取新Token | Token 失效自救 |
| 🔔 配置通知接口 / 📢 测试通知 | 推送渠道配置与测试 |
| 🐛 开启调试日志 / 💤 完成后停止循环 | 运行行为开关 |

## ❓ FAQ

<details>
<summary><b>脚本安装后没有反应？</b></summary>

主脚本是后台脚本，不注入任何页面。请在脚本管理页确认脚本已启用，通过菜单 **🚀 立即运行** 手动触发，在「脚本日志」中观察执行过程。
</details>

<details>
<summary><b>提示未授权 / Token 失效？</b></summary>

依次尝试：菜单 **📊 Token状态** 检查 → **🔁 强制用授权码换取新Token** → 仍失败则重新走一遍「首次授权」。若粘贴授权码后"保存了却消失"，请确认版本 ≥ v4.4.3（该版本修复了后台等待循环误清授权码的问题）。
</details>

<details>
<summary><b>搜索积分没涨？</b></summary>

确认 PC 搜索任务开启且未达当日上限（积分满后服务端不再计分）。可在设置中把 `api` 换成任一热搜接口提升词库多样性；国区账号需使用大陆 IP。
</details>

<details>
<summary><b>收到「活动卡片可领取」提醒后要做什么？</b></summary>

打开 [rewards.bing.com/earn](https://rewards.bing.com/earn)，找到提醒中列出的卡片（「日常任务」区），点击卡片即可领取——页面上下文一键领取，无需任何额外操作。提醒每天最多一次，当天没领第二天有新的可领项时会再提醒。
</details>

<details>
<summary><b>「仅限积分商城应用」的卡片怎么完成？</b></summary>

这类卡（`WW_Moreactivities_RewardsApp_*`）服务端标记为 App 专属，网页端本身不可领取，只能由手机必应（Bing）App 完成，脚本不会提醒它们。
</details>

<details>
<summary><b>推送到企业微信 / 钉钉 / 飞书没收到？</b></summary>

在群机器人设置中复制 webhook 密钥填入对应通知项，并打开对应的 `_on` 开关；企业微信 / 飞书机器人需包含关键词「#」，钉钉机器人同理。
</details>

<details>
<summary><b>会封号吗？</b></summary>

任何自动化操作都有风险。脚本内置随机延迟、搜索间隔抖动、国区锁定检测等防风控措施，但请自行评估与承担。
</details>

## 🛠 开发与测试

```bash
# 运行全部测试（108 个，node 内置 test runner，无外部依赖）
# 注意：必须显式列出文件名——node --test tests/ 在 Windows 下报 MODULE_NOT_FOUND
node --test "tests/userscript.logic.test.cjs" "tests/page-claim.logic.test.cjs"

# 语法检查
node --check "微软积分商城签到（全能智能重构版）.user.js"
```

测试基于 `node:vm` 沙箱加载脚本源码、剥离入口后断言内部函数；网络层通过可注入的 `GM_xmlhttpRequest` / `fetch` 打桩，不触达真实服务。

<details>
<summary><b>项目结构</b></summary>

```text
bing-rewards-auto/
├── 微软积分商城签到（全能智能重构版）.user.js   # 主脚本（后台定时任务）
├── tests/
│   ├── userscript.logic.test.cjs               # 主脚本逻辑测试
│   └── page-claim.logic.test.cjs               # 页面诊断组件逻辑测试（指向 .bak）
├── 改动与待办记录.md                            # 38 轮迭代完整改动日志（抓包实证）
└── 优化分析.md                                  # 初期优化分析与裁定记录
```

</details>

## 📝 更新日志

完整改动记录（含每轮抓包实证与裁定过程）见 [改动与待办记录.md](改动与待办记录.md)。近期版本：

| 版本 | 要点 |
|---|---|
| **v4.5.0** | **架构定案**：活动卡片与欢迎积分改**提醒模式**（当日一次通知，手动领取）；每日活动集保留 DAPI App 通道自动完成；页面组件退役；修复设置面板粘贴授权码不能保存 |
| v4.4.x | 开页代领编排六轮迭代（autoclaim 握手 / 限次冷却 / 信号回传 / 账本双写），后随 v4.5.0 提醒模式退役 |
| v4.3.x | 空清单早退、放弃账本、边缘拦截识别等 12 项修复；开源发布 |
| v4.2.x | 页面领取组件；Server Action ID 截断 P0 修复 |
| v4.1.x | App 上报确立为主路径入账通道 |

## 🤝 贡献

欢迎 Issue 与 PR：报 bug 请附脚本日志（脱敏后）与「🩺 日常卡片诊断」弹窗内容；站点改版导致的失效请优先跑一遍诊断菜单，把输出贴进 Issue。

## ⚠️ 免责声明

本项目仅供学习研究，不构成任何形式的保证。使用本项目产生的一切后果由使用者自行承担，请遵守目标网站的服务条款与当地法律法规。如商用或侵权请联系作者删除。

## License

[MIT](https://opensource.org/licenses/MIT) © [Arimayuki03](https://github.com/Arimayuki03)
