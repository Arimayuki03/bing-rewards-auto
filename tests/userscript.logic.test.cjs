const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const scriptPath = path.resolve(__dirname, "..", "微软积分商城签到（全能智能重构版）.user.js");

function createHarness(initialStorage = {}, { gmXhr, gmCookie } = {}) {
    const storage = new Map(Object.entries(initialStorage));
    const intervals = { set: [], cleared: [] };
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
        GM_openInTab() {},
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
    return { ...context.__userscriptTest, storage, intervals };
}

test("claimCard returns false when all earn-action strategies fail (legacy path retired)", async () => {
    const { API, Utils } = createHarness();
    API._resolveReportActivityActionId = async () => "f".repeat(40);
    Utils.xhr = async () => { throw new Error("server action failed"); };
    Utils.fetchPage = async () => ""; // live hash 重试也拿不到 → 短路到放弃
    let legacyCalls = 0;
    API.reportActivity = async () => { legacyCalls++; return false; };

    const result = await API.claimCard({ offerId: "offer", hash: "hash" });

    assert.equal(result, false);
    assert.equal(legacyCalls, 0, "v3.6.11: dead legacy reportactivity must no longer be called");
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
    RewardsAuto.state.pc401 = true;

    TaskManager.init();

    assert.equal(TaskManager.signTimes, 0);
    assert.equal(TaskManager.readTimes, 0);
    assert.equal(TaskManager.promosTimes, 0);
    assert.equal(RewardsAuto.state.pc401, false);
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
    Utils.xhr = async options => { req = options; return "ok"; };

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
    Utils.xhr = async options => { posts.push(options); return "ok"; };

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
        return "ok";
    };

    // card.url 是 bing.com 目标页 → Server Action 必须改发 earn 页
    const ok = await API.claimCard({ offerId: "o1", hash: "h1", url: "https://cn.bing.com/search?q=x&rnoreward=1" });
    assert.equal(ok, true);
    assert.equal(posts[0].url, "https://rewards.bing.com/earn");
    assert.equal(posts[0].headers["next-action"], actionId);
    assert.ok(posts[0].headers["next-router-state-tree"].includes("earn"));
    assert.equal(posts[0].headers["accept"], "text/x-component");
});

test("claimCard falls back to visiting the card url when all report strategies fail", async () => {
    const { API, Utils } = createHarness();
    API._resolveReportActivityActionId = async () => "c".repeat(42);
    API.getRewardsToken = async () => false;
    API.reportActivity = async () => false;
    const gets = [];
    Utils.xhr = async options => {
        if (options.method === "POST") throw new Error("HTTP 500");
        gets.push(options);
        // earn 刷新返回空 flight（live hash 重试无候选 → 直接落到 impression/visit）
        return options.url === "https://rewards.bing.com/earn" ? "<html></html>" : "ok";
    };

    const ok = await API.claimCard({ offerId: "o1", hash: "h1", url: "https://cn.bing.com/search?q=x&rnoreward=1" });
    assert.equal(ok, true);
    // v3.6.11：POST 失败后先刷新 earn 取 live hash，再复刻点击目标页
    assert.equal(gets.length, 2);
    assert.equal(gets[0].url, "https://rewards.bing.com/earn");
    assert.equal(gets[1].url, "https://cn.bing.com/search?q=x&rnoreward=1");

    // 非 bing.com 目标页不做点击复刻，所有策略失败返回 false
    assert.equal(await API.claimCard({ offerId: "o2", hash: "h2", url: "https://example.com/x" }), false);
    assert.equal(gets.length, 3); // 又刷新了一次 earn，但不请求 example.com
    assert.equal(gets[2].url, "https://rewards.bing.com/earn");
});

// ====== v3.6.2：Server Action 与真实浏览器行为对齐 ======

test("jsTimezoneOffset keeps the raw JS sign for the new server action", () => {
    const { Utils } = createHarness();
    const raw = String(new Date().getTimezoneOffset());
    assert.equal(Utils.jsTimezoneOffset(), raw);
    // 与旧版 DAPI 约定（东经为正）符号相反
    assert.equal(Number(Utils.jsTimezoneOffset()) + Number(Utils.getTimezoneOffset()), 0);
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
    Utils.xhr = async options => { req = options; return "ok"; };

    const ok = await TaskManager._sendDailySetAction("offer-1", "a".repeat(40), "f".repeat(42), {});
    assert.equal(ok, true);
    assert.equal(req.headers.cookie, ".MSA.Auth=t");
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
        return "ok";
    };

    const ok = await API.claimCard({ offerId: "o1", hash: "h1" });

    assert.equal(ok, true);
    // 策略1 首选路径成功即返回，不再落到后续策略
    assert.equal(posts.length, 1);
    assert.equal(posts[0].headers.cookie, "_U=u");
});

test("front-end rewards block fixes the run date before the /dashboard early-return", () => {
    const source = fs.readFileSync(scriptPath, "utf8");
    const start = source.indexOf('if (location.hostname === "rewards.bing.com") {');
    const end = source.indexOf("// ====== 后台模式入口 ======");
    assert.ok(start > 0 && end > start, "front-end rewards block not located");
    const block = source.slice(start, end);
    // dashboard 分支会在 init() 之前 return：前台块必须自带日期初始化，
    // 否则 clickPunchCards 以 dateNowNum=0 读写打卡状态键（与其他页面日期错位）
    assert.match(block, /RewardsAuto\.state\.dateNowNum = Utils\.getTodayNum\(\);/);
    assert.match(block, /RewardsAuto\.state\.dateNowStr = Utils\.getTodayStr\(\);/);
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

// ====== v3.6.8：rewards.bing.com 前台同源转发通道 ======

test("rewards.bing.com requests ride the page channel when a live page heartbeats", async () => {
    let swCalls = 0;
    const gmXhr = o => { swCalls++; o.onload({ status: 200, responseText: "SW", responseHeaders: "" }); };
    const { Utils, storage } = createHarness({ "BingRewards_alive": { ts: Date.now() } }, { gmXhr });
    Utils.getRandomUUID = () => "req-fixed-0001"; // 固定转发请求 id，便于预置回包
    storage.set("BingRewards_resp", { id: "req-fixed-0001", ok: true, status: 200, text: "RSC:OK", headers: "x: y" });

    const body = await Utils.xhr({ method: "POST", url: "https://rewards.bing.com/dashboard", data: "[1]" });

    assert.equal(body, "RSC:OK");
    assert.equal(swCalls, 0, "channel hit must not issue an SW request");
    assert.equal(storage.get("BingRewards_req").url, "https://rewards.bing.com/dashboard");
});

test("page-channel non-2xx keeps acceptErrorBody / rejection semantics", async () => {
    const { Utils, storage } = createHarness({ "BingRewards_alive": { ts: Date.now() } });
    Utils.getRandomUUID = () => "req-fixed-0002";
    storage.set("BingRewards_resp", { id: "req-fixed-0002", ok: true, status: 500, text: "E80", headers: "" });
    const r = await Utils.xhr({ method: "POST", url: "https://rewards.bing.com/dashboard", acceptErrorBody: true });
    assert.equal(r.status, 500);
    assert.equal(r.body, "E80");

    Utils.getRandomUUID = () => "req-fixed-0003";
    storage.set("BingRewards_resp", { id: "req-fixed-0003", ok: true, status: 401, text: "", headers: "" });
    await assert.rejects(
        () => Utils.xhr({ method: "POST", url: "https://rewards.bing.com/dashboard" }),
        /HTTP 401/);
});

test("page execution failure falls back to the direct SW path", async () => {
    const calls = [];
    const gmXhr = o => { calls.push(o.url); o.onload({ status: 200, responseText: "SW-OK", responseHeaders: "" }); };
    const { Utils, storage } = createHarness({ "BingRewards_alive": { ts: Date.now() } }, { gmXhr });
    Utils.getRandomUUID = () => "req-fixed-0004";
    storage.set("BingRewards_resp", { id: "req-fixed-0004", ok: false, err: "CORS blocked" });

    const body = await Utils.xhr({ method: "POST", url: "https://rewards.bing.com/dashboard", data: "d" });

    assert.equal(body, "SW-OK");
    assert.deepEqual(calls, ["https://rewards.bing.com/dashboard"]);
});

test("without live page or tab capability the channel disables once and goes direct", async () => {
    const calls = [];
    const gmXhr = o => { calls.push(o.url); o.onload({ status: 200, responseText: "SW-OK", responseHeaders: "" }); };
    const { Utils, RewardsAuto } = createHarness({}, { gmXhr });
    // harness 的 GM_openInTab 返回 undefined：救援不可用 → 通道立即禁用，绝不挂 25 秒

    const body = await Utils.xhr({ url: "https://rewards.bing.com/earn" });

    assert.equal(body, "SW-OK");
    assert.equal(RewardsAuto._pageChannelOff, true);
    assert.equal(RewardsAuto._pageRescueUsed, true);
    await Utils.xhr({ url: "https://rewards.bing.com/earn" });
    assert.equal(calls.length, 2, "disabled channel: later requests go direct without retrying the tab");
});

test("www.bing.com requests are never routed through the page channel", async () => {
    const calls = [];
    const gmXhr = o => { calls.push(o.url); o.onload({ status: 200, responseText: "SW-OK", responseHeaders: "" }); };
    const { Utils } = createHarness({ "BingRewards_alive": { ts: Date.now() } }, { gmXhr });

    const body = await Utils.xhr({ url: "https://www.bing.com/search?q=abc" });

    assert.equal(body, "SW-OK");
    assert.equal(calls.length, 1);
});

test("front-end wires the proxy and gives bgprobe tabs a DOM-processing-free mode", () => {
    const source = fs.readFileSync(scriptPath, "utf8");
    // 页面侧：执行器带真实 cookie（fetch credentials:include / xhr withCredentials 已在
    // v3.6.9 执行器测试中断言），监听器把请求交给执行器执行并回包
    assert.match(source, /const pageProxyExecutor = \(\) => \{[\s\S]*?credentials: "include"/);
    assert.match(source, /GM_addValueChangeListener\("BingRewards_req"[\s\S]{0,1200}?await ex\.exec\(req\)/);
    // 通道挂在 rewards.bing.com 块最前，先于 dashboard 分支
    const rewards = source.indexOf('if (location.hostname === "rewards.bing.com") {');
    const dash = source.indexOf('if (location.hostname === "rewards.bing.com" && location.pathname === "/dashboard") {');
    assert.ok(rewards > 0 && rewards < dash);
    assert.match(source.slice(rewards, rewards + 120), /setupPageProxy\(\);/);
    assert.match(source.slice(dash, dash + 500), /location\.search\.includes\("bgprobe"\)/);
});

test("background detection uses hostname, not just typeof document (sandbox has document)", () => {
    const source = fs.readFileSync(scriptPath, "utf8");
    const fixed = '!/(^|\\.)bing\\.com$/.test(location.hostname || "");';
    assert.equal(source.split(fixed).length - 1, 2);
});

// ====== v3.6.13：页面注入标记与失联分诊 ======

test("page leaves an injection marker and the SW timeout message triages the cause", () => {
    const source = fs.readFileSync(scriptPath, "utf8");
    // 代理页挂载前先写注入标记（区分"未注入"与"注入但无心跳"）
    assert.match(source, /const setupPageProxy = \(\) => \{\s*[^}]*?GM_setValue\("BingRewards_injected"/);
    // 未就绪日志三分诊：心跳存在 / 注入标记新鲜 / 从未注入
    assert.ok(source.includes('"BingRewards_injected"'));
    assert.ok(source.includes("代理页从未被脚本注入"));
    assert.ok(source.includes("「前台运行/网页脚本」开关与站点权限"));
});

// ====== v3.6.15：诊断菜单只在页面上下文注册（后台注册是假阳性）======

test("the channel diagnostic menu is registered on rewards pages only, before any early-return", () => {
    const source = fs.readFileSync(scriptPath, "utf8");
    const rewards = source.indexOf('if (location.hostname === "rewards.bing.com") {');
    const dash = source.indexOf('if (location.hostname === "rewards.bing.com" && location.pathname === "/dashboard") {');
    assert.ok(rewards > 0 && dash > rewards);
    // 页面上下文注册（紧跟 setupPageProxy 之后），且全文件仅此一处
    const block = source.slice(rewards, dash);
    assert.match(block, /setupPageProxy\(\);[\s\S]{0,200}?GM_registerMenuCommand\("🔗 通道诊断（本页）"/);
    assert.equal(source.split('GM_registerMenuCommand("🔗 通道诊断（本页）"').length - 1, 1,
        "background-registered diagnostic gives a false 'injection OK' (v3.6.14 bug)");
    assert.match(block, /BingRewards_alive/);
});

// ====== v3.6.9：转发执行器多级回退 / 心跳带 mode / 授权码保留 ======

test("a mode:none heartbeat disables the channel instead of per-request timeouts", async () => {
    const calls = [];
    const gmXhr = o => { calls.push(o.url); o.onload({ status: 200, responseText: "SW-OK", responseHeaders: "" }); };
    const { Utils, storage } = createHarness({ "BingRewards_alive": { ts: Date.now(), mode: "none" } }, { gmXhr });

    const body = await Utils.xhr({ method: "POST", url: "https://rewards.bing.com/dashboard", data: "d" });

    assert.equal(body, "SW-OK");
    assert.equal(calls.length, 1);
    assert.equal(storage.get("BingRewards_req"), undefined, "no request may be forwarded to a dead executor");
});

test("non-fetch executor modes (xhr/uwfetch) still route through the page channel", async () => {
    const { Utils, storage } = createHarness({ "BingRewards_alive": { ts: Date.now(), mode: "xhr" } });
    Utils.getRandomUUID = () => "req-fixed-0005";
    storage.set("BingRewards_resp", { id: "req-fixed-0005", ok: true, status: 200, text: "RSC:XHR", headers: "" });

    const body = await Utils.xhr({ method: "POST", url: "https://rewards.bing.com/dashboard", data: "d" });

    assert.equal(body, "RSC:XHR");
});

test("page proxy executor falls back fetch→uw.fetch→XHR→uw.XHR and always heartbeats", () => {
    const source = fs.readFileSync(scriptPath, "utf8");
    assert.match(source, /const pageProxyExecutor = \(\) => \{[\s\S]*?typeof uw\.fetch === "function"[\s\S]*?typeof XMLHttpRequest === "function"[\s\S]*?typeof uw\.XMLHttpRequest === "function"[\s\S]*?return null;/);
    // 即使没有任何执行器也必须心跳上报 mode:"none"（后台据此立即禁用，不再干等 25s）
    assert.match(source, /mode: ex \? ex\.mode : "none"/);
    // XHR 通道带 cookie 的关键配置
    assert.match(source, /x\.withCredentials = true/);
});

// ====== v3.6.10：解除已死 legacy 签入接口对阅读的连坐 ======

test("sign 401 (dead legacy endpoint) no longer skips the read task", async () => {
    const d = new Date();
    const today = Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`);
    const { API, RewardsAuto, TaskManager, Utils } = createHarness({
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
    TaskManager.doSign = async () => { RewardsAuto.state.pc401 = true; return true; };
    TaskManager.doRead = async () => { readRan++; return true; };
    TaskManager.doPromos = async () => true;
    TaskManager.doSearch = async () => true;
    TaskManager.doStreak = async () => true;
    TaskManager.doDailySet = async () => true;
    TaskManager.doPunchCard = async () => true;
    TaskManager.doClaimPoints = async () => true;

    await TaskManager.runAll();

    assert.ok(readRan > 0, "read must run even after signPC 401s");
    assert.equal(RewardsAuto.state.pc401, true, "flag still recorded for diagnostics");
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
    Utils.xhr = async o => { posts.push(o); return "0:{}\n1:irrelevant-rsc"; };

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
        return "1:ok";
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
    const dyn = "1".repeat(40);
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

// ====== v3.6.12：入账延迟竞态修复 + x-deployment-id 指纹头 ======

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
    Utils.xhr = async o => { posts.push(o); return "1:ok"; };

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
