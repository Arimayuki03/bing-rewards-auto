// ==UserScript==
// @name         ScriptCat 注入测试
// @namespace    local.inject-test
// @version      1.0.0
// @description  验证 ScriptCat 是否向 rewards.bing.com 注入前台脚本（安装后打开 rewards 页面看顶部绿条）
// @match        https://rewards.bing.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    "use strict";
    const show = () => {
        try {
            const bar = document.createElement("div");
            bar.textContent = "✅ ScriptCat 注入测试：脚本已在本页执行（前台注入正常）";
            bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0a7d43;color:#fff;padding:10px 12px;font-size:15px;text-align:center;font-family:sans-serif";
            (document.body || document.documentElement).appendChild(bar);
            setTimeout(() => bar.remove(), 15000);
        } catch (_) {}
    };
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", show);
    } else {
        show();
    }
})();
