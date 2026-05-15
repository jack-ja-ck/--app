// ui.js：负责歌词显示、预览更新、按钮事件绑定

const STORAGE_SONGS = "worship.songs.v5";
const STORAGE_SETTINGS = "worship.settings.v5";

/** 默认歌词与 state.js 中 DEFAULT_LYRICS 一致；此处不重复声明 const，避免与全局冲突 */

function clamp(n, min, max) {
    const x = Number(n);
    if (!Number.isFinite(x)) return min;
    return Math.max(min, Math.min(max, x));
}

let _eventsBound = false;
let _autoplayMainTimer = 0;
let _autoplayProgTimer = 0;

const UI = {
    _inited: false,

    init() {
        if (!UI._inited) {
            UI._inited = true;
            UI.bindEvents();
        }
    },

    _updateAll() {
        const fn = typeof globalThis !== "undefined" ? globalThis.updateAll : null;
        if (typeof fn === "function") fn();
    },

    _hydrateSongsFromLocalStorage() {
        const g = typeof globalThis !== "undefined" ? globalThis : window;
        const AppState = g.AppState;
        if (!AppState) return;
        if (Array.isArray(AppState.songs) && AppState.songs.length) return;
        try {
            const raw = localStorage.getItem(STORAGE_SONGS);
            if (!raw) return;
            const arr = JSON.parse(raw);
            if (Array.isArray(arr) && arr.length) AppState.songs = arr;
        } catch (_e) {
            /* ignore */
        }
    },

    _persistSongsToLocalStorage() {
        const g = typeof globalThis !== "undefined" ? globalThis : window;
        const AppState = g.AppState;
        if (!AppState) return;
        try {
            localStorage.setItem(STORAGE_SONGS, JSON.stringify(AppState.songs));
        } catch (_e) {
            /* ignore */
        }
        if (typeof g.saveAllData === "function") g.saveAllData();
    },

    syncCurrentPagesFromSong() {
        const g = typeof globalThis !== "undefined" ? globalThis : window;
        const AppState = g.AppState;
        const getSong = g.getSong;
        const parsePages = g.parsePages;
        if (!AppState || typeof getSong !== "function" || typeof parsePages !== "function") return;
        const song = getSong(AppState.currentSongId);
        if (!song) {
            AppState.currentPages = [];
            return;
        }
        const lines = clamp(Math.floor(Number(AppState.defaultLines)) || 4, 1, 20);
        AppState.currentPages = parsePages(String(song.lyrics || ""), lines);
        const len = AppState.currentPages.length;
        if (len) {
            AppState.currentPageIndex = clamp(
                Math.floor(Number(AppState.currentPageIndex)) || 0,
                0,
                len - 1
            );
            AppState.currentCardPage = AppState.currentPageIndex;
        } else {
            AppState.currentPageIndex = 0;
            AppState.currentCardPage = 0;
        }
    },

    addNewSong() {
        const g = typeof globalThis !== "undefined" ? globalThis : window;
        const addSong = g.addSong;
        const setCurrentSong = g.setCurrentSong;
        if (!g.AppState || typeof addSong !== "function" || typeof setCurrentSong !== "function") return;
        UI._hydrateSongsFromLocalStorage();
        const blank = { title: "未命名", lyrics: "", key: "", tempo: "", notes: "", tags: "" };
        const s = addSong(blank);
        if (!s) return;
        setCurrentSong(s.id);
        UI._persistSongsToLocalStorage();
        UI.syncCurrentPagesFromSong();
        UI.renderLyrics();
        UI._updateAll();
        UI.showToast("已新建诗歌，请编辑歌词", document.getElementById("add-song-btn"));
    },

    saveCurrentLyrics() {
        const g = typeof globalThis !== "undefined" ? globalThis : window;
        if (typeof g.saveCurrentLyrics === "function") {
            g.saveCurrentLyrics();
            return;
        }
        const getSong = g.getSong;
        const AppState = g.AppState;
        if (!AppState || typeof getSong !== "function") return;
        UI._hydrateSongsFromLocalStorage();
        const ta = document.getElementById("lyric-editor-large");
        const song = getSong(AppState.currentSongId);
        if (!song || !ta) return;
        song.lyrics = ta.value;
        UI._persistSongsToLocalStorage();
        UI.syncCurrentPagesFromSong();
        UI._updateAll();
        UI.showToast("已保存歌词", document.getElementById("save-song-btn"));
    },

    applyToDisplay() {
        UI.saveCurrentLyrics();
        const g = typeof globalThis !== "undefined" ? globalThis : window;
        const R = g.AppRouter;
        if (R && typeof R.init === "function") R.init();
        if (R && typeof R.broadcastState === "function") R.broadcastState();
        UI.showToast("已同步到演示", document.getElementById("apply-to-display"));
    },

    resetCurrentSong() {
        const ta = document.getElementById("lyric-editor-large");
        if (ta) {
            ta.value =
                typeof DEFAULT_LYRICS !== "undefined"
                    ? DEFAULT_LYRICS
                    : "奇异恩典\n何等甘甜\n我罪已得赦免\n\n前我失丧\n今被寻回\n瞎眼得看见";
        }
        UI.saveCurrentLyrics();
    },

    exportData() {
        UI.saveCurrentLyrics();
        const g = typeof globalThis !== "undefined" ? globalThis : window;
        const AppState = g.AppState;
        if (!AppState) return;
        UI._hydrateSongsFromLocalStorage();
        const payload = {
            songs: AppState.songs,
            settings: {
                currentSongId: AppState.currentSongId,
                currentPage: AppState.currentPageIndex,
                ui: {
                    fontSize: AppState.fontSize,
                    defaultLines: AppState.defaultLines,
                    posY: AppState.posY,
                    bgType: AppState.bgType
                }
            }
        };
        try {
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "worship-data.worship";
            a.click();
            URL.revokeObjectURL(url);
            UI.showToast("已导出", document.getElementById("export-data-btn"));
        } catch (_e) {
            /* ignore */
        }
    },

    triggerImportFilePicker() {
        document.getElementById("import-file-input")?.click();
    },

    onImportFileChange(ev) {
        const input = ev.target;
        const file = input && input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            const g = typeof globalThis !== "undefined" ? globalThis : window;
            const AppState = g.AppState;
            if (!AppState) return;
            let data = null;
            try {
                data = JSON.parse(String(reader.result || ""));
            } catch (_e) {
                data = null;
            }
            if (!data || !Array.isArray(data.songs) || !data.songs.length) {
                UI.showToast("导入失败", document.getElementById("import-data-btn"));
                input.value = "";
                return;
            }
            AppState.songs = data.songs;
            const settings = data.settings || {};
            AppState.currentSongId = settings.currentSongId || AppState.songs[0].id;
            AppState.currentPageIndex = Number.isFinite(settings.currentPage) ? settings.currentPage : 0;
            if (settings.ui && typeof settings.ui === "object") {
                if (settings.ui.fontSize != null) AppState.fontSize = Number(settings.ui.fontSize) || AppState.fontSize;
                if (settings.ui.defaultLines != null) {
                    AppState.defaultLines = clamp(settings.ui.defaultLines, 1, 20);
                }
                if (settings.ui.posY != null) AppState.posY = clamp(settings.ui.posY, 20, 70);
                if (settings.ui.bgType) AppState.bgType = String(settings.ui.bgType);
            }
            try {
                localStorage.setItem(STORAGE_SONGS, JSON.stringify(AppState.songs));
                localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(settings));
            } catch (_e) {
                /* ignore */
            }
            if (typeof g.saveAllData === "function") g.saveAllData();
            UI.syncCurrentPagesFromSong();
            UI.renderLyrics();
            UI._syncSliderLabelsFromAppState();
            UI._updateAll();
            UI.showToast("导入成功", document.getElementById("import-data-btn"));
            input.value = "";
        };
        reader.readAsText(file, "utf-8");
    },

    openBatchImportModal() {
        const m = document.getElementById("batch-import-modal");
        if (m) m.style.display = "flex";
    },

    _syncSliderLabelsFromAppState() {
        const g = typeof globalThis !== "undefined" ? globalThis : window;
        const AppState = g.AppState;
        if (!AppState) return;
        const fs = document.getElementById("font-slider");
        const dl = document.getElementById("default-lines-input");
        const ps = document.getElementById("pos-slider");
        const fv = document.getElementById("font-val");
        const pv = document.getElementById("pos-val");
        if (fs) fs.value = String(clamp(AppState.fontSize, 24, 120));
        if (dl) dl.value = String(clamp(AppState.defaultLines, 1, 20));
        if (ps) ps.value = String(clamp(AppState.posY, 20, 70));
        if (fv) fv.textContent = String(clamp(AppState.fontSize, 24, 120));
        if (pv) pv.textContent = String(clamp(AppState.posY, 20, 70));
    },

    onFontSliderInput() {
        const g = typeof globalThis !== "undefined" ? globalThis : window;
        const AppState = g.AppState;
        const el = document.getElementById("font-slider");
        const fv = document.getElementById("font-val");
        if (!AppState || !el) return;
        AppState.fontSize = clamp(Number(el.value) || 56, 24, 120);
        if (fv) fv.textContent = String(AppState.fontSize);
        UI._updateAll();
    },

    onDefaultLinesInput() {
        const g = typeof globalThis !== "undefined" ? globalThis : window;
        const AppState = g.AppState;
        const el = document.getElementById("default-lines-input");
        if (!AppState || !el) return;
        AppState.defaultLines = clamp(Number(el.value) || 4, 1, 20);
        AppState.currentPageIndex = 0;
        AppState.currentCardPage = 0;
        UI.syncCurrentPagesFromSong();
        UI.renderLyrics();
        UI._updateAll();
    },

    onPosSliderInput() {
        const g = typeof globalThis !== "undefined" ? globalThis : window;
        const AppState = g.AppState;
        const el = document.getElementById("pos-slider");
        const pv = document.getElementById("pos-val");
        if (!AppState || !el) return;
        AppState.posY = clamp(Number(el.value) || 45, 20, 70);
        if (pv) pv.textContent = String(AppState.posY);
        UI._updateAll();
    },

    onBgOptionClick(ev) {
        const g = typeof globalThis !== "undefined" ? globalThis : window;
        const AppState = g.AppState;
        const node = ev.currentTarget;
        if (!AppState || !node) return;
        const bg = node.getAttribute("data-bg") || "solid-black";
        AppState.bgType = bg;
        document.querySelectorAll(".bg-option").forEach((n) => {
            n.classList.toggle("active", n === node);
        });
        UI._updateAll();
    },

    triggerBgImageInput() {
        document.getElementById("bg-image-input")?.click();
    },

    onBgImageInputChange(ev) {
        const input = ev.target;
        const files = input && input.files;
        if (!files || !files.length) return;
        const arr = Array.from(files);
        const anchor = document.getElementById("upload-bg-btn") || document.getElementById("upload-bg-trigger");
        const readOne = (file) =>
            new Promise((resolve, reject) => {
                const r = new FileReader();
                r.onload = () => {
                    const dataUrl = String(r.result || "").trim();
                    if (dataUrl) resolve(dataUrl);
                    else reject(new Error("empty"));
                };
                r.onerror = () => reject(r.error || new Error("read"));
                r.readAsDataURL(file);
            });
        (async () => {
            const g = typeof globalThis !== "undefined" ? globalThis : window;
            const AppState = g.AppState;
            let lastOk = "";
            for (const file of arr) {
                try {
                    lastOk = await readOne(file);
                } catch {
                    /* skip */
                }
            }
            if (!lastOk) {
                UI.showToast("未能读取文件", anchor);
                input.value = "";
                return;
            }
            if (AppState) AppState.bgType = "image";
            try {
                sessionStorage.setItem("worship.ui.bgImageDataUrl", lastOk);
            } catch (_e) {
                /* ignore */
            }
            document.querySelectorAll(".bg-option").forEach((n) => {
                n.classList.toggle("active", n.getAttribute("data-bg") === "image");
            });
            UI._updateAll();
            UI.showToast(
                arr.length > 1 ? `已选择 ${arr.length} 个文件，已应用最后一项` : "已选择背景文件",
                anchor
            );
            input.value = "";
        })();
    },

    stopAutoplay() {
        const g = typeof globalThis !== "undefined" ? globalThis : window;
        if (_autoplayMainTimer) clearInterval(_autoplayMainTimer);
        if (_autoplayProgTimer) clearInterval(_autoplayProgTimer);
        _autoplayMainTimer = 0;
        _autoplayProgTimer = 0;
        if (g.AppState) g.AppState.autoplayActive = false;
        const bar = document.getElementById("autoplay-progress");
        if (bar) bar.style.width = "0%";
    },

    toggleAutoplay() {
        const g = typeof globalThis !== "undefined" ? globalThis : window;
        const AppState = g.AppState;
        if (!AppState) return;
        if (AppState.autoplayActive) {
            UI.stopAutoplay();
            UI.showToast("自动播放已停止", document.getElementById("autoplay-toggle"));
            return;
        }
        UI.stopAutoplay();
        const intervalEl = document.getElementById("autoplay-interval");
        const seconds = clamp(Number(intervalEl && intervalEl.value) || AppState.autoplayInterval || 5, 1, 30);
        AppState.autoplayInterval = seconds;
        const intervalMs = seconds * 1000;
        AppState.autoplayActive = true;
        let elapsed = 0;
        _autoplayMainTimer = window.setInterval(() => {
            UI.syncCurrentPagesFromSong();
            const next = typeof g.nextPage === "function" ? g.nextPage : null;
            if (typeof next === "function") next();
            else if (g.AppState && g.AppState.currentPages.length) {
                const max = g.AppState.currentPages.length - 1;
                const cur = g.AppState.currentPageIndex;
                g.AppState.currentPageIndex = cur >= max ? 0 : cur + 1;
                g.AppState.currentCardPage = g.AppState.currentPageIndex;
            }
            UI.renderLyrics();
            UI._updateAll();
            elapsed = 0;
        }, intervalMs);
        _autoplayProgTimer = window.setInterval(() => {
            elapsed += 100;
            const pct = clamp((elapsed / intervalMs) * 100, 0, 100);
            const bar = document.getElementById("autoplay-progress");
            if (bar) bar.style.width = pct + "%";
        }, 100);
        UI.showToast("自动播放已开始", document.getElementById("autoplay-toggle"));
    },

    _getDisplayWindowPlacement() {
        const g = typeof globalThis !== "undefined" ? globalThis : window;
        if (typeof g.__worshipGetProjectionWindowPlacement === "function") {
            return g.__worshipGetProjectionWindowPlacement();
        }
        const scr = window.screen;
        const availLeft = Number(scr.availLeft) || 0;
        const availTop = Number(scr.availTop) || 0;
        const availWidth = Math.max(400, Number(scr.availWidth) || 1280);
        const availHeight = Math.max(300, Number(scr.availHeight) || 720);
        const maxW = Math.floor(availWidth * 0.96);
        const maxH = Math.floor(availHeight * 0.96);
        const w = clamp(Math.floor(availWidth * 0.92), 800, maxW);
        const h = clamp(Math.floor(availHeight * 0.92), 540, maxH);
        return {
            left: availLeft + Math.max(0, Math.floor((availWidth - w) / 2)),
            top: availTop + Math.max(0, Math.floor((availHeight - h) / 2)),
            width: w,
            height: h
        };
    },

    _openAuxWindow(pathWithQuery, anchorEl) {
        const { left, top, width, height } = UI._getDisplayWindowPlacement();
        const feats = [
            `left=${left}`,
            `top=${top}`,
            `width=${width}`,
            `height=${height}`,
            "menubar=no",
            "toolbar=no",
            "status=no",
            "scrollbars=yes"
        ].join(",");
        const name = `worship_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        let url;
        try {
            const u = new URL("index.html", location.href);
            u.search = String(pathWithQuery || "").replace(/^\?/, "");
            url = u.href;
        } catch (_e) {
            url = `./index.html${String(pathWithQuery || "").startsWith("?") ? pathWithQuery : `?${pathWithQuery}`}`;
        }
        const win = window.open(url, name, feats);
        if (!win) {
            UI.showToast("无法打开窗口，请允许弹窗", anchorEl);
            return null;
        }
        const applyPlacement = () => {
            try {
                win.moveTo(left, top);
                win.resizeTo(width, height);
            } catch (_e) {
                /* ignore */
            }
        };
        applyPlacement();
        const ua = navigator.userAgent || "";
        const p = navigator.platform || "";
        const mac = /^Mac/i.test(p) || /Mac OS X/i.test(ua);
        if (mac) {
            window.setTimeout(applyPlacement, 100);
            window.setTimeout(applyPlacement, 380);
        }
        return win;
    },

    createDisplayWindow() {
        const g = typeof globalThis !== "undefined" ? globalThis : window;
        if (typeof g.__worshipOpenDisplayWindow === "function") {
            g.__worshipOpenDisplayWindow();
            return;
        }
        const R = g.AppRouter;
        if (R && typeof R.init === "function") R.init();
        if (R && typeof R.broadcastState === "function") R.broadcastState();
        UI._openAuxWindow("?display=1", document.getElementById("open-display-btn"));
    },

    createLeaderWindow() {
        const g = typeof globalThis !== "undefined" ? globalThis : window;
        if (typeof g.__worshipOpenLeaderWindow === "function") {
            g.__worshipOpenLeaderWindow();
            return;
        }
        const R = g.AppRouter;
        if (R && typeof R.init === "function") R.init();
        if (R && typeof R.broadcastState === "function") R.broadcastState();
        UI._openAuxWindow("?leader=1", document.getElementById("open-leader-btn"));
    },

    filterSongList() {
        const g = typeof globalThis !== "undefined" ? globalThis : window;
        const el = document.getElementById("search-input");
        const q = (el && el.value ? el.value : "").trim().toLowerCase();
        if (g.AppState) g.AppState.searchQuery = q;
        if (typeof g.renderSongList === "function") {
            g.renderSongList();
            return;
        }
        const list = document.getElementById("song-list");
        if (!list) return;
        list.querySelectorAll(".song-item").forEach((row) => {
            const titleEl = row.querySelector(".song-item-title");
            const text = (titleEl && titleEl.textContent ? titleEl.textContent : "").toLowerCase();
            row.style.display = !q || text.includes(q) ? "" : "none";
        });
    },

    runOnlineSearch() {
        const g = typeof globalThis !== "undefined" ? globalThis : window;
        if (typeof g.renderOnlineSearchResult === "function") {
            g.renderOnlineSearchResult();
        }
    },

    renderLyrics() {
        const g = typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : self;
        const AppState = g.AppState;
        const getSong = g.getSong;
        if (!AppState || typeof getSong !== "function") return;

        const song = getSong(AppState.currentSongId);
        const pages = Array.isArray(AppState.currentPages) ? AppState.currentPages : [];
        const plen = pages.length;
        const rawIdx = Math.floor(Number(AppState.currentPageIndex)) || 0;
        const idx = plen ? Math.max(0, Math.min(rawIdx, plen - 1)) : 0;

        const ta = document.getElementById("lyric-editor-large");
        const mini = document.getElementById("mini-preview");
        const counter = document.getElementById("preview-line-counter");

        if (!song) {
            if (ta) ta.value = "";
            if (mini) mini.innerHTML = "";
            if (counter) counter.textContent = "";
            return;
        }

        const pageLines = plen && Array.isArray(pages[idx])
            ? pages[idx].map((x) => String(x ?? ""))
            : [];

        /* 主控台 app.js 的编辑区始终承载「整首歌词」；勿写入当前页行，否则 updateAll→syncEditorToSong 会截断曲库 */
        if (ta) ta.value = String(song.lyrics || "");

        if (!mini) {
            if (counter) counter.textContent = "";
            return;
        }

        let maxPreviewLines = null;
        const attr = mini.getAttribute("data-preview-lines");
        if (attr != null && String(attr).trim() !== "") {
            const n = parseInt(String(attr).trim(), 10);
            if (Number.isFinite(n) && n > 0) maxPreviewLines = n;
        }

        const linesToShow =
            maxPreviewLines == null
                ? pageLines
                : pageLines.slice(0, Math.min(maxPreviewLines, pageLines.length));

        mini.innerHTML = "";
        for (let i = 0; i < linesToShow.length; i++) {
            const row = document.createElement("div");
            row.className = "preview-line";
            row.textContent = linesToShow[i];
            mini.appendChild(row);
        }

        if (counter) {
            counter.textContent = linesToShow.length ? `(${linesToShow.length} 行)` : "";
        }
    },

    updateMiniPreview() {
        // TODO: 根据 AppState 与当前页歌词刷新迷你预览框内容与样式
    },

    updateSpeakerCards() {
        // TODO: 根据分页结果重建投屏预览卡片列表并同步当前页高亮
    },

    bindEvents() {
        if (_eventsBound) return;
        _eventsBound = true;

        const on = (id, ev, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener(ev, fn);
        };

        /* 新建诗歌由 app.js createNewSong 绑定（state / switchSong）；勿在此绑 legacy AppState 路径以免与主逻辑脱节 */
        /* 保存歌词由 app.js saveCurrentLyrics 绑定（含校验、曲库持久化、提示窗）；勿重复监听以免保存两次 */
        on("apply-to-display", "click", () => UI.applyToDisplay());
        on("reset-current-song", "click", () => UI.resetCurrentSong());

        on("export-data-btn", "click", () => UI.exportData());
        on("import-data-btn", "click", () => UI.triggerImportFilePicker());
        on("import-file-input", "change", (e) => UI.onImportFileChange(e));
        on("batch-import-btn", "click", () => UI.openBatchImportModal());

        on("font-slider", "input", () => UI.onFontSliderInput());
        on("default-lines-input", "input", () => UI.onDefaultLinesInput());
        on("pos-slider", "input", () => UI.onPosSliderInput());

        document.querySelectorAll(".bg-option").forEach((node) => {
            node.addEventListener("click", (e) => UI.onBgOptionClick(e));
        });
        on("upload-bg-btn", "click", () => UI.triggerBgImageInput());
        on("bg-image-input", "change", (e) => UI.onBgImageInputChange(e));

        on("autoplay-toggle", "click", () => UI.toggleAutoplay());
        on("autoplay-stop", "click", () => {
            UI.stopAutoplay();
            UI.showToast("自动播放已停止", document.getElementById("autoplay-stop"));
        });

        /* 开启投屏 / 主领：由 app.js 绑定（含 Mac 兼容的 window.open 参数与固定窗口名），此处勿重复监听以免连开两窗 */

        on("search-input", "input", () => UI.filterSongList());
        on("online-search-input", "input", () => UI.runOnlineSearch());

        /* 翻页键盘由 app.js 统一处理（含 Alt/Ctrl+Shift 组合键与输入框例外）。
         * 若此处再监听，会与 app.js 重复触发 nextPage，且 renderLyrics 曾把编辑区写成「单页片段」，
         * syncEditorToSong 会把整首歌词冲掉 → 分页塌成 1 页、始终回到第一张卡片。 */
    },

    showToast(msg, triggerEl, opts) {
        const fn = typeof globalThis !== "undefined" ? globalThis.showToast : null;
        if (typeof fn === "function") {
            fn(msg, triggerEl, opts);
            return;
        }
        const t = document.getElementById("toast");
        if (!t) return;
        t.textContent = String(msg ?? "");
        t.style.opacity = "1";
        setTimeout(() => {
            t.style.opacity = "0";
        }, 1800);
    }
};


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

const CSS_DYNAMIC_BG_TYPES = new Set(["gentle-light", "starry-night", "cross-glow"]);
const PARTICLE_BG_COUNT = 135;
function removeProjectionCssBg() {
    document.getElementById("projection-css-bg")?.remove();
}
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
globalThis.removeProjectionCssBg = removeProjectionCssBg;
globalThis.ensureProjectionCssBg = ensureProjectionCssBg;
function rollParticleTint() {
    const r = Math.random();
    if (r < 0.38) return "w";
    if (r < 0.69) return "g";
    return "b";
}

function createAmbientParticles(w, h, count) {
    return Array.from({ length: count }, () => {
        const a = Math.random() * Math.PI * 2;
        const speed = 0.5 + Math.random() * 0.3;
        const tint = globalThis.rollParticleTint();
        return {
            x: Math.random() * w,
            y: Math.random() * h,
            vx: Math.cos(a) * speed,
            vy: Math.sin(a) * speed,
            r: 3 + Math.random() * 4,
            alpha: 0.7 + Math.random() * 0.2,
            colorMode: tint
        };
    });
}

function applyParticleShadow(ctx, p) {
    ctx.shadowBlur = 16;
    if (p.colorMode === "g") ctx.shadowColor = "rgba(255,215,0,0.72)";
    else if (p.colorMode === "b") ctx.shadowColor = "rgba(173,216,230,0.68)";
    else ctx.shadowColor = "rgba(255,255,255,0.78)";
}

function applyParticleFill(ctx, p) {
    const a = p.alpha.toFixed(3);
    if (p.colorMode === "g") ctx.fillStyle = `rgba(255,215,0,${a})`;
    else if (p.colorMode === "b") ctx.fillStyle = `rgba(173,216,230,${a})`;
    else ctx.fillStyle = `rgba(255,255,255,${a})`;
}

function drawParticles(w, h, dt) {
    const ctx = globalThis.projectionCtx;
    if (!ctx) return;
    if (globalThis.projectionParticles.length !== PARTICLE_BG_COUNT) {
        globalThis.projectionParticles = globalThis.createAmbientParticles(w, h, PARTICLE_BG_COUNT);
    }
    globalThis.projectionParticles.forEach((p) => {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;
        p.x = globalThis.clamp(p.x, 0, w);
        p.y = globalThis.clamp(p.y, 0, h);
        globalThis.applyParticleShadow(ctx, p);
        globalThis.applyParticleFill(ctx, p);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.shadowBlur = 0;
}
globalThis.ensureProjectionCanvas = function () {
    if (!globalThis.projectionCanvas || !globalThis.projectionCtx) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    if (globalThis.projectionCanvas.width !== Math.floor(w * dpr) || globalThis.projectionCanvas.height !== Math.floor(h * dpr)) {
        globalThis.projectionCanvas.width = Math.floor(w * dpr);
        globalThis.projectionCanvas.height = Math.floor(h * dpr);
        globalThis.projectionCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        globalThis.projectionParticles = [];
    }

};
globalThis.drawBg = function (ts) {
    if (!globalThis.projectionCtx || !globalThis.liveState) return;
    const bgState = globalThis.liveState.background || {};
    const type = bgState.type || "solid-black";
    const gifLayer = document.getElementById("projection-bg-image");

    if (CSS_DYNAMIC_BG_TYPES.has(type)) {
        globalThis.ensureProjectionCssBg(type);
        if (gifLayer) gifLayer.style.display = "none";
        if (globalThis.projectionCanvas) globalThis.projectionCanvas.style.display = "none";
        globalThis.projectionLastTs = ts;
        globalThis.projectionRaf = 0;
        return;
    }
    const urlForMedia = String(bgState.imageData || "");
    let mediaType = bgState.mediaType;
    if (mediaType !== "video" && mediaType !== "image") {
        mediaType =
            typeof globalThis.inferMediaTypeFromDataUrl === "function"
                ? globalThis.inferMediaTypeFromDataUrl(urlForMedia)
                : /^data:video\//i.test(urlForMedia)
                  ? "video"
                  : "image";
    }
    if (!mediaType) mediaType = "image";

    // 视频背景处理
    const isVideoBg = type === "image" && mediaType === "video" && !!bgState.imageData;
    const dispV = document.getElementById("display-video-bg");

    if (isVideoBg && dispV && bgState.imageData) {
        globalThis.removeProjectionCssBg();
        if (gifLayer) gifLayer.style.display = "none";
        if (globalThis.projectionCanvas) globalThis.projectionCanvas.style.display = "none";
        const want = String(bgState.imageData || "");
        const srcChanged = dispV.dataset.worshipBgUrl !== want;
        if (srcChanged) {
            dispV.dataset.worshipBgUrl = want;
            dispV.src = want;
        }
        dispV.style.opacity = "1";
        if (srcChanged || dispV.paused || dispV.ended) {
            void dispV.play().catch(() => {});
        }
        globalThis.projectionLastTs = ts;
        globalThis.projectionRaf = 0;
        return;
    }

    // 当不是视频背景时，暂停并清空视频元素
    if (dispV && !isVideoBg) {
        dispV.pause();
        dispV.removeAttribute("src");
        delete dispV.dataset.worshipBgUrl;
        try {
            dispV.load();
        } catch (_e) {
            /* ignore */
        }
        dispV.style.opacity = "0";
    }

    globalThis.removeProjectionCssBg();
    if (globalThis.projectionCanvas) globalThis.projectionCanvas.style.display = "block";

    globalThis.ensureProjectionCanvas();
    const ctx = globalThis.projectionCtx;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (gifLayer) gifLayer.style.display = "none";

    if (type === "solid-white") {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
    } else if (type === "solid-gray") {
        ctx.fillStyle = "#444";
        ctx.fillRect(0, 0, w, h);
    } else if (type === "gradient") {
        const g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, "#1a2e59");
        g.addColorStop(1, "#0a0f1d");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
    } else if (type === "image" && bgState.imageData) {
        const isGif = /^data:image\/gif/i.test(bgState.imageData);
        if (isGif && gifLayer) {
            if (gifLayer.src !== bgState.imageData) gifLayer.src = bgState.imageData;
            gifLayer.style.display = "block";
            if (globalThis.projectionCanvas) globalThis.projectionCanvas.style.display = "none";
        } else {
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, w, h);
            if (!globalThis.projectionBgImage || globalThis.projectionBgImage.src !== bgState.imageData) {
                globalThis.projectionBgImage = new Image();
                globalThis.projectionBgImage.src = bgState.imageData;
            }
            if (globalThis.projectionBgImage.complete && globalThis.projectionBgImage.naturalWidth > 0) {
                const ratio = Math.max(w / globalThis.projectionBgImage.naturalWidth, h / globalThis.projectionBgImage.naturalHeight);
                const dw = globalThis.projectionBgImage.naturalWidth * ratio;
                const dh = globalThis.projectionBgImage.naturalHeight * ratio;
                const dx = (w - dw) / 2;
                const dy = (h - dh) / 2;
                ctx.drawImage(globalThis.projectionBgImage, dx, dy, dw, dh);
            }
        }
    } else if (type === "particles") {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, w, h);
        const dt = globalThis.clamp((ts - (globalThis.projectionLastTs || ts)) / 16.67, 0.3, 2.5);
        globalThis.drawParticles(w, h, dt);
    } else {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, w, h);
    }
    globalThis.projectionLastTs = ts;
    const gifAnimating = type === "image" && typeof bgState.imageData === "string" && /^data:image\/gif/i.test(bgState.imageData);
    const loop = type === "particles" || gifAnimating || (type === "image" && globalThis.projectionBgImage && !globalThis.projectionBgImage.complete);
    if (loop) globalThis.projectionRaf = requestAnimationFrame(globalThis.drawBg);
    else globalThis.projectionRaf = 0;

};
globalThis.restartBg = function () {
    try {
        const ls = globalThis.liveState;
        if (projectionDisplayIsVideoBackground(ls)) {
            const dispV = document.getElementById("display-video-bg");
            const want = String(ls.background?.imageData || "").trim();
            if (dispV && want && dispV.dataset.worshipBgUrl === want) {
                if (globalThis.projectionRaf) cancelAnimationFrame(globalThis.projectionRaf);
                globalThis.projectionRaf = 0;
                dispV.style.opacity = "1";
                void dispV.play().catch(() => {});
                return;
            }
        }
    } catch (_e) {
        /* ignore */
    }
    if (globalThis.projectionRaf) cancelAnimationFrame(globalThis.projectionRaf);
    globalThis.projectionRaf = requestAnimationFrame(globalThis.drawBg);

};
function projectionLiveBackgroundSignature(bg) {
    if (!bg || typeof bg !== "object") return "";
    const type = String(bg.type || "");
    const mt = String(bg.mediaType || "");
    const s = String(bg.imageData || "").trim();
    if (!s) return [type, mt, "empty"].join("\x1e");
    const len = s.length;
    return [type, mt, "len" + len, s.slice(0, 96), s.slice(-96)].join("\x1e");
}
function projectionDisplayIsVideoBackground(live) {
    const ls = live || globalThis.liveState;
    if (!ls) return false;
    const bg = ls.background || {};
    const type = bg.type || "solid-black";
    const url = String(bg.imageData || "");
    let mediaType = bg.mediaType;
    if (mediaType !== "video" && mediaType !== "image") {
        mediaType =
            typeof globalThis.inferMediaTypeFromDataUrl === "function"
                ? globalThis.inferMediaTypeFromDataUrl(url)
                : /^data:video\//i.test(url)
                  ? "video"
                  : "image";
    }
    if (!mediaType) mediaType = "image";
    return type === "image" && mediaType === "video" && !!bg.imageData;
}
globalThis.applyLive = function (mode, payload) {
    if (payload === undefined && mode && typeof mode === "object") {
        payload = mode;
        mode = globalThis.projectionMode || "display";
    }
    if (!payload || !payload.pages) return;
    const prev = globalThis.liveState;
    const m0 = mode || globalThis.projectionMode || "display";
    let next = payload;
    const incomingBg = payload.background;
    if (
        prev &&
        m0 === "display" &&
        projectionDisplayIsVideoBackground(prev) &&
        (!incomingBg || !String(incomingBg.imageData || "").trim())
    ) {
        next = { ...payload, background: prev.background };
    }
    globalThis.liveState = next;
    const m = mode || globalThis.projectionMode;
    if (m === "display") {
        const prevIdx = Number(prev?.pageIndex) || 0;
        const newIdx = Number(next.pageIndex) || 0;
        const sameSong = !!prev && String(prev.songId || "") === String(next.songId || "");
        const navChanged = !!prev && (!sameSong || prevIdx !== newIdx);
        const trans =
            typeof globalThis.__worshipCanonicalPageTransition === "function"
                ? globalThis.__worshipCanonicalPageTransition(next.pageTransition || "none")
                : "none";
        const dur = globalThis.clamp(Number(next.pageTransitionSpeed ?? 0.6), 0.3, 1.5);
        /** 视频背景与 <video> 同屏时，翻页 CSS 过渡易与解码/合成抢线程，出现短暂黑屏或卡顿；仅歌词瞬时替换 */
        const videoBg = projectionDisplayIsVideoBackground(next);
        const doAnim =
            navChanged &&
            !videoBg &&
            !next.playlistFade &&
            trans !== "none" &&
            typeof globalThis.__worshipRunDisplayPageTransitionThenRender === "function";
        const fontOpForAnim = globalThis.clamp(Number(next.fontOpacityPct ?? 100), 20, 100);
        if (doAnim) {
            globalThis.__worshipRunDisplayPageTransitionThenRender(trans, dur, (o) => globalThis.renderDisplayLyric(o), fontOpForAnim);
        } else {
            globalThis.renderDisplayLyric();
        }
    } else globalThis.renderLeaderLyric();
    const skipRestart =
        m === "display" &&
        projectionDisplayIsVideoBackground(globalThis.liveState) &&
        projectionLiveBackgroundSignature(prev?.background) ===
            projectionLiveBackgroundSignature(globalThis.liveState.background);
    if (!skipRestart) globalThis.restartBg();

};
globalThis.renderDisplayLyric = function (opts) {
    const layer = document.getElementById("projection-lyric");
    if (!layer || !globalThis.liveState) return;
    const inner = document.getElementById("projection-lyric-anim");
    const target = inner || layer;
    const pages = globalThis.liveState.pages || [];
    const idx = globalThis.clamp(globalThis.liveState.pageIndex || 0, 0, Math.max(0, pages.length - 1));
    const lines = pages[idx] || [];
    const t = globalThis.liveState.text || {};
    const fontColor = globalThis.liveState.fontColor || t.color || "#ffffff";
    const fontOp = globalThis.clamp(Number(globalThis.liveState.fontOpacityPct ?? 100), 20, 100) / 100;
    layer.style.textAlign = "center";
    let topPct = 45;
    if (typeof globalThis.projectionTextTopPctFromLive === "function") {
        try {
            topPct = globalThis.projectionTextTopPctFromLive(t);
        } catch (_e) {
            const raw = t.topPct != null ? Number(t.topPct) : 45;
            topPct = globalThis.clamp(Number.isFinite(raw) ? raw : 45, 20, 70);
        }
    } else {
        const raw = t.topPct != null ? Number(t.topPct) : 45;
        topPct = globalThis.clamp(Number.isFinite(raw) ? raw : 45, 20, 70);
    }
    layer.style.top = `${topPct}%`;
    layer.style.fontFamily = t.fontFamily || globalThis.__projectionUi.fontFamily;
    const fsPx =
        typeof globalThis.clampLyricFontSize === "function"
            ? globalThis.clampLyricFontSize(Number(t.fontSize) || 60)
            : globalThis.clamp(t.fontSize || 56, 8, 500);
    layer.style.fontSize = `${fsPx}px`;
    const lh =
        typeof globalThis.getAdvPreviewLineHeightNumber === "function"
            ? globalThis.getAdvPreviewLineHeightNumber()
            : 1.45;
    layer.style.lineHeight = String(lh);
    layer.style.fontWeight =
        t.fontWeight != null && t.fontWeight !== "" ? String(t.fontWeight) : "700";
    layer.style.color = fontColor;
    const skipMid = !!(opts && opts.pageTransitionMidSwap);
    layer.style.transform = "translateY(-50%)";
    if (inner) {
        layer.style.opacity = "1";
        layer.style.transition = "";
        if (!skipMid) {
            inner.style.transition = "";
            inner.style.transform = "";
        }
    }
    const applyFade = !!globalThis.liveState.playlistFade && !skipMid;
    target.style.transition = "opacity 300ms ease";
    if (applyFade) target.style.opacity = "0";
    else     target.style.opacity = String(fontOp);
    const buildRow =
        typeof globalThis.buildLyricRowHtmlForProjectionLine === "function"
            ? globalThis.buildLyricRowHtmlForProjectionLine
            : (line) => `<div>${globalThis.escapeHtml(line)}</div>`;
    target.innerHTML = lines.map((line) => buildRow(line, "", undefined)).join("");
    if (applyFade) {
        requestAnimationFrame(() => {
            target.style.opacity = String(fontOp);
        });
    }
    globalThis.updateDisplayCardPreview();

};
globalThis.renderLeaderLyric = function () {
    const layer = document.getElementById("projection-lyric");
    if (!layer || !globalThis.liveState) return;
    const pages = globalThis.liveState.pages || [];
    const idx = globalThis.clamp(globalThis.liveState.pageIndex || 0, 0, Math.max(0, pages.length - 1));
    const current = pages[idx] || [];
    const next = pages[idx + 1] || [];
    const t = globalThis.liveState.text || {};
    const fontColor = globalThis.liveState.fontColor || t.color || "#ffffff";
    layer.style.textAlign = "left";
    layer.style.fontFamily = t.fontFamily || globalThis.__projectionUi.fontFamily;
    layer.style.fontWeight =
        t.fontWeight != null && t.fontWeight !== "" ? String(t.fontWeight) : "700";
    layer.style.color = fontColor;
    layer.style.fontSize = "44px";
    const applyFade = !!globalThis.liveState.playlistFade;
    layer.style.transition = "opacity 300ms ease";
    if (applyFade) layer.style.opacity = "0";
    const fmtLine =
        typeof globalThis.formatLyricLineForCompactPreview === "function"
            ? globalThis.formatLyricLineForCompactPreview
            : (ln) => String(ln ?? "");
    layer.innerHTML = [
        `<div style="position:absolute;top:-90px;right:0;font-size:16px;opacity:.9;">第 ${idx + 1}/${Math.max(1, pages.length)} 页</div>`,
        `<div style="line-height:1.35;margin-bottom:20px;">${current.map((x) => globalThis.escapeHtml(fmtLine(x))).join("<br>") || "..."}</div>`,
        `<div style="font-size:22px;opacity:.75;">下页：${next.length ? next.map((x) => globalThis.escapeHtml(fmtLine(x))).join(" / ") : "（无）"}</div>`
    ].join("");
    if (applyFade) requestAnimationFrame(() => { layer.style.opacity = "1"; });

};
globalThis.updateDisplayCardPreview = function () {
    if (
        typeof location !== "undefined" &&
        new URLSearchParams(location.search || "").get("display") === "1"
    ) {
        return;
    }
    const holder = document.getElementById("display-card-preview");
    if (!holder || !globalThis.liveState) return;
    holder.innerHTML = "";
    const pages = globalThis.liveState.pages || [];
    if (!pages.length) return;
    const cardsPerRow = globalThis.clamp(Math.floor((window.innerWidth - 120) / 120), 4, 10);
    pages.forEach((lines, i) => {
        const card = document.createElement("div");
        card.className = "display-mini-card" + (i === globalThis.liveState.pageIndex ? " active" : "");
        card.style.setProperty("--cards-per-row", String(cardsPerRow));
        const fmt =
            typeof globalThis.formatLyricLineForCompactPreview === "function"
                ? globalThis.formatLyricLineForCompactPreview
                : (ln) => String(ln ?? "");
        const l1 = fmt(lines?.[0] || "");
        const l2 = fmt(lines?.[1] || "");
        card.innerHTML = `<div style="font-weight:700;white-space:normal;">${globalThis.escapeHtml(l1)}</div><div style="opacity:.75;margin-top:4px;white-space:normal;">${globalThis.escapeHtml(l2)}</div>`;
        card.addEventListener("click", () => {
            if (globalThis.__projectionChannel) globalThis.__projectionChannel.postMessage({ type: "goto", page: i });
        });
        holder.appendChild(card);
    });

};
globalThis.installProjectionUI = function (mode) {
    const audienceDisplay =
        typeof location !== "undefined" &&
        new URLSearchParams(location.search || "").get("display") === "1";

    const app = document.getElementById("app");
    if (app) app.style.display = "none";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";

    const host = document.createElement("div");
    host.id = "projection-host";
    host.style.cssText = "position:fixed;inset:0;background:#000;overflow:hidden;";
    document.body.appendChild(host);

    if (mode === "display") {
        const displayVid = document.createElement("video");
        displayVid.id = "display-video-bg";
        displayVid.setAttribute("loop", "");
        displayVid.muted = true;
        displayVid.defaultMuted = true;
        displayVid.setAttribute("playsinline", "");
        displayVid.playsInline = true;
        displayVid.setAttribute("autoplay", "");
        displayVid.preload = "auto";
        try {
            displayVid.disablePictureInPicture = true;
        } catch (_e) {
            /* ignore */
        }
        displayVid.style.cssText =
            "position:fixed;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:0;" +
            "pointer-events:none;opacity:0;display:block;" +
            "transform:translateZ(0);backface-visibility:hidden;-webkit-backface-visibility:hidden;";
        host.appendChild(displayVid);
    }

    const canvas = document.createElement("canvas");
    canvas.id = "projection-bg";
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
    host.appendChild(canvas);
    globalThis.projectionCanvas = canvas;
    globalThis.projectionCtx = canvas.getContext("2d");

    const gifImg = document.createElement("img");
    gifImg.id = "projection-bg-image";
    gifImg.alt = "";
    gifImg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center;display:none;pointer-events:none;";
    host.appendChild(gifImg);

    const lyric = document.createElement("div");
    lyric.id = "projection-lyric";
    lyric.style.cssText = [
        "position:absolute",
        "left:4%",
        "right:4%",
        "top:50%",
        "transform:translateY(-50%)",
        "text-align:center",
        "line-height:1.45",
        "font-weight:700",
        "text-shadow:0 2px 10px rgba(0,0,0,.85)",
        "z-index:2"
    ].join(";");
    if (mode === "leader") lyric.style.textAlign = "left";
    host.appendChild(lyric);
    if (mode === "display") {
        const anim = document.createElement("div");
        anim.id = "projection-lyric-anim";
        anim.style.cssText = "width:100%;transform-origin:center center;";
        lyric.appendChild(anim);
    }

    if (mode !== "display" || !audienceDisplay) {
        const nav = document.createElement("div");
        nav.style.cssText =
            "position:absolute;left:0;right:0;bottom:24px;display:flex;justify-content:center;gap:12px;z-index:3;";
        nav.innerHTML =
            '<button id="projection-prev-btn" class="display-control-btn">上一页</button><button id="projection-next-btn" class="display-control-btn">下一页</button>';
        host.appendChild(nav);
    }

    if (mode === "display" && !audienceDisplay) {
        const preview = document.createElement("div");
        preview.id = "display-card-preview";
        preview.style.cssText =
            "position:absolute;left:20px;right:20px;bottom:72px;display:flex;gap:8px;overflow:auto;justify-content:center;z-index:3;padding:4px;flex:1 1 auto;";
        host.appendChild(preview);
    }

};
function initDisplayMode() {
    globalThis.projectionMode = "display";
    const audienceDisplay =
        typeof location !== "undefined" &&
        new URLSearchParams(location.search || "").get("display") === "1";

    if (audienceDisplay) {
        try {
            document.body.classList.add("worship-audience-projection");
        } catch (_e) {
            /* ignore */
        }
        const pmMon = document.getElementById("projection-preview-monitor");
        if (pmMon) pmMon.style.display = "none";
    }

    globalThis.installProjectionUI("display");
    if (audienceDisplay) {
        document.getElementById("display-card-preview")?.remove();
        document.getElementById("projection-prev-btn")?.parentElement?.remove();
    }

    const initState = globalThis.getStore("worship.live.v5", null);
    if (initState) globalThis.applyLive("display", initState);
    const onPrev = () => globalThis.__projectionChannel && globalThis.__projectionChannel.postMessage({ type: "flip", delta: -1 });
    const onNext = () => globalThis.__projectionChannel && globalThis.__projectionChannel.postMessage({ type: "flip", delta: 1 });
    document.getElementById("projection-prev-btn")?.addEventListener("click", onPrev);
    document.getElementById("projection-next-btn")?.addEventListener("click", onNext);

    const host = document.getElementById("projection-host");

    if (audienceDisplay) {
        const esc = globalThis.escapeHtml || function (s) {
            return String(s ?? "");
        };

        let projectionHelpPanel = null;
        let projectionHelpHideTimer = 0;
        let projectionGuideOverlay = null;
        let projectionWasFs = false;
        let projectionCursorIdleTimer = 0;

        function requestProjectionFullscreen() {
            const el = host || document.documentElement;
            const req =
                el.requestFullscreen ||
                el.webkitRequestFullscreen ||
                el.msRequestFullscreen;
            if (!req) return Promise.reject(new Error("fullscreen"));
            return Promise.resolve(req.call(el));
        }

        function clearProjectionCenterMsgs() {
            document.querySelectorAll("[data-projection-center-msg]").forEach((n) => n.remove());
        }

        function showProjectionCenterFadeMessage(text, visibleMs) {
            clearProjectionCenterMsgs();
            const wrap = document.createElement("div");
            wrap.setAttribute("data-projection-center-msg", "1");
            wrap.style.cssText = [
                "position:fixed",
                "inset:0",
                "z-index:100003",
                "display:flex",
                "align-items:center",
                "justify-content:center",
                "pointer-events:none",
                "padding:24px"
            ].join(";");
            const inner = document.createElement("div");
            inner.textContent = text;
            inner.style.cssText = [
                "max-width:92vw",
                "text-align:center",
                "color:#fff",
                "font-size:clamp(22px,4.2vw,36px)",
                "font-weight:700",
                "line-height:1.35",
                "text-shadow:0 2px 28px rgba(0,0,0,0.85)",
                "opacity:0",
                "transition:opacity .45s ease"
            ].join(";");
            wrap.appendChild(inner);
            document.body.appendChild(wrap);
            requestAnimationFrame(() => {
                inner.style.opacity = "1";
            });
            setTimeout(() => {
                inner.style.opacity = "0";
            }, visibleMs);
            setTimeout(() => wrap.remove(), visibleMs + 500);
        }

        function showProjectionReadyToast() {
            showProjectionCenterFadeMessage("✅ 投屏就绪 · 请在控制台翻页", 2000);
        }

        function showProjectionRestoreFsHint() {
            showProjectionCenterFadeMessage("按 F 键恢复全屏", 3000);
        }

        function hideProjectionHelpPanel() {
            if (projectionHelpHideTimer) {
                clearTimeout(projectionHelpHideTimer);
                projectionHelpHideTimer = 0;
            }
            if (projectionHelpPanel) {
                projectionHelpPanel.remove();
                projectionHelpPanel = null;
            }
        }

        function showProjectionHelpPanel() {
            hideProjectionHelpPanel();
            const wrap = document.createElement("div");
            wrap.setAttribute("data-projection-help", "1");
            wrap.style.cssText = [
                "position:fixed",
                "inset:0",
                "z-index:100001",
                "display:flex",
                "align-items:center",
                "justify-content:center",
                "padding:16px",
                "background:rgba(0,0,0,0.5)"
            ].join(";");
            const inner = document.createElement("div");
            inner.style.cssText = [
                "width:min(96vw,720px)",
                "max-height:85vh",
                "overflow:auto",
                "background:rgba(18,22,32,0.96)",
                "color:#e8ecff",
                "border-radius:14px",
                "padding:20px 22px",
                "box-shadow:0 12px 40px rgba(0,0,0,0.5)",
                "font-size:13px",
                "line-height:1.45"
            ].join(";");
            const winRows = [
                ["F", "全屏"],
                ["Win+P", "切换屏幕"],
                ["Win+Shift+→", "移动窗口"],
                ["Esc", "退出全屏"],
                ["B / W", "黑屏 / 白屏"]
            ];
            const macRows = [
                ["Control+Command+F", "全屏"],
                ["Option+F1", "切换屏幕"],
                ["Shift+Option+Command+→", "移动窗口"],
                ["Esc", "退出全屏"],
                ["B / W", "黑屏 / 白屏"]
            ];
            function colHtml(title, rows) {
                let ul =
                    '<div style="opacity:.75;font-weight:600;margin-bottom:8px;">' +
                    esc(title) +
                    '</div><ul style="margin:0;padding-left:1.15em;">';
                rows.forEach(([k, v]) => {
                    ul += "<li><b>" + esc(k) + "</b> — " + esc(v) + "</li>";
                });
                ul += "</ul>";
                return ul;
            }
            inner.innerHTML =
                '<div style="font-size:17px;font-weight:700;margin-bottom:14px;">' +
                esc("快捷键说明") +
                "</div>" +
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">' +
                "<div>" +
                colHtml("Windows", winRows) +
                "</div><div>" +
                colHtml("Mac", macRows) +
                "</div></div>" +
                '<div style="margin-top:14px;opacity:.78;font-size:12px;text-align:center;line-height:1.5;">' +
                esc("按 H 可再次打开 · 8 秒后自动关闭") +
                "<br/>" +
                esc("因浏览器安全策略限制，暂不支持一键自动投屏") +
                "</div>";
            wrap.appendChild(inner);
            wrap.addEventListener("click", (e) => {
                if (e.target === wrap) hideProjectionHelpPanel();
            });
            document.body.appendChild(wrap);
            projectionHelpPanel = wrap;
            projectionHelpHideTimer = setTimeout(hideProjectionHelpPanel, 8000);
        }

        function removeProjectionGuideOverlay() {
            if (projectionGuideOverlay) {
                projectionGuideOverlay.remove();
                projectionGuideOverlay = null;
            }
        }

        function showProjectionGuideOverlay() {
            if (projectionGuideOverlay || !host) return;
            const wrap = document.createElement("div");
            wrap.setAttribute("data-projection-fs-guide", "1");
            wrap.style.cssText = "position:fixed;inset:0;z-index:100000;pointer-events:none;";
            const btn = document.createElement("button");
            btn.type = "button";
            btn.setAttribute("aria-label", "全屏投屏");
            btn.textContent = "📺";
            btn.style.cssText = [
                "position:fixed",
                "left:50%",
                "top:50%",
                "transform:translate(-50%,-50%)",
                "width:100px",
                "height:100px",
                "border-radius:50%",
                "border:2px solid rgba(255,255,255,0.35)",
                "padding:0",
                "cursor:pointer",
                "pointer-events:auto",
                "font-size:52px",
                "line-height:1",
                "display:flex",
                "align-items:center",
                "justify-content:center",
                "background:rgba(30,36,54,0.72)",
                "box-shadow:0 10px 40px rgba(0,0,0,0.55)",
                "backdrop-filter:blur(8px)",
                "color:#fff"
            ].join(";");
            btn.addEventListener("click", () => {
                requestProjectionFullscreen().catch(() => {});
            });
            wrap.appendChild(btn);
            projectionGuideOverlay = wrap;
            document.body.appendChild(wrap);
        }

        function clearAudienceCursorState() {
            document.body.style.cursor = "";
            if (projectionCursorIdleTimer) {
                clearTimeout(projectionCursorIdleTimer);
                projectionCursorIdleTimer = 0;
            }
        }

        function scheduleAudienceCursorHide() {
            const target = host || document.documentElement;
            const inFs =
                (document.fullscreenElement || document.webkitFullscreenElement) === target;
            if (!inFs) return;
            if (projectionCursorIdleTimer) clearTimeout(projectionCursorIdleTimer);
            projectionCursorIdleTimer = setTimeout(() => {
                document.body.style.cursor = "none";
            }, 2000);
        }

        function onAudiencePointerMove() {
            document.body.style.cursor = "";
            scheduleAudienceCursorHide();
        }

        function onAudienceContextMenu(e) {
            e.preventDefault();
        }

        function onProjectionFullscreenChange() {
            const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
            const target = host || document.documentElement;
            if (fsEl === target) {
                projectionWasFs = true;
                removeProjectionGuideOverlay();
                showProjectionReadyToast();
                clearAudienceCursorState();
                scheduleAudienceCursorHide();
            } else if (projectionWasFs) {
                projectionWasFs = false;
                clearAudienceCursorState();
                showProjectionRestoreFsHint();
            }
        }

        document.addEventListener("fullscreenchange", onProjectionFullscreenChange);
        document.addEventListener("webkitfullscreenchange", onProjectionFullscreenChange);
        document.addEventListener("mousemove", onAudiencePointerMove);
        document.addEventListener("contextmenu", onAudienceContextMenu);

        requestProjectionFullscreen().catch(() => {
            showProjectionGuideOverlay();
        });

        document.addEventListener("keydown", (e) => {
            const tag = (e.target && e.target.tagName) || "";
            const typing =
                tag === "INPUT" ||
                tag === "TEXTAREA" ||
                (e.target && e.target.isContentEditable);
            if (!typing) {
                if (e.key === "f" || e.key === "F") {
                    e.preventDefault();
                    requestProjectionFullscreen().catch(() => {
                        showProjectionGuideOverlay();
                    });
                }
                if (e.key === "h" || e.key === "H") {
                    e.preventDefault();
                    showProjectionHelpPanel();
                }
            }
        });
    }

    document.addEventListener("keydown", (e) => {
        if (e.key === "ArrowLeft") onPrev();
        if (e.key === "ArrowRight") onNext();
    });

    if (globalThis.__projectionChannel) {
        globalThis.__projectionChannel.onmessage = (e) => {
            const d = e.data;
            if (d && d.type === "main_projection_end" && d.source === "main") {
                try {
                    window.close();
                } catch (_e) {
                    /* ignore */
                }
                return;
            }
            if (d && d.type === "update" && d.payload && d.payload.pages) {
                globalThis.applyLive("display", d.payload);
            }
        };
        globalThis.__projectionChannel.postMessage({ type: "request_state" });
    }

    window.addEventListener("storage", (e) => {
        if (e.key === "worship.live.v5" && e.newValue) globalThis.applyLive("display", globalThis.parseJSON(e.newValue, null));
    });
    window.addEventListener("resize", () => {
        if (projectionDisplayIsVideoBackground(globalThis.liveState)) {
            globalThis.updateDisplayCardPreview();
            return;
        }
        globalThis.restartBg();
        globalThis.updateDisplayCardPreview();
    });

}
function initLeaderView() {
    {
        globalThis.projectionMode = "leader";
        document.title = "主领视角";
        globalThis.installProjectionUI("leader");
        const NOTES_KEY = "leader_notes";
        const DISPLAY_MODE_KEY = "leader_display_mode";
        const BG_MODE_KEY = "leader_bg_mode";
        const TOOLBAR_COLLAPSED_KEY = "leader_toolbar_collapsed";
        const FONT_SIZE_KEY = "leader_font_size";
        const host = document.getElementById("projection-host");
        const lyricLayer = document.getElementById("projection-lyric");
        const bgCanvas = document.getElementById("projection-bg");
        const bgImg = document.getElementById("projection-bg-image");
        const oldNav = document.getElementById("projection-prev-btn")?.parentElement;
        if (!host || !lyricLayer || !bgCanvas) return;
        if (bgImg) bgImg.style.display = "none";
        if (oldNav) oldNav.style.display = "none";
        if (globalThis.projectionRaf) {
            cancelAnimationFrame(globalThis.projectionRaf);
            globalThis.projectionRaf = 0;
        }

        let displayMode = localStorage.getItem(DISPLAY_MODE_KEY) || "multi";
        if (!["single", "multi", "scroll"].includes(displayMode)) displayMode = "multi";
        let bgMode = localStorage.getItem(BG_MODE_KEY) || "particles";
        if (!["black", "particles"].includes(bgMode)) bgMode = "particles";
        let noteEditMode = false;
        const migrateLeaderNotes = (raw) => {
            const out = {};
            if (!raw || typeof raw !== "object") return out;
            Object.keys(raw).forEach((k) => {
                const v = raw[k];
                if (typeof v === "string") {
                    const t = v.trim();
                    if (t) out[k] = { note: t, icon: "💬" };
                } else if (v && typeof v === "object") {
                    const t = String(v.note || "").trim();
                    if (t) out[k] = { note: t, icon: String(v.icon || "💬") };
                }
            });
            return out;
        };
        const notesMapRaw = globalThis.getStore(NOTES_KEY, {});
        let notesMap = migrateLeaderNotes(notesMapRaw);
        if (JSON.stringify(notesMapRaw) !== JSON.stringify(notesMap)) globalThis.setStore(NOTES_KEY, notesMap);
        let overlay = null;
        let bgLoop = 0;
        let pts = [];
        let touchStartX = 0;
        let hideTimer = 0;
        let toolbarCollapsed = localStorage.getItem(TOOLBAR_COLLAPSED_KEY) === "1";
        if (localStorage.getItem(TOOLBAR_COLLAPSED_KEY) === null && window.innerWidth < 480) toolbarCollapsed = true;
        let brushMode = false;
        let brushDrawing = false;
        let brushCanvas = null;
        let brushCtx = null;
        let lastPoint = null;
        let brushColor = "#ffff00";
        let brushWidth = 4;
        let brushPanel = null;
        let bgPanel = null;
        let fontPanel = null;
        let fontHideTimer = 0;
        let currentPageKey = "";
        const pageDrawings = {};
        let leaderFontSize = localStorage.getItem(FONT_SIZE_KEY) || "5vw";
        const parsedLeaderFont = parseFloat(leaderFontSize);
        if (!Number.isFinite(parsedLeaderFont) || parsedLeaderFont < 3 || parsedLeaderFont > 8) leaderFontSize = "5vw";
        let touchStartY = 0;
        let swipeFromBottomY = null;
        let mouseBottomStartY = null;
        const leaderTabletRange = window.matchMedia("(min-width: 768px) and (max-width: 1024px)");
        const leaderBottomSwipeBand = () => (leaderTabletRange.matches ? 140 : 100);
        const leaderBottomSwipeMinDy = () => (leaderTabletRange.matches ? 36 : 20);

        host.classList.add("leader-host");
        lyricLayer.classList.add("leader-lyric-shell");
        lyricLayer.style.cssText = "";

        const leftArrow = document.createElement("button");
        leftArrow.className = "leader-side-arrow left";
        leftArrow.textContent = "<";
        const rightArrow = document.createElement("button");
        rightArrow.className = "leader-side-arrow right";
        rightArrow.textContent = ">";
        host.appendChild(leftArrow);
        host.appendChild(rightArrow);

        const toolbar = document.createElement("div");
        toolbar.className = "leader-toolbar";
        toolbar.innerHTML = '<button class="leader-mini-btn" data-mode="single" title="单句"><span class="leader-btn-icon">🔍</span><span class="leader-btn-label">单句</span></button><button class="leader-mini-btn" data-mode="multi" title="多句"><span class="leader-btn-icon">📋</span><span class="leader-btn-label">多句</span></button><button class="leader-mini-btn" data-mode="scroll" title="滚动"><span class="leader-btn-icon">📜</span><span class="leader-btn-label">滚动</span></button><button class="leader-mini-btn" data-action="prev" title="上一页"><span class="leader-btn-icon">◀</span><span class="leader-btn-label">上页</span></button><button class="leader-mini-btn" data-action="next" title="下一页"><span class="leader-btn-icon">▶</span><span class="leader-btn-label">下页</span></button><button class="leader-mini-btn" data-action="font-panel" title="字号"><span class="leader-btn-icon leader-font-aa">Aa</span><span class="leader-btn-label">字号</span></button><button class="leader-mini-btn" data-action="note" title="备注"><span class="leader-btn-icon">✏️</span><span class="leader-btn-label">备注</span></button><button class="leader-mini-btn leader-brush-btn" data-action="brush" title="标注"><span class="leader-btn-icon">✍️</span><span class="leader-btn-label">画笔</span><span class="leader-brush-indicator"></span></button><button class="leader-mini-btn" data-action="bg-panel" title="背景"><span class="leader-btn-icon">🎨</span><span class="leader-btn-label">背景</span></button>';
        host.appendChild(toolbar);
        const toolbarRail = document.createElement("div");
        toolbarRail.className = "leader-toolbar-rail";
        toolbarRail.innerHTML = '<button type="button" class="leader-expand-fab" aria-label="展开工具栏"><span class="leader-expand-fab-icon">∨</span></button>';
        host.appendChild(toolbarRail);

        const hideFontPanel = () => {
            if (fontHideTimer) {
                clearTimeout(fontHideTimer);
                fontHideTimer = 0;
            }
            if (fontPanel) fontPanel.style.display = "none";
        };
        const positionFontPanel = () => {
            if (!fontPanel || fontPanel.style.display === "none") return;
            const aaBtn = toolbar.querySelector('[data-action="font-panel"]');
            if (!aaBtn) return;
            const hostRect = host.getBoundingClientRect();
            const btnRect = aaBtn.getBoundingClientRect();
            const pw = fontPanel.offsetWidth || 160;
            const left = globalThis.clamp(btnRect.left + btnRect.width / 2 - pw / 2 - hostRect.left, 8, hostRect.width - pw - 8);
            const top = btnRect.top - hostRect.top - fontPanel.offsetHeight - 8;
            fontPanel.style.left = `${left}px`;
            fontPanel.style.top = `${Math.max(8, top)}px`;
        };
        const resetFontPanelHideTimer = () => {
            if (fontHideTimer) clearTimeout(fontHideTimer);
            fontHideTimer = setTimeout(() => hideFontPanel(), 3000);
        };
        const ensureFontPanel = () => {
            if (fontPanel) return;
            fontPanel = document.createElement("div");
            fontPanel.className = "leader-font-pop";
            fontPanel.innerHTML = '<input type="range" class="leader-font-range" min="3" max="8" step="0.1" aria-label="字号">';
            host.appendChild(fontPanel);
            const range = fontPanel.querySelector(".leader-font-range");
            range.addEventListener("input", () => {
                const v = globalThis.clamp(parseFloat(range.value) || 5, 3, 8);
                leaderFontSize = `${Number(v.toFixed(1))}vw`;
                localStorage.setItem(FONT_SIZE_KEY, leaderFontSize);
                render();
                resetFontPanelHideTimer();
                positionFontPanel();
            });
            fontPanel.addEventListener("mousedown", (e) => e.stopPropagation());
            fontPanel.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
        };
        const toggleFontPanel = () => {
            ensureFontPanel();
            if (fontPanel.style.display === "block") {
                hideFontPanel();
                return;
            }
            const range = fontPanel.querySelector(".leader-font-range");
            const parsed = parseFloat(leaderFontSize);
            range.value = String(Number.isFinite(parsed) ? globalThis.clamp(parsed, 3, 8) : 5);
            fontPanel.style.display = "block";
            positionFontPanel();
            resetFontPanelHideTimer();
        };
        const showToolbar = () => {
            if (brushMode) return;
            if (toolbarCollapsed) return;
            toolbar.classList.remove("hidden");
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setTimeout(() => setToolbarCollapsed(true), 3000);
        };
        const setToolbarCollapsed = (collapsed) => {
            toolbarCollapsed = !!collapsed;
            localStorage.setItem(TOOLBAR_COLLAPSED_KEY, toolbarCollapsed ? "1" : "0");
            toolbar.classList.toggle("collapsed", toolbarCollapsed);
            toolbarRail.classList.toggle("active", toolbarCollapsed);
            if (toolbarCollapsed) hideFontPanel();
            if (!toolbarCollapsed) {
                toolbar.classList.remove("hidden");
                showToolbar();
            }
        };
        const saveNote = (lineIndex, note) => {
            const key = String(lineIndex);
            const text = String(note || "").trim();
            if (!text) delete notesMap[key];
            else notesMap[key] = { note: text, icon: "💬" };
            globalThis.setStore(NOTES_KEY, notesMap);
        };
        const loadNote = (lineIndex) => {
            const v = notesMap[String(lineIndex)];
            if (v == null) return "";
            if (typeof v === "string") return v;
            return String(v.note || "");
        };
        const loadNoteRecord = (lineIndex) => {
            const v = notesMap[String(lineIndex)];
            if (v == null) return null;
            if (typeof v === "string") {
                const t = v.trim();
                return t ? { note: t, icon: "💬" } : null;
            }
            const t = String(v.note || "").trim();
            return t ? { note: t, icon: String(v.icon || "💬") } : null;
        };
        const closeOverlay = () => {
            if (overlay?.parentNode) overlay.parentNode.removeChild(overlay);
            overlay = null;
        };
        const getPages = () => {
            const pages = Array.isArray(globalThis.liveState?.pages) ? globalThis.liveState.pages : [];
            const idx = globalThis.clamp(globalThis.liveState?.pageIndex || 0, 0, Math.max(0, pages.length - 1));
            return { pages, idx };
        };
        const globalIndex = (pages, pageIndex, lineIndex) => pages.slice(0, pageIndex).reduce((n, p) => n + (p || []).length, 0) + lineIndex;
        const buildPageKey = () => {
            const { idx } = getPages();
            const song = String(globalThis.liveState?.title || "");
            return `${song}::${idx}`;
        };
        const updateBrushIndicator = () => {
            const indicator = toolbar.querySelector(".leader-brush-indicator");
            if (!indicator) return;
            indicator.style.display = brushMode ? "block" : "none";
            indicator.style.background = brushColor;
            const size = globalThis.clamp(brushWidth + 2, 4, 8);
            indicator.style.width = `${size}px`;
            indicator.style.height = `${size}px`;
        };
        const saveCurrentDrawing = () => {
            if (!brushCanvas || !currentPageKey) return;
            pageDrawings[currentPageKey] = brushCanvas.toDataURL("image/png");
        };
        const restoreCurrentDrawing = () => {
            if (!brushCanvas || !brushCtx) return;
            const dataUrl = pageDrawings[currentPageKey];
            if (!dataUrl) return;
            const img = new Image();
            img.onload = () => {
                brushCtx.clearRect(0, 0, brushCanvas.width, brushCanvas.height);
                brushCtx.drawImage(img, 0, 0, brushCanvas.width, brushCanvas.height);
            };
            img.src = dataUrl;
        };
        const hideBrushPanel = () => {
            if (brushPanel) brushPanel.style.display = "none";
        };
        const hideBgPanel = () => {
            if (bgPanel) bgPanel.style.display = "none";
        };
        const syncBrushPanelActiveState = () => {
            if (!brushPanel) return;
            brushPanel.querySelectorAll("[data-brush-color]").forEach((el) => {
                el.classList.toggle("active", el.getAttribute("data-brush-color") === brushColor);
            });
            brushPanel.querySelectorAll("[data-brush-width]").forEach((el) => {
                el.classList.toggle("active", Number(el.getAttribute("data-brush-width")) === brushWidth);
            });
        };
        const updateBrushPanelPosition = () => {
            if (!brushPanel || brushPanel.style.display === "none") return;
            const hostRect = host.getBoundingClientRect();
            const panelWidth = brushPanel.offsetWidth || 360;
            const left = globalThis.clamp(hostRect.width / 2 - panelWidth / 2, 8, hostRect.width - panelWidth - 8);
            const top = hostRect.height - brushPanel.offsetHeight - 72;
            brushPanel.style.left = `${left}px`;
            brushPanel.style.top = `${Math.max(8, top)}px`;
        };
        const showBgPanel = () => {
            if (!bgPanel) return;
            const bgBtn = toolbar.querySelector('[data-action="bg-panel"]');
            if (!bgBtn) return;
            bgPanel.style.display = "block";
            const hostRect = host.getBoundingClientRect();
            const btnRect = bgBtn.getBoundingClientRect();
            const panelWidth = bgPanel.offsetWidth || 170;
            const left = globalThis.clamp(btnRect.left + btnRect.width / 2 - panelWidth / 2 - hostRect.left, 8, hostRect.width - panelWidth - 8);
            const top = btnRect.top - hostRect.top - bgPanel.offsetHeight - 6;
            bgPanel.style.left = `${left}px`;
            bgPanel.style.top = `${Math.max(8, top)}px`;
            bgPanel.querySelectorAll("[data-bg]").forEach((btn) => btn.classList.toggle("active", btn.getAttribute("data-bg") === bgMode));
        };
        const showBrushPanel = () => {
            if (!brushPanel) return;
            brushPanel.style.display = "block";
            syncBrushPanelActiveState();
            updateBrushPanelPosition();
        };
        const ensureBrushPanel = () => {
            if (brushPanel) return;
            brushPanel = document.createElement("div");
            brushPanel.className = "leader-brush-panel";
            brushPanel.innerHTML = '<div class="leader-brush-row"><button class="leader-brush-color" data-brush-color="#ffff00" style="background:#ffff00;" title="黄色"></button><button class="leader-brush-color" data-brush-color="#ff6666" style="background:#ff6666;" title="红色"></button><button class="leader-brush-color" data-brush-color="#66ccff" style="background:#66ccff;" title="蓝色"></button><button class="leader-brush-color" data-brush-color="#ffffff" style="background:#ffffff;" title="白色"></button><button class="leader-brush-color" data-brush-color="#66ff66" style="background:#66ff66;" title="绿色"></button><button class="leader-brush-color" data-brush-color="#cc66ff" style="background:#cc66ff;" title="紫色"></button></div><div class="leader-brush-row"><button class="leader-brush-width" data-brush-width="2" title="细">2px</button><button class="leader-brush-width" data-brush-width="4" title="中">4px</button><button class="leader-brush-width" data-brush-width="6" title="粗">6px</button><button class="leader-brush-clear" data-action="clear-brush" title="清除">🗑️</button><button class="leader-brush-done" data-action="done-brush" title="完成">✅</button></div>';
            host.appendChild(brushPanel);
            brushPanel.addEventListener("click", (e) => {
                if (e.target.closest("[data-action='done-brush']")) {
                    setBrushMode(false);
                    return;
                }
                const colorBtn = e.target.closest("[data-brush-color]");
                if (colorBtn) {
                    brushColor = colorBtn.getAttribute("data-brush-color") || "#ffff00";
                    syncBrushPanelActiveState();
                    updateBrushIndicator();
                    hideBrushPanel();
                    return;
                }
                const widthBtn = e.target.closest("[data-brush-width]");
                if (widthBtn) {
                    brushWidth = Number(widthBtn.getAttribute("data-brush-width")) || 4;
                    syncBrushPanelActiveState();
                    updateBrushIndicator();
                    hideBrushPanel();
                    return;
                }
                if (e.target.closest("[data-action='clear-brush']")) {
                    if (brushCtx && brushCanvas) {
                        brushCtx.clearRect(0, 0, brushCanvas.width, brushCanvas.height);
                        saveCurrentDrawing();
                    }
                    hideBrushPanel();
                }
            });
        };
        const ensureBgPanel = () => {
            if (bgPanel) return;
            bgPanel = document.createElement("div");
            bgPanel.className = "leader-bg-panel";
            bgPanel.innerHTML = '<button class="leader-bg-item" data-bg="black">🌙 纯黑</button><button class="leader-bg-item" data-bg="particles">✨ 粒子</button>';
            host.appendChild(bgPanel);
            bgPanel.addEventListener("click", (e) => {
                const btn = e.target.closest("[data-bg]");
                if (!btn) return;
                bgMode = btn.getAttribute("data-bg") || "black";
                localStorage.setItem(BG_MODE_KEY, bgMode);
                applyBg();
                hideBgPanel();
            });
        };
        const getCanvasPoint = (ev) => {
            if (!brushCanvas) return null;
            const rect = brushCanvas.getBoundingClientRect();
            const p = ev.touches?.[0] || ev.changedTouches?.[0] || ev;
            return { x: p.clientX - rect.left, y: p.clientY - rect.top };
        };
        const beginBrush = (ev) => {
            if (!brushMode || !brushCtx) return;
            brushDrawing = true;
            lastPoint = getCanvasPoint(ev);
            ev.preventDefault();
        };
        const moveBrush = (ev) => {
            if (!brushMode || !brushDrawing || !brushCtx) return;
            const pt = getCanvasPoint(ev);
            if (!pt || !lastPoint) return;
            brushCtx.strokeStyle = brushColor;
            brushCtx.lineWidth = brushWidth;
            brushCtx.lineCap = "round";
            brushCtx.beginPath();
            brushCtx.moveTo(lastPoint.x, lastPoint.y);
            brushCtx.lineTo(pt.x, pt.y);
            brushCtx.stroke();
            lastPoint = pt;
            ev.preventDefault();
        };
        const endBrush = () => {
            brushDrawing = false;
            lastPoint = null;
            if (brushMode) saveCurrentDrawing();
        };
        const setupBrushCanvas = () => {
            const previousKey = currentPageKey;
            currentPageKey = buildPageKey();
            if (previousKey && previousKey !== currentPageKey) saveCurrentDrawing();

            const mount = lyricLayer.querySelector(".leader-brush-mount");
            if (!mount) return;

            if (!brushCanvas) {
                brushCanvas = document.createElement("canvas");
                brushCanvas.className = "leader-brush-canvas";
                brushCtx = brushCanvas.getContext("2d");
                brushCanvas.addEventListener("mousedown", beginBrush);
                brushCanvas.addEventListener("mousemove", moveBrush);
                window.addEventListener("mouseup", endBrush);
                brushCanvas.addEventListener("touchstart", beginBrush, { passive: false });
                const brushWindowTouchMove = (ev) => {
                    if (!brushMode || !brushDrawing || !brushCtx) return;
                    moveBrush(ev);
                };
                window.addEventListener("touchmove", brushWindowTouchMove, { passive: false });
                window.addEventListener("touchend", endBrush, { passive: true });
                window.addEventListener("touchcancel", endBrush, { passive: true });
                mount.appendChild(brushCanvas);
            } else if (brushCanvas.parentNode !== mount) {
                mount.appendChild(brushCanvas);
            }

            const dpr = Math.max(1, window.devicePixelRatio || 1);
            const cssW = Math.max(1, Math.ceil(mount.scrollWidth));
            const cssH = Math.max(1, Math.ceil(mount.scrollHeight));
            const nextW = Math.max(1, Math.floor(cssW * dpr));
            const nextH = Math.max(1, Math.floor(cssH * dpr));
            const needResize = brushCanvas.width !== nextW || brushCanvas.height !== nextH;

            if (needResize) {
                saveCurrentDrawing();
                brushCanvas.width = nextW;
                brushCanvas.height = nextH;
                brushCanvas.style.width = `${cssW}px`;
                brushCanvas.style.height = `${cssH}px`;
                brushCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
                brushCtx.clearRect(0, 0, brushCanvas.width, brushCanvas.height);
                if (pageDrawings[currentPageKey]) restoreCurrentDrawing();
            }

            brushCanvas.style.position = "absolute";
            brushCanvas.style.left = "0";
            brushCanvas.style.top = "0";
            brushCanvas.style.display = "block";
            brushCanvas.style.visibility = "visible";
            brushCanvas.style.pointerEvents = brushMode ? "auto" : "none";
        };
        const setBrushMode = (enabled) => {
            brushMode = !!enabled;
            toolbar.querySelector('[data-action="brush"]')?.classList.toggle("active", brushMode);
            if (brushMode) {
                if (hideTimer) {
                    clearTimeout(hideTimer);
                    hideTimer = 0;
                }
                hideFontPanel();
                toolbar.classList.add("brush-hidden");
                setToolbarCollapsed(false);
                ensureBrushPanel();
                hideBgPanel();
                showBrushPanel();
            } else {
                saveCurrentDrawing();
                toolbar.classList.remove("brush-hidden");
                hideBrushPanel();
                showToolbar();
            }
            setupBrushCanvas();
            updateBrushIndicator();
        };
        function toggleDrawMode() {
            setBrushMode(!brushMode);
        }

        function openNote(lineIndex, readOnly, anchorEl) {
            closeOverlay();
            const wrap = document.createElement("div");
            wrap.className = "leader-note-pop-wrap";
            wrap.dataset.noteReadonly = readOnly ? "1" : "0";
            const box = document.createElement("div");
            box.className = "leader-note-pop";
            box.style.width = "300px";
            const rec = loadNoteRecord(lineIndex);
            const noteVal = rec ? rec.note : "";
            const closeBtn = document.createElement("button");
            closeBtn.type = "button";
            closeBtn.className = "leader-note-close";
            closeBtn.textContent = "✕";
            closeBtn.addEventListener("click", closeOverlay);
            box.appendChild(closeBtn);
            if (readOnly) {
                const view = document.createElement("div");
                view.className = "leader-note-view";
                view.textContent = rec ? `${rec.icon} ${rec.note}` : "（无备注）";
                box.appendChild(view);
            } else {
                box.insertAdjacentHTML("beforeend", '<textarea class="leader-note-input"></textarea><div class="leader-note-actions"><button class="leader-note-btn">保存</button><button class="leader-note-btn secondary">取消</button></div>');
                const ta = box.querySelector(".leader-note-input");
                ta.value = noteVal;
                box.querySelector(".leader-note-btn")?.addEventListener("click", () => {
                    saveNote(lineIndex, ta.value);
                    closeOverlay();
                    render();
                });
                box.querySelector(".leader-note-btn.secondary")?.addEventListener("click", closeOverlay);
            }
            wrap.appendChild(box);
            wrap.addEventListener("click", (e) => {
                if (e.target !== wrap) return;
                closeOverlay();
                if (!readOnly) {
                    noteEditMode = false;
                    render();
                }
            });
            document.body.appendChild(wrap);
            if (anchorEl) {
                const rect = anchorEl.getBoundingClientRect();
                const left = globalThis.clamp(rect.left + rect.width / 2 - 150, 12, window.innerWidth - 312);
                const top = globalThis.clamp(rect.bottom + 8, 12, window.innerHeight - 240);
                box.style.position = "absolute";
                box.style.left = `${left}px`;
                box.style.top = `${top}px`;
            }
            overlay = wrap;
        }

        function drawBgLeader(ts) {
            if (bgMode !== "particles") return;
            globalThis.ensureProjectionCanvas();
            const ctx = globalThis.projectionCtx;
            if (!ctx) return;
            const w = window.innerWidth;
            const h = window.innerHeight;
            const g = ctx.createRadialGradient(w * 0.5, h * 0.45, Math.min(w, h) * 0.1, w * 0.5, h * 0.55, Math.max(w, h) * 0.8);
            g.addColorStop(0, "#0f1f3f");
            g.addColorStop(1, "#000");
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
            if (pts.length !== PARTICLE_BG_COUNT) {
                pts = globalThis.createAmbientParticles(w, h, PARTICLE_BG_COUNT);
            }
            const dt = globalThis.clamp((ts - (globalThis.projectionLastTs || ts)) / 16.67, 0.5, 1.8);
            globalThis.projectionLastTs = ts;
            pts.forEach((p) => {
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                if (p.x < 0 || p.x > w) p.vx *= -1;
                if (p.y < 0 || p.y > h) p.vy *= -1;
                p.x = globalThis.clamp(p.x, 0, w);
                p.y = globalThis.clamp(p.y, 0, h);
                globalThis.applyParticleShadow(ctx, p);
                globalThis.applyParticleFill(ctx, p);
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fill();
            });
            ctx.shadowBlur = 0;
            bgLoop = requestAnimationFrame(drawBgLeader);
        }

        function applyBg() {
            if (bgLoop) cancelAnimationFrame(bgLoop);
            bgLoop = 0;
            host.style.background = "#000";
            if (bgMode === "particles") {
                bgCanvas.style.display = "block";
                pts = [];
                globalThis.projectionLastTs = 0;
                bgLoop = requestAnimationFrame(drawBgLeader);
            } else {
                bgCanvas.style.display = "none";
            }
            bgPanel?.querySelectorAll("[data-bg]").forEach((btn) => btn.classList.toggle("active", btn.getAttribute("data-bg") === bgMode));
        }

        function render() {
            closeOverlay();
            const { pages, idx } = getPages();
            const lines = pages[idx] || [];
            const nextLine = pages[idx + 1]?.[0] || "（无）";
            const color = globalThis.liveState?.fontColor || globalThis.liveState?.text?.color || "#ffffff";
            const curStart = pages.slice(0, idx).reduce((n, p) => n + (p || []).length, 0);
            const curEnd = curStart + lines.length - 1;
            let content = "";
            if (displayMode === "single") {
                const gi = globalIndex(pages, idx, 0);
                content = `<div class="leader-brush-mount leader-brush-mount--fit"><div class="leader-current leader-single" style="color:${color};font-size:${leaderFontSize};"><div class="leader-line">${globalThis.escapeHtml(lines[0] || "...")}${!noteEditMode && loadNote(gi) ? `<span class="leader-note-dot" data-line="${gi}"></span>` : ""}${noteEditMode ? `<span class="leader-plus-dot" data-line="${gi}" title="添加备注">⊕</span>` : ""}</div></div></div>`;
            } else if (displayMode === "scroll") {
                const all = pages.flat();
                content = `<div class="leader-current leader-scroll" style="color:${color};font-size:${leaderFontSize};"><div class="leader-brush-mount leader-brush-mount--scroll">${all.map((line, i) => `<div class="leader-line${i >= curStart && i <= curEnd ? " current" : ""}" style="text-align:center;">${globalThis.escapeHtml(line)}${!noteEditMode && loadNote(i) ? `<span class="leader-note-dot" data-line="${i}"></span>` : ""}${noteEditMode ? `<span class="leader-plus-dot" data-line="${i}" title="添加备注">⊕</span>` : ""}</div>`).join("")}</div></div>`;
            } else {
                content = `<div class="leader-brush-mount leader-brush-mount--fit"><div class="leader-current leader-multi" style="color:${color};font-size:${leaderFontSize};">${lines.map((line, i) => {
                    const gi = globalIndex(pages, idx, i);
                    return `<div class="leader-line">${globalThis.escapeHtml(line)}${!noteEditMode && loadNote(gi) ? `<span class="leader-note-dot" data-line="${gi}"></span>` : ""}${noteEditMode ? `<span class="leader-plus-dot" data-line="${gi}" title="添加备注">⊕</span>` : ""}</div>`;
                }).join("") || "<div class='leader-line'>...</div>"}</div></div>`;
            }
            const nextHtml = displayMode === "scroll" ? "" : `<div class="leader-next">下句：${globalThis.escapeHtml(nextLine)}</div>`;
            host.classList.toggle("leader-scroll-mode", displayMode === "scroll");
            const mainClass = displayMode === "scroll" ? "leader-main leader-main-scroll" : "leader-main";
            lyricLayer.innerHTML = `<div class="leader-page">${idx + 1}/${Math.max(1, pages.length)}</div><div class="${mainClass}">${content}</div>${nextHtml}`;
            toolbar.querySelectorAll("[data-mode]").forEach((btn) => btn.classList.toggle("active", btn.getAttribute("data-mode") === displayMode));
            toolbar.querySelector('[data-action="note"]')?.classList.toggle("active", noteEditMode);
            requestAnimationFrame(() => setupBrushCanvas());
        }

        const flip = (delta) => globalThis.__projectionChannel && globalThis.__projectionChannel.postMessage({ type: "flip", delta });

        lyricLayer.addEventListener("click", (e) => {
            const plus = e.target.closest(".leader-plus-dot");
            if (plus) return openNote(Number(plus.getAttribute("data-line")) || 0, false, plus);
            const dot = e.target.closest(".leader-note-dot");
            if (dot) return openNote(Number(dot.getAttribute("data-line")) || 0, true, dot);
        });
        toolbar.addEventListener("click", (e) => {
            const btn = e.target.closest("button");
            if (!btn) return;
            if (btn.dataset.mode) {
                displayMode = btn.dataset.mode;
                localStorage.setItem(DISPLAY_MODE_KEY, displayMode);
                render();
            } else if (btn.dataset.bg) {
                bgMode = btn.dataset.bg;
                localStorage.setItem(BG_MODE_KEY, bgMode);
                applyBg();
            } else if (btn.dataset.action === "bg-panel") {
                ensureBgPanel();
                if (bgPanel?.style.display === "block") hideBgPanel();
                else showBgPanel();
            } else if (btn.dataset.action === "font-panel") {
                toggleFontPanel();
            } else if (btn.dataset.action === "note") {
                noteEditMode = !noteEditMode;
                closeOverlay();
                render();
            } else if (btn.dataset.action === "brush") {
                toggleDrawMode();
            } else if (btn.dataset.action === "prev") flip(-1);
            else if (btn.dataset.action === "next") flip(1);
            showToolbar();
        });
        toolbarRail.addEventListener("click", (e) => {
            e.stopPropagation();
            setToolbarCollapsed(false);
        });
        leftArrow.addEventListener("click", () => {
            flip(-1);
            showToolbar();
        });
        rightArrow.addEventListener("click", () => {
            flip(1);
            showToolbar();
        });
        host.addEventListener("touchstart", (e) => {
            if (toolbarCollapsed && !brushMode) setToolbarCollapsed(false);
            touchStartX = e.changedTouches?.[0]?.clientX || 0;
            touchStartY = e.changedTouches?.[0]?.clientY || 0;
            if (toolbarCollapsed && touchStartY > window.innerHeight - leaderBottomSwipeBand()) swipeFromBottomY = touchStartY;
            else swipeFromBottomY = null;
            showToolbar();
        }, { passive: true });
        host.addEventListener("touchend", (e) => {
            if (brushMode) return;
            const x = e.changedTouches?.[0]?.clientX || 0;
            const y = e.changedTouches?.[0]?.clientY || 0;
            const dx = x - touchStartX;
            const dy = y - touchStartY;
            if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) flip(dx < 0 ? 1 : -1);
            if (toolbarCollapsed && swipeFromBottomY != null && y < swipeFromBottomY - leaderBottomSwipeMinDy()) setToolbarCollapsed(false);
            swipeFromBottomY = null;
            showToolbar();
        }, { passive: true });
        host.addEventListener("dblclick", (e) => {
            if (!brushMode) return;
            if (e.target?.closest?.(".leader-brush-panel")) return;
            setBrushMode(false);
        });
        document.addEventListener("keydown", (e) => {
            if (!brushMode && e.key === "ArrowLeft") flip(-1);
            if (!brushMode && e.key === "ArrowRight") flip(1);
            if (brushMode && e.key === "Escape") setBrushMode(false);
            if (e.key === "Escape") closeOverlay();
            showToolbar();
        });
        document.addEventListener("mousemove", () => {
            if (toolbarCollapsed && !brushMode) {
                setToolbarCollapsed(false);
                return;
            }
            showToolbar();
        });
        host.addEventListener("mousedown", (e) => {
            if (brushMode || e.button !== 0) return;
            mouseBottomStartY = e.clientY > window.innerHeight - leaderBottomSwipeBand() ? e.clientY : null;
        });
        window.addEventListener("mouseup", (e) => {
            if (brushMode || mouseBottomStartY == null) return;
            if (toolbarCollapsed && e.clientY < mouseBottomStartY - leaderBottomSwipeMinDy()) setToolbarCollapsed(false);
            mouseBottomStartY = null;
        });
        document.addEventListener("click", (e) => {
            if (overlay && e.target === overlay && overlay.classList.contains("leader-note-pop-wrap")) {
                const ro = overlay.dataset.noteReadonly === "1";
                closeOverlay();
                if (!ro) {
                    noteEditMode = false;
                    render();
                }
            } else if (overlay && e.target === overlay) {
                closeOverlay();
            }
            if (fontPanel && fontPanel.style.display !== "none") {
                const inFont = e.target?.closest?.(".leader-font-pop");
                const inAa = e.target?.closest?.('[data-action="font-panel"]');
                if (!inFont && !inAa) hideFontPanel();
            }
            if (bgPanel && bgPanel.style.display !== "none") {
                const inBgPanel = e.target?.closest?.(".leader-bg-panel");
                const inBgBtn = e.target?.closest?.('[data-action="bg-panel"]');
                if (!inBgPanel && !inBgBtn) hideBgPanel();
            }
            if (toolbarCollapsed) {
                const inToolbar = e.target?.closest?.(".leader-toolbar");
                const inFab = e.target?.closest?.(".leader-expand-fab");
                if (!inToolbar && !inFab) setToolbarCollapsed(false);
            }
            showToolbar();
        });

        if (globalThis.__projectionChannel) {
            globalThis.__projectionChannel.onmessage = (e) => {
                if (e.data?.type === "update" && e.data.payload?.pages) {
                    globalThis.liveState = e.data.payload;
                    render();
                }
            };
            globalThis.__projectionChannel.postMessage({ type: "request_state" });
        }
        window.addEventListener("storage", (e) => {
            if (e.key === "worship.live.v5" && e.newValue) {
                const payload = globalThis.parseJSON(e.newValue, null);
                if (payload?.pages) {
                    globalThis.liveState = payload;
                    render();
                }
            }
        });
        window.addEventListener("resize", () => {
            applyBg();
            render();
            updateBrushPanelPosition();
            positionFontPanel();
            if (bgPanel?.style.display === "block") showBgPanel();
        });

        const initState = globalThis.getStore("worship.live.v5", null);
        if (initState?.pages) globalThis.liveState = initState;
        applyBg();
        render();
        setToolbarCollapsed(toolbarCollapsed);
        updateBrushIndicator();
        showToolbar();
        return;
    }
    globalThis.projectionMode = "leader";
    document.title = "主领视角";
    globalThis.installProjectionUI("leader");
    const NOTES_KEY = "leader_notes";
    const DISPLAY_MODE_KEY = "leader_display_mode";
    const BG_MODE_KEY = "leader_bg_mode";
    const host = document.getElementById("projection-host");
    const layer = document.getElementById("projection-lyric");
    const canvas = document.getElementById("projection-bg");
    const bgImage = document.getElementById("projection-bg-image");
    const nav = document.getElementById("projection-prev-btn")?.parentElement;
    if (!host || !layer || !canvas) return;
    if (bgImage) bgImage.style.display = "none";
    if (nav) nav.style.display = "none";
    if (globalThis.projectionRaf) { cancelAnimationFrame(globalThis.projectionRaf); globalThis.projectionRaf = 0; }
    host.classList.add("leader-host");
    layer.classList.add("leader-lyric-shell");
    layer.style.cssText = "";

    let displayMode = localStorage.getItem(DISPLAY_MODE_KEY) || "multi";
    if (!["single", "multi", "scroll"].includes(displayMode)) displayMode = "multi";
    let bgMode = localStorage.getItem(BG_MODE_KEY) || "particles";
    if (!["black", "particles"].includes(bgMode)) bgMode = "particles";
    let noteEditMode = false;
    let notesMap = globalThis.getStore(NOTES_KEY, {});
    let popup = null;
    let bgRaf = 0;
    let bgParticles = [];
    let hideTimer = 0;
    let touchStartX = 0;

    const leftArrow = document.createElement("button");
    leftArrow.className = "leader-side-arrow left";
    leftArrow.textContent = "<";
    const rightArrow = document.createElement("button");
    rightArrow.className = "leader-side-arrow right";
    rightArrow.textContent = ">";
    host.appendChild(leftArrow);
    host.appendChild(rightArrow);

    const toolbar = document.createElement("div");
    toolbar.className = "leader-toolbar";
    toolbar.innerHTML = [
        '<button class="leader-mini-btn" data-mode="single">🔍 单句模式</button>',
        '<button class="leader-mini-btn" data-mode="multi">📋 多句模式</button>',
        '<button class="leader-mini-btn" data-mode="scroll">📜 滚动模式</button>',
        '<button class="leader-mini-btn" data-action="prev">◀ 上一页</button>',
        '<button class="leader-mini-btn" data-action="next">▶ 下一页</button>',
        '<button class="leader-mini-btn" data-action="note">✏️ 备注</button>',
        '<button class="leader-mini-btn" data-bg="black">🌙 纯黑背景</button>',
        '<button class="leader-mini-btn" data-bg="particles">✨ 粒子背景</button>'
    ].join("");
    host.appendChild(toolbar);

    function showToolbar() {
        toolbar.classList.remove("hidden");
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => toolbar.classList.add("hidden"), 3000);
    }

    function saveNote(lineIndex, note) {
        notesMap[String(lineIndex)] = String(note || "").trim();
        if (!notesMap[String(lineIndex)]) delete notesMap[String(lineIndex)];
        globalThis.setStore(NOTES_KEY, notesMap);
    }
    function loadNote(lineIndex) { return String(notesMap[String(lineIndex)] || ""); }
    function closePopup() { if (popup?.parentNode) popup.parentNode.removeChild(popup); popup = null; }
    function getPagesAndIndex() {
        const pages = Array.isArray(globalThis.liveState?.pages) ? globalThis.liveState.pages : [];
        const idx = globalThis.clamp(globalThis.liveState?.pageIndex || 0, 0, Math.max(0, pages.length - 1));
        return { pages, idx };
    }
    function lineGlobalIndex(pages, pageIndex, lineIndex) {
        return pages.slice(0, pageIndex).reduce((n, p) => n + (p || []).length, 0) + lineIndex;
    }
    function openNoteEditor(lineIndex, readonly) {
        closePopup();
        const wrap = document.createElement("div");
        wrap.className = "leader-note-pop-wrap";
        const box = document.createElement("div");
        box.className = "leader-note-pop";
        const noteVal = loadNote(lineIndex);
        if (readonly) {
            box.innerHTML = `<div class="leader-note-view">${globalThis.escapeHtml(noteVal || "（无备注）")}</div>`;
        } else {
            box.innerHTML = '<textarea class="leader-note-input"></textarea><div class="leader-note-actions"><button class="leader-note-btn">保存</button><button class="leader-note-btn secondary">取消</button></div>';
            const ta = box.querySelector(".leader-note-input");
            ta.value = noteVal;
            box.querySelector(".leader-note-btn")?.addEventListener("click", () => {
                saveNote(lineIndex, ta.value);
                closePopup();
                render();
            });
            box.querySelector(".leader-note-btn.secondary")?.addEventListener("click", closePopup);
        }
        wrap.appendChild(box);
        wrap.addEventListener("click", (e) => { if (e.target === wrap) closePopup(); });
        document.body.appendChild(wrap);
        popup = wrap;
    }

    function drawLeaderBackground(ts) {
        if (bgMode !== "particles") return;
        globalThis.ensureProjectionCanvas();
        const ctx = globalThis.projectionCtx;
        if (!ctx) return;
        const w = window.innerWidth;
        const h = window.innerHeight;
        const g = ctx.createRadialGradient(w * 0.5, h * 0.45, Math.min(w, h) * 0.1, w * 0.5, h * 0.55, Math.max(w, h) * 0.8);
        g.addColorStop(0, "#0f1f3f");
        g.addColorStop(1, "#000000");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        if (bgParticles.length !== PARTICLE_BG_COUNT) {
            bgParticles = globalThis.createAmbientParticles(w, h, PARTICLE_BG_COUNT);
        }
        const dt = globalThis.clamp((ts - (globalThis.projectionLastTs || ts)) / 16.67, 0.5, 1.8);
        globalThis.projectionLastTs = ts;
        bgParticles.forEach((p) => {
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            if (p.x < 0 || p.x > w) p.vx *= -1;
            if (p.y < 0 || p.y > h) p.vy *= -1;
            p.x = globalThis.clamp(p.x, 0, w);
            p.y = globalThis.clamp(p.y, 0, h);
            globalThis.applyParticleShadow(ctx, p);
            globalThis.applyParticleFill(ctx, p);
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.shadowBlur = 0;
        bgRaf = requestAnimationFrame(drawLeaderBackground);
    }
    function applyBackgroundMode() {
        if (bgRaf) cancelAnimationFrame(bgRaf);
        bgRaf = 0;
        host.style.background = "#000";
        if (bgMode === "particles") {
            canvas.style.display = "block";
            bgParticles = [];
            globalThis.projectionLastTs = 0;
            bgRaf = requestAnimationFrame(drawLeaderBackground);
        } else {
            canvas.style.display = "none";
        }
        toolbar.querySelectorAll("[data-bg]").forEach((btn) => btn.classList.toggle("active", btn.getAttribute("data-bg") === bgMode));
    }

    function render() {
        closePopup();
        const { pages, idx } = getPagesAndIndex();
        const lines = pages[idx] || [];
        const nextLine = pages[idx + 1]?.[0] || "（无）";
        const color = globalThis.liveState?.fontColor || globalThis.liveState?.text?.color || "#ffffff";
        const curStart = pages.slice(0, idx).reduce((n, p) => n + (p || []).length, 0);
        const curEnd = curStart + lines.length - 1;
        let bodyHtml = "";
        if (displayMode === "single") {
            const gi = lineGlobalIndex(pages, idx, 0);
            const note = loadNote(gi);
            bodyHtml = `<div class="leader-current leader-single" style="color:${color};"><div class="leader-line">${globalThis.escapeHtml(lines[0] || "...")}${note ? `<span class="leader-note-dot" data-line="${gi}"></span>` : ""}${noteEditMode ? `<span class="leader-plus-dot" data-line="${gi}">+</span>` : ""}</div></div>`;
        } else if (displayMode === "scroll") {
            const all = pages.flat();
            bodyHtml = `<div class="leader-current leader-scroll" style="color:${color};">${all.map((line, i) => {
                const note = loadNote(i);
                const cur = i >= curStart && i <= curEnd ? " current" : "";
                return `<div class="leader-line${cur}">${globalThis.escapeHtml(line)}${note ? `<span class="leader-note-dot" data-line="${i}"></span>` : ""}${noteEditMode ? `<span class="leader-plus-dot" data-line="${i}">+</span>` : ""}</div>`;
            }).join("")}</div>`;
        } else {
            bodyHtml = `<div class="leader-current leader-multi" style="color:${color};">${lines.map((line, i) => {
                const gi = lineGlobalIndex(pages, idx, i);
                const note = loadNote(gi);
                return `<div class="leader-line">${globalThis.escapeHtml(line)}${note ? `<span class="leader-note-dot" data-line="${gi}"></span>` : ""}${noteEditMode ? `<span class="leader-plus-dot" data-line="${gi}">+</span>` : ""}</div>`;
            }).join("") || "<div class='leader-line'>...</div>"}</div>`;
        }
        const nextHtml = displayMode === "scroll" ? "" : `<div class="leader-next">下句：${globalThis.escapeHtml(nextLine)}</div>`;
        layer.innerHTML = `<div class="leader-page">${idx + 1}/${Math.max(1, pages.length)}</div><div class="leader-main">${bodyHtml}</div>${nextHtml}`;
        toolbar.querySelectorAll("[data-mode]").forEach((btn) => btn.classList.toggle("active", btn.getAttribute("data-mode") === displayMode));
        toolbar.querySelector('[data-action="note"]')?.classList.toggle("active", noteEditMode);
    }

    function flip(delta) { if (globalThis.__projectionChannel) globalThis.__projectionChannel.postMessage({ type: "flip", delta }); }

    layer.addEventListener("click", (e) => {
        const plus = e.target.closest(".leader-plus-dot");
        if (plus) return openNoteEditor(Number(plus.getAttribute("data-line")) || 0, false);
        const dot = e.target.closest(".leader-note-dot");
        if (dot) return openNoteEditor(Number(dot.getAttribute("data-line")) || 0, true);
    });
    toolbar.addEventListener("click", (e) => {
        const btn = e.target.closest("button");
        if (!btn) return;
        if (btn.dataset.mode) {
            displayMode = btn.dataset.mode;
            localStorage.setItem(DISPLAY_MODE_KEY, displayMode);
            render();
        } else if (btn.dataset.bg) {
            bgMode = btn.dataset.bg;
            localStorage.setItem(BG_MODE_KEY, bgMode);
            globalThis.applyBackgroundMode();
        } else if (btn.dataset.action === "note") {
            noteEditMode = !noteEditMode;
            render();
        } else if (btn.dataset.action === "prev") flip(-1);
        else if (btn.dataset.action === "next") flip(1);
        showToolbar();
    });
    leftArrow.addEventListener("click", () => { flip(-1); showToolbar(); });
    rightArrow.addEventListener("click", () => { flip(1); showToolbar(); });

    host.addEventListener("touchstart", (e) => {
        touchStartX = e.changedTouches?.[0]?.clientX || 0;
        showToolbar();
    }, { passive: true });
    host.addEventListener("touchend", (e) => {
        const endX = e.changedTouches?.[0]?.clientX || 0;
        const dx = endX - touchStartX;
        if (Math.abs(dx) > 50) flip(dx < 0 ? 1 : -1);
        showToolbar();
    }, { passive: true });

    document.addEventListener("keydown", (e) => {
        if (e.key === "ArrowLeft") flip(-1);
        if (e.key === "ArrowRight") flip(1);
        if (e.key === "Escape") closePopup();
        showToolbar();
    });
    document.addEventListener("mousemove", showToolbar);
    document.addEventListener("click", (e) => {
        if (popup && e.target === popup) closePopup();
        showToolbar();
    });

    if (globalThis.__projectionChannel) {
        globalThis.__projectionChannel.onmessage = (e) => {
            if (e.data?.type === "update" && e.data.payload?.pages) {
                globalThis.liveState = e.data.payload;
                render();
            }
        };
        globalThis.__projectionChannel.postMessage({ type: "request_state" });
    }
    window.addEventListener("storage", (e) => {
        if (e.key === "worship.live.v5" && e.newValue) {
            const payload = globalThis.parseJSON(e.newValue, null);
            if (payload?.pages) {
                globalThis.liveState = payload;
                render();
            }
        }
    });
    window.addEventListener("resize", () => {
        globalThis.applyBackgroundMode();
        render();
    });

    const initState = globalThis.getStore("worship.live.v5", null);
    if (initState?.pages) globalThis.liveState = initState;
    globalThis.applyBackgroundMode();
    render();
    showToolbar();
}



const uiRoot =
    typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : self;
uiRoot.UI = UI;
