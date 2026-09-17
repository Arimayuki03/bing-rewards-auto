const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const scriptPath = path.resolve(__dirname, "..", "微软积分商城签到（全能智能重构版）.user.js");

function createHarness(initialStorage = {}, { gmXhr, gmCookie } = {}) {
    const storage = new Map(Object.entries(initialStorage));
    const intervals = { set: [], cleared: [] };
    const openTabs = [];
    let source = fs.readFileSync(scriptPath, "utf8");
    const entryPattern = /\s*\/\/ ====== 后台模式入口 ======\s*\r?\n\s*init\(\);\s*\r?\n\s*\}\)\(\);/;
    assert.match(source, entryPattern, "test harness could not locate the userscript entry point");
    source = source.replace(entryPattern, `
    globalThis.__userscriptTest = { RewardsAuto, Utils, API, TaskManager };
})();`);

    const context = {
        URL,
        URLSearchParams,
        clearTimeout,
        console: { debug() {}, error() {}, log() {} },
        crypto: globalThis.crypto,
        GM_addValueChangeListener() {},
        GM_cookie() {},
        GM_getValue(key, defaultValue) {
            return storage.has(key) ? storage.get(key) : defaultValue;
        },
        GM_info: { script: { name: "Rewards Auto Test" } },
        GM_log() {},
        GM_notification() {},
        // v3.7.0：记录 GM_openInTab 调用（策略5 真实标签页兜底）供断言
        GM_openInTab: (url, opts) => { openTabs.push({ url, opts }); return { close() {} }; },
        GM_registerMenuCommand() {},
        GM_setValue(key, value) {
            storage.set(key, value);
        },
        GM_xmlhttpRequest: gmXhr || function () {
            throw new Error("unexpected GM_xmlhttpRequest call");
        },
        // 默认按 ScriptCat 语义同步回调空列表（cookieHeaderFor 因此立即返回 ""）；
        // 需要模拟 cookie 的用例可通过 createHarness 的 gmCookie 选项覆盖
        GM_cookie: gmCookie || function (...args) {
            const callback = args.find(a => typeof a === "function");
            if (callback) callback([]);
        },
        alert() {},
        confirm() { return false; },
        location: { hostname: "test.invalid", pathname: "/", search: "" },
        prompt() { return null; },
        setTimeout,
        // runAll 的运行锁心跳通过计时器实现；记录回调与周期供断言/手动触发使用
        setInterval: (fn, ms) => { intervals.set.push({ fn, ms }); return intervals.set.length; },
        clearInterval: (id) => { intervals.cleared.push(id); },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: scriptPath });
    return { ...context.__userscriptTest, storage, intervals, openTabs };
}

test("claimCard returns false when all earn-action strategies fail (legacy path retired)", async () => {
    const { API, Utils } = createHarness();
    API.appActivity = async () => null; // 无 Token：App 主路径不可用，静默落网页策略
    API._resolveReportActivityActionId = async () => "f".repeat(40);
    Utils.xhr = async () => { throw new Error("server action failed"); };
    Utils.fetchPage = async () => ""; // live hash 重试也拿不到 → 短路到放弃
    let legacyCalls = 0;
    API.reportActivity = async () => { legacyCalls++; return false; };

    const result = await API.claimCard({ offerId: "offer", hash: "hash" });

    assert.equal(result, false);
    assert.equal(legacyCalls, 0, "v3.6.11: dead legacy reportactivity must no longer be called");
});

// ====== v4.2.0：边缘拦截识别 → 转交页面领取脚本（2026-09-17 抓包实证）======

test("isEdgeBlockedError recognizes the 503 + Bing error page signature only", () => {
    const { Utils } = createHarness();
    // 实测形态：SW 直连 Server Action 被边缘拦截时抛出的错误消息
    assert.equal(Utils.isEdgeBlockedError(new Error('HTTP 503: <!DOCTYPE html><html xml:lang="en"><head><title>Bing</title>')), true);
    assert.equal(Utils.isEdgeBlockedError(new Error("HTTP 503: <html>blocked</html>")), true);
    // 其他失败形态不得误判（否则会跳过仍可能成功的网页策略）
    assert.equal(Utils.isEdgeBlockedError(new Error("HTTP 500: 1:E{\"digest\":\"D\"}")), false);
    assert.equal(Utils.isEdgeBlockedError(new Error("HTTP 503: service unavailable")), false, "无 HTML 体的 503 不算边缘拦截");
    assert.equal(Utils.isEdgeBlockedError(new Error("2xx 无 1:true（cookie 链缺失特征）: 0:{}")), false);
    assert.equal(Utils.isEdgeBlockedError(null), false);
});

test("claimCard short-circuits remaining strategies once edge-blocked and hands off to the page script", async () => {
    const { API, Utils } = createHarness();
    API.appActivity = async () => null; // App 路径不可用
    API._resolveReportActivityActionId = async () => "f".repeat(42);
    let posts = 0;
    Utils.xhr = async options => {
        if (options.method === "POST") {
            posts++;
            // 边缘拦截的真实形态
            throw new Error('HTTP 503: <!DOCTYPE html><html xml:lang="en"><head><title>Bing</title></head></html>');
        }
        return "<html></html>";
    };
    Utils.fetchPage = async () => "";

    const ok = await API.claimCard({ offerId: "WW_locked", hash: "h1", url: "https://cn.bing.com/search?q=x" });

    assert.equal(ok, false, "边缘拦截时不得谎报成功");
    assert.equal(posts, 1, "策略1 被拦截后不得再试 impression 形状（同一拦截态，重复无益）");
});

test("claimCard still tries impression shape when the failure is not an edge block", async () => {
    const { API, Utils } = createHarness();
    API.appActivity = async () => null;
    API._resolveReportActivityActionId = async () => "f".repeat(42);
    const bodies = [];
    Utils.xhr = async options => {
        if (options.method === "POST") {
            const payload = JSON.parse(options.data)[2];
            bodies.push(payload);
            // 首轮 context 形状失败（500，非边缘拦截）→ 必须继续尝试 impression
            if (bodies.length === 1) throw new Error('HTTP 500: 1:E{"digest":"D"}');
            return "0:{}\n1:true\n";
        }
        return "<html></html>";
    };
    Utils.fetchPage = async () => "";

    const ok = await API.claimCard({ offerId: "O1", hash: "h1" });

    assert.equal(ok, true, "非拦截失败必须继续走完策略链");
    assert.equal(bodies.length, 2, "应尝试两种 payload 形状");
    // context 形状：{offerid, isPromotional, timezoneOffset}；impression 形状：{offerid, form}
    assert.ok("timezoneOffset" in bodies[0] && !("form" in bodies[0]), "首轮必须是 context 形状");
    assert.ok("form" in bodies[1] && !("timezoneOffset" in bodies[1]), "第二轮必须是 impression 形状");
});

test("token exchange uses POST body instead of exposing secrets in the URL", async () => {
    const { API, RewardsAuto, Utils, storage } = createHarness();
    let request;
    Utils.xhr = async options => {
        request = options;
        return JSON.stringify({ access_token: "access-value", refresh_token: "new-refresh-value" });
    };

    const result = await API.getToken({
        client_id: "client",
        refresh_token: "sensitive refresh token",
        grant_type: "REFRESH_TOKEN",
    }, 1);

    assert.equal(result, true);
    assert.equal(request.method, "POST");
    assert.equal(request.url, "https://login.live.com/oauth20_token.srf");
    assert.equal(request.url.includes("sensitive"), false);
    assert.match(request.data, /refresh_token=sensitive\+refresh\+token/);
    assert.equal(RewardsAuto.state.token, "access-value");
    assert.equal(storage.get("Config.token"), "new-refresh-value");
});

test("401 refresh keeps the stored refresh token available", async () => {
    const { API, RewardsAuto, storage } = createHarness({ "Config.token": "refresh-value" });
    RewardsAuto.state.token = "expired-access";
    API.renewToken = async () => {
        assert.equal(storage.get("Config.token"), "refresh-value");
        RewardsAuto.state.token = "fresh-access";
        return true;
    };
    const seen = [];

    const result = await API.withTokenRetry(async token => {
        seen.push(token);
        if (token === "expired-access") throw new Error("HTTP 401");
        return "ok";
    });

    assert.equal(result, "ok");
    assert.deepEqual(seen, ["expired-access", "fresh-access"]);
    assert.equal(storage.get("Config.token"), "refresh-value");
});

test("discover failure does not mark promotions complete", async () => {
    const { API, RewardsAuto, TaskManager } = createHarness({ "Tasks.promos": true });
    RewardsAuto.state.dateNowNum = 20260731;
    TaskManager.promosDate = 0;
    API.discoverCards = async () => null;

    const result = await TaskManager.doPromos();

    assert.equal(result, false);
    assert.equal(TaskManager.promosDate, 0);
    assert.equal(TaskManager.promosTimes, 1);
});

test("partial promotion failure remains retryable", async () => {
    const { API, RewardsAuto, TaskManager, Utils } = createHarness({ "Tasks.promos": true });
    RewardsAuto.state.dateNowNum = 20260731;
    Utils.randomDelay = async () => {};
    API.discoverCards = async () => [
        { offerId: "one", hash: "one", points: 1, kind: "daily", title: "one" },
        { offerId: "two", hash: "two", points: 1, kind: "daily", title: "two" },
    ];
    let call = 0;
    API.claimCard = async () => ++call === 1;

    const result = await TaskManager.doPromos();

    assert.equal(result, false);
    assert.equal(TaskManager.promosDate, 0);
    assert.equal(TaskManager.promosTimes, 1);
});

test("failed search reports do not inflate local progress", async () => {
    const { API, RewardsAuto, TaskManager, Utils } = createHarness({ "Tasks.search": true });
    const info = { pc: { progress: 0, max: 1 } };
    RewardsAuto.state.dateNowNum = 20260731;
    API.getRewardsInfo = async () => info;
    API.checkSearchRestricted = async () => false;
    API.getSearchPage = async () => "<html></html>";
    API.reportSearch = async () => false;
    Utils.delay = async () => {};
    Utils.randomRange = () => 4;

    const result = await TaskManager.doSearch();

    assert.equal(result, false);
    assert.equal(RewardsAuto.state.pcProgress, 0);
});

test("DAPI search quota sums all PC counters", async () => {
    const { API } = createHarness();
    API._getMeInfo = async () => ({
        counters: {
            pcSearch: [
                { pointProgress: 10, pointProgressMax: 30 },
                { pointProgress: 20, pointProgressMax: 30 },
            ],
        },
    });
    API.getReadProgress = async () => false;

    const info = await API.getSearchQuotaFromAPI();

    assert.equal(info.pc.progress, 30);
    assert.equal(info.pc.max, 60);
});

test("pointsCounters parsing avoids redundant quota fallbacks", async () => {
    const { API, Utils } = createHarness();
    Utils.xhr = async () => '<script>"pointsCounters":{"pc":{"max":60,"progress":10},"mobile":{"max":0,"progress":0},"dailyOffer":0}</script>';
    let fallbackCalls = 0;
    API.getSearchQuotaFromUserInfo = async () => { fallbackCalls++; return false; };
    API.getSearchQuotaFromAPI = async () => { fallbackCalls++; return false; };

    const info = await API.getRewardsInfo(1);

    assert.equal(info.pc.progress, 10);
    assert.equal(info.pc.max, 60);
    assert.equal(fallbackCalls, 0);
});

test("pointsCounters without a PC quota still uses the fallback", async () => {
    const { API, Utils } = createHarness();
    Utils.xhr = async () => '<script>"pointsCounters":{"mobile":{"max":30,"progress":5}}</script>';
    let fallbackCalls = 0;
    API.getSearchQuotaFromUserInfo = async () => {
        fallbackCalls++;
        return { pc: { progress: 7, max: 60 } };
    };
    API.getReadProgress = async () => false; // 避免兜底内部再走 fetchPage

    const info = await API.getRewardsInfo(1);

    assert.equal(info.pc.progress, 7);
    assert.equal(info.pc.max, 60);
    assert.equal(fallbackCalls, 1);
});

test("a partial reading batch waits for the next run instead of immediate retry", async () => {
    const { API, RewardsAuto, TaskManager, Utils } = createHarness({ "Tasks.read": true });
    RewardsAuto.state.dateNowNum = 20260731;
    Utils.randomDelay = async () => {};
    let progressChecks = 0;
    API.getReadProgress = async () => {
        progressChecks++;
        return progressChecks === 1
            ? { progress: 0, max: 30 }
            : { progress: 10, max: 30 };
    };
    let reads = 0;
    API.doRead = async () => {
        reads++;
        return { points: 1, isDuplicate: false };
    };

    const result = await TaskManager.doRead();

    assert.equal(result, true);
    assert.equal(reads, 10);
    // v3.6.12：入账延迟下乐观标记今日已完成；下一轮入口会用 fresh 进度强制复核，
    // 未满则重置并继续——既避免汇总 ❌ 误报，也不会漏做阅读
    assert.equal(TaskManager.readDate, 20260731);
});

test("pending daily activities without an actionable URL stay incomplete", async () => {
    const { API, RewardsAuto, TaskManager, Utils, storage } = createHarness();
    RewardsAuto.state.dateNowNum = 20260731;
    Utils.randomDelay = async () => {};
    API.getDailySetItems = async () => [
        { offerId: "daily-one", complete: false, url: "" },
    ];
    TaskManager._extractDailySetHashes = async () => [];
    TaskManager._extractDailySetUrls = async () => [];

    const result = await TaskManager.doDailySet();

    assert.equal(result, false);
    assert.notEqual(storage.get("Config.dailySetDone"), 20260731);
});

test("task initialization resets transient and previous-day restriction state", () => {
    const { RewardsAuto, TaskManager, Utils, storage } = createHarness({
        "Config.tasks": null,
        "Config.searchProgressDate": 1,
        "Config.lastSearchProgress": 12,
        "Config.restrictedTimes": 2,
    });
    TaskManager.signTimes = 3;
    TaskManager.readTimes = 3;
    TaskManager.promosTimes = 3;

    TaskManager.init();

    assert.equal(TaskManager.signTimes, 0);
    assert.equal(TaskManager.readTimes, 0);
    assert.equal(TaskManager.promosTimes, 0);
    assert.equal(RewardsAuto.state.lastSearchProgress, -1);
    assert.equal(RewardsAuto.state.restrictedTimes, 0);
    assert.equal(storage.get("Config.searchProgressDate"), Utils.getTodayNum());
});

test("GET redirects are followed and the final body is returned", async () => {
    const calls = [];
    const gmXhr = opts => {
        calls.push(opts.url);
        if (opts.url === "https://rewards.bing.com/earn") {
            opts.onload({ status: 302, responseHeaders: "Location: https://rewards.bing.com/en-us\r\n", responseText: "" });
        } else {
            opts.onload({ status: 200, responseHeaders: "", responseText: "<html>final</html>" });
        }
    };
    const { Utils } = createHarness({}, { gmXhr });

    const body = await Utils.xhr({ url: "https://rewards.bing.com/earn" });

    assert.equal(body, "<html>final</html>");
    assert.deepEqual(calls, ["https://rewards.bing.com/earn", "https://rewards.bing.com/en-us"]);
});

test("non-GET redirects resolve the Location string as before", async () => {
    const calls = [];
    const gmXhr = opts => {
        calls.push(opts.url);
        opts.onload({ status: 302, responseHeaders: "Location: https://rewards.bing.com/new\r\n", responseText: "" });
    };
    const { Utils } = createHarness({}, { gmXhr });

    const result = await Utils.xhr({ method: "POST", url: "https://rewards.bing.com/api/x", data: "a=1" });

    assert.equal(result, "https://rewards.bing.com/new");
    assert.equal(calls.length, 1);
});

test("renewToken preserves an unused auth code on refresh, clears it when the code path consumes it", async () => {
    // v3.6.9 语义变更：refresh 成功路径根本没用到授权码，不得清掉用户刚粘贴的新凭证
    const h1 = createHarness({
        "Config.token": "refresh-value",
        "Config.tokenTime": 0,
        "Config.code": "stale-one-time-code",
    });
    h1.API.getToken = async () => true;
    assert.equal(await h1.API.renewToken(), true);
    assert.equal(h1.storage.get("Config.code"), "stale-one-time-code");
    assert.equal(h1.storage.get("Config.token"), "refresh-value");

    // 换取路径：授权码被真正消费，成功后清理明文残留
    const h2 = createHarness({
        "Config.code": "https://login.live.com/oauth20_desktop.srf?code=CONSUMED-CODE-VALUE",
    });
    h2.API.getToken = async () => true;
    assert.equal(await h2.API.renewToken(), true);
    assert.equal(h2.storage.get("Config.code"), "");
});

test("doPromos keeps promosDate pending when a claimed card is unconfirmed", async () => {
    const { API, RewardsAuto, TaskManager, Utils } = createHarness({ "Tasks.promos": true });
    RewardsAuto.state.dateNowNum = 20260803;
    Utils.randomDelay = async () => {};
    let scans = 0;
    API.discoverCards = async () => {
        scans++;
        return [{ offerId: "one", hash: "h", points: 1, kind: "daily", title: "one" }];
    };
    API.claimCard = async () => true;

    const result = await TaskManager.doPromos();

    assert.equal(result, false);
    assert.equal(TaskManager.promosDate, 0);
    assert.equal(scans, 2); // 初始扫描 + 领取后复核
});

test("doPromos marks done once claimed cards are confirmed completed", async () => {
    const { API, RewardsAuto, TaskManager, Utils } = createHarness({ "Tasks.promos": true });
    RewardsAuto.state.dateNowNum = 20260803;
    Utils.randomDelay = async () => {};
    let scans = 0;
    API.discoverCards = async () => {
        scans++;
        return scans === 1
            ? [{ offerId: "one", hash: "h", points: 1, kind: "daily", title: "one" }]
            : []; // 复核时服务端已确认完成
    };
    API.claimCard = async () => true;

    const result = await TaskManager.doPromos();

    assert.equal(result, true);
    assert.equal(TaskManager.promosDate, 20260803);
    assert.equal(scans, 2);
});

test("doPromos gives up a card after N consecutive unconfirmed claims", async () => {
    const { API, RewardsAuto, TaskManager, Utils } = createHarness({ "Tasks.promos": true });
    RewardsAuto.state.dateNowNum = 20260803;
    Utils.randomDelay = async () => {};
    API.claimCard = async () => true;
    API.discoverCards = async () => [{ offerId: "stuck", hash: "h", points: 1, kind: "daily", title: "stuck" }];

    // 前 4 次：未达上限（5），保持 pending。
    // 真实运行中每个 tick 是新实例，init() 会重置 promosTimes，
    // 因此"连续 N 次未确认"是跨运行的累计——这里在每次调用前模拟一轮新运行。
    for (let i = 0; i < 4; i++) {
        TaskManager.promosTimes = 0;
        assert.equal(await TaskManager.doPromos(), false);
        assert.equal(TaskManager.promosDate, 0);
    }

    // 第 5 次：连续 5 次未确认 → 当日放弃，标记完成
    TaskManager.promosTimes = 0;
    assert.equal(await TaskManager.doPromos(), true);
    assert.equal(TaskManager.promosDate, 20260803);
});

test("checkSearchRestricted reuses provided quota info without refetching", async () => {
    const { API, RewardsAuto } = createHarness();
    let fetchCount = 0;
    API.getRewardsInfo = async () => { fetchCount++; return { pc: { progress: 0, max: 60 } }; };
    RewardsAuto.state.pcMax = 60;
    RewardsAuto.state.lastSearchProgress = -1;

    const restricted = await API.checkSearchRestricted({ pc: { progress: 5, max: 60 } });

    assert.equal(restricted, false);
    assert.equal(fetchCount, 0);
});

test("idle detection requires every task done today", async () => {
    const { RewardsAuto, TaskManager } = createHarness({
        "Config.dailySetDone": 20260803,
        "Config.punchCardBgDone": 20260803,
    });
    RewardsAuto.state.dateNowNum = 20260803;
    TaskManager.signDate = 20260803;
    TaskManager.readDate = 20260803;
    TaskManager.promosDate = 20260803;
    TaskManager.searchDate = 20260803;
    assert.equal(TaskManager._isIdle(), true);

    TaskManager.searchDate = 0;
    assert.equal(TaskManager._isIdle(), false);
});

test("run lock blocks a second concurrent acquisition", () => {
    const { TaskManager } = createHarness();
    const token1 = TaskManager._acquireRunLock();
    assert.ok(token1);
    const token2 = TaskManager._acquireRunLock();
    assert.equal(token2, null);
    TaskManager._releaseRunLock(token1);
    const token3 = TaskManager._acquireRunLock();
    assert.ok(token3);
    TaskManager._releaseRunLock(token3);
});

test("run lock expires so a crashed instance does not deadlock", () => {
    const { TaskManager, storage } = createHarness();
    storage.set("Config.runLock", { token: "stale", expire: Date.now() - 1000 });
    const token = TaskManager._acquireRunLock();
    assert.ok(token);
    TaskManager._releaseRunLock(token);
});

test("doDailySet uses the run-start date for its daily gate", async () => {
    const { RewardsAuto, TaskManager } = createHarness({
        "Config.dailySetDone": 20260801,
    });
    RewardsAuto.state.dateNowNum = 20260801; // 运行起始日（可能不等于真实当天）
    const result = await TaskManager.doDailySet();
    assert.equal(result, true); // 与存储标记一致 → 直接跳过；若用即时日期则不会命中
});

test("push dedup keeps distinct amounts distinct", () => {
    const { Utils } = createHarness();
    assert.equal(Utils._dedupePush("签入完成 +5积分"), true);
    assert.equal(Utils._dedupePush("签入完成 +15积分"), true); // 数字不同 → 不误吞
    assert.equal(Utils._dedupePush("签入完成 +15积分"), false); // 完全相同 → 去重
});

test("api mode getter reads the live config", () => {
    const { RewardsAuto, storage } = createHarness();
    storage.set("Config.api", "offline");
    assert.equal(RewardsAuto.apiConfig.mode, "offline");
    storage.set("Config.api", "hot.nntool.cc");
    assert.equal(RewardsAuto.apiConfig.mode, "hot.nntool.cc");
});

test("dateKeysFromRunDay derives server date keys from the run-start day", () => {
    const { Utils } = createHarness();
    // 跨 realm 数组原型不同，用 JSON 字符串比较
    assert.equal(JSON.stringify(Utils.dateKeysFromRunDay(20260803)), JSON.stringify(["08/03/2026", "8/3/2026"]));
    // runDay 为 0（未初始化）时回退到当前日期，保证不产生非法键
    const fallback = Utils.dateKeysFromRunDay(0);
    assert.match(fallback[0], /^\d{2}\/\d{2}\/\d{4}$/);
});

test("runAll returns early when idle without doing heavy work", async () => {
    const d = new Date();
    const today = Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`);
    const { API, TaskManager } = createHarness({
        "Config.tasks": { sign: today, read: today, promos: today, search: today, streakDays: 0 },
        "Config.dailySetDone": today,
        "Config.punchCardBgDone": today,
        "Config.token": "refresh",
    });
    let renews = 0;
    API.renewToken = async () => { renews++; return true; };
    API.getBalance = async () => { throw new Error("idle run must not call getBalance"); };

    await TaskManager.runAll();

    assert.equal(renews, 0); // 空闲轮不续期 Token，零请求
});

// ====== 请求缓存层（v3.5.0）======

test("earn page is fetched once per run despite repeated getRewardsInfo calls", async () => {
    const { API, RewardsAuto, Utils } = createHarness();
    RewardsAuto.state.dateNowNum = 20260810;
    let fetches = 0;
    Utils.xhr = async () => {
        fetches++;
        return '<script>"pointsCounters":{"pc":{"max":60,"progress":10},"mobile":{"max":0,"progress":0},"dailyOffer":0}</script>';
    };
    API.getSearchQuotaFromUserInfo = async () => false;
    API.getSearchQuotaFromAPI = async () => false;
    API.getReadProgress = async () => false;

    await API.getRewardsInfo(1);
    await API.getRewardsInfo(1);
    await API.getRewardsInfo(1);

    assert.equal(fetches, 1);
});

test("fresh:true bypasses the per-run cache", async () => {
    const { API, RewardsAuto, Utils } = createHarness();
    RewardsAuto.state.dateNowNum = 20260810;
    let fetches = 0;
    Utils.xhr = async () => {
        fetches++;
        return '<script>"pointsCounters":{"pc":{"max":60,"progress":10},"mobile":{"max":0,"progress":0},"dailyOffer":0}</script>';
    };
    API.getSearchQuotaFromUserInfo = async () => false;
    API.getSearchQuotaFromAPI = async () => false;
    API.getReadProgress = async () => false;

    await API.getRewardsInfo(1);
    await API.getRewardsInfo(1);           // 命中缓存
    await API.getRewardsInfo(3, { fresh: true }); // 强制刷新（汇总复查路径）

    assert.equal(fetches, 2);
});

test("getuserinfo is fetched once per run across all consumers", async () => {
    const { API, RewardsAuto, Utils } = createHarness();
    RewardsAuto.state.dateNowNum = 20260810;
    const fetched = [];
    Utils.xhr = async options => {
        fetched.push(options.url);
        return JSON.stringify({ dashboard: { dailySetPromotions: {}, userStatus: { counters: {} } } });
    };

    await API._getUserInfo();
    await API.getDailySetItems();
    await API.getSearchQuotaFromUserInfo();

    // getuserinfo 家族（含 flyout 兜底）只允许请求一次；flight 兜底会另抓
    // earn/dashboard 页面（与其他任务共享轮内缓存），不计入本断言
    const infoFetches = fetched.filter(u => u.includes("/api/getuserinfo") || u.includes("panelflyout"));
    assert.equal(infoFetches.length, 1);
});

test("getReadProgress and getSearchQuotaFromAPI share one DAPI /me request", async () => {
    const { API, RewardsAuto, Utils } = createHarness();
    RewardsAuto.state.dateNowNum = 20260810;
    let fetches = 0;
    Utils.xhr = async options => {
        fetches++;
        assert.ok(options.url.includes("prod.rewardsplatform.microsoft.com/dapi/me"));
        assert.equal(options.headers["x-rewards-country"], "cn");
        return JSON.stringify({
            response: {
                balance: 1234,
                promotions: [{ attributes: { offerid: RewardsAuto.appConfig.offerIds.readArticle, progress: 3, max: 30 } }],
                counters: { pcSearch: [{ pointProgress: 5, pointProgressMax: 60 }] },
            },
        });
    };

    const read = await API.getReadProgress();
    const quota = await API.getSearchQuotaFromAPI();
    const balance = await API.getBalance();

    assert.equal(fetches, 1);
    // 跨 realm 原型不同，用 JSON 字符串比较（与 dateKeysFromRunDay 测试一致）
    assert.equal(JSON.stringify(read), JSON.stringify({ progress: 3, max: 30 }));
    assert.equal(quota.pc.progress, 5);
    assert.equal(balance, 1234);
});

test("cache key includes the run day so a new day invalidates the cache", async () => {
    const { API, RewardsAuto, Utils } = createHarness();
    let fetches = 0;
    Utils.xhr = async () => { fetches++; return JSON.stringify({ dashboard: {} }); };

    RewardsAuto.state.dateNowNum = 20260810;
    await API._getUserInfo();
    await API._getUserInfo();
    RewardsAuto.state.dateNowNum = 20260811; // 模拟新一天
    await API._getUserInfo();

    assert.equal(fetches, 2);
});

test("failed page fetches are not cached", async () => {
    const { Utils, RewardsAuto } = createHarness();
    RewardsAuto.state.dateNowNum = 20260810;
    let calls = 0;
    Utils.xhr = async () => {
        calls++;
        if (calls === 1) throw new Error("network error");
        return "<html>recovered</html>";
    };

    await assert.rejects(() => Utils.fetchPage({ url: "https://example.com/a" }));
    const body = await Utils.fetchPage({ url: "https://example.com/a" });

    assert.equal(body, "<html>recovered</html>");
    assert.equal(calls, 2);
});

test("dashboard and its RSC variant are cached separately", async () => {
    const { Utils, RewardsAuto } = createHarness();
    RewardsAuto.state.dateNowNum = 20260810;
    const variants = [];
    Utils.xhr = async options => {
        variants.push(options.headers?.rsc ? "rsc" : "html");
        return "<html></html>";
    };

    // _extractDailySetUrls 走普通抓取，_extractDailySetHashes 走 _cacheKey:"rsc"，两者互不覆盖
    await Utils.fetchPage({ url: "https://rewards.bing.com/dashboard" });
    await Utils.fetchPage({ url: "https://rewards.bing.com/dashboard" });
    await Utils.fetchPage({ url: "https://rewards.bing.com/dashboard", _cacheKey: "rsc", headers: { rsc: "1" } });
    await Utils.fetchPage({ url: "https://rewards.bing.com/dashboard", _cacheKey: "rsc", headers: { rsc: "1" } });

    assert.deepEqual(variants, ["html", "rsc"]);
});

test("doPromos recheck fetches fresh data after claiming", async () => {
    const { API, RewardsAuto, TaskManager, Utils } = createHarness({ "Tasks.promos": true });
    RewardsAuto.state.dateNowNum = 20260810;
    Utils.randomDelay = async () => {};
    API.claimCard = async () => true;
    // 首次扫描有卡片、复核时已确认完成（服务端状态变化，必须 fresh 才看得到）
    let scan = 0;
    API.discoverCards = async (fetchOpts) => {
        scan++;
        if (scan === 1) return [{ offerId: "one", hash: "h", points: 1, kind: "daily", title: "one" }];
        // 复核调用必须绕过轮内缓存，否则读到的永远是上报前的旧页面
        assert.equal(fetchOpts?.fresh, true, "recheck scan must bypass the run cache");
        return [];
    };

    const result = await TaskManager.doPromos();

    assert.equal(result, true);
    assert.equal(TaskManager.promosDate, 20260810);
    assert.equal(scan, 2);
});

test("extractNextAction parses the Server Action hash from raw/escaped payloads", () => {
    const { Utils, RewardsAuto } = createHarness();
    const hash = "70babbc81d2724f60d29a95c03b3d739cba77cea92";
    assert.equal(Utils.extractNextAction(`"name":"next-action","value":"${hash}"`), hash);
    assert.equal(RewardsAuto._nextAction, hash);
    // 转义版本（RSC payload）走 fallback 分支
    assert.equal(Utils.extractNextAction("", `<script>"next-action":"${hash}"</script>`), hash);
    assert.equal(Utils.extractNextAction("<html>no match</html>"), null);
});


// ====== 2026-09 站点改版适配（v3.6.0）======

// 构造一段内嵌 flight 分片的 HTML：payload 为 JSON 字符串（再转义一层进 JS 字面量）
function flightHtml(...payloads) {
    const pushes = payloads
        .map(p => `self.__next_f.push([1,${JSON.stringify(p)}])`)
        .join(";</script><script>");
    return `<html><body><script>${pushes}</script></body></html>`;
}

test("concatFlightChunks decodes and joins __next_f payload strings", () => {
    const { Utils } = createHarness();
    const html = flightHtml('abc', '{"a":1}', 'def');
    assert.equal(Utils.concatFlightChunks(html), 'abc{"a":1}def');
    assert.equal(Utils.concatFlightChunks("<p>no flight data</p>"), "");
    assert.equal(Utils.concatFlightChunks(""), "");
    // 单片损坏不影响其余分片
    const broken = flightHtml('{"x":').replace('self.__next_f.push', 'self.__next_f.pushX')
        + '<script>self.__next_f.push([1,"ok"])</script>';
    assert.equal(Utils.concatFlightChunks(broken), "ok");
});

test("extractFlightObjects finds offer objects across escape and nesting", () => {
    const { Utils } = createHarness();
    const offerA = JSON.stringify({ offerId: "A", hash: "a".repeat(40), note: '"quoted \ back"' });
    const offerB = JSON.stringify({ offerId: "B", hash: "b".repeat(40), isPromotional: "$undefined", nested: { deep: { offerId: "A" } } });
    const combined = `2:I[123,[],["children","$L5"]]\n5:{"children":[${offerA},"\n",${offerB}]}\n`;

    const objs = Utils.extractFlightObjects(combined, '"offerId"');
    assert.equal(objs.length, 2);
    assert.equal(objs[0].offerId, "A");
    assert.equal(objs[0].hash, "a".repeat(40));
    assert.equal(objs[0].note, '"quoted \ back"');
    assert.equal(objs[1].offerId, "B");
    // "$undefined" 序列化为 null
    assert.equal(objs[1].isPromotional, null);
    assert.equal(JSON.stringify(Utils.extractFlightObjects("", '"offerId"')), "[]");
});

test("extractNamedActionIds resolves reportActivity from the new build format", () => {
    const { Utils } = createHarness();
    const js = `e.s(["reportActivity",0,(0,t.createServerReference)("707e6eb15bdfdd5fba193f0a77e934f7018faf87ce",t.callServer,void 0,t.findSourceMapURL,"reportActivity")]);`
        + `(0,f.createServerReference)("4083298219f6007c7b566711872d816ee01f1002ab",f.callServer,void 0,f.findSourceMapURL,"submitEmailConsent");`;
    const byName = Utils.extractNamedActionIds(js);
    assert.equal(byName.reportActivity, "707e6eb15bdfdd5fba193f0a77e934f7018faf87ce");
    assert.equal(byName.submitEmailConsent, "4083298219f6007c7b566711872d816ee01f1002ab");
    // 框架参数（callServer 等）不得被误认为 action 名
    const js2 = `var x=(0,t.createServerReference)("${"c".repeat(40)}",t.callServer,void 0,t.findSourceMapURL);`;
    assert.equal(JSON.stringify(Utils.extractNamedActionIds(js2)), "{}");
    assert.equal(JSON.stringify(Utils.extractNamedActionIds("")), "{}");
});

test("flightDateToNum normalizes MM/DD/YYYY and rejects junk", () => {
    const { Utils } = createHarness();
    assert.equal(Utils.flightDateToNum("09/13/2026"), 20260913);
    assert.equal(Utils.flightDateToNum("1/2/2026"), 0);      // 仅接受补零格式
    assert.equal(Utils.flightDateToNum("2026-09-13"), 0);
    assert.equal(Utils.flightDateToNum(undefined), 0);
});

test("_extractDailySetHashes matches pending offers from flight data and skips done/locked/future", async () => {
    const { TaskManager, RewardsAuto, Utils } = createHarness();
    RewardsAuto.state.dateNowNum = 20260913;
    const okOffer = { offerId: "Gamification_DailySet_CN_20260913_zh-cn_Child_0", hash: "a".repeat(40), activityType: 11 };
    const html = flightHtml(
        JSON.stringify({ offerId: okOffer.offerId, ...okOffer }),
        JSON.stringify({ offerId: "Gamification_DailySet_CN_20260913_zh-cn_Child_1", hash: "b".repeat(40), isCompleted: true }),
        JSON.stringify({ offerId: "Gamification_DailySet_CN_20260913_zh-cn_Child_2", hash: "c".repeat(40), isLocked: true }),
        JSON.stringify({ offerId: "Gamification_DailySet_CN_20260913_zh-cn_Child_3", hash: "d".repeat(40), date: "09/14/2026" }),
        JSON.stringify({ offerId: "Gamification_DailySet_CN_20260912_zh-cn_Child_9", hash: "e".repeat(40) }) // 不在待办清单
    );
    Utils.xhr = async () => html;

    const pending = [
        { offerId: okOffer.offerId },
        { offerId: "Gamification_DailySet_CN_20260913_zh-cn_Child_1" },
        { offerId: "Gamification_DailySet_CN_20260913_zh-cn_Child_2" },
        { offerId: "Gamification_DailySet_CN_20260913_zh-cn_Child_3" },
    ];
    const hashes = await TaskManager._extractDailySetHashes(pending);
    assert.equal(hashes.length, 1);
    assert.equal(hashes[0].offerId, okOffer.offerId);
    assert.equal(hashes[0].hash, "a".repeat(40));
    assert.equal(hashes[0].form, "");
    assert.equal(JSON.stringify(hashes[0].variants),
        JSON.stringify([{ hash: "a".repeat(40), form: "", type: 0, isPromotional: false }]));
});

test("_extractDailySetHashes collects every flight variant per offerId and prefers the form-bearing one", async () => {
    const { TaskManager, RewardsAuto, Utils } = createHarness();
    RewardsAuto.state.dateNowNum = 20260913;
    const offerId = "Gamification_DailySet_CN_20260913_zh-cn_Child_0";
    // 同一 offerId 三个对象：瘦对象（无 type/form）、卡片富对象（type/isPromotional）、
    // 印象对象（form）。旧逻辑首个命中即停会丢失后两者。
    const html = flightHtml(
        JSON.stringify({ offerId, hash: "a".repeat(40), isCompleted: false, date: "09/13/2026" }),
        JSON.stringify({ offerId, hash: "b".repeat(40), type: 22, isPromotional: true }),
        JSON.stringify({ offerId, hash: "c".repeat(40), form: "MA123" }),
        JSON.stringify({ offerId, hash: "c".repeat(40), form: "MA123" }) // 重复对象必须去重
    );
    Utils.xhr = async () => html;

    const hashes = await TaskManager._extractDailySetHashes([{ offerId }]);
    assert.equal(hashes.length, 1);
    assert.equal(hashes[0].hash, "c".repeat(40)); // 首选带 form 的变体
    assert.equal(hashes[0].form, "MA123");
    assert.equal(hashes[0].variants.length, 3);
    assert.equal(JSON.stringify(hashes[0].variants[1]),
        JSON.stringify({ hash: "b".repeat(40), form: "", type: 22, isPromotional: true }));
});

test("_extractDailySetHashes keeps pointProgress-based completion consistent with getuserinfo", async () => {
    const { TaskManager, RewardsAuto, Utils } = createHarness();
    RewardsAuto.state.dateNowNum = 20260913;
    const offerId = "Gamification_DailySet_CN_20260913_zh-cn_Child_0";
    const html = flightHtml(JSON.stringify({
        offerId, hash: "a".repeat(40), pointProgress: 30, pointProgressMax: 30
    }));
    Utils.xhr = async () => html;
    const hashes = await TaskManager._extractDailySetHashes([{ offerId }]);
    assert.equal(hashes.length, 0); // pointProgress 已满 → 视为完成，不再上报
});

test("_sendDailySetAction sends dynamic id, router state tree and offer fields", async () => {
    const { TaskManager, RewardsAuto, Utils } = createHarness();
    let req;
    // v3.7.0 判据：2xx 且含 1:true 才算 action 执行
    Utils.xhr = async options => { req = options; return "0:{\"a\":\"$@1\"}\n1:true\n"; };

    const ok = await TaskManager._sendDailySetAction("offer-1", "a".repeat(40), "f".repeat(42), { form: "MA123" });
    assert.equal(ok, true);
    assert.equal(req.method, "POST");
    assert.equal(req.url, "https://rewards.bing.com/dashboard");
    assert.equal(req.headers["next-action"], "f".repeat(42));
    assert.ok(req.headers["next-router-state-tree"].includes("dashboard"));
    // payload 形状复刻真实浏览器：[hash, 11, {offerid, form}]
    assert.deepEqual(JSON.parse(req.data), ["a".repeat(40), 11, { offerid: "offer-1", form: "MA123" }]);

    // 无动态 ID 时回退构建期常量；form 缺失时序列化为 "$undefined"
    await TaskManager._sendDailySetAction("offer-2", "b".repeat(40), null, {});
    assert.equal(req.headers["next-action"], RewardsAuto.fallbackActionId);
    assert.equal(JSON.parse(req.data)[2].form, "$undefined");
    assert.equal(JSON.parse(req.data)[1], 11);
});

test("_sendDailySetAction supports the browser context shape and records 500 bodies", async () => {
    const { TaskManager, Utils } = createHarness();
    let req;
    Utils.xhr = async options => {
        req = options;
        return { status: 500, body: '0:{"a":"$@1"} 1:E{"digest":"3200825472@E80"}' };
    };

    // context 形状：卡片组件点击入账调用点（type 缺省回退 11）
    const ok = await TaskManager._sendDailySetAction("offer-1", "a".repeat(40), "f".repeat(42),
        { shape: "context", type: 22, isPromotional: true });
    assert.equal(ok, false); // 500 响应体必须被记录，不再抛异常
    assert.deepEqual(JSON.parse(req.data),
        ["a".repeat(40), 22, { offerid: "offer-1", isPromotional: "true", timezoneOffset: Utils.jsTimezoneOffset() }]);
    assert.equal(req.acceptErrorBody, true);

    await TaskManager._sendDailySetAction("offer-2", "b".repeat(40), null, { shape: "context" });
    assert.deepEqual(JSON.parse(req.data),
        ["b".repeat(40), 11, { offerid: "offer-2", isPromotional: "$undefined", timezoneOffset: Utils.jsTimezoneOffset() }]);
});

test("_resolveReportActivityActionId scans chunk URLs (keeping dpl) and caches the result", async () => {
    const { API, TaskManager, RewardsAuto, Utils } = createHarness();
    const actionId = "707e6eb15bdfdd5fba193f0a77e934f7018faf87ce";
    const pageHtml = flightHtml("bootstrap")
        + `<script src="/_next/static/chunks/app-page.js?dpl=20260912-2"></script>`
        + `<script src="/_next/static/chunks/framework.js"></script>`;
    const chunkJs = `e.s(["reportActivity",0,(0,t.createServerReference)("${actionId}",t.callServer,void 0,t.findSourceMapURL,"reportActivity")]);`;
    const fetched = [];
    Utils.xhr = async options => {
        fetched.push(options.url);
        if (options.url.endsWith(".js?dpl=20260912-2") || options.url.endsWith("/framework.js")) {
            return options.url.includes("app-page") ? chunkJs : "no actions here";
        }
        return pageHtml;
    };

    const id = await API._resolveReportActivityActionId();
    assert.equal(id, actionId);
    assert.equal(RewardsAuto.state.reportActionId, actionId);
    assert.equal(RewardsAuto._nextAction, actionId);
    // dpl 部署参数必须保留，避免 CDN 返回旧部署的 chunk
    assert.ok(fetched.some(u => u.includes("/_next/static/chunks/app-page.js?dpl=20260912-2")));

    // 第二次调用走轮内缓存，不再请求
    const count = fetched.length;
    assert.equal(await API._resolveReportActivityActionId(), actionId);
    assert.equal(fetched.length, count);
});

test("reportActionId persistent cache reuses the same dpl and rescans a new deployment", async () => {
    const { API, TaskManager, RewardsAuto, Utils, storage } = createHarness({
        "Config.reportAction": { dpl: "20260912-2", id: "a".repeat(42) },
    });
    const actionId = "b".repeat(42);
    const pageHtml = `<script src="/_next/static/chunks/app-page.js?dpl=20260912-2"></script>`;
    let chunkFetches = 0;
    Utils.xhr = async options => {
        if (options.url.includes("/_next/static/chunks/")) {
            chunkFetches++;
            return `createServerReference("${actionId}",t.callServer,void 0,t.findSourceMapURL,"reportActivity")`;
        }
        return pageHtml;
    };

    // dpl 一致 → 直接复用持久缓存，零 chunk 请求
    let id = await API._resolveReportActivityActionId();
    assert.equal(id, "a".repeat(42));
    assert.equal(chunkFetches, 0);

    // 部署更新（dpl 变化）→ 重新扫描并更新缓存（先清内存态，模拟下一轮新进程）
    RewardsAuto.state.reportActionId = null;
    storage.set("Config.reportAction", { dpl: "20260901-1", id: "a".repeat(42) });
    id = await API._resolveReportActivityActionId();
    assert.equal(id, actionId);
    assert.ok(chunkFetches > 0);
    assert.equal(JSON.stringify(storage.get("Config.reportAction")), JSON.stringify({ dpl: "20260912-2", id: actionId }));
});

test("doDailySet completes via flight hashes and dynamic action id", async () => {
    const { API, RewardsAuto, TaskManager, Utils, storage } = createHarness();
    RewardsAuto.state.dateNowNum = 20260913;
    const offerId = "Gamification_DailySet_CN_20260913_zh-cn_Child_0";
    const actionId = "707e6eb15bdfdd5fba193f0a77e934f7018faf87ce";
    let infoCalls = 0;
    API.getDailySetItems = async (fetchOpts) => {
        infoCalls++;
        if (infoCalls > 1) assert.equal(fetchOpts?.fresh, true, "复查必须绕过缓存");
        return [{ offerId, complete: infoCalls > 1, pointProgress: 0, pointProgressMax: 30 }];
    };
    TaskManager._extractDailySetHashes = async (pending) => {
        assert.deepEqual(pending.map(p => p.offerId), [offerId]);
        return [{ offerId, hash: "a".repeat(40), form: "MA1" }];
    };
    API._resolveReportActivityActionId = async () => actionId;
    const posts = [];
    Utils.xhr = async options => { posts.push(options); return "0:{\"a\":\"$@1\"}\n1:true\n"; };

    const result = await TaskManager.doDailySet();

    assert.equal(result, true);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].headers["next-action"], actionId);
    assert.equal(JSON.parse(posts[0].data)[2].offerid, offerId);
    assert.equal(storage.get("Config.dailySetDone"), 20260913);
});

test("doDailySet visits the activity link when every Server Action shape fails", async () => {
    const { API, RewardsAuto, TaskManager, Utils, storage } = createHarness();
    RewardsAuto.state.dateNowNum = 20260913;
    const offerId = "Gamification_DailySet_CN_20260913_zh-cn_Child_0";
    let infoCalls = 0;
    API.getDailySetItems = async (fetchOpts) => {
        infoCalls++;
        if (infoCalls > 1) assert.equal(fetchOpts?.fresh, true, "复查必须绕过缓存");
        return [{
            offerId, complete: infoCalls > 1, pointProgress: 0, pointProgressMax: 30,
            url: "https://cn.bing.com/search?q=x&rnoreward=1"
        }];
    };
    TaskManager._extractDailySetHashes = async (pending) => {
        assert.deepEqual(pending.map(p => p.offerId), [offerId]);
        return [{ offerId, hash: "a".repeat(40), form: "", variants: [{ hash: "a".repeat(40), form: "", type: 0, isPromotional: false }] }];
    };
    API._resolveReportActivityActionId = async () => "f".repeat(42);
    const calls = [];
    Utils.xhr = async options => {
        calls.push(options);
        if (options.method === "POST") return { status: 500, body: '1:E{"digest":"D"}' };
        return "ok";
    };
    Utils.randomDelay = async () => {};

    const result = await TaskManager.doDailySet();

    assert.equal(result, true);
    const posts = calls.filter(c => c.method === "POST");
    const gets = calls.filter(c => !c.method || c.method === "GET");
    assert.equal(posts.length, 1, "无 form 变体时只尝试 context 形状一次");
    assert.equal(JSON.parse(posts[0].data)[1], 11);
    assert.equal(gets.length, 1, "Server Action 失败后必须后台访问活动链接");
    assert.equal(gets[0].url, "https://cn.bing.com/search?q=x&rnoreward=1");
    assert.equal(gets[0].headers.referer, "https://rewards.bing.com/dashboard");
    assert.equal(storage.get("Config.dailySetDone"), 20260913);
});

// ====== v3.6.1：getuserinfo 失效兜底（flyout + flight）======

test("_getUserInfo falls back to the Bing flyout API and normalizes to legacy shape", async () => {
    const { API, Utils } = createHarness();
    const flyoutPayload = JSON.stringify({
        isError: false,
        userInfo: { isRewardsUser: true, balance: 92, profile: { userName: "u" } },
        flyoutResult: {
            isRewardsUser: true,
            dailySetPromotions: { "09/13/2026": [{ offerId: "DS1", pointProgress: 0, pointProgressMax: 30 }] },
            morePromotions: [{ offerId: "MP1", hash: "h", points: 10 }],
            userStatus: {
                isRewardsUser: true,
                availablePoints: 92,
                counters: { PCSearch: [{ pointProgress: 60, pointProgressMax: 60 }] }
            }
        }
    });
    const urls = [];
    Utils.xhr = async options => {
        urls.push(options.url);
        if (options.url.includes("/api/getuserinfo")) throw new Error("HTTP 401");
        return flyoutPayload;
    };

    const data = await API._getUserInfo();
    assert.ok(data, "flyout fallback should return normalized data");
    assert.ok(urls.some(u => u.includes("/rewards/panelflyout/getuserinfo")), "flyout endpoint must be requested");
    const dashboard = data.dashboard;
    assert.equal(dashboard.dailySetPromotions["09/13/2026"][0].offerId, "DS1");
    assert.equal(dashboard.morePromotions[0].offerId, "MP1");
    assert.equal(dashboard.userStatus.availablePoints, 92);
    // 大小写计数器统一为 getuserinfo 旧键名，供搜索配额解析
    assert.equal(dashboard.userStatus.counters.pcSearch[0].pointProgressMax, 60);

    // getuserinfo 正常时不得请求 flyout
    Utils.xhr = async () => JSON.stringify({ dashboard: { dailySetPromotions: {}, userStatus: { counters: {} } } });
    const direct = await API._getUserInfo({ fresh: true });
    assert.ok(direct.dashboard);
});

test("getDailySetItems falls back to flight offers when both APIs fail", async () => {
    const { API, RewardsAuto, Utils } = createHarness();
    RewardsAuto.state.dateNowNum = 20260913;
    Utils.xhr = async options => {
        if (options.url.includes("/api/getuserinfo") || options.url.includes("panelflyout")) {
            throw new Error("HTTP 401");
        }
        const offer = JSON.stringify({
            offerId: "Gamification_DailySet_CN_20260913_zh-cn_Child_0",
            hash: "a".repeat(40), isCompleted: false, date: "09/13/2026",
            pointProgress: 0, pointProgressMax: 30, destination: "https://cn.bing.com/x?rnoreward=1"
        });
        const done = JSON.stringify({
            offerId: "Gamification_DailySet_CN_20260913_zh-cn_Child_1",
            hash: "b".repeat(40), isCompleted: true, date: "09/13/2026"
        });
        return flightHtml(offer, done);
    };

    const items = await API.getDailySetItems();
    assert.equal(items.length, 2);
    assert.equal(items[0].offerId, "Gamification_DailySet_CN_20260913_zh-cn_Child_0");
    assert.equal(items[0].complete, false);
    assert.equal(items[1].complete, true);

    // flight 流完全缺失（页面结构未知）→ 返回 null 交由重试机制
    Utils.xhr = async options => {
        if (options.url.includes("/api/getuserinfo") || options.url.includes("panelflyout")) throw new Error("HTTP 401");
        return "<html>no flight data</html>";
    };
    assert.equal(await API.getDailySetItems({ fresh: true }), null);
});

test("claimCard Server Action targets a rewards page with the resolved action id", async () => {
    const { API, RewardsAuto, Utils } = createHarness();
    const actionId = "c".repeat(42);
    API._resolveReportActivityActionId = async () => actionId;
    API.getRewardsToken = async () => false;
    API.reportActivity = async () => { throw new Error("legacy endpoint retired"); };
    const posts = [];
    Utils.xhr = async options => {
        if (options.method === "POST") posts.push(options);
        return "0:{\"a\":\"$@1\"}\n1:true\n";
    };

    // card.url 是 bing.com 目标页 → Server Action 必须改发 earn 页
    const ok = await API.claimCard({ offerId: "o1", hash: "h1", url: "https://cn.bing.com/search?q=x&rnoreward=1" });
    assert.equal(ok, true);
    assert.equal(posts[0].url, "https://rewards.bing.com/earn");
    assert.equal(posts[0].headers["next-action"], actionId);
    assert.ok(posts[0].headers["next-router-state-tree"].includes("earn"));
    assert.equal(posts[0].headers["accept"], "text/x-component");
});

test("claimCard opens a real background tab as the last resort and never fakes success", async () => {
    const { API, Utils, openTabs } = createHarness();
    API._resolveReportActivityActionId = async () => "c".repeat(42);
    API.getRewardsToken = async () => false;
    API.reportActivity = async () => false;
    const gets = [];
    Utils.xhr = async options => {
        if (options.method === "POST") throw new Error("HTTP 500");
        gets.push(options);
        // earn 刷新返回空 flight（live hash 重试无候选 → 直接落到 impression/tab）
        return "<html></html>";
    };

    // v3.7.0：XHR GET 活动链接已证无入账效果，改为开真实后台标签页且不算成功
    const ok = await API.claimCard({ offerId: "o1", hash: "h1", url: "https://cn.bing.com/search?q=x&rnoreward=1" });
    assert.equal(ok, false);
    assert.equal(gets.length, 1); // 唯一 GET 是策略2 的 earn 刷新；策略1/3 POST 均抛错
    assert.equal(gets[0].url, "https://rewards.bing.com/earn");
    assert.equal(openTabs.length, 1, "bing.com 目标页应开真实标签页兜底");
    assert.equal(openTabs[0].url, "https://cn.bing.com/search?q=x&rnoreward=1");
    assert.equal(openTabs[0].opts.active, false);

    // 非 bing.com 目标页不开标签页，所有策略失败返回 false
    assert.equal(await API.claimCard({ offerId: "o2", hash: "h2", url: "https://example.com/x" }), false);
    assert.equal(openTabs.length, 1, "非 bing.com 链接不得开标签页");
});

// ====== v4.1.0：App 上报 p:0 静默吸收标定（2026-09-16 真实账号实测）======

test("claimCard treats App p:0 non-duplicate response as not-credited and falls through", async () => {
    // 实测：WW_Rewards_locked_level2_Sep26w3_offer2 不在 App 目录内（cn/my/us/sg 四区域
    // promotions 均无），DAPI 上报一律 200 + p:0 + isDuplicate:false——服务端静默吸收。
    // claimCard 不得把它当成功，必须落到网页策略。
    const { API, Utils } = createHarness();
    API.appActivity = async () => ({ points: 0, isDuplicate: false, balance: 4260 });
    API._resolveReportActivityActionId = async () => "c".repeat(42);
    const posts = [];
    Utils.xhr = async options => {
        if (options.method === "POST") posts.push(options);
        return "0:{\"a\":\"$@1\"}\n1:true\n";
    };

    const ok = await API.claimCard({ offerId: "WW_locked", hash: "h1" });

    assert.equal(ok, true, "网页 Server Action 兜底承接");
    assert.equal(posts.length, 1, "p:0 非 duplicate 必须继续走 earn 策略而不是短路");
});

test("claimCard accepts App report when points are credited or duplicate-confirmed", async () => {
    const { API, Utils } = createHarness();
    // 实测：Gamification_DailySet_Child3 App 上报 +10p（balance 4118→4128）
    let mode = "credited";
    API.appActivity = async () => mode === "credited"
        ? { points: 10, isDuplicate: false, balance: 4128 }
        : { points: 0, isDuplicate: true, balance: 4128 };
    let posts = 0;
    Utils.xhr = async () => { posts++; return "1:true\n"; };

    assert.equal(await API.claimCard({ offerId: "Child3", hash: "h1" }), true);
    assert.equal(posts, 0, "入账成功后不得再发任何网页请求");

    mode = "duplicate";
    assert.equal(await API.claimCard({ offerId: "Child3", hash: "h1" }), true);
    assert.equal(posts, 0, "幂等确认同样短路，不发网页请求");
});

test("doDailySet App ladder keeps p:0 offers pending for the web fallback", async () => {
    // 实测标定同样约束 doDailySet 阶梯0：p:0 + isDuplicate:false 的每日活动
    // 不得从待办清单出列（否则 Server Action 阶梯被跳过）。
    const { API, RewardsAuto, TaskManager, Utils } = createHarness();
    RewardsAuto.state.dateNowNum = 20260916;
    Utils.randomDelay = async () => {};
    RewardsAuto.state.token = "tok";
    API.getDailySetItems = async () => [
        { offerId: "Gamification_DailySet_Test_Child1", hash: "h1", points: 10, complete: false, url: "https://cn.bing.com/x" },
    ];
    API.appActivity = async () => ({ points: 0, isDuplicate: false, balance: 4260 });
    const sent = [];
    TaskManager._extractDailySetHashes = async (pendingItems) => {
        sent.push(pendingItems.map(it => it.offerId));
        return []; // 走到链接兜底前即结束，不需要完整链路
    };
    TaskManager._extractDailySetUrls = async () => [];

    await TaskManager.doDailySet();

    assert.deepEqual(sent[0], ["Gamification_DailySet_Test_Child1"],
        "App p:0 非 duplicate 的活动必须留在 pending 清单进入网页阶梯");
});

// ====== v3.6.2：Server Action 与真实浏览器行为对齐 ======

test("jsTimezoneOffset keeps the raw JS sign for the new server action", () => {
    const { Utils } = createHarness();
    const raw = String(new Date().getTimezoneOffset());
    assert.equal(Utils.jsTimezoneOffset(), raw);
    // v4.2.1：旧版 DAPI 东为正的 Utils.getTimezoneOffset 已随死代码清除（无任何现调用），
    // 不再做双约定符号互验；只钉住 Server Action 必须使用 JS 原始符号这一实测约定。
});

test("routerStateTree uses the browser-canonical __PAGE__ marker", () => {
    const { Utils } = createHarness();
    const tree = decodeURIComponent(Utils.routerStateTree("https://rewards.bing.com/dashboard"));
    assert.ok(tree.includes("__PAGE__"));
    assert.ok(tree.includes("dashboard"));
    const earnTree = decodeURIComponent(Utils.routerStateTree("https://rewards.bing.com/earn"));
    assert.ok(earnTree.includes("earn"));
});

// ====== v3.6.5：显式 Cookie 头（SW 子请求不自动携带 SameSite 登录 cookie）======

test("cookieHeaderFor builds a Cookie header from GM_cookie and stays empty when unavailable", async () => {
    const { Utils } = createHarness({}, {
        gmCookie(...args) {
            const callback = args.find(a => typeof a === "function");
            callback([
                { name: "ANON", value: "A=xyz" },
                { name: ".MSA.Auth", value: "token-value" },
            ]);
        }
    });
    const header = await Utils.cookieHeaderFor("https://rewards.bing.com/dashboard");
    assert.equal(header, "ANON=A=xyz; .MSA.Auth=token-value");

    // 默认 harness：GM_cookie 回调空列表 → 返回 ""，调用方保持隐式 cookie 行为
    const { Utils: U2 } = createHarness();
    assert.equal(await U2.cookieHeaderFor("https://rewards.bing.com/dashboard"), "");
});

test("_sendDailySetAction attaches the explicit cookie header when GM_cookie provides one", async () => {
    const { TaskManager, Utils } = createHarness({}, {
        gmCookie(...args) {
            const callback = args.find(a => typeof a === "function");
            callback([{ name: ".MSA.Auth", value: "t" }]);
        }
    });
    let req;
    Utils.xhr = async options => { req = options; return "0:{\"a\":\"$@1\"}\n1:true\n"; };

    const ok = await TaskManager._sendDailySetAction("offer-1", "a".repeat(40), "f".repeat(42), {});
    assert.equal(ok, true);
    assert.equal(req.headers.cookie, ".MSA.Auth=t");
    assert.equal(req.anonymous, true, "v3.7.0：显式链可用时关掉自动附带的碎片 cookie");
});

test("reportActivity attaches the explicit cookie header for the legacy API", async () => {
    const { API, Utils } = createHarness({}, {
        gmCookie(...args) {
            const callback = args.find(a => typeof a === "function");
            callback([{ name: "_U", value: "u" }]);
        }
    });
    let req;
    Utils.xhr = async options => { req = options; return "{}"; };
    API.getRequestVerificationToken = async () => "tok";

    await API.reportActivity("o1", "h1");
    assert.equal(req.headers.cookie, "_U=u");
});

// ====== v3.6.6：审查修复（策略1 Cookie 头 / 前台日期基准 / 运行锁心跳）======

test("claimCard strategy 1 (earn action) attaches the explicit cookie header", async () => {
    const { API, Utils } = createHarness({}, {
        gmCookie(...args) {
            const callback = args.find(a => typeof a === "function");
            callback([{ name: "_U", value: "u" }]);
        }
    });
    API._resolveReportActivityActionId = async () => null;
    API.getRewardsToken = async () => "tok";
    const posts = [];
    Utils.xhr = async options => {
        if (options.method === "POST") posts.push(options);
        return "0:{\"a\":\"$@1\"}\n1:true\n";
    };

    const ok = await API.claimCard({ offerId: "o1", hash: "h1" });

    assert.equal(ok, true);
    // 策略1 首选路径成功即返回，不再落到后续策略
    assert.equal(posts.length, 1);
    assert.equal(posts[0].headers.cookie, "_U=u");
    assert.equal(posts[0].anonymous, true, "v3.7.0：显式链可用时关掉自动附带的碎片 cookie");
});

// ====== v4.1.0：页面代理脚本与注入标记分诊随转发通道一并退役 ======

test("background script retires the page channel entirely", () => {
    const source = fs.readFileSync(scriptPath, "utf8");
    // 救援标签页/共享存储转发协议/注入标记分诊必须全部消失
    assert.doesNotMatch(source, /ensurePageChannel/);
    assert.doesNotMatch(source, /pageRequest/);
    assert.doesNotMatch(source, /_pageRouted/);
    assert.doesNotMatch(source, /_pageChannelOff|_pageRescueUsed|_pageTabHandle/);
    assert.doesNotMatch(source, /BingRewards_req|BingRewards_resp|BingRewards_alive|BingRewards_injected/);
    assert.doesNotMatch(source, /bgprobe|claimnow/);
    assert.doesNotMatch(source, /Config\.pageProxy/);
    // 头部架构说明不再指引安装页面代理脚本
    assert.ok(!source.includes("页面代理脚本未注入"));
});

test("v4.1.0 background script keeps crontab and drops all page-side code", () => {
    const source = fs.readFileSync(scriptPath, "utf8");
    assert.match(source, /@crontab/, "后台脚本保留 @crontab 定时能力");
    // 页面执行器/DOM 处理器已退役——后台脚本不再包含注入页面才生效的死代码
    assert.doesNotMatch(source, /const setupPageProxy/);
    assert.doesNotMatch(source, /clickPunchCards/);
    assert.doesNotMatch(source, /autoClaimPoints/);
});

test("run lock defaults to a 20-minute expiry and renewal only extends the owner's lock", () => {
    const { TaskManager, storage } = createHarness();
    const token = TaskManager._acquireRunLock();
    assert.ok(token);
    const span = storage.get("Config.runLock").expire - Date.now();
    assert.ok(span > 19 * 60 * 1000 && span <= 20 * 60 * 1000,
        `lock expiry should be ~20 minutes out, got ${span}ms`);

    // 续期仅延长自己持有的锁
    const shortened = Date.now() + 10 * 60 * 1000; // 人为把过期时间拨早
    storage.set("Config.runLock", { token, expire: shortened });
    TaskManager._renewRunLock(token);
    assert.ok(storage.get("Config.runLock").expire > shortened, "renewal must extend the expiry");

    // 锁被他人持有时不得覆盖
    storage.set("Config.runLock", { token: "someone-else", expire: Date.now() + 1000 });
    TaskManager._renewRunLock(token);
    assert.equal(storage.get("Config.runLock").token, "someone-else");
});

test("runAll holds the run lock with a heartbeat and stops it when finished", async () => {
    const d = new Date();
    const today = Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`);
    const { API, TaskManager, intervals } = createHarness({
        "Config.tasks": { sign: today, read: today, promos: today, search: today, streakDays: 0 },
        "Config.dailySetDone": today,
        "Config.punchCardBgDone": today,
    });
    API.getBalance = async () => { throw new Error("idle run must not call getBalance"); };

    await TaskManager.runAll();

    // 心跳以 5 分钟周期启动，且在 runAll 结束时停止
    assert.deepEqual(intervals.set.map(i => i.ms), [5 * 60 * 1000]);
    assert.equal(intervals.cleared.length, 1);
});

// ====== v3.6.7：运行锁加固（心跳失联 / 持有上限 / 过期值异常 → 自动接管）======

test("run lock takes over from stale heartbeat, exceeded hold ceiling, or corrupt expiry", () => {
    const { TaskManager, storage } = createHarness();
    const min = 60 * 1000;
    const now = Date.now();

    // ① 心跳失联：expire 仍有效，但 lastBeat 已 16 分钟未刷新（> 3 个心跳周期）
    storage.set("Config.runLock", { token: "t1", expire: now + 15 * min, lastBeat: now - 16 * min, acquiredAt: now - 30 * min });
    const g1 = TaskManager._acquireRunLock();
    assert.ok(g1, "stale heartbeat must be taken over");
    TaskManager._releaseRunLock(g1);

    // ② 持有超上限：心跳新鲜，但 acquiredAt 是 91 分钟前（卡死但仍在心跳的实例）
    storage.set("Config.runLock", { token: "t2", expire: now + 15 * min, lastBeat: now, acquiredAt: now - 91 * min });
    const g2 = TaskManager._acquireRunLock();
    assert.ok(g2, "over-ceiling hold must be taken over");
    TaskManager._releaseRunLock(g2);

    // ③ 过期时间异常：超大 expire 视同损坏锁
    storage.set("Config.runLock", { token: "t3", expire: now + 365 * 24 * 60 * min, lastBeat: now, acquiredAt: now });
    const g3 = TaskManager._acquireRunLock();
    assert.ok(g3, "corrupt expiry must be taken over");
    TaskManager._releaseRunLock(g3);

    // 对照：心跳新鲜 + 持有在上限内的活锁必须继续挡住
    storage.set("Config.runLock", { token: "t4", expire: now + 15 * min, lastBeat: now, acquiredAt: now });
    assert.equal(TaskManager._acquireRunLock(), null);

    // 对照：临界窗口内（心跳 14 分钟前、持有 40 分钟）仍判为有效，不误抢
    storage.set("Config.runLock", { token: "t5", expire: now + 15 * min, lastBeat: now - 14 * min, acquiredAt: now - 40 * min });
    assert.equal(TaskManager._acquireRunLock(), null);
});

test("renewal stamps heartbeat, declines at hold ceiling, never touches others' lock", () => {
    const { TaskManager, storage } = createHarness();
    const token = TaskManager._acquireRunLock();
    assert.ok(token);

    // 迁移：v3.6.6 旧记录无 lastBeat/acquiredAt，续期时补齐且不拒续
    storage.set("Config.runLock", { token, expire: Date.now() + 19 * 60 * 1000 });
    assert.equal(TaskManager._renewRunLock(token), true);
    const rec = storage.get("Config.runLock");
    assert.equal(typeof rec.lastBeat, "number");
    assert.equal(typeof rec.acquiredAt, "number");

    // 达到持有上限：拒绝续期且不改写锁记录（让锁自然过期，别的实例接管）
    storage.set("Config.runLock", { ...rec, acquiredAt: Date.now() - 91 * 60 * 1000 });
    const expireBefore = storage.get("Config.runLock").expire;
    assert.equal(TaskManager._renewRunLock(token), false);
    assert.equal(storage.get("Config.runLock").expire, expireBefore);

    // 锁已被他人接管：拒绝且绝不覆盖
    storage.set("Config.runLock", { token: "other", expire: Date.now() + 1000 });
    assert.equal(TaskManager._renewRunLock(token), false);
    assert.equal(storage.get("Config.runLock").token, "other");
});

test("runAll heartbeat timer stops itself once the hold ceiling is reached", async () => {
    const { API, TaskManager, storage, intervals } = createHarness();
    API.getBalance = () => new Promise(() => {}); // 挂在 try 内部，保持 runAll 运行中

    const runPromise = TaskManager.runAll(); // 不会 resolve，本用例不等待它
    assert.equal(intervals.set.length, 1);
    assert.equal(intervals.cleared.length, 0);

    // 把锁的持有时间拨到上限之外，模拟一次"卡死后到达上限"的心跳时刻
    const rec = storage.get("Config.runLock");
    storage.set("Config.runLock", { ...rec, acquiredAt: Date.now() - 91 * 60 * 1000 });
    intervals.set[0].fn();

    assert.equal(intervals.cleared.length, 1, "heartbeat must stop itself when renewal is declined");
    assert.equal(storage.get("Config.runLock").expire, rec.expire, "declined renewal must not extend the lock");
    assert.equal(intervals.set.length, 1);
    void runPromise;
});

// ====== v4.1.0：前台同源转发通道退役，rewards 域请求一律 SW 直连 ======

test("rewards.bing.com requests go straight to SW without any page channel", async () => {
    const calls = [];
    const gmXhr = o => { calls.push(o.url); o.onload({ status: 200, responseText: "SW", responseHeaders: "" }); };
    const { Utils, storage } = createHarness({ "BingRewards_alive": { ts: Date.now() } }, { gmXhr });

    const body = await Utils.xhr({ method: "POST", url: "https://rewards.bing.com/dashboard", data: "[1]" });

    assert.equal(body, "SW");
    assert.equal(calls.length, 1);
    assert.equal(calls[0], "https://rewards.bing.com/dashboard");
    assert.equal(storage.get("BingRewards_req"), undefined, "channel is retired: no request may be forwarded via shared storage");
});

test("SW non-2xx keeps acceptErrorBody / rejection semantics", async () => {
    let n = 0;
    const gmXhr = o => {
        n++;
        if (n === 1) o.onload({ status: 500, responseText: "E80", responseHeaders: "" });
        else o.onload({ status: 401, responseText: "", responseHeaders: "" });
    };
    const { Utils } = createHarness({}, { gmXhr });
    const r = await Utils.xhr({ method: "POST", url: "https://rewards.bing.com/dashboard", acceptErrorBody: true });
    assert.equal(r.status, 500);
    assert.equal(r.body, "E80");

    await assert.rejects(
        () => Utils.xhr({ method: "POST", url: "https://rewards.bing.com/dashboard" }),
        /HTTP 401/);
});

test("background detection uses hostname, not just typeof document (sandbox has document)", () => {
    const source = fs.readFileSync(scriptPath, "utf8");
    const fixed = '!/(^|\\.)bing\\.com$/.test(location.hostname || "");';
    assert.equal(source.split(fixed).length - 1, 2);
});

// ====== v3.6.13：页面注入标记与失联分诊 ======

// ====== v4.1.0：转发执行器/注入标记/诊断菜单随通道一并退役（测试移除）======

// ====== v3.6.10：解除已死 legacy 签入接口对阅读的连坐 ======

test("sign 401 (dead legacy endpoint) no longer skips the read task", async () => {
    const d = new Date();
    const today = Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`);
    const { API, TaskManager, Utils } = createHarness({
        // read 日期未完成 → 非空闲轮；其余今日已完成，缩短 runAll 实际路径
        "Config.tasks": { sign: today, promos: today, search: today, streakDays: 0 },
        "Config.dailySetDone": today,
        "Config.punchCardBgDone": today,
    });
    let readRan = 0;
    Utils.randomDelay = async () => {};
    API.getBalance = async () => 100;
    API.checkRegion = async () => true;
    API.renewToken = async () => true;
    API.discoverCards = async () => [];
    API.getRewardsInfo = async () => null;
    // 签到按真实故障形态抛 401（legacy 接口下线场景），验证阅读不被连坐。
    // v4.2.1：连坐时代的 state.pc401 诊断标志位已随死代码清除，故障经异常表达。
    TaskManager.doSign = async () => { throw new Error("HTTP 401: legacy reportActivity endpoint retired"); };
    TaskManager.doRead = async () => { readRan++; return true; };
    TaskManager.doPromos = async () => true;
    TaskManager.doSearch = async () => true;
    TaskManager.doStreak = async () => true;
    TaskManager.doDailySet = async () => true;
    TaskManager.doPunchCard = async () => true;
    TaskManager.doClaimPoints = async () => true;

    await TaskManager.runAll();

    assert.ok(readRan > 0, "read must run even after signPC 401s");
});

test("renewToken keeps an unused auth code on refresh success and logs it", async () => {
    const oldTime = Date.now() - 47 * 86400000;
    const savedCode = "https://login.live.com/oauth20_desktop.srf?code=FRESH-CODE";
    const { API, Utils, storage } = createHarness({
        "Config.token": "old-refresh",
        "Config.tokenTime": oldTime,
        "Config.code": savedCode,
    });
    Utils.xhr = async () => JSON.stringify({ refresh_token: "new-refresh", access_token: "access" });

    const ok = await API.renewToken();

    assert.equal(ok, true);
    assert.equal(storage.get("Config.token"), "new-refresh");
    assert.ok(storage.get("Config.tokenTime") > oldTime);
    // refresh 路径没用到授权码：绝不能把用户刚粘贴的新凭证清掉
    assert.equal(storage.get("Config.code"), savedCode);
});

// ====== v3.6.11：登录态抓包重写的卡片链路与欢迎页领取 ======
// 复用文件前部已有的 flightHtml(...payloads) helper 构造 __next_f 测试页

test("parseEarnLiveOffers reads live hash/completion/lock per offer", () => {
    const { Utils } = createHarness();
    const combined = [
        { offerId: "O1", hash: "a".repeat(64), isCompleted: true },
        { offerId: "O2", hash: "b".repeat(64), isLocked: true, unlockCriteria: "rewardsApp" },
        { offerId: "O3", hash: "c".repeat(64) },
    ].map(o => JSON.stringify(o)).join(",");
    const live = Utils.parseEarnLiveOffers(combined);
    assert.equal(live.O1.isCompleted, true);
    assert.equal(live.O2.isLocked, true);
    assert.equal(live.O2.unlockCriteria, "rewardsApp");
    assert.equal(live.O3.hash, "c".repeat(64));
    assert.equal(live.O3.isCompleted, false);
});

test("claimCard posts the browser-captured earn contract (context shape, live hash)", async () => {
    const posts = [];
    const { API, Utils } = createHarness();
    API._resolveReportActivityActionId = async () => "f".repeat(40);
    Utils.fetchPage = async () => { throw new Error("strategy 1 must not re-fetch"); };
    Utils.xhr = async o => { posts.push(o); return "0:{}\n1:true\n1:irrelevant-rsc"; };

    const ok = await API.claimCard({ offerId: "O3", hash: "c".repeat(64), points: 15, url: "https://www.bing.com/search?q=x" });

    assert.equal(ok, true);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "https://rewards.bing.com/earn");
    assert.equal(posts[0].method, "POST");
    assert.equal(posts[0].headers["next-action"], "f".repeat(40));
    const body = JSON.parse(posts[0].data);
    assert.equal(body[0], "c".repeat(64));
    assert.equal(body[1], 11);
    assert.equal(body[2].offerid, "O3");
    assert.ok("timezoneOffset" in body[2] && "isPromotional" in body[2]);
    assert.equal("form" in body[2], false, "context shape must not carry the impression form field");
});

test("claimCard retries once with the fresh earn-flight hash when the first POST fails", async () => {
    const posts = [];
    const { API, Utils } = createHarness();
    API._resolveReportActivityActionId = async () => "f".repeat(40);
    Utils.xhr = async o => {
        posts.push(o);
        if (posts.length === 1) throw new Error("HTTP 500");
        return "1:true";
    };
    Utils.fetchPage = async () => flightHtml(`{"offerId":"O5","hash":"${"e".repeat(64)}","isCompleted":false,"isLocked":false}`);

    const ok = await API.claimCard({ offerId: "O5", hash: "stalehash", points: 15 });

    assert.equal(ok, true);
    assert.equal(posts.length, 2);
    assert.equal(JSON.parse(posts[1].data)[0], "e".repeat(64), "second attempt must use the fresh live hash");
});

test("claimCard abandons without extra posts when the live offer is locked (app-only)", async () => {
    const posts = [];
    const { API, Utils } = createHarness();
    API._resolveReportActivityActionId = async () => "f".repeat(40);
    Utils.xhr = async o => { posts.push(o); throw new Error("HTTP 500"); };
    Utils.fetchPage = async () => flightHtml(`{"offerId":"O9","hash":"${"d".repeat(64)}","isCompleted":false,"isLocked":true,"unlockCriteria":"rewardsApp"}`);

    const ok = await API.claimCard({ offerId: "O9", hash: "stale", points: 10 });

    assert.equal(ok, false);
    assert.equal(posts.length, 1, "locked offers must short-circuit after the single failed attempt");
});

test("claimPendingPoints posts empty args to dashboard with dynamic/fallback action id", async () => {
    const posts = [];
    const { API, Utils } = createHarness();
    // 真实长度前提：现网 $ACTION_ID_ 抓包实测 42 位（写死 {40} 会截出无效前缀、
    // 且候选数仍为 1 反而优先于正确兜底）。40 位夹具曾把错误假设固化为基线。
    const dyn = "1".repeat(40) + "ab";
    assert.equal(dyn.length, 42, "夹具必须按真实 42 位构造");
    Utils.fetchPage = async () => `<html>foo $ACTION_ID_${dyn} bar</html>`;
    Utils.xhr = async o => { posts.push(o); return '0:{"a":"$@1"}\n1:true\n'; };

    const ok = await API.claimPendingPoints();

    assert.equal(ok, true);
    assert.equal(posts[0].url, "https://rewards.bing.com/dashboard");
    assert.equal(posts[0].method, "POST");
    assert.equal(posts[0].data, "[]");
    assert.equal(posts[0].headers["next-action"], dyn);

    // 页面没有唯一 $ACTION_ID 候选 → 抓包兜底 id
    Utils.fetchPage = async () => "<html>none</html>";
    await API.claimPendingPoints();
    assert.equal(posts[1].headers["next-action"], "00491296f1d668ad46b65342c95cb9d72a62c1fa9d");
});

test("claimPendingPoints accepts a 42-char Config.claimActionId override (guard regression)", async () => {
    // 失败日志指引用户"更新 Config.claimActionId"，但旧守卫 /^[a-f0-9]{40}$/ 会把
    // 正确的 42 位覆盖值拒掉并静默回退过期常量——用户无法自救。
    const OVERRIDE42 = "a".repeat(40) + "bc";
    assert.equal(OVERRIDE42.length, 42);
    assert.notEqual(OVERRIDE42, "00491296f1d668ad46b65342c95cb9d72a62c1fa9d");
    const posts = [];
    const { API, Utils } = createHarness({ "Config.claimActionId": OVERRIDE42 });
    Utils.fetchPage = async () => "<html>no candidates here</html>";
    Utils.xhr = async o => { posts.push(o); return "0:{}\n1:true\n"; };

    const ok = await API.claimPendingPoints();

    assert.equal(ok, true);
    assert.equal(posts[0].headers["next-action"], OVERRIDE42, "42 位覆盖值必须通过守卫，不得静默回退兜底常量");
});

test("getBalance({fresh:true}) bypasses the round cache (今日获取 was pinned at +0)", async () => {
    // runAll 轮末取数必须 fresh：缓存键绑定轮内恒定的 dateNowNum，
    // 不绕开的话首尾命中同一缓存、earned 恒为 0。
    let requests = 0;
    const balances = [4100, 4300];
    const { API, Utils } = createHarness();
    Utils.xhr = async () => {
        const v = balances[Math.min(requests, balances.length - 1)];
        requests++;
        return JSON.stringify({ response: { balance: v } });
    };

    const first = await API.getBalance();
    const cached = await API.getBalance();
    assert.equal(first, 4100);
    assert.equal(cached, 4100);
    assert.equal(requests, 1, "轮内第二次非 fresh 调用应命中缓存，不再发请求");

    const fresh = await API.getBalance({ fresh: true });
    assert.equal(fresh, 4300, "fresh 必须绕开缓存拿到轮末真实余额");
    assert.equal(requests, 2);
});

test("debugDailySet action-request log never carries cookie plaintext", async () => {
    const logged = [];
    const { TaskManager, Utils } = createHarness({ "Config.debugDailySet": true }, {
        gmCookie(...args) {
            const callback = args.find(a => typeof a === "function");
            callback([{ name: ".MSA.Auth", value: "MSA_SECRET_VALUE_1234567890" }]);
        },
    });
    Utils.log = (...a) => logged.push(a.join(" "));
    Utils.xhr = async () => "0:{}\n1:true\n";

    const ok = await TaskManager._sendDailySetAction("offer-1", "a".repeat(40), "f".repeat(42), {});

    assert.equal(ok, true);
    const line = logged.find(l => String(l).includes("Server Action 请求"));
    assert.ok(line, "调试开启时应输出请求形态日志");
    assert.ok(!String(line).includes("MSA_SECRET_VALUE_1234567890"), "cookie 值不得进入日志（截图/issue 外泄面）");
    assert.ok(!/"cookie"\s*:/.test(String(line)), "序列化的 headers 中不得出现 cookie 字段");
    assert.ok(String(line).includes('"cookies":1'), "作者本意的 cookie 条数应保留");
});

test("discoverCards overlays earn live state: filters done/locked, restamps live hash", async () => {
    const offers = [
        { offerId: "DONE1", hash: "a".repeat(64), points: 10, title: "T1", isCompleted: true },
        { offerId: "LOCK1", hash: "b".repeat(64), points: 10, title: "T2", isCompleted: false, isLocked: true, unlockCriteria: "rewardsApp" },
        { offerId: "OPEN1", hash: "c".repeat(64), points: 15, title: "T3", isCompleted: false },
    ];
    const combined = '{"activityCards":[' + offers.map(o => JSON.stringify(o)).join(",") + ']}';
    const { API, Utils } = createHarness();
    API._getUserInfo = async () => null;
    Utils.fetchPage = async () => flightHtml(combined);

    const cards = await API.discoverCards();

    // Array.from 在宿主 realm 收集（vm realm 的 map 结果跨 realm 原型比较会失败）
    assert.deepEqual(Array.from(cards, c => c.offerId), ["OPEN1"]);
    assert.equal(cards[0].hash, "c".repeat(64));
});

// ====== v3.6.17：多源同 offerId 去重（hash 随页面轮换，去重键不能含 hash） ======

test("discoverCards dedupes the same offerId across sources and keeps the first url", async () => {
    const hashA = "a".repeat(64), hashB = "b".repeat(64);
    const DUP = "WW_Rewards_locked_level2_Sep26w3_offer2";
    const { API, Utils } = createHarness();
    // 源1: getuserinfo 先推（带 destinationUrl）
    API._getUserInfo = async () => ({ dashboard: {
        morePromotions: [
            { offerId: DUP, hash: hashA, points: 15, title: "可爱但野性", destinationUrl: "https://www.bing.com/promo" },
            { offerId: "C1", hash: hashA, points: 10, title: "T1" },
        ],
    } });
    // 源2: earn 页 activityCards 再推同一 offerId（hash 已轮换、无 url）。
    // 方法1 的结束 lookahead 要求 ] 后跟 , 键 或 $，数组尾补一个后续键才与真实页面同构。
    const combined = '{"activityCards":['
        + JSON.stringify({ offerId: DUP, hash: hashB, points: 15, title: "可爱但野性" })
        + "," + JSON.stringify({ offerId: "C2", hash: hashB, points: 10, title: "T2" })
        + '],"hasMore":1}';
    Utils.fetchPage = async () => flightHtml(combined);

    const cards = await API.discoverCards();

    const ids = Array.from(cards, c => c.offerId);
    assert.equal(ids.filter(id => id === DUP).length, 1, "same offerId from two sources must yield one card");
    assert.equal(ids.length, 3, "other distinct offers must survive");
    const kept = cards.find(c => c.offerId === DUP);
    assert.equal(kept.url, "https://www.bing.com/promo", "first source url must survive the dedupe");
    assert.equal(kept.hash, hashB, "kept hash must be restamped from the current flight");
});

// ====== v3.7.0：入账唯一判据 1:true + cookie 链诊断（登录态浏览器逆向实证） ======

test("claimCard treats 2xx without 1:true as not-executed (cookie-less SW signature)", async () => {
    const posts = [];
    const { API, Utils } = createHarness();
    API._resolveReportActivityActionId = async () => "f".repeat(40);
    Utils.fetchPage = async () => "<html></html>";
    // 200 + RSC 重渲染流（无 1:true）——实测缺 cookie 链时服务端的行为
    Utils.xhr = async o => { posts.push(o); return "2:\"$Sreact.fragment\"\n5:I[339756,[\"/_next/static/chunks/0accg9rvmunu0.js\"]]"; };

    const ok = await API.claimCard({ offerId: "O1", hash: "c".repeat(64), points: 10 });

    assert.equal(ok, false, "200 without 1:true means the action never ran");
    assert.ok(posts.length >= 1);
});

test("claimCard sends explicit cookie chain with anonymous and passes on 1:true", async () => {
    const posts = [];
    const { API, Utils } = createHarness({}, {
        // ScriptCat action 形回调：两张含 httpOnly 的登录 cookie
        gmCookie: (action, details, cb) => cb([{ name: "_U", value: "u1" }, { name: "ANON", value: "a1" }]),
    });
    API._resolveReportActivityActionId = async () => "f".repeat(40);
    Utils.fetchPage = async () => "<html></html>";
    Utils.xhr = async o => { posts.push(o); return "0:{\"a\":\"$@1\",\"f\":\"\",\"q\":\"\",\"i\":false}\n1:true\n"; };

    const ok = await API.claimCard({ offerId: "O1", hash: "c".repeat(64), points: 10 });

    assert.equal(ok, true);
    assert.equal(posts[0].headers.cookie, "_U=u1; ANON=a1");
    assert.equal(posts[0].anonymous, true, "explicit chain must suppress the partial auto cookie jar");
});

test("cookieHeaderFor surfaces GM_cookie errors instead of silent empty chain", async () => {
    const { Utils, RewardsAuto } = createHarness({}, {
        gmCookie: (action, details, cb) => cb(undefined, { message: "user denied cookie access" }),
    });

    const chain = await Utils.cookieHeaderFor("https://rewards.bing.com/earn");

    assert.equal(chain, "");
    assert.equal(RewardsAuto.state.cookieDiag.form, "GM_cookie(action)");
    assert.match(RewardsAuto.state.cookieDiag.error, /denied/);
});

// ====== v3.6.12：入账延迟竞态修复 + x-deployment-id 指纹头 ======

// ====== v4.0.0：DAPI App 上报主路径（type 101 + offerid，SW 直连实测入账） ======

test("claimCard primary path: DAPI type 101 credits via SW direct without earn POST", async () => {
    const posts = [];
    const { API, RewardsAuto, Utils } = createHarness();
    RewardsAuto.state.token = "at-mock";
    Utils.xhr = async o => {
        posts.push(o);
        if (o.url.includes("/dapi/me/activities")) {
            return JSON.stringify({ response: { activity: { p: 10 }, isDuplicate: false, balance: 4128 } });
        }
        return "1:true";
    };
    const ok = await API.claimCard({ offerId: "Gamification_DailySet_X_Child3", hash: "c".repeat(64), points: 10 });
    assert.equal(ok, true);
    assert.equal(posts.length, 1, "DAPI success must not fall through to earn POST");
    assert.ok(posts[0].url.includes("/dapi/me/activities"));
    const body = JSON.parse(posts[0].data);
    assert.equal(body.type, 101);
    assert.equal(body.attributes.offerid, "Gamification_DailySet_X_Child3");
});

test("claimCard treats DAPI isDuplicate as already-credited success", async () => {
    const { API, RewardsAuto, Utils } = createHarness();
    RewardsAuto.state.token = "at-mock";
    Utils.xhr = async () => JSON.stringify({ response: { activity: null, isDuplicate: true, balance: 4128 } });
    assert.equal(await API.claimCard({ offerId: "O1", hash: "h", points: 10 }), true);
});

test("claimCard falls back to earn Server Action when DAPI rejects the offer", async () => {
    const posts = [];
    const { API, RewardsAuto, Utils } = createHarness();
    RewardsAuto.state.token = "at-mock";
    API._resolveReportActivityActionId = async () => "f".repeat(40);
    Utils.fetchPage = async () => "<html></html>";
    Utils.xhr = async o => {
        posts.push(o);
        if (o.url.includes("/dapi/")) throw new Error("HTTP 403");
        return "0:{}\n1:true\n";
    };
    const ok = await API.claimCard({ offerId: "WEB_ONLY", hash: "c".repeat(64), points: 5 });
    assert.equal(ok, true);
    assert.ok(posts[0].url.includes("/dapi/"));
    assert.equal(posts[1].url, "https://rewards.bing.com/earn");
});

test("doRead verification bypasses the round cache and marks readDate optimistically", async () => {
    const { API, RewardsAuto, TaskManager, Utils } = createHarness();
    RewardsAuto.state.dateNowNum = 20260915;
    TaskManager.readDate = 0;
    const calls = [];
    API.getReadProgress = async opts => {
        calls.push(opts);
        return calls.length === 1 ? { progress: 0, max: 30 } : { progress: 30, max: 30 };
    };
    API.doRead = async () => ({ points: 3, isDuplicate: false });
    Utils.randomDelay = async () => {};
    Utils.delay = async () => {};

    const ok = await TaskManager.doRead();

    assert.equal(ok, true);
    assert.equal(TaskManager.readDate, 20260915, "readDate must be set once the batch executed");
    assert.equal(calls.length, 2);
    // vm realm 对象跨 realm 深比较会失败，逐字段断言
    assert.ok(calls[1] && calls[1].fresh === true, "post-batch verification must bypass the round cache");
});

test("server-action posts carry x-deployment-id when a dpl is known", async () => {
    const posts = [];
    const { API, Utils } = createHarness({
        "Config.reportAction": { dpl: "20260912-2", id: "f".repeat(40) },
    });
    API._resolveReportActivityActionId = async () => "f".repeat(40);
    Utils.fetchPage = async () => "<html></html>";
    Utils.xhr = async o => { posts.push(o); return "1:true"; };

    await API.claimCard({ offerId: "O1", hash: "c".repeat(64), points: 10 });
    await API.claimPendingPoints();

    assert.equal(posts[0].url, "https://rewards.bing.com/earn");
    assert.equal(posts[0].headers["x-deployment-id"], "20260912-2");
    assert.equal(posts[1].url, "https://rewards.bing.com/dashboard");
    assert.equal(posts[1].headers["x-deployment-id"], "20260912-2");
    // v3.6.16：直连补齐浏览器指纹头（sec-fetch-*），earn 动作对齐 origin/referer/UA
    assert.equal(posts[0].headers["sec-fetch-site"], "same-origin");
    assert.equal(posts[0].headers["sec-fetch-mode"], "cors");
    assert.equal(posts[0].headers["sec-fetch-dest"], "empty");
    assert.equal(posts[0].headers.origin, "https://rewards.bing.com");
    assert.ok(posts[0].headers["user-agent"]);
});

// ====== v4.1.1：锁定等级卡不再阻塞"活动卡片✅"（2026-09-17 日志实证） ======
// 现场：每日活动 Child1/2/3 已 App 上报入账，但 WW_Rewards_locked_level2_Sep26w3_offer2
// 每轮被列为可领取、全策略失败 → fail>0 → promosDate 永远写不上 → 摘要整日 ❌。

test("normalizeDashboardCard filters out locked offers (isLocked) at parse layer", async () => {
    const { API, Utils } = createHarness();
    API._getUserInfo = async () => ({ dashboard: {
        morePromotions: [
            { offerId: "LOCKED1", hash: "a".repeat(64), points: 15, title: "可爱但野性", isLocked: true, unlockCriteria: "level2" },
            { offerId: "OPEN1", hash: "b".repeat(64), points: 10, title: "T1" },
        ],
    } });
    Utils.fetchPage = async () => "<html></html>"; // 非 earn flight 内容；空串会让 discoverCards 直接返回 null

    const cards = await API.discoverCards();

    assert.deepEqual(Array.from(cards, c => c.offerId), ["OPEN1"],
        "locked offers must be filtered at the getuserinfo parse layer");
});

test("parseCard filters out locked offers in activityCards arrays", async () => {
    const combined = '{"activityCards":['
        + JSON.stringify({ offerId: "LOCKED2", hash: "a".repeat(64), points: 15, title: "T2", isLocked: true })
        + "," + JSON.stringify({ offerId: "OPEN2", hash: "b".repeat(64), points: 10, title: "T3" })
        + '],"hasMore":1}';
    const { API, Utils } = createHarness();
    API._getUserInfo = async () => null;
    Utils.fetchPage = async () => flightHtml(combined);

    const cards = await API.discoverCards();

    assert.deepEqual(Array.from(cards, c => c.offerId), ["OPEN2"],
        "locked offers must be filtered at the activityCards parse layer");
});

test("_recordFailedClaims counts toward the give-up ledger and reaches give-up at N", () => {
    const { RewardsAuto, TaskManager } = createHarness();
    RewardsAuto.state.dateNowNum = 20260917;

    // 前 4 次：未达上限（5），无卡片出列
    for (let i = 0; i < 4; i++) {
        assert.deepEqual(Array.from(TaskManager._recordFailedClaims(["stuck1", "stuck1", "other"])), []);
    }
    // 第 5 次：达上限 → stuck1 出列（other 计 4 次未达）
    assert.deepEqual(Array.from(TaskManager._recordFailedClaims(["stuck1"])), ["stuck1"]);

    // _givenUpOfferIds 同步可见，次日日期变更自动清零
    assert.ok(TaskManager._givenUpOfferIds().has("stuck1"));
    RewardsAuto.state.dateNowNum = 20260918;
    assert.equal(TaskManager._givenUpOfferIds().size, 0);
});

test("doPromos marks done once failing locked cards reach the give-up limit", async () => {
    const { API, RewardsAuto, TaskManager, Utils, storage } = createHarness({ "Tasks.promos": true });
    RewardsAuto.state.dateNowNum = 20260917;
    Utils.randomDelay = async () => {};
    // 锁定卡每轮全策略失败（真实场景：WW_Rewards_locked_level2_Sep26w3_offer2）
    API.discoverCards = async () => [
        { offerId: "WW_Rewards_locked_level2_Sep26w3_offer2", hash: "h", points: 15, kind: "open_only", title: "可爱但野性" },
    ];
    API.claimCard = async () => false;

    // 前 4 轮：未达上限，保持 pending
    for (let i = 0; i < 4; i++) {
        TaskManager.promosTimes = 0;
        assert.equal(await TaskManager.doPromos(), false);
        assert.equal(TaskManager.promosDate, 0);
    }

    // 第 5 轮：达上限当日放弃 → promosDate 落账，摘要可转 ✅
    TaskManager.promosTimes = 0;
    assert.equal(await TaskManager.doPromos(), true);
    assert.equal(TaskManager.promosDate, 20260917);
    // 放弃账本已记账，下轮扫描起不再出列该卡
    assert.equal(storage.get("Config.promosUnconfirmed").offers["WW_Rewards_locked_level2_Sep26w3_offer2"], 5);
});

test("doPromos stays pending while a failing card has not reached the give-up limit", async () => {
    const { API, RewardsAuto, TaskManager, Utils } = createHarness({ "Tasks.promos": true });
    RewardsAuto.state.dateNowNum = 20260917;
    Utils.randomDelay = async () => {};
    API.discoverCards = async () => [{ offerId: "stuck", hash: "h", points: 5, kind: "daily", title: "stuck" }];
    API.claimCard = async () => false;

    assert.equal(await TaskManager.doPromos(), false);
    assert.equal(TaskManager.promosDate, 0);
    assert.equal(TaskManager.promosTimes, 1);
});

test("second scan keeps promosDate only while failed cards are below the give-up limit", async () => {
    const { API, RewardsAuto, TaskManager, Utils, storage } = createHarness();
    RewardsAuto.state.dateNowNum = 20260917;
    Utils.randomDelay = async () => {};
    const today = 20260917;
    // read 未完成 → 非空闲轮，runAll 能走到末尾的二次扫描；其余任务当日已完成
    storage.set("Config.tasks", { sign: today, read: 0, promos: today, search: today, streakDays: 66 });
    storage.set("Config.dailySetDone", today);
    storage.set("Config.punchCardBgDone", today);
    // 主任务全部 stub 掉（doPromos 也 stub，隔离出纯二次扫描路径）
    let readRan = 0;
    API.getBalance = async () => 100;
    API.checkRegion = async () => true;
    API.renewToken = async () => true;
    API.getRewardsInfo = async () => null;
    API.discoverCards = async () => [{ offerId: "locked", hash: "h", points: 15, kind: "open_only", title: "L" }];
    API.claimCard = async () => false;
    TaskManager.doSign = async () => true;
    TaskManager.doRead = async () => { readRan++; return true; };
    TaskManager.doPromos = async () => true;
    TaskManager.doSearch = async () => true;
    TaskManager.doStreak = async () => true;
    TaskManager.doDailySet = async () => true;
    TaskManager.doPunchCard = async () => true;
    TaskManager.doClaimPoints = async () => true;

    // 第 1 轮失败（未达上限）：promosDate 被重置，下轮继续重试
    await TaskManager.runAll();
    assert.ok(readRan > 0, "runAll must reach the task flow");
    assert.equal(TaskManager.promosDate, 0, "failing scan below the limit must reset promosDate for retry");
    // 第 2 轮失败：仍未达上限，保持重置状态；账本计数持续累计
    await TaskManager.runAll();
    assert.equal(TaskManager.promosDate, 0);
    assert.equal(storage.get("Config.promosUnconfirmed").offers.locked, 2);
});
