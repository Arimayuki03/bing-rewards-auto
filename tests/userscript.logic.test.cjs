const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const scriptPath = path.resolve(__dirname, "..", "微软积分商城签到（全能智能重构版）.user.js");

function createHarness(initialStorage = {}, { gmXhr, gmCookie, setTimeout: setTimeoutOverride } = {}) {
    const storage = new Map(Object.entries(initialStorage));
    const intervals = { set: [], cleared: [] };
    const openTabs = [];
    let source = fs.readFileSync(scriptPath, "utf8");
    const entryPattern = /\s*\/\/ ====== 后台模式入口 ======\s*\r?\n\s*init\(\);\s*\r?\n\s*\}\)\(\);/;
    assert.match(source, entryPattern, "test harness could not locate the userscript entry point");
    source = source.replace(entryPattern, `
    globalThis.__userscriptTest = { RewardsAuto, Utils, API, TaskManager, init };
})();`);

    const context = {
        URL,
        URLSearchParams,
        clearTimeout,        console: { debug() {}, error() {}, log() {} },
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
        setTimeout: setTimeoutOverride || setTimeout,
        // runAll 的运行锁心跳通过计时器实现；记录回调与周期供断言/手动触发使用
        setInterval: (fn, ms) => { intervals.set.push({ fn, ms }); return intervals.set.length; },
        clearInterval: (id) => { intervals.cleared.push(id); },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: scriptPath });
    return { ...context.__userscriptTest, storage, intervals, openTabs, setTimeoutOverride };
}

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

test("doPromos reminds once and closes the day without claiming (v4.5.0)", async () => {
    // 提醒模式：发现可领卡 → notifyClaimables 当日一次提醒 → promosDate 落账，
    // 不调用任何领取接口（claimCard 已退役，桩不存在即证明）。
    const { API, RewardsAuto, TaskManager, Utils, storage } = createHarness({ "Tasks.promos": true });
    RewardsAuto.state.dateNowNum = 20260731;
    Utils.randomDelay = async () => {};
    API.discoverCards = async () => [
        { offerId: "one", hash: "one", points: 1, kind: "daily", title: "卡一" },
        { offerId: "two", hash: "two", points: 1, kind: "daily", title: "卡二" },
    ];
    API.claimCard = async () => { throw new Error("claimCard must be retired in v4.5.0"); };

    const result = await TaskManager.doPromos();

    assert.equal(result, true);
    assert.equal(TaskManager.promosDate, 20260731, "提醒后当日落账，不再重试");
    const rec = storage.get("Config.claimNotify");
    assert.equal(rec.date, 20260731);
    assert.ok(rec.kinds["活动卡片"].includes("卡一") && rec.kinds["活动卡片"].includes("卡二"));
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
    // v4.3.0：_getMeInfo 入口判空——须配置有效 token 才能走到 DAPI /me 共享缓存路径
    RewardsAuto.state.token = "at-mock";
    RewardsAuto.state.dateNowNum = 20260810;
    let fetches = 0;
    Utils.xhr = async options => {
        fetches++;
        assert.ok(options.url.includes("prod.rewardsplatform.microsoft.com/dapi/me"));
        assert.equal(options.headers["x-rewards-country"], "cn");
        assert.equal(options.headers.authorization, "Bearer at-mock");
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

test("getReadProgress with no token sends no DAPI request and reports failure", async () => {
    // v4.3.0 判空守卫回归：state.token 非真值时 _getMeInfo 直接 return null，
    // 绝不能拼出 "Bearer false"/"Bearer null" 鉴权头发请求。
    const { API, RewardsAuto, Utils } = createHarness();
    RewardsAuto.state.dateNowNum = 20260810;
    const dapiUrls = [];
    Utils.xhr = async options => {
        if (String(options.url).includes("prod.rewardsplatform.microsoft.com")) {
            dapiUrls.push(options.url);
        }
        return "<html></html>";
    };

    assert.equal(await API.getReadProgress(), false, "无 token 时阅读进度走失败分支");
    assert.equal(dapiUrls.length, 0, "无 token 不得发出任何 DAPI /me 请求");
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

// v4.3.0 init 口径测试共用：TaskManager.init 与主脚本 init 均以 Utils.getTodayNum()
// 为"今天"基准，测试侧用同款计算避免硬编码日期跨日失效
function Utils_getTodayNumForInit() {
    const d = new Date();
    return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`);
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

test("getBalance({fresh:true}) bypasses the round cache (今日获取 was pinned at +0)", async () => {
    // runAll 轮末取数必须 fresh：缓存键绑定轮内恒定的 dateNowNum，
    // 不绕开的话首尾命中同一缓存、earned 恒为 0。
    // v4.3.0：_getMeInfo 入口判空——harness 须配置有效 token 才能走 DAPI 取数路径。
    let requests = 0;
    const balances = [4100, 4300];
    const { API, RewardsAuto, Utils } = createHarness();
    RewardsAuto.state.token = "at-mock";
    Utils.xhr = async options => {
        assert.ok(String(options.headers.authorization).startsWith("Bearer at-mock"),
            "DAPI /me 请求必须携带真实 Bearer 鉴权头");
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

test("getBalance without a token falls back to getuserinfo and sends no DAPI request", async () => {
    // v4.3.0 判空守卫：state.token 非真值时 _getMeInfo 直接 return null，
    // getBalance 落到 _getUserInfo 既有兜底——绝不能拼出 "Bearer null"/"Bearer false"。
    const dapiUrls = [];
    const { API, RewardsAuto, Utils } = createHarness();
    assert.ok(!RewardsAuto.state.token, "harness 默认无 token 前提成立");
    Utils.xhr = async options => {
        if (String(options.url).includes("prod.rewardsplatform.microsoft.com")) {
            dapiUrls.push(options.url);
        }
        return JSON.stringify({ dashboard: { availablePoints: 4260, dailySetPromotions: {}, userStatus: { counters: {} } } });
    };

    const balance = await API.getBalance();

    assert.equal(balance, 4260, "无 token 时走 getuserinfo 兜底取数");
    assert.equal(dapiUrls.length, 0, "无 token 不得发出任何 DAPI 请求");
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

test("doDailySet marks done when every item is already complete (no notify)", async () => {
    // 提醒模式：全部已完成 → 置当日判据、不提醒、不开标签页、零 Server Action。
    const { API, RewardsAuto, TaskManager, Utils, storage, openTabs } = createHarness();
    RewardsAuto.state.dateNowNum = 20260920;
    Utils.randomDelay = async () => {};
    API.getDailySetItems = async () => [
        { offerId: "DS1", complete: true, pointProgress: 30, pointProgressMax: 30 },
        { offerId: "DS2", complete: true, pointProgress: 30, pointProgressMax: 30 },
    ];

    const result = await TaskManager.doDailySet();

    assert.equal(result, true);
    assert.equal(storage.get("Config.dailySetDone"), 20260920);
    assert.ok(!storage.get("Config.claimNotify"), "全部完成时不得提醒");
    assert.equal(openTabs.length, 0, "提醒模式不得打开任何标签页");
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


test("doDailySet exits early when ladder0 App reports clear every pending item", async () => {
    // 空清单早退的第二条汇合路径：阶梯0 App 上报把全部 pending 项出列后，
    // 网页阶梯（含 _extractDailySetHashes）不得再执行，已入账 offer 的链接不得再开。
    const { API, RewardsAuto, TaskManager, Utils, storage, openTabs } = createHarness();
    RewardsAuto.state.dateNowNum = 20260920;
    Utils.randomDelay = async () => {};
    RewardsAuto.state.token = "at-mock";
    const offerId = "Gamification_DailySet_Test_Child1";
    API.getDailySetItems = async () => [{ offerId, complete: false, url: "https://cn.bing.com/x?rnoreward=1" }];
    API.appActivity = async () => ({ points: 10, isDuplicate: false, balance: 4260 }); // 全部入账出列
    let hashesCalled = 0;
    TaskManager._extractDailySetHashes = async () => { hashesCalled++; return []; };
    const posts = [];
    Utils.xhr = async options => {
        if (options.method === "POST") posts.push(options);
        return "1:true";
    };

    const result = await TaskManager.doDailySet();

    assert.equal(result, true);
    assert.equal(hashesCalled, 0, "全部出列后不得再触发网页 hash 提取");
    assert.equal(posts.length, 0, "全部出列后不得再发 Server Action POST");
    assert.equal(openTabs.length, 0, "已入账 offer 的链接不得再开标签页");
    assert.equal(storage.get("Config.dailySetDone"), 20260920);
});

// ====== v4.3.0：dailySetFail 当日放弃上限（{date, count} 结构，次日自动恢复） ======


test("doDailySet gives up for the day after DAILY_SET_GIVE_UP_AFTER consecutive failures", async () => {
    // 同日第 5 次失败落账后，入口放弃门直接返回 true 且零请求；不伪造 dailySetDone。
    // 失败轮用真实形态构造：待办项 Server Action 500（非边缘拦截）+ 复查仍未完成
    // （getDailySetItems 返回 [] 会命中空清单早退，不能当失败轮）。
    const { API, RewardsAuto, TaskManager, Utils, storage } = createHarness();
    RewardsAuto.state.dateNowNum = 20260920;
    Utils.randomDelay = async () => {};
    API.getDailySetItems = async () => [{ offerId: "DS_stuck", complete: false }];
    TaskManager._extractDailySetHashes = async () => [{ offerId: "DS_stuck", hash: "a".repeat(40) }];
    API._resolveReportActivityActionId = async () => "f".repeat(42);
    Utils.xhr = async () => { throw new Error('HTTP 500: 1:E{"digest":"D"}'); };

    // 前 4 次：未达上限（5），正常执行并返回 false
    for (let i = 0; i < 4; i++) {
        assert.equal(await TaskManager.doDailySet(), false);
        assert.notEqual(storage.get("Config.dailySetDone"), 20260920);
    }

    // 第 5 次失败落账（5 ≥ 上限）→ 次轮入口放弃门当日放弃
    storage.set("Config.dailySetFail", { date: 20260920, count: 5 });
    const requests = [];
    Utils.xhr = async options => { requests.push(options); return "<html></html>"; };
    const result = await TaskManager.doDailySet();

    assert.equal(result, true, "达上限后当日放弃必须返回 true（对齐 promos 放弃语义）");
    assert.equal(requests.length, 0, "放弃轮必须零请求");
    assert.notEqual(storage.get("Config.dailySetDone"), 20260920, "放弃不得伪造当日完成标记");
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


test("_sendDailySetAction flags edge block on the 503+HTML resolve path and doDailySet short-circuits", async () => {
    // acceptErrorBody 下 503+Bing 错误页走 resolve（非 catch）——必须合成
    // "HTTP <status>: <body>" 后判 isEdgeBlockedError，检出置本轮标记；
    // doDailySet 跳过剩余 pending 项（总请求数不随 pending 数增长）并返回 false。
    const { API, RewardsAuto, TaskManager, Utils } = createHarness();
    RewardsAuto.state.dateNowNum = 20260920;
    Utils.randomDelay = async () => {};
    const offerIds = ["DS_A", "DS_B", "DS_C"];
    API.getDailySetItems = async () => offerIds.map(id => ({ offerId: id, complete: false }));
    TaskManager._extractDailySetHashes = async () => offerIds.map(id => ({ offerId: id, hash: "a".repeat(40) }));
    API._resolveReportActivityActionId = async () => "f".repeat(42);
    const posts = [];
    Utils.xhr = async options => {
        if (options.method === "POST") {
            posts.push(options);
            return { status: 503, body: '<!DOCTYPE html><html xml:lang="en"><head><title>Bing</title></head></html>' };
        }
        return "<html></html>";
    };

    const result = await TaskManager.doDailySet();

    assert.equal(RewardsAuto.state.dailySetEdgeBlocked, true, "503+HTML resolve 路径必须置本轮边缘拦截标记");
    assert.equal(posts.length, 1, `检出拦截后必须跳过剩余 ${offerIds.length - 1} 项，总请求数不随 pending 数增长`);
    assert.equal(JSON.parse(posts[0].data)[2].offerid, "DS_A");
    assert.equal(result, false, "拦截轮不得复查/落账，返回 false 交由 runAll 计入失败账本");
});


test("non-edge failures (500) keep trying every pending item without short-circuiting", async () => {
    // 500（非边缘拦截）不得触发短路：逐项尝试的旧行为保持不变。
    const { API, RewardsAuto, TaskManager, Utils } = createHarness();
    RewardsAuto.state.dateNowNum = 20260920;
    Utils.randomDelay = async () => {};
    const offerIds = ["DS_A", "DS_B", "DS_C"];
    API.getDailySetItems = async () => offerIds.map(id => ({ offerId: id, complete: false }));
    TaskManager._extractDailySetHashes = async () => offerIds.map(id => ({ offerId: id, hash: "a".repeat(40) }));
    API._resolveReportActivityActionId = async () => "f".repeat(42);
    const posts = [];
    Utils.xhr = async options => {
        if (options.method === "POST") {
            posts.push(options);
            return { status: 500, body: '1:E{"digest":"D"}' };
        }
        return "<html></html>";
    };

    await TaskManager.doDailySet();

    assert.equal(RewardsAuto.state.dailySetEdgeBlocked, false, "500 不是边缘拦截，不得置标记");
    assert.equal(posts.length, offerIds.length, "非拦截失败必须逐项尝试（每项 context 形状 1 次）");
});

// ====== v4.4.0：边缘拦截日开页代领编排（抓包真值 2026-09-26）======


test("doDailySet does not fake completion when getDailySetItems returns an empty array", async () => {
    // 空清单（getuserinfo 退役后数据源降级形态）→ 返回 false 待下轮重试，不得假标完成。
    const { API, RewardsAuto, TaskManager, Utils, storage, openTabs } = createHarness();
    RewardsAuto.state.dateNowNum = 20260920;
    Utils.randomDelay = async () => {};
    API.getDailySetItems = async () => [];

    const result = await TaskManager.doDailySet();

    assert.equal(result, false, "空清单必须返回 false 待下轮重试");
    assert.notEqual(storage.get("Config.dailySetDone"), 20260920, "空清单不得假标当日完成");
    assert.equal(openTabs.length, 0);
});

test("doPromos closes the day normally when no cards remain at all", async () => {
    // 无卡片（扫描成功但全部完成/出列）→ 原收账路径不受影响，零开页。
    const { API, RewardsAuto, TaskManager, Utils, openTabs } = createHarness();
    RewardsAuto.state.dateNowNum = 20260926;
    Utils.randomDelay = async () => {};
    API.discoverCards = async () => [];

    const result = await TaskManager.doPromos();

    assert.equal(result, true);
    assert.equal(openTabs.length, 0);
    assert.equal(TaskManager.promosDate, 20260926);
});

// ====== v4.4.2：边缘拦截开页检查前移（v4.4.1 日志实证的短路缺口）======

test("renewToken refreshes the token when any DAPI consumer task is enabled", async () => {
    // 四开关任一开启 → 正常续期（覆盖 sign/read/promos/search 各单独开启的组合）。
    for (const onlyTask of ["Tasks.sign", "Tasks.read", "Tasks.promos", "Tasks.search"]) {
        const initialStorage = {
            "Tasks.sign": false, "Tasks.read": false, "Tasks.promos": false, "Tasks.search": false,
            [onlyTask]: true,
            "Config.token": "refresh-value",
        };
        const { API, Utils, storage } = createHarness(initialStorage);
        const posts = [];
        Utils.xhr = async options => {
            posts.push(options);
            return JSON.stringify({ refresh_token: "new-refresh", access_token: "access" });
        };

        assert.equal(await API.renewToken(), true, `${onlyTask} 开启时必须续期`);
        assert.equal(posts.length, 1, "应发出一次 refresh_token 续期请求");
        assert.equal(storage.get("Config.token"), "new-refresh");
    }
});

test("renewToken returns false with zero requests when all DAPI consumer tasks are off", async () => {
    // v4.3.0：四开关全关 → 跳过续期并返回 false，不再假成功 true。
    const { API, Utils, storage } = createHarness({
        "Tasks.sign": false, "Tasks.read": false, "Tasks.promos": false, "Tasks.search": false,
        "Config.token": "refresh-value",
    });
    let requests = 0;
    Utils.xhr = async () => { requests++; return "{}"; };

    assert.equal(await API.renewToken(), false, "无消费方开启时返回 false（不再假成功）");
    assert.equal(requests, 0, "零续期请求");
    assert.equal(storage.get("Config.token"), "refresh-value", "存储的 refresh_token 不得被误清");
});

test("withTokenRetry returns null without a second request when renewal leaves no token (never Bearer null)", async () => {
    // 核心回归点：401 续期后 state.token 仍为空 → 直接返回 null，
    // 全部打桩请求中绝不出现 "Bearer null"/"Bearer false" 鉴权头。
    const seenAuth = [];
    const { API, RewardsAuto, Utils } = createHarness({ "Config.token": "refresh-value" });
    RewardsAuto.state.token = "expired-access";
    API.renewToken = async () => {
        // 模拟"续期流程走完但 token 仍空"（如授权码获取失败）
        RewardsAuto.state.token = null;
        return true;
    };
    Utils.xhr = async options => {
        seenAuth.push(options.headers && options.headers.authorization);
        return JSON.stringify({ response: { balance: 1 } });
    };

    const result = await API.withTokenRetry(async token => {
        // requestFn 本身不该被第二次调用；首次调用收到过期 token 后抛 401
        assert.equal(token, "expired-access");
        throw new Error("HTTP 401");
    });

    assert.equal(result, null, "续期后 token 仍空必须返回 null");
    assert.equal(seenAuth.length, 0, "不得带着空 token 发出第二次请求");
});

// ====== v4.4.3：设置面板粘贴授权码保存链路修复 ======

test("parseAuthCode accepts every paste shape users actually produce", () => {
    const { Utils } = createHarness();
    const code = "M.C5x5_BAY.0.-AeypQ2ZlU-EyI-XXX-long-token-value";
    // 完整跳转 URL
    assert.equal(Utils.parseAuthCode(`https://login.live.com/oauth20_desktop.srf?code=${code}&lc=2052`).code, code);
    // URL 前后带杂散文本/换行（设置面板常见误粘）——URL 构造失败落正则提取
    assert.equal(Utils.parseAuthCode(`已复制\nhttps://login.live.com/oauth20_desktop.srf?code=${code}\n请粘贴`).code, code, "前后杂散文本必须被剥净");
    // 字面 "\n" 转义序列（部分面板序列化产物）同样截断
    assert.equal(Utils.parseAuthCode(`https://login.live.com/oauth20_desktop.srf?code=${code}\\nlc=2052`).code, code, "字面反斜杠n必须被截断");
    // fragment 形态（#code=）
    assert.equal(Utils.parseAuthCode(`https://login.live.com/oauth20_desktop.srf#code=${code}`).code, code);
    // URL 编码的 code
    assert.equal(Utils.parseAuthCode(`https://login.live.com/oauth20_desktop.srf?code=${encodeURIComponent(code)}`).code, code);
    // 仅粘贴 code 值
    assert.equal(Utils.parseAuthCode(`  ${code}  `).code, code);
    // 无效形态一律拒绝
    assert.equal(Utils.parseAuthCode(""), null);
    assert.equal(Utils.parseAuthCode(null), null);
    assert.equal(Utils.parseAuthCode("https://example.com/without-code"), null);
    assert.equal(Utils.parseAuthCode("short"), null);
    assert.equal(Utils.parseAuthCode("一段没有任何URL或code特征的中文说明文字"), null);
});

test("fetchCode keeps an already-saved code and does not pre-clear Config.code", async () => {
    // v4.4.3 核心：已保存的授权码必须被直接使用，且任何路径不得在消费前清空它。
    // 走 renewToken 真实链路：无 token（跳过 refresh 分支）→ fetchCode 命中已存值
    // → 换取成功 → 条件清理。
    const code = "M.C5x5_BAY.0.-AeypQ2ZlU-EyI-XXX-long-token-value";
    const posts = [];
    const { API, Utils, storage } = createHarness({
        "Config.code": `https://login.live.com/oauth20_desktop.srf?code=${code}&lc=2052`,
    });
    Utils.delay = async () => {};
    Utils.xhr = async options => {
        posts.push(options);
        if (String(options.url).includes("oauth20_token.srf")) {
            return JSON.stringify({ refresh_token: "new-refresh", access_token: "new-access" });
        }
        return "{}";
    };

    assert.equal(await API.renewToken(), true, "已保存授权码必须直接完成换取");
    assert.equal(storage.get("Config.token"), "new-refresh");
    assert.equal(storage.get("Config.code"), "", "消费成功后清理明文残留");
    const body = new URLSearchParams(posts.find(p => String(p.url).includes("oauth20_token.srf")).data);
    assert.equal(body.get("code"), code, "换取请求必须使用粘贴的授权码");
});

test("token refresh failure keeps the pasted Config.code (no unconditional wipe)", async () => {
    // 失败路径回归：refresh_token 失效（invalid_grant）不得抹掉用户刚粘贴的授权码。
    const { API, Utils, storage } = createHarness({
        "Config.token": "dead-refresh",
        "Config.code": "M.C5x5_BAY.0.-AeypQ2ZlU-EyI-XXX-long-token-value",
    });
    Utils.delay = async () => {};
    Utils.xhr = async options => {
        if (String(options.url).includes("oauth20_token.srf")) {
            return JSON.stringify({ error: "invalid_grant", error_description: "token expired" });
        }
        // 授权页自动获取等其余请求一律失败（后台无登录态）
        throw new Error("HTTP 403");
    };

    assert.equal(await API.renewToken(), false, "refresh 与授权码均不可用时返回失败");
    assert.equal(storage.get("Config.code"), "M.C5x5_BAY.0.-AeypQ2ZlU-EyI-XXX-long-token-value", "失败路径不得清空已保存的授权码");
    assert.equal(storage.get("Config.token"), false, "失效 token 必须被清");
});

test("successful exchange does not wipe a re-pasted newer Config.code", async () => {
    // 条件清理回归：换取期间用户重新粘贴了新值（存储值 ≠ 本轮消费值）→ 不得清除。
    const code = "M.C5x5_BAY.0.-AeypQ2ZlU-EyI-XXX-long-token-value";
    const { API, Utils, storage } = createHarness({ "Config.code": code });
    Utils.delay = async () => {};
    Utils.xhr = async options => {
        if (String(options.url).includes("oauth20_token.srf")) {
            // 换取请求在途时模拟用户重新粘贴新授权码
            storage.set("Config.code", "M.C5x5_BAY.0.-BRAND-NEW-CODE-pasted-during-exchange");
            return JSON.stringify({ refresh_token: "new-refresh", access_token: "new-access" });
        }
        return "{}";
    };

    assert.equal(await API.renewToken(), true);
    assert.equal(storage.get("Config.code"), "M.C5x5_BAY.0.-BRAND-NEW-CODE-pasted-during-exchange", "重粘贴的新值不得被旧轮次清理抹掉");
    assert.equal(storage.get("Config.token"), "new-refresh");
});

test("no stubbed DAPI request ever carries a falsy Bearer header across the retry ladder", async () => {
    // 与上一条互补：走真实 _dapiRequest 链路（renewToken mock 为失败，避免真实
    // 授权码流程阻塞 90 秒），401 → 续期失败 → 无第二次请求；全链路鉴权头逐个体检。
    const seenAuth = [];
    const { API, RewardsAuto, Utils } = createHarness({ "Config.token": "refresh-value" });
    RewardsAuto.state.token = "expired-access";
    API.renewToken = async () => false;
    Utils.xhr = async options => {
        seenAuth.push(options.headers && options.headers.authorization);
        if (String(options.url).includes("prod.rewardsplatform.microsoft.com")) {
            throw new Error("HTTP 401");
        }
        return "{}";
    };

    const result = await API._dapiRequest({ body: { probe: 1 } });

    assert.equal(result, null, "续期失败后必须返回 null");
    assert.equal(seenAuth.length, 1, "只应有首次（过期 token）请求，不得二次重试");
    assert.equal(seenAuth[0], "Bearer expired-access");
    for (const auth of seenAuth) {
        assert.notEqual(auth, "Bearer null", "鉴权头不得为 Bearer null");
        assert.notEqual(auth, "Bearer false", "鉴权头不得为 Bearer false");
        assert.notEqual(auth, "Bearer undefined", "鉴权头不得为 Bearer undefined");
        assert.ok(/^Bearer \S+$/.test(String(auth)), `鉴权头必须携带非空 token，实际: ${auth}`);
    }
});

test("_dapiRequest entry guard sends nothing when the token is falsy (no Bearer false)", async () => {
    // v4.3.0：_dapiRequest 入口判空——token 非真值时不发请求直接返回 null，
    // 消灭历史 "Bearer false"/"Bearer null" 鉴权头。
    const { API, RewardsAuto, Utils } = createHarness();
    RewardsAuto.state.token = null;
    let requests = 0;
    Utils.xhr = async () => { requests++; return "{}"; };

    assert.equal(await API._dapiRequest({ body: { probe: 1 } }), null);
    assert.equal(await API._dapiRequest({ body: { probe: 1 }, region: "cn" }), null);
    assert.equal(requests, 0, "空 token 不得发出任何 DAPI 请求");

    // 交叉验证：token 存在时同一入口正常发请求并携带 Bearer 头
    RewardsAuto.state.token = "valid-token";
    const seen = [];
    Utils.xhr = async options => { seen.push(options.headers.authorization); return "{}"; };
    await API._dapiRequest({ body: { probe: 1 } });
    assert.deepEqual(seen, ["Bearer valid-token"]);
});

// ====== v4.3.0：init 的 isAllDone 口径补 punchCardBgDone ======

// ====== v4.5.0：提醒模式核心行为 ======

test("notifyClaimables fires once per day per kind and resets the next day", async () => {
    const { RewardsAuto, TaskManager, Utils, storage } = createHarness();
    RewardsAuto.state.dateNowNum = 20260927;
    Utils.randomDelay = async () => {};
    const items = [{ title: "卡A", points: 15, offerId: "A" }];

    assert.equal(await TaskManager.notifyClaimables("活动卡片", items), true, "当日首次必须提醒");
    assert.equal(await TaskManager.notifyClaimables("活动卡片", items), false, "同日同类目不得重复提醒");
    assert.equal(await TaskManager.notifyClaimables("每日活动", items), true, "不同类目独立提醒");
    // 次日重置
    RewardsAuto.state.dateNowNum = 20260928;
    assert.equal(await TaskManager.notifyClaimables("活动卡片", items), true, "次日账本重置后重新提醒");
    assert.equal(storage.get("Config.claimNotify").date, 20260928);
});

test("notifyClaimables ignores empty lists and truncates long item lists", async () => {
    const { RewardsAuto, TaskManager, Utils } = createHarness();
    RewardsAuto.state.dateNowNum = 20260927;
    Utils.randomDelay = async () => {};

    assert.equal(await TaskManager.notifyClaimables("活动卡片", []), false);
    assert.equal(await TaskManager.notifyClaimables("活动卡片", null), false);

    const many = Array.from({ length: 30 }, (_, i) => ({ title: `卡${i}`, points: 1 }));
    assert.equal(await TaskManager.notifyClaimables("每日活动", many), true);
});

test("doClaimPoints reminds instead of claiming when pending points exist (v4.5.0)", async () => {
    const { RewardsAuto, TaskManager, Utils, storage } = createHarness();
    RewardsAuto.state.dateNowNum = 20260927;
    Utils.randomDelay = async () => {};
    const dash = '<img alt="可领取"> 1,234';
    const seenUrls = [];
    Utils.xhr = async options => {
        seenUrls.push(String(options.url));
        return String(options.url).includes("dashboard") ? dash : "";
    };

    await TaskManager.doClaimPoints();

    const rec = storage.get("Config.claimNotify");
    assert.ok(rec && rec.kinds["欢迎积分"] && rec.kinds["欢迎积分"].includes("1234"),
        `必须提醒可领积分；实际 urls=${JSON.stringify(seenUrls)}，storage=${JSON.stringify(storage.get("Config.claimNotify"))}`);
    assert.deepEqual(seenUrls, ["https://rewards.bing.com/dashboard"], "仅一次 dashboard 检测，零领取请求");
});

test("second scan claims daily-set cards via App channel, never claimCard (v4.5.1)", async () => {
    // v4.5.1：claimCard 已随活动卡自动领取退役。二次扫描若调用它必然 TypeError
    //（函数已不存在），此用例同时锁定：①不再调用 claimCard；②每日活动卡改走
    // DAPI App 通道，判据与主路径一致（p:0 + isDuplicate:false 不算入账）。
    // 经由 runAll 全链路（init 会重置日期，故以真实当天为基准）。
    const d = new Date();
    const today = Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`);
    const { API, RewardsAuto, TaskManager, Utils } = createHarness();
    Utils.randomDelay = async () => {};
    Utils.delay = async () => {};
    RewardsAuto.state.token = "at-mock";
    API.discoverCards = async () => [
        { offerId: "Gamification_DailySet_Test_Child9", kind: "daily", title: "每日卡", points: 10, hash: "h9" },
        { offerId: "Gamification_Punch_Test", kind: "punch", title: "非每日卡", points: 5, hash: "h5" },
    ];
    // claimCard 已退役：桩不存在，任何调用都会抛 TypeError（老代码此处直接崩）
    assert.equal(API.claimCard, undefined, "claimCard 必须已从脚本中退役");
    const appCalls = [];
    API.appActivity = async (type, offerId, useToken) => {
        appCalls.push({ type, offerId, useToken });
        return offerId.endsWith("Child9") ? { points: 10, isDuplicate: false } : { points: 0, isDuplicate: false };
    };
    // 前置任务全部桩为秒过，只让二次扫描块真正执行；不关 Tasks.* 开关
    //（Config.tasks 为空 → signDate=0 ≠ today → _isIdle()=false，空闲门不拦）。
    API.checkRegion = async () => true;
    API.renewToken = async () => true;
    API.getBalance = async () => ({ points: 4260 });
    TaskManager.doSign = async () => true;
    TaskManager.doRead = async () => true;
    TaskManager.doPromos = async () => true;
    TaskManager.doSearch = async () => true;
    TaskManager.doStreak = async () => true;
    TaskManager.doDailySet = async () => true;
    TaskManager.doPunchCard = async () => true;
    TaskManager.doClaimPoints = async () => {};

    await TaskManager.runAll();

    assert.deepEqual(appCalls, [
        { type: 101, offerId: "Gamification_DailySet_Test_Child9", useToken: true },
    ], "二次扫描必须经 DAPI App 通道领取每日活动卡，且跳过非每日卡与 p:0 静默吸收");
});

test("init keeps scheduling runAll when only the punch card is incomplete (keep=false)", () => {
    // 四任务 + 每日活动全完成、打卡未完成（punchCardBgDone 非当日）→ 不得短路，
    // runAll 仍被随机延迟调度（否则当日剩余 tick 零调度）。
    const today = Utils_getTodayNumForInit();
    const scheduled = [];
    const { TaskManager, init } = createHarness({
        "Config.keep": false,
        "Config.tasks": { sign: today, read: today, promos: today, search: today, streakDays: 0 },
        "Config.dailySetDone": today,
        // punchCardBgDone 故意缺省（非当日）
        "Config.searchProgressDate": 1,
    }, {
        setTimeout: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
    });
    TaskManager.signDate = today;
    TaskManager.readDate = today;
    TaskManager.promosDate = today;
    TaskManager.searchDate = today;

    init();

    assert.equal(scheduled.length, 1, "打卡未完成时不得短路，runAll 必须被调度");
    assert.ok(scheduled[0].ms >= 2000, "后台随机延迟语义保持");
});

test("init short-circuits without scheduling when everything including the punch card is done (keep=false)", () => {
    const today = Utils_getTodayNumForInit();
    const scheduled = [];
    const { TaskManager, init } = createHarness({
        "Config.keep": false,
        "Config.tasks": { sign: today, read: today, promos: today, search: today, streakDays: 0 },
        "Config.dailySetDone": today,
        "Config.punchCardBgDone": today,
        "Config.searchProgressDate": 1,
    }, {
        setTimeout: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
    });
    TaskManager.signDate = today;
    TaskManager.readDate = today;
    TaskManager.promosDate = today;
    TaskManager.searchDate = today;

    init();

    assert.equal(scheduled.length, 0, "全部完成（含打卡当日）必须短路，零调度");
});
