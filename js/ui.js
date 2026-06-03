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
        const g = typeof globalThis !== "undefined" ? globalThis : window;
        if (typeof g.saveCurrentLyrics === "function") {
            g.saveCurrentLyrics();
            return;
        }
        UI.saveCurrentLyrics();
        const R = g.AppRouter;
        if (R && typeof R.init === "function") R.init();
        if (R && typeof R.broadcastState === "function") R.broadcastState();
        UI.showToast("已保存并应用", document.getElementById("save-song-btn"));
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
        let win = null;
        try {
            win = window.open(url, name, feats);
        } catch (_e) {
            /* ignore */
        }
        if (!win) {
            try {
                win = window.open(url, name);
            } catch (_e2) {
                /* ignore */
            }
        }
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
function projectionAssignVideoBgSrc(videoEl, dataUrl) {
    const want = String(dataUrl || "").trim();
    if (!videoEl || !want) return;
    const prev = String(videoEl.dataset.worshipBgUrl || "");
    if (prev === want && videoEl.src && !videoEl.paused && !videoEl.ended) {
        videoEl.style.opacity = "1";
        return;
    }
    videoEl.dataset.worshipBgUrl = want;
    const kickPlay = () => {
        videoEl.style.opacity = "1";
        if (videoEl.paused || videoEl.ended) void videoEl.play().catch(() => {});
    };
    const applySrc = (url) => {
        if (String(videoEl.dataset.worshipBgUrl || "") !== want) return;
        if (videoEl.src !== url) videoEl.src = url;
        if (videoEl.readyState >= 2) kickPlay();
        else videoEl.addEventListener("loadeddata", kickPlay, { once: true });
    };
    if (/^data:video\//i.test(want)) {
        if (videoEl._worshipVideoBlobKey === want && videoEl._worshipVideoBlobUrl) {
            applySrc(videoEl._worshipVideoBlobUrl);
            return;
        }
        fetch(want)
            .then((r) => r.blob())
            .then((blob) => {
                if (String(videoEl.dataset.worshipBgUrl || "") !== want) return;
                if (videoEl._worshipVideoBlobUrl) {
                    try {
                        URL.revokeObjectURL(videoEl._worshipVideoBlobUrl);
                    } catch (_e) {
                        /* ignore */
                    }
                }
                videoEl._worshipVideoBlobUrl = URL.createObjectURL(blob);
                videoEl._worshipVideoBlobKey = want;
                applySrc(videoEl._worshipVideoBlobUrl);
            })
            .catch(() => applySrc(want));
        return;
    }
    if (videoEl._worshipVideoBlobUrl) {
        try {
            URL.revokeObjectURL(videoEl._worshipVideoBlobUrl);
        } catch (_e) {
            /* ignore */
        }
        delete videoEl._worshipVideoBlobUrl;
        delete videoEl._worshipVideoBlobKey;
    }
    applySrc(want);
}

function projectionHideDisplayVideoBg(videoEl) {
    if (!videoEl) return;
    videoEl.pause();
    videoEl.removeAttribute("src");
    delete videoEl.dataset.worshipBgUrl;
    if (videoEl._worshipVideoBlobUrl) {
        try {
            URL.revokeObjectURL(videoEl._worshipVideoBlobUrl);
        } catch (_e) {
            /* ignore */
        }
        delete videoEl._worshipVideoBlobUrl;
        delete videoEl._worshipVideoBlobKey;
    }
    try {
        videoEl.load();
    } catch (_e) {
        /* ignore */
    }
    videoEl.style.opacity = "0";
}

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
        if (globalThis.projectionRaf) {
            cancelAnimationFrame(globalThis.projectionRaf);
            globalThis.projectionRaf = 0;
        }
        projectionAssignVideoBgSrc(dispV, bgState.imageData);
        globalThis.projectionLastTs = ts;
        return;
    }

    if (dispV && !isVideoBg) projectionHideDisplayVideoBg(dispV);

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
        const isNativeAnimImg =
            /^data:image\/gif/i.test(bgState.imageData) || /^data:image\/webp/i.test(bgState.imageData);
        if (isNativeAnimImg && gifLayer) {
            globalThis.removeProjectionCssBg();
            if (globalThis.projectionCanvas) globalThis.projectionCanvas.style.display = "none";
            if (dispV) projectionHideDisplayVideoBg(dispV);
            const want = String(bgState.imageData);
            if (gifLayer.src !== want) {
                gifLayer.src = want;
                if (typeof gifLayer.decode === "function") gifLayer.decode().catch(() => {});
            }
            gifLayer.style.display = "block";
            gifLayer.style.transform = "translateZ(0)";
            globalThis.projectionLastTs = ts;
            globalThis.projectionRaf = 0;
            return;
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
    const loop =
        type === "particles" ||
        (type === "image" && globalThis.projectionBgImage && !globalThis.projectionBgImage.complete);
    if (loop) globalThis.projectionRaf = requestAnimationFrame(globalThis.drawBg);
    else globalThis.projectionRaf = 0;

};
globalThis.restartBg = function () {
    try {
        const ls = globalThis.liveState;
        const bg = ls?.background || {};
        const bgData = String(bg.imageData || "");
        if (projectionDisplayIsVideoBackground(ls)) {
            const dispV = document.getElementById("display-video-bg");
            const want = bgData.trim();
            if (dispV && want && dispV.dataset.worshipBgUrl === want && dispV.src) {
                if (globalThis.projectionRaf) cancelAnimationFrame(globalThis.projectionRaf);
                globalThis.projectionRaf = 0;
                dispV.style.opacity = "1";
                if (dispV.paused || dispV.ended) void dispV.play().catch(() => {});
                return;
            }
        }
        const gifLayer = document.getElementById("projection-bg-image");
        if (
            gifLayer &&
            bg.type === "image" &&
            (/^data:image\/gif/i.test(bgData) || /^data:image\/webp/i.test(bgData)) &&
            gifLayer.src === bgData &&
            gifLayer.style.display !== "none"
        ) {
            if (globalThis.projectionRaf) cancelAnimationFrame(globalThis.projectionRaf);
            globalThis.projectionRaf = 0;
            return;
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
function projectionLyricLinesSig(st) {
    if (!st || !Array.isArray(st.pages)) return "";
    const idx = globalThis.clamp(Number(st.pageIndex) || 0, 0, Math.max(0, st.pages.length - 1));
    const lines = st.pages[idx] || [];
    return `${String(st.songId || "")}\x1d${idx}\x1d${lines.map((x) => String(x ?? "")).join("\x1e")}`;
}

globalThis.applyLive = function (mode, payload, opts) {
    if (payload === undefined && mode && typeof mode === "object") {
        payload = mode;
        mode = globalThis.projectionMode || "display";
        opts = undefined;
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
        const lyricSame =
            !!prev && projectionLyricLinesSig(prev) === projectionLyricLinesSig(next);
        const styleOnly = !!(opts && opts.styleOnly) || (lyricSame && !navChanged);
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
        } else if (styleOnly && typeof globalThis.renderDisplayLyricStyleOnly === "function") {
            globalThis.renderDisplayLyricStyleOnly();
        } else {
            globalThis.renderDisplayLyric();
        }
    } else if (typeof globalThis.__worshipLeaderApplyLive === "function") {
        try {
            globalThis.__worshipLeaderApplyLive(m, next);
        } catch (_e) {
            globalThis.renderLeaderLyric();
        }
    } else globalThis.renderLeaderLyric();
    const skipRestart =
        m === "display" &&
        prev &&
        projectionLiveBackgroundSignature(prev.background) ===
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
/** 仅更新投屏歌词排版样式（字号/颜色/位置/透明度），不重绘 innerHTML，拖动滑块时更顺滑 */
globalThis.renderDisplayLyricStyleOnly = function () {
    const layer = document.getElementById("projection-lyric");
    if (!layer || !globalThis.liveState) return;
    const inner = document.getElementById("projection-lyric-anim");
    const target = inner || layer;
    const pages = globalThis.liveState.pages || [];
    const idx = globalThis.clamp(globalThis.liveState.pageIndex || 0, 0, Math.max(0, pages.length - 1));
    const lines = pages[idx] || [];
    if (!lines.length && !target.querySelector(".lyric-seg, div")) {
        globalThis.renderDisplayLyric();
        return;
    }
    const t = globalThis.liveState.text || {};
    const fontColor = globalThis.liveState.fontColor || t.color || "#ffffff";
    const fontOp = globalThis.clamp(Number(globalThis.liveState.fontOpacityPct ?? 100), 20, 100) / 100;
    const lightBg = fontColor === "#111" || (t.color || "") === "#111";
    const strokePx = globalThis.clamp(Number(t.strokePx), 0, 6);
    const strokeSig = `${strokePx}\x1d${lightBg ? 1 : 0}`;
    if (layer.dataset.projStrokeSig !== strokeSig) {
        layer.dataset.projStrokeSig = strokeSig;
        globalThis.renderDisplayLyric();
        return;
    }
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
    layer.style.transform = "translateY(-50%)";
    layer.style.transition = "none";
    if (inner) {
        layer.style.opacity = "1";
        inner.style.transition = "none";
        inner.style.transform = "";
    }
    target.style.transition = "none";
    target.style.opacity = String(fontOp);
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
            "transform:translateZ(0);backface-visibility:hidden;-webkit-backface-visibility:hidden;" +
            "will-change:opacity;";
        displayVid.setAttribute("preload", "auto");
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
    gifImg.style.cssText =
        "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center;display:none;" +
        "pointer-events:none;transform:translateZ(0);backface-visibility:hidden;-webkit-backface-visibility:hidden;";
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
                globalThis.applyLive("display", d.payload, { styleOnly: !!d.styleOnly });
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
    const run = globalThis.__worshipAppInitLeaderView;
    if (typeof run === "function") {
        run();
        return;
    }
    console.warn("[WorshipApp] 主领视图尚未就绪：请确认已加载 app.js 后刷新页面。");
}

const uiRoot =
    typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : self;
uiRoot.UI = UI;
