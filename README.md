# Microsoft Rewards 自动任务脚本

<div align="center">

**微软积分商城每日签到全家桶 · 后台静默执行 · 多通道消息推送**

[![Version](https://img.shields.io/badge/version-4.3.1-blue)](https://github.com/Arimayuki03/scriptcat/releases)
[![ScriptCat](https://img.shields.io/badge/ScriptCat-%E6%89%A9%E5%B1%95%E8%84%9A%E6%9C%AC-orange)](https://scriptcat.org/)
[![Tests](https://img.shields.io/badge/tests-146%2F146-brightgreen)](#开发与测试)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](#License)
[![Platform](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-%E5%9B%BD%E5%8C%BA%20Microsoft%20Rewards-9cf)](https://rewards.bing.com/)
[![Stars](https://img.shields.io/github/stars/Arimayuki03/scriptcat?style=social)](https://github.com/Arimayuki03/scriptcat/stargazers)

</div>

---

## 📖 简介

基于 [ScriptCat（脚本猫）](https://scriptcat.org/) 的 Microsoft Rewards 自动任务脚本，每天在浏览器后台**静默完成签到、阅读、活动、搜索、Quiz、拼图**等任务赚取积分，支持**企业微信 / 钉钉 / 飞书 / PushMe / Bark** 五种推送渠道通知积分变动。

项目经过 30 轮真实抓包实证迭代：签到走 **App 静默通道**（Bing App UA 上报）、阅读走 **DAPI Token 通道**、活动卡领取按 offer 类型自动选择 **App 上报 / 页面上报**路径，并配套一个**页面领取组件**处理仅能在页面上下文领取的锁定卡。内置轮内缓存、跨实例运行锁、随机延迟、边缘拦截识别与多级兜底账本，长期无人值守运行稳定。

> ⚠️ 本项目仅限个人学习交流使用，请自行承担账号风险。不适用于中国大陆以外地区（内置国区锁定检测，非大陆 IP 自动停止）。

## ✨ 功能特性

| 功能 | 说明 | 默认 |
|---|---|---|
| ✅ 每日签入 | PC + App 双通道静默签入（+3 分/次） | 开 |
| 📰 新闻阅读 | DAPI 接口领取阅读任务，App UA 上报 3 篇（+30 分） | 开 |
| 🎯 活动卡片 | 自动发现可领 offer，App 上报为主路径，含每日打卡 | 开 |
| 🔍 PC 搜索 | 随机词 + 4 家热搜 API 补足搜索积分，间隔 ±15 秒抖动 | 开 |
| 🧩 Quiz 自动答题 | 自动识别问答/拼图类卡片并完成 | 开 |
| 📅 每日活动 | getuserinfo/flyout 结构化数据 + flight 流三级兜底 | 开 |
| 🔗 连签检测 | 自动检测搜索连签任务并接续 | 自动 |
| 🔁 二次扫描 | 复查入账确认，防误报完成 | 自动 |
| 📲 页面领取组件 | 仅页面上下文可领的锁定卡（如 `WW_Rewards_locked_level2`）在打开 rewards 页时自动领取 | 独立脚本 |
| 🔔 积分通知 | 企业微信 / 钉钉 / 飞书 / PushMe / Bark，余额变动推送 | 自选 |

**可靠性设计**：轮内请求缓存（同轮零重复请求）· 跨实例运行锁 · 按日期隔离状态 · 随机延迟与 UA 轮换 · 边缘 503 拦截识别与当日放弃账本 · action ID 随部署动态解析 · 空清单早退 · 跨日自愈。

## 🧩 脚本组成

| 文件 | 角色 | 版本 |
|---|---|---|
| [`微软积分商城签到（全能智能重构版）.user.js`](微软积分商城签到（全能智能重构版）.user.js) | 主脚本：`@crontab` 后台脚本，每 20 分钟一轮自动完成全部任务 | 4.3.1 |
| [`微软积分商城签到-页面领取.user.js`](微软积分商城签到-页面领取.user.js) | 页面侧组件：仅在用户打开 rewards.bing.com 时自动领取锁定卡 | 4.3.1 |

> 两个脚本独立工作、互不依赖：主脚本不注入页面，页面组件不依赖跨脚本存储。只装主脚本即可覆盖绝大多数任务；页面组件用于补领主脚本通道拿不到的少量 offer。

## 📦 安装

### 1. 安装 ScriptCat 扩展

从 [官网](https://scriptcat.org/) 或 [Chrome / Edge 商店](https://microsoftedge.microsoft.com/addons/detail/%E8%84%9A%E6%9C%AC%E7%8C%AB/ndcooeabepamngnbjkkenojohadncemm) 安装脚本猫浏览器扩展。

### 2. 安装脚本

- **方式 A（推荐）**：在 ScriptCat 面板选择「新建脚本」，粘贴 `user.js` 全文后保存。
- **方式 B**：下载本仓库的 `.user.js` 文件，拖入浏览器，由 ScriptCat 接管安装。

### 3. 首次授权

1. 扩展面板打开主脚本的 **菜单 → 🔑 手动授权**，浏览器会跳转 `login.live.com`；
2. 登录微软账号后复制跳转后**完整 URL**；
3. 脚本设置中把该 URL 粘贴进 **「授权码链接」** 文本框并保存，脚本自动换取并续期 Token。

> 授权一次长期有效（脚本自动用 refresh_token 续期）；若提示未授权或 Token 失效，重复上述步骤即可。

## ⚙️ 配置

脚本设置面板（ScriptCat → 脚本 → 设置）内可配置：

| 配置项 | 说明 | 默认 |
|---|---|---|
| `keep` | 全部完成后仍每 20 分钟检查（取消勾选 = 完成后停止循环） | 开 |
| `lock` | 锁定国区，非大陆 IP 自动停止 | 开 |
| `span` | 搜索间隔（秒），±15 秒抖动 | 30 |
| `api` | 搜索词接口：`offline` / hot.nntool.cc / hot.baiwumm.com / hot.cnxiaobai.com | offline |
| `code` | 授权码链接（首次使用必填） | — |
| `Tasks.*` | 五类任务开关：签入 / 阅读 / 活动卡片 / Quiz / PC 搜索 | 全开 |
| `Notice.*` | 通知开关与 webhook 密钥（企业微信 / 钉钉 / 飞书 / PushMe / Bark） | 浏览器通知开 |

**运行方式**：主脚本为 `@crontab` 后台脚本，**不注入任何页面**——扩展面板「当前页运行脚本」显示 0/0 属正常现象，任务在后台按 20 分钟周期自动执行。可随时通过菜单 **🚀 立即运行** 手动触发一轮。

## 📋 脚本菜单

| 主脚本 | 说明 |
|---|---|
| 🔑 手动授权 / 📋 粘贴授权码 | 首次授权 |
| 📊 Token状态 | 查看当前授权状态 |
| 🚀 立即运行 | 手动执行一轮任务 |
| 🔁 强制用授权码换取新Token | Token 失效自救 |
| 🔔 配置通知接口 / 📢 测试通知 | 推送渠道配置与测试 |

| 页面领取脚本（在 rewards.bing.com 页面） | 说明 |
|---|---|
| 🧾 页面领取状态（本页） | 查看最近一次扫描结果 |
| ▶️ 立即领取（本页） | 跳过 15 分钟节流强制领取 |

## ❓ FAQ

<details>
<summary><b>脚本安装后没有反应？</b></summary>

主脚本是后台脚本，不注入任何页面。请在脚本管理页面确认脚本已启用，并通过菜单 **🚀 立即运行** 手动触发，在「脚本日志」中观察执行过程。
</details>

<details>
<summary><b>提示未授权 / Token 失效？</b></summary>

依次尝试：菜单 **📊 Token状态** 检查 → **🔁 强制用授权码换取新Token** → 仍失败则重新走一遍「首次授权」流程。
</details>

<details>
<summary><b>搜索积分没涨？</b></summary>

确认 PC 搜索任务开启且未达当日上限（积分满后服务端不再计分）。可在设置中把 `api` 换成任一热搜接口提升词库多样性；国区账号需使用大陆 IP。
</details>

<details>
<summary><b>「每日活动完成 0/3」或卡片一直不领取？</b></summary>

个别 offer 仅在页面上下文可领（SW 直连会被边缘 503 拦截）。安装配套的**页面领取脚本**，保持 rewards.bing.com 页面打开即可自动补领；也可在页面菜单点 **▶️ 立即领取（本页）**。
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
# 运行全部测试（146 个：主脚本 119 + 页面组件 27）
# 注意：必须显式列出文件名——node --test tests/ 在 Windows 下报 MODULE_NOT_FOUND
node --test "tests/userscript.logic.test.cjs" "tests/page-claim.logic.test.cjs"

# 语法检查
node --check "微软积分商城签到（全能智能重构版）.user.js"
node --check "微软积分商城签到-页面领取.user.js"
```

项目结构：

```
scriptcat/
├── 微软积分商城签到（全能智能重构版）.user.js   # 主脚本（后台 @crontab，4200+ 行）
├── 微软积分商城签到-页面领取.user.js            # 页面领取组件（350+ 行）
├── 微软积分商城签到（全能智能重构版）.options.json
├── tests/
│   ├── userscript.logic.test.cjs               # 主脚本逻辑测试（119）
│   └── page-claim.logic.test.cjs               # 页面组件逻辑测试（27）
├── 改动与待办记录.md                            # 30 轮迭代完整改动日志
└── 优化分析.md                                  # 初期优化分析与裁定记录
```

## 📝 更新日志

完整改动记录见 [改动与待办记录.md](改动与待办记录.md)。近期版本：

| 版本 | 要点 |
|---|---|
| v4.3.1 | 开源发布至 GitHub，新增 README；功能同 v4.3.0 |
| v4.3.0 | 三审查报告合并定案 12 项修复：空清单早退、兜底标签页 10s close、renewToken 门槛与 Bearer 畸形头、边缘拦截短路、dailySetFail 当日上限 5、页面脚本补 19 条 skipPatterns 等；测试 121 → 146 |
| v4.2.1 | `$ACTION_ID_` 40 → {40,64} 位截断修复（P0）、页面提取兄弟嵌套漏提、轮末余额 fresh、日志去 cookie 明文 |
| v4.2.0 | 新增页面领取组件；抓包实证锁定卡仅页面上下文可领 |
| v4.1.0 | App 上报确立为主路径入账通道，页面代理转发通道退役 |

## ⚠️ 免责声明

本项目仅供学习研究，不构成任何形式的保证。使用本项目产生的一切后果由使用者自行承担，请遵守目标网站的服务条款与当地法律法规。如商用或侵权请联系作者删除。

## License

[MIT](https://opensource.org/licenses/MIT) © [Arimayuki03](https://github.com/Arimayuki03)
