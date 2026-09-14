// ==UserScript==
// @name         微软积分商城签到（重构版）
// @version      1.0.0
// @description  每天在后台自动完成 Microsoft Rewards 任务获取积分奖励，✅签入(PC+App静默)、✅阅读、✅活动、✅搜索、✅Quiz、✅拼图、✅热搜API、✅二次扫描、✅积分通知、✅连签任务检测、✅每日活动自动上报
// @author       kunkun
// @icon         https://bing.com/th?id=OMR.icon-96.png&pid=Rewards
// @homepage     https://scriptcat.org/zh-CN/script-show-page/7869
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
// @storageName  BingRewardsAuto_Shared
// @tips         此脚本为开源免费使用，请勿购买
// ==/UserScript==

/* global GM_cookie, GM_getValue, GM_setValue, GM_xmlhttpRequest, GM_log, GM_info, GM_notification, GM_openInTab */

/* ==UserConfig==
Config:
    keep:
        title: 持续检测（全部完成后是否继续）
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
    dingding:
        title: 钉钉群机器人（不加签，关键词：#）
        type: text
        password: true
        description: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    feishu:
        title: 飞书群机器人（不加签，关键词：#）
        type: text
        password: true
        description: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    pushme:
        title: PushMe（push.i-i.me）
        type: text
        password: true
        description: xxxxxxxxxxxxxxxxxxxx
    bark:
        title: Bark（bark.day.app）
        type: text
        password: true
        description: xxxxxxxxxxxxxxxxxxxx
==/UserConfig== */

(function() {
    'use strict';

    // 授权码自动捕获
    if (location.hostname === "login.live.com" && location.pathname === "/oauth20_desktop.srf") {
        const code = new URLSearchParams(location.search).get("code");
        if (code) {
            GM_setValue("Config.code", location.href);
            GM_setValue("Config.token", false);
            if (GM_getValue("Notice.bro", true)) {
                try { GM_notification({ title: "🟢 授权成功", text: "授权码已捕获，可关闭此页" }); } catch(_) {}
            }
            try { history.replaceState({}, "", "about:blank"); } catch(_) {}
            setTimeout(() => { try { window.close(); } catch(_) {} }, 200);
        }
        return;
    }

    const RewardsAuto = {
        // UA: pc=Edge桌面, mobile=Edge移动, app=BingSapphire真机抓包
        ua: {
            pc: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
            mobile: "Mozilla/5.0 (Linux; Android 16; Redmi K20 Pro Build/BP4A.251205.006; ) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/144.0.7559.132 Mobile Safari/537.36 EdgA/131.0.0.0",
            // App 端 UA（来自真实抓包数据，Redmi K20 Pro + BingSapphire）
            app: "Mozilla/5.0 (Linux; Android 16; Redmi K20 Pro Build/BP4A.251205.006; ) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/144.0.7559.132 Mobile Safari/537.36 BingSapphire/32.6.2110003560",
        },
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
            mode: GM_getValue("Config.api", "offline"),
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
            pcMax: 90,
            readProgress: 0,
            readMax: 30,
            sendMSG: "",
            lastSearchProgress: -1,
            restrictedTimes: 0,
            ip: "",
            ipInfo: "",
            startTime: 0,
        }
    };

    const Webhooks = [
        {
            name: "企业微信",
            url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=",
            key: GM_getValue("Notice.wework", false),
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
            key: GM_getValue("Notice.dingding", false),
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
            key: GM_getValue("Notice.feishu", false),
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
            key: GM_getValue("Notice.pushme", false),
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
            key: GM_getValue("Notice.bark", false),
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
        log(icon, msg, push = false) {
            GM_log(`${icon} ${msg}`);
            if (push && GM_getValue("Notice.bro", true)) {
                try {
                    GM_notification({
                        title: GM_info.script.name + ` ${icon}`,
                        text: msg,
                        onclick: () => GM_openInTab("https://rewards.bing.com/dashboard", { active: true })
                    });
                } catch(_) {}
            }
            // 发送到外部通知接口
            if (push) {
                RewardsAuto.state.sendMSG = `${icon} ${msg}`;
                this.sendWebhook();
            }
        },

        // 非国内 IP 仅在当天首次检测到时通知，避免定时任务重复弹窗。
        notifyNonDomesticIp(message = "IP非大陆，已暂停全部任务") {
            const noticeKey = "Config.ipPauseNoticeDate";
            const today = this.getTodayNum();
            if (GM_getValue(noticeKey, 0) === today) {
                GM_log("🟡 非大陆 IP 通知今日已发送，跳过重复通知");
                return false;
            }

            GM_setValue(noticeKey, today);
            this.log("🔴", message, true);
            return true;
        },

        // 发送webhook通知
        async sendWebhook() {
            await Promise.all(Webhooks.map(async (i) => {
                if (!i.key) return;
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

        // 封装 GM_xmlhttpRequest，15秒超时，支持重定向
        xhr(options) {
            return new Promise((resolve, reject) => {
                const start = Date.now();
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
                            resolve(match ? match[1] : false);
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

        randomRange(min, max) {
            return Math.floor(Math.random() * (max - min + 1) + min);
        },

        getTimestamp() {
            return Date.now();
        },

        getTodayNum() {
            const d = new Date();
            return Number(`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`);
        },

        getTodayStr() {
            const d = new Date();
            return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}`;
        },

        getRandomUUID() {
            return crypto.randomUUID().replace(/-/g, "").toUpperCase();
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

        waitForElement(selector, timeout = 30000) {
            return new Promise((resolve, reject) => {
                const element = document.querySelector(selector);
                if (element) return resolve(element);

                const observer = new MutationObserver((_, obs) => {
                    const el = document.querySelector(selector);
                    if (el) { obs.disconnect(); resolve(el); }
                });
                observer.observe(document.body, { childList: true, subtree: true });

                setTimeout(() => {
                    observer.disconnect();
                    const el = document.querySelector(selector);
                    el ? resolve(el) : reject(new Error(`等待元素超时: ${selector}`));
                }, timeout);
            });
        },

        waitForElementsByText(containerSelector, textPatterns, timeout = 30000) {
            return new Promise((resolve, reject) => {
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

                const found = findElements();
                if (found.length > 0) return resolve(found);

                const observer = new MutationObserver((_, obs) => {
                    const found = findElements();
                    if (found.length > 0) { obs.disconnect(); resolve(found); }
                });
                observer.observe(document.body, { childList: true, subtree: true });

                setTimeout(() => {
                    observer.disconnect();
                    const found = findElements();
                    found.length > 0 ? resolve(found) : reject(new Error("等待文本元素超时"));
                }, timeout);
            });
        }
    };

    const API = {
        async getToken(url, maxRetries = 3) {
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const res = await Utils.xhr({ url });
                    if (!Utils.isJSON(res)) {
                        if (attempt < maxRetries) {
                            await Utils.delay(3210);
                            continue;
                        }
                        return false;
                    }
                    const data = JSON.parse(res);
                    if (data.error) {
                        Utils.log("🔴", `Token错误: ${data.error} - ${data.error_description || ''}`);
                        if (["invalid_grant","invalid_request"].includes(data.error)) {
                            GM_setValue("Config.token", false);
                            GM_setValue("Config.code", "");
                        }
                        return false;
                    }
                    if (data.refresh_token && data.access_token) {
                        GM_setValue("Config.token", data.refresh_token);
                        GM_setValue("Config.tokenTime", Utils.getTimestamp());
                        RewardsAuto.state.token = data.access_token;
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
                    Utils.log("🟡", "Token 过期，强制重新授权...");
                    RewardsAuto.state.token = null;
                    GM_setValue("Config.token", false);
                    GM_setValue("Config.tokenTime", 0);
                    const refreshed = await this.renewToken();
                    if (!refreshed) return null;
                    return await requestFn(RewardsAuto.state.token);
                }
                throw e;
            }
        },

        async renewToken() {
            if (!GM_getValue("Tasks.sign", true) && !GM_getValue("Tasks.read", true)) return true;
            
            let refreshToken = GM_getValue("Config.token", false);
            const tokenTime = GM_getValue("Config.tokenTime", 0);
            
            // Token 超过 7 天提前续期
            if (tokenTime > 0) {
                const days = (Utils.getTimestamp() - tokenTime) / (1000 * 60 * 60 * 24);
                if (days > 7) {
                    Utils.log("🟡", `Token已${Math.floor(days)}天，提前续期`);
                    refreshToken = false;
                }
            }

            const authUrl = "https://login.live.com/oauth20_authorize.srf?client_id=0000000040170455&response_type=code&scope=service::prod.rewardsplatform.microsoft.com::MBI_SSL&redirect_uri=https://login.live.com/oauth20_desktop.srf";

            // 自动获取授权码，失败时再打开授权页让用户手动处理
            const fetchCode = async (msg) => {
                GM_setValue("Config.code", "");
                Utils.log("🟡", `${msg}，尝试自动获取授权码...`);
                
                try {
                    const res = await new Promise((resolve, reject) => {
                        GM_xmlhttpRequest({
                            method: "GET",
                            url: authUrl,
                            headers: { "User-Agent": navigator.userAgent },
                            onload: (r) => resolve(r),
                            onerror: () => reject(new Error("请求失败")),
                            ontimeout: () => reject(new Error("超时")),
                            timeout: 15000
                        });
                    });
                    const finalUrl = res.finalUrl || "";
                    const code = new URL(finalUrl).searchParams.get("code");
                    if (code) {
                        Utils.log("🟢", "自动获取授权码成功");
                        return [code];
                    }
                } catch (e) {
                    Utils.log("🟡", `自动获取失败: ${e.message}`);
                }

                Utils.log("🟡", "请手动完成授权...");
                GM_openInTab(authUrl, { active: true, insert: true, setParent: true });

                if (GM_getValue("Notice.bro", true)) {
                    try {
                        GM_notification({
                            text: "完成后粘贴地址栏URL到脚本设置的「授权码链接」",
                            title: "🟡 需要授权", timeout: 0
                        });
                    } catch(_) {}
                }

                // 等待用户粘贴或授权页自动捕获授权码（最长 3 分钟）
                for (let i = 0; i < 180; i++) {
                    await Utils.delay(1000);
                    const raw = GM_getValue("Config.code", "");
                    if (!raw) continue;

                    let code = null;
                    if (raw.includes("code=")) {
                        try {
                            const url = new URL(raw);
                            code = url.searchParams.get("code");
                        } catch {}
                    }
                    if (!code && raw.length > 20 && !raw.includes("http")) {
                        code = raw.trim();
                    }

                    if (code && code.length > 10) {
                        Utils.log("🟢", "授权码获取成功");
                        return [code];
                    }
                }
                Utils.log("🔴", "授权码获取超时", true);
                return false;
            };

            // 根据是否有 refreshToken 决定获取方式
            if (!refreshToken) {
                const codeMatch = await fetchCode("检测到授权码为空");
                if (!codeMatch) return false;
                const url = `https://login.live.com/oauth20_token.srf?client_id=0000000040170455&code=${encodeURIComponent(codeMatch[0])}&redirect_uri=https://login.live.com/oauth20_desktop.srf&grant_type=authorization_code`;
                const token = await this.getToken(url);
                if (!token) {
                    const retry = await fetchCode("授权码失效");
                    if (!retry) return false;
                    return await this.renewToken();
                }
                Utils.log("🟢", "Token获取成功！", true);
                return true;
            } else {
                const url = `https://login.live.com/oauth20_token.srf?client_id=0000000040170455&refresh_token=${encodeURIComponent(refreshToken)}&scope=service::prod.rewardsplatform.microsoft.com::MBI_SSL&grant_type=REFRESH_TOKEN`;
                const token = await this.getToken(url);
                if (!token) {
                    const retry = await fetchCode("Token失效");
                    if (!retry) return false;
                    return await this.renewToken();
                }
                return true;
            }
        },

        // 优先从 earn 页面“今日积分”表格解析，DAPI 只做兜底
        async getRewardsInfo(maxRetries = 3) {
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const html = await Utils.xhr({ url: "https://rewards.bing.com/earn" });
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

                    return {
                        balance,
                        pc: { progress: pcCur, max: pcMax },
                        mobile: { progress: mobCur, max: mobMax },
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
            const region = GM_getValue("Config.lock", true) ? "cn" : RewardsAuto.state.region.toLowerCase();
            try {
                const res = await this.withTokenRetry(token => Utils.xhr({
                    method: "POST",
                    url: "https://prod.rewardsplatform.microsoft.com/dapi/me/activities",
                    headers: {
                        "content-type": "application/json; charset=UTF-8",
                        "user-agent": RewardsAuto.ua.app,
                        "authorization": `Bearer ${token}`,
                        "x-rewards-appid": RewardsAuto.appConfig.rewardsAppId,
                        "x-rewards-ismobile": "true",
                        "x-rewards-country": region,
                        "x-rewards-language": "zh",
                        "x-rewards-partnerid": "startapp",
                        "x-rewards-flights": "rwgobig"
                    },
                    data: JSON.stringify({
                        amount: 1, id: Utils.getRandomUUID().replace(/-/g, '') + Utils.getRandomUUID().replace(/-/g, '').slice(0, 24),
                        type: 103,
                        country: region,
                        channel: RewardsAuto.appConfig.channel
                    })
                }));
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

            return await Utils.xhr({
                method: "POST",
                url: "https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest",
                headers,
                data: params.toString(),
                anonymous: false
            });
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

        async signPC() {
            try {
                const res = await this.reportActivity("Gamification_DailyCheckIn", "1", "https://rewards.bing.com/");
                if (Utils.isJSON(res)) {
                    const data = JSON.parse(res);
                    return Number(data.points || data.response?.activity?.p || 0);
                }
            } catch (e) {
                if (e.message?.includes("401")) RewardsAuto.state.pc401 = true;
                Utils.log("🟡", `PC签入失败: ${e.message}`);
            }
            return -1;
        },

        async appActivity(type, offerid) {
            const region = GM_getValue("Config.lock", true) ? "cn" : RewardsAuto.state.region.toLowerCase();
            const body = {
                amount: 1,
                country: region,
                id: Utils.getRandomUUID().replace(/-/g, '') + Utils.getRandomUUID().replace(/-/g, '').slice(0, 24),
                type: type,
                channel: RewardsAuto.appConfig.channel
            };
            if (offerid) {
                body.attributes = { offerid: offerid };
            }
            try {
                const res = await this.withTokenRetry(token => Utils.xhr({
                    method: "POST",
                    url: "https://prod.rewardsplatform.microsoft.com/dapi/me/activities",
                    headers: {
                        "content-type": "application/json; charset=utf-8",
                        "user-agent": RewardsAuto.ua.app,
                        "authorization": `Bearer ${token}`,
                        "x-rewards-appid": RewardsAuto.appConfig.rewardsAppId,
                        "x-rewards-ismobile": "true",
                        "x-rewards-country": region,
                        "x-rewards-language": "zh"
                    },
                    data: JSON.stringify(body)
                }));
                if (Utils.isJSON(res)) {
                    const data = JSON.parse(res);
                    const points = data.response?.activity?.p || 0;
                    const isDuplicate = data.response?.isDuplicate || false;
                    const balance = data.response?.balance || 0;
                    return { points, isDuplicate, balance };
                }
            } catch (e) {
                Utils.log("🔴", `App活动失败(${offerid}): ${e.message}`);
            }
            return null;
        },

        async getReadProgress() {
            try {
                const res = await this.withTokenRetry(token => Utils.xhr({
                    url: "https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613",
                    headers: {
                        "content-type": "application/json; charset=UTF-8",
                        "user-agent": RewardsAuto.ua.app,
                        "authorization": `Bearer ${token}`,
                        "x-rewards-appid": RewardsAuto.appConfig.rewardsAppId,
                        "x-rewards-ismobile": "true",
                        "x-rewards-country": "cn",
                        "x-rewards-language": "zh"
                    }
                }));
                if (Utils.isJSON(res)) {
                    const promos = JSON.parse(res).response?.promotions || [];
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
                    Utils.log("🟡", `DAPI 响应不是 JSON: ${String(res).substring(0, 100)}`);
                }
            } catch (e) {
                Utils.log("🔴", `阅读进度获取失败: ${e.message}`);
            }
            return false;
        },

        // 获取 RequestVerificationToken（用于 reportactivity API）
        async getRewardsToken() {
            try {
                const html = await Utils.xhr({
                    url: "https://rewards.bing.com/",
                    headers: {
                        "user-agent": RewardsAuto.ua.pc,
                        "referer": "https://rewards.bing.com/"
                    }
                });
                if (html) {
                    const match = html.replace(/\s/g, "").match(/RequestVerificationToken(.*?)value="(.*?)"/);
                    if (match) return match[2];
                }
            } catch (e) {
                Utils.log("🟡", `RequestVerificationToken 获取失败: ${e.message}`);
            }
            return false;
        },

        async getSearchQuotaFromUserInfo() {
            try {
                const res = await Utils.xhr({
                    url: `https://rewards.bing.com/api/getuserinfo?type=1&X-Requested-With=XMLHttpRequest&_=${Date.now()}`,
                    headers: {
                        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                        "user-agent": RewardsAuto.ua.pc,
                        "referer": "https://rewards.bing.com/",
                        "x-requested-with": "XMLHttpRequest"
                    },
                    anonymous: false
                });
                if (!Utils.isJSON(res)) return false;

                const data = JSON.parse(res);
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
                    const readInfo = await API.getReadProgress();
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
        async getSearchQuotaFromAPI() {
            try {
                const res = await this.withTokenRetry(token => Utils.xhr({
                    url: "https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613",
                    headers: {
                        "content-type": "application/json; charset=UTF-8",
                        "user-agent": RewardsAuto.ua.app,
                        "authorization": `Bearer ${token}`,
                        "x-rewards-appid": RewardsAuto.appConfig.rewardsAppId,
                        "x-rewards-ismobile": "true",
                        "x-rewards-country": "cn",
                        "x-rewards-language": "zh"
                    }
                }));
                if (Utils.isJSON(res)) {
                    const data = JSON.parse(res);
                    const response = data.response || {};
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

                    let pcCur = 0, pcMax = 0;
                    if (counters?.pcSearch && counters.pcSearch.length > 0) {
                        pcCur = counters.pcSearch[0].pointProgress || 0;
                        pcMax = counters.pcSearch[0].pointProgressMax || 0;
                    }

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
                        const readInfo = await API.getReadProgress();
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
        async getBalance() {
            // 方法1: DAPI（需要 Token）
            try {
                const res = await this.withTokenRetry(token => Utils.xhr({
                    url: "https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=105",
                    headers: {
                        "content-type": "application/json; charset=UTF-8",
                        "user-agent": RewardsAuto.ua.app,
                        "authorization": `Bearer ${token}`,
                        "x-rewards-appid": RewardsAuto.appConfig.rewardsAppId,
                        "x-rewards-ismobile": "true",
                        "x-rewards-country": "cn",
                        "x-rewards-language": "zh"
                    }
                }));
                if (Utils.isJSON(res)) {
                    const data = JSON.parse(res);
                    return data.response?.balance || 0;
                }
            } catch (e) {}

            // 方法2: getuserinfo API（不需要 Token）
            try {
                const res2 = await Utils.xhr({
                    url: `https://rewards.bing.com/api/getuserinfo?type=1&X-Requested-With=XMLHttpRequest&_=${Date.now()}`,
                    headers: {
                        "user-agent": RewardsAuto.ua.pc,
                        "referer": "https://rewards.bing.com/",
                        "x-requested-with": "XMLHttpRequest"
                    },
                });
                if (Utils.isJSON(res2)) {
                    const data2 = JSON.parse(res2);
                    return data2.dashboard?.availablePoints || data2.balance || 0;
                }
            } catch (e) {}

            return 0;
        },

        // 执行阅读
        async doRead() {
            const region = GM_getValue("Config.lock", true) ? "cn" : RewardsAuto.state.region.toLowerCase();
            try {
                // 生成 64 位 hex ID（无连字符），匹配实际 App 行为
                const id = Utils.getRandomUUID().replace(/-/g, '') + Utils.getRandomUUID().replace(/-/g, '').slice(0, 24);
                const res = await this.withTokenRetry(token => Utils.xhr({
                    method: "POST",
                    url: "https://prod.rewardsplatform.microsoft.com/dapi/me/activities",
                    headers: {
                        "content-type": "application/json; charset=utf-8",
                        "user-agent": RewardsAuto.ua.app,
                        "authorization": `Bearer ${token}`,
                        "x-rewards-appid": RewardsAuto.appConfig.rewardsAppId,
                        "x-rewards-ismobile": "true",
                        "x-rewards-country": region,
                        "x-rewards-language": "zh"
                    },
                    data: JSON.stringify({
                        amount: 1, country: region, id: id,
                        type: 101, attributes: { offerid: RewardsAuto.appConfig.offerIds.readArticle }
                    })
                }));
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
        async discoverCards() {
            const cards = [];
            const seenCardKeys = new Set();
            try {
                const html = await Utils.xhr({ url: "https://rewards.bing.com/earn" });
                if (!html) { Utils.log("🔴", "earn 页面返回空"); return cards; }

                // unescape 版本供 RSC 解析使用
                const clean = html.replace(/\\"/g, '"');

                // ---------- 动态提取 next-action（供 claimCard 使用） ----------
                const naMatch = html.match(/name":"next-action"[^}]*"value":"([a-f0-9]{40,})"/)
                    || html.match(/next-action["']\s*:\s*["']([a-f0-9]{40,})["']/)
                    || clean.match(/"next-action"[^"]*"([a-f0-9]{40,})"/);
                if (naMatch) {
                    RewardsAuto._nextAction = naMatch[1];
                    Utils.log("🟢", `动态 next-action: ${naMatch[1].slice(0, 12)}…`);
                }

                const pushCard = (card) => {
                    if (!card || !card.offerId || !card.hash || card.points <= 0) return;
                    const key = `${card.offerId}:${card.hash}`;
                    if (seenCardKeys.has(key)) return;
                    seenCardKeys.add(key);
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
                    if (isCompleted) return null;

                    const title = titleMatch ? titleMatch[1] : "";

                    const skip = RewardsAuto.skipPatterns.some(p =>
                        title.toLowerCase().includes(p.toLowerCase()) ||
                        offerId.toLowerCase().includes(p.toLowerCase())
                    );
                    if (skip) return null;

                    return { title, points, offerId, hash, kind: inferKind(offerId, title) };
                };

                // ---------- 方法0: getuserinfo 结构化数据 ----------
                try {
                    const userInfo = await Utils.xhr({
                        url: `https://rewards.bing.com/api/getuserinfo?type=1&X-Requested-With=XMLHttpRequest&_=${Date.now()}`,
                        headers: {
                            "user-agent": RewardsAuto.ua.pc,
                            "referer": "https://rewards.bing.com/",
                            "x-requested-with": "XMLHttpRequest"
                        },
                        anonymous: false
                    });
                    if (Utils.isJSON(userInfo)) {
                        const data = JSON.parse(userInfo);
                        const dashboard = data.dashboard || data;
                        const now = new Date();
                        const todayKeys = new Set([
                            `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}/${now.getFullYear()}`,
                            `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`
                        ]);

                        const normalizeDashboardCard = (item, kind) => {
                            if (!item) return null;
                            const offerId = item.offerId || item.offerid || item.id || item.name;
                            const hash = item.hash || item.activityId;
                            const title = item.title || item.name || item.description || "";
                            const points = Number(item.points ?? item.pointProgressMax ?? item.max ?? 0);
                            const doneMax = Number(item.pointProgressMax || 0);
                            const doneCur = Number(item.pointProgress || 0);
                            const isCompleted = item.isCompleted || item.complete || item.completed || (doneMax > 0 && doneCur >= doneMax);
                            if (!offerId || !hash || points <= 0 || isCompleted) return null;
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

                if (cards.length === 0) {
                    // 输出前 500 字符供调试
                    const snippet = clean.slice(0, 500).replace(/[\r\n]+/g, ' ');
                    Utils.log("🟡", `所有方法均未命中，页面前500字符: ${snippet}`);
                }
            } catch (e) {
                Utils.log("🔴", `卡片解析失败: ${e.message}`);
            }
            return cards;
        },

        // 领取卡片奖励（多种策略尝试，兼容所有卡片类型）
        async claimCard(card) {
            const nextAction = RewardsAuto._nextAction || "70babbc81d2724f60d29a95c03b3d739cba77cea92";
            const url = card.url || "https://rewards.bing.com/earn";
            const referer = card.url || "https://rewards.bing.com/";

            // 策略1: reportactivity + RequestVerificationToken（最稳定）
            try {
                const token = await this.getRewardsToken();
                if (token) {
                    await Utils.xhr({
                        method: "POST",
                        url: "https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest",
                        headers: {
                            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                            "user-agent": RewardsAuto.ua.pc,
                            "referer": referer,
                            "origin": "https://rewards.bing.com",
                            "x-requested-with": "XMLHttpRequest"
                        },
                        data: new URLSearchParams({
                            id: card.offerId,
                            hash: card.hash,
                            timeZone: 480,
                            activityAmount: 1,
                            dbs: 0,
                            form: "",
                            type: "",
                            __RequestVerificationToken: token
                        }).toString()
                    });
                    return true;
                }
            } catch (e1) {
                Utils.log("🟡", `reportactivity+token 失败: ${card.offerId}`);
            }

            // 策略2: Server Action（原始 hash）
            try {
                await Utils.xhr({
                    method: "POST", url,
                    headers: { "content-type": "text/plain;charset=UTF-8", "next-action": nextAction, referer },
                    data: JSON.stringify([card.hash, 11, { offerid: card.offerId, isPromotional: "$undefined", timezoneOffset: "-480" }])
                });
                return true;
            } catch (e2) {
                Utils.log("🟡", `Server Action 失败: ${card.offerId}`);
            }

            // 策略3: reportActivity（原始 hash）
            try {
                await this.reportActivity(card.offerId, card.hash, referer);
                return true;
            } catch (e3) {
                Utils.log("🟡", `reportActivity 失败: ${card.offerId}`);
            }

            // 策略4: reportActivity（hash "1"）
            try {
                await this.reportActivity(card.offerId, "1", referer);
                return true;
            } catch (e4) {
                Utils.log("🟡", `卡片领取失败(${card.offerId}): 所有策略均失败`);
                return false;
            }
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

        async reportSearch(html, query, isMobile = false) {
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
                        Utils.notifyNonDomesticIp(`IP非大陆(${RewardsAuto.state.region})，已停止\n${RewardsAuto.state.ipInfo}`);
                        return false;
                    }
                    GM_setValue("Config.ipPauseNoticeDate", 0);
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
                console.debug("获取附加 IP 信息失败");
            }
        },

        async getHotSearchWord() {
            const keywords = ["天气预报", "今日新闻", "体育赛事", "股票行情", "电影推荐", "科技资讯", "美食食谱", "旅游攻略", "历史上的今天", "健康常识"];
            const baseWord = keywords[Utils.randomRange(0, keywords.length - 1)];
            const randomSuffix = Math.random().toString(36).slice(2, 6);
            let sentence = `${baseWord} ${randomSuffix}`;

            if (RewardsAuto.apiConfig.mode !== "offline") {
                if (RewardsAuto.apiConfig.wordIndex < 1 || RewardsAuto.apiConfig.wordList.length < 1) {
                    // 获取随机API配置
                    const apiArr = RewardsAuto.apiConfig.arr;
                    const lastApiIndex = parseInt(GM_getValue("Config.apiIndex", -1));
                    const candidates = apiArr
                        .map((entry, index) => ({ entry, index }))
                        .filter(item => item.index !== lastApiIndex);
                    const selected = candidates[Utils.randomRange(0, candidates.length - 1)];
                    GM_setValue("Config.apiIndex", selected.index);

                    const [apiName, apiConfig] = selected.entry;
                    RewardsAuto.apiConfig.url = apiConfig.url;
                    RewardsAuto.apiConfig.hot = apiConfig.hot;

                    try {
                        const hotSource = RewardsAuto.apiConfig.hot[Utils.randomRange(0, RewardsAuto.apiConfig.hot.length - 1)];
                        const result = await Utils.xhr({ url: RewardsAuto.apiConfig.url + hotSource });
                        if (result && Utils.isJSON(result)) {
                            const res = JSON.parse(result);
                            if (res.code == 200) {
                                RewardsAuto.apiConfig.wordIndex = 1;
                                RewardsAuto.apiConfig.wordList = [];
                                for (let i = 0; i < res.data.length; i++) {
                                    RewardsAuto.apiConfig.wordList.push(res.data[i].title);
                                }
                                // 随机打乱数组
                                RewardsAuto.apiConfig.wordList.sort(() => Math.random() - 0.5);
                                sentence = RewardsAuto.apiConfig.wordList[RewardsAuto.apiConfig.wordIndex];
                                // 截断到20-32字符
                                sentence = sentence.substring(0, Utils.randomRange(20, 32));
                                return sentence;
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

        async checkSearchRestricted() {
            // 用服务器实际进度判断，避免本地虚增导致误判
            const info = await this.getRewardsInfo();
            const currentTotal = info
                ? info.pc.progress
                : RewardsAuto.state.pcProgress;
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

            if (RewardsAuto.state.restrictedTimes >= 3) {
                Utils.log("🔴", "搜索受限或账号异常，已中断今日搜索！", true);
                return true;
            }
            return false;
        }
    };

    const isDashboardPage = typeof location !== "undefined" &&
        location.hostname === "rewards.bing.com" && /^\/dashboard\/?$/.test(location.pathname);

    // 每轮后台任务只打开一个 dashboard；该页面会统一处理每日活动和待领取积分。
    let dashboardTabRequested = false;
    const openDashboardOnce = () => {
        if (dashboardTabRequested) {
            Utils.log("📅", "本轮已请求打开 dashboard，跳过重复打开");
            return false;
        }

        dashboardTabRequested = true;
        try {
            GM_openInTab("https://rewards.bing.com/dashboard", { active: false, insert: true });
            return true;
        } catch (e) {
            dashboardTabRequested = false;
            throw e;
        }
    };

    const TaskManager = {
        // 任务日期状态
        signDate: 0, readDate: 0, promosDate: 0, searchDate: 0, streakDays: 0,
        signPoint: -1, signTimes: 0, readTimes: 0, promosTimes: 0,

        // 初始化任务状态
        init() {
            RewardsAuto.state.dateNowNum = Utils.getTodayNum();
            RewardsAuto.state.dateNowStr = Utils.getTodayStr();
            const tasks = GM_getValue("Config.tasks", {});
            this.signDate = tasks.sign || 0;
            this.readDate = tasks.read || 0;
            this.promosDate = tasks.promos || 0;
            this.searchDate = tasks.search || 0;
            this.streakDays = tasks.streakDays || 0;
            this.signPoint = GM_getValue("Config.signPoint", -1);
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
            if (!GM_getValue("Tasks.sign", true) || this.signTimes > 2) return;
            if (this.signPoint >= 0 && this.signDate === RewardsAuto.state.dateNowNum) {
                Utils.log("✅", `签入已完成(${this.signPoint}积分)`);
                return;
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
            } else {
                this.signTimes++;
                Utils.log("🟡", `签入失败，稍后重试`);
            }
        },

        async doRead() {
            if (!GM_getValue("Tasks.read", true) || this.readTimes > 2) return;
            if (this.readDate === RewardsAuto.state.dateNowNum) {
                // 二次验证：检查实际进度是否真的满了
                const verifyProgress = await API.getReadProgress();
                if (verifyProgress && verifyProgress.progress >= verifyProgress.max) {
                    Utils.log("✅", `阅读任务已完成（已验证 ${verifyProgress.progress}/${verifyProgress.max}）`);
                    return;
                } else if (verifyProgress) {
                    // readDate 被错误设置，重置
                    Utils.log("🟡", `阅读标记有误（${verifyProgress.progress}/${verifyProgress.max}），重置并继续`);
                    this.readDate = 0;
                    this.save();
                } else {
                    Utils.log("🟡", "无法验证阅读进度，跳过");
                    return;
                }
            }

            const progress = await API.getReadProgress();
            if (!progress) {
                this.readTimes++;
                Utils.log("🟡", "无法获取阅读进度，稍后重试");
                return;
            }

            const { progress: cur, max } = progress;
            Utils.log("📖", `阅读进度: ${cur}/${max}`);

            if (cur >= max) {
                this.readDate = RewardsAuto.state.dateNowNum;
                this.save();
                Utils.log("✅", "阅读任务已完成");
                return;
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
                return;
            }

            // 二次验证
            const verify = await API.getReadProgress();
            if (verify && verify.progress >= verify.max) {
                this.readDate = RewardsAuto.state.dateNowNum;
                this.save();
                Utils.log("🔵", `阅读任务完成！共 ${successCount} 篇`, true);
            } else {
                this.readTimes++;
                Utils.log("🟡", `阅读已执行但未完成，下次继续`);
            }
        },

        async doPromos() {
            if (!GM_getValue("Tasks.promos", true) || this.promosTimes > 2) return;
            if (this.promosDate === RewardsAuto.state.dateNowNum) {
                Utils.log("✅", "活动卡片已完成");
                return;
            }

            Utils.log("🧩", "扫描活动卡片...");
            const cards = await API.discoverCards();

            if (cards.length === 0) {
                this.promosDate = RewardsAuto.state.dateNowNum;
                this.save();
                Utils.log("✅", "无新活动卡片");
                return;
            }

            Utils.log("🧩", `发现 ${cards.length} 个卡片`);
            let ok = 0, fail = 0;

            for (const card of cards) {
                Utils.log("  ", `[${card.kind}] ${card.title} +${card.points}p`);
                
                // Quiz 任务需要单独处理（可选开启）
                if (card.kind === "quiz" && !GM_getValue("Tasks.quiz", true)) continue;
                
                // 【防封号】领取卡片前随机延迟
                await Utils.randomDelay(3000, 8000);
                const result = await API.claimCard(card);
                result ? ok++ : fail++;
            }

            this.promosDate = RewardsAuto.state.dateNowNum;
            this.save();
            Utils.log("🔵", `活动完成: ${ok}成功/${fail}失败`, true);
        },

        async doSearch() {
            if (!GM_getValue("Tasks.search", true)) return;

            const info = await API.getRewardsInfo();
            if (!info) { Utils.log("🔴", "无法获取积分信息"); return; }

            RewardsAuto.state.pcProgress = info.pc.progress;
            RewardsAuto.state.pcMax = info.pc.max;

            Utils.log("🔍", `搜索配额: PC ${info.pc.progress}/${info.pc.max}`);

            const pcDone = info.pc.progress >= info.pc.max;
            if (pcDone) {
                this.searchDate = RewardsAuto.state.dateNowNum;
                this.save();
                Utils.log("✅", `搜索配额已满 PC: ${info.pc.progress}/${info.pc.max}`);
                return;
            }

            if (this.searchDate === RewardsAuto.state.dateNowNum) {
                Utils.log("🟡", "搜索配额未满，继续执行搜索任务");
                this.searchDate = 0;
            }

            const isRestricted = await API.checkSearchRestricted();
            if (isRestricted) {
                this.searchDate = RewardsAuto.state.dateNowNum;
                this.save();
                return;
            }

            const limit = Utils.randomRange(4, 7);
            for (let i = 0; i < limit; i++) {
                if (RewardsAuto.state.pcProgress >= RewardsAuto.state.pcMax) break;

                let query;
                if (RewardsAuto.apiConfig.mode !== "offline") {
                    query = await API.getHotSearchWord();
                } else {
                    query = RewardsAuto.searchPool[Utils.randomRange(0, RewardsAuto.searchPool.length - 1)];
                }

                Utils.log("🔍", `[PC] 搜索 ${i+1}/${limit}: ${query}`);

                try {
                    const html = await API.getSearchPage(query, false);
                    if (html) {
                        await API.reportSearch(html, query, false);
                        RewardsAuto.state.pcProgress += 3;
                    }
                } catch (e) {
                    Utils.log("🟡", `搜索失败: ${e.message}`);
                }

                const span = Number(GM_getValue("Config.span", 30));
                const wait = Utils.randomRange((span-15)*1000, (span+15)*1000);
                Utils.log("⏳", `等待 ${wait/1000}秒`);
                await Utils.delay(wait);
            }

            const finalInfo = await API.getRewardsInfo();
            if (finalInfo) {
                const pcDone2 = finalInfo.pc.progress >= finalInfo.pc.max;
                if (pcDone2) {
                    this.searchDate = RewardsAuto.state.dateNowNum;
                    this.save();
                    RewardsAuto.state.restrictedTimes = 0;
                    GM_setValue("Config.restrictedTimes", 0);
                    GM_setValue("Config.lastSearchProgress", -1);
                    Utils.log("🔵", `🔍 搜索任务完成！PC: ${finalInfo.pc.progress}/${finalInfo.pc.max}`, true);
                } else {
                    Utils.log("🟡", `搜索已执行，配额未满 PC: ${finalInfo.pc.progress}/${finalInfo.pc.max}`);
                }
            } else {
                Utils.log("🟡", "搜索已执行，但无法获取最终配额状态");
            }
        },

        async doDailySet() {
            const today = Utils.getTodayNum();
            const processedKey = "Config.dailySetProcessed";
            let processed = GM_getValue(processedKey, []);
            if (processed.length > 0 && processed[0]?.date !== today) processed = [];
            const processedIds = new Set(processed.map(p => p.offerId));

            Utils.log("📅", `开始执行每日活动（已处理 ${processedIds.size} 个）...`);
            await Utils.randomDelay(3000, 8000);

            // 检测运行环境：前台页面直接 DOM 操作，后台通过 GM_openInTab。
            const currentHostname = typeof location === "undefined" ? "" : location.hostname;
            const hasDocumentBody = typeof document !== "undefined" && !!document.body;
            const isServiceWorker = currentHostname !== "rewards.bing.com" || !hasDocumentBody;
            Utils.log("📅", `运行环境检测: ${isServiceWorker ? "service worker" : "页面上下文"} (hostname: ${currentHostname || "undefined"})`);

            if (isServiceWorker) {
                // 后台模式：通过打开链接执行
                Utils.log("📅", "后台模式：打开每日活动链接...");
                const clickCount = await this._clickDailySetViaForeground(processedIds);
                if (clickCount > 0) {
                    // 保存处理记录
                    const newProcessed = [...processedIds].map(id => ({ date: today, offerId: id }));
                    GM_setValue(processedKey, newProcessed);
                    Utils.log("🔵", `每日活动完成，打开了 ${clickCount} 个链接`, true);
                } else {
                    Utils.log("🟡", "未找到可点击的每日活动链接");
                }
            } else {
                // 前台模式：直接 DOM 操作
                try {
                    const clickedCount = await this.clickDailySetLinks(processedIds);
                    if (clickedCount > 0) {
                        // 保存处理记录
                        const newProcessed = [...processedIds].map(id => ({ date: today, offerId: id }));
                        GM_setValue(processedKey, newProcessed);
                        Utils.log("🔵", `每日活动完成，点击了 ${clickedCount} 个活动`, true);
                    } else {
                        Utils.log("🟡", "未找到可点击的每日活动链接");
                    }
                } catch (e) {
                    Utils.log("🔴", `每日活动执行异常: ${e.message}`);
                }
            }
        },

        async doClaimPoints() {
            // 通过 XHR 检测可领取积分（兼容 service worker）
            try {
                const dashboardHtml = await Utils.xhr({ url: "https://rewards.bing.com/dashboard" });
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
                    Utils.log("🎁", `发现 ${amount} 积分待领取，尝试自动领取...`);
                    await this._claimPointsViaForeground();
                } else {
                    Utils.log("✅", "可领取积分为 0");
                }
            } catch (e) {
                Utils.log("🟡", `检测可领取积分失败: ${e.message}`);
            }
        },

        // 直接打开 dashboard 页面领取积分（service worker 调用）
        async _claimPointsViaForeground() {
            if (isDashboardPage) {
                Utils.log("📅", "当前已在 dashboard 页面，跳过重复打开");
                return;
            }

            Utils.log("📅", "打开 dashboard 页面领取积分...");
            // dashboard 页面会统一自动处理领取和每日活动。
            const opened = openDashboardOnce();
            Utils.log("🎁", opened ? "已打开 dashboard 页面，等待领取积分..." : "已复用 dashboard 页面，等待领取积分...");
        },

        // ====== 连签任务检测（通过 XHR 获取 earn 页面信息） ======
        async doStreak() {
            Utils.log("📅", "开始检测连签任务...");
            try {
                // 获取 earn 页面 HTML
                const earnHtml = await Utils.xhr({ url: "https://rewards.bing.com/earn" });
                if (!earnHtml) { Utils.log("🟡", "无法获取 earn 页面"); return; }

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

                // 如果视觉搜索未完成，自动访问视觉搜索链接完成打卡
                if (!visualSearchDone) {
                    Utils.log("📅", "视觉搜索未完成，正在自动打卡...");
                    try {
                        // 访问视觉搜索打卡链接
                        const vsUrl = "https://www.bing.com/?features=vsstreak,vstooltip&form=ML2XES";
                        await GM_openInTab(vsUrl, { active: false, insert: true });
                        Utils.log("✅", "视觉搜索打卡页面已打开");
                        await Utils.randomDelay(3000, 5000);
                    } catch (e) {
                        Utils.log("🟡", `视觉搜索打卡失败: ${e.message}`);
                    }
                }

                // 解析 1,000 奖励印章进度（新格式："赚取 12 个印章"）
                const stampMatch = text.match(/(\d+)\s*个印章/) || text.match(/印章\s*(\d+)/);
                if (stampMatch) {
                    Utils.log("📅", `连签奖励印章进度: ${stampMatch[1]}/12`);
                }

                // 连签任务的实际完成由 doPromos() 的 discoverCards + claimCard 统一处理
                Utils.log("📅", "连签任务检测完成，未完成任务将由活动卡片模块处理");
            } catch (e) {
                Utils.log("🔴", `连签任务异常: ${e.message}`);
            }
        },

        // 通过打开链接完成每日活动（后台模式）
        async _clickDailySetViaForeground(processedIds) {
            let clickCount = 0;
            try {
                // dashboard 页面会统一自动处理每日活动和待领取积分。
                const opened = openDashboardOnce();
                Utils.log("📅", opened ? "已打开 dashboard 页面，等待自动点击每日活动..." : "已复用 dashboard 页面，等待自动点击每日活动...");
                clickCount = 3; // 假设3个活动会被点击
            } catch (e) {
                Utils.log("🟡", `活动执行失败: ${e.message}`);
            }
            return clickCount;
        },

        async clickDailySetLinks(processedIds) {
            // DOM 方式点击每日活动链接（在页面上下文中执行）
            let clickCount = 0;

            // 等待每日活动区域加载
            try {
                await Utils.waitForElement('a[href*="rnoreward=1"]', 15000);
            } catch {
                Utils.log("🟡", "等待活动链接超时，页面可能未加载完成");
            }

            // 选择器：匹配每日活动链接（包含 rnoreward=1 参数）
                const allLinks = Array.from(document.querySelectorAll('a[href*="rnoreward=1"]'))
                    .filter(link => !new URL(link.href, location.href).pathname.startsWith("/redeem"));
            Utils.log("📅", `找到 ${allLinks.length} 个每日活动链接`);

            for (const link of allLinks) {
                const href = link.href || "";
                const text = link.textContent || "";

                // 检测已完成：文本包含"已完成"或点数后无"+"
                if (text.includes("已完成") || text.includes("Completed")) {
                    Utils.log("📅", `跳过已完成活动`);
                    continue;
                }

                // 提取活动标题（第一个段落文本）
                const titleEl = link.querySelector('p');
                const title = titleEl ? titleEl.textContent.trim().substring(0, 30) : "未知活动";

                // 提取 offerId 用于去重
                const offerIdMatch = href.match(/BTDSUOID[^"]*?(\w+_\d{8}_Child\d+)/i);
                const offerId = offerIdMatch ? offerIdMatch[1] : href.slice(0, 80);
                if (processedIds.has(offerId)) continue;

                Utils.log("📅", `点击活动: ${title}`);
                await Utils.randomDelay(3000, 8000);

                try {
                    // 点击链接（会在新标签页打开）
                    link.click();
                    clickCount++;
                    processedIds.add(offerId);
                    await Utils.randomDelay(3000, 8000);
                } catch (e) {
                    Utils.log("🟡", `点击活动失败: ${e.message}`);
                }
            }
            return clickCount;
        },

        async runAll() {
            if (this.running) {
                Utils.log("🟡", "任务正在运行中，请勿重复触发");
                return;
            }
            this.running = true;
            try {
            RewardsAuto.state.startTime = Utils.getTimestamp();
            Utils.log("🚀", "启动全能自动化任务...");
            this.init();

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
                // checkRegion 已分别记录地区异常或发送非大陆 IP 通知。
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

            if (regionOK && isTokenOK) {
                await withRetry(() => this.doSign(), "签到");
                await Utils.randomDelay();
                if (!RewardsAuto.state.pc401) {
                    await withRetry(() => this.doRead(), "阅读");
                    await Utils.randomDelay();
                } else {
                    Utils.log("🟡", "PC会话已过期，跳过阅读任务");
                }
            } else if (regionOK) {
                await withRetry(() => this.doSign(), "签到");
                await Utils.randomDelay();
            }

            await withRetry(() => this.doPromos(), "活动卡片");
            await Utils.randomDelay();

            await withRetry(() => this.doSearch(), "搜索");

            // 连签任务检测
            await withRetry(() => this.doStreak(), "连签检测");
            await Utils.randomDelay();

            Utils.log("📅", "开始执行每日活动任务...");
            await Utils.randomDelay();
            await withRetry(() => this.doDailySet(), "每日活动");

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
            if (newCards.length > 0) {
                Utils.log("🧩", `二次扫描发现 ${newCards.length} 个新卡片`);
                let ok = 0, fail = 0;
                for (const card of newCards) {
                    Utils.log("  ", `[${card.kind}] ${card.title} +${card.points}p`);
                    if (card.kind === "quiz" && !GM_getValue("Tasks.quiz", true)) continue;
                    await Utils.randomDelay(3000, 8000);
                    const result = await API.claimCard(card);
                    result ? ok++ : fail++;
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

            const info = await API.getRewardsInfo();
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
                this.running = false;
            }
        }
    };

    // 兑换页包含与任务页相似的链接；在此页运行自动点击会反复打开兑换窗口。
    const isRedeemPage = location.hostname === "rewards.bing.com" && location.pathname.startsWith("/redeem");

    if (location.hostname === "rewards.bing.com" && !isRedeemPage && !isDashboardPage) {
        const punchCardSelectors = [
            "a[href*='punchcard']", "a[href*='quest']",
            "a[data-rac][href*='earn']", "a.cursor-pointer[href]",
            "a.group\\/ctrl",
            "a[href*='/earn/quest/']",
            "a[href*='promotional']",
            "a[data-bi-id][href*='earn']",
        ];
        const textPatterns = ["盗贼之海", "五月亮点来袭", "每日活动", "Daily Set", "限时活动", "特别活动"];
        
        const detailTextPatterns = [
            "关注赛事", "访问网站", "开始搜索",
            "发现", "探索", "获取", "Learn more", "了解更多",
            "Start", "Begin", "Watch", "View", "Check",
            "立即开始", "立即参与", "立即前往", "立即访问",
            "参加活动", "参与活动", "前往活动"
        ];

        const clickDetailTasks = async () => {
            const today = Utils.getTodayNum();
            const detailStateKey = "Config.punchCardDetailState";
            const detailDateKey = "Config.punchCardDetailDate";
            const savedDate = GM_getValue(detailDateKey, 0);
            let currentDetailState = 0;
            
            if (savedDate === today) {
                currentDetailState = GM_getValue(detailStateKey, 0);
            } else {
                GM_setValue(detailStateKey, 0);
                GM_setValue(detailDateKey, today);
            }
            
            if (currentDetailState >= 5) {
                console.log("[Rewards Auto] 详情页任务今日已全部点击完成");
                return true;
            }
            
            console.log(`[Rewards Auto] 开始执行详情页任务点击，当前状态: ${currentDetailState}/5`);
            // 【防封号】操作前随机延迟 2-4 秒
            await Utils.randomDelay(3000, 8000);
            
            // 查找可用的任务按钮
            const enabledButtons = document.querySelectorAll(
                "a[data-rac][target='_blank']:not([aria-disabled='true']):not([data-disabled='true'])"
            );
            const disabledButtons = document.querySelectorAll(
                "a[data-rac][target='_blank'][aria-disabled='true'][data-disabled='true']"
            );
            
            console.log(`[Rewards Auto] 找到 ${enabledButtons.length} 个可用按钮，${disabledButtons.length} 个禁用按钮`);
            
            let clickableButton = null;
            
            // 优先查找包含特定文本的按钮
            for (const btn of enabledButtons) {
                const text = btn.textContent || "";
                const ariaLabel = btn.getAttribute("aria-label") || "";
                if (detailTextPatterns.some(pattern => text.includes(pattern) || ariaLabel.includes(pattern))) {
                    clickableButton = btn;
                    break;
                }
            }
            
            // 如果没有找到特定文本的按钮，使用第一个可用按钮
            if (!clickableButton && enabledButtons.length > 0) {
                clickableButton = enabledButtons[0];
            }
            
            if (!clickableButton) {
                console.log("[Rewards Auto] 未找到可用的任务按钮，所有任务可能已完成或需要等待解锁");
                return true;
            }
            
            const buttonText = clickableButton.textContent || "未知任务";
            const ariaLabel = clickableButton.getAttribute("aria-label") || buttonText;
            console.log(`[Rewards Auto] 准备点击任务按钮: "${buttonText}"`);
            
            // 【防封号】点击前随机延迟 3-8 秒
            await Utils.randomDelay(3000, 8000);
            
            try {
                clickableButton.click();
                console.log(`[Rewards Auto] 已点击任务按钮: "${buttonText}"`);
                GM_setValue(detailStateKey, currentDetailState + 1);
                GM_setValue(detailDateKey, today);
                // 【防封号】点击后随机延迟 2-4 秒
                await Utils.randomDelay(3000, 8000);
                return true;
            } catch (clickError) {
                console.error(`[Rewards Auto] 点击任务按钮失败: ${clickError.message}`);
                return false;
            }
        };

        const clickPunchCards = async (depth = 0) => {
            if (depth > 5) {
                console.log("[Rewards Auto] 打卡递归深度超限，停止");
                return;
            }
            const today = Utils.getTodayNum();
            const stateKey = "Config.punchCardState";
            const dateKey = "Config.punchCardDate";
            const savedDate = GM_getValue(dateKey, 0);
            let state = savedDate === today ? GM_getValue(stateKey, 0) : 0;

            if (state >= 2) {
                console.log("[Rewards Auto] 打卡任务已完成");
                return;
            }

            console.log(`[Rewards Auto] 打卡任务: ${state}/2`);
            // 【防封号】操作前随机延迟 3-8 秒
            await Utils.randomDelay(3000, 8000);

            let found = [];
            for (const sel of punchCardSelectors) {
                try {
                    found = await Utils.waitForElementsByText(sel, textPatterns, 10000);
                    if (found.length > 0) break;
                } catch {}
            }

            if (found.length === 0) {
                console.log("[Rewards Auto] 未找到打卡卡片");
                return;
            }

            if (state < found.length) {
                const target = found[state];
                console.log(`[Rewards Auto] 点击: ${target.pattern}`);
                // 【防封号】点击前随机延迟
                await Utils.randomDelay();
                try {
                    target.element.click();
                    GM_setValue(stateKey, state + 1);
                    GM_setValue(dateKey, today);
                    if (state + 1 < 2) {
                        // 【防封号】两次点击间隔 5-10 秒
                        await Utils.randomDelay(5000, 10000);
                        await clickPunchCards(depth + 1);
                    }
                } catch (e) {
                    console.error(`[Rewards Auto] 点击失败: ${e.message}`);
                }
            }
        };

        const startPunchCards = () => {
            setTimeout(async () => {
                const path = location.pathname;
                if (path.includes("/earn/quest/") || path.includes("punchcard")) {
                    console.log("[Rewards Auto] 检测到打卡详情页，开始执行任务点击...");
                    await clickDetailTasks();
                } else {
                    console.log("[Rewards Auto] 检测到奖励主页，开始执行卡片点击...");
                    await clickPunchCards();
                }

                console.log("[Rewards Auto] 开始执行每日活动点击...");
                await TaskManager.doDailySet();

                console.log("[Rewards Auto] 检查可领取积分...");
                await TaskManager.doClaimPoints();
            }, 3000); // 延迟 3 秒等待页面渲染
        };
        
        if (document.readyState === "complete" || document.readyState === "interactive") {
            startPunchCards();
        } else {
            document.addEventListener("DOMContentLoaded", startPunchCards);
        }
    }

    if (isRedeemPage) return;

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

    GM_registerMenuCommand("📢 测试通知", () => {
        RewardsAuto.state.sendMSG = "🧪 这是一条测试消息\n如果你看到这条消息，说明通知接口配置成功！";
        Utils.log("📢", "测试通知已发送", true);
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

    GM_registerMenuCommand("📋 查看通知状态", () => {
        const wework = GM_getValue("Notice.wework", "");
        const dingding = GM_getValue("Notice.dingding", "");
        const feishu = GM_getValue("Notice.feishu", "");
        const pushme = GM_getValue("Notice.pushme", "");
        const bark = GM_getValue("Notice.bark", "");
        
        let status = "📊 通知接口配置状态：\n\n";
        status += `企业微信: ${wework ? "✅ 已配置" : "❌ 未配置"}\n`;
        status += `钉钉: ${dingding ? "✅ 已配置" : "❌ 未配置"}\n`;
        status += `飞书: ${feishu ? "✅ 已配置" : "❌ 未配置"}\n`;
        status += `PushMe: ${pushme ? "✅ 已配置" : "❌ 未配置"}\n`;
        status += `Bark: ${bark ? "✅ 已配置" : "❌ 未配置"}\n`;
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
                          checkDone(GM_getValue("Tasks.search", true), TaskManager.searchDate);

        if (!isKeep && isAllDone) {
            Utils.log("💤", "今日任务已全部完成");
            return;
        }

        // 【防封号核心】随机延迟 5-95 秒启动，避免定时器特征
        const delay = Utils.randomRange(5000, 95000);
        Utils.log("⏳", `${delay/1000}秒后启动...`);
        setTimeout(() => TaskManager.runAll(), delay);
    };

    // 清除可能影响搜索的 Cookie
    GM_cookie("delete", { url: "https://bing.com", name: "_EDGE_S" });

    // ====== 前台页面处理器（dashboard 页面内执行 DOM 操作） ======
    if (isDashboardPage) {
        Utils.log("📅", "前台模式：统一处理 dashboard 任务...");

        // 自动领取积分函数
        const autoClaimPoints = async () => {
            try {
                // 等待页面加载
                await new Promise(r => setTimeout(r, 3000));

                // 查找可领取按钮
                const claimableBtn = document.querySelector('button[aria-expanded]') ||
                    Array.from(document.querySelectorAll('button')).find(b => {
                        const text = b.textContent || "";
                        return text.includes("可领取") && text.includes("领取");
                    });

                if (!claimableBtn) {
                    Utils.log("📅", "无可领取积分按钮");
                    return;
                }

                // 检查是否有可领取积分
                const amountText = claimableBtn.textContent || "";
                const amountMatch = amountText.match(/(\d[\d,]*)/);
                const amount = amountMatch ? parseInt(amountMatch[1].replace(/,/g, '')) : 0;

                if (amount <= 0) {
                    Utils.log("📅", "可领取积分为 0");
                    return;
                }

                Utils.log("🎁", `发现 ${amount} 积分待领取，开始领取...`);

                // 点击可领取按钮
                claimableBtn.click();
                await new Promise(r => setTimeout(r, 2000));

                // 查找并点击领取积分按钮
                const dialog = document.querySelector('[role="dialog"]');
                if (dialog) {
                    const claimBtn = Array.from(dialog.querySelectorAll('button')).find(
                        b => b.innerText?.includes('领取积分') || b.innerText?.includes('领取')
                    );
                    if (claimBtn) {
                        claimBtn.click();
                        await new Promise(r => setTimeout(r, 2000));
                        Utils.log("🎁", `${amount} 积分领取成功！`);
                    }
                }
            } catch (e) {
                Utils.log("🟡", `自动领取积分失败: ${e.message}`);
            }
        };

        // 自动点击每日活动函数
        const autoClickDailySet = async () => {
            try {
                // 等待页面加载
                await new Promise(r => setTimeout(r, 3000));

                // 查找每日活动链接（包含 rnoreward=1 参数）
                const links = Array.from(document.querySelectorAll('a[href*="rnoreward=1"]'))
                    .filter(link => !new URL(link.href, location.href).pathname.startsWith("/redeem"));

                // 过滤已完成的
                const incompleteLinks = links.filter(link => {
                    const text = link.textContent || "";
                    return !text.includes("已完成") && !text.includes("Completed");
                });

                Utils.log("📅", `找到 ${incompleteLinks.length} 个未完成的每日活动`);
                let clickCount = 0;

                for (const link of incompleteLinks) {
                    const title = link.querySelector('p')?.textContent?.trim()?.substring(0, 30) || "未知活动";
                    Utils.log("📅", `点击活动: ${title}`);
                    await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
                    link.click();
                    clickCount++;
                    await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
                }

                if (clickCount > 0) {
                    Utils.log("📅", `每日活动完成，点击了 ${clickCount} 个活动`);
                }
            } catch (e) {
                Utils.log("🟡", `每日活动点击失败: ${e.message}`);
            }
        };

        // 页面加载后自动执行
        setTimeout(async () => {
            Utils.log("📅", "页面加载完成，开始自动处理...");
            await autoClaimPoints();
            await autoClickDailySet();
        }, 5000);

        // 前台模式统一执行一次，不再监听旧的跨标签页指令，避免重复点击。
        return;
    }

    // ====== 后台模式入口 ======
    init();

})();



