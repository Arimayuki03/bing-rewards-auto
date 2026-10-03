<div align="center">

# Microsoft Rewards 自动任务脚本

**微软积分商城每日签到全家桶 · 后台静默执行 · 多通道消息推送**

[![Version](https://img.shields.io/badge/version-4.5.1-blue)](https://github.com/Arimayuki03/bing-rewards-auto/releases)
[![ScriptCat](https://img.shields.io/badge/ScriptCat-%E6%89%A9%E5%B1%95%E8%84%9A%E6%9C%AC-orange)](https://scriptcat.org/)
[![Tests](https://img.shields.io/badge/tests-91%2F91-brightgreen)](#开发与测试)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](#License)
[![Platform](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-%E5%9B%BD%E5%8C%BA%20Microsoft%20Rewards-9cf)](https://rewards.bing.com/)
[![Stars](https://img.shields.io/github/stars/Arimayuki03/bing-rewards-auto?style=social)](https://github.com/Arimayuki03/bing-rewards-auto/stargazers)

</div>

---

## 📖 简介

基于 [ScriptCat（脚本猫）](https://scriptcat.org/) 的 Microsoft Rewards 自动任务脚本，每天在浏览器后台**静默完成签到、阅读、搜索、每日活动**等任务赚取积分，活动卡片与欢迎积分**发现可领取时当日提醒一次**、手动打开页面领取，支持**企业微信 / 钉钉 / 飞书 / PushMe / Bark** 五种推送渠道通知积分变动。

项目经过 37 轮真实抓包实证迭代：签到走 **App 静默通道**（Bing App UA 上报）、阅读走 **DAPI Token 通道**、每日活动走 **DAPI App 上报**自动完成；活动卡片与欢迎积分因 Server Action 被 SW 边缘 503 结构性拦截（v4.2.0 实证）改为**提醒模式**。内置轮内缓存、跨实例运行锁、随机延迟与当日一次提醒去重，长期无人值守运行稳定。

> ⚠️ 本项目仅限个人学习交流使用，请自行承担账号风险。不适用于中国大陆以外地区（内置国区锁定检测，非大陆 IP 自动停止）。

## ✨ 功能特性

| 功能 | 说明 | 默认 |
|---|---|---|
| ✅ 每日签入 | PC + App 双通道静默签入（+3 分/次） | 开 |
| 📰 新闻阅读 | DAPI 接口领取阅读任务，App UA 上报 3 篇（+30 分） | 开 |
| 🎯 活动卡片 | 自动发现可领 offer，**当日提醒一次**，手动领取（v4.5.1） | 开 |
| 🔍 PC 搜索 | 随机词 + 4 家热搜 API 补足搜索积分，间隔 ±15 秒抖动 | 开 |
| 🧩 Quiz / 拼图卡片 | 随活动卡片扫描，可领时一并提醒（无答题器） | 开 |
| 📅 每日活动 | DAPI App 上报自动完成 + flight 流三级兜底 | 开 |
| 🔗 连签检测 | 自动检测搜索连签任务并接续 | 自动 |
| 🔁 二次扫描 | 复查每日活动入账确认，防误报完成 | 自动 |
| 🔔 积分通知 | 企业微信 / 钉钉 / 飞书 / PushMe / Bark，余额变动推送 | 自选 |

**可靠性设计**：轮内请求缓存（同轮零重复请求）· 跨实例运行锁 · 按日期隔离状态 · 随机延迟与 UA 轮换 · 边缘 503 拦截识别与当日放弃账本 · 当日一次提醒去重 · 跨日自愈。

## 🧩 脚本组成

单脚本文件，无页面组件、无外部依赖：

| 文件 | 角色 | 版本 |
|---|---|---|
| [`微软积分商城签到（全能智能重构版）.user.js`](微软积分商城签到（全能智能重构版）.user.js) | 主脚本：`@crontab` 后台脚本，每 20 分钟一轮自动完成全部任务 | 4.5.1 |

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
> 「授权码链接」里的内容**用掉后仍会保留**，方便随时确认自己填的是什么；脚本用 `Config.codeUsed` 单独记住"这份已用过"，不会重复使用同一份授权码。想让同一份再生效一次，用菜单 **🔁 强制用授权码换取新Token**。

## ⚙️ 配置

脚本设置面板（ScriptCat → 脚本 → 设置）内可配置：

| 配置项 | 说明 | 默认 |
|---|---|---|
| `keep` | 全部完成后仍每 20 分钟检查（取消勾选 = 完成后停止循环） | 开 |
| `lock` | 锁定国区，非大陆 IP 自动停止 | 开 |
| `span` | 搜索间隔（秒），±15 秒抖动 | 30 |
| `api` | 搜索词接口：`offline` / hot.nntool.cc / hot.baiwumm.com / hot.cnxiaobai.com | offline |
| `code` | 授权码链接（首次使用必填；换取成功后仍保留，可随时查看/重贴） | — |
| `Tasks.*` | 五类任务开关：签入 / 阅读 / 活动卡片 / Quiz / PC 搜索 | 全开 |
| `Notice.*` | 通知开关与 webhook 密钥（企业微信 / 钉钉 / 飞书 / PushMe / Bark） | 浏览器通知开 |

**运行方式**：主脚本为 `@crontab` 后台脚本，**不注入任何页面**——扩展面板「当前页运行脚本」显示 0/0 属正常现象，任务在后台按 20 分钟周期自动执行。可随时通过菜单 **🚀 立即运行** 手动触发一轮。

## 📋 脚本菜单

| 主脚本 | 说明 |
|---|---|
| 🔑 手动授权 / 📋 粘贴授权码 | 首次授权 |
| 📊 Token状态 | 查看当前授权状态 |
| 🚀 立即运行 | 手动执行一轮任务 |
| 🩺 日常卡片诊断 | 只读探测：每日活动/活动卡状态、cookie 链、提醒账本 |
| 🔁 强制用授权码换取新Token | Token 失效自救 |
| 🔔 配置通知接口 / 📢 测试通知 | 推送渠道配置与测试 |

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
<summary><b>每日活动/活动卡片/欢迎积分是怎么完成的？</b></summary>

v4.5.1 起分两条链路：**每日活动集**（dashboard 上 3 张 Gamification_DailySet 卡）由脚本经 DAPI App 通道**自动完成**；**活动卡片**（/earn 日常任务区）与**欢迎积分**因服务端对后台请求的结构性拦截（SW 直发 Server Action 一律 503）改为**提醒模式**——发现可领取时当日推送一次通知（含明细），打开 rewards.bing.com 手动点卡片领取即可。「仅限积分商城应用」的卡片只能由必应 App 完成。有疑问时用主脚本菜单 **🩺 日常卡片诊断** 逐层查看。
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
# 运行全部测试（91 个）
# 注意：必须显式列出文件名——node --test tests/ 在 Windows 下报 MODULE_NOT_FOUND
node --test "tests/userscript.logic.test.cjs"

# 语法检查
node --check "微软积分商城签到（全能智能重构版）.user.js"
```

项目结构：

```
bing-rewards-auto/
├── 微软积分商城签到（全能智能重构版）.user.js   # 主脚本（后台定时任务，单文件，3700+ 行）
├── tests/
│   └── userscript.logic.test.cjs               # 主脚本逻辑测试（91）
├── 改动与待办记录.md                            # 历轮迭代完整改动日志
└── 优化分析.md                                  # 初期优化分析与裁定记录
```

## 📝 更新日志

完整改动记录见 [改动与待办记录.md](改动与待办记录.md)。近期版本：

| 版本 | 要点 |
|---|---|
| v4.5.4 | 修复设置面板「授权码链接」输入框在授权码用掉后变空——`Config.code` 曾同时充当"输入框显示值"与"待消费一次性凭据"，后者按设计须清空，输入框因此必然被清空；现 `Config.code` 只作显示值永久保留，"是否已用过"另存指纹 `Config.codeUsed`，同步根治 v4.5.0 每 20 分钟重演的 Token 死循环；测试 97 → 100 |
| v4.5.2 | 提醒模式实战修正：活动卡片提醒剔除每日活动卡（Gamification_DailySet，由脚本自动完成，2026-10-01 实测混入 6 项中 3 项）；欢迎积分提醒前移至搜索前——原排运行末尾，SW 回收丢写 claimNotify 账本致当日重复提醒；测试 91 → 94 |
| v4.5.1 | 提醒模式重构上线：/earn 活动卡片与 dashboard 欢迎积分当日一次提醒、用户手动领取（SW 503 结构性拦截，自动领取退役）；每日活动集保留 DAPI App 通道自动完成（含二次扫描）；删除页面领取组件，回归单脚本文件；修复 v4.5.0 遗留的二次扫描悬空 claimCard 调用；测试 169 → 91 |
| v4.4.6 | 回滚基线：信号基线持久化到存储 + 限额用尽日无信号每天点名一次页面脚本缺失；测试 168 → 169 |
| v4.4.5 | 信号基线记录下沉到 _kickPageSweep，覆盖全部开页触发路径（放弃账本/每日活动/二次扫描/活动卡片）；测试 167 → 168 |
| v4.4.4 | 开页代领闭环断点定位：页面脚本清扫后写信号 cookie（后台可读），开页账本双写防 SW 存储丢写，🩺 诊断显示信号状态；测试 163 → 167 |
| v4.4.3 | 修复设置面板粘贴授权码不能正常保存（SW 菜单无 prompt/alert 静默失效、预清空竞态抹值、失败路径无差别清理），新增 parseAuthCode 统一解析与 Token 状态可解析性显示；测试 159 → 163 |
| v4.4.2 | 边缘拦截开页检查前移至失败落账后、二次扫描补检查点；测试 157 → 159 |
| v4.4.1 | 放弃账本卡片先转页面代领再收账；测试 154 → 157 |
| v4.4.0 | 日常任务卡片修复（内置浏览器抓包实证）：边缘拦截日自动开页代领闭环、页面脚本清扫后逐卡复核、空清单不再假标完成、双脚本新增 🩺 只读诊断菜单；测试 146 → 154 |
| v4.3.1 | 开源发布至 GitHub，新增 README；功能同 v4.3.0 |
| v4.3.0 | 三审查报告合并定案 12 项修复：空清单早退、兜底标签页 10s close、renewToken 门槛与 Bearer 畸形头、边缘拦截短路、dailySetFail 当日上限 5、页面脚本补 19 条 skipPatterns 等；测试 121 → 146 |
| v4.2.1 | `$ACTION_ID_` 40 → {40,64} 位截断修复（P0）、页面提取兄弟嵌套漏提、轮末余额 fresh、日志去 cookie 明文 |
| v4.2.0 | 新增页面领取组件；抓包实证锁定卡仅页面上下文可领 |
| v4.1.0 | App 上报确立为主路径入账通道，页面代理转发通道退役 |

## ⚠️ 免责声明

本项目仅供学习研究，不构成任何形式的保证。使用本项目产生的一切后果由使用者自行承担，请遵守目标网站的服务条款与当地法律法规。如商用或侵权请联系作者删除。

## License

[MIT](https://opensource.org/licenses/MIT) © [Arimayuki03](https://github.com/Arimayuki03)
