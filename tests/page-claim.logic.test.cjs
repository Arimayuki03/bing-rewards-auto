// 页面领取脚本（微软积分商城签到-页面领取.user.js）的逻辑测试。
// 该脚本无 GM 依赖，用最小 vm 环境加载后经 globalThis.__pageClaim 断言内部函数。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const pageScriptPath = path.resolve(__dirname, "..", "微软积分商城签到-页面领取.user.js");

// 与主测试 harness 同构的 flight 构造：把 payload 串成 self.__next_f.push 分片
function flightHtml(...payloads) {
    const pushes = payloads
        .map(p => `self.__next_f.push([1,${JSON.stringify(p)}])`)
        .join(";</script><script>");
    return `<html><body><script>${pushes}</script></body></html>`;
}

function createPageHarness({ search = "", pathname = "/earn", fetchImpl, gmLog, seedState } = {}) {
    const store = new Map();
    const source = fs.readFileSync(pageScriptPath, "utf8");

    // 预置状态：脚本在加载时就会调用一次 maybeRun()，需要隔离它的用例
    // （如直接调用 runSweep 的用例）可先占住节流窗口，避免自动扫描混入断言。
    if (seedState) store.set("bw_page_claim", JSON.stringify(seedState));

    // fetch 打桩：默认返回空 HTML，用例按 URL 定制
    const fetchCalls = [];
    const fetchStub = async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        if (fetchImpl) {
            const r = await fetchImpl(String(url), init || {});
            if (r) return r;
        }
        return { status: 200, text: async () => "<html></html>" };
    };

    const timers = [];
    const context = {
        URL,
        URLSearchParams,
        clearTimeout,
        console: { debug() {}, error() {}, log() {}, warn() {} },
        fetch: fetchStub,
        // 记录调度但仍以 0 延迟真实执行：runSweep 内部的 sleep() 依赖 setTimeout 能否
        // resolve，只记录不执行会让扫描永久挂起（本文件首轮运行即踩到）。
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return setTimeout(fn, 0); },
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: (k) => store.delete(k),
        },
        location: { hostname: "rewards.bing.com", pathname, search, origin: "https://rewards.bing.com", href: `https://rewards.bing.com${pathname}${search}` },
        GM_log: gmLog || (() => {}),
        GM_registerMenuCommand: () => {},
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: pageScriptPath });
    return { ...context.__pageClaim, context, store, fetchCalls, timers };
}

// ====== flight 解析 ======

test("pageCollector filters completed and locked offers, keeps claimable ones with current hash", () => {
    const { collectClaimableOffers } = createPageHarness();
    const combined = [
        { offerId: "DONE", hash: "a".repeat(64), points: 10, isCompleted: true },
        { offerId: "LOCKED", hash: "b".repeat(64), points: 10, isLocked: true, unlockCriteria: "rewardsApp" },
        { offerId: "OPEN", hash: "c".repeat(64), points: 15 },
        { offerId: "NO_POINTS", hash: "d".repeat(64), points: 0 },
        { offerId: "NO_HASH", points: 5 },
    ].map(o => JSON.stringify(o)).join(",");

    const offers = collectClaimableOffers(combined);

    assert.deepEqual(Array.from(offers, o => o.offerId), ["OPEN"]);
    assert.equal(offers[0].hash, "c".repeat(64));
    assert.equal(offers[0].points, 15);
});

test("pageCollector treats any variant of the same offerId as authoritative for done/locked", () => {
    const { collectClaimableOffers } = createPageHarness();
    // 同一 offer 先出现瘦对象（无状态）再出现富对象（isCompleted）——保守出列
    const combined = [
        { offerId: "DUP", hash: "a".repeat(64), points: 15 },
        { offerId: "DUP", hash: "a".repeat(64), points: 15, isCompleted: true, title: "T" },
    ].map(o => JSON.stringify(o)).join(",");

    const offers = collectClaimableOffers(combined);

    assert.equal(offers.length, 0, "任一变体宣称已完成即不得再上报");
});

test("pageCollector extracts nested flight objects via brace matching", () => {
    const { collectClaimableOffers } = createPageHarness();
    // 嵌套对象（attributes 等）不得影响边界判定
    const combined = JSON.stringify({
        wrapper: { deep: [{ offerId: "NESTED", hash: "e".repeat(64), points: 10, attributes: { a: { b: 1 } } }] },
    });

    const offers = collectClaimableOffers(combined);

    assert.deepEqual(Array.from(offers, o => o.offerId), ["NESTED"]);
});

// ====== 请求构造 ======

test("routerStateTree encodes the earn segment like the observed browser request", () => {
    const { routerStateTree } = createPageHarness();
    const tree = JSON.parse(decodeURIComponent(routerStateTree("https://rewards.bing.com/earn")));

    assert.equal(tree[1].children[1].children[0], "earn");
    assert.equal(tree[1].children[1].children[1].children[0], "__PAGE__");
    // 真实浏览器请求观测值：顶层 5 元素，末尾 refreshFlag+16 = 4112
    assert.equal(tree.length, 5);
    assert.equal(tree[4], 4112);
});

test("resolveActionId scans chunks for createServerReference(reportActivity)", async () => {
    // 真实产物形态（2026-09-17 实测）：createServerReference 被压缩包在分组括号里
    const chunk = `386334,e=>{"use strict";var t=e.i(95187);let n=(0,t.createServerReference)("${"f".repeat(40)}",t.callServer,void 0,t.findSourceMapURL,"reportActivity");e.s(["reportActivity",0,n])}`;
    const { resolveActionId } = createPageHarness({
        fetchImpl: async (url) => {
            if (url.includes("/_next/static/chunks/")) return { status: 200, text: async () => chunk };
            return { status: 200, text: async () => "" };
        },
    });

    const html = `<script src="/_next/static/chunks/abc.js?dpl=20260916-2"></script>`;
    const id = await resolveActionId(html, "20260916-2");

    assert.equal(id, "f".repeat(40), "必须兼容 createServerReference)( 的分组括号形态");
});

test("resolveActionId matches the exact production chunk shape (2026-09-17 captured)", async () => {
    // 逐字取自真实产物（dpl=20260916-2, chunk 3pg1ui3anrk2b.js）——
    // createServerReference 前有 (0,t. 分组，其后紧跟 )(，ID 在名字之前；
    // 关键：该 ID 是 42 位（非 40 位），长度写死 {40} 会静默截断出无效 ID。
    const REAL_ID = "707e6eb15bdfdd5fba193f0a77e934f7018faf87ce";
    assert.equal(REAL_ID.length, 42, "生产 ID 长度前提（抓包实测）");
    const realChunk = 'document?document.currentScript:void 0,386334,e=>{"use strict";var t=e.i(95187);let n=(0,t.createServerReference)("' + REAL_ID + '",t.callServer,void 0,t.findSourceMapURL,"reportActivity");e.s(["reportActivity",0,n])},695144,e=>{"use strict"}';

    const m = realChunk.match(/createServerReference[\s\S]{0,60}?([a-f0-9]{40,64})[\s\S]{0,300}?"reportActivity"/);
    assert.ok(m, "正则必须命中真实产物形态");
    assert.equal(m[1], REAL_ID, "必须完整捕获 42 位 ID，不得截断");
});

test("resolveActionId handles escaped chunk paths and skips chunks without the name", async () => {
    const chunkWithName = `let n=(0,t.createServerReference)("${"a".repeat(40)}",t.callServer,void 0,t.findSourceMapURL,"reportActivity")`;
    const fetchCalls = [];
    const { resolveActionId } = createPageHarness({
        fetchImpl: async (url) => {
            fetchCalls.push(url);
            if (url.includes("3pg1ui3anrk2b")) return { status: 200, text: async () => chunkWithName };
            // 其余 chunk 含 reportActivity 名字但不是定义处（无 40 位 hex 前置）
            return { status: 200, text: async () => `await reportActivity(x.hash,11,{offerid})` };
        },
    });
    // flight 流里的 chunk 路径是 \/ 转义形态
    const html = `\\/_next\\/static\\/chunks\\/aaa.js\\/_next\\/static\\/chunks\\/3pg1ui3anrk2b.js?dpl=20260916-2`;
    const id = await resolveActionId(html, "20260916-2");

    assert.equal(id, "a".repeat(40), "转义路径必须能还原并扫描");
    assert.ok(fetchCalls.some(u => u.includes("3pg1ui3anrk2b")), "应实际请求到含定义的 chunk");
});

test("postServerAction treats only 200 + 1:true as accepted", async () => {
    const cases = [
        { status: 200, body: "0:{\"a\":\"$@1\"}\n1:true\n", accepted: true },
        { status: 200, body: "2:\"$Sreact.fragment\"\n5:I[1,[],\"\"]\n", accepted: false }, // 重渲染流，无 1:true
        { status: 503, body: "<!DOCTYPE html><html><head><title>Bing</title>", accepted: false },
    ];
    for (const c of cases) {
        const { postServerAction } = createPageHarness({
            fetchImpl: async () => ({ status: c.status, text: async () => c.body }),
        });
        const r = await postServerAction("https://rewards.bing.com/earn", "a".repeat(40), "[]", "20260916-2");
        assert.equal(r.accepted, c.accepted, `status=${c.status} body=${c.body.slice(0, 20)}`);
    }
});

test("postServerAction sends credentials and the deployment header", async () => {
    const { postServerAction, fetchCalls } = createPageHarness({
        fetchImpl: async () => ({ status: 200, text: async () => "1:true" }),
    });

    await postServerAction("https://rewards.bing.com/earn", "b".repeat(40), "[]", "20260916-2");

    const call = fetchCalls.find(c => c.init && c.init.method === "POST");
    assert.ok(call, "must issue a POST");
    assert.equal(call.init.credentials, "include", "页面上下文领取必须携带真实登录 cookie");
    assert.equal(call.init.headers["next-action"], "b".repeat(40));
    assert.equal(call.init.headers["x-deployment-id"], "20260916-2");
    assert.equal(call.init.headers["accept"], "text/x-component");
});

// ====== 端到端扫描 ======

test("runSweep posts every claimable offer with its current hash and reports accepted counts", async () => {
    const offers = [
        { offerId: "A", hash: "a".repeat(64), points: 15 },
        { offerId: "B", hash: "b".repeat(64), points: 10 },
    ];
    const chunk = `createServerReference("${"c".repeat(40)}",t.callServer,void 0,t.findSourceMapURL,"reportActivity")`;
    const posts = [];
    const { runSweep } = createPageHarness({
        // 占住节流窗口，隔离脚本加载时的自动扫描
        seedState: { lastRunAt: Date.now() },
        fetchImpl: async (url, init) => {
            if (init && init.method === "POST") {
                posts.push({ url, body: init.body, headers: init.headers });
                return { status: 200, text: async () => "0:{}\n1:true\n" };
            }
            if (url.includes("/_next/static/chunks/")) return { status: 200, text: async () => chunk };
            if (url.endsWith("/earn")) {
                // 真实页面 HTML 同时含 flight 分片与 chunk 引用，action ID 靠后者定位
                return { status: 200, text: async () => flightHtml(JSON.stringify({ activityCards: offers }))
                    .replace("</body>", '<script src="/_next/static/chunks/x.js?dpl=20260916-2"></script></body>') };
            }
            return { status: 200, text: async () => "<html></html>" };
        },
    });

    const result = await runSweep("test");

    assert.equal(result.ok, 2, "两个 offer 均应上报受理");
    assert.equal(result.total, 2);
    const offerPosts = posts.filter(p => p.url.endsWith("/earn"));
    assert.equal(offerPosts.length, 2);
    const first = JSON.parse(offerPosts[0].body);
    assert.equal(first[0], "a".repeat(64), "必须用当次 flight 的轮换 hash");
    assert.equal(first[1], 11);
    assert.equal(first[2].offerid, "A");
    assert.equal(offerPosts[0].headers["next-action"], "c".repeat(40), "action ID 必须来自 chunk 扫描");
});

test("runSweep skips entirely when both page fetches fail", async () => {
    const posts = [];
    const { runSweep } = createPageHarness({
        fetchImpl: async (url, init) => {
            if (init && init.method === "POST") { posts.push(url); return { status: 200, text: async () => "1:true" }; }
            return { status: 503, text: async () => "<!DOCTYPE html>" };
        },
    });

    const result = await runSweep("test");

    assert.equal(result, null);
    assert.equal(posts.length, 0, "页面抓取失败时不得发出任何上报");
});

// ====== 触发与节流 ======

test("maybeRun only fires on rewards paths and throttles repeated runs", () => {
    // 脚本加载时自身会调用一次 maybeRun()：/earn 属常用路径，应自动调度一次
    const { maybeRun, store, timers } = createPageHarness({ pathname: "/earn", search: "" });

    assert.equal(timers.length, 1, "进入 earn 页应自动调度一次扫描");
    assert.ok(Number(JSON.parse(store.get("bw_page_claim")).lastRunAt) > 0, "时间戳必须先落地占住窗口");

    assert.equal(maybeRun(), false, "15 分钟窗口内不得重复扫描");
    assert.equal(timers.length, 1);
});

test("maybeRun ignores unrelated paths but claimnow=1 forces a run", () => {
    // 非常用路径：加载时不调度
    const unrelated = createPageHarness({ pathname: "/redeem", search: "" });
    assert.equal(unrelated.timers.length, 0, "非常用路径不自动扫描");
    assert.equal(unrelated.maybeRun(), false);
    assert.equal(unrelated.timers.length, 0);

    // claimnow=1 强制：任何 rewards 路径都调度
    const forced = createPageHarness({ pathname: "/redeem", search: "?claimnow=1" });
    assert.equal(forced.timers.length, 1, "claimnow=1 在任意 rewards 路径强制扫描");
    assert.equal(JSON.parse(forced.store.get("bw_page_claim")).lastRunReason, "claimnow");
});

test("maybeRun re-fires after the throttle window elapses", () => {
    const h = createPageHarness({ pathname: "/dashboard", search: "" });
    assert.equal(h.timers.length, 1);

    // 手动把时间戳拨回 16 分钟前
    const state = JSON.parse(h.store.get("bw_page_claim"));
    state.lastRunAt = Date.now() - 16 * 60 * 1000;
    h.store.set("bw_page_claim", JSON.stringify(state));

    assert.equal(h.maybeRun(), true, "节流窗口过后应重新扫描");
    assert.equal(h.timers.length, 2);
});

// ====== 与主脚本的协作契约 ======

test("page claim script stays self-contained: no cross-script storage, no rescue tab", () => {
    const source = fs.readFileSync(pageScriptPath, "utf8");
    // 只检查元数据指令行——@description 里提到 @storageName 属说明文字，不构成依赖
    const directive = (name) => new RegExp(`^\\/\\/ ${name}\\b`, "m").test(source);
    // v3.9.0 现场已证伪 @storageName 跨脚本共享；本脚本不得依赖它
    assert.ok(!directive("@storageName"), "must not declare @storageName");
    assert.ok(!/GM_(get|set)Value\(\s*["']BingRewards_/.test(source), "must not use the retired bridge keys");
    // 不引入救援标签页/后台调度
    assert.ok(!/GM_openInTab/.test(source), "must not open tabs");
    assert.ok(!directive("@crontab"), "must not be a background-scheduled script");
    // 只注入 rewards 域
    const matches = [...source.matchAll(/^\/\/ @match\s+(.+)$/gm)].map(m => m[1].trim());
    assert.deepEqual(Array.from(matches), ["https://rewards.bing.com/*"]);
});
