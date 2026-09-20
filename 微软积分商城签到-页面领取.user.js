// ==UserScript==
// @name         微软积分商城签到-页面领取
// @namespace    local.bing-rewards-auto
// @version      4.3.0
// @description  《微软积分商城签到（全能智能重构版）》的页面侧领取组件。2026-09-17 抓包实证：Server Action 的入账判据在页面上下文成立（同 payload、同 action ID，页面内 POST /earn → 200 + 1:true，实测余额 +15），而 Service Worker 直连被边缘 503（返回 Bing 错误页 HTML）——这类"仅页面上下文可领"的 offer（如 WW_Rewards_locked_level2_*，unlockCriteria 已满足但不在 App 目录）只有本脚本能拿到。工作方式：仅在用户已打开 rewards.bing.com 页面时生效，不依赖 @storageName 跨脚本存储（v3.9.0 现场已证伪），不开救援标签页；自主抓取 earn/dashboard 的 flight 数据 → 解析待领 offer 与当次轮换 hash → 扫构建 chunk 定位当前部署的 reportActivity action ID → 页面内逐个上报 + 欢迎积分领取，15 分钟节流防重复。后台脚本下一轮复核到账后自然转入完成/放弃账本。
// @icon         https://bing.com/th?id=OMR.icon-96.png&pid=Rewards
// @license      MIT
// @match        https://rewards.bing.com/*
// @run-at       document-idle
// @grant        GM_log
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    // 测试挂钩先行注册：脚本后续任何一步抛错都不影响测试可达性
    try {
        globalThis.__pageClaim = {};
    } catch (_) {}
    // 兜底值仅用于 chunk 扫描失败时——action ID 随部署轮换，正常路径必须用扫出来的
    const FALLBACK_REPORT_ACTION = "707e6eb15bdfdd5fba193f0a77e934f7018faf87ce"; // 2026-09-16 dpl=20260916-2
    // 同一页面停留期间的节流窗口；?claimnow=1 强制执行（调试/手动触发用）
    const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
    const STATE_KEY = "bw_page_claim";
    const CHUNK_CACHE_KEY = "bw_page_claim_chunk";
    const AUTO_PATHS = ["/", "/dashboard", "/earn"];
    const OFFER_POST_DELAY = [2500, 5000];
    // 与主脚本 skipPatterns（config 默认列表，19 条，无用户配置通道）逐条照抄：
    // 页面侧代领同样必须尊重用户明确排除的类目，不能只靠后台账本兜底
    const SKIP_PATTERNS = [
        "referral", "refer and earn", "sweepstake", "entries",
        "install the", "set bing as your default", "bing wallpaper",
        "punch card", "ancient coin", "sea of thieves", "rewards extension",
        "redemption goal", "order history", "claim your gift", "shop to earn",
        "set goal", "Available tomorrow", "Offer is Locked", "Earn -1 points"
    ];

    const log = (...a) => {
        try { GM_log(`[页面领取] ${a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}`); }
        catch (_) { try { console.log("[页面领取]", ...a); } catch (_) {} }
    };

    const readState = () => {
        try { return JSON.parse(localStorage.getItem(STATE_KEY) || "{}") || {}; }
        catch (_) { return {}; }
    };
    const writeState = (patch) => {
        try { localStorage.setItem(STATE_KEY, JSON.stringify({ ...readState(), ...patch })); } catch (_) {}
    };

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const randBetween = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

    // ====== flight 流解析 ======
    // 页面把 RSC 数据以 self.__next_f.push([1,"..."]) 分片内嵌在 HTML 中，逐片 JSON
    // 解码后拼接为完整流；offer 对象（offerId/hash/isCompleted/isLocked/points）在其中。
    const concatFlightChunks = (html) => {
        let combined = "";
        for (const m of String(html || "").matchAll(/self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g)) {
            try { combined += JSON.parse(`"${m[1]}"`); } catch (_) { /* 单片损坏不影响其余 */ }
        }
        return combined;
    };

    // 从 anchor 位置向前找最近的 "{"，做字符串感知的花括号配对后 JSON.parse；
    // 命中过浅（对象在 anchor 前已闭合）或解析失败时继续向前扩，与真实对象边界对齐。
    const extractFlightObjects = (combined) => {
        const out = [];
        if (!combined) return out;
        const anchor = '"offerId"';
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
                    // 与主脚本对齐：转义仅在字符串内成立，字符串外的 \ 不得吞掉下一字符
                    if (inStr && c === "\\") { esc = true; continue; }
                    if (c === '"') { inStr = !inStr; continue; }
                    if (inStr) continue;
                    if (c === "{") depth++;
                    if (c === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
                }
                if (end === -1) break;
                // 对齐主脚本 extractFlightObjects 的两道守卫（v4.2.1 修复照抄时漏掉的回归）：
                // end 为开区间末位，end - 1 >= idx 即对象边界必须包住 anchor 位置；
                // 命中过浅（如 anchor 前最近的 { 是兄弟嵌套对象、在 anchor 前已闭合）
                // 或解析失败/结果不含 offerId 时继续向前扩，而不是就此 break 丢弃 offer。
                if (end > idx) {
                    try {
                        // 与主脚本对齐：$undefined 哨兵串归一为 null，避免非 nullish 哨兵
                        // 使 ?? 不回退（points 侧曾因此单向漏领）
                        const obj = JSON.parse(combined.slice(start, end).replace(/"\$undefined"/g, "null"));
                        if (obj && typeof obj === "object" && "offerId" in obj) {
                            if (typeof obj.offerId === "string") out.push(obj);
                            cursor = Math.max(cursor, end);
                            break;
                        }
                    } catch (_) { /* 边界未对齐，继续向前扩 */ }
                }
                start = start > 0 ? combined.lastIndexOf("{", start - 1) : -1;
            }
        }
        return out;
    };

    // 同一 offerId 在 flight 里可能出现多个对象（瘦对象 / 卡片富对象 / 印象对象）：
    // 任一对象宣称已完成或已锁定即出列（保守方向，避免无效上报）；hash 取首个非空值
    // （必须是当次加载的轮换值，服务端按当次 flight 校验）。
    const collectClaimableOffers = (combined) => {
        const byId = new Map();
        for (const obj of extractFlightObjects(combined)) {
            const id = obj.offerId;
            const prev = byId.get(id) || { offerId: id, hash: "", points: 0, completed: false, locked: false, title: "" };
            prev.completed = prev.completed || obj.isCompleted === true || obj.complete === true;
            prev.locked = prev.locked || obj.isLocked === true;
            // 40-64 hex 格式门：现网 hash 长度实测在 40-64 之间变动过（40 位 SHA-1 与
            // 64 位两代并存，见主脚本记录）；明显不是 hash 的串不得当作 hash 入领取链
            if (!prev.hash && typeof obj.hash === "string" && /^[a-f0-9]{40,64}$/i.test(obj.hash)) prev.hash = obj.hash;
            const pts = Number(obj.points ?? obj.pointProgressMax ?? 0);
            if (Number.isFinite(pts) && pts > prev.points) prev.points = pts;
            if (!prev.title && typeof obj.title === "string") prev.title = obj.title;
            byId.set(id, prev);
        }
        // 与主脚本 skipPatterns 对齐：title/offerId 任一字段大小写不敏感子串命中即出列
        return [...byId.values()].filter(o =>
            o.hash && o.points > 0 && !o.completed && !o.locked
            && !SKIP_PATTERNS.some(p =>
                o.title.toLowerCase().includes(p.toLowerCase()) ||
                o.offerId.toLowerCase().includes(p.toLowerCase())));
    };

    // ====== 请求构造 ======
    const routerStateTree = (url) => {
        const refreshFlag = 4096;
        let segment = "dashboard";
        try {
            const pathname = decodeURIComponent(new URL(url, location.origin).pathname).replace(/\/+$/, "");
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
                            null, null, refreshFlag,
                        ],
                    },
                    null, null, refreshFlag,
                ],
            },
            null, null, refreshFlag + 16,
        ];
        return encodeURIComponent(JSON.stringify(tree));
    };

    const fetchText = async (url) => {
        try {
            const res = await fetch(url, { credentials: "include", redirect: "follow" });
            return { status: res.status, text: await res.text() };
        } catch (_) {
            return { status: 0, text: "" };
        }
    };

    // 扫描构建 chunk 定位当前部署的 reportActivity action ID。
    // 真实产物形态（2026-09-17 抓取 dpl=20260916-2 实测）：
    //   let n=(0,t.createServerReference)("707e6eb15bdfdd5fba193f0a77e934f7018faf87ce",
    //                                      t.callServer,void 0,t.findSourceMapURL,"reportActivity")
    // 注意 createServerReference 被压缩包在分组括号里（`)("...`），其与 action ID 之间
    // 允许出现任意少量字符——v3.9.0 旧正则要求紧跟 `("`，对现网产物永不命中（只能吃
    // fallback 的过期 action ID，一旦部署轮换即失效）。chunk 路径在 flight 里以 `\/`
    // 转义，匹配前先反转义。
    const resolveActionId = async (htmlAll, dpl) => {
        // 同一部署内复用扫描结果：action ID 只随部署轮换，每次扫描重抓最多 24 个 chunk
        // 既费流量又拖 2-6 秒。localStorage 是页面同源存储（本脚本节流状态同样用它），
        // 不违反"无跨脚本存储"的自包含约束；dpl 一变即失效，不会吃旧部署的 ID。
        if (dpl) {
            try {
                const cached = JSON.parse(localStorage.getItem(CHUNK_CACHE_KEY) || "null");
                if (cached && cached.dpl === dpl && /^[a-f0-9]{40,64}$/i.test(String(cached.id || ""))) return cached.id;
            } catch (_) { /* 缓存损坏当未命中 */ }
        }
        try {
            const unescaped = String(htmlAll).replace(/\\\//g, "/").replace(/\\u0026/gi, "&");
            const chunkUrls = [...new Set([...unescaped.matchAll(/\/_next\/static\/chunks\/[\w\-./()%]+?\.js/g)].map(m => m[0]))].slice(0, 24);
            for (const cu of chunkUrls) {
                const js = await fetchText(cu + (dpl ? `?dpl=${dpl}` : ""));
                if (!js.text.includes("reportActivity")) continue;
                // 锚在 reportActivity 名字上：同一 createServerReference 调用里，ID 在名字之前。
                // 长度必须用 {40,64} 宽区间——实测 ID 为 **42 位**（707e6eb15bdfdd5fba193f0a77e934f7018faf87ce），
                // 写死 {40} 会静默截断成无效 ID。不用 `createServerReference\)?\("id"` 这种紧邻
                // 假设：压缩产物里 `createServerReference)("id"` 与 ID 之间可能夹分组括号。
                const am = js.text.match(/createServerReference[\s\S]{0,60}?([a-f0-9]{40,64})[\s\S]{0,300}?"reportActivity"/);
                if (am) {
                    if (dpl) { try { localStorage.setItem(CHUNK_CACHE_KEY, JSON.stringify({ dpl, id: am[1] })); } catch (_) {} }
                    return am[1];
                }
            }
        } catch (_) {}
        return "";
    };

    const postServerAction = async (url, actionId, body, dpl) => {
        const headers = {
            "accept": "text/x-component",
            "content-type": "text/plain;charset=UTF-8",
            "next-action": actionId,
            "next-router-state-tree": routerStateTree(url),
        };
        if (dpl) headers["x-deployment-id"] = dpl;
        try {
            const res = await fetch(url, { method: "POST", headers, body, credentials: "include" });
            const text = await res.text();
            // 入账判据（抓包实证）：响应含 1:true 即 action 被执行。注意对已完成 offer
            // 重放同样返回 1:true 而不入账——是否真正到账由后台下一轮复核确认。
            return { status: res.status, accepted: res.status === 200 && text.includes("1:true"), text };
        } catch (e) {
            return { status: 0, accepted: false, text: String((e && e.message) || e) };
        }
    };

    // ====== 主流程：自扫描领取 ======
    let sweeping = false;
    const runSweep = async (reason) => {
        if (sweeping) return null;
        sweeping = true;
        const startedAt = Date.now();
        try {
            const [earn, dash] = await Promise.all([
                fetchText("https://rewards.bing.com/earn"),
                fetchText("https://rewards.bing.com/dashboard"),
            ]);
            if (earn.status !== 200 && dash.status !== 200) {
                log(`扫描跳过（${reason}）：earn/dashboard 抓取失败`, earn.status, dash.status);
                return null;
            }
            const htmlAll = earn.text + dash.text;
            const combined = concatFlightChunks(earn.text) + concatFlightChunks(dash.text);
            const dpl = (htmlAll.match(/dpl=([0-9][0-9A-Za-z.\-]*)/) || [])[1] || "";

            const offers = collectClaimableOffers(combined);
            const actionId = await resolveActionId(htmlAll, dpl) || FALLBACK_REPORT_ACTION;
            log(`扫描开始（${reason}）: ${offers.length} 个待领 offer, action=${actionId.slice(0, 12)}…, dpl=${dpl || "?"}`);

            let accepted = 0;
            const results = [];
            for (const o of offers) {
                const body = JSON.stringify([o.hash, 11, {
                    offerid: o.offerId,
                    isPromotional: "$undefined",
                    timezoneOffset: String(new Date().getTimezoneOffset()),
                }]);
                const r = await postServerAction("https://rewards.bing.com/earn", actionId, body, dpl);
                if (r.accepted) accepted++;
                results.push({ offerId: o.offerId, points: o.points, status: r.status, accepted: r.accepted });
                log(`领取${r.accepted ? " ✅" : " ❌"} ${o.offerId} +${o.points}p HTTP ${r.status}${r.accepted ? "" : " " + String(r.text).slice(0, 80)}`);
                await sleep(randBetween(OFFER_POST_DELAY[0], OFFER_POST_DELAY[1]));
            }

            // 欢迎页「可领取」积分：POST dashboard 空参数数组，next-action 取页面下发的
            // $ACTION_ID_（仅当页面存在可领取项时随 flight 下发）；无待领时响应不含 1:true。
            let welcome = { status: 0, accepted: false };
            try {
                // {40,64} 宽区间：现网 $ACTION_ID_ 实测 42 位，写死 {40} 会截出无效前缀，
                // 且截断后候选数仍为 1、反而优先于兜底值被采用
                const ids = [...new Set([...String(dash.text + combined).matchAll(/\$ACTION_ID_([a-f0-9]{40,64})/g)].map(m => m[1]))];
                if (ids.length === 1) {
                    // 页面下发唯一 $ACTION_ID_ 即"存在待领"信号（〇-Z：该字段仅当页面有
                    // 可领项时随 flight 下发）。无信号/候选歧义时拿旧 ID POST 必不被受理，
                    // v4.2.1 起直接跳过——原 42 位兜底常量路径随之退役。
                    welcome = await postServerAction("https://rewards.bing.com/dashboard", ids[0], "[]", dpl);
                    log(`欢迎积分领取 HTTP ${welcome.status}`, welcome.accepted ? "✅" : "（未受理）");
                } else {
                    log("欢迎积分无待领信号（页面未下发唯一 $ACTION_ID_），跳过领取");
                }
            } catch (e) {
                log("欢迎积分领取异常", String((e && e.message) || e));
            }

            const rec = {
                lastRunAt: startedAt,
                lastRunReason: reason,
                lastResult: { ok: accepted, total: offers.length, results, welcomeAccepted: welcome.accepted, actionId: actionId.slice(0, 12), dpl },
            };
            writeState(rec);
            log(`扫描完成: ${accepted}/${offers.length} 个上报受理（到账由后台下一轮复核确认）`);
            return rec.lastResult;
        } finally {
            sweeping = false;
        }
    };

    // 触发条件：仅 rewards 页 + 常用路径（或 ?claimnow=1 强制）；15 分钟节流。
    const maybeRun = () => {
        const force = /(?:^|[?&])claimnow=1(?:&|$)/.test(location.search);
        const pathname = (location.pathname || "/").replace(/\/+$/, "") || "/";
        if (!force && !AUTO_PATHS.includes(pathname)) return false;
        const last = Number(readState().lastRunAt || 0);
        if (!force && Date.now() - last < SWEEP_INTERVAL_MS) return false;
        // 先落时间戳再执行：即使本次失败也占住窗口，避免每个页面视图都重扫一遍
        writeState({ lastRunAt: Date.now(), lastRunReason: force ? "claimnow" : "auto" });
        // 等页面自身加载完成后再扫，避免与首屏请求竞争带宽
        setTimeout(() => { runSweep(force ? "claimnow" : "auto").catch(e => log("扫描异常:", String((e && e.message) || e))); }, force ? 2000 : 6000);
        return true;
    };

    // ====== 菜单：状态查看与手动触发 ======
    try {
        GM_registerMenuCommand("🧾 页面领取状态（本页）", () => {
            const s = readState();
            const r = s.lastResult || {};
            const ago = s.lastRunAt ? `${Math.max(0, Math.round((Date.now() - s.lastRunAt) / 1000))} 秒前` : "从未";
            alert([
                "上下文: rewards 页面（本页脚本已注入）",
                `最近扫描: ${ago}（触发源: ${s.lastRunReason || "?"}）`,
                `上次结果: ${r.ok ?? 0}/${r.total ?? 0} 个上报受理${r.welcomeAccepted ? "，欢迎积分已受理" : ""}`,
                r.dpl ? `部署: ${r.dpl}（action ${r.actionId || "?"}…）` : "",
                "",
                "仅当本页打开时生效；15 分钟自动节流一次。",
                "后台脚本下一轮会复核到账并记入完成/放弃账本。",
            ].filter(Boolean).join("\n"));
        });
        GM_registerMenuCommand("▶️ 立即领取（本页）", () => {
            writeState({ lastRunAt: 0 });
            runSweep("manual").then(r => {
                alert(r ? `完成: ${r.ok}/${r.total} 个上报受理` : "扫描未执行（抓取失败或已有任务在跑）");
            }).catch(e => alert("扫描异常: " + String((e && e.message) || e)));
        });
    } catch (_) { /* 菜单注册失败不影响自动流程 */ }

    maybeRun();

    // ====== 测试挂钩（无 GM 环境的 vm 测试需要直接调用内部函数） ======
    try {
        Object.assign(globalThis.__pageClaim, {
            concatFlightChunks, extractFlightObjects, collectClaimableOffers,
            routerStateTree, resolveActionId, postServerAction, runSweep, maybeRun, readState,
        });
    } catch (_) {}
})();
