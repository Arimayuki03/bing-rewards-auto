// ==UserScript==
// @name         微软积分商城签到-页面代理（前台通道）
// @namespace    local.bing-rewards-auto
// @version      3.9.0
// @description  《微软积分商城签到（全能智能重构版）》的页面侧组件：①同源转发通道执行器（页面上下文 fetch 携带真实登录 cookie 与正确 Origin，是 Server Action 唯一可用的执行环境）②OAuth 授权码自动捕获 ③打卡/每日活动 DOM 处理。后台脚本因 @crontab 属于「后台脚本」类别（ScriptCat 规则：不注入任何页面），页面功能必须由本脚本承载。与后台脚本共用 @storageName 通信（BingRewards_req/resp/alive 协议）。
// @icon         https://bing.com/th?id=OMR.icon-96.png&pid=Rewards
// @license      MIT
// @match        https://login.live.com/oauth20_desktop.srf*
// @match        https://rewards.bing.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_log
// @grant        GM_notification
// @storageName  BingRewardsAuto_Shared
// ==/UserScript==

(function() {
    'use strict';

    // 注入信标：F12 控制台第一行 = 脚本已注入；第二行 = 共享存储可写。
    // 只有一行都没有 = ScriptCat 未注入本脚本（查弹窗分组与启用开关）。
    try { console.log("[页面代理] v3.9.0 已注入", location.href); } catch (_) {}

    // ====== OAuth 授权码自动捕获（v3.8.0 自后台脚本迁入：后台脚本不注入页面，原为死代码） ======
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
        // 页面侧仅需运行日期与通知内容两个可变字段；其余状态归后台脚本所有
        state: { dateNowNum: 0, dateNowStr: "", sendMSG: "" },
    };

    // 后台 Utils 的页面侧最小子集（签名与后台保持一致，逻辑随用随迁）
    const Utils = {
        log(icon, msg) {
            try { GM_log(`${icon} ${msg}`); }
            catch (_) { try { console.log(`[页面代理] ${icon} ${msg}`); } catch (_) {} }
        },
        delay(ms) { return new Promise(r => setTimeout(r, ms)); },
        randomRange(min, max) { return Math.floor(Math.random() * (max - min + 1) + min); },
        randomDelay(min = 3000, max = 8000) { return this.delay(this.randomRange(min, max)); },
        dateParts() {
            const d = new Date();
            return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate() };
        },
        getTodayNum() {
            const { y, mo, d } = this.dateParts();
            return Number(`${y}${String(mo).padStart(2,"0")}${String(d).padStart(2,"0")}`);
        },
        getTodayStr() {
            const { y, mo, d } = this.dateParts();
            return `${mo}/${d}/${y}`;
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

    };

    // ====== 前台同源转发通道 · 页面侧（v3.8.0 自后台脚本迁入，协议不变）======
    // 后台脚本（@crontab）属于「后台脚本」类别，ScriptCat 不会把它注入任何页面——
    // 这是 v3.6.8→v3.7.0 通道始终"代理页从未被脚本注入"的根因。本脚本以普通页面
    // 脚本身份注入 rewards.bing.com，在页面上下文发起同源请求（浏览器自动附带全量
    // 真实登录 cookie 与正确的 Origin），后台通过共享存储 (@storageName) 桥接转发。
    // ====== 前台同源转发通道 · 页面侧（v3.6.8；v3.6.9 执行器加固）======
    // 挂 20 秒心跳并监听 BingRewards_req：在页面上下文发起 rewards.bing.com
    // 同源 GET/POST（浏览器自动附带全量真实登录 cookie），结果按
    // {id,ok,status,text,...} 写回 BingRewards_resp。任何异常不应答，
    // 后台将回退直连——转发通道只能改善、绝不能恶化既有任务路径。
    //
    // v3.6.9 根因修复：ScriptCat 内容脚本沙箱可能不暴露 fetch（22:12 轮
    // "后台代理标签页未就绪"即因此静默失联）。执行器逐级回退：
    // fetch → unsafeWindow.fetch → XMLHttpRequest → unsafeWindow.XMLHttpRequest；
    // 全部不可用时也照常上报 mode:"none" 心跳，让后台立即禁用通道而非干等 25 秒。
    const pageProxyExecutor = () => {
        const fetchExec = (f) => async (req) => {
            const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
            const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, 20000) : null;
            try {
                const res = await f(req.url, {
                    method: req.method,
                    headers: req.headers && Object.keys(req.headers).length ? req.headers : undefined,
                    body: req.method === "POST" ? req.data : undefined,
                    credentials: "include",
                    redirect: "follow",
                    signal: ctrl ? ctrl.signal : undefined,
                });
                const text = await res.text();
                return {
                    status: res.status, text: text.slice(0, 500000),
                    finalUrl: res.url || req.url,
                    headers: Array.from(res.headers || []).map(([k, v]) => `${k}: ${v}`).join("\r\n"),
                };
            } finally { if (timer) clearTimeout(timer); }
        };
        const xhrExec = (Ctor) => (req) => new Promise((resolve, reject) => {
            try {
                const x = new Ctor();
                x.open(req.method || "GET", req.url, true);
                x.withCredentials = true; // 同源请求附带全量登录 cookie 的关键
                x.timeout = 20000;
                for (const [k, v] of Object.entries(req.headers || {})) {
                    // cookie/origin/referer 等禁用头浏览器会自行接管，个别环境抛错，逐个 try
                    try { x.setRequestHeader(k, String(v)); } catch (_) {}
                }
                x.onload = () => resolve({
                    status: x.status, text: String(x.responseText || "").slice(0, 500000),
                    finalUrl: x.responseURL || req.url, headers: x.getAllResponseHeaders() || "",
                });
                x.onerror = () => reject(new Error("XHR 网络错误"));
                x.ontimeout = () => reject(new Error("XHR 超时"));
                x.send(req.method === "POST" ? req.data : undefined);
            } catch (e) { reject(e); }
        });
        if (typeof fetch === "function") return { mode: "fetch", exec: fetchExec((...a) => fetch(...a)) };
        let uw = null;
        try { uw = (typeof unsafeWindow !== "undefined" && unsafeWindow) ? unsafeWindow : null; } catch (_) {}
        if (uw && typeof uw.fetch === "function") return { mode: "uwfetch", exec: fetchExec((...a) => uw.fetch(...a)) };
        if (typeof XMLHttpRequest === "function") return { mode: "xhr", exec: xhrExec(XMLHttpRequest) };
        if (uw && typeof uw.XMLHttpRequest === "function") return { mode: "uwxhr", exec: xhrExec(uw.XMLHttpRequest) };
        return null;
    };
    const setupPageProxy = () => {
        // v3.6.13 注入标记：只要有任意 rewards 页面执行到脚本，就留下痕迹。
        // 后台据此区分"代理页从未被注入（ScriptCat 前台注入开关/权限问题）"
        // 与"注入了但执行器全缺（mode:none）"——连续多轮零心跳时后者不该出现。
        try { GM_setValue("BingRewards_injected", { ts: Date.now(), url: (location.href || "").slice(0, 80) }); } catch (_) {}
        try {
            console.log("[页面代理] B→A 注入标记已写入; A→B 共享存储可读:",
                !!GM_getValue("Config.token", false), "(true=桥通, false=桥未通但自扫描领取不受影响)");
        } catch (_) {}
        const ex = pageProxyExecutor();
        const beat = () => { try { GM_setValue("BingRewards_alive", { ts: Date.now(), mode: ex ? ex.mode : "none" }); } catch (_) {} };
        beat();
        try { setInterval(beat, 20000); } catch (_) {}
        if (!ex) {
            try { Utils.log("🔗", "转发通道不可用：页面沙箱内 fetch/XHR 均不存在"); } catch (_) {}
            return;
        }
        GM_addValueChangeListener("BingRewards_req", async (name, oldV, req) => {
            try {
                if (!req || !req.id || req.answered) return;
                if (!/^https:\/\/rewards\.bing\.com\//i.test(req.url || "")) return;
                if (!["GET", "POST"].includes(req.method)) return;
                req.answered = true;
                try { GM_setValue(name, req); } catch (_) {} // 认领标记，多标签页时尽量只执行一次
                try {
                    const r = await ex.exec(req);
                    GM_setValue("BingRewards_resp", { id: req.id, ok: true, status: r.status, text: r.text, finalUrl: r.finalUrl, headers: r.headers });
                } catch (e) {
                    GM_setValue("BingRewards_resp", { id: req.id, ok: false, err: String((e && e.message) || e).slice(0, 200) });
                }
            } catch (_) { /* 转发异常不应答，后台超时后自行回退 */ }
        });
    };

    // ====== v3.9.0 桥无关自扫描领取 ======
    // v3.8.0 现场：页面代理已在「当前页运行脚本 1/1」，但后台读不到它写的注入标记/心跳
    // ——@storageName 跨脚本共享未生效，req/resp 桥不可依赖。但领取动作只需要「页面上下文」
    // 这一个条件（抓包实证：页面内 fetch 带真实 cookie+正确 Origin → 200+1:true 入账），
    // 不需要后台驱动：B 自己抓取 earn/dashboard 的 flight、解析待领 offer、页面内 POST
    // reportActivity 与欢迎积分领取。后台下一轮 discoverCards/复核自然验证到账——
    // 存储桥通与不通，这条路都成立。
    const FALLBACK_REPORT_ACTION = "707e6eb15bdfdd5fba193f0a77e934f7018faf87ce"; // 2026-09-15 dpl=20260912-2
    const FALLBACK_CLAIM_ACTION = "00491296f1d668ad46b65342c95cb9d72a62c1fa9d";  // 2026-09-14 抓包
    const sweepLog = (...a) => { try { console.log("[页面代理]", ...a); } catch (_) {} };
    const sweepConcatFlight = (html) => {
        let c = "";
        for (const m of String(html).matchAll(/self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g)) {
            try { c += JSON.parse('"' + m[1] + '"'); } catch (_) {}
        }
        return c;
    };
    const sweepExtractOffers = (combined) => {
        const out = [];
        const seen = new Set();
        const re = /"offerId":"([^"]+)"/g;
        let m;
        while ((m = re.exec(combined)) !== null) {
            const id = m[1];
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const win = combined.slice(Math.max(0, m.index - 700), m.index + 700);
            const hm = win.match(/"hash":"([a-f0-9]{64})"/);
            if (!hm) continue;
            if (/"isCompleted":true/.test(win) || /"isLocked":true/.test(win)) continue;
            const pm = win.match(/"points":(\d+)/);
            const points = pm ? Number(pm[1]) : 0;
            if (points <= 0) continue;
            out.push({ offerId: id, hash: hm[1], points });
        }
        return out;
    };
    const runClaimSweep = async () => {
        const tree = encodeURIComponent('["",{"children":["(nav)",{"children":["dashboard",{"children":["__PAGE__",{},null,null,4096]},null,null,4096]},null,null,4096]},null,null,4112]');
        const fetchText = async (url) => {
            try {
                const r = await fetch(url, { credentials: "include", redirect: "follow" });
                return { status: r.status, text: await r.text() };
            } catch (_) { return { status: 0, text: "" }; }
        };
        const earn = await fetchText("https://rewards.bing.com/earn");
        const dash = await fetchText("https://rewards.bing.com/dashboard");
        if (earn.status !== 200 && dash.status !== 200) { sweepLog("扫描跳过：页面抓取失败", earn.status, dash.status); return; }
        const htmlAll = earn.text + dash.text;
        const combined = sweepConcatFlight(earn.text) + sweepConcatFlight(dash.text);
        const dpl = (htmlAll.match(/dpl=([0-9][0-9A-Za-z.\-]*)/) || [])[1] || "";
        // reportActivity action id：扫描构建 chunk 定位 createServerReference(...,"reportActivity")
        let actionId = "";
        try {
            const chunkUrls = [...new Set([...htmlAll.matchAll(/\/_next\/static\/chunks\/[^\s"'<>?]+\.js/g).map(x => x[0])])].slice(0, 16);
            for (const cu of chunkUrls) {
                const js = await fetchText("https://rewards.bing.com" + cu + (dpl ? "?dpl=" + dpl : ""));
                const am = js.text.match(/createServerReference\("([a-f0-9]{40})"[^)]*,"reportActivity"\)/);
                if (am) { actionId = am[1]; break; }
            }
        } catch (_) {}
        if (!actionId) actionId = FALLBACK_REPORT_ACTION;
        const headers = (nextAction) => ({
            "accept": "text/x-component",
            "content-type": "text/plain;charset=UTF-8",
            "next-action": nextAction,
            "next-router-state-tree": tree,
            ...(dpl ? { "x-deployment-id": dpl } : {}),
        });
        const offers = sweepExtractOffers(combined);
        sweepLog(`扫描开始: ${offers.length} 个待领取 offer, action=${actionId.slice(0, 12)}…`);
        let okN = 0;
        for (const o of offers) {
            try {
                const body = JSON.stringify([o.hash, 11, {
                    offerid: o.offerId, isPromotional: "$undefined",
                    timezoneOffset: String(new Date().getTimezoneOffset()),
                }]);
                const r = await fetch("https://rewards.bing.com/earn", { method: "POST", headers: headers(actionId), body, credentials: "include" });
                const t = await r.text();
                const ok = r.status === 200 && t.includes("1:true");
                if (ok) okN++;
                sweepLog(`领取${ok ? " ✅" : " ❌"} ${o.offerId} +${o.points}p HTTP ${r.status}${ok ? "" : " " + t.slice(0, 80)}`);
            } catch (e) { sweepLog("领取异常", o.offerId, e && e.message); }
            await new Promise(r => setTimeout(r, 2500 + Math.random() * 2500));
        }
        // 欢迎页「可领取」积分：POST dashboard 空参数数组
        try {
            const ids = [...new Set([...String(dash.text + combined).matchAll(/\$ACTION_ID_([a-f0-9]{40})/g)].map(x => x[1]))];
            const claimId = ids.length === 1 ? ids[0] : FALLBACK_CLAIM_ACTION;
            const r = await fetch("https://rewards.bing.com/dashboard", { method: "POST", headers: headers(claimId), body: "[]", credentials: "include" });
            const t = await r.text();
            sweepLog(`欢迎积分领取 HTTP ${r.status}`, (r.status === 200 && t.includes("1:true")) ? "✅" : "❌/无待领");
        } catch (e) { sweepLog("欢迎积分领取异常", e && e.message); }
        sweepLog(`扫描完成: ${okN}/${offers.length} 受理成功（到账以后台下一轮复核为准）`);
    };
    const maybeSweep = () => {
        // 后台救援页 ?claimnow=1 强制执行；用户正常浏览 dashboard/earn 时 15 分钟节流一次
        const force = /claimnow=1/.test(location.search);
        if (!force && location.pathname !== "/dashboard" && location.pathname !== "/earn") return;
        try {
            const last = Number(localStorage.getItem("bw_sweep_last") || 0);
            if (!force && Date.now() - last < 15 * 60 * 1000) return;
            localStorage.setItem("bw_sweep_last", String(Date.now()));
        } catch (_) {}
        setTimeout(() => { runClaimSweep().catch(e => sweepLog("扫描异常:", e && e.message || e)); }, force ? 3000 : 8000);
    };

    if (location.hostname === "rewards.bing.com") {
        setupPageProxy();
        maybeSweep();
        // v3.6.15：诊断菜单只在此（页面上下文）注册——后台沙箱里注册的菜单会让
        // 用户误以为前台注入正常（v3.6.14 实测假阳性）。能否在 rewards 页面的
        // 脚本菜单里看到它，就是"前台注入是否生效"的一锤定音判据。
        GM_registerMenuCommand("🔗 通道诊断（本页）", () => {
            try {
                const now = Date.now();
                const alive = GM_getValue("BingRewards_alive", null);
                const inj = GM_getValue("BingRewards_injected", null);
                const age = ts => (typeof ts === "number" ? `${Math.max(0, Math.round((now - ts) / 1000))} 秒前` : "无");
                const aliveStr = alive && typeof alive.ts === "number"
                    ? `${age(alive.ts)}（mode=${alive.mode || "?"}，${now - alive.ts < 45000 ? "在线 ✅" : "已离线"}）`
                    : "无";
                const injStr = inj && typeof inj.ts === "number" ? `${age(inj.ts)} @ ${inj.url || "?"}` : "无";
                const exec = typeof fetch === "function" ? "fetch"
                    : (typeof XMLHttpRequest === "function" ? "XHR" : "无（将用 unsafeWindow 回退）");
                alert([
                    "上下文: rewards 页面（本页诊断）",
                    "前台脚本注入: ✅ 正常（能看到本菜单即证明）",
                    `本页可用执行器: ${exec}`,
                    `最近注入标记: ${injStr}`,
                    `通道心跳: ${aliveStr}`,
                    "",
                    "心跳长期'无/离线'时：保持本页或任意 rewards.bing.com 页面打开，",
                    "后台每 20 分钟会自动复用它转发上报。",
                ].join("\n"));
            } catch (e) {
                alert("诊断失败: " + (e && e.message || e));
            }
        });
        // 前台页面（含 /dashboard）先初始化运行起始日：dashboard 分支会在后台入口
        // init() 之前 return，TaskManager.init() 不会执行；若不在此设置，
        // clickPunchCards 等处理器会以 dateNowNum=0 读写打卡状态键，与其他页面的
        // 日期键错位，打卡状态机与每日尝试上限跨页面族失效（重复点击打卡入口）。
        RewardsAuto.state.dateNowNum = Utils.getTodayNum();
        RewardsAuto.state.dateNowStr = Utils.getTodayStr();

        // 仅保留真正指向打卡/任务详情的选择器，移除 a.cursor-pointer[href]、a.group/ctrl 等
        // 宽泛选择器——它们会误中“兑换奖励”面板的 /redeem/cn?ref=rewardspanel 导航链接，
        // 导致反复打开新窗口
        const punchCardSelectors = [
            "a[href*='punchcard']",
            "a[href*='/earn/quest/']",
            "a[href*='quest']",
            "a[data-rac][href*='earn']",
            "a[data-bi-id][href*='earn']",
            "a[href*='promotional']",
        ];
        // 文本模式刻意排除"搜索/奖励"等宽泛词：首页搜索框与"奖励"导航页会命中它们，
        // 导致把导航链接误当打卡卡片点击、无谓开新页。
        const textPatterns = ["每日活动", "Daily Set", "限时活动", "特别活动", "打卡", "Punch", "Quest",
            "月度", "Monthly", "亮点", "Highlights"];

        // href 安全过滤：排除兑换/推荐/设置等非打卡导航链接，防止误点击开新窗口
        const isSafePunchHref = (href = "") => {
            if (!href) return false;
            try {
                const u = new URL(href);
                // /earn 及 /earn 落地页是导航而非打卡详情页（详情页路径含 /earn/quest/ 或 punchcard）
                if (/^\/earn\/?$/.test(u.pathname)) return false;
                if (u.hostname === "login.live.com") return false;
            } catch (_) {}
            const blocked = ["/redeem", "redeemgoal", "ref=", "refer", "sweepstakes", "aka.ms",
                "microsoft-store", "orderhistory", "xbox.com", "goal/all", "/dashboard",
                "login.live.com", "bing.com/redeem", "rewardspanel"];
            return !blocked.some(b => href.toLowerCase().includes(b.toLowerCase()));
        };
        
        const detailTextPatterns = [
            "关注赛事", "访问网站", "开始搜索",
            "发现", "探索", "获取", "Learn more", "了解更多",
            "Start", "Begin", "Watch", "View", "Check",
            "立即开始", "立即参与", "立即前往", "立即访问",
            "参加活动", "参与活动", "前往活动"
        ];

        const clickDetailTasks = async () => {
            // 与后台任务同一"今天"基准（运行起始日）：避免后台旧实例跨午夜运行时，
            // 前台即时日期与存储键错位导致打卡点击被重复执行
            const today = RewardsAuto.state.dateNowNum;
            const detailDateKey = "Config.punchCardDetailDate";
            const detailDoneKey = "Config.punchCardDetailDone";

            // 今日已处理过则跳过
            if (GM_getValue(detailDateKey, 0) === today && GM_getValue(detailDoneKey, false)) {
                Utils.log("🟢","[Rewards Auto] 详情页任务今日已处理");
                return true;
            }

            Utils.log("🟢","[Rewards Auto] 开始执行详情页任务点击...");
            // 【防封号】操作前随机延迟
            await Utils.randomDelay(3000, 6000);

            // 拓宽选择器：打卡详情页的任务按钮可能是 a/button，可能有也可能没有 data-rac
            const selectors = [
                "a[data-rac][target='_blank']:not([aria-disabled='true']):not([data-disabled='true'])",
                "a[target='_blank'][href*='bing.com']:not([aria-disabled='true']):not([data-disabled='true'])",
                "a[target='_blank'][href*='rewards']:not([aria-disabled='true']):not([data-disabled='true'])",
            ];

            let allButtons = [];
            for (const sel of selectors) {
                allButtons = Array.from(document.querySelectorAll(sel));
                if (allButtons.length > 0) {
                    Utils.log("🟢",`[Rewards Auto] 选择器 ${sel} 命中 ${allButtons.length} 个按钮`);
                    break;
                }
            }

            // 过滤已完成/禁用/无文本的按钮
            const clickable = allButtons.filter(b => {
                const text = (b.textContent || "").trim();
                const ariaLabel = b.getAttribute("aria-label") || "";
                const combined = text + " " + ariaLabel;
                if (/已完成|completed|done|✓|✔|已领取|claimed/i.test(combined)) return false;
                if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
                return combined.length > 1;
            });

            if (clickable.length === 0) {
                Utils.log("🟢","[Rewards Auto] 未找到可点击的任务按钮（可能全部完成或页面结构变化）");
                // 打印页面按钮诊断信息
                const diag = Array.from(document.querySelectorAll("a[target='_blank'], button"))
                    .map(b => (b.textContent || "").trim().substring(0, 30)).filter(t => t).slice(0, 10).join(" | ");
                if (diag) Utils.log("🟢",`[Rewards Auto] 页面按钮诊断: ${diag}`);
                // 不写入完成标记：可能只是页面尚未渲染完成，下次打开页面时重试。
                // （误判最坏情况只是多点击一轮，而误标完成会让当天的真实任务永久漏做）
                return false;
            }

            Utils.log("🟢",`[Rewards Auto] 找到 ${clickable.length} 个可点击任务按钮，逐个点击...`);
            let clicked = 0;

            // 快照方式逐个点击（每个按钮只点一次，避免重复）
            for (const btn of clickable) {
                const btnText = (btn.textContent || "").trim().substring(0, 40) || btn.getAttribute("aria-label") || "未知任务";
                Utils.log("🟢",`[Rewards Auto] 点击任务 (${clicked + 1}/${clickable.length}): "${btnText}"`);
                // 【防封号】点击前随机延迟
                await Utils.randomDelay(3000, 8000);
                try {
                    btn.click();
                    clicked++;
                } catch (e) {
                    Utils.log("🔴",`[Rewards Auto] 点击失败: ${e.message}`);
                }
            }

            Utils.log("🟢",`[Rewards Auto] 详情页任务完成，共点击 ${clicked} 个任务按钮`);
            GM_setValue(detailDateKey, today);
            GM_setValue(detailDoneKey, true);
            return true;
        };

        const clickPunchCards = async (depth = 0) => {
            if (depth > 5) {
                Utils.log("🟢","[Rewards Auto] 打卡递归深度超限，停止");
                return;
            }
            // 与后台任务同一"今天"基准，避免跨午夜与后台存储键错位（详见 clickDetailTasks）
            const today = RewardsAuto.state.dateNowNum;
            const stateKey = "Config.punchCardState";
            const dateKey = "Config.punchCardDate";
            const attemptKey = "Config.punchCardAttempts";
            const attemptDateKey = "Config.punchCardAttemptDate";
            const savedDate = GM_getValue(dateKey, 0);
            let state = savedDate === today ? GM_getValue(stateKey, 0) : 0;

            if (state >= 2) {
                Utils.log("🟢","[Rewards Auto] 打卡任务已完成");
                return;
            }

            // 每日尝试上限：当页面上没有可安全点击的打卡链接时，封顶尝试次数，
            // 避免每次页面加载都重复点击、无限打开新窗口
            const savedAttemptDate = GM_getValue(attemptDateKey, 0);
            let attempts = savedAttemptDate === today ? GM_getValue(attemptKey, 0) : 0;
            if (attempts >= 3) {
                Utils.log("🟢","[Rewards Auto] 今日打卡尝试已达上限，停止");
                return;
            }

            Utils.log("🟢",`[Rewards Auto] 打卡任务: ${state}/2`);
            // 【防封号】操作前随机延迟 3-8 秒
            await Utils.randomDelay(3000, 8000);

            let found = [];
            for (const sel of punchCardSelectors) {
                try {
                    const matched = await Utils.waitForElementsByText(sel, textPatterns, 10000);
                    // 只保留 href 安全的元素，排除兑换/推荐等导航链接
                    const safe = matched.filter(m => isSafePunchHref(m.element?.href || ""));
                    if (safe.length > 0) { found = safe; break; }
                } catch {}
            }

            // 兜底：文本模式未命中时，直接用选择器查找安全链接（不依赖活动名称）
            if (found.length === 0) {
                for (const sel of punchCardSelectors) {
                    try {
                        const els = Array.from(document.querySelectorAll(sel));
                        const safe = els.filter(el => isSafePunchHref(el.href || ""));
                        if (safe.length > 0) {
                            found = safe.map(el => ({ element: el, pattern: "selector-fallback" }));
                            Utils.log("🟢",`[Rewards Auto] 文本未命中，选择器兜底找到 ${safe.length} 个打卡入口`);
                            break;
                        }
                    } catch {}
                }
            }

            // 无论是否找到，都累加尝试次数并持久化
            GM_setValue(attemptKey, attempts + 1);
            GM_setValue(attemptDateKey, today);

            if (found.length === 0) {
                Utils.log("🟢","[Rewards Auto] 未找到可安全点击的打卡卡片");
                return;
            }

            if (state < found.length) {
                const target = found[state];
                Utils.log("🟢",`[Rewards Auto] 点击: ${target.pattern}`);
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
                    Utils.log("🔴",`[Rewards Auto] 点击失败: ${e.message}`);
                }
            }
        };

        const startPunchCards = () => {
            // 后台救援标签页（?bgprobe=1）必须保持被动：只维持转发通道，不做任何 DOM 点击
            if (location.search.includes("bgprobe")) return;
            setTimeout(async () => {
                const path = location.pathname;
                if (path.includes("/earn/quest/") || path.includes("punchcard")) {
                    Utils.log("🟢","[Rewards Auto] 检测到打卡详情页，开始执行任务点击...");
                    await clickDetailTasks();
                } else {
                    Utils.log("🟢","[Rewards Auto] 检测到奖励主页，开始执行卡片点击...");
                    await clickPunchCards();
                }
                // 每日活动与积分领取由 dashboard 专用前台处理器（autoClickDailySet/autoClaimPoints）
                // 及后台 crontab 的 doDailySet/doClaimPoints 负责，此处不再重复调用，
                // 避免在 /dashboard 页面与另一套处理器重叠执行造成重复上报
            }, 3000); // 延迟 3 秒等待页面渲染
        };
        
        if (document.readyState === "complete" || document.readyState === "interactive") {
            startPunchCards();
        } else {
            document.addEventListener("DOMContentLoaded", startPunchCards);
        }
    }

    // ====== 前台页面处理器（dashboard 页面内执行 DOM 操作） ======
    if (location.hostname === "rewards.bing.com" && location.pathname === "/dashboard") {
        // 后台救援标签页（?bgprobe=1）：只维持同源转发通道心跳/监听，
        // 不跑 DOM 自动领取与点击，避免页面导航打断转发、也避免误触前台 UI
        if (location.search.includes("bgprobe")) {
            Utils.log("🔗", "后台代理标签页就绪：仅维持同源转发通道，跳过前台 DOM 自动处理");
            return;
        }
        Utils.log("📅", "前台模式：监听后台指令...");

        // 自动领取积分函数（带重试：页面数据可能异步加载，首轮未命中时最多重试 5 轮）
        const autoClaimPoints = async () => {
            try {
                const MAX_RETRY = 5;
                for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
                    // 等待页面加载（外部已等 5 秒，此处首轮再等 3 秒，后续每轮等 4 秒）
                    await new Promise(r => setTimeout(r, attempt === 1 ? 3000 : 4000));

                    // 查找可领取按钮（拓宽到 button 和 [role="button"]，排除禁用态/已领取）
                    const claimableBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find(b => {
                        const text = (b.textContent || "").trim();
                        if (!text) return false;
                        if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
                        return text.includes("可领取") || (text.includes("领取") && !text.includes("已领取"));
                    });

                    if (!claimableBtn) {
                        if (attempt < MAX_RETRY) continue; // 页面数据可能尚未加载完，下一轮重试
                        const btnTexts = Array.from(document.querySelectorAll('button, [role="button"]'))
                            .map(b => (b.textContent || "").trim()).filter(t => t).slice(0, 15).join(" | ");
                        Utils.log("📅", `重试 ${MAX_RETRY} 轮后仍无可领取积分按钮；页面按钮: ${btnTexts || "(无)"}`);
                        return;
                    }

                    const amountMatch = (claimableBtn.textContent || "").match(/(\d[\d,]*)/);
                    const amount = amountMatch ? parseInt(amountMatch[1].replace(/,/g, '')) : 0;
                    Utils.log("🎁", `发现可领取积分按钮${amount > 0 ? `（${amount} 积分）` : ""}，开始领取...（第 ${attempt} 轮）`);

                    // 点击可领取按钮
                    claimableBtn.click();
                    await new Promise(r => setTimeout(r, 2500));

                    // 若弹出确认对话框，查找并点击其中的领取按钮；未弹窗视为直接领取
                    const dialog = document.querySelector('[role="dialog"]');
                    if (dialog) {
                        const claimBtn = Array.from(dialog.querySelectorAll('button, [role="button"]')).find(b => {
                            const t = (b.innerText || b.textContent || "").trim();
                            return (t.includes("领取") || /claim/i.test(t)) && !t.includes("已领取");
                        });
                        if (claimBtn) {
                            claimBtn.click();
                            await new Promise(r => setTimeout(r, 2500));
                        } else {
                            Utils.log("🟡", `第 ${attempt} 轮弹出对话框但未找到确认按钮，将重试`);
                            continue;
                        }
                    }

                    Utils.log("🎁", `${amount > 0 ? amount + " " : ""}积分领取操作完成`, true);
                    return;
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

                // 查找每日活动链接（rnoreward/earn 任务链接，排除兑换/推荐/导航类）
                const links = Array.from(document.querySelectorAll('a[href]')).filter(a => {
                    const href = (a.href || "").toLowerCase();
                    if (!href || href.startsWith("javascript:")) return false;
                    const blocked = ["/redeem", "ref=", "refer", "sweepstakes", "aka.ms", "orderhistory",
                        "goal/all", "login.live.com", "rewardspanel", "microsoft-store", "xbox.com"];
                    if (blocked.some(b => href.includes(b))) return false;
                    return href.includes("rnoreward") || href.includes("/earn/") || href.includes("punchcard");
                });

                // 过滤已完成的
                const incompleteLinks = links.filter(link => {
                    const text = link.textContent || "";
                    return !text.includes("已完成") && !text.includes("Completed");
                });

                Utils.log("📅", `找到 ${incompleteLinks.length} 个未完成的每日活动`);
                if (incompleteLinks.length === 0) {
                    const sample = Array.from(document.querySelectorAll('a[href]'))
                        .map(a => a.href).filter(h => h).slice(0, 10).join(" , ");
                    Utils.log("🔵", `未找到每日活动链接；页面链接样例: ${sample || "(无)"}`);
                }
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

        // 监听后台指令
        GM_addValueChangeListener("BingRewards_cmd", (name, oldValue, newValue) => {
            if (!newValue || newValue.processed) return;

            const cmd = newValue;
            Utils.log("📅", `收到后台指令: ${cmd.action}`);

            if (cmd.action === "clickDailySet") {
                autoClickDailySet().then(() => {
                    cmd.processed = true;
                    GM_setValue("BingRewards_cmd", cmd);
                });
            } else if (cmd.action === "claimPoints") {
                autoClaimPoints().then(() => {
                    cmd.processed = true;
                    GM_setValue("BingRewards_cmd", cmd);
                });
            } else {
                cmd.processed = true;
                GM_setValue("BingRewards_cmd", cmd);
            }
        });

        // 前台模式不执行后台任务
        return;
    }

})();
