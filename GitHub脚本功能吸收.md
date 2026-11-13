# GitHub 热门 Bing / Microsoft Rewards 脚本调研与吸收清单

> 调研日期：2026-11-13　目标版本：v4.6.0-beta.1
> 调研对象：GitHub 上星标较高、近期仍有维护的 Microsoft Rewards 自动化项目
> 吸收原则：只吸收能在 ScriptCat `@crontab` 后台脚本（无页面注入、SW 直连）中稳定落地的能力；需要浏览器常驻/页面上下文的能力保留提醒或暂不吸收。

## 一、调研结果

| 项目 | 星标 | 技术栈 | 核心能力 | 与本项目的关系 |
|---|---:|---|---|---|
| [TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script) | 约 1.2k | TypeScript + Playwright，API / 浏览器双模式 | 桌面/移动搜索、Daily Set、Punch Cards、Read to Earn、Daily Check-In、Explore on Bing、视觉搜索、Edge 浏览、搜索奖励、Flyout 领卡、积分核算 | 本轮主要吸收来源；其 API 模式与本项目“SW 直连 + cookie”最接近 |
| [chiihero/Microsoft-Rewards-Script](https://github.com/chiihero/Microsoft-Rewards-Script) | 约 668 | TypeScript（TheNetsky 中文本地化） | 中文环境、国区账号适配、任务汇总 | 参考国区日志/配额口径 |
| [3kh0/bing-rewards](https://github.com/3kh0/bing-rewards) | 约 69 | Python + Selenium | web/mobile/offers 全类别、按剩余任务执行 | 验证“移动配额必须单独跑”的普遍做法 |
| [idbb98/microsoft-bing-rewards-daily-task-script](https://github.com/idbb98/microsoft-bing-rewards-daily-task-script) | 约 8 | Userscript + Python/.NET | App 签到/阅读、设备 UA 预设、dashboard/earn 任务点击、搜索面板 | 参考 App 设备预设与任务状态面板 |
| [SeiShonagon520/bing-rewards-helper](https://github.com/SeiShonagon520/bing-rewards-helper) | 约 7 | Userscript | PC 搜索、联想词、真人化滚动/停留、风控页检测 | 搜索节奏与验证码检测思路 |

## 二、本轮吸收的功能

### 1. 移动端搜索（TheNetsky / 3kh0 / idbb98）

**问题**：原脚本 `getRewardsInfo()` 已经解析出 `mobile.max / mobile.progress`，但 `doSearch()` 只跑 PC 配额，移动配额整天不领取。

**吸收实现**：
- 新增 `Tasks.mobile` 开关（默认开）。
- `doSearch()` 同时读取 PC / 移动配额；PC 满后继续补移动，两者都满才落 `searchDate`。
- 移动搜索使用 `RewardsAuto.ua.mobile`（EdgA UA）与 `_Rwho=u=m&ts=<今天>` cookie，PC 使用 `u=d`。
- PC / 移动各自维护停滞计数（`restrictedTimes` / `mobileRestrictedTimes`），避免一方增长掩盖另一方受限。
- 汇总通知新增“移动搜索 x/y”行。

**来源文件**：TheNetsky `src/rewards/api/search/ApiSearch.ts`、`src/rewards/shared/search/SearchManager.ts`；3kh0 `BingRewards.py` 的 mobile 分支。

### 2. SERP 真实 IG + cvid 上报（TheNetsky）

**问题**：原 `reportSearch()` 使用随机 UUID 作为 `IG`，与本次搜索结果页的会话不一致；服务端可能返回 200 但不计分。

**吸收实现**：
- `getSearchPage()` 生成 `cvid` 并带进搜索 URL。
- 从 SERP HTML 提取真实 `IG`（兼容 `IG:"..."`、`?IG=`、`&amp;IG=`、`{"IG":"..."}`）。
- `reportSearch()` 使用同一 `IG + cvid` 调用 `/rewardsapp/reportActivity`，并解析 `ModernRewards.ReportActivity({...})` 回执中的 `Balance / DailySearchPointsEarned / DailySearchPointsLimit`。
- ncheader 仍保留为可选初始化请求，失败不阻断 reportActivity。

**来源文件**：TheNetsky `src/rewards/api/search/BingSearchApi.ts`、`src/rewards/shared/search/BingSearchReport.ts`。

### 3. URLReward 搜索奖励自动补搜（TheNetsky）

**问题**：dashboard 上有些 URLReward 卡（目标为 Bing 根路径）只要搜索即可推进，但原脚本只把它们当普通活动卡提醒。

**吸收实现**：
- 新增 `API.getSearchBonusOffers()`：从 getuserinfo / flyout 的 morePromotions、promotionalItems、exploreOnBingPromotions 等池中筛选：
  - 未完成；
  - `promotionType=urlreward`；
  - 目标 URL 为 Bing 根路径，且只含跟踪参数（form/ocid/publ/crea/pc/channel/mkt/cc/setlang）。
- 新增 `TaskManager._runSearchBonus()`：按缺口补搜，单卡最多 4 次、单轮总预算 6 次，补完 fresh 复查。
- 新增 `Tasks.bonus` 开关（默认开）。

**来源文件**：TheNetsky `src/rewards/shared/search/SearchBonus.ts`、`src/rewards/api/search/ApiSearch.ts#searchBonus`。

### 4. Bing Flyout 活动卡片自动领取（TheNetsky）

**问题**：v4.5.1 因 `rewards.bing.com` 的 Server Action 被 SW 边缘 503 拦截，活动卡片改为纯提醒。TheNetsky 的 `FlyoutActivityReport` 走的是 `www.bing.com/msrewards/api/v1/reportactivity`，与 Server Action 不同域，可绕开该拦截。

**吸收实现**：
- `API.getFlyoutViewModel()`：GET `www.bing.com/rewards/panelflyout?...`，解析 `window.flyoutViewModel`（含 `userId`、卡片 `hash/AuthKey`）。
- `API.claimCardViaFlyout(card, model)`：POST `/msrewards/api/v1/reportactivity`，payload 复刻 TheNetsky：
  `ActivityType / ActivitySubType / OfferId / Channel / PartnerId / UserId / AuthKey / ActivityCount`。
- `TaskManager._claimManualCardsViaFlyout()`：每卡每天最多 3 次、单轮最多 8 张；只有服务端明确 `OfferComplete=true` 才算出列；有积分但未完成仍保留提醒。
- 新增 `Config.flyoutClaim` 开关（默认开）；关闭后恢复纯提醒模式。
- 失败/未确认卡片继续走 `notifyClaimables()` 当日一次提醒。

**来源文件**：TheNetsky `src/rewards/api/actions/FlyoutActivityReport.ts`、`src/rewards/browser/parsers/FlyoutPageParser.ts`、`src/rewards/api/actions/ApiUrlReward.ts`。

### 5. 其他对齐

- 阅读任务保持 DAPI 通道，每日上限 10 篇（与 TheNetsky `ApiReadToEarn` 的循环上报思路一致）。
- 每日签到保持 App `type=103` 通道（TheNetsky `DailyCheckIn` 同类型）。
- 每日活动保持 DAPI App 上报 + flight 兜底（原项目已有，不重复吸收）。

## 三、评估后暂不吸收

| 能力 | 来源 | 不吸收原因 |
|---|---|---|
| Edge 后台浏览（30 分钟 streak） | TheNetsky `EdgeBrowsing.ts` | 需要桌面 access token + 每 5 分钟常驻上报，与 20 分钟 crontab / SW 生命周期冲突；且本项目 OAuth scope 未覆盖 Edge 通道 |
| 视觉搜索 streak | TheNetsky `ApiVisualSearch.ts` / `VisualSearchClient.ts` | 需要 multipart 上传 + bcid 轮换 + 视觉搜索 SERP 上报，后台环境未验证；误报会污染 streak |
| Quiz / 拼图自动答题 | 多个项目 | 没有通用答案源；各区域题目不同，自动答题误选会浪费卡片。保留“可领取时提醒” |
| Search multiplier perk 激活 | TheNetsky `ActivateSearchPerk.ts` | 激活依赖 Server Action（本项目已实证 SW 503）；Flyout 是否支持该活动类型未验证 |
| 欢迎积分自动领取 | TheNetsky `ClaimBonusPoints.ts` | 走 Server Action `reportClaimAllPoints`，仍受 503 拦截；保留当日提醒 |
| 多账号 / 控制面板 / Docker | TheNetsky / chiihero | 与 ScriptCat 单脚本后台架构不匹配 |

## 四、验证与回归

- 新增测试：移动配额补搜、PC+移动同轮、真实 IG 提取、搜索回执解析、搜索奖励筛选/补搜、Flyout 视图模型解析、Flyout 领卡 payload、自动领取后仅提醒剩余卡片。
- 代码审查后补 10 条回归：null 数据源结账语义、未确认上报不计数、移动-only 配额、锁定卡/跨池去重、Flyout 缺卡与数字 ID、每日补搜账本、init 移动开关等。
- 测试总数：100 → 121，全部通过。
- 语法检查：`node --check "微软积分商城签到（全能智能重构版）.user.js"`。
- 实际账号验证建议：
  1. 观察日志是否出现 `移动搜索配额已满` / `[移动] 搜索`；
  2. 观察 `搜索回执: 今日搜索分 x/y` 是否随搜索增长；
  3. 观察 `Flyout 自动领取: ... +N分` 与后续汇总“活动卡片”状态；
  4. 若 Flyout 返回 `missing-user-or-hash` / `non-json`，说明页面结构或登录态变化，脚本会自动降级为提醒。
