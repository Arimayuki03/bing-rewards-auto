// ==UserScript==
// @name         微软积分商城签到（全能智能重构版）
// @namespace    local.bing-rewards-auto
// @version      4.2.0
// @description  每天在后台自动完成 Microsoft Rewards 任务获取积分奖励，✅签入(PC+App静默)、✅阅读、✅活动、✅搜索、✅Quiz、✅拼图、✅热搜API、✅二次扫描、✅积分通知、✅连签任务检测、✅每日活动自动上报（v4.2.0：配套《微软积分商城签到-页面领取》脚本——抓包实证 SW 直连 Server Action 被边缘 503、页面上下文同样请求 200+入账，仅页面上下文可领的 offer 交由页面侧脚本在用户打开 rewards 页时自动完成；v4.1.1：锁定等级卡解析层过滤 + 失败卡计入放弃账本；v4.1.0：App 上报为主路径，服务端对 App 目录外 offer 静默 200+p:0）
// @icon         https://bing.com/th?id=OMR.icon-96.png&pid=Rewards
// @license      MIT
// @crontab      */20 * * * *
// @connect      bing.com
// @connect      login.live.com
// @connect      rewards.bing.com
// @connect      prod.rewardsplatform.microsoft.com
// @connect      hotapi.nntool.cc
// @connect      hot.baiwumm.com
// @connect      cnxiaobai.com
// @connect      disp-qryapi.3g.qq.com
// @connect      qyapi.weixin.qq.com
// @connect      oapi.dingtalk.com
// @connect      open.feishu.cn
// @connect      push.i-i.me
// @connect      api.day.app
// @match        https://login.live.com/oauth20_desktop.srf*
// @match        https://rewards.bing.com/*
// @match        https://www.bing.com/*
// @match        https://cn.bing.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_cookie
// @grant        GM_info
// @grant        GM_log
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @storageName  BingRewardsAuto_Shared
// ==/UserScript==
//
// ⚠️ 架构说明：@crontab 使本脚本被 ScriptCat 归类为「后台脚本」——只在扩展
// 后台运行、不注入任何页面（弹窗「当前页运行脚本」永远 0/0 属正常现象）。
// v4.1.0：前台同源转发通道（页面代理脚本 + 救援标签页）整体退役——App 上报
// （DAPI type 101）实测为主路径入账通道后，Server Action 网页链仅存兜底价值，
// 不再为它维持页面注入/共享存储桥/救援标签页。全部请求走 SW 直连。

/* global GM_cookie, GM_getValue, GM_setValue, GM_xmlhttpRequest, GM_log, GM_info, GM_notification, GM_openInTab, GM_addValueChangeListener */

/* ==UserConfig==
Config:
    keep:
        title: 全部完成后仍每20分钟检查（取消勾选=完成后停止循环）
        type: checkbox
        default: true
    lock:
        title: 锁定国区（非大陆IP自动停止）
        type: checkbox
        default: true
    span:
        title: 搜索间隔（秒）
        type: number
        default: 30
        min: 30
        unit: ±15秒
    api:
        title: 搜索词接口（offline为随机搜索词）
        type: select
        default: offline
        values: [offline, hot.nntool.cc, hot.baiwumm.com, hot.cnxiaobai.com]
    debugDailySet:
        title: 调试日志（输出每日活动原始字段，排查用）
        type: checkbox
        default: false
    code:
        title: 授权码链接
        type: textarea
        description: 粘贴 login.live.com 跳转后的完整URL
Tasks:
    sign:
        title: 每日签入
        type: checkbox
        default: true
    read:
        title: 新闻阅读
        type: checkbox
        default: true
    promos:
        title: 活动卡片（含打卡）
        type: checkbox
        default: true
    quiz:
        title: Quiz 自动答题
        type: checkbox
        default: true
    search:
        title: PC搜索
        type: checkbox
        default: true
Notice:
    bro:
        title: 浏览器通知（当前脚本）
        type: checkbox
        default: true
    wework:
        title: 企业微信消息推送（群机器人）
        type: text
        password: true
        description: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    wework_on:
        title: 企业微信推送开关
        type: checkbox
        default: false
    dingding:
        title: 钉钉群机器人（不加签，关键词：#）
        type: text
        password: true
        description: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    dingding_on:
        title: 钉钉推送开关
        type: checkbox
        default: false
    feishu:
        title: 飞书群机器人（不加签，关键词：#）
        type: text
        password: true
        description: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    feishu_on:
        title: 飞书推送开关
        type: checkbox
        default: false
    pushme:
        title: PushMe（push.i-i.me）
        type: text
        password: true
        description: xxxxxxxxxxxxxxxxxxxx
    pushme_on:
        title: PushMe推送开关
        type: checkbox
        default: false
    bark:
        title: Bark（bark.day.app）
        type: text
        password: true
        description: xxxxxxxxxxxxxxxxxxxx
    bark_on:
        title: Bark推送开关
        type: checkbox
        default: false
==/UserConfig== */

(function() {
    'use strict';

    // OAuth 授权码自动捕获（v3.8.0 随页面注入能力一并退役：后台脚本不注入页面）

    const RewardsAuto = {
        // UA: pc=Edge桌面, mobile=Edge移动, app=BingSapphire真机抓包
        ua: {
            pc: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
            mobile: "Mozilla/5.0 (Linux; Android 16; Redmi K20 Pro Build/BP4A.251205.006; ) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/144.0.7559.132 Mobile Safari/537.36 EdgA/131.0.0.0",
            // App 端 UA（来自真实抓包数据，Redmi K20 Pro + BingSapphire）
            app: "Mozilla/5.0 (Linux; Android 16; Redmi K20 Pro Build/BP4A.251205.006; ) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/144.0.7559.132 Mobile Safari/537.36 BingSapphire/32.6.2110003560",
        },
        // Server Action 兜底 ID：站点每次部署都会轮换 action ID，此值仅为
        // 动态解析（JS chunk 扫描）失败时的最后兜底，需随站点改版更新。
        // 来源：当前构建 chunk 中 createServerReference(..., "reportActivity")。
        fallbackActionId: "707e6eb15bdfdd5fba193f0a77e934f7018faf87ce",
        appConfig: {
            rewardsAppId: "SAAndroid/32.6.2110003560",
            channel: "SAAndroid",                       // 渠道：Android 版 Bing App
            offerIds: {
                dailyCheckIn: "Gamification_Sapphire_DailyCheckIn",  // 每日签到标识
                readArticle: "ENUS_readarticle3_30points",           // 阅读任务标识
            }
        },
        searchPool: [
            "what is the weather forecast tomorrow",
            "how do I make sourdough bread at home",
            "where can I find cheap flights to tokyo",
            "why is the sky blue scientific explanation",
            "how to learn rust programming in 2026",
            "what time does the world cup final start",
            "how to fix a leaky kitchen faucet step by step",
            "what are the best vr games of 2026",
            "how to start a vegetable garden in spring",
            "where to watch new movies this week",
            "how to take care of a bonsai tree",
            "what is the difference between python async and threading",
            "how to meditate properly for beginners",
            "what is the origin of halloween traditions",
            "how do solar panels actually work",
            "what is the best mechanical keyboard for typing",
            "how to tie a windsor knot tie",
            "what causes northern lights aurora borealis",
            "how to brew the perfect espresso at home",
            "what are the symptoms of vitamin d deficiency",
            "how to sleep better naturally tonight",
            "why do cats purr when they are happy",
            // 地点/新闻/购物意图
            "best coffee shops in san francisco downtown",
            "italian restaurants near times square",
            "tokyo cherry blossom season 2026 forecast",
            "rtx 5070 ti benchmark vs rtx 4080 super",
            "iphone 17 release date and features",
            "tesla stock price today nasdaq",
            "best noise cancelling headphones under 300",
            "fastest electric cars 0 to 60 mph",
            "vintage camera brands collectors guide",
            "budget gaming laptop with rtx 4070 2026",
            // 操作指南/食谱
            "easy chocolate chip cookies recipe from scratch",
            "30 minute home workout routine no equipment",
            "stretching exercises for lower back pain relief",
            "easy origami crane folding instructions",
            "git rebase vs merge which one to use",
            "markdown cheat sheet with examples",
            "japanese hiragana chart pronunciation",
            "ancient rome history quick overview",
            "pomodoro technique for focus and productivity",
            "healthy breakfast ideas under 10 minutes",
            // 中文搜索词
            "天气预报", "今日新闻热点", "美食食谱家常菜", "旅游攻略", "健康养生知识",
            "科技资讯", "电影推荐", "股票行情", "体育赛事", "历史上的今天"
        ],
        // 热搜API配置
        apiConfig: {
            // getter 每次读取实时配置，菜单里切换搜索词接口无需 reload 即生效
            get mode() { return GM_getValue("Config.api", "offline"); },
            arr: [
                ["hot.baiwumm.com", {
                    url: "https://hot.baiwumm.com/api/",
                    hot: ["weibo", "douyin", "baidu", "toutiao", "thepaper", "qq", "netease", "zhihu"],
                }],
                ["hot.cnxiaobai.com", {
                    url: "https://cnxiaobai.com/DailyHotApi/",
                    hot: ["weibo", "douyin", "baidu", "toutiao", "thepaper", "qq-news", "netease-news", "zhihu"],
                }],
                ["hot.nntool.cc", {
                    url: "https://hotapi.nntool.cc/",
                    hot: ["weibo", "douyin", "baidu", "toutiao", "thepaper", "qq-news", "netease-news", "zhihu"],
                }],
            ],
            url: "",
            hot: [],
            wordList: [],
            wordIndex: 0,
        },
        skipPatterns: [
            "referral", "refer and earn", "sweepstake", "entries",
            "install the", "set bing as your default", "bing wallpaper",
            "punch card", "ancient coin", "sea of thieves", "rewards extension",
            "redemption goal", "order history", "claim your gift", "shop to earn",
            "set goal", "Available tomorrow", "Offer is Locked", "Earn -1 points"
        ],
        skipHrefs: [
            "sweepstakes/", "referandearn", "aka.ms/win", "workinprogress",
            "punchcard", "microsoft-store", "goal/all", "orderhistory",
            "/redeem", "/redeemgoal", "xbox.com/rewards"
        ],
        state: {
            token: false,
            region: "CN",
            host: "www.bing.com",
            dateNowNum: 0,
            dateNowStr: "",
            pcProgress: 0,
            pcMax: 60,
            readProgress: 0,
            readMax: 30,
            sendMSG: "",
            lastSearchProgress: -1,
            restrictedTimes: 0,
            pc401: false,
            _rvTokenCache: null,
            reportActionId: null,   // 轮内缓存的 reportActivity action ID（每次部署轮换，需动态解析）
            ip: "",
            ipInfo: "",
            startTime: 0,
        }
    };

    const Webhooks = [
        {
            name: "企业微信",
            url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=",
            get key() { return GM_getValue("Notice.wework", false); },
            get enabled() { return GM_getValue("Notice.wework_on", false); },
            msg: {
                "msgtype": "text",
                "text": {
                    get content() {
                        return `> ${new Date().toLocaleString()}\n\n ## ${GM_info.script.name}\n ${RewardsAuto.state.sendMSG}`
                    }
                },
            },
        },
        {
            name: "钉钉",
            url: "https://oapi.dingtalk.com/robot/send?access_token=",
            get key() { return GM_getValue("Notice.dingding", false); },
            get enabled() { return GM_getValue("Notice.dingding_on", false); },
            msg: {
                "msgtype": "markdown",
                "markdown": {
                    "title": GM_info.script.name,
                    get text() {
                        return `> ${new Date().toLocaleString()}\n ### ${GM_info.script.name}\n ${RewardsAuto.state.sendMSG}`
                    }
                },
            },
        },
        {
            name: "飞书",
            url: "https://open.feishu.cn/open-apis/bot/v2/hook/",
            get key() { return GM_getValue("Notice.feishu", false); },
            get enabled() { return GM_getValue("Notice.feishu_on", false); },
            msg: {
                "msg_type": "interactive",
                "card": {
                    "schema": "2.0",
                    "header": {
                        "title": {
                            "tag": "plain_text",
                            "content": GM_info.script.name
                        },
                        "template": "orange"
                    },
                    "body": {
                        "elements": [{
                            "tag": "markdown",
                            "text_align": "center",
                            get content() {
                                return `#### ${new Date().toLocaleString()}\n ${RewardsAuto.state.sendMSG}`
                            }
                        }]
                    }
                }
            },
        },
        {
            name: "PushMe",
            url: "https://push.i-i.me/?push_key=",
            get key() { return GM_getValue("Notice.pushme", false); },
            get enabled() { return GM_getValue("Notice.pushme_on", false); },
            msg: {
                "type": "markdown",
                "title": `${GM_info.script.name}[#rewards!https://rewards.bing.com/rewards.png]`,
                get content() {
                    return `\n ${RewardsAuto.state.sendMSG}`
                }
            },
        },
        {
            name: "Bark",
            url: "https://api.day.app/",
            get key() { return GM_getValue("Notice.bark", false); },
            get enabled() { return GM_getValue("Notice.bark_on", false); },
            msg: {
                "group": "rewards",
                "icon": "https://rewards.bing.com/rewards.png",
                "title": GM_info.script.name,
                get markdown() {
                    return `\n ${RewardsAuto.state.sendMSG}`
                }
            },
        },
    ];

    const Utils = {
        // 日志输出（带通知支持）
        log(icon, msg, push = false, force = false) {
            GM_log(`${icon} ${msg}`);
            if (push) {
                // 每日去重：内容相同（仅去空白比较）的通知当天只推送一次，
                // 避免已完成任务在后续轮次重复弹窗；force=true 时跳过去重（如测试通知）
                if (!force && !this._dedupePush(msg)) return;
                if (GM_getValue("Notice.bro", true)) {
                    try {
                        GM_notification({
                            title: GM_info.script.name + ` ${icon}`,
                            text: msg,
                            onclick: () => GM_openInTab("https://rewards.bing.com/dashboard", { active: true })
                        });
                    } catch(_) {}
                }
                // 发送到外部通知接口
                // 多行内容视为完整汇总报告，原样推送；单行通知才拼接图标前缀
                RewardsAuto.state.sendMSG = msg.includes("\n") ? msg : `${icon} ${msg}`;
                this.sendWebhook();
            }
        },

        // 推送去重：同一天内内容相同（仅去除空白后比较）的通知只推送一次。
        // 保留数字原样——数字归一化会把"签入 +5积分"与"+15积分"误判为同一条而吞掉推送。
        // key 截断到 300 字符（汇总报告通常 <300），既降低长消息尾部差异被截断误判的概率，
        // 又限制当日去重记录的存储体积。
        _dedupePush(msg) {
            try {
                const today = Utils.getTodayNum();
                let rec = GM_getValue("Config.pushDedupe", null);
                if (!rec || rec.date !== today) rec = { date: today, keys: [] };
                const key = String(msg).replace(/\s+/g, "").slice(0, 300);
                if (rec.keys.includes(key)) return false;
                rec.keys.push(key);
                GM_setValue("Config.pushDedupe", rec);
                return true;
            } catch (_) {
                return true; // 去重逻辑异常时不阻断推送
            }
        },

        // 发送webhook通知
        async sendWebhook() {
            await Promise.all(Webhooks.map(async (i) => {
                if (!i.enabled || !i.key) return;
                const safeKey = String(i.key).trim();
                const targetUrl = safeKey.startsWith("http") ? safeKey : i.url + safeKey;
                try {
                    const result = await this.xhr({
                        method: "POST",
                        url: targetUrl,
                        headers: {
                            "content-type": "application/json; charset=UTF-8",
                        },
                        data: JSON.stringify(i.msg),
                    });
                    if (result) GM_log(`🔵 「${i.name}」消息推送完成`);
                } catch (e) {
                    GM_log(`🔴 「${i.name}」消息推送出错: ${e.message}`);
                }
            }));
        },

        // 封装 GM_xmlhttpRequest，15秒超时。
        // GET 重定向自动跟随并返回最终页面内容（earn/dashboard 常见区域跳转），
        // 避免调用方拿到 Location 字符串后误当 HTML 解析、静默失败；非 GET 请求
        // 遇重定向仍返回 Location（或 false），由调用方决定后续处理。
        async xhr(options, _redirects = 0) {
            return new Promise((resolve, reject) => {
                const start = Date.now();
                const isGetLike = !options.method || options.method.toUpperCase() === "GET";
                GM_xmlhttpRequest({
                    anonymous: false,
                    ...options,
                    timeout: 15000,
                    onload: (res) => {
                        const cost = ((Date.now() - start) / 1000).toFixed(2);
                        if (res.status >= 200 && res.status < 300) {
                            resolve(res.responseText);
                        } else if ([301, 302, 307, 308].includes(res.status)) {
                            const match = res.responseHeaders?.match(/Location:\s*(.*?)\s*\r?\n/i);
                            if (isGetLike && match && _redirects < 5) {
                                try {
                                    const nextUrl = new URL(match[1], options.url).toString();
                                    this.xhr({ ...options, url: nextUrl }, _redirects + 1).then(resolve, reject);
                                    return;
                                } catch (_) { /* 相对路径解析失败时退回原行为 */ }
                            }
                            resolve(match ? match[1] : false);
                        } else if (options.acceptErrorBody) {
                            // 调试路径：非 2xx 时携带状态与响应体返回，供上层记录诊断信息
                            resolve({ status: res.status, body: res.responseText || "", headers: res.responseHeaders || "" });
                        } else {
                            reject(new Error(`HTTP ${res.status}，用时 ${cost} 秒`));
                        }
                    },
                    onerror: (err) => {
                        const cost = ((Date.now() - start) / 1000).toFixed(2);
                        reject(new Error(`${err?.error || "网络错误"}，用时 ${cost} 秒`));
                    },
                    ontimeout: () => {
                        const cost = ((Date.now() - start) / 1000).toFixed(2);
                        reject(new Error(`请求超时，用时 ${cost} 秒`));
                    }
                });
            });
        },

        // 读取浏览器 cookie（含 httpOnly）构造显式 Cookie 头。
        // 背景（2026-09-14 实测定位）：Server Action 的鉴权依赖完整 cookie 链，同样
        // 的 payload+headers，浏览器与带完整 cookie 的 curl 返回 200，脚本 SW 请求
        // 返回 500——ScriptCat SW 发起的跨源子请求不会自动携带 SameSite=Lax/Strict
        // 的登录 cookie（.MSA.Auth/_U/rn_S 等）。GM_cookie 可无视 SameSite 读取，
        // 显式放进 Cookie 头即可补齐。不可用（非 ScriptCat/未授权/超时）返回 ""，
        // 调用方保持隐式 cookie 行为不变。
        // v3.7.0：三形式兼容（ScriptCat action 形 / TM .list 形 / GM.cookie Promise 形）
        // 并上抛 error——此前回调只取首参，授权拒绝/接口缺失时静默返回 ""，直连请求
        // 长期在缺 cookie 状态下发出而无从排查（2026-09-15 抓包：缺链请求 200 但
        // action 不执行、半截链 500）。每轮首次获取记录 form/count/error 诊断日志。
        cookieHeaderFor(url, timeoutMs = 2500) {
            return new Promise((resolve) => {
                let done = false;
                const report = (cookie, diag) => {
                    if (done) return; done = true;
                    clearTimeout(timer);
                    RewardsAuto.state.cookieDiag = diag || { form: "ok", count: (cookie.match(/=/g) || []).length };
                    if (diag && !RewardsAuto.state.cookieDiagLogged) {
                        RewardsAuto.state.cookieDiagLogged = true;
                        Utils.log("🟡", `cookie 链诊断(${diag.form}): ${diag.error} —— SW 直连将缺 SameSite 登录 cookie（Server Action 会 500/200-noop）。请检查 ScriptCat 的 GM_cookie 授权弹窗与脚本 @connect 域名`);
                    } else if (!diag && !RewardsAuto.state.cookieDiagLogged) {
                        RewardsAuto.state.cookieDiagLogged = true;
                        Utils.log("🩺", `cookie 链可用: ${RewardsAuto.state.cookieDiag.count} 条`);
                    }
                    resolve(cookie);
                };
                const timer = setTimeout(() => report("", { form: "timeout", error: `${timeoutMs}ms 无回调` }), timeoutMs);
                try {
                    if (typeof GM_cookie === "function") {
                        GM_cookie("list", { url }, (cookies, error) => {
                            if (done) return;
                            if (error) return report("", { form: "GM_cookie(action)", error: String((error && error.message) || error) });
                            if (Array.isArray(cookies)) return report(cookies.map(c => `${c.name}=${c.value}`).join("; "));
                            // 回调形态不对 → 尝试 TM 对象形 GM_cookie.list
                            try {
                                if (GM_cookie && typeof GM_cookie.list === "function") {
                                    GM_cookie.list({ url }, (cookies2, error2) => {
                                        if (done) return;
                                        if (error2) return report("", { form: "GM_cookie.list", error: String((error2 && error2.message) || error2) });
                                        if (Array.isArray(cookies2)) return report(cookies2.map(c => `${c.name}=${c.value}`).join("; "));
                                        report("", { form: "GM_cookie.list", error: "回调未返回数组" });
                                    });
                                    return;
                                }
                            } catch (_) { /* 落到错误上报 */ }
                            report("", { form: "GM_cookie(action)", error: "回调未返回数组" });
                        });
                        return;
                    }
                    if (typeof GM !== "undefined" && GM && GM.cookie && typeof GM.cookie.list === "function") {
                        GM.cookie.list({ url }).then((cookies) => {
                            if (Array.isArray(cookies)) report(cookies.map(c => `${c.name}=${c.value}`).join("; "));
                            else report("", { form: "GM.cookie.list", error: "返回非数组" });
                        }).catch((e) => report("", { form: "GM.cookie.list", error: String((e && e.message) || e) }));
                        return;
                    }
                    report("", { form: "unavailable", error: "GM_cookie 不可用" });
                } catch (e) {
                    report("", { form: "exception", error: String((e && e.message) || e) });
                }
            });
        },

        randomRange(min, max) {
            return Math.floor(Math.random() * (max - min + 1) + min);
        },

        // 动态提取 next-action（discoverCards / 每日活动提取等 3 处共用，避免各自维护同一组正则）。
        // raw 为原始 HTML/RSC，fallback 为反斜杠转义后的版本（不同序列化格式命中不同分支）。
        // 命中即写入 RewardsAuto._nextAction 并返回，供 claimCard / Server Action 复用。
        extractNextAction(raw, fallback = "", label = "") {
            const naMatch = (raw && raw.match(/name":"next-action"[^}]*"value":"([a-f0-9]{40,})"/))
                || (raw && raw.match(/next-action["']\s*:\s*["']([a-f0-9]{40,})["']/))
                || (fallback && fallback.match(/"next-action"[^"]*"([a-f0-9]{40,})"/));
            if (naMatch) {
                RewardsAuto._nextAction = naMatch[1];
                Utils.log("🟢", `动态 next-action${label}: ${naMatch[1].slice(0, 12)}…`);
            }
            return naMatch ? naMatch[1] : null;
        },

        // 判定 Server Action 直连是否被边缘拦截（v4.2.0 抓包实证 2026-09-17）：
        // SW 直连 rewards 的 Server Action 一律 503 + Bing 边缘错误页 HTML；页面上下文
        // 同 payload、同 action ID 返回 200 + `1:true` 并真实入账（余额 +15 实测）。
        // 该形态是结构性拦截，与本轮 hash/ cookie 链 / payload 形状无关——据此跳过同轮
        // 冗余策略，转交页面侧《页面领取》脚本。
        isEdgeBlockedError(err) {
            const msg = String((err && err.message) || err || "");
            return /^HTTP 503/.test(msg) && /<!DOCTYPE html>|<html[\s>]/i.test(msg);
        },

        // 解析 earn flight 流中的可领取 offer 实时状态（2026-09-14 登录态抓包实证）：
        // offerId → {hash, isCompleted, isLocked, unlockCriteria}。卡片上报的 hash 必须
        // 用本次页面加载 flight 里的轮换值（服务端拒收与当次加载不一致的旧 hash）；
        // isCompleted=true 即已入账，isLocked=true（如 unlockCriteria:"rewardsApp"，
        // UI 显示"仅限积分商城应用"）表示网页端无领取资格。
        parseEarnLiveOffers(combined) {
            const map = {};
            if (!combined) return map;
            try {
                for (const obj of this.extractFlightObjects(combined, '"offerId"')) {
                    const id = obj && typeof obj.offerId === "string" ? obj.offerId : "";
                    if (!id || map[id]) continue;
                    map[id] = {
                        hash: typeof obj.hash === "string" ? obj.hash : "",
                        isCompleted: obj.isCompleted === true || obj.complete === true,
                        isLocked: obj.isLocked === true,
                        unlockCriteria: typeof obj.unlockCriteria === "string" ? obj.unlockCriteria : "",
                    };
                }
            } catch (_) {}
            return map;
        },

        // ====== RSC flight 流解析（2026-09 改版后 offer 数据存于 self.__next_f 分片） ======

        // 拼接 flight 分片：页面把 RSC 数据以 self.__next_f.push([1,"..."]) 的形式
        // 分片内嵌在 HTML 中，逐片 JSON 解码后拼接为完整流。无分片返回空串。
        concatFlightChunks(html) {
            if (!html || typeof html !== "string") return "";
            let combined = "";
            const pushRe = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g;
            for (const m of html.matchAll(pushRe)) {
                try { combined += JSON.parse(`"${m[1]}"`); } catch (_) { /* 单片损坏不影响其余 */ }
            }
            return combined;
        },

        // 从拼接流中提取所有包含 anchor 字段（如 '"offerId"'）的 JSON 对象。
        // 从 anchor 位置向前找最近的 "{"，做字符串感知的花括号配对后 JSON.parse；
        // 命中过浅（对象在 anchor 前已闭合）或解析失败时继续向前扩，与真实对象边界对齐。
        extractFlightObjects(combined, anchor) {
            const out = [];
            if (!combined || !anchor) return out;
            const anchorKey = anchor.replace(/^"|"$/g, "");
            let cursor = 0;
            for (;;) {
                const idx = combined.indexOf(anchor, cursor);
                if (idx === -1) break;
                cursor = idx + anchor.length;
                let start = combined.lastIndexOf("{", idx);
                while (start !== -1) {
                    let depth = 0, inStr = false, esc = false, end = -1;
                    for (let j = start; j < combined.length; j++) {
                        const c = combined[j];
                        if (esc) { esc = false; continue; }
                        if (inStr && c === "\\") { esc = true; continue; }
                        if (c === '"') { inStr = !inStr; continue; }
                        if (inStr) continue;
                        if (c === "{") depth++;
                        else if (c === "}") { depth--; if (depth === 0) { end = j; break; } }
                    }
                    if (end >= idx) {
                        try {
                            const parsed = JSON.parse(combined.slice(start, end + 1).replace(/"\$undefined"/g, "null"));
                            if (parsed && typeof parsed === "object" && anchorKey in parsed) {
                                out.push(parsed);
                                cursor = Math.max(cursor, end + 1);
                                break;
                            }
                        } catch (_) { /* 边界未对齐，继续向前扩 */ }
                    }
                    start = combined.lastIndexOf("{", start - 1);
                }
            }
            return out;
        },

        // 从 JS chunk 源码中提取带名称的 Server Action ID：新版构建把 action 注册为
        // createServerReference("<id>", callServer, …, "<actionName>")，id 随每次部署轮换。
        // 框架自身参数（callServer 等）不是 action 名，需排除；取最后一个候选串作为名称。
        extractNamedActionIds(js) {
            const byName = {};
            if (!js || typeof js !== "string") return byName;
            const knownNonNames = new Set(["callServer", "findSourceMapURL", "encodeFormAction", "default"]);
            const re = /createServerReference\s*\)?\s*\(\s*"([a-f0-9]{40,64})"([\s\S]{0,800}?)\)/g;
            for (const m of js.matchAll(re)) {
                const names = [...(m[2] || "").matchAll(/"([A-Za-z_$][\w$]*)"/g)]
                    .map(x => x[1])
                    .filter(n => !knownNonNames.has(n) && n.length > 3);
                if (names.length) byName[names[names.length - 1]] = m[1];
            }
            return byName;
        },

        // Server Action 请求的 Next-Router-State-Tree 头：2026-09 改版后服务端按此
        // 构建响应，缺失可能导致请求被拒绝。结构对齐真实浏览器请求：'(nav)' 路由组
        // + 叶子标记 __PAGE__ + 刷新标记 4096。segment 取自 POST 目标路径的首段
        // （dashboard/earn）。
        routerStateTree(url = "https://rewards.bing.com/dashboard") {
            const refreshFlag = 4096;
            let segment = "dashboard";
            try {
                const pathname = new URL(url).pathname.replace(/\/+$/, "");
                const tail = pathname.split("/").pop();
                if (tail) segment = tail;
            } catch (_) {}
            const tree = [
                "",
                {
                    children: [
                        "(nav)",
                        {
                            children: [
                                segment,
                                { children: ["__PAGE__", {}, null, null, refreshFlag] },
                                null,
                                null,
                                refreshFlag
                            ]
                        },
                        null,
                        null,
                        refreshFlag
                    ]
                },
                null,
                null,
                refreshFlag + 16
            ];
            return encodeURIComponent(JSON.stringify(tree));
        },

        // Fisher–Yates 原地洗牌：每种排列等概率，
        // 替代有偏的 sort(() => Math.random() - 0.5)
        shuffle(arr) {
            for (let i = arr.length - 1; i > 0; i--) {
                const j = this.randomRange(0, i);
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
            return arr;
        },

        getTimestamp() {
            return Date.now();
        },

        // 日期拆解：getTodayNum/getTodayStr/dateKeysFromRunDay 共用
        dateParts(date = new Date()) {
            return { y: date.getFullYear(), mo: date.getMonth() + 1, d: date.getDate() };
        },

        getTodayNum() {
            const { y, mo, d } = this.dateParts();
            return Number(`${y}${String(mo).padStart(2,"0")}${String(d).padStart(2,"0")}`);
        },

        getTodayStr() {
            const { y, mo, d } = this.dateParts();
            return `${mo}/${d}/${y}`;
        },

        // 东经偏移分钟数（中国 UTC+8 返回 "480"）。旧版 cn.bing.com 上报接口的
        // timeZone/timezoneOffset 使用此约定（实测抓包）。
        getTimezoneOffset() {
            return String(-new Date().getTimezoneOffset());
        },

        // JS 原始时区偏移（中国 UTC+8 返回 "-480"）。新版 Next.js Server Action 的
        // timezoneOffset 来自浏览器 client 代码的 new Date().getTimezoneOffset()，
        // 必须使用原始符号，与服务端按 (UTC - offset) 计算本地日期的约定一致。
        jsTimezoneOffset() {
            return String(new Date().getTimezoneOffset());
        },

        // 从运行起始日期（YYYYMMDD 数字）生成服务端日期键（MM/DD/YYYY 两种格式），
        // 供 dailySetPromotions 按日查找。整轮运行必须使用同一"今天"基准（dateNowNum），
        // 避免跨午夜时标记日期与数据查询日期错位导致重复处理。
        dateKeysFromRunDay(runDay) {
            let y, mo, d;
            if (runDay > 0) {
                y = Math.floor(runDay / 10000);
                mo = Math.floor((runDay % 10000) / 100);
                d = runDay % 100;
            } else {
                ({ y, mo, d } = this.dateParts());
            }
            return [
                `${String(mo).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`,
                `${mo}/${d}/${y}`
            ];
        },

        // flight offer 的 date 字段（MM/DD/YYYY）转 yyyymmdd 数字；无效/缺失返回 0
        flightDateToNum(raw) {
            if (typeof raw !== "string") return 0;
            const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
            if (!m) return 0;
            return Number(`${m[3]}${m[1]}${m[2]}`);
        },

        getRandomUUID() {
            // 优先使用 crypto.randomUUID；不可用（旧浏览器/非安全上下文）时回退到手动拼接
            try {
                if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
                    return crypto.randomUUID().replace(/-/g, "").toUpperCase();
                }
            } catch (_) {}
            const hex = "0123456789ABCDEF";
            let uuid = "";
            for (let i = 0; i < 32; i++) {
                uuid += hex[Math.floor(Math.random() * 16)];
            }
            return uuid;
        },

        isJSON(s) {
            try { const j = JSON.parse(s); return Array.isArray(j) || (typeof j === "object" && j !== null); }
            catch { return false; }
        },

        delay(ms) {
            return new Promise(r => setTimeout(r, ms));
        },

        // 防封号核心：所有操作间必须使用随机延迟
        randomDelay(min = 3000, max = 8000) {
            return this.delay(this.randomRange(min, max));
        },

        waitForElementsByText(containerSelector, textPatterns, timeout = 30000) {
            return new Promise((resolve) => {
                const findElements = () => {
                    const containers = document.querySelectorAll(containerSelector);
                    const results = [];
                    for (const container of containers) {
                        const text = container.textContent || "";
                        for (const pattern of textPatterns) {
                            if (text.includes(pattern)) {
                                results.push({ element: container, pattern });
                                break;
                            }
                        }
                    }
                    return results;
                };

                if (typeof document === "undefined" || !document.body) return resolve([]);
                const found = findElements();
                if (found.length > 0) return resolve(found);

                const observer = new MutationObserver(() => {
                    const matched = findElements();
                    if (matched.length > 0) { observer.disconnect(); resolve(matched); }
                });
                observer.observe(document.body, { childList: true, subtree: true });

                setTimeout(() => {
                    observer.disconnect();
                    resolve(findElements());
                }, timeout);
            });
        },

        // ====== 按运行周期的只读请求缓存 ======
        // crontab 每 20 分钟一轮，单轮内 earn/dashboard/getuserinfo/DAPI-me 会被
        // 多个任务反复抓取（earn 最多 5 次、dashboard 最多 5 次），几分钟内页面
        // 内容不会变化。缓存键绑定运行起始日期：同一轮共享，次日（及每个新进程）
        // 自动失效。仅用于"读取状态"的 GET 请求；上报/复查路径用 fresh:true 强制刷新。
        _pageCache: new Map(),

        async fetchPage(options, { fresh = false } = {}) {
            const key = `${options.url}|${options._cacheKey || ""}|${RewardsAuto.state.dateNowNum}`;
            if (!fresh) {
                const hit = this._pageCache.get(key);
                if (hit !== undefined) return hit;
            }
            const { _cacheKey, ...rest } = options;
            const promise = this.xhr(rest);
            try {
                const result = await promise;
                this._pageCache.set(key, result);
                return result;
            } catch (e) {
                this._pageCache.delete(key); // 失败不缓存，下次调用自动重试
                throw e;
            }
        },

        // fetchPage + JSON 解析，解析失败返回 null（与 _getUserInfo 语义一致）
        async fetchJson(options, fetchOpts) {
            const text = await this.fetchPage(options, fetchOpts);
            if (!text || !this.isJSON(text)) return null;
            try { return JSON.parse(text); } catch (_) { return null; }
        }
    };

    const API = {
        async getToken(tokenParams, maxRetries = 3) {
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const data = tokenParams instanceof URLSearchParams
                        ? tokenParams.toString()
                        : new URLSearchParams(tokenParams).toString();
                    const res = await Utils.xhr({
                        method: "POST",
                        url: "https://login.live.com/oauth20_token.srf",
                        headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
                        data
                    });
                    if (!Utils.isJSON(res)) {
                        if (attempt < maxRetries) {
                            await Utils.delay(3210);
                            continue;
                        }
                        return false;
                    }
                    const tokenData = JSON.parse(res);
                    if (tokenData.error) {
                        Utils.log("🔴", `Token错误: ${tokenData.error} - ${tokenData.error_description || ''}`);
                        if (["invalid_grant","invalid_request"].includes(tokenData.error)) {
                            GM_setValue("Config.token", false);
                            GM_setValue("Config.code", "");
                        }
                        return false;
                    }
                    if (tokenData.refresh_token && tokenData.access_token) {
                        GM_setValue("Config.token", tokenData.refresh_token);
                        GM_setValue("Config.tokenTime", Utils.getTimestamp());
                        RewardsAuto.state.token = tokenData.access_token;
                        return true;
                    }
                    if (attempt < maxRetries) {
                        await Utils.delay(3210);
                        continue;
                    }
                    return false;
                } catch (e) {
                    if (e.message.includes("400") || e.message.includes("401")) {
                        GM_setValue("Config.token", false);
                        GM_setValue("Config.code", "");
                        return false;
                    }
                    if (attempt < maxRetries) {
                        await Utils.delay(3210);
                        continue;
                    }
                    Utils.log("🔴", `Token请求失败: ${e.message}`);
                    return false;
                }
            }
            return false;
        },

        // 401 自动刷新 Token 并重试
        async withTokenRetry(requestFn) {
            let token = RewardsAuto.state.token;
            if (!token) return null;
            try {
                return await requestFn(token);
            } catch (e) {
                if (e.message && e.message.includes("401")) {
                    Utils.log("🟡", "访问 Token 过期，尝试使用刷新 Token 续期...");
                    RewardsAuto.state.token = null;
                    const refreshed = await this.renewToken();
                    if (!refreshed) return null;
                    return await requestFn(RewardsAuto.state.token);
                }
                throw e;
            }
        },

        // ====== 通用请求辅助（消除 DAPI / getuserinfo 重复样板） ======

        // 解析请求区域：锁定中国区或跟随账号区域
        _resolveRegion() {
            return GM_getValue("Config.lock", true) ? "cn" : RewardsAuto.state.region.toLowerCase();
        },

        // 生成 64 位活动 ID（两段 UUID 去连字符拼接，匹配 App 实际上报格式）
        _genActivityId() {
            return Utils.getRandomUUID() + Utils.getRandomUUID().slice(0, 32);
        },

        // 统一的 DAPI 请求：自动携带 App 端鉴权头、Token 失效重试，返回原始响应文本
        async _dapiRequest({ path = "/me/activities", method = "POST", body = null, region = null, extraHeaders = {} }) {
            const country = region || this._resolveRegion();
            return this.withTokenRetry(token => Utils.xhr({
                method,
                url: `https://prod.rewardsplatform.microsoft.com/dapi${path}`,
                headers: {
                    "content-type": "application/json; charset=UTF-8",
                    "user-agent": RewardsAuto.ua.app,
                    "authorization": `Bearer ${token}`,
                    "x-rewards-appid": RewardsAuto.appConfig.rewardsAppId,
                    "x-rewards-ismobile": "true",
                    "x-rewards-country": country,
                    "x-rewards-language": "zh",
                    ...extraHeaders
                },
                data: body ? JSON.stringify(body) : undefined
            }));
        },

        // 统一的 getuserinfo 请求（无需 Token），解析失败返回 null。
        // 2026-09 改版后旧接口偶发 401/非 JSON（页面 GET 正常而 API 被拒），
        // 失败时回退新版 Bing flyout 接口并归一化为旧 dashboard 结构。
        async _getUserInfo(fetchOpts) {
            try {
                // _ 参数绑定运行起始日期：轮内恒定（fetchPage 可命中缓存），
                // 跨轮次变化（破坏 CDN 缓存）。若用时间戳则缓存键每次都不同。
                const guHeaders = {
                    "user-agent": RewardsAuto.ua.pc,
                    "referer": "https://rewards.bing.com/",
                    "origin": "https://rewards.bing.com",
                    "x-requested-with": "XMLHttpRequest"
                };
                const cookie = await Utils.cookieHeaderFor("https://rewards.bing.com/api/getuserinfo");
                if (cookie) guHeaders.cookie = cookie;
                const data = await Utils.fetchJson({
                    url: "https://rewards.bing.com/api/getuserinfo?type=1&X-Requested-With=XMLHttpRequest&_=" + RewardsAuto.state.dateNowNum,
                    headers: guHeaders
                }, fetchOpts);
                if (data && (data.dashboard || data.userStatus)) return data;
            } catch (_) {}
            const flyout = await this._getFlyoutUserInfo(fetchOpts);
            if (flyout) {
                Utils.log("🟡", "getuserinfo 不可用，已回退 Bing flyout 接口");
            }
            return flyout;
        },

        // 新版 Bing flyout 用户数据（站点改版后的替代数据源，TheNetsky v4 同款），
        // 归一化为旧 getuserinfo 的 dashboard 结构，供每日活动/搜索配额/活动卡片共用。
        async _getFlyoutUserInfo(fetchOpts) {
            try {
                const data = await Utils.fetchJson({
                    url: "https://www.bing.com/rewards/panelflyout/getuserinfo?channel=BingFlyout&partnerId=BingRewards",
                    headers: {
                        "user-agent": RewardsAuto.ua.pc,
                        "referer": "https://www.bing.com/",
                        "accept": "application/json"
                    }
                }, fetchOpts);
                if (!data || data.isError || data.errorMessage) return null;
                const ui = data.userInfo || {};
                const flyout = data.flyoutResult || {};
                const status = flyout.userStatus || {};
                if (!status.isRewardsUser && !ui.isRewardsUser) return null;
                const rawCounters = status.counters || {};
                const counters = {
                    pcSearch: rawCounters.PCSearch ?? rawCounters.pcSearch ?? [],
                    mobileSearch: rawCounters.MobileSearch ?? rawCounters.mobileSearch ?? [],
                    activityAndQuiz: rawCounters.ActivityAndQuiz ?? rawCounters.activityAndQuiz ?? [],
                    dailyPoint: rawCounters.DailyPoint ?? rawCounters.dailyPoint ?? []
                };
                return {
                    dashboard: {
                        dailySetPromotions: flyout.dailySetPromotions || {},
                        morePromotions: flyout.morePromotions || [],
                        activityAndQuiz: flyout.activityAndQuiz || [],
                        userStatus: {
                            ...status,
                            isRewardsUser: true,
                            availablePoints: Number.isFinite(Number(status.availablePoints))
                                ? Number(status.availablePoints) : (Number(ui.balance) || 0),
                            counters
                        }
                    },
                    profile: ui.profile || null
                };
            } catch (_) {
                return null;
            }
        },

        // ====== 新版 Server Action ID 解析（2026-09 改版） ======
        // 站点改为 Next.js 新构建后，action ID 随每次部署轮换且不再出现在页面
        // flight 流中。改为扫描 /earn 与 /dashboard 引用的公开 JS chunk，解析
        // createServerReference(..., "reportActivity") 得到当前有效的 action ID。
        // 返回 { urls, dpl }：dpl 为页面引用的部署 ID（chunk 查询参数），供跨轮缓存。
        async _collectActionChunkUrls() {
            const urls = new Set();
            let dpl = null;
            for (const pageUrl of ["https://rewards.bing.com/earn", "https://rewards.bing.com/dashboard"]) {
                try {
                    // fetchPage 轮内缓存：这两个页面本轮多半已被其他任务抓取，零额外开销
                    const html = await Utils.fetchPage({ url: pageUrl, headers: { "user-agent": RewardsAuto.ua.pc } });
                    if (!html) continue;
                    // flight 分片内的路径以 \/ 与 \u0026 转义，先还原再匹配；
                    // 保留 ?dpl= 部署参数，确保拿到与页面同一部署的 chunk
                    const unescaped = html.replace(/\\\//g, "/").replace(/\\u0026/gi, "&");
                    if (!dpl) {
                        const dm = unescaped.match(/[?&]dpl=([A-Za-z0-9._-]+)/);
                        if (dm) dpl = dm[1];
                    }
                    for (const m of unescaped.matchAll(/(?:\/_next\/)?static\/(?:chunks|immutable|media)\/[\w\-./()%]+?\.js(?:\?[^\s"'<>\\]*)?/g)) {
                        urls.add(new URL(m[0], "https://rewards.bing.com").toString());
                    }
                } catch (_) { /* 单页失败不阻断 */ }
            }
            return { urls: [...urls], dpl };
        },

        async _resolveReportActivityActionId() {
            if (RewardsAuto.state.reportActionId) return RewardsAuto.state.reportActionId;
            let chunkUrls = [], dpl = null;
            try {
                ({ urls: chunkUrls, dpl } = await this._collectActionChunkUrls());
            } catch (_) {}
            // 跨轮持久缓存：部署 ID（dpl）一致则同一构建，action ID 必然相同，
            // 直接复用以免每轮 cron 都重复扫描 chunk（每轮最多 16 个 GET）。
            const cached = GM_getValue("Config.reportAction", null);
            if (dpl && cached && cached.dpl === dpl && /^[a-f0-9]{40,64}$/.test(String(cached.id || ""))) {
                RewardsAuto.state.reportActionId = cached.id;
                RewardsAuto._nextAction = cached.id;
                Utils.log("🟢", `命中 action ID 缓存(dpl=${dpl}): ${cached.id.slice(0, 12)}…`);
                return cached.id;
            }
            // 顺序扫描、命中即停，限制单轮最多抓 16 个 chunk 控制流量
            for (const url of chunkUrls.slice(0, 16)) {
                try {
                    const js = await Utils.fetchPage({ url, headers: { "user-agent": RewardsAuto.ua.pc } });
                    const byName = Utils.extractNamedActionIds(js);
                    if (byName.reportActivity) {
                        RewardsAuto.state.reportActionId = byName.reportActivity;
                        RewardsAuto._nextAction = byName.reportActivity; // 旧路径同步受益
                        if (dpl) GM_setValue("Config.reportAction", { dpl, id: byName.reportActivity });
                        Utils.log("🟢", `动态 reportActionId(dpl=${dpl || "?"}): ${byName.reportActivity.slice(0, 12)}…`);
                        return byName.reportActivity;
                    }
                } catch (_) { /* 单个 chunk 失败不阻断 */ }
            }
            Utils.log("🟡", "未能从 JS chunk 解析 reportActivity ID，将使用兜底值");
            return null;
        },

        async renewToken() {
            if (!GM_getValue("Tasks.sign", true) && !GM_getValue("Tasks.read", true)) return true;

            const authUrl = "https://login.live.com/oauth20_authorize.srf?client_id=0000000040170455&response_type=code&scope=service::prod.rewardsplatform.microsoft.com::MBI_SSL&redirect_uri=https://login.live.com/oauth20_desktop.srf";
            // @crontab 运行环境（service_worker/sandbox）无微软登录 Cookie，自动获取授权码
            // 必然失败，直接跳过。注意 ScriptCat 的 crontab 可能在 sandbox 页面里执行且带
            // document——只判 typeof document 会把后台误判为前台，故以主机名是否为 bing 系为准。
            const isBackground = typeof document === "undefined" || !/(^|\.)bing\.com$/.test(location.hostname || "");

            // 获取授权码：前台先尝试自动重定向捕获；后台/失败时打开授权页等待用户手动完成
            const fetchCode = async (msg) => {
                Utils.log("🟡", `${msg}，尝试获取授权码...`);

                // 优先检查用户是否已提前粘贴授权码（脚本设置或授权页自动捕获），有则直接用，不清空
                const existing = GM_getValue("Config.code", "");
                if (existing) {
                    let code = null;
                    if (existing.includes("code=")) {
                        try { code = new URL(existing).searchParams.get("code"); } catch {}
                    }
                    if (!code && existing.length > 20 && !existing.includes("http")) {
                        code = existing.trim();
                    }
                    if (code && code.length > 10) {
                        Utils.log("🟢", "检测到已保存的授权码，直接使用");
                        return code;
                    }
                }

                // 无有效授权码，清空残留值后等待用户输入
                GM_setValue("Config.code", "");

                if (!isBackground) {
                    try {
                        const res = await new Promise((resolve, reject) => {
                            GM_xmlhttpRequest({
                                method: "GET",
                                url: authUrl,
                                headers: { "User-Agent": navigator.userAgent },
                                onload: (r) => resolve(r),
                                onerror: () => reject(new Error("请求失败")),
                                ontimeout: () => reject(new Error("超时")),
                                timeout: 8000
                            });
                        });
                        const code = new URL(res.finalUrl || "").searchParams.get("code");
                        if (code) {
                            Utils.log("🟢", "自动获取授权码成功");
                            return code;
                        }
                    } catch (e) {
                        Utils.log("🟡", `自动获取失败: ${e.message}`);
                    }
                } else {
                    Utils.log("🟡", "后台模式无登录态，跳过自动获取");
                }

                Utils.log("🟡", "请手动完成授权...");
                try { GM_openInTab(authUrl, { active: true, insert: true }); } catch(_) {}

                if (GM_getValue("Notice.bro", true)) {
                    try {
                        GM_notification({
                            text: "完成后粘贴地址栏URL到脚本设置的「授权码链接」",
                            title: "🟡 需要授权", timeout: 0
                        });
                    } catch(_) {}
                }

                // 等待用户粘贴或授权页自动捕获授权码（最长 90 秒，避免 crontab 超时被终止）
                for (let i = 0; i < 90; i++) {
                    await Utils.delay(1000);
                    const raw = GM_getValue("Config.code", "");
                    if (!raw) continue;

                    let code = null;
                    if (raw.includes("code=")) {
                        try { code = new URL(raw).searchParams.get("code"); } catch {}
                    }
                    if (!code && raw.length > 20 && !raw.includes("http")) {
                        code = raw.trim();
                    }
                    if (code && code.length > 10) {
                        Utils.log("🟢", "授权码获取成功");
                        return code;
                    }
                }
                Utils.log("🔴", "授权码获取超时", true);
                return null;
            };

            // 改为循环（原递归会丢弃刚获取的授权码，导致用户需重复授权）
            for (let attempt = 0; attempt < 3; attempt++) {
                let refreshToken = GM_getValue("Config.token", false);
                const tokenTime = GM_getValue("Config.tokenTime", 0);

                // Token 超过 7 天记录日志（仍用 refresh_token 续期；微软 refresh_token 有效期 90 天，
                // 续期成功后 tokenTime 会刷新，无需强制走授权码流程）
                if (tokenTime > 0) {
                    const days = (Utils.getTimestamp() - tokenTime) / (1000 * 60 * 60 * 24);
                    if (days > 7) {
                        Utils.log("🟡", `Token已${Math.floor(days)}天，尝试续期`);
                    }
                }

                if (refreshToken) {
                    // 优先用 refresh_token 续期
                    const params = {
                        client_id: "0000000040170455",
                        refresh_token: refreshToken,
                        scope: "service::prod.rewardsplatform.microsoft.com::MBI_SSL",
                        grant_type: "refresh_token"
                    };
                    if (await this.getToken(params)) {
                        // v3.6.9：refresh 成功时不再清空 Config.code——本轮根本没用到授权码，
                        // 清掉只会把用户刚手动粘贴的新凭证丢掉（"更新了授权码却还是被清"）。
                        // 授权码仅在真正完成换取后清理（见下方换取路径）。
                        Utils.log("🟢", "Token续期成功");
                        return true;
                    }
                    // 续期失败，清除 token，下轮改用授权码
                    GM_setValue("Config.token", false);
                    continue;
                }

                // 无 refreshToken，通过授权码换取 token
                const code = await fetchCode(attempt === 0 ? "需要授权码" : "上次授权码已失效，请重新授权");
                if (!code) return false;

                const params = {
                    client_id: "0000000040170455",
                    code,
                    redirect_uri: "https://login.live.com/oauth20_desktop.srf",
                    grant_type: "authorization_code"
                };
                if (await this.getToken(params)) {
                    // 一次性授权码已消费，及时清理明文残留
                    GM_setValue("Config.code", "");
                    Utils.log("🟢", "Token获取成功！", true);
                    return true;
                }
                // 授权码失效，清除后下轮重新获取
                GM_setValue("Config.token", false);
                GM_setValue("Config.code", "");
            }

            Utils.log("🔴", "Token 多次获取失败，请检查账号授权状态", true);
            return false;
        },

        // 优先从 earn 页面“今日积分”表格解析，DAPI 只做兜底
        async getRewardsInfo(maxRetries = 3, { fresh = false } = {}) {
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const html = await Utils.fetchPage({ url: "https://rewards.bing.com/earn" }, { fresh });
                    const clean = html.replace(/\\"/g, '"');
                    
                    // 尝试从Next.js RSC数据中解析
                    let balance = 0;
                    let pcMax = 60, pcCur = 0, mobMax = 0, mobCur = 0;
                    let dailyOffer = 0;
                    let searchQuotaFound = false;
                    
                    // 从 RSC JSON 数据中解析 pointsCounters（兼容有/无 mobile 字段、不同字段顺序）
                    const pcIdx = clean.indexOf('"pointsCounters":{');
                    if (pcIdx !== -1) {
                        let start = pcIdx + 17, depth = 0, end = start;
                        for (let i = start; i < clean.length && i < start + 500; i++) {
                            if (clean[i] === '{') depth++;
                            if (clean[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
                        }
                        try {
                            const pts = JSON.parse(clean.substring(start, end));
                            pcMax = pts.pc?.max ?? 60;
                            pcCur = pts.pc?.progress ?? 0;
                            mobMax = pts.mobile?.max ?? 0;
                            mobCur = pts.mobile?.progress ?? 0;
                            dailyOffer = pts.dailyOffer ?? 0;
                            searchQuotaFound = Number(pts.pc?.max) > 0;
                            if (pts.totalPoints != null) balance = Number(pts.totalPoints);
                        } catch {}
                    }

                    // 补充获取 balance
                    if (balance === 0) {
                        const balMatch = clean.match(/"balance":(\d+)/) || clean.match(/"availablePoints":(\d+)/);
                        if (balMatch) balance = parseInt(balMatch[1]);
                    }

                    // 解析今日积分明细
                    const todayDetails = [];
                    
                    // 从RSC数据中解析活动卡片（括号深度匹配，兼容嵌套数组）
                    const acIdx = clean.indexOf('"activityCards":[');
                    if (acIdx !== -1) {
                        let acStart = acIdx + 16, acDepth = 0, acEnd = acStart;
                        for (let i = acStart; i < clean.length && i < acStart + 5000; i++) {
                            if (clean[i] === '[') acDepth++;
                            if (clean[i] === ']') { acDepth--; if (acDepth === 0) { acEnd = i + 1; break; } }
                        }
                        try {
                            const cardsStr = clean.substring(acStart, acEnd);
                            const cardRegex = /"title":"([^"]+)".*?"points":(\d+).*?"isCompleted":(true|false)/g;
                            let cardMatch;
                            while ((cardMatch = cardRegex.exec(cardsStr)) !== null) {
                                const title = cardMatch[1];
                                const points = parseInt(cardMatch[2]);
                                const isCompleted = cardMatch[3] === "true";
                                if (points > 0 && isCompleted) {
                                    todayDetails.push({ title, points });
                                }
                            }
                        } catch {}
                    }
                    
                    // 方法2: 从HTML中解析搜索进度
                    const toNum = value => parseInt(String(value).replace(/,/g, ''), 10) || 0;
                    const searchRowMatch = clean.match(/<p>\s*必应搜索\s*<\/p>\s*<\/div>\s*<div(?=[^>]*justify-self-end)[^>]*>([\s\S]{0,500}?)<\/div>/i);
                    const searchHtmlMatch = searchRowMatch
                        ? (searchRowMatch[1].match(/<span[^>]*>([\d,]+)<\/span>\s*<span[^>]*>\s*\/\s*([\d,]+)\s*<\/span>/i)
                            || searchRowMatch[1].match(/([\d,]+)\s*\/\s*([\d,]+)/))
                        : null;
                    if (searchHtmlMatch) {
                        pcCur = toNum(searchHtmlMatch[1]);
                        pcMax = toNum(searchHtmlMatch[2]);
                        searchQuotaFound = pcMax > 0;
                        todayDetails.push({ 
                            title: '必应搜索', 
                            points: pcCur,
                            max: pcMax
                        });
                        Utils.log("🔍", `页面表格配额: PC ${pcCur}/${pcMax}`);
                    }
                    
                    // 方法3: 从RSC数据中解析搜索进度
                    const searchRscMatch = clean.match(/"combinedSearch":\{[^}]*"progress":(\d+)[^}]*"max":(\d+)/);
                    if (searchRscMatch && !todayDetails.some(d => d.title === '必应搜索')) {
                        pcCur = toNum(searchRscMatch[1]);
                        pcMax = toNum(searchRscMatch[2]);
                        searchQuotaFound = pcMax > 0;
                        todayDetails.push({
                            title: '必应搜索',
                            points: pcCur,
                            max: pcMax
                        });
                    }
                    
                    // 添加dailyOffer到今日明细
                    if (dailyOffer > 0) {
                        todayDetails.push({ title: '优惠', points: dailyOffer });
                    }
                    
                    // 匹配其他活动（如"优惠"）
                    const otherActivityRegex = /<p>([^<]+)<\/p><\/div><div[^>]*>(\d+)<\/div>/g;
                    let otherMatch;
                    while ((otherMatch = otherActivityRegex.exec(clean)) !== null) {
                        const title = otherMatch[1];
                        const points = parseInt(otherMatch[2]);
                        if (points > 0 && !todayDetails.some(d => d.title === title)) {
                            todayDetails.push({ title, points });
                        }
                    }

                    // 解析历史积分
                    const history = {
                        month: 0,
                        year: 0,
                        lifetime: 0
                    };
                    
                    // 方法1: 从RSC数据中解析历史积分
                    const historyRscMatch = clean.match(/"pointsHistory":\{[^}]*"thisMonth":\{"earn":(\d+)[^}]*"thisYear":\{"earn":(\d+)[^}]*"lifetime":\{"earn":(\d+)/);
                    if (historyRscMatch) {
                        history.month = parseInt(historyRscMatch[1]);
                        history.year = parseInt(historyRscMatch[2]);
                        history.lifetime = parseInt(historyRscMatch[3]);
                    } else {
                        // 方法2: 从HTML中解析历史积分
                        const monthHtmlMatch = clean.match(/本月.*?(\d[\d,]*)<\/div>/);
                        const yearHtmlMatch = clean.match(/今年.*?(\d[\d,]*)<\/div>/);
                        const lifetimeHtmlMatch = clean.match(/生存期.*?(\d[\d,]*)<\/div>/);
                        
                        // JSON格式
                        const monthJsonMatch = clean.match(/"monthlyPoints":(\d+)/);
                        const yearJsonMatch = clean.match(/"yearlyPoints":(\d+)/);
                        const lifetimeJsonMatch = clean.match(/"lifetimePoints":(\d+)/);
                        
                        if (monthHtmlMatch) {
                            history.month = parseInt(monthHtmlMatch[1].replace(/,/g, ''));
                        } else if (monthJsonMatch) {
                            history.month = parseInt(monthJsonMatch[1]);
                        }
                        
                        if (yearHtmlMatch) {
                            history.year = parseInt(yearHtmlMatch[1].replace(/,/g, ''));
                        } else if (yearJsonMatch) {
                            history.year = parseInt(yearJsonMatch[1]);
                        }
                        
                        if (lifetimeHtmlMatch) {
                            history.lifetime = parseInt(lifetimeHtmlMatch[1].replace(/,/g, ''));
                        } else if (lifetimeJsonMatch) {
                            history.lifetime = parseInt(lifetimeJsonMatch[1]);
                        }
                    }

                    if (!searchQuotaFound) {
                        const userInfoResult = await this.getSearchQuotaFromUserInfo();
                        if (userInfoResult) {
                            Utils.log("🟢", "页面未命中搜索配额，使用 getuserinfo 兜底");
                            return userInfoResult;
                        }
                    }

                    if (!searchQuotaFound && RewardsAuto.state.token) {
                        const apiResult = await this.getSearchQuotaFromAPI();
                        if (apiResult) {
                            Utils.log("🟢", "页面未命中搜索配额，使用 DAPI 兜底");
                            return apiResult;
                        }
                    }
                    
                    // 补充阅读进度（仅在有 token 时查询，避免无谓的告警日志）
                    let readProgress = 0, readMax = 30;
                    if (RewardsAuto.state.token) {
                        try {
                            const readInfo = await this.getReadProgress({ fresh });
                            if (readInfo) {
                                readProgress = readInfo.progress;
                                readMax = readInfo.max;
                            }
                        } catch (e) {}
                    }
                    
                    return {
                        balance,
                        pc: { progress: pcCur, max: pcMax },
                        mobile: { progress: mobCur, max: mobMax },
                        readProgress,
                        readMax,
                        dailyOffer,
                        todayDetails,
                        history
                    };
                } catch (e) {
                    if (attempt < maxRetries) {
                        await Utils.delay(3210);
                        continue;
                    }
                    Utils.log("🔴", `仪表盘获取失败: ${e.message}`);
                    return false;
                }
            }
            return false;
        },

        async signApp() {
            const region = this._resolveRegion();
            try {
                const res = await this._dapiRequest({
                    region,
                    extraHeaders: { "x-rewards-partnerid": "startapp", "x-rewards-flights": "rwgobig" },
                    body: {
                        amount: 1,
                        id: this._genActivityId(),
                        type: 103,
                        country: region,
                        channel: RewardsAuto.appConfig.channel
                    }
                });
                if (Utils.isJSON(res)) {
                    const data = JSON.parse(res);
                    const response = data.response || {};
                    if (response.activity) return Number(response.activity.p || response.activity.points || 0);
                    if (response.isDuplicate || response.activity === null) return 0;
                    Utils.log("🟡", `App签入响应未确认: ${String(res).slice(0, 120)}`);
                }
            } catch (e) {
                Utils.log("🔴", `App签入失败: ${e.message}`);
            }
            return -1;
        },

        async getRequestVerificationToken(pageUrl = "https://rewards.bing.com/") {
            // 默认 rewards 首页复用带缓存的 getRewardsToken，避免重复请求
            if (pageUrl === "https://rewards.bing.com/") {
                const token = await this.getRewardsToken();
                return token || "";
            }
            try {
                const html = await Utils.xhr({
                    url: pageUrl,
                    headers: {
                        "user-agent": RewardsAuto.ua.pc,
                        "referer": "https://rewards.bing.com/"
                    },
                    anonymous: false
                });
                const tokenMatch = html.match(/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/i)
                    || html.match(/RequestVerificationToken.*?value=["']([^"']+)["']/i)
                    || html.match(/"verificationToken"\s*:\s*"([^"]+)"/i)
                    || html.match(/"__RequestVerificationToken"\s*:\s*"([^"]+)"/i);
                return tokenMatch ? tokenMatch[1].replace(/&amp;/g, "&") : "";
            } catch (e) {
                Utils.log("🟡", `活动Token获取失败: ${e.message}`);
                return "";
            }
        },

        async reportActivity(offerId, hash, referer = "https://rewards.bing.com/") {
            const token = await this.getRequestVerificationToken(referer);
            const params = new URLSearchParams({
                id: offerId,
                hash: hash || "1",
                activityAmount: "1"
            });
            if (token) params.set("__RequestVerificationToken", token);

            const headers = {
                "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                "user-agent": RewardsAuto.ua.pc,
                "referer": referer,
                "origin": "https://rewards.bing.com",
                "x-requested-with": "XMLHttpRequest"
            };
            if (token) headers["RequestVerificationToken"] = token;
            // 显式 Cookie 头：同 Server Action，SW 子请求不自动携带 SameSite 登录 cookie
            const cookie = await Utils.cookieHeaderFor("https://rewards.bing.com/api/reportactivity");
            if (cookie) headers.cookie = cookie;

            try {
                return await Utils.xhr({
                    method: "POST",
                    url: "https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest",
                    headers,
                    data: params.toString(),
                    anonymous: false
                });
            } catch (e) {
                // HTTP 400：该活动类型（如 Gamification_DailySet）不被 reportactivity 接口支持，属预期，静默返回
                if (e.message && e.message.includes("400")) return false;
                throw e;
            }
        },

        // 每日活动上报：通过 reportActivity API 完成（匹配浏览器行为）
        async reportDailyActivity(searchUrl) {
            try {
                const fullUrl = searchUrl.startsWith("http") ? searchUrl : `https://cn.bing.com${searchUrl}`;
                const urlObj = new URL(fullUrl);
                const sp = urlObj.searchParams;
                const ig = Utils.getRandomUUID().replace(/-/g, '').substring(0, 32).toUpperCase();

                // cn.bing.com 版本的 URL（用作 referer 和 body url）
                const cnUrl = fullUrl.replace(/^https?:\/\/www\.bing\.com/, "https://cn.bing.com")
                                     .replace(/^https:\/\/bing\.com/, "https://cn.bing.com");
                const cnUrlObj = new URL(cnUrl);
                const cnSp = cnUrlObj.searchParams;

                // 构建 reportActivity 查询参数（匹配浏览器抓包：IID=commerce.5067，不含 ajaxreq）
                const reportParams = new URLSearchParams();
                reportParams.set("IG", ig);
                reportParams.set("IID", "commerce.5067");
                if (cnSp.get("form")) reportParams.set("form", cnSp.get("form"));
                if (cnSp.get("ocid") || cnSp.get("OCID")) reportParams.set("ocid", cnSp.get("ocid") || cnSp.get("OCID"));
                if (cnSp.get("rnoreward")) reportParams.set("rnoreward", cnSp.get("rnoreward"));

                // 步骤1: GET 加载活动页面（服务器记录访问）
                try {
                    await Utils.xhr({
                        method: "GET",
                        url: cnUrl,
                        headers: {
                            "user-agent": RewardsAuto.ua.pc,
                            "referer": "https://rewards.bing.com/",
                            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
                        }
                    });
                } catch (_) {}

                // 步骤2: 发送 ncheader（匹配浏览器的预请求）
                const ncheaderParams = new URLSearchParams();
                ncheaderParams.set("ver", String(Date.now()).substring(0, 8));
                ncheaderParams.set("IID", "commerce.5057");
                ncheaderParams.set("IG", ig);
                try {
                    await Utils.xhr({
                        method: "POST",
                        url: `https://cn.bing.com/rewardsapp/ncheader?${ncheaderParams.toString()}`,
                        headers: {
                            "content-type": "application/x-www-form-urlencoded",
                            "user-agent": RewardsAuto.ua.pc,
                            "referer": cnUrl,
                            "origin": "https://cn.bing.com",
                            "accept": "*/*",
                            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
                        },
                        data: "wb=1;i=1;v=1"
                    });
                } catch (_) { /* ncheader 失败不阻断 */ }

                // 步骤3: 发送 reportActivity
                const bodyParams = new URLSearchParams();
                bodyParams.set("url", cnUrl);
                bodyParams.set("V", "web");

                await Utils.xhr({
                    method: "POST",
                    url: `https://cn.bing.com/rewardsapp/reportActivity?${reportParams.toString()}`,
                    headers: {
                        "content-type": "application/x-www-form-urlencoded",
                        "user-agent": RewardsAuto.ua.pc,
                        "referer": cnUrl,
                        "origin": "https://cn.bing.com",
                        "accept": "*/*",
                        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
                    },
                    data: bodyParams.toString()
                });
                return true;
            } catch (e) {
                Utils.log("🟡", `每日活动上报失败: ${e.message}`);
                return false;
            }
        },

        // 获取今日每日活动列表（getuserinfo/flyout 结构化数据，含已完成项；
        // 两者都不可用时回退 flight 流解析，保证列表与完成状态复查不依赖旧接口）
        async getDailySetItems(fetchOpts) {
            const items = [];
            try {
                const data = await this._getUserInfo(fetchOpts);
                if (data) {
                    const dashboard = data.dashboard || data;
                    const dailySetPromotions = dashboard.dailySetPromotions || {};
                    const todayKeys = Utils.dateKeysFromRunDay(RewardsAuto.state.dateNowNum);
                    for (const dateKey of todayKeys) {
                        const dailyItems = dailySetPromotions[dateKey];
                        if (!Array.isArray(dailyItems)) continue;
                        for (const item of dailyItems) {
                            if (!item) continue;
                            const offerId = item.offerId || item.offerid || item.name || item.id;
                            if (!offerId || items.some(it => it.offerId === offerId)) continue;
                            const doneMax = Number(item.pointProgressMax || 0);
                            const doneCur = Number(item.pointProgress || 0);
                            // 拓宽 URL 字段捕获（兼容不同版本的字段命名），确保 bing.com 访问上报可用
                            const url = item.destinationUrl || item.destination || item.url || item.link
                                || item.clickUrl || item.activityUrl || item.attributes?.url || "";
                            // 调试：输出活动项字段，便于定位真实 URL/hash 字段名
                            if (GM_getValue("Config.debugDailySet", false)) {
                                Utils.log("🔵", `每日活动原始字段: ${Object.keys(item).join(",")}`);
                                Utils.log("🔵", `每日活动项: ${JSON.stringify(item).slice(0, 400)}`);
                            }
                            items.push({
                                title: item.title || item.name || "",
                                points: Number(item.pointProgressMax ?? item.points ?? 0),
                                offerId,
                                hash: item.hash || item.activityId || "",
                                url,
                                complete: !!(item.complete || item.isCompleted || item.completed || (doneMax > 0 && doneCur >= doneMax))
                            });
                        }
                        if (items.length > 0) break;
                    }
                }

                // 兜底：两个接口都拿不到时，直接解析 dashboard/earn flight 流中的每日活动 offer。
                // flight 流完全没有（页面结构未知）→ 返回 null 交由重试机制；
                // flight 流正常但无每日活动 → 视为今日确实无活动。
                if (items.length === 0) {
                    const flightItems = await this._dailySetItemsFromFlight(fetchOpts);
                    if (flightItems === null) return null;
                    for (const it of flightItems) {
                        if (!items.some(x => x.offerId === it.offerId)) items.push(it);
                    }
                    if (flightItems.length > 0) {
                        Utils.log("📅", `接口不可用，flight 流兜底解析到 ${flightItems.length} 个每日活动`);
                    }
                }
            } catch (e) {
                Utils.log("🟡", `每日活动列表获取失败: ${e.message}`);
                return null;
            }
            return items;
        },

        // 从 flight 流解析今日每日活动 offer（含完成状态）。flight 数据缺失返回 null。
        async _dailySetItemsFromFlight(fetchOpts) {
            const out = [];
            let sawFlight = false;
            try {
                for (const pageUrl of ["https://rewards.bing.com/dashboard", "https://rewards.bing.com/earn"]) {
                    const html = await Utils.fetchPage({ url: pageUrl, headers: { "user-agent": RewardsAuto.ua.pc } }, fetchOpts);
                    if (!html) continue;
                    const combined = Utils.concatFlightChunks(html);
                    if (combined) sawFlight = true;
                    for (const obj of Utils.extractFlightObjects(combined, '"offerId"')) {
                        const offerId = typeof obj.offerId === "string" ? obj.offerId : "";
                        if (!offerId || !/^Gamification_DailySet/i.test(offerId)) continue;
                        if (out.some(it => it.offerId === offerId)) continue;
                        const dateNum = Utils.flightDateToNum(obj.date);
                        if (dateNum > 0 && dateNum !== RewardsAuto.state.dateNowNum) continue;
                        const doneMax = Number(obj.pointProgressMax || 0);
                        const doneCur = Number(obj.pointProgress || 0);
                        out.push({
                            title: typeof obj.title === "string" ? obj.title : (typeof obj.description === "string" ? obj.description : ""),
                            points: Number(obj.points ?? doneMax ?? 0),
                            offerId,
                            hash: typeof obj.hash === "string" ? obj.hash : "",
                            url: typeof obj.destination === "string" ? obj.destination : (typeof obj.destinationUrl === "string" ? obj.destinationUrl : ""),
                            complete: obj.isCompleted === true || obj.complete === true || (doneMax > 0 && doneCur >= doneMax)
                        });
                    }
                    if (out.length > 0) break;
                }
            } catch (e) {
                Utils.log("🟡", `flight 流每日活动兜底解析失败: ${e.message}`);
                return null;
            }
            return sawFlight ? out : null;
        },

        async signPC() {
            // v3.6.10 实测（已登录页面同源对照实验）：legacy reportactivity 接口已被
            // 服务端下线——真实页面同样 401，且页面源码中已不存在 RequestVerificationToken，
            // flight 流中亦无 Gamification_DailyCheckIn。保留尝试以兼容区域/改版回滚，
            // 但其失败不代表积分损失或会话过期（签入实际由 App 静默签入与搜索连签覆盖），
            // 不得再用于连坐其他任务（见 runAll 中 pc401 的解除）。
            try {
                const res = await this.reportActivity("Gamification_DailyCheckIn", "1", "https://rewards.bing.com/");
                if (Utils.isJSON(res)) {
                    const data = JSON.parse(res);
                    return Number(data.points || data.response?.activity?.p || 0);
                }
            } catch (e) {
                if (e.message?.includes("401")) RewardsAuto.state.pc401 = true;
                Utils.log("🔵", `PC签入（legacy，服务端已下线）跳过: ${e.message}`);
            }
            return -1;
        },

        async appActivity(type, offerid, quiet = false) {
            const region = this._resolveRegion();
            const body = {
                amount: 1,
                country: region,
                id: this._genActivityId(),
                type: type,
                channel: RewardsAuto.appConfig.channel
            };
            if (offerid) {
                body.attributes = { offerid: offerid };
            }
            try {
                const res = await this._dapiRequest({ region, body });
                if (Utils.isJSON(res)) {
                    const data = JSON.parse(res);
                    const points = data.response?.activity?.p || 0;
                    const isDuplicate = data.response?.isDuplicate || false;
                    const balance = data.response?.balance || 0;
                    return { points, isDuplicate, balance };
                }
            } catch (e) {
                if (!quiet) Utils.log("🔴", `App活动失败(${offerid}): ${e.message}`);
            }
            return null;
        },

        // DAPI /me 结构化数据（阅读进度/搜索配额/余额共用）；options=613 已包含
        // options=105 的余额字段，单轮内一次请求供所有读取方复用。
        // 需要 Token，失败返回 null；options 作为缓存键的一部分，不同 options 独立缓存。
        // region 默认 cn：这些端点原本就固定发往国区（与 _dapiRequest 的动态区域不同），保持不变。
        async _getMeInfo(options = "613", fetchOpts, region = "cn") {
            try {
                const res = await Utils.fetchPage({
                    url: "https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=" + options,
                    _cacheKey: "dapi-me",
                    method: "GET",
                    headers: {
                        "user-agent": RewardsAuto.ua.app,
                        "authorization": `Bearer ${RewardsAuto.state.token}`,
                        "x-rewards-appid": RewardsAuto.appConfig.rewardsAppId,
                        "x-rewards-ismobile": "true",
                        "x-rewards-country": region,
                        "x-rewards-language": "zh"
                    }
                }, fetchOpts);
                if (!res || !Utils.isJSON(res)) return null;
                const parsed = JSON.parse(res);
                return parsed.response || null;
            } catch (_) {
                return null;
            }
        },

        async getReadProgress(fetchOpts) {
            try {
                const response = await this._getMeInfo("613", fetchOpts);
                if (response) {
                    const promos = response.promotions || [];
                    const readOfferId = RewardsAuto.appConfig.offerIds.readArticle;
                    const task = promos.find(x => x.attributes?.offerid === readOfferId);
                    if (task && task.attributes) {
                        const progress = parseInt(task.attributes.progress) || 0;
                        const max = parseInt(task.attributes.max) || 30;
                        Utils.log("📊", `阅读进度查询: ${progress}/${max} (offerid: ${readOfferId})`);
                        return { progress, max };
                    } else {
                        Utils.log("🟡", `阅读任务未找到 (offerid: ${readOfferId})`);
                    }
                } else {
                    Utils.log("🟡", "DAPI /me 响应无效");
                }
            } catch (e) {
                Utils.log("🔴", `阅读进度获取失败: ${e.message}`);
            }
            return false;
        },

        // 获取 RequestVerificationToken（用于 reportactivity API，带缓存避免重复请求）
        async getRewardsToken(force = false) {
            const cache = RewardsAuto.state._rvTokenCache;
            if (!force && cache && cache.token && (Date.now() - cache.time < 30 * 60 * 1000)) {
                return cache.token;
            }
            try {
                const html = await Utils.xhr({
                    url: "https://rewards.bing.com/",
                    headers: {
                        "user-agent": RewardsAuto.ua.pc,
                        "referer": "https://rewards.bing.com/"
                    },
                    anonymous: false
                });
                if (html) {
                    const match = html.match(/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/i)
                        || html.replace(/\s/g, "").match(/RequestVerificationToken(.*?)value="(.*?)"/)
                        || html.match(/"verificationToken"\s*:\s*"([^"]+)"/i)
                        || html.match(/"__RequestVerificationToken"\s*:\s*"([^"]+)"/i);
                    if (match) {
                        const token = match[match.length - 1].replace(/&amp;/g, "&");
                        RewardsAuto.state._rvTokenCache = { token, time: Date.now() };
                        return token;
                    }
                }
            } catch (e) {
                Utils.log("🟡", `RequestVerificationToken 获取失败: ${e.message}`);
            }
            return false;
        },

        async getSearchQuotaFromUserInfo(fetchOpts) {
            try {
                const data = await this._getUserInfo(fetchOpts);
                if (!data) return false;
                const dashboard = data.dashboard || data;
                const userStatus = dashboard.userStatus || {};
                const counters = userStatus.counters || {};

                const sumCounter = items => {
                    if (!Array.isArray(items)) return { progress: 0, max: 0 };
                    return items.reduce((acc, item) => {
                        acc.progress += Number(item.pointProgress || 0);
                        acc.max += Number(item.pointProgressMax || item.pointMax || 0);
                        return acc;
                    }, { progress: 0, max: 0 });
                };

                const pc = sumCounter(counters.pcSearch);
                if (pc.max === 0) return false;

                const balance = Number(userStatus.availablePoints || dashboard.availablePoints || 0);

                // 获取阅读进度
                let readProgress = 0, readMax = 30;
                try {
                    const readInfo = await API.getReadProgress(fetchOpts);
                    if (readInfo) {
                        readProgress = readInfo.progress;
                        readMax = readInfo.max;
                    }
                } catch (e) {}

                Utils.log("📊", `getuserinfo查询: PC ${pc.progress}/${pc.max}, 阅读 ${readProgress}/${readMax}, 积分 ${balance}`);

                return {
                    balance,
                    pc,
                    readProgress,
                    readMax,
                    dailyOffer: 0,
                    todayDetails: pc.max > 0 ? [{ title: "必应搜索", points: pc.progress, max: pc.max }] : [],
                    history: null
                };
            } catch (e) {
                if (GM_getValue("Config.debugDAPI", false)) {
                    Utils.log("🟡", `getuserinfo 查询失败: ${e.message}`);
                }
                return false;
            }
        },

        // 查不到 counters 或配额 0/0 时返回 false，回退到 HTML 解析
        async getSearchQuotaFromAPI(fetchOpts) {
            try {
                const response = await this._getMeInfo("613", fetchOpts);
                if (response) {
                    const promos = response.promotions || [];
                    if (GM_getValue("Config.debugDAPI", false)) {
                        const promoNames = promos.map(p => p.name || p.attributes?.offerid || "?").join(", ");
                        Utils.log("🔵", `DAPI promotions(${promos.length}): ${promoNames}`);

                        for (let i = 0; i < Math.min(promos.length, 5); i++) {
                            const p = promos[i];
                            const attrs = p.attributes || {};
                            const attrStr = Object.entries(attrs).map(([k, v]) => `${k}=${v}`).join(", ").slice(0, 300);
                            Utils.log("🔵", `DAPI promo[${i}] ${p.name}: ${attrStr}`);
                        }
                    }

                    const counters = response.counters || response.userStatus?.counters;
                    if (!counters) {
                        if (GM_getValue("Config.debugDAPI", false)) {
                            Utils.log("🟡", "DAPI 未返回 counters，回退到页面解析");
                        }
                        return false;
                    }

                    const pcSearch = Array.isArray(counters.pcSearch) ? counters.pcSearch : [];
                    const { progress: pcCur, max: pcMax } = pcSearch.reduce((acc, item) => {
                        acc.progress += Number(item?.pointProgress || 0);
                        acc.max += Number(item?.pointProgressMax || item?.pointMax || 0);
                        return acc;
                    }, { progress: 0, max: 0 });

                    if (pcMax === 0) {
                        if (GM_getValue("Config.debugDAPI", false)) {
                            Utils.log("🟡", "DAPI 返回配额 0，回退到页面解析");
                        }
                        return false;
                    }

                    const balance = response.balance || response.userStatus?.availablePoints || 0;

                    // 获取阅读进度
                    let readProgress = 0, readMax = 30;
                    try {
                        const readInfo = await API.getReadProgress(fetchOpts);
                        if (readInfo) {
                            readProgress = readInfo.progress;
                            readMax = readInfo.max;
                        }
                    } catch (e) {}

                    Utils.log("📊", `DAPI查询: PC ${pcCur}/${pcMax}, 阅读 ${readProgress}/${readMax}, 积分 ${balance}`);

                    return {
                        balance,
                        pc: { progress: pcCur, max: pcMax },
                        readProgress,
                        readMax,
                        dailyOffer: 0,
                        todayDetails: [],
                        history: null
                    };
                }
            } catch (e) {
                Utils.log("🟡", `DAPI查询失败: ${e.message}`);
            }
            return false;
        },

        // 查询当前积分余额
        async getBalance(fetchOpts) {
            // 方法1: DAPI（需要 Token）；options=613 与阅读进度/搜索配额共用同一份缓存
            const meInfo = await this._getMeInfo("613", fetchOpts);
            if (meInfo) return meInfo.balance || 0;

            // 方法2: getuserinfo API（不需要 Token）
            try {
                const data2 = await this._getUserInfo(fetchOpts);
                if (data2) {
                    return data2.dashboard?.availablePoints || data2.balance || 0;
                }
            } catch (e) {}

            return 0;
        },

        // 执行阅读
        async doRead() {
            const region = this._resolveRegion();
            try {
                const res = await this._dapiRequest({
                    region,
                    body: {
                        amount: 1,
                        country: region,
                        id: this._genActivityId(),
                        type: 101,
                        attributes: { offerid: RewardsAuto.appConfig.offerIds.readArticle }
                    }
                });
                if (Utils.isJSON(res)) {
                    const data = JSON.parse(res);
                    const points = data.response?.activity?.p || 0;
                    const isDuplicate = data.response?.isDuplicate || false;
                    return { points, isDuplicate };
                }
                return null;
            } catch (e) {
                Utils.log("🔴", `阅读请求失败: ${e.message}`);
                return false;
            }
        },

        // 多层级解析：activityCards → promotionCards → 全局扫描 → HTML data 属性
        async discoverCards(fetchOpts) {
            const cards = [];
            const cardsByOfferId = new Map();
            try {
                const html = await Utils.fetchPage({ url: "https://rewards.bing.com/earn" }, fetchOpts);
                if (!html) { Utils.log("🔴", "earn 页面返回空"); return null; }

                // unescape 版本供 RSC 解析使用
                const clean = html.replace(/\\"/g, '"');

                // ---------- 动态提取 next-action（供 claimCard 使用） ----------
                Utils.extractNextAction(html, clean);

                const pushCard = (card) => {
                    if (!card || !card.offerId || !card.hash || card.points <= 0) return;
                    const dup = cardsByOfferId.get(card.offerId);
                    if (dup) {
                        // 去重键不能含 hash：hash 随页面轮换，getuserinfo 与 flyout 回退
                        // 会把同一 offer 各推一次（v3.6.16 轮 02:18 实测——二次领取因
                        // flyout 源无 url 空转失败，把整轮误判"部分失败"）。首条缺 url
                        // 时回填；上报 hash 由后续 live 合并步骤统一重盖，去重不影响正确性。
                        if (!dup.url && card.url) dup.url = card.url;
                        return;
                    }
                    cardsByOfferId.set(card.offerId, card);
                    cards.push(card);
                };

                const inferKind = (offerId, title = "") => {
                    const text = `${offerId} ${title}`;
                    if (/quiz|trivia/i.test(text)) return "quiz";
                    if (/puzzle/i.test(text)) return "puzzle";
                    if (/image/i.test(text)) return "image_creator";
                    if (/explore|search/i.test(text)) return "explore_search";
                    if (/dailyset|daily/i.test(text)) return "daily";
                    if (/streak/i.test(text)) return "streak";
                    return "open_only";
                };

                // ---------- 辅助：从字符串提取单张卡片对象 ----------
                const parseCard = (obj) => {
                    const offerIdMatch = obj.match(/"offerId":"([^"]+)"/i)
                        || obj.match(/"offerid":"([^"]+)"/i)
                        || obj.match(/"offer_id":"([^"]+)"/i);
                    const hashMatch = obj.match(/"hash":"([^"]+)"/)
                        || obj.match(/"activityId":"([^"]+)"/)
                        || obj.match(/"id":"([^"]+)"/);
                    if (!offerIdMatch || !hashMatch) return null;

                    const offerId = offerIdMatch[1];
                    const hash = hashMatch[1];
                    const pointsMatch = obj.match(/"points":(\d+)/);
                    const isCompletedMatch = obj.match(/"isCompleted":(true|false)/i)
                        || obj.match(/"completed":(true|false)/i)
                        || obj.match(/"state":"(completed|CLAIMED)"/i);
                    const titleMatch = obj.match(/"title":"([^"]+)"/)
                        || obj.match(/"name":"([^"]+)"/)
                        || obj.match(/"displayName":"([^"]+)"/);

                    const points = pointsMatch ? parseInt(pointsMatch[1]) : 0;
                    const isCompleted = isCompletedMatch
                        ? (isCompletedMatch[1] === "true" || isCompletedMatch[1] === "completed" || isCompletedMatch[1] === "CLAIMED")
                        : false;
                    // v4.1.1：锁定卡解析层过滤（与 earn live 合并的 isLocked 过滤同语义）
                    if (isCompleted || /"isLocked"\s*:\s*true/i.test(obj)) return null;

                    const title = titleMatch ? titleMatch[1] : "";

                    const skip = RewardsAuto.skipPatterns.some(p =>
                        title.toLowerCase().includes(p.toLowerCase()) ||
                        offerId.toLowerCase().includes(p.toLowerCase())
                    );
                    if (skip) return null;

                    return { title, points, offerId, hash, form: obj.match(/"form":"([^"]+)"/)?.[1] || "", kind: inferKind(offerId, title) };
                };

                // ---------- 方法0: getuserinfo 结构化数据 ----------
                try {
                    const data = await this._getUserInfo();
                    if (data) {
                        const dashboard = data.dashboard || data;
                        const todayKeys = new Set(Utils.dateKeysFromRunDay(RewardsAuto.state.dateNowNum));

                        const normalizeDashboardCard = (item, kind) => {
                            if (!item) return null;
                            const offerId = item.offerId || item.offerid || item.id || item.name;
                            const hash = item.hash || item.activityId;
                            const title = item.title || item.name || item.description || "";
                            const points = Number(item.points ?? item.pointProgressMax ?? item.max ?? 0);
                            const doneMax = Number(item.pointProgressMax || 0);
                            const doneCur = Number(item.pointProgress || 0);
                            const isCompleted = item.isCompleted || item.complete || item.completed || (doneMax > 0 && doneCur >= doneMax);
                            // v4.1.1：isLocked 卡（unlockCriteria:"rewardsApp" 等）只能在对应端
                            // 完成，网页端结构性不可领——解析层出列，否则每轮进领取链白跑
                            if (!offerId || !hash || points <= 0 || isCompleted || item.isLocked === true) return null;
                            const skip = RewardsAuto.skipPatterns.some(p =>
                                title.toLowerCase().includes(p.toLowerCase()) ||
                                offerId.toLowerCase().includes(p.toLowerCase())
                            );
                            if (skip) return null;
                            return {
                                title,
                                points,
                                offerId,
                                hash,
                                form: (typeof item.form === "string" && item.form) || item.attributes?.form || "",
                                kind: kind || inferKind(offerId, title),
                                source: "getuserinfo",
                                url: item.destinationUrl || item.destination || "https://rewards.bing.com/"
                            };
                        };

                        const dailySetPromotions = dashboard.dailySetPromotions || {};
                        for (const dateKey of todayKeys) {
                            const dailyItems = dailySetPromotions[dateKey];
                            if (Array.isArray(dailyItems)) {
                                for (const item of dailyItems) pushCard(normalizeDashboardCard(item, "daily"));
                            }
                        }

                        const morePromotions = dashboard.morePromotions || dashboard.promotions || [];
                        if (Array.isArray(morePromotions)) {
                            for (const item of morePromotions) pushCard(normalizeDashboardCard(item));
                        }

                        if (cards.length > 0) {
                            Utils.log("🧩", `getuserinfo 命中 ${cards.length} 个活动卡片`);
                        }
                    }
                } catch (e) {
                    Utils.log("🟡", `getuserinfo 活动解析跳过: ${e.message}`);
                }

                // ---------- 方法1: activityCards 数组 ----------
                const m1 = clean.match(/"activityCards":\[([\s\S]*?)\](?=,"|,"[a-z]|}$)/i);
                if (m1) {
                    Utils.log("🧩", "命中 activityCards 数组");
                    const cardObjRegex = /\{[^{}]*\}/g;
                    let m;
                    while ((m = cardObjRegex.exec(m1[1])) !== null) {
                        const card = parseCard(m[0]);
                        pushCard(card);
                    }
                }

                // ---------- 方法2: promotionCards / promotions 数组 ----------
                if (cards.length === 0) {
                    const m2 = clean.match(/"(?:promotionCards|promotions|dailySet|cards)":\[([\s\S]*?)\](?=,"|,"[a-z]|}$)/i);
                    if (m2) {
                        Utils.log("🧩", "命中 promotionCards/promotions 数组");
                        const cardObjRegex = /\{[^{}]*\}/g;
                        let m;
                        while ((m = cardObjRegex.exec(m2[1])) !== null) {
                            const card = parseCard(m[0]);
                            pushCard(card);
                        }
                    }
                }

                // ---------- 方法3: 全局扫描含 offerId+hash 的对象（平衡括号匹配） ----------
                if (cards.length === 0) {
                    Utils.log("🧩", "全局扫描 RSC payload 中的卡片对象");
                    const seen = new Set();
                    const offerIdRe = /"offerId"|"offerid"|"offer_id"/gi;
                    let m;
                    while ((m = offerIdRe.exec(clean)) !== null) {
                        let start = m.index;
                        while (start > 0 && clean[start] !== '{') start--;
                        if (clean[start] !== '{') continue;
                        let depth = 0, end = start;
                        for (let i = start; i < clean.length; i++) {
                            if (clean[i] === '{') depth++;
                            if (clean[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
                        }
                        if (depth !== 0) continue;
                        const obj = clean.slice(start, end);
                        if (!/"(?:hash|activityId|id)"\s*:/.test(obj)) continue;
                        const key = obj.slice(0, 80);
                        if (seen.has(key)) continue;
                        seen.add(key);
                        const card = parseCard(obj);
                        pushCard(card);
                    }
                }

                // ---------- 方法4: 从 Next.js RSC flight payload 中提取 ----------
                if (cards.length === 0) {
                    Utils.log("🧩", "尝试解析 RSC flight payload");
                    // RSC 格式: 数字:{JSON}\n
                    const flightRegex = /\d+:(\{[\s\S]*?"(?:offerId|offerid)"[\s\S]*?\})\n/g;
                    let m;
                    const seen = new Set();
                    while ((m = flightRegex.exec(clean)) !== null) {
                        const key = m[1].slice(0, 80);
                        if (seen.has(key)) continue;
                        seen.add(key);
                        const card = parseCard(m[1]);
                        pushCard(card);
                    }
                }

                // ---------- 方法5: 从 HTML data-* 属性中提取 ----------
                if (cards.length === 0) {
                    Utils.log("🧩", "尝试从 HTML data 属性中提取卡片");
                    const dataRegex = /data-offer-id="([^"]+)"[^>]*data-hash="([^"]+)"/gi;
                    let m;
                    while ((m = dataRegex.exec(html)) !== null) {
                        const offerId = m[1];
                        const hash = m[2];
                        const skip = RewardsAuto.skipPatterns.some(p => offerId.toLowerCase().includes(p.toLowerCase()));
                        if (skip) continue;
                        pushCard({ title: "", points: 1, offerId, hash, kind: "open_only" });
                    }
                }

                // ---- earn flight live 状态合并（2026-09-14 登录态抓包实证）----
                // 卡片上报 hash 必须用本次 /earn 加载的轮换 hash（真实点击抓包：服务端
                // 按当次 flight 值校验）；isCompleted/isLocked 是网页侧权威状态与资格
                // 标记——据此过滤"已入账"和"仅限积分商城应用"卡片，不再空转重试。
                try {
                    const live = Utils.parseEarnLiveOffers(Utils.concatFlightChunks(html));
                    if (Object.keys(live).length > 0) {
                        const kept = [];
                        for (const c of cards) {
                            const o = live[c.offerId];
                            if (!o) { kept.push(c); continue; } // earn 墙未见该 offer → 保留原样
                            if (o.isCompleted) { Utils.log("🔵", `卡片已入账（earn live 状态）: ${c.offerId}`); continue; }
                            if (o.isLocked) { Utils.log("🔒", `卡片锁定（${o.unlockCriteria || "?"}），网页端不可领取: ${c.offerId}`); continue; }
                            if (o.hash) c.hash = o.hash;
                            kept.push(c);
                        }
                        cards.length = 0;
                        cards.push(...kept);
                    }
                } catch (_) { /* live 合并失败不影响原有解析结果 */ }

                if (cards.length === 0) {
                    // 输出前 500 字符供调试
                    const snippet = clean.slice(0, 500).replace(/[\r\n]+/g, ' ');
                    Utils.log("🟡", `所有方法均未命中，页面前500字符: ${snippet}`);
                }
            } catch (e) {
                Utils.log("🔴", `卡片解析失败: ${e.message}`);
                return null;
            }
            return cards;
        },

        // 当前部署 ID（dpl）：真实浏览器的所有 Server Action 请求都携带
        // x-deployment-id 头（2026-09-15 抓包实证）。直连路径此前缺这个头，
        // 而 00:38 轮证明"带全量登录 cookie 的直连 POST 仍 500"——指纹自洽度
        // 每补一分是一分。取值来自 _resolveReportActivityActionId 扫描 chunk
        // 时持久化的 Config.reportAction.dpl。
        _currentDpl() {
            try {
                const saved = GM_getValue("Config.reportAction", null);
                if (saved && typeof saved.dpl === "string" && saved.dpl) return saved.dpl;
            } catch (_) {}
            return "";
        },

        // 欢迎页“可领取 N”积分的真实领取（2026-09-14 登录态抓包实证：+6 分到账）：
        // POST https://rewards.bing.com/dashboard，body 为空参数数组 []，
        // next-action 为 claim 专用 ID（独立于 reportActivity，随部署轮换，且仅在
        // 页面存在可领取项时随 flight 下发 "$ACTION_ID_xxx"）。成功响应包含 `1:true`。
        // 解析顺序：页面 $ACTION_ID_ 唯一候选 → Config.claimActionId 覆盖值 → 抓包兜底值。
        async claimPendingPoints() {
            const DASH = "https://rewards.bing.com/dashboard";
            let actionId = String(GM_getValue("Config.claimActionId", "") || "");
            if (!/^[a-f0-9]{40}$/.test(actionId)) {
                actionId = "00491296f1d668ad46b65342c95cb9d72a62c1fa9d"; // 2026-09-14 dpl=20260912-2 抓包
            }
            try {
                const html = await Utils.fetchPage({ url: DASH, headers: { "user-agent": RewardsAuto.ua.pc } }, { fresh: true });
                if (html) {
                    const ids = new Set(
                        (String(html).match(/\$ACTION_ID_([a-f0-9]{40})/g) || [])
                            .concat((Utils.concatFlightChunks(html).match(/\$ACTION_ID_([a-f0-9]{40})/g) || []))
                            .map(s => s.slice(11)));
                    if (ids.size === 1) actionId = [...ids][0];
                }
            } catch (_) { /* 拿不到就用配置/兜底值 */ }
            const dpl = this._currentDpl();
            const headers = {
                "accept": "text/x-component",
                "content-type": "text/plain;charset=UTF-8",
                "next-action": actionId,
                "next-router-state-tree": Utils.routerStateTree(DASH),
                ...(dpl ? { "x-deployment-id": dpl } : {}),
                "sec-fetch-site": "same-origin",
                "sec-fetch-mode": "cors",
                "sec-fetch-dest": "empty",
            };
            const cookie = await Utils.cookieHeaderFor(DASH);
            if (cookie) headers.cookie = cookie;
            try {
                const res = await Utils.xhr({ method: "POST", url: DASH, headers, data: "[]" });
                if (typeof res === "string" && res.includes("1:true")) return true;
                Utils.log("🟡", `欢迎积分领取响应形态异常: ${String(typeof res === "string" ? res : (res && res.status) || "?").slice(0, 80)}`);
                return false;
            } catch (e) {
                Utils.log("🟡", `欢迎积分领取失败（action id 可能已轮换，可更新 Config.claimActionId）: ${e.message}`);
                return false;
            }
        },

        // 领取卡片奖励（2026-09-14 登录态抓包重写）
        // 浏览器点击日常任务卡的真实契约：POST https://rewards.bing.com/earn（卡片墙
        // 所在页自身），context 形状 body [本次earnFlightHash, 11,
        // {offerid, isPromotional, timezoneOffset}]，next-action=reportActivity 动态 ID。
        // 200 即上报受理；earn 响应是 RSC 流、不含 `1:true`，是否入账交由调用方的
        // "复核 + 连续 N 轮放弃"机制判定，此处不看响应文本。
        async claimCard(card) {
            // 策略0（主路径）：DAPI App 上报 type 101 + offerid——Bearer 鉴权、
            // 无 cookie/Origin 依赖，SW 直连实测真实入账（2026-09-15：Child3 +10p，
            // balance 4118→4128）。isDuplicate:true 即同 activity id 幂等确认，同样成功。
            // v4.1.0 实测标定（2026-09-16）：服务端对 App 目录外/锁定/未开始的 offer
            // 一律静默 200 + p:0 + isDuplicate:false（WW_Rewards_locked_level2 与已完成
            // Child3 换 id 重报均为 p:0）——这类响应不代表入账，必须视为"App 上报未受理"，
            // 落到下方网页策略兜底，绝不能当成功短路。
            const appRes = await this.appActivity(101, card.offerId, true);
            if (appRes && (appRes.points > 0 || appRes.isDuplicate)) {
                Utils.log("📲", `App上报入账(${card.offerId}): +${appRes.points}p${appRes.isDuplicate ? "（已入账，幂等确认）" : ""}`);
                return true;
            }

            // 新版构建下页面 flight 流不再内嵌可用的 next-action 引用，
            // 优先用 chunk 扫描出的 reportActivity ID，避免误用页面其他 action 的 ID
            const nextAction = await this._resolveReportActivityActionId()
                || RewardsAuto._nextAction || RewardsAuto.fallbackActionId;
            const EARN = "https://rewards.bing.com/earn";

            // v3.7.0 抓包实证（2026-09-15 登录态页面）：action 成功的唯一判据是响应含
            // `1:true`——缺 cookie 链的请求同样 200，但服务端只重渲染页面、action 不执行
            // （无 `1:true`）；半截链则 500。此前"任何 2xx 即成功"把这两类假成功当入账，
            // 是"已上报未到账"空转的直接来源。显式链可用时加 anonymous 关掉 SW 自动附带
            // 的 SameSite=None 碎片 cookie，避免与显式链合并出重复/半认证头（500 嫌疑）。
            const postEarnAction = async (hash, shape) => {
                const dpl = this._currentDpl();
                const headers = {
                    "accept": "text/x-component",
                    "content-type": "text/plain;charset=UTF-8",
                    "next-action": nextAction,
                    "next-router-state-tree": Utils.routerStateTree(EARN),
                    "origin": "https://rewards.bing.com",
                    "referer": EARN,
                    "user-agent": RewardsAuto.ua.pc,
                    ...(dpl ? { "x-deployment-id": dpl } : {}),
                    "sec-fetch-site": "same-origin",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-dest": "empty",
                };
                const cookie = await Utils.cookieHeaderFor(EARN);
                if (cookie) headers.cookie = cookie;
                const res = await Utils.xhr({
                    method: "POST", url: EARN, headers,
                    anonymous: !!cookie,
                    acceptErrorBody: true,
                    data: JSON.stringify(shape === "impression"
                        ? [hash, 11, { offerid: card.offerId, form: card.form || "$undefined" }]
                        : [hash, 11, {
                            offerid: card.offerId,
                            isPromotional: "$undefined",
                            timezoneOffset: Utils.jsTimezoneOffset(),
                        }]),
                });
                if (typeof res === "string" && res.includes("1:true")) return;
                const detail = typeof res === "string"
                    ? `2xx 无 1:true（cookie 链缺失特征）: ${res.slice(0, 100)}`
                    : `HTTP ${res && res.status}: ${String((res && res.body) || "").slice(0, 140)}`;
                throw new Error(detail);
            };

            // 策略1: context 形 + live hash（discoverCards 已用本次 earn flight 覆盖）
            // v4.2.0：边缘拦截（503 + Bing 错误页）是结构性拒绝，逐条重试其余形状/路由
            // 只会重复同一失败。实测标定见 isEdgeBlockedError 注释；此处短路交给页面侧脚本。
            let edgeBlocked = false;
            if (card.hash) {
                try { await postEarnAction(card.hash); return true; }
                catch (e) {
                    edgeBlocked = Utils.isEdgeBlockedError(e);
                    Utils.log("🟡", `Earn 同源上报失败(${card.offerId}): ${e.message}`);
                }
            }

            // 策略2: 强制刷新 earn 页再取一次 live hash——卡片来自 getuserinfo 静态源
            // 或 discoverCards 合并未命中时，旧 hash 大概率正是失败原因（服务端按当次
            // 页面加载校验）。顺带用权威 live 状态短路：已入账返回成功，锁定直接放弃。
            try {
                const html = await Utils.fetchPage({ url: EARN }, { fresh: true });
                const live = Utils.parseEarnLiveOffers(Utils.concatFlightChunks(html || ""));
                const o = live && live[card.offerId];
                if (o && o.isCompleted) return true;
                if (o && o.isLocked) {
                    Utils.log("🔒", `卡片锁定（${o.unlockCriteria || "?"}），网页端不可领取: ${card.offerId}`);
                    return false;
                }
                if (o && o.hash && o.hash !== card.hash) {
                    await postEarnAction(o.hash);
                    return true;
                }
            } catch (e2) {
                edgeBlocked = edgeBlocked || Utils.isEdgeBlockedError(e2);
                Utils.log("🟡", `Live hash 重试失败(${card.offerId}): ${e2.message}`);
            }

            // 策略3: impression 形（改版前旧 payload，兼容仍引用旧构建的区域）
            if (!edgeBlocked && card.hash) {
                try { await postEarnAction(card.hash, "impression"); return true; }
                catch (e3) { Utils.log("🟡", `Server Action(impression) 失败: ${card.offerId}`); }
            }

            // （原 legacy /api/reportactivity 策略删除：2026-09-14 实测该端点已被服务端
            //   下线——真实登录页面同样 401、页面已无 RequestVerificationToken，保留只会
            //   为每张失败卡片白白多打 3 个请求。）

            // 边缘拦截时不发后台标签页（它同样走 SW/扩展发起的网络栈，无法改变拦截结果），
            // 直接转交页面侧脚本；非拦截性失败仍保留这条原生流程兜底。
            if (edgeBlocked) {
                Utils.log("🟡", `卡片需页面上下文领取(${card.offerId}): SW 直连被边缘拦截（503），已交给《页面领取》脚本——打开任意 rewards.bing.com 页面即可自动完成`);
                return false;
            }

            // 策略5（v3.7.0 重写）：XHR GET 活动链接已证无入账效果——入账只发生在
            // rewards 页的 Server Action（实测 Child2 无任何 bing 访问即入账），且裸 GET
            // 曾把"访问成功"谎报为"领取成功"。改为开真实后台标签页走浏览器原生流程
            //（个别 bingredirect 类卡片可能由 bing 侧结算），10 秒后自动关闭；
            // 本策略不返回成功，是否入账交由领取后复核与放弃账本判定。
            if (card.url && /^https?:\/\/[^/]*bing\.com/i.test(card.url)) {
                try {
                    const opened = GM_openInTab(card.url, { active: false });
                    Utils.log("🔵", `已开后台标签页走原生流程(${card.offerId})，10 秒后自动关闭`);
                    setTimeout(() => { try { if (opened && opened.close) opened.close(); } catch (_) {} }, 10000);
                } catch (_) { /* 开页失败不影响结果 */ }
            }

            Utils.log("🟡", `卡片领取失败(${card.offerId}): 所有策略均失败`);
            return false;
        },

        async getSearchPage(query, isMobile = false) {
            const mkt = GM_getValue("Config.lock", true) ? "&mkt=zh-CN" : "";
            const deviceType = isMobile ? "m" : "d";
            return Utils.xhr({
                url: `https://${RewardsAuto.state.host}/search?q=${encodeURIComponent(query)}&form=QBLH${mkt}`,
                headers: {
                    "user-agent": isMobile ? RewardsAuto.ua.mobile : RewardsAuto.ua.pc,
                    "cookie": `_Rwho=u=${deviceType}&ts=${RewardsAuto.state.dateNowStr}`,
                    "referer": `https://${RewardsAuto.state.host}/?form=QBLH`
                }
            });
        },

        async reportSearch(query, isMobile = false) {
            try {
                const ig = Utils.getRandomUUID();
                const mkt = GM_getValue("Config.lock", true) ? "&mkt=zh-CN" : "";
                const params = `q=${encodeURIComponent(query)}&form=QBLH${mkt}`;
                const deviceType = isMobile ? "m" : "d";
                const headers = {
                    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "user-agent": isMobile ? RewardsAuto.ua.mobile : RewardsAuto.ua.pc,
                    "referer": `https://${RewardsAuto.state.host}/?form=QBLH`,
                    "cookie": `_Rwho=u=${deviceType}&ts=${RewardsAuto.state.dateNowStr}`
                };

                await Utils.xhr({
                    method: "POST",
                    url: `https://${RewardsAuto.state.host}/rewardsapp/ncheader?ver=88888888&IID=SERP.5047&IG=${ig}&ajaxreq=1`,
                    headers,
                    data: "wb=1%3bi%3d1%3bv%3d1"
                });
                await Utils.xhr({
                    method: "POST",
                    url: `https://${RewardsAuto.state.host}/rewardsapp/reportActivity?IG=${ig}&IID=SERP.5047&${params}&ajaxreq=1`,
                    headers,
                    data: `url=${encodeURIComponent(`https://${RewardsAuto.state.host}/search?${params}`)}&V=web`
                });
                return true;
            } catch (e) {
                Utils.log("🟡", `搜索上报失败: ${e.message}`);
                return false;
            }
        },

        async checkRegion(retryCount = 0) {
            if (!GM_getValue("Config.lock", true)) return true;
            try {
                const html = await Utils.xhr({ url: `https://${RewardsAuto.state.host}/` });
                if (!html) {
                    if (retryCount < 2) {
                        Utils.log("🟡", `地区检测返回空，第${retryCount + 1}次重试...`);
                        await Utils.randomDelay(3000, 8000);
                        return await this.checkRegion(retryCount + 1);
                    }
                    Utils.log("🔴", "地区检测失败（无响应）");
                    return false;
                }
                const match = html.replace(/\s/g, "").match(/Region:"(.*?)"(.*?)RevIpCC:"(.*?)"/);
                if (match) {
                    RewardsAuto.state.region = match[3].toUpperCase();
                    if (RewardsAuto.state.region !== "CN") {
                        // 获取IP详细信息（来自比尔脚本）
                        await this.getIPInfo();
                        Utils.log("🔴", `IP非大陆(${RewardsAuto.state.region})，已停止\n${RewardsAuto.state.ipInfo}`, true);
                        return false;
                    }
                    Utils.log("🟢", `地区检测通过: ${RewardsAuto.state.region}`);
                    return true;
                }
                // 正则未匹配到，可能是页面结构变化
                if (retryCount < 2) {
                    Utils.log("🟡", `地区检测格式异常，第${retryCount + 1}次重试...`);
                    await Utils.randomDelay(3000, 8000);
                    return await this.checkRegion(retryCount + 1);
                }
                Utils.log("🔴", "地区检测失败（格式不匹配）");
                return false;
            } catch (e) {
                if (retryCount < 2) {
                    Utils.log("🟡", `地区检测异常: ${e.message}，第${retryCount + 1}次重试...`);
                    await Utils.randomDelay(3000, 8000);
                    return await this.checkRegion(retryCount + 1);
                }
                Utils.log("🔴", `地区检测失败: ${e.message}`);
                return false;
            }
        },

        async getIPInfo() {
            try {
                const qryResult = await Utils.xhr({
                    url: "https://disp-qryapi.3g.qq.com/v1/dispatch",
                    headers: { "referer": "https://3g.qq.com/" }
                });
                if (qryResult && Utils.isJSON(qryResult)) {
                    const resJSON = JSON.parse(qryResult);
                    RewardsAuto.state.ip = (resJSON.code == 0 && resJSON.extra && resJSON.extra.ip) ? resJSON.extra.ip : "";
                    let rawInfo = (resJSON.code == 0 && resJSON.ipInfo) ? String(resJSON.ipInfo) : "";
                    rawInfo = rawInfo.replace(/[#*]+/g, " ").trim();
                    RewardsAuto.state.ipInfo = rawInfo ? `🌏所在地区：${rawInfo}` : "";
                }
            } catch {
                Utils.log("🟡", "获取附加 IP 信息失败");
            }
        },

        async getHotSearchWord() {
            const keywords = ["天气预报", "今日新闻", "体育赛事", "股票行情", "电影推荐", "科技资讯", "美食食谱", "旅游攻略", "历史上的今天", "健康常识"];
            const baseWord = keywords[Utils.randomRange(0, keywords.length - 1)];
            const randomSuffix = Math.random().toString(36).slice(2, 5);
            let sentence = `${baseWord} ${randomSuffix}`;

            if (RewardsAuto.apiConfig.mode !== "offline") {
                if (RewardsAuto.apiConfig.wordList.length < 1) {
                    // 获取随机API配置
                    const apiArr = RewardsAuto.apiConfig.arr;
                    const lastApiName = GM_getValue("Config.apiIndex", "");
                    let filteredArr = apiArr.filter(([name]) => name !== lastApiName);
                    if (filteredArr.length < 1) filteredArr = apiArr; // 全部 API 均被排除时回退完整列表，避免随机取到 undefined
                    const [apiName, apiConfig] = filteredArr[Utils.randomRange(0, filteredArr.length - 1)];
                    GM_setValue("Config.apiIndex", apiName);
                    
                    RewardsAuto.apiConfig.url = apiConfig.url;
                    RewardsAuto.apiConfig.hot = apiConfig.hot;

                    try {
                        const hotSource = RewardsAuto.apiConfig.hot[Utils.randomRange(0, RewardsAuto.apiConfig.hot.length - 1)];
                        const result = await Utils.xhr({ url: RewardsAuto.apiConfig.url + hotSource });
                        if (result && Utils.isJSON(result)) {
                            const res = JSON.parse(result);
                            if (res.code == 200) {
                                RewardsAuto.apiConfig.wordList = (res.data || [])
                                    .map(d => d && d.title)
                                    .filter(t => typeof t === "string" && t.trim());
                                if (RewardsAuto.apiConfig.wordList.length > 0) {
                                    // 随机打乱数组（Fisher–Yates）
                                    Utils.shuffle(RewardsAuto.apiConfig.wordList);
                                    // 从首个词开始使用，避免跳过首词及单词表时取到 undefined
                                    RewardsAuto.apiConfig.wordIndex = 0;
                                    sentence = RewardsAuto.apiConfig.wordList[0].substring(0, Utils.randomRange(20, 32));
                                    return sentence;
                                }
                            }
                        }
                    } catch (e) {
                        Utils.log("🟡", `热搜词获取失败: ${e.message}`);
                    }
                } else {
                    RewardsAuto.apiConfig.wordIndex++;
                    if (RewardsAuto.apiConfig.wordIndex > RewardsAuto.apiConfig.wordList.length - 1) {
                        RewardsAuto.apiConfig.wordIndex = 0;
                    }
                    sentence = RewardsAuto.apiConfig.wordList[RewardsAuto.apiConfig.wordIndex];
                    sentence = sentence.substring(0, Utils.randomRange(20, 32));
                    return sentence;
                }
                Utils.log("🟡", "热搜词接口异常，已使用随机搜索词");
            }
            return sentence;
        },

        async checkSearchRestricted(info) {
            // 用服务器实际进度判断，避免本地虚增导致误判。
            // 调用方可传入已获取的 info 复用，减少同一轮内的重复抓取。
            let currentTotal = RewardsAuto.state.pcProgress;
            if (info) {
                currentTotal = info.pc.progress;
            } else {
                const fetched = await this.getRewardsInfo();
                if (fetched) currentTotal = fetched.pc.progress;
            }
            const lastTotal = RewardsAuto.state.lastSearchProgress;

            if (lastTotal !== -1) {
                if (currentTotal === lastTotal &&
                    currentTotal < RewardsAuto.state.pcMax) {
                    RewardsAuto.state.restrictedTimes++;
                } else {
                    RewardsAuto.state.restrictedTimes = 0;
                }
            }

            RewardsAuto.state.lastSearchProgress = currentTotal;
            GM_setValue("Config.lastSearchProgress", currentTotal);
            GM_setValue("Config.restrictedTimes", RewardsAuto.state.restrictedTimes);
            GM_setValue("Config.searchProgressDate", RewardsAuto.state.dateNowNum);

            if (RewardsAuto.state.restrictedTimes >= 3) {
                Utils.log("🔴", "搜索受限或账号异常，已中断今日搜索！", true);
                return true;
            }
            return false;
        }
    };

    // 活动卡片"连续未确认"放弃上限：某卡片服务端连续 N 次复核仍未确认完成时，
    // 当日不再重复上报（多为需真实访问才结算的开放型卡片），次日按日期清零重试。
    const PROMOS_GIVE_UP_AFTER = 5;

    // 运行锁参数：运行中心跳每 5 分钟续期一次；过期窗口 20 分钟（> 2 个心跳周期），
    // 既保证活跃长任务不被误判过期，又把实例意外终止（关标签页/SW 被杀）后
    // 后台停摆的最长时间从 60 分钟压缩到 20 分钟。
    const RUN_LOCK_EXPIRE_MS = 20 * 60 * 1000;
    const RUN_LOCK_HEARTBEAT_MS = 5 * 60 * 1000;
    // v3.6.7 加固：心跳续期只能证明"持有实例还活着"，证明不了"任务还在推进"——
    // 一个 await 永不返回的卡死轮次（如 SW 挂起/恢复后 promise 悬挂）会把锁无限
    // 续期，令后台每轮跳过、永久停摆。接管判据因此从"仅看 expire"扩展为三条：
    //   ① 心跳失联（lastBeat 超过 3 个心跳周期未刷新）→ 持有者已死或计时器冻结；
    //   ② 总持有时长超过硬上限（90 分钟，约为最慢合法轮次的 3 倍）→ 判定卡死，
    //      持有者停止续期，后来者允许接管；
    //   ③ expire 异常超前（> 2 个过期窗口）→ 锁记录损坏/被写坏，视为无效。
    const RUN_LOCK_STALE_BEAT_MS = 3 * RUN_LOCK_HEARTBEAT_MS;
    const RUN_LOCK_MAX_HOLD_MS = 90 * 60 * 1000;

    const TaskManager = {
        // 任务日期状态
        signDate: 0, readDate: 0, promosDate: 0, searchDate: 0, streakDays: 0,
        signPoint: -1, signTimes: 0, readTimes: 0, promosTimes: 0,

        // 初始化任务状态
        init() {
            RewardsAuto.state.dateNowNum = Utils.getTodayNum();
            RewardsAuto.state.dateNowStr = Utils.getTodayStr();
            const savedTasks = GM_getValue("Config.tasks", {});
            const tasks = savedTasks && typeof savedTasks === "object" ? savedTasks : {};
            this.signDate = tasks.sign || 0;
            this.readDate = tasks.read || 0;
            this.promosDate = tasks.promos || 0;
            this.searchDate = tasks.search || 0;
            this.streakDays = tasks.streakDays || 0;
            this.signPoint = GM_getValue("Config.signPoint", -1);

            // 这些计数器只属于当前运行；手动再次运行时必须从干净状态开始。
            this.signTimes = 0;
            this.readTimes = 0;
            this.promosTimes = 0;
            RewardsAuto.state.pc401 = false;

            // 搜索受限状态只允许在同一天跨运行恢复，避免把昨天的停滞次数带到今天。
            const progressDate = GM_getValue("Config.searchProgressDate", 0);
            if (progressDate === RewardsAuto.state.dateNowNum) {
                RewardsAuto.state.lastSearchProgress = GM_getValue("Config.lastSearchProgress", -1);
                RewardsAuto.state.restrictedTimes = GM_getValue("Config.restrictedTimes", 0);
            } else {
                RewardsAuto.state.lastSearchProgress = -1;
                RewardsAuto.state.restrictedTimes = 0;
                GM_setValue("Config.lastSearchProgress", -1);
                GM_setValue("Config.restrictedTimes", 0);
                GM_setValue("Config.searchProgressDate", RewardsAuto.state.dateNowNum);
            }
        },

        // 保存任务状态
        save() {
            GM_setValue("Config.tasks", {
                sign: this.signDate, read: this.readDate,
                promos: this.promosDate, search: this.searchDate,
                streakDays: this.streakDays
            });
        },

        async doSign() {
            if (!GM_getValue("Tasks.sign", true)) { Utils.log("🟡", "签入任务已关闭，跳过"); return true; }
            if (this.signTimes > 2) { Utils.log("🟡", "签入重试次数已用完，稍后由下次运行处理"); return false; }
            if (this.signPoint >= 0 && this.signDate === RewardsAuto.state.dateNowNum) {
                Utils.log("✅", `签入已完成(${this.signPoint}积分)`);
                return true;
            }

            await Utils.randomDelay();
            
            let totalPoint = 0;
            let signOk = false;
            
            // App 端签到（静默执行，不写入通知）
            const appPoint = await API.signApp();
            if (appPoint >= 0) {
                signOk = true;
                if (appPoint > 0) {
                    GM_log(`📱 App签入静默成功 +${appPoint}积分`);
                    totalPoint += appPoint;
                } else {
                    GM_log("📱 App签入已确认，无新增积分");
                }
            }
            
            // PC 端签到
            await Utils.randomDelay(3000, 8000);
            const pcPoint = await API.signPC();
            if (pcPoint >= 0) {
                signOk = true;
                Utils.log("💻", `PC签入成功！+${pcPoint}积分`);
                totalPoint += pcPoint;
            }
            
            if (signOk) {
                this.signPoint = totalPoint;
                this.signDate = RewardsAuto.state.dateNowNum;
                GM_setValue("Config.signPoint", totalPoint);
                this.save();
                Utils.log("🔵", `签入任务完成！总积分 +${totalPoint}`, true);
                return true;
            } else {
                this.signTimes++;
                Utils.log("🟡", `签入失败，稍后重试`);
                return false;
            }
        },

        async doRead() {
            if (!GM_getValue("Tasks.read", true)) { Utils.log("🟡", "阅读任务已关闭，跳过"); return true; }
            if (this.readTimes > 2) { Utils.log("🟡", "阅读重试次数已用完，稍后由下次运行处理"); return false; }
            if (this.readDate === RewardsAuto.state.dateNowNum) {
                // 二次验证：检查实际进度是否真的满了
                const verifyProgress = await API.getReadProgress();
                if (verifyProgress && verifyProgress.progress >= verifyProgress.max) {
                    Utils.log("✅", `阅读任务已完成（已验证 ${verifyProgress.progress}/${verifyProgress.max}）`);
                    return true;
                } else if (verifyProgress) {
                    // readDate 被错误设置，重置
                    Utils.log("🟡", `阅读标记有误（${verifyProgress.progress}/${verifyProgress.max}），重置并继续`);
                    this.readDate = 0;
                    this.save();
                } else {
                    Utils.log("🟡", "无法验证阅读进度，跳过");
                    return false;
                }
            }

            const progress = await API.getReadProgress();
            if (!progress) {
                this.readTimes++;
                Utils.log("🟡", "无法获取阅读进度，稍后重试");
                return false;
            }

            const { progress: cur, max } = progress;
            Utils.log("📖", `阅读进度: ${cur}/${max}`);

            if (cur >= max) {
                this.readDate = RewardsAuto.state.dateNowNum;
                this.save();
                Utils.log("✅", "阅读任务已完成");
                return true;
            }

            let successCount = 0;
            const maxPerDay = 10; // 每天最多 10 篇
            const remaining = Math.min(max - cur, maxPerDay);
            Utils.log("📖", `今日还可阅读 ${remaining} 篇（上限 ${maxPerDay} 篇/天）`);

            for (let i = 0; i < remaining; i++) {
                const result = await API.doRead();
                if (!result) { Utils.log("🟡", `阅读第 ${i + 1} 篇失败，中止`); break; }
                successCount++;
                Utils.log("📖", `阅读文章 ${i + 1}/${remaining} +${result.points}积分`);
                await Utils.randomDelay(3000, 8000);
            }

            if (successCount === 0) {
                this.readTimes++;
                Utils.log("🟡", "阅读全部失败，稍后重试");
                return false;
            }

            // 二次验证（v3.6.12 修复）：此前不带 fresh，复核命中的是轮内缓存的旧进度
            // （2026-09-15 00:34 实测：10 篇读完立即复核仍 0/30，实为缓存旧值），导致
            // "已执行但未完成"误报与汇总 ❌。现强制绕过缓存，并等一个入账延迟窗口；
            // 同时乐观置 readDate——入口处有"readDate 已置则强制复核、不符则重置"守卫，
            // 早置只会让汇总正确，不会漏做。
            this.readDate = RewardsAuto.state.dateNowNum;
            this.save();
            await Utils.delay(12000);
            const verify = await API.getReadProgress({ fresh: true });
            if (verify && verify.progress >= verify.max) {
                Utils.log("🔵", `阅读任务完成！共 ${successCount} 篇`, true);
                return true;
            } else {
                this.readTimes++;
                Utils.log("🟡", `阅读已执行 ${successCount} 篇，入账确认延迟，下轮自动复核`);
                return true;
            }
        },

        async doPromos() {
            if (!GM_getValue("Tasks.promos", true)) { Utils.log("🟡", "活动卡片任务已关闭，跳过"); return true; }
            if (this.promosTimes > 2) { Utils.log("🟡", "活动卡片重试次数已用完，稍后由下次运行处理"); return false; }
            if (this.promosDate === RewardsAuto.state.dateNowNum) {
                Utils.log("✅", "活动卡片已完成");
                return true;
            }

            Utils.log("🧩", "扫描活动卡片...");
            const cards = await API.discoverCards();

            if (cards === null) {
                this.promosTimes++;
                Utils.log("🟡", "活动卡片扫描失败，稍后重试");
                return false;
            }

            if (cards.length === 0) {
                this.promosDate = RewardsAuto.state.dateNowNum;
                this.save();
                Utils.log("✅", "无新活动卡片");
                return true;
            }

            // 当日已连续未确认达上限的卡片（多为"需真实访问才结算"的开放型卡片）
            // 直接跳过本轮上报，避免整天空转；次日日期变更自动清零重试。
            const giveUpIds = this._givenUpOfferIds();
            const claimable = cards.filter(c => !giveUpIds.has(c.offerId));
            if (claimable.length === 0) {
                this.promosDate = RewardsAuto.state.dateNowNum;
                this.save();
                Utils.log("🟡", `其余 ${giveUpIds.size} 个卡片已连续未确认放弃，今日流程结束（次日自动重试）`);
                return true;
            }

            Utils.log("🧩", `发现 ${claimable.length} 个可领取卡片`);
            let ok = 0, fail = 0;
            const claimed = new Set();
            const failed = [];

            for (const card of claimable) {
                Utils.log("  ", `[${card.kind}] ${card.title} +${card.points}p`);

                // Quiz 任务需要单独处理（可选开启）
                if (card.kind === "quiz" && !GM_getValue("Tasks.quiz", true)) continue;

                // 【防封号】领取卡片前随机延迟
                await Utils.randomDelay(3000, 8000);
                const result = await API.claimCard(card);
                result ? ok++ : fail++;
                if (result) claimed.add(card.offerId);
                else failed.push(card.offerId);
            }

            // v4.1.1：领取失败的卡片同样计入放弃账本（此前只统计"上报成功但未确认"，
            // 锁定等级/时间窗卡每轮全策略失败却永远进不了账本，阻塞 promosDate 整日 ❌）。
            // 达上限的卡片当日放弃，下轮扫描起不再出列。
            const newlyGivenUp = this._recordFailedClaims(failed);

            // 仍有失败但未达放弃上限的卡片 → 保持 pending，下轮仅重试这些卡片
            //（与旧"部分失败"语义一致；复核只对"本轮失败卡全部收口"的轮次执行，省请求数）。
            const stillPending = failed.filter(id => !newlyGivenUp.includes(id));
            if (stillPending.length > 0) {
                this.promosTimes++;
                Utils.log("🟡", `活动卡片部分失败（${ok} 成功/${fail} 失败），稍后重试`);
                return false;
            }

            // 领取后复核：上报成功≠积分到账（v4.1.0 实测：App 目录外 offer 会被
            // 静默吸收、网页 2xx 可能只是页面重渲染）。
            // 未确认卡片按 offerId 累计连续失败次数，达上限后当日放弃（_countUnconfirmed），
            // 本轮没有任何卡片上报成功（如全部是已关闭的 quiz）时跳过复核，省掉 2 次请求。
            let unconfirmed = [];
            if (claimed.size > 0) {
                await Utils.randomDelay(4000, 8000);
                // 复核必须绕过轮内缓存（fresh），否则刚上报的卡片永远"未确认"
                const recheck = await API.discoverCards({ fresh: true });
                if (Array.isArray(recheck)) {
                    unconfirmed = this._countUnconfirmed(recheck, claimed).retryable;
                }
            }

            // 全部卡片收口（领取成功、复核确认完成、或达上限当日放弃）才落账 ✅
            if (unconfirmed.length > 0) {
                this.promosTimes++;
                Utils.log("🟡", `已上报但 ${unconfirmed.length} 个卡片服务端未确认（${unconfirmed.join(",")}），下轮重试`);
                return false;
            }

            this.promosDate = RewardsAuto.state.dateNowNum;
            this.save();
            if (newlyGivenUp.length > 0) {
                Utils.log("🔵", `活动完成: ${ok}成功/${fail}失败（含 ${newlyGivenUp.length} 个当日放弃）`, true);
            } else {
                Utils.log("🔵", `活动完成: ${ok}成功/${fail}失败`, true);
            }
            return true;
        },

        // 当日已达"连续未确认放弃"上限的卡片 offerId 集合（次日按日期自动清零）
        _givenUpOfferIds(giveUpAfter = PROMOS_GIVE_UP_AFTER) {
            const rec = GM_getValue("Config.promosUnconfirmed", null);
            if (!rec || rec.date !== RewardsAuto.state.dateNowNum || typeof rec.offers !== "object") {
                return new Set();
            }
            return new Set(Object.entries(rec.offers)
                .filter(([, count]) => count >= giveUpAfter)
                .map(([offerId]) => offerId));
        },

        // 统计刚领取但服务端未确认的卡片：按 offerId 累计当日连续失败次数，
        // 达上限的进入 givenUp（当日放弃、本轮不再计数），未达上限的进入 retryable（下轮重试）。
        _countUnconfirmed(recheckCards, claimedOfferIds, giveUpAfter = PROMOS_GIVE_UP_AFTER) {
            const today = RewardsAuto.state.dateNowNum;
            const key = "Config.promosUnconfirmed";
            let rec = GM_getValue(key, null);
            if (!rec || rec.date !== today || typeof rec.offers !== "object") {
                rec = { date: today, offers: {} };
            }

            const retryable = [];
            const givenUp = [];
            for (const card of recheckCards) {
                if (!claimedOfferIds.has(card.offerId)) continue;
                const count = (rec.offers[card.offerId] || 0) + 1;
                rec.offers[card.offerId] = count;
                if (count >= giveUpAfter) {
                    givenUp.push(card.offerId);
                } else {
                    retryable.push(card.offerId);
                }
            }
            GM_setValue(key, rec);

            if (givenUp.length > 0) {
                Utils.log("🟡", `卡片服务端连续 ${giveUpAfter} 次未确认，当日放弃（次日自动重试）: ${givenUp.join(",")}`);
            }
            return { retryable, givenUp };
        },

        // v4.1.1：把"领取直接失败"（所有策略均失败/锁定拒绝）的卡片同样计入放弃账本。
        // 此前账本只覆盖"上报成功但复核未确认"的卡片，而锁定等级/时间窗卡每轮全策略
        // 失败却永远进不了账本 → fail>0 阻塞 promosDate，摘要"活动卡片"整日 ❌ 空转。
        // 返回当日已达放弃上限的 offerId 列表（达上限即从待办出列）。
        _recordFailedClaims(failedOfferIds, giveUpAfter = PROMOS_GIVE_UP_AFTER) {
            const ids = [...new Set(failedOfferIds)].filter(Boolean);
            if (ids.length === 0) return [];
            const today = RewardsAuto.state.dateNowNum;
            const key = "Config.promosUnconfirmed";
            let rec = GM_getValue(key, null);
            if (!rec || rec.date !== today || typeof rec.offers !== "object") {
                rec = { date: today, offers: {} };
            }
            const givenUp = [];
            for (const id of ids) {
                const count = (rec.offers[id] || 0) + 1;
                rec.offers[id] = count;
                if (count >= giveUpAfter) givenUp.push(id);
            }
            GM_setValue(key, rec);
            if (givenUp.length > 0) {
                Utils.log("🟡", `卡片连续 ${giveUpAfter} 次领取失败，当日放弃（次日自动重试）: ${givenUp.join(",")}`);
            }
            return givenUp;
        },

        async doSearch() {
            if (!GM_getValue("Tasks.search", true)) { Utils.log("🟡", "搜索任务已关闭，跳过"); return true; }

            const info = await API.getRewardsInfo();
            if (!info) { Utils.log("🔴", "无法获取积分信息"); return false; }

            RewardsAuto.state.pcProgress = info.pc.progress;
            RewardsAuto.state.pcMax = info.pc.max;

            Utils.log("🔍", `搜索配额: PC ${info.pc.progress}/${info.pc.max}`);

            const pcDone = info.pc.progress >= info.pc.max;
            if (pcDone) {
                this.searchDate = RewardsAuto.state.dateNowNum;
                this.save();
                Utils.log("✅", `搜索配额已满 PC: ${info.pc.progress}/${info.pc.max}`);
                return true;
            }

            if (this.searchDate === RewardsAuto.state.dateNowNum) {
                Utils.log("🟡", "搜索配额未满，继续执行搜索任务");
                this.searchDate = 0;
            }

            const isRestricted = await API.checkSearchRestricted(info);
            if (isRestricted) {
                this.searchDate = RewardsAuto.state.dateNowNum;
                this.save();
                return true;
            }

            const limit = Utils.randomRange(4, 7);
            // 轮内搜索词去重：50 词池随机取 4-7 次约 1/4 概率撞词，重复词更可疑且通常不计分
            const usedQueries = new Set();
            for (let i = 0; i < limit; i++) {
                if (RewardsAuto.state.pcProgress >= RewardsAuto.state.pcMax) break;

                let query;
                if (RewardsAuto.apiConfig.mode !== "offline") {
                    query = await API.getHotSearchWord();
                } else {
                    query = RewardsAuto.searchPool[Utils.randomRange(0, RewardsAuto.searchPool.length - 1)];
                    // 撞词时最多重试 3 次换词
                    for (let tries = 0; tries < 3 && usedQueries.has(query); tries++) {
                        query = RewardsAuto.searchPool[Utils.randomRange(0, RewardsAuto.searchPool.length - 1)];
                    }
                    usedQueries.add(query);
                }

                Utils.log("🔍", `[PC] 搜索 ${i+1}/${limit}: ${query}`);

                try {
                    const html = await API.getSearchPage(query, false);
                    if (html) {
                        const reported = await API.reportSearch(query, false);
                        if (reported) {
                            // 每次搜索通常计 1 分，仅用于循环内提前退出判断；
                            // 真实配额以最终 getRewardsInfo 复查为准，避免虚增导致提前结束
                            RewardsAuto.state.pcProgress += 1;
                        }
                    }
                } catch (e) {
                    Utils.log("🟡", `搜索失败: ${e.message}`);
                }

                const span = Number(GM_getValue("Config.span", 30)) || 30;
                // 限制 span 范围，避免配置过小时 (span-15) 为负导致延迟为负/过短
                const safeSpan = Math.min(Math.max(span, 15), 120);
                const wait = Utils.randomRange((safeSpan - 15) * 1000, (safeSpan + 15) * 1000);
                Utils.log("⏳", `等待 ${wait/1000}秒`);
                await Utils.delay(wait);
            }

            const finalInfo = await API.getRewardsInfo(3, { fresh: true });
            if (finalInfo) {
                const pcDone2 = finalInfo.pc.progress >= finalInfo.pc.max;
                if (pcDone2) {
                    this.searchDate = RewardsAuto.state.dateNowNum;
                    this.save();
                    RewardsAuto.state.restrictedTimes = 0;
                    GM_setValue("Config.restrictedTimes", 0);
                    GM_setValue("Config.lastSearchProgress", -1);
                    Utils.log("🔵", `🔍 搜索任务完成！PC: ${finalInfo.pc.progress}/${finalInfo.pc.max}`, true);
                    return true;
                } else {
                    Utils.log("🟡", `搜索已执行，配额未满 PC: ${finalInfo.pc.progress}/${finalInfo.pc.max}`);
                    return false;
                }
            } else {
                Utils.log("🟡", "搜索已执行，但无法获取最终配额状态");
                return false;
            }
        },

        async doDailySet() {
            // 使用运行起始日期（dateNowNum），与其余任务保持同一"今天"基准，
            // 避免跨午夜运行时新旧日期混用导致状态错位；次日新实例会重新捕获日期。
            const today = RewardsAuto.state.dateNowNum;
            if (GM_getValue("Config.dailySetDone", 0) === today) {
                Utils.log("📅", "每日活动今日已完成，跳过");
                return true;
            }
            const processedKey = "Config.dailySetProcessed";
            let processed = GM_getValue(processedKey, []);
            if (!Array.isArray(processed)) processed = [];
            if (processed.length > 0 && processed[0]?.date !== today) processed = [];
            const processedIds = new Set(processed.map(p => p.offerId));

            Utils.log("📅", `开始执行每日活动（已处理 ${processedIds.size} 个）...`);
            await Utils.randomDelay(3000, 8000);

            // 1) getuserinfo 获取今日每日活动（含完成状态，用于过滤已完成项）
            const items = await API.getDailySetItems();
            if (items === null) {
                Utils.log("🟡", "每日活动列表获取失败（接口异常），稍后由重试机制处理");
                return false;
            }
            const pendingItems = items.filter(it => !it.complete && !processedIds.has(it.offerId));
            if (items.length > 0 && pendingItems.length === 0) {
                Utils.log("✅", `每日活动均已完成（共 ${items.length} 个）`);
                GM_setValue(processedKey, items.filter(it => it.complete).map(it => ({ date: today, offerId: it.offerId })));
                GM_setValue("Config.dailySetDone", today);
                return true;
            }

            // v4.0.0 阶梯0：DAPI App 上报（type 101 + offerid）先行——SW 直连实测
            // 入账（与阅读/App签入同族端点，无 Origin 校验问题）；成功项直接出列，
            // 剩余项才走网页 Server Action 阶梯。
            // v4.1.0 标定：p:0 + isDuplicate:false = App 目录外/未开始的 offer 被
            // 服务端静默吸收（非入账），必须落到 rest 走网页阶梯，不得当成功。
            if (pendingItems.length > 0 && RewardsAuto.state.token) {
                const rest = [];
                for (const it of pendingItems) {
                    const r = await API.appActivity(101, it.offerId, true);
                    if (r && (r.points > 0 || r.isDuplicate)) {
                        Utils.log("📅", `每日活动 App上报: ${it.offerId} +${r.points}p${r.isDuplicate ? "（已入账）" : ""}`);
                    } else {
                        rest.push(it);
                    }
                    await Utils.randomDelay(2000, 4000);
                }
                pendingItems.length = 0;
                pendingItems.push(...rest);
            }

            // 2) 优先：从 flight 流解析每个活动的专属 hash，发送 Server Action 完成（纯后台请求，不打开网页）
            const hashes = await this._extractDailySetHashes(pendingItems);
            const nextAction = await API._resolveReportActivityActionId() || RewardsAuto._nextAction;
            if (hashes.length > 0) {
                Utils.log("📅", `解析到 ${hashes.length} 个每日活动 hash，开始完成上报...`);
                for (const h of hashes) {
                    Utils.log("📅", `完成每日活动: ${h.offerId}`);
                    const variants = Array.isArray(h.variants) && h.variants.length > 0
                        ? h.variants
                        : [{ hash: h.hash, form: h.form || "", type: 0, isPromotional: false }];
                    // 阶梯 1：impression 形状——bundle 中卡片可见即入账的调用点，
                    // 仅当变体携带真实 form 字段（与浏览器 impression 对象一致）时使用
                    let ok = false;
                    const formVariant = variants.find(v => v.form);
                    if (formVariant) {
                        ok = await this._sendDailySetAction(h.offerId, formVariant.hash, nextAction,
                            { shape: "impression", form: formVariant.form });
                    }
                    // 阶梯 2：context 形状——bundle 中卡片组件点击入账的调用点
                    // （reportActivity(hash, type ?? 11, {offerid, isPromotional, timezoneOffset})）
                    if (!ok) {
                        for (const v of variants.slice(0, 2)) {
                            ok = await this._sendDailySetAction(h.offerId, v.hash, nextAction,
                                { shape: "context", type: v.type, isPromotional: v.isPromotional });
                            if (ok) break;
                        }
                    }
                    // 阶梯 3：后台复刻真实点击——GET 活动目标链接（rnoreward=1 跳转入账）
                    if (!ok) {
                        const dest = pendingItems.find(p => p.offerId === h.offerId)?.url;
                        await this._visitActivityUrl(dest, h.offerId);
                    }
                    await Utils.randomDelay(4000, 8000);
                }

                // 复查完成状态（上报后的状态变化必须绕过缓存）；rnoreward 跳转入账
                // 有数秒延迟（v3.6.12：4-8 秒实测偏短，出现过 0/3 误报后同轮二次扫描又确认成功）
                await Utils.randomDelay(8000, 15000);
                const after = await API.getDailySetItems({ fresh: true });
                if (after && after.length > 0) {
                    const completedIds = new Set(after.filter(it => it.complete).map(it => it.offerId));
                    GM_setValue(processedKey, [...completedIds].map(id => ({ date: today, offerId: id })));
                    const okCount = after.filter(it => it.complete).length;
                    if (okCount >= after.length) {
                        GM_setValue("Config.dailySetDone", today);
                        Utils.log("🔵", `每日活动完成 ${okCount}/${after.length} 个`, true);
                        return true;
                    } else {
                        Utils.log("🟡", `每日活动完成 ${okCount}/${after.length} 个，未完成项下轮重试`);
                        return false;
                    }
                } else {
                    Utils.log("🟡", "每日活动已上报，无法复查完成状态，下轮重新校验");
                    return false;
                }
            }

            // 3) 兜底：hash 提取失败时后台静默打开活动链接（不打开 dashboard）
            Utils.log("🟡", "未提取到活动 hash，回退为后台打开活动链接");
            let urls = await this._extractDailySetUrls();
            if (urls.length === 0) {
                urls = items.filter(it => !it.complete && it.url && /bing\.com/i.test(it.url)).map(it => it.url);
            }
            if (urls.length === 0) {
                if (items.length === 0) {
                    GM_setValue("Config.dailySetDone", today);
                    Utils.log("✅", "今日无每日活动，流程结束");
                    return true;
                }
                Utils.log("🟡", `仍有 ${pendingItems.length} 个每日活动未完成，但未提取到可用链接`);
                return false;
            }
            let opened = 0;
            for (let i = 0; i < urls.length; i++) {
                try {
                    GM_openInTab(urls[i], { active: false, insert: true });
                    opened++;
                } catch (e) {
                    Utils.log("🟡", `打开活动链接失败: ${e.message}`);
                }
                await Utils.randomDelay(6000, 12000);
            }
            if (opened === 0) return false;

            // 打开链接只代表已触发操作，仍需以后端状态为准，避免把弹窗失败或页面结构变化误记为完成。
            await Utils.randomDelay(8000, 15000);
            const afterOpen = await API.getDailySetItems({ fresh: true });
            if (!afterOpen || afterOpen.length === 0) {
                Utils.log("🟡", "每日活动链接已打开，但无法复查完成状态");
                return false;
            }
            const completed = afterOpen.filter(it => it.complete);
            GM_setValue(processedKey, completed.map(it => ({ date: today, offerId: it.offerId })));
            if (completed.length < afterOpen.length) {
                Utils.log("🟡", `每日活动完成 ${completed.length}/${afterOpen.length} 个，未完成项下轮重试`);
                return false;
            }
            GM_setValue("Config.dailySetDone", today);
            Utils.log("🔵", `每日活动完成 ${completed.length}/${afterOpen.length} 个`, true);
            return true;
        },

        // 打卡任务（后台模式）：从 dashboard 发现打卡页 → 提取子任务链接 → 逐个 XHR 模拟点击
        async doPunchCard() {
            const today = RewardsAuto.state.dateNowNum;
            const doneKey = "Config.punchCardBgDone";
            if (GM_getValue(doneKey, 0) === today) {
                Utils.log("📅", "打卡任务今日已尝试");
                return true;
            }

            Utils.log("📅", "检查打卡任务...");

            // 1) 从 dashboard HTML 中发现打卡详情页 URL（轮内缓存：与 doClaimPoints 等共用同一次抓取）
            let punchUrl = null;
            try {
                const html = await Utils.fetchPage({
                    url: "https://rewards.bing.com/dashboard",
                    headers: { "user-agent": RewardsAuto.ua.pc }
                });
                if (!html) return false;
                const clean = html.replace(/\\"/g, '"').replace(/\\u0026/gi, "&").replace(/&amp;/g, "&");
                const m = clean.match(/https?:\/\/rewards\.bing\.com\/earn\/quest\/[\w-]*punchcard[\w-]*/i);
                if (m) punchUrl = m[0];
            } catch (e) {
                Utils.log("🟡", `打卡链接获取失败: ${e.message}`);
                return false;
            }

            if (!punchUrl) {
                Utils.log("📅", "未发现打卡任务");
                GM_setValue(doneKey, today);
                return true;
            }

            Utils.log("📅", `发现打卡页: ${punchUrl}`);

            // 2) GET 打卡详情页，提取子任务链接
            let taskLinks = [];
            try {
                const detailHtml = await Utils.xhr({
                    url: punchUrl,
                    headers: {
                        "user-agent": RewardsAuto.ua.pc,
                        "referer": "https://rewards.bing.com/",
                        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
                    }
                });
                if (!detailHtml) return false;
                const clean = detailHtml.replace(/\\"/g, '"').replace(/\\u0026/gi, "&").replace(/&amp;/g, "&");

                // 提取 bing 活动链接（搜索/活动页），排除导航/登录/兑换类
                const linkRegex = /https?:\/\/(?:www\.|cn\.)?bing\.com\/[^"'\s\\<>]+/gi;
                const seen = new Set();
                let m;
                while ((m = linkRegex.exec(clean)) !== null) {
                    const url = m[0];
                    if (/^https?:\/\/(?:www\.|cn\.)?bing\.com\/?(?:\?|$)/i.test(url)) continue;
                    if (/\/redeem|login\.live|aka\.ms|rewardspanel|microsoft-store|account\.microsoft/i.test(url)) continue;
                    if (seen.has(url)) continue;
                    seen.add(url);
                    taskLinks.push(url);
                }
            } catch (e) {
                Utils.log("🟡", `打卡详情页获取失败: ${e.message}`);
                return false;
            }

            if (taskLinks.length === 0) {
                Utils.log("📅", "打卡页无子任务链接（可能已全部完成）");
                GM_setValue(doneKey, today);
                return true;
            }

            // 打卡子任务通常 3-10 个；过多说明混入了导航链接，截取前 10 个
            if (taskLinks.length > 10) {
                Utils.log("🟡", `提取到 ${taskLinks.length} 个链接，可能混入导航链接，仅取前 10 个`);
                taskLinks = taskLinks.slice(0, 10);
            }

            Utils.log("📅", `发现 ${taskLinks.length} 个打卡子任务链接，模拟点击...`);

            // 3) 逐个 GET 子任务链接（模拟真实点击访问，服务器记录完成）
            let ok = 0;
            for (let i = 0; i < taskLinks.length; i++) {
                try {
                    await Utils.xhr({
                        url: taskLinks[i],
                        headers: {
                            "user-agent": RewardsAuto.ua.pc,
                            "referer": punchUrl,
                            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
                        }
                    });
                    ok++;
                } catch (e) {
                    Utils.log("🟡", `打卡子任务 ${i + 1} 失败: ${e.message}`);
                }
                // 【防封号】每个子任务间隔 5-12 秒
                await Utils.randomDelay(5000, 12000);
            }

            if (ok === taskLinks.length) {
                GM_setValue(doneKey, today);
                Utils.log("🔵", `打卡任务: ${ok}/${taskLinks.length} 个子任务完成`, true);
                return true;
            } else if (ok > 0) {
                Utils.log("🟡", `打卡任务部分失败: ${ok}/${taskLinks.length} 个子任务完成`);
                return false;
            } else {
                Utils.log("🟡", "打卡子任务全部失败");
                return false;
            }
        },

        // 从 dashboard HTML 中提取每日活动真实链接（rnoreward=1）
        async _extractDailySetUrls() {
            const urls = [];
            try {
                const html = await Utils.fetchPage({ url: "https://rewards.bing.com/dashboard" });
                if (!html) return urls;
                const clean = html.replace(/\\"/g, '"').replace(/\\u0026/gi, "&").replace(/&amp;/g, "&");
                // 动态提取 next-action（与 discoverCards 一致），供 Server Action 请求使用
                Utils.extractNextAction(html, clean, "(dashboard)");
                const linkRegex = /https?:\/\/(?:www\.|cn\.)?bing\.com\/[^"'\s\\<>]*rnoreward=1[^"'\s\\<>]*/gi;
                const seen = new Set();
                let m;
                while ((m = linkRegex.exec(clean)) !== null) {
                    if (seen.has(m[0])) continue;
                    seen.add(m[0]);
                    urls.push(m[0]);
                }
                if (urls.length > 0) Utils.log("📅", `dashboard 提取到 ${urls.length} 个每日活动链接`);
            } catch (e) {
                Utils.log("🟡", `dashboard 链接提取失败: ${e.message}`);
            }
            return urls;
        },

        // 从 /earn 与 /dashboard 的 flight 流中解析每个待完成每日活动的专属 hash。
        // 2026-09 改版后：offer 对象（offerId/hash/isCompleted/isLocked/date 等）
        // 位于 self.__next_f 分片中，按 getuserinfo 的 offerId 精确匹配；
        // flight 解析不中时回退旧的 RSC 正则（offerId 邻近 hex 串）。
        // v3.6.4：同一 offerId 在 flight 流中可能出现多个对象（瘦对象仅含
        // offerId/hash/isCompleted 等；卡片组件的富对象带 type/isPromotional；
        // 印象上报对象带 form）。全部收集为 variants 供上报阶梯依次尝试，
        // 不再"首个命中即定终身"。
        async _extractDailySetHashes(pendingItems = []) {
            const result = [];
            const pendingIds = pendingItems.map(it => it.offerId);
            // 1) 主路径：flight 流 offer 对象
            try {
                const byId = new Map();
                for (const pageUrl of ["https://rewards.bing.com/earn", "https://rewards.bing.com/dashboard"]) {
                    const html = await Utils.fetchPage({ url: pageUrl, headers: { "user-agent": RewardsAuto.ua.pc } });
                    if (!html) continue;
                    const combined = Utils.concatFlightChunks(html);
                    for (const obj of Utils.extractFlightObjects(combined, '"offerId"')) {
                        const offerId = typeof obj.offerId === "string" ? obj.offerId : "";
                        if (!offerId) continue;
                        // 有待完成清单时精确匹配；无清单时按前缀兜底（保持旧行为）
                        const hit = pendingIds.length
                            ? pendingIds.includes(offerId)
                            : /^Gamification_DailySet/i.test(offerId);
                        if (!hit) continue;
                        const hash = typeof obj.hash === "string" ? obj.hash : "";
                        if (!hash) continue;
                        const doneCur = Number(obj.pointProgress || 0);
                        const doneMax = Number(obj.pointProgressMax || 0);
                        const isCompleted = obj.isCompleted === true || obj.complete === true
                            || (doneMax > 0 && doneCur >= doneMax);
                        const dateNum = Utils.flightDateToNum(obj.date);
                        // 未完成、未锁定、未到期的 offer 才可上报
                        if (isCompleted || obj.isLocked === true) continue;
                        if (dateNum > 0 && dateNum > RewardsAuto.state.dateNowNum) continue;
                        const typeNum = Number(obj.type);
                        const variant = {
                            hash,
                            form: typeof obj.form === "string" && obj.form ? obj.form : "",
                            type: Number.isFinite(typeNum) && typeNum > 0 ? typeNum : 0,
                            isPromotional: obj.isPromotional === true
                        };
                        const list = byId.get(offerId) || [];
                        const key = JSON.stringify(variant);
                        if (!list.some(v => JSON.stringify(v) === key)) {
                            list.push(variant);
                            byId.set(offerId, list);
                        }
                    }
                    if (byId.size > 0 && (pendingIds.length === 0 || byId.size >= pendingIds.length)) break;
                }
                for (const [offerId, list] of byId) {
                    if (GM_getValue("Config.debugDailySet", false)) {
                        list.forEach((v, i) => Utils.log("🔵", `flight offer 变体${i + 1}(${offerId}): ${JSON.stringify({ ...v, hash: `${v.hash.slice(0, 12)}…` })}`));
                    }
                    // 首选带 form 的变体（impression 形状的真实入账参数），否则首个变体
                    const primary = list.find(v => v.form) || list[0];
                    result.push({ offerId, hash: primary.hash, form: primary.form, variants: list });
                }
                if (result.length > 0) {
                    Utils.log("📅", `flight 流解析到 ${result.length} 个每日活动 hash`);
                }
            } catch (e) {
                Utils.log("🟡", `flight 流每日活动解析失败: ${e.message}`);
            }

            // 2) 兜底：旧 RSC 正则（flight 未覆盖到的 offerId，如侧栏懒加载分片缺失）
            const missed = pendingIds.filter(id => !result.some(r => r.offerId === id));
            if (missed.length > 0) {
                try {
                    // RSC 变体与普通 dashboard 抓取内容不同，用独立缓存键
                    const rsc = await Utils.fetchPage({
                        url: "https://rewards.bing.com/dashboard",
                        _cacheKey: "rsc",
                        headers: { "rsc": "1", "accept": "text/x-component", "user-agent": RewardsAuto.ua.pc }
                    });
                    if (rsc) {
                        const clean = rsc.replace(/\\"/g, '"').replace(/\\u0026/gi, "&");
                        // 动态提取 next-action（与 discoverCards 一致），供 Server Action 请求使用
                        Utils.extractNextAction(rsc, clean, "(每日活动)");
                        const offerRegex = /Gamification_DailySet[\w-]*Child\d+/g;
                        const seen = new Set();
                        let m;
                        while ((m = offerRegex.exec(clean)) !== null) {
                            const offerId = m[0];
                            if (seen.has(offerId) || !missed.includes(offerId)) continue;
                            seen.add(offerId);
                            // 在 offerId 前后 400 字符范围内查找最近的 40-64 位十六进制 hash
                            const start = Math.max(0, m.index - 400);
                            const ctx = clean.slice(start, m.index + offerId.length + 400);
                            const center = m.index - start;
                            const hexRegex = /[0-9a-f]{40,64}/g;
                            let best = null;
                            let hm;
                            while ((hm = hexRegex.exec(ctx)) !== null) {
                                const dist = Math.abs(hm.index - center);
                                if (!best || dist < best.dist) best = { hash: hm[0], dist };
                            }
                            if (best) result.push({ offerId, hash: best.hash, form: "", variants: [{ hash: best.hash, form: "", type: 0, isPromotional: false }] });
                        }
                        if (result.length > 0) {
                            Utils.log("📅", `RSC 回退解析到 ${result.length} 个每日活动 hash`);
                        } else if (GM_getValue("Config.debugDailySet", false)) {
                            const idx = clean.indexOf("Gamification_DailySet");
                            Utils.log("🔵", `RSC 未提取到 hash；DailySet 上下文: ${idx >= 0 ? clean.slice(idx - 120, idx + 200) : "(未找到 DailySet)"}`);
                        }
                    }
                } catch (e) {
                    Utils.log("🟡", `每日活动 hash 回退提取失败: ${e.message}`);
                }
            }
            return result;
        },

        // 发送每日活动完成 Server Action。action ID 优先用 chunk 扫描结果，
        // 其次页面动态提取结果，最后才是构建期兜底值。
        // 两种 payload 形状均来自当前构建 bundle 的真实调用点（v3.6.4 拆分）：
        //  - shape "impression"（卡片可见即入账/活动弹窗关闭）：
        //      reportActivity(hash, 11, {offerid, form})
        //  - shape "context"（卡片组件点击入账，ReportActivityContext 包装）：
        //      reportActivity(hash, type ?? 11, {offerid, isPromotional: toString(), timezoneOffset})
        // 请求带 acceptErrorBody：非 2xx 时直接记录状态与响应体（含 React digest），
        // 供与真实浏览器 DevTools 捕获对比；不再靠二次重发抓取（该通道曾偶发丢失）。
        async _sendDailySetAction(offerId, hash, nextAction, offer = {}) {
            const actionId = nextAction || RewardsAuto.fallbackActionId;
            const shape = offer.shape === "context" ? "context" : "impression";
            const typeNum = Number(offer.type);
            const body = JSON.stringify([hash,
                shape === "context" && Number.isFinite(typeNum) && typeNum > 0 ? typeNum : 11,
                shape === "context"
                    ? {
                        offerid: offerId,
                        isPromotional: (offer.isPromotional === true || offer.isPromotional === "true") ? "true" : "$undefined",
                        timezoneOffset: Utils.jsTimezoneOffset()
                    }
                    : { offerid: offerId, form: offer.form || "$undefined" }
            ]);
            const dpl = API._currentDpl();
            const reqOptions = {
                method: "POST",
                url: "https://rewards.bing.com/dashboard",
                headers: {
                    "accept": "text/x-component",
                    "content-type": "text/plain;charset=UTF-8",
                    "next-action": actionId,
                    "next-router-state-tree": Utils.routerStateTree("https://rewards.bing.com/dashboard"),
                    "origin": "https://rewards.bing.com",
                    "referer": "https://rewards.bing.com/dashboard",
                    "user-agent": RewardsAuto.ua.pc,
                    ...(dpl ? { "x-deployment-id": dpl } : {}),
                    // v3.6.16：直连最后一块指纹拼图——浏览器对 Server Action 必带
                    // sec-fetch-*（同源 CORS 语义），服务端可能校验。ScriptCat 若透传
                    // 则直连即可工作；若剥掉也无害（通道路径浏览器自动带）。
                    "sec-fetch-site": "same-origin",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-dest": "empty",
                },
                data: body,
                anonymous: false,
                acceptErrorBody: true
            };
            // 显式 Cookie 头：补齐 SW 跨源子请求不自动携带的 SameSite 登录 cookie；
            // 链可用时同时关掉自动附带（v3.7.0，与 claimCard 同理）
            const cookie = await Utils.cookieHeaderFor(reqOptions.url);
            if (cookie) { reqOptions.headers.cookie = cookie; reqOptions.anonymous = true; }
            if (GM_getValue("Config.debugDailySet", false)) {
                Utils.log("🔵", `Server Action 请求(${shape}): ${JSON.stringify({
                    url: reqOptions.url, headers: reqOptions.headers, data: reqOptions.data,
                    cookies: cookie ? cookie.split("; ").length : 0
                })}`);
            }
            // v3.7.0：与 claimCard 同款严格判据——2xx 且含 `1:true` 才算 action 执行；
            // 缺 cookie 链的 200 是页面重渲染（action 未执行），不得视为上报成功。
            // 显式链可用时 anonymous 关掉 SW 自动附带的碎片 cookie（防重复/半认证头）。
            try {
                const res = await Utils.xhr(reqOptions);
                if (typeof res === "string" && res.includes("1:true")) return true;
                if (typeof res === "string") {
                    Utils.log("🟡", `Server Action ${shape} 未执行(${offerId}): 2xx 无 1:true（cookie 链缺失特征）: ${res.slice(0, 100)}`);
                } else {
                    Utils.log("🟡", `Server Action ${shape} 失败(${offerId}): HTTP ${res && res.status ? res.status : "?"}: ${String(res && res.body || "").slice(0, 240)}`);
                }
                return false;
            } catch (e) {
                Utils.log("🟡", `Server Action ${shape} 请求异常(${offerId}): ${e.message}`);
                return false;
            }
        },

        // 后台复刻真实浏览器点击卡片的行为：GET 活动目标链接（bingredirect 类活动
        // 的 rnoreward=1 跳转入账路径，与搜索配额的入账方式同源）。Server Action
        // 各形状都失败时的最后手段，不打开标签页。
        async _visitActivityUrl(url, offerId) {
            if (!url || !/^https?:\/\/[^/]*bing\.com/i.test(url)) return false;
            try {
                await Utils.xhr({
                    url,
                    headers: {
                        "user-agent": RewardsAuto.ua.pc,
                        "referer": "https://rewards.bing.com/dashboard"
                    }
                });
                Utils.log("🔵", `已后台访问活动链接(${offerId})，等待入账`);
                return true;
            } catch (e) {
                Utils.log("🟡", `后台访问活动链接失败(${offerId}): ${e.message}`);
                return false;
            }
        },

        async doClaimPoints() {
            // 通过 XHR 检测可领取积分（兼容 service worker）；轮内缓存与 doPunchCard 共用抓取
            try {
                const dashboardHtml = await Utils.fetchPage({ url: "https://rewards.bing.com/dashboard" });
                if (!dashboardHtml) {
                    Utils.log("✅", "无法获取 dashboard 页面");
                    return;
                }

                const claimableMatch = dashboardHtml.match(/alt="可领取"[^>]*>[\s\S]*?(\d[\d,]*)/i);
                if (!claimableMatch) {
                    Utils.log("✅", "无可领取积分");
                    return;
                }

                const amount = parseInt(claimableMatch[1].replace(/,/g, '')) || 0;
                if (amount > 0) {
                    // v3.6.11：不再只提醒，直接走实测契约领取（SW 直连）
                    const ok = await API.claimPendingPoints();
                    if (ok) {
                        Utils.log("🎁", `已领取 ${amount} 待领取积分`, true);
                    } else {
                        Utils.log("🟡", `${amount} 积分领取失败（打开 dashboard 时前台仍会自动领取）`);
                    }
                } else {
                    Utils.log("✅", "可领取积分为 0");
                }
            } catch (e) {
                Utils.log("🟡", `检测可领取积分失败: ${e.message}`);
            }
        },

        // ====== 连签任务检测（通过 XHR 获取 earn 页面信息） ======
        async doStreak() {
            Utils.log("📅", "开始检测连签任务...");
            try {
                // 获取 earn 页面 HTML（轮内缓存：与 getRewardsInfo/discoverCards 共用同一次抓取）
                const earnHtml = await Utils.fetchPage({ url: "https://rewards.bing.com/earn" });
                if (!earnHtml) { Utils.log("🟡", "无法获取 earn 页面"); return false; }

                // 去除 HTML 标签，保留纯文本用于正则匹配
                const text = earnHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

                // 解析每日连续打卡天数（新格式："每日连续打卡 7"）
                const streakDaysMatch = text.match(/每日连续打卡\s*(\d+)/);
                if (streakDaysMatch) {
                    this.streakDays = parseInt(streakDaysMatch[1]) || 0;
                    Utils.log("📅", `每日连续打卡：${this.streakDays} 天`);
                }

                // 解析连签任务状态（适配 2026-07 新 DOM 格式）
                // 新格式示例："必应搜索连续打卡 已完成连续打卡 5 天，共 7 天。 搜索: 1/1"
                const taskPatterns = [
                    { name: "必应搜索连续打卡", pattern: /必应搜索连续打卡[\s\S]*?搜索:\s*(\d+)\/(\d+)/ },
                    { name: "每日连续打卡活动", pattern: /每日连续打卡活动[\s\S]*?活动:\s*(\d+)\/(\d+)/ },
                    { name: "必应应用连续打卡", pattern: /必应应用连续打卡[\s\S]*?签到:\s*(\d+)\/(\d+)/ },
                    { name: "视觉搜索连续打卡", pattern: /视觉搜索连续打卡[\s\S]*?活动:\s*(\d+)\/(\d+)/ },
                ];

                let visualSearchDone = true;
                for (const { name, pattern } of taskPatterns) {
                    const m = text.match(pattern);
                    if (m) {
                        const cur = parseInt(m[1]), max = parseInt(m[2]);
                        const done = cur >= max;
                        Utils.log(done ? "✅" : "📅", `${name}: ${cur}/${max}${done ? " 已完成" : ""}`);
                        if (name === "视觉搜索连续打卡" && !done) {
                            visualSearchDone = false;
                        }
                    }
                }

                // 视觉搜索未完成仅记录日志，不再自动打开页面（避免弹窗干扰前台）
                if (!visualSearchDone) {
                    Utils.log("📅", "视觉搜索连续打卡未完成（如需完成可手动访问必应视觉搜索）");
                }

                // 解析 1,000 奖励印章进度（新格式："赚取 12 个印章"）
                const stampMatch = text.match(/(\d+)\s*个印章/) || text.match(/印章\s*(\d+)/);
                if (stampMatch) {
                    Utils.log("📅", `连签奖励印章进度: ${stampMatch[1]}/12`);
                }

                // 连签任务的实际完成由 doPromos() 的 discoverCards + claimCard 统一处理
                Utils.log("📅", "连签任务检测完成，未完成任务将由活动卡片模块处理");
                return true;
            } catch (e) {
                Utils.log("🔴", `连签任务异常: ${e.message}`);
                return false;
            }
        },

        // 今日任务是否全部完成（用于空闲短路）。搜索受限日也会被计入"已完成"，
        // 因为受限本身意味着当日停止搜索，避免重复触发风控。
        _isIdle() {
            const today = RewardsAuto.state.dateNowNum;
            const enabled = key => GM_getValue(key, true);
            return (!enabled("Tasks.sign")     || this.signDate === today) &&
                   (!enabled("Tasks.read")     || this.readDate === today) &&
                   (!enabled("Tasks.promos")   || this.promosDate === today) &&
                   (!enabled("Tasks.search")   || this.searchDate === today) &&
                   GM_getValue("Config.dailySetDone", 0) === today &&
                   GM_getValue("Config.punchCardBgDone", 0) === today;
        },

        // 跨实例运行锁（尽力而为）：crontab 每 20 分钟触发一次新脚本实例，
        // 而一轮 runAll 可能耗时数分钟到二十分钟。用共享 storage 加锁，
        // 防止两个实例重叠执行造成重复搜索/上报。写入后回读校验降低竞态窗口；
        // 锁记录含 {token, expire, lastBeat, acquiredAt}，持有者有效性按上述
        // 三条接管判据综合判定，任何"永久占用"形态（含卡死但仍在心跳）都被兜住。
        _acquireRunLock(expireMs = RUN_LOCK_EXPIRE_MS) {
            try {
                const key = "Config.runLock";
                const now = Date.now();
                const cur = GM_getValue(key, null);
                if (cur && typeof cur.expire === "number" && cur.token) {
                    // 旧版本锁记录无 lastBeat/acquiredAt：expire 总在"续期时刻+窗口"
                    // 写入，据此回推最近一次写入时间；acquiredAt 缺失不参与上限判定。
                    const beat = typeof cur.lastBeat === "number" ? cur.lastBeat : cur.expire - RUN_LOCK_EXPIRE_MS;
                    const held = typeof cur.acquiredAt === "number" ? now - cur.acquiredAt : -1;
                    const expireSane = cur.expire - now <= expireMs * 2;
                    const alive = cur.expire > now && expireSane &&
                        now - beat <= RUN_LOCK_STALE_BEAT_MS &&
                        !(held > RUN_LOCK_MAX_HOLD_MS);
                    // 无论让出还是接管，都记录持有者画像，供排查"谁在占锁"
                    const detail = `持有者 ${String(cur.token).slice(0, 8)}…，` +
                        `心跳 ${Math.max(0, Math.round((now - beat) / 1000))} 秒前，` +
                        `已持有 ${held >= 0 ? `${Math.max(0, Math.round(held / 60000))} 分钟` : "?"}，` +
                        `锁剩余 ${Math.max(0, Math.round((cur.expire - now) / 60000))} 分钟${expireSane ? "" : "（过期时间异常）"}`;
                    if (alive) {
                        Utils.log("🟡", `运行锁仍有效（${detail}）`);
                        return null; // 另一实例持有有效锁
                    }
                    Utils.log("🟡", `运行锁已失效，直接接管（${detail}）`);
                }
                const token = Utils.getRandomUUID();
                GM_setValue(key, { token, expire: now + expireMs, lastBeat: now, acquiredAt: now });
                const after = GM_getValue(key, null);
                if (after && after.token && after.token !== token) return null; // 被并发实例覆盖，让出
                return token;
            } catch (_) {
                return Utils.getRandomUUID(); // 存储异常时不阻断任务（无锁运行）
            }
        },

        // 释放运行锁：仅当锁仍归属本实例时清除，避免误删他人持有的锁
        _releaseRunLock(token) {
            try {
                if (!token) return;
                const cur = GM_getValue("Config.runLock", null);
                if (cur && cur.token === token) GM_setValue("Config.runLock", null);
            } catch (_) {}
        },

        // 续期运行锁：仅当锁仍归属本实例时延长过期时间并刷新心跳戳。
        // 返回 false 表示"本实例不应再持有锁"（被他人接管，或总持有超过
        // 上限判定卡死），调用方（心跳计时器）据此自停——卡死轮次的心跳
        // 不会把锁永久续下去；存储读写异常时返回 true，维持无锁运行的宽容语义。
        _renewRunLock(token) {
            try {
                if (!token) return false;
                const cur = GM_getValue("Config.runLock", null);
                if (!(cur && cur.token === token)) return false; // 锁已被他人接管，不再触碰
                const now = Date.now();
                const acquiredAt = typeof cur.acquiredAt === "number" ? cur.acquiredAt : now;
                if (now - acquiredAt > RUN_LOCK_MAX_HOLD_MS) {
                    Utils.log("🟡", `运行锁持有已超 ${Math.round(RUN_LOCK_MAX_HOLD_MS / 60000)} 分钟，判定本轮卡死，停止续期（锁将自动让出）`);
                    return false;
                }
                GM_setValue("Config.runLock", { token, expire: now + RUN_LOCK_EXPIRE_MS, lastBeat: now, acquiredAt });
                return true;
            } catch (_) {
                return true;
            }
        },

        async runAll() {
            if (this.running) {
                Utils.log("🟡", "任务正在运行中，请勿重复触发");
                return;
            }
            this.running = true;
            const runLock = this._acquireRunLock();
            try {
            if (!runLock) {
                Utils.log("🟡", "检测到另一脚本实例正在运行（运行锁），本轮跳过");
                return;
            }
            // 运行锁心跳：运行中每 5 分钟续期，长任务（含最大搜索间隔配置）不会被
            // 误判过期；实例意外终止后心跳停止，锁在心跳失联窗口内被接管。
            // 续期被拒（锁被接管或总持有达上限）时计时器自停，卡死轮次不再永久锁死后台。
            this._lockHeartbeat = setInterval(() => {
                if (!this._renewRunLock(runLock)) {
                    clearInterval(this._lockHeartbeat);
                    this._lockHeartbeat = null;
                }
            }, RUN_LOCK_HEARTBEAT_MS);
            RewardsAuto.state.startTime = Utils.getTimestamp();
            Utils.log("🚀", "启动全能自动化任务...");
            this.init();

            // 空闲短路：今日任务全部完成后，本轮直接结束（零请求）。
            // 不在空闲轮续期 Token——每天第一个非空闲轮次本就会续期，
            // 若在此处续期，一旦 refresh_token 失效会每 20 分钟触发一次
            // 完整授权流程（开标签页+等待 90 秒），严重打扰用户。
            if (this._isIdle()) {
                Utils.log("💤", "今日任务已全部完成，本轮跳过（明日 0 点自动恢复）");
                return;
            }

            // 记录初始积分
            const startBalance = await API.getBalance();
            Utils.log("📊", `初始积分: ${startBalance}`);

            const regionOK = await API.checkRegion();
            
            // Token 续期
            let isTokenOK = false;
            if (regionOK) {
                isTokenOK = await API.renewToken();
                if (!isTokenOK) {
                    Utils.log("🟡", "Token失败，跳过签入/阅读", true);
                }
            } else {
                Utils.log("🔴", "IP非国内，已暂停全部任务", true);
                return;
            }

            // setTimeout 重试机制
            const retryDelay = 60000; // 重试间隔 60 秒
            const maxRetries = 2;

            const withRetry = async (taskFn, taskName, retries = 0) => {
                try {
                    const result = await taskFn();
                    if (result === false && retries < maxRetries) {
                        Utils.log("🟡", `${taskName} 失败，${retryDelay/1000}秒后重试 (${retries + 1}/${maxRetries})`);
                        await Utils.delay(retryDelay);
                        return withRetry(taskFn, taskName, retries + 1);
                    }
                    return result;
                } catch (e) {
                    if (retries < maxRetries) {
                        Utils.log("🟡", `${taskName} 异常: ${e.message}，${retryDelay/1000}秒后重试`);
                        await Utils.delay(retryDelay);
                        return withRetry(taskFn, taskName, retries + 1);
                    }
                    Utils.log("🔴", `${taskName} 失败: ${e.message}`);
                    return false;
                }
            };

            // 仅捕获异常、不自动重试。doSearch/doStreak/doDailySet/doPunchCard 返回 false
            // 通常表示"本轮正常推进、下轮继续"（配额未满/部分完成），并非瞬时失败；
            // 用 withRetry 会各多跑 2 次、放大请求量，反滥用风险更高。
            const runOnce = async (taskFn, taskName) => {
                try {
                    return await taskFn();
                } catch (e) {
                    Utils.log("🔴", `${taskName} 异常: ${e.message}`);
                    return false;
                }
            };

            if (regionOK && isTokenOK) {
                await withRetry(() => this.doSign(), "签到");
                await Utils.randomDelay();
                // v3.6.10：阅读不再被 pc401 连坐。doRead 走 DAPI（Token）通道，与
                // PC 网页会话 cookie 无关；而 PC 签入依赖的 legacy reportActivity
                // 路径已随站点改版下线（已登录页面同源请求同样 401、页面已无
                // RequestVerificationToken），用它判"会话过期"会误伤每日阅读。
                await withRetry(() => this.doRead(), "阅读");
                await Utils.randomDelay();
            } else if (regionOK) {
                // Token（DAPI）失败时仍尝试 web 路径（App 静默签入在 doSign 内部）。
                // v3.6.10：去掉"pc401 → Cookie 已过期请重新登录"的提示——实测 legacy
                // 签入接口已下线（真实登录页面同样 401），该 401 不再能证明会话状态。
                await withRetry(() => this.doSign(), "签到");
                await Utils.randomDelay();
            }

            // doPromos 也走 runOnce：其失败语义（扫描失败/部分未确认）由"连续 N 次放弃"计数
            // 跨轮次处理，一轮内 withRetry 会把放弃计数单轮冲到 3 并对未确认卡片重复全量上报。
            await runOnce(() => this.doPromos(), "活动卡片");
            await Utils.randomDelay();

            await runOnce(() => this.doSearch(), "搜索");

            // 连签任务检测
            await runOnce(() => this.doStreak(), "连签检测");
            await Utils.randomDelay();

            Utils.log("📅", "开始执行每日活动任务...");
            const dailySetOk = await runOnce(() => this.doDailySet(), "每日活动");
            if (dailySetOk === false) {
                // 记录跨轮次失败次数用于诊断，但不伪造“已完成”状态。
                const savedFailRec = GM_getValue("Config.dailySetFail", null);
                const failRec = savedFailRec && typeof savedFailRec === "object"
                    ? savedFailRec
                    : { date: 0, count: 0 };
                const fails = failRec.date === RewardsAuto.state.dateNowNum ? (Number(failRec.count) || 0) + 1 : 1;
                GM_setValue("Config.dailySetFail", { date: RewardsAuto.state.dateNowNum, count: fails });
                Utils.log("🟡", `每日活动本轮未能确认完成（连续 ${fails} 轮），保留待重试状态`);
            } else if (dailySetOk === true) {
                GM_setValue("Config.dailySetFail", { date: RewardsAuto.state.dateNowNum, count: 0 });
            }

            // 打卡任务（后台 XHR 模拟点击子任务链接）
            await Utils.randomDelay();
            await runOnce(() => this.doPunchCard(), "打卡任务");

            // 领取待领取积分
            try {
                await this.doClaimPoints();
            } catch (e) {
                Utils.log("🟡", `领取积分执行异常: ${e.message}`);
            }

            // 二次扫描机制（来自Python版）：完成一轮任务后再次扫描新解锁的卡片
            Utils.log("🔄", "二次扫描：检查是否有新解锁的卡片...");
            await Utils.randomDelay(3000, 8000);
            const newCards = await API.discoverCards();
            if (newCards === null) {
                Utils.log("🟡", "二次扫描失败，稍后由下次运行继续检查");
            } else if (newCards.length > 0) {
                Utils.log("🧩", `二次扫描发现 ${newCards.length} 个新卡片`);
                let ok = 0, fail = 0;
                const claimedIds = new Set();
                const failedIds = [];
                // 与 doPromos 一致：当日已放弃的卡片不再重复上报
                const giveUpIds = this._givenUpOfferIds();
                for (const card of newCards) {
                    if (giveUpIds.has(card.offerId)) continue;
                    Utils.log("  ", `[${card.kind}] ${card.title} +${card.points}p`);
                    if (card.kind === "quiz" && !GM_getValue("Tasks.quiz", true)) continue;
                    await Utils.randomDelay(3000, 8000);
                    const result = await API.claimCard(card);
                    result ? ok++ : fail++;
                    if (result) claimedIds.add(card.offerId);
                    else failedIds.push(card.offerId);
                }
                // v4.1.1：与 doPromos 同语义——失败卡计入放弃账本；仍有失败且未达
                // 上限的卡片时重置 promosDate（下轮重试），达上限的当日放弃、不再阻塞落账。
                const secondGivenUp = this._recordFailedClaims(failedIds);
                const secondPending = failedIds.filter(id => !secondGivenUp.includes(id));
                if (secondPending.length > 0) {
                    this.promosDate = 0;
                    this.save();
                }
                // 与 doPromos 相同的领取后复核：2xx 不等于到账。
                // 未确认卡片计入放弃计数；仅当仍有未达上限的未确认卡时才重置 promosDate
                //（交回 doPromos 的重试/放弃机制处理），达上限的当日放弃、不再阻塞落账，
                // 避免"二次扫描领取未到账→当日被永久跳过"的缺口。
                if (claimedIds.size > 0) {
                    await Utils.randomDelay(4000, 8000);
                    // 复核必须绕过轮内缓存（fresh），同 doPromos
                    const recheck = await API.discoverCards({ fresh: true });
                    if (Array.isArray(recheck)) {
                        const { retryable } = this._countUnconfirmed(recheck, claimedIds);
                        if (retryable.length > 0) {
                            this.promosDate = 0;
                            this.save();
                        }
                    }
                }
                Utils.log("🔵", `二次扫描完成: ${ok}成功/${fail}失败`);
            } else {
                Utils.log("✅", "二次扫描：无新卡片");
            }

            // 任务完成汇总
            const endTime = Utils.getTimestamp();
            const totalTime = ((endTime - RewardsAuto.state.startTime) / 1000).toFixed(1);

            // 查询最终积分
            const endBalance = await API.getBalance();
            const earned = (startBalance > 0 && endBalance > 0) ? (endBalance - startBalance) : 0;

            // 汇总必须反映本轮执行后的最新进度，绕过轮内缓存
            const info = await API.getRewardsInfo(3, { fresh: true });
            if (info) {
                // 构建简洁日志
                const signOk = this.signDate === RewardsAuto.state.dateNowNum;
                const readOk = this.readDate === RewardsAuto.state.dateNowNum;
                const searchOk = info.pc.progress >= info.pc.max;
                const promosOk = this.promosDate === RewardsAuto.state.dateNowNum;

                let logMsg = `签到\t\t${signOk ? '✅' : '❌'}\n`;
                logMsg += `阅读\t\t${readOk ? '✅' : '❌'} ${info.readProgress || 0}/${info.readMax || 30}\n`;
                logMsg += `PC 搜索\t${searchOk ? '✅' : '⏳'} ${info.pc.progress}/${info.pc.max}\n`;
                logMsg += `活动卡片\t${promosOk ? '✅' : '❌'}\n`;
                logMsg += `连签\t\t${this.streakDays || 0} 天\n`;
                logMsg += `今日获取\t+${earned}\n`;
                logMsg += `总积分\t\t${info.balance || endBalance}`;

                // 发送通知
                RewardsAuto.state.sendMSG = logMsg;
                Utils.log("📊", logMsg, true);
            } else {
                Utils.log("🎉", `任务执行完成！用时 ${totalTime} 秒`, true);
            }
            } finally {
                clearInterval(this._lockHeartbeat);
                this._releaseRunLock(runLock);
                this.running = false;
            }
        }
    };

    // v4.1.0：前台页面侧处理器已随同源转发通道退役。rewards 页 DOM 自动领取/
    // 每日活动点击由 Server Action 兜底链与 App 上报取代，不再需要页面内代码。

    GM_registerMenuCommand("🔑 手动授权", () => {
        GM_openInTab("https://login.live.com/oauth20_authorize.srf?client_id=0000000040170455&response_type=code&scope=service::prod.rewardsplatform.microsoft.com::MBI_SSL&redirect_uri=https://login.live.com/oauth20_desktop.srf", { active: true });
    });

    GM_registerMenuCommand("📋 粘贴授权码", () => {
        const code = prompt("粘贴授权页面跳转后的完整URL:");
        if (code?.trim()) {
            GM_setValue("Config.code", code.trim());
            alert("已保存！");
        }
    });

    GM_registerMenuCommand("📊 Token状态", () => {
        const token = GM_getValue("Config.token", false);
        const time = GM_getValue("Config.tokenTime", 0);
        let ageStr = "未知";
        if (time > 0) {
            const diff = Utils.getTimestamp() - time;
            const days = Math.floor(diff / 86400000);
            const hours = Math.floor((diff % 86400000) / 3600000);
            const minutes = Math.floor((diff % 3600000) / 60000);
            const parts = [];
            if (days > 0) parts.push(`${days}天`);
            if (hours > 0) parts.push(`${hours}小时`);
            parts.push(`${minutes}分钟`);
            ageStr = parts.join("");
        }
        const tokenDate = time > 0 ? new Date(time).toLocaleString("zh-CN") : "未知";
        alert(`Token: ${token ? "已保存" : "无"}\n获取时间: ${tokenDate}\n已过: ${ageStr}\n授权码: ${GM_getValue("Config.code", "") ? "有" : "无"}`);
    });

    GM_registerMenuCommand("🚀 立即运行", () => TaskManager.runAll());

    // v3.6.9：refresh_token 仍活着时脚本永远不会主动用授权码换新 Token（设计上避免
    // 反复打扰授权）；想用刚粘贴的授权码彻底重建登录态，点这个清除旧 Token 即可。
    GM_registerMenuCommand("🔁 强制用授权码换取新Token", () => {
        if (!GM_getValue("Config.code", "")) {
            alert("未检测到已保存的授权码。请先「🔑 手动授权」完成授权，再用「📋 粘贴授权码」保存跳转后的完整URL。");
            return;
        }
        GM_setValue("Config.token", false);
        Utils.log("🟡", "已清除旧 Token，下一轮将使用粘贴的授权码重新换取（也可点「🚀 立即运行」马上执行）");
    });

    // 通知接口配置菜单
    GM_registerMenuCommand("🔔 配置通知接口", () => {
        const configNames = [
            { key: "Notice.wework", name: "企业微信 Webhook", hint: "群机器人webhook key" },
            { key: "Notice.dingding", name: "钉钉机器人 Access Token", hint: "不加签，关键词需包含 #" },
            { key: "Notice.feishu", name: "飞书机器人 Webhook", hint: "不加签，关键词需包含 #" },
            { key: "Notice.pushme", name: "PushMe Key", hint: "push.i-i.me 推送key" },
            { key: "Notice.bark", name: "Bark Key", hint: "bark.day.app 推送key" }
        ];
        
        let configStr = "🔔 通知接口配置\n";
        configStr += "==================\n\n";
        configNames.forEach((item, index) => {
            const saved = GM_getValue(item.key, "");
            configStr += `${index + 1}. ${item.name}\n`;
            configStr += `   状态: ${saved ? "✅ 已配置" : "❌ 未配置"}\n`;
            configStr += `   说明: ${item.hint}\n\n`;
        });
        configStr += "请输入要配置的编号 (1-5)，或输入 0 清除所有配置：";
        
        const choice = prompt(configStr);
        if (!choice) return;
        
        const num = parseInt(choice);
        if (num === 0) {
            if (confirm("确定要清除所有通知接口配置吗？")) {
                configNames.forEach(item => GM_setValue(item.key, ""));
                alert("所有通知接口配置已清除！");
            }
            return;
        }
        
        if (num >= 1 && num <= 5) {
            const selected = configNames[num - 1];
            const current = GM_getValue(selected.key, "");
            const newValue = prompt(`配置 ${selected.name}\n\n当前值: ${current || "(空)"}\n\n请输入新的值：`, current);
            if (newValue !== null) {
                GM_setValue(selected.key, newValue.trim());
                alert(`${selected.name} 已${newValue.trim() ? "配置" : "清除"}！`);
            }
        } else {
            alert("无效的编号！");
        }
    });

    // 各推送渠道独立开关（默认关闭；即使已配置 key，也需开启对应开关才会推送）
    [
        { key: "Notice.wework_on", name: "企业微信" },
        { key: "Notice.dingding_on", name: "钉钉" },
        { key: "Notice.feishu_on", name: "飞书" },
        { key: "Notice.pushme_on", name: "PushMe" },
        { key: "Notice.bark_on", name: "Bark" },
    ].forEach(ch => {
        GM_registerMenuCommand(GM_getValue(ch.key, false) ? `📢 ${ch.name}推送: 开` : `📢 ${ch.name}推送: 关`, () => {
            const cur = GM_getValue(ch.key, false);
            GM_setValue(ch.key, !cur);
            alert(`${ch.name}推送已${!cur ? "开启" : "关闭"}${!cur ? "（请确认已在「配置通知接口」中填写 key）" : ""}`);
        });
    });

    GM_registerMenuCommand("📢 测试通知", () => {
        RewardsAuto.state.sendMSG = "🧪 这是一条测试消息\n如果你看到这条消息，说明通知接口配置成功！";
        Utils.log("📢", "测试通知已发送", true, true);
        alert("测试消息已发送，请检查各通知渠道！");
    });

    // 浏览器通知静默开关
    const updateBroMenu = () => {
        const enabled = GM_getValue("Notice.bro", true);
        return enabled ? "🔕 关闭浏览器通知" : "🔔 开启浏览器通知";
    };
    GM_registerMenuCommand(updateBroMenu(), () => {
        const current = GM_getValue("Notice.bro", true);
        GM_setValue("Notice.bro", !current);
        alert(`浏览器通知已${!current ? "开启" : "关闭"}`);
        location.reload();
    });

    // 调试模式开关：输出每日活动原始字段/前台 DOM 样例，用于定位上报与点击问题
    GM_registerMenuCommand(GM_getValue("Config.debugDailySet", false) ? "🐛 关闭调试日志" : "🐛 开启调试日志", () => {
        const cur = GM_getValue("Config.debugDailySet", false);
        GM_setValue("Config.debugDailySet", !cur);
        alert(`调试日志已${!cur ? "开启" : "关闭"}`);
    });

    // 任务全部完成后是否停止循环（开启后：签到/阅读/活动/搜索/每日活动全部完成则不再运行）
    GM_registerMenuCommand(GM_getValue("Config.keep", true) ? "💤 完成后停止循环: 关" : "💤 完成后停止循环: 开", () => {
        const keep = GM_getValue("Config.keep", true);
        GM_setValue("Config.keep", !keep);
        // 提示语基于切换后的"停止循环"状态：keep=true（继续循环）⇔ 停止循环关闭
        alert(keep
            ? "已开启「完成后停止循环」：今日任务全部完成后将不再重复运行"
            : "已关闭「完成后停止循环」：任务完成后仍会每20分钟检查一次");
    });

    GM_registerMenuCommand("📋 查看通知状态", () => {
        const channels = [
            { name: "企业微信", key: "Notice.wework" },
            { name: "钉钉", key: "Notice.dingding" },
            { name: "飞书", key: "Notice.feishu" },
            { name: "PushMe", key: "Notice.pushme" },
            { name: "Bark", key: "Notice.bark" },
        ];
        let status = "📊 通知接口配置状态：\n\n";
        channels.forEach(c => {
            const configured = !!GM_getValue(c.key, "");
            const on = GM_getValue(c.key + "_on", false);
            status += `${c.name}: ${configured ? "✅已配置" : "❌未配置"} | 推送${on ? "🔔开" : "🔕关"}\n`;
        });
        status += `\n浏览器通知: ${GM_getValue("Notice.bro", true) ? "🔔开" : "🔕关"}`;
        alert(status);
    });

    const init = () => {
        TaskManager.init();

        // 检查今日任务是否已完成
        const isKeep = GM_getValue("Config.keep", true);
        const checkDone = (enabled, date) => !enabled || date === RewardsAuto.state.dateNowNum;
        const isAllDone = checkDone(GM_getValue("Tasks.sign", true), TaskManager.signDate) &&
                          checkDone(GM_getValue("Tasks.read", true), TaskManager.readDate) &&
                          checkDone(GM_getValue("Tasks.promos", true), TaskManager.promosDate) &&
                          checkDone(GM_getValue("Tasks.search", true), TaskManager.searchDate) &&
                          GM_getValue("Config.dailySetDone", 0) === RewardsAuto.state.dateNowNum;

        if (!isKeep && isAllDone) {
            Utils.log("💤", "今日任务已全部完成");
            return;
        }

        // 【防封号核心】随机延迟启动，避免定时器特征。
        // 后台 crontab 受执行时间预算限制，缩短随机等待；前台页面保持 5-95 秒。
        // 与 renewToken 的同款修正：ScriptCat crontab 可能在带 document 的 sandbox 页面
        // 中执行（实测日志 "⏳ 54.731秒后启动... {env:service_worker}"），以主机名为准。
        const isBackground = typeof document === "undefined" || !/(^|\.)bing\.com$/.test(location.hostname || "");
        const delay = isBackground ? Utils.randomRange(2000, 5000) : Utils.randomRange(5000, 95000);
        Utils.log("⏳", `${delay/1000}秒后启动...`);
        setTimeout(() => TaskManager.runAll(), delay);
    };

    // 清除可能影响搜索的 Cookie（后台 crontab 或引擎不支持时静默跳过，
    // 避免顶层异常导致整次定时运行中断、签到全停）
    try { GM_cookie("delete", { url: "https://bing.com", name: "_EDGE_S" }); } catch (_) {}

    // ====== 后台模式入口 ======
    init();

})();



