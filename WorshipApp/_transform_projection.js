const fs = require("fs");
const path = require("path");

const rootDir = __dirname;
const leaderSrc = fs.readFileSync(path.join(rootDir, "_extract_leader.txt"), "utf8");
const displaySrc = fs.readFileSync(path.join(rootDir, "_extract_display.txt"), "utf8");

function dedent(lines, spaces) {
    const prefix = " ".repeat(spaces);
    return lines.map((line) => (line.startsWith(prefix) ? line.slice(spaces) : line));
}

function transformBody(src, spaces) {
    let lines = src.split(/\r?\n/);
    lines = dedent(lines, spaces);
    let text = lines.join("\n");
    text = text.replace(/\$\("/g, 'document.getElementById("');
    text = text.replace(/\$\('/g, "document.getElementById('");
    text = text.replace(/\bprojectionMode\b/g, "globalThis.projectionMode");
    text = text.replace(/\bprojectionRaf\b/g, "globalThis.projectionRaf");
    text = text.replace(/\bprojectionLastTs\b/g, "globalThis.projectionLastTs");
    text = text.replace(/\bprojectionCtx\b/g, "globalThis.projectionCtx");
    text = text.replace(/\bprojectionCanvas\b/g, "globalThis.projectionCanvas");
    text = text.replace(/\bprojectionBgImage\b/g, "globalThis.projectionBgImage");
    text = text.replace(/\bprojectionParticles\b/g, "globalThis.projectionParticles");
    text = text.replace(/\bchannel\b/g, "globalThis.__projectionChannel");
    text = text.replace(/\bliveState\b/g, "globalThis.liveState");
    text = text.replace(/\bSTORAGE\.LIVE\b/g, '"worship.live.v5"');
    text = text.replace(/\binstallProjectionUI\b/g, "globalThis.installProjectionUI");
    text = text.replace(/\bapplyLive\b/g, "globalThis.applyLive");
    text = text.replace(/\brestartBg\b/g, "globalThis.restartBg");
    text = text.replace(/\bupdateDisplayCardPreview\b/g, "globalThis.updateDisplayCardPreview");
    text = text.replace(/\bapplyBackgroundMode\b/g, "globalThis.applyBackgroundMode");
    text = text.replace(/\brenderLeaderLyric\b/g, "globalThis.renderLeaderLyric");
    text = text.replace(/\brenderDisplayLyric\b/g, "globalThis.renderDisplayLyric");
    text = text.replace(/\bensureProjectionCssBg\b/g, "globalThis.ensureProjectionCssBg");
    text = text.replace(/\bremoveProjectionCssBg\b/g, "globalThis.removeProjectionCssBg");
    text = text.replace(/\bensureProjectionCanvas\b/g, "globalThis.ensureProjectionCanvas");
    text = text.replace(/\bcreateAmbientParticles\b/g, "globalThis.createAmbientParticles");
    text = text.replace(/\brollParticleTint\b/g, "globalThis.rollParticleTint");
    text = text.replace(/\bapplyParticleShadow\b/g, "globalThis.applyParticleShadow");
    text = text.replace(/\bapplyParticleFill\b/g, "globalThis.applyParticleFill");
    text = text.replace(/\bdrawParticles\b/g, "globalThis.drawParticles");
    text = text.replace(/\bdrawBg\b/g, "globalThis.drawBg");
    text = text.replace(/\bescapeHtml\b/g, "globalThis.escapeHtml");
    text = text.replace(/\bgetStore\b/g, "globalThis.getStore");
    text = text.replace(/\bsetStore\b/g, "globalThis.setStore");
    text = text.replace(/\bparseJSON\b/g, "globalThis.parseJSON");
    text = text.replace(/\bclamp\b/g, "globalThis.clamp");
    text = text.replace(/\bsplitPages\b/g, "globalThis.parsePages");
    text = text.replace(/\bstate\.songs\b/g, "globalThis.songs");
    text = text.replace(/\bstate\.currentSongId\b/g, "globalThis.currentSongId");
    text = text.replace(/\bstate\.currentPage\b/g, "globalThis.currentPageIndex");
    text = text.replace(/\bstate\.ui\b/g, "globalThis.__projectionUi");
    text = text.replace(/\bstate\.playlist\b/g, "globalThis.__projectionPlaylist");
    text = text.replace(/\bstate\.sizePreset\b/g, "globalThis.__projectionSizePreset");
    text = text.replace(/\bstate\.autoplay\b/g, "globalThis.__projectionAutoplay");
    text = text.replace(/function globalThis\.(\w+)\s*\(/g, "function $1(");
    return text;
}

const displayBody = transformBody(displaySrc, 4)
    .replace(/^function initDisplayMode\(\) \{\r?\n/, "")
    .replace(/\}\s*$/, "");
const leaderBody = transformBody(leaderSrc, 4);

const header = `
/* --- 自 app.js 迁移：投屏 / 主领（依赖 globalThis 上的协作 API，勿与 app.js 同时双开同一角色） --- */
globalThis.__projectionUi = globalThis.__projectionUi || {
    theme: "dark",
    fontFamily: "'Microsoft YaHei','PingFang SC',sans-serif",
    fontSize: 56,
    defaultLines: 4,
    posY: 45,
    bgType: "solid-black",
    bgImage: "",
    bgImageId: "",
    lyricsBgShareToCloud: false,
    fontColor: "#ffffff",
    bgMediaType: "image"
};
globalThis.__projectionPlaylist = globalThis.__projectionPlaylist || {
    items: [],
    running: false,
    activeIndex: -1,
    fadeNext: false,
    autoSwitch: false
};
globalThis.__projectionSizePreset = globalThis.__projectionSizePreset || "M";
globalThis.__projectionAutoplay = globalThis.__projectionAutoplay || {
    timer: null,
    progressTimer: null,
    running: false,
    elapsed: 0
};
globalThis.songs = globalThis.songs || (globalThis.AppState && globalThis.AppState.songs) || [];
globalThis.currentSongId =
    globalThis.currentSongId !== undefined && globalThis.currentSongId !== null
        ? globalThis.currentSongId
        : globalThis.AppState && globalThis.AppState.currentSongId;
globalThis.currentPages = globalThis.currentPages || [];
globalThis.currentPageIndex = Number.isFinite(Number(globalThis.currentPageIndex))
    ? globalThis.currentPageIndex
    : 0;
globalThis.parseJSON =
    globalThis.parseJSON ||
    function (raw, fallback) {
        try {
            return raw ? JSON.parse(raw) : fallback;
        } catch (_e) {
            return fallback;
        }
    };
globalThis.clamp =
    globalThis.clamp ||
    function (v, min, max) {
        return Math.max(min, Math.min(max, Number(v) || 0));
    };
globalThis.escapeHtml =
    globalThis.escapeHtml ||
    function (text) {
        return String(text ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    };
globalThis.getStore =
    globalThis.getStore ||
    function (key, fallback) {
        return globalThis.parseJSON(localStorage.getItem(key), fallback);
    };
globalThis.setStore =
    globalThis.setStore ||
    function (key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (_e) {
            /* ignore */
        }
    };
globalThis.__projectionChannel =
    globalThis.__projectionChannel ||
    (typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("worship_channel") : null);
`;

const installSrc = fs
    .readFileSync(path.join(rootDir, "app.js"), "utf8")
    .split(/\r?\n/)
    .slice(2233, 2286)
    .join("\n");
const installBody = transformBody(installSrc, 4)
    .replace(/^function installProjectionUI\(mode\) \{\r?\n/, "")
    .replace(/\}$/, "");

const applyLiveSrc = fs
    .readFileSync(path.join(rootDir, "app.js"), "utf8")
    .split(/\r?\n/)
    .slice(2507, 2518)
    .join("\n");
const applyLiveBody = transformBody(applyLiveSrc, 4)
    .replace(/^function applyLive\(mode, payload\) \{\r?\n/, "")
    .replace(/\}$/, "");

const renderDisplaySrc = fs
    .readFileSync(path.join(rootDir, "app.js"), "utf8")
    .split(/\r?\n/)
    .slice(2441, 2461)
    .join("\n");
const renderDisplayBody = transformBody(renderDisplaySrc, 4)
    .replace(/globalThis.__projectionUi \|\| state\.ui\.fontFamily/g, "globalThis.__projectionUi")
    .replace(/^function renderDisplayLyric\(\) \{\r?\n/, "")
    .replace(/\}\s*$/, "");

const renderLeaderSrc = fs
    .readFileSync(path.join(rootDir, "app.js"), "utf8")
    .split(/\r?\n/)
    .slice(2462, 2485)
    .join("\n");
const renderLeaderBody = transformBody(renderLeaderSrc, 4)
    .replace(/^function renderLeaderLyric\(\) \{\r?\n/, "")
    .replace(/\}\s*$/, "");

const updateCardSrc = fs
    .readFileSync(path.join(rootDir, "app.js"), "utf8")
    .split(/\r?\n/)
    .slice(2486, 2506)
    .join("\n");
const updateCardBody = transformBody(updateCardSrc, 4)
    .replace(/^function updateDisplayCardPreview\(\) \{\r?\n/, "")
    .replace(/\}\s*$/, "");

const drawBgSrc = fs
    .readFileSync(path.join(rootDir, "app.js"), "utf8")
    .split(/\r?\n/)
    .slice(2363, 2435)
    .join("\n");
const drawBgBody = transformBody(drawBgSrc, 4)
    .replace(/^function drawBg\(ts\) \{\r?\n/, "")
    .replace(/\}\s*$/, "");

const restartBgSrc = fs
    .readFileSync(path.join(rootDir, "app.js"), "utf8")
    .split(/\r?\n/)
    .slice(2436, 2440)
    .join("\n");
const restartBgInner = transformBody(restartBgSrc, 4)
    .replace(/^function restartBg\(\) \{\r?\n/, "")
    .replace(/\}\s*$/, "");

const particleHelpers = fs
    .readFileSync(path.join(rootDir, "app.js"), "utf8")
    .split(/\r?\n/)
    .slice(2303, 2362)
    .join("\n");
const particleBody = transformBody(particleHelpers, 4);

const ensureCanvasSrc = fs
    .readFileSync(path.join(rootDir, "app.js"), "utf8")
    .split(/\r?\n/)
    .slice(2287, 2299)
    .join("\n");
const ensureCanvasBody = transformBody(ensureCanvasSrc, 4)
    .replace(/^function ensureProjectionCanvas\(\) \{\r?\n/, "")
    .replace(/\}\s*$/, "");

const removeProjCssFixed = `
function removeProjectionCssBg() {
    document.getElementById("projection-css-bg")?.remove();
}
`.trim();

const ensureProjCssFixed = `
function ensureProjectionCssBg(type) {
    const host = document.getElementById("projection-host");
    if (!host || !CSS_DYNAMIC_BG_TYPES.has(type)) return;
    let el = document.getElementById("projection-css-bg");
    if (!el) {
        el = document.createElement("div");
        el.id = "projection-css-bg";
        el.style.cssText = "position:absolute;inset:0;z-index:0;pointer-events:none;";
        host.insertBefore(el, host.firstChild);
    }
    el.className = "projection-css-bg-fill css-bg-" + type;
}
`.trim();

const out =
    header +
    "\nconst CSS_DYNAMIC_BG_TYPES = new Set([\"gentle-light\", \"starry-night\", \"cross-glow\"]);\n" +
    "const PARTICLE_BG_COUNT = 135;\n" +
    removeProjCssFixed +
    "\n" +
    ensureProjCssFixed +
    "\n" +
    "globalThis.removeProjectionCssBg = removeProjectionCssBg;\n" +
    "globalThis.ensureProjectionCssBg = ensureProjectionCssBg;\n" +
    particleBody +
    "\n" +
    "globalThis.ensureProjectionCanvas = function () {\n" +
    ensureCanvasBody +
    "\n};\n" +
    "globalThis.drawBg = function (ts) {\n" +
    drawBgBody +
    "\n};\n" +
    "globalThis.restartBg = function () {\n" +
    restartBgInner +
    "\n};\n" +
    "globalThis.applyLive = function (mode, payload) {\n" +
    applyLiveBody +
    "\n};\n" +
    "globalThis.renderDisplayLyric = function () {\n" +
    renderDisplayBody +
    "\n};\n" +
    "globalThis.renderLeaderLyric = function () {\n" +
    renderLeaderBody +
    "\n};\n" +
    "globalThis.updateDisplayCardPreview = function () {\n" +
    updateCardBody +
    "\n};\n" +
    "globalThis.installProjectionUI = function (mode) {\n" +
    installBody +
    "\n};\n" +
    "function initDisplayMode() {\n" +
    displayBody +
    "\n}\n" +
    "function initLeaderView() {\n" +
    leaderBody.replace(/^function initLeaderView\(\) \{\r?\n?/, "") +
    "\n";

fs.writeFileSync(path.join(rootDir, "_ui_projection_bundle.js"), out);
console.log("written", out.length);
