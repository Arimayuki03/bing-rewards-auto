// ==UserScript==
// @name         微软积分商城签到-页面领取
// @namespace    local.bing-rewards-auto
// @version      4.5.0
// @description  《微软积分商城签到（全能智能重构版）》的页面侧诊断组件。主脚本 v4.5.0 起每日任务/活动卡片/欢迎积分改为提醒模式（当日一次通知，用户手动领取），本组件同步退役页面内自动领取，保留两个只读工具：🧾 查看本页视角的 flight 数据/待领 offer/部署与 action ID 形态、🩺 日常卡片诊断——用于站点改版后验证数据载体与解析链是否仍然有效。历史：2026-09-17 抓包实证 Server Action 入账判据仅在页面上下文成立（SW 直连被边缘 503），v4.4.x 曾承担"仅页面可领 offer"的自动代领（?autoclaim=1 握手 + 清扫后信号 cookie 回传），随主脚本提醒模式一并退役。
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
                if (am) return am[1];
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

    // ====== 菜单：只读诊断（v4.5.0：自动领取已退役，仅保留诊断工具） ======
    try {
        GM_registerMenuCommand("🧾 页面注入状态（本页）", () => {
            alert([
                "上下文: rewards 页面（本组件已注入）",
                "v4.5.0 起每日任务/活动卡片/欢迎积分为提醒模式，",
                "由主脚本通知、用户手动领取，本组件不再自动领取。",
                "如需查看数据载体形态，请用「🩺 日常卡片诊断（本页）」。",
            ].join("\n"));
        });
        GM_registerMenuCommand("🩺 日常卡片诊断（本页）", async () => {
            const lines = [];
            try {
                const [earn, dash] = await Promise.all([
                    fetchText("https://rewards.bing.com/earn"),
                    fetchText("https://rewards.bing.com/dashboard"),
                ]);
                lines.push(`【页面抓取】earn HTTP ${earn.status}（${earn.text.length}B）, dashboard HTTP ${dash.status}（${dash.text.length}B）`);
                const combined = concatFlightChunks(earn.text) + concatFlightChunks(dash.text);
                lines.push(`【flight 流】拼接后 ${combined.length} 字符（0 = 页面结构可能已改版）`);
                const offers = collectClaimableOffers(combined);
                lines.push(`【待领 offer】${offers.length} 个（手动打开 rewards.bing.com 领取）`);
                for (const o of offers.slice(0, 12)) {
                    lines.push(`  - ${o.offerId} +${o.points}p`);
                }
                const dpl = ((earn.text + dash.text).match(/dpl=([0-9][0-9A-Za-z.\-]*)/) || [])[1] || "";
                const actionId = await resolveActionId(earn.text + dash.text, dpl);
                lines.push(`【Action ID】${actionId ? `✅ ${actionId.slice(0, 16)}…（dpl=${dpl || "?"}）` : "❌ 未能解析（站点可能已改版）"}`);
                lines.push("", "— 以上为只读探测，未发送任何领取请求 —");
            } catch (e) {
                lines.push(`诊断异常: ${e.message}`);
            }
            alert(lines.join("\n"));
        });
    } catch (_) { /* 菜单注册失败不影响诊断 */ }

    // ====== 测试挂钩（无 GM 环境的 vm 测试需要直接调用内部函数） ======
    try {
        Object.assign(globalThis.__pageClaim, {
            concatFlightChunks, extractFlightObjects, collectClaimableOffers,
            routerStateTree, resolveActionId, postServerAction, fetchText,
        });
    } catch (_) {}
})();
