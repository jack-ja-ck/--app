(() => {
    "use strict";

    const STORAGE = {
        SONGS: "worship.songs.v5",
        SETTINGS: "worship.settings.v5",
        LIVE: "worship.live.v5",
        PLAYLIST: "playlist"
    };
    /** 歌词编辑区自动草稿（localStorage JSON） */
    const WORSHIP_DRAFT_LS = "worship_draft";
    const WORSHIP_BACKUP_FORMAT = "worship-backup";
    const WORSHIP_APP_VERSION = "v2.1.0";
    const WORSHIP_ERROR_LOG_LS = "worship_error_log";
    const WORSHIP_ERROR_LOG_MAX = 50;
    const WORSHIP_ERROR_LOG_COPY_LAST = 10;
    const LYRIC_TEMPLATES_KEY = "worship.lyric_templates.v1";
    const THEME_BG_STORAGE = "worship.theme_bg.v1";
    const THEME_BG_OPACITY_STORAGE = "theme_bg_opacity";
    /** 高级编辑：快速预览叠层 / 行间距（与 state.ui 分离，单独持久化） */
    const ADV_MINI_OVERLAY_PCT_LS = "worship_adv_mini_overlay_pct_v1";
    const ADV_MINI_BLUR_PX_LS = "worship_adv_mini_blur_px_v1";
    const ADV_PREVIEW_LINE_HEIGHT_LS = "worship_adv_preview_line_height_v1";
    /** 自定义主题背景：最多保留 4 张缩略图（localStorage JSON），超出丢弃最旧 */
    const THEME_BG_SLOTS_STORAGE = "worship.theme_bg_slots.v1";
    const THEME_BG_ACTIVE_ID_STORAGE = "worship.theme_bg_active.v1";
    /** 控制台主题背景视频（Data URL，localStorage；与壁纸槽位并存，播放时优先于壁纸） */
    const WORSHIP_THEME_VIDEO_LS = "worship_theme_video";
    /** 用户命名的已保存播放列表（localStorage JSON 数组） */
    const WORSHIP_SETLISTS_LS = "worship_setlists";

    /** 部分浏览器对 .mov/.mp4 会生成 data:application/octet-stream，需与 data:video/* 同等对待 */
    function isLikelyThemeConsoleVideoDataUrl(s) {
        const t = String(s || "").trim();
        if (!t.startsWith("data:") || t.length < 80) return false;
        if (/^data:video\//i.test(t)) return true;
        if (/^data:application\/octet-stream[;,]/i.test(t)) return true;
        return false;
    }
    const THEME_BG_SLOTS_MAX = 4;
    /** 旧版自动注入的默认十字架壁纸（迁移时清除，不再作为默认） */
    const DEFAULT_THEME_BG_REL_PATH = "./cross.jpg";
    const DEFAULT_THEME_BG_SLOT_ID = "tbg_default_cross";
    const UPLOADED_BACKGROUNDS_STORAGE = "uploaded_backgrounds";
    /** 「我的背景」本地槽位上限；超出时丢弃最旧（按 timestamp） */
    const UPLOADED_BACKGROUNDS_MAX = 4;

    function appendWorshipErrorLogEntry(info) {
        try {
            const message = String(info?.message || "error").slice(0, 4000);
            const stack = String(info?.stack || "").slice(0, 16000);
            let arr = [];
            try {
                arr = JSON.parse(localStorage.getItem(WORSHIP_ERROR_LOG_LS) || "[]");
            } catch (_e) {
                arr = [];
            }
            if (!Array.isArray(arr)) arr = [];
            arr.push({ message, stack, ts: Date.now() });
            while (arr.length > WORSHIP_ERROR_LOG_MAX) arr.shift();
            localStorage.setItem(WORSHIP_ERROR_LOG_LS, JSON.stringify(arr));
        } catch (_e) {
            /* ignore */
        }
    }

    window.addEventListener("error", (ev) => {
        const st = ev.error && typeof ev.error.stack === "string" ? ev.error.stack : "";
        appendWorshipErrorLogEntry({
            message: String(ev.message || "window.error"),
            stack: st
        });
    });
    window.addEventListener("unhandledrejection", (ev) => {
        const r = ev.reason;
        const msg =
            r && typeof r === "object" && r.message != null
                ? String(r.message)
                : String(r || "unhandledrejection");
        const stack = r && typeof r === "object" && typeof r.stack === "string" ? String(r.stack) : "";
        appendWorshipErrorLogEntry({ message: msg, stack });
    });

    function inferMediaTypeFromDataUrl(dataUrl) {
        const s = String(dataUrl || "");
        if (/^data:video\//i.test(s)) return "video";
        /** 部分浏览器导出的本地视频为 octet-stream，需按视频处理（见 isLikelyThemeConsoleVideoDataUrl） */
        if (/^data:application\/octet-stream[;,]/i.test(s)) return "video";
        return "image";
    }
    try {
        globalThis.inferMediaTypeFromDataUrl = inferMediaTypeFromDataUrl;
    } catch (_e) {
        /* ignore */
    }

    function normalizeUploadedBackgroundsArray(arr) {
        const list = Array.isArray(arr) ? arr.filter((x) => x && x.id && x.imageData) : [];
        list.forEach((x) => {
            if (x.mediaType !== "video" && x.mediaType !== "image") {
                x.mediaType = inferMediaTypeFromDataUrl(x.imageData);
            }
        });
        list.sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
        return list.slice(0, UPLOADED_BACKGROUNDS_MAX);
    }
    const LEGACY_LYRIC_BGS_STORAGE = "worship.lyric_bgs.v1";
    /** 背景大图存 IndexedDB；以下为库名与运行时缓存（失败时回退 localStorage） */
    const IDB_NAME = "WorshipAppDB";
    const IDB_VERSION = 1;
    const IDB_STORE_THEME = "themeBackground";
    const IDB_STORE_UPLOADED = "uploadedBackgrounds";
    const IDB_THEME_ROW_ID = "__theme_bg__";

    let _bgUseIdbFallbackLs = false;
    let _idbThemeBgCache = "";
    let _idbUploadedCache = [];
    let _themeBgSlotsCache = [];
    let _themeBgActiveId = "";
    let _themeConsoleVideoDataUrl = "";

    function promiseReq(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function promiseTx(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    let _openBgDbPromise = null;
    function openWorshipBgDatabase() {
        if (_openBgDbPromise) return _openBgDbPromise;
        _openBgDbPromise = new Promise((resolve, reject) => {
            if (typeof indexedDB === "undefined") {
                reject(new Error("indexedDB unsupported"));
                return;
            }
            const req = indexedDB.open(IDB_NAME, IDB_VERSION);
            req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
            req.onsuccess = () => resolve(req.result);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(IDB_STORE_THEME)) {
                    db.createObjectStore(IDB_STORE_THEME, { keyPath: "id" });
                }
                if (!db.objectStoreNames.contains(IDB_STORE_UPLOADED)) {
                    db.createObjectStore(IDB_STORE_UPLOADED, { keyPath: "id" });
                }
            };
        });
        return _openBgDbPromise;
    }

    async function idbReadThemeBg(db) {
        const tx = db.transaction(IDB_STORE_THEME, "readonly");
        const row = await promiseReq(tx.objectStore(IDB_STORE_THEME).get(IDB_THEME_ROW_ID));
        return row && row.imageData ? String(row.imageData) : "";
    }

    async function idbWriteThemeBg(db, imageData) {
        const tx = db.transaction(IDB_STORE_THEME, "readwrite");
        tx.objectStore(IDB_STORE_THEME).put({ id: IDB_THEME_ROW_ID, imageData: String(imageData || "") });
        await promiseTx(tx);
    }

    async function idbClearThemeBg(db) {
        const tx = db.transaction(IDB_STORE_THEME, "readwrite");
        tx.objectStore(IDB_STORE_THEME).delete(IDB_THEME_ROW_ID);
        await promiseTx(tx);
    }

    async function idbReadAllUploaded(db) {
        const tx = db.transaction(IDB_STORE_UPLOADED, "readonly");
        const rows = await promiseReq(tx.objectStore(IDB_STORE_UPLOADED).getAll());
        return Array.isArray(rows) ? rows.filter((x) => x && x.id && x.imageData) : [];
    }

    async function idbWriteAllUploaded(db, list) {
        const tx = db.transaction(IDB_STORE_UPLOADED, "readwrite");
        const store = tx.objectStore(IDB_STORE_UPLOADED);
        store.clear();
        const arr = normalizeUploadedBackgroundsArray(list);
        arr.forEach((item) => {
            if (item && item.id && item.imageData) store.put(item);
        });
        await promiseTx(tx);
    }

    async function migrateLocalStorageBackgroundsToIndexedDb(db) {
        try {
            const themeLs = localStorage.getItem(THEME_BG_STORAGE);
            if (themeLs && themeLs.trim()) {
                await idbWriteThemeBg(db, themeLs);
                localStorage.removeItem(THEME_BG_STORAGE);
            }
            const uploadedLs = localStorage.getItem(UPLOADED_BACKGROUNDS_STORAGE);
            if (uploadedLs) {
                const parsed = parseJSON(uploadedLs, null);
                if (Array.isArray(parsed) && parsed.length) {
                    await idbWriteAllUploaded(db, parsed);
                }
                localStorage.removeItem(UPLOADED_BACKGROUNDS_STORAGE);
            }
        } catch (e) {
            console.warn("migrateLocalStorageBackgroundsToIndexedDb", e);
        }
    }

    async function initBackgroundImageIndexedDb() {
        try {
            const db = await openWorshipBgDatabase();
            await migrateLocalStorageBackgroundsToIndexedDb(db);
            _idbThemeBgCache = await idbReadThemeBg(db);
            const rawUploaded = await idbReadAllUploaded(db);
            _idbUploadedCache = normalizeUploadedBackgroundsArray(rawUploaded);
            if (rawUploaded.filter((x) => x && x.id && x.imageData).length > UPLOADED_BACKGROUNDS_MAX) {
                persistUploadedBackgroundsAsync(_idbUploadedCache);
            }
            _bgUseIdbFallbackLs = false;
        } catch (e) {
            console.warn("IndexedDB unavailable, fallback localStorage for backgrounds", e);
            _bgUseIdbFallbackLs = true;
            try {
                _idbThemeBgCache = localStorage.getItem(THEME_BG_STORAGE) || "";
            } catch (_e) {
                _idbThemeBgCache = "";
            }
            let parsedLs = [];
            try {
                parsedLs = parseJSON(localStorage.getItem(UPLOADED_BACKGROUNDS_STORAGE), []);
            } catch (_e2) {
                parsedLs = [];
            }
            if (!Array.isArray(parsedLs)) parsedLs = [];
            _idbUploadedCache = normalizeUploadedBackgroundsArray(parsedLs);
            if (parsedLs.filter((x) => x && x.id && x.imageData).length > UPLOADED_BACKGROUNDS_MAX) {
                persistUploadedBackgroundsAsync(_idbUploadedCache);
            }
        }
    }

    function persistThemeBgAsync(imageData) {
        _idbThemeBgCache = String(imageData || "");
        if (_bgUseIdbFallbackLs) {
            try {
                if (_idbThemeBgCache.trim()) localStorage.setItem(THEME_BG_STORAGE, _idbThemeBgCache);
                else localStorage.removeItem(THEME_BG_STORAGE);
            } catch (err) {
                console.warn(err);
            }
            return;
        }
        openWorshipBgDatabase()
            .then((db) => {
                if (!_idbThemeBgCache.trim()) return idbClearThemeBg(db);
                return idbWriteThemeBg(db, _idbThemeBgCache);
            })
            .catch((err) => console.warn("persistThemeBgAsync", err));
    }

    function themeBgSlotId() {
        return "tbg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
    }

    function normalizeThemeBgSlots(arr) {
        const list = Array.isArray(arr) ? arr.filter((x) => x && x.id && x.imageData) : [];
        list.sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
        return list.slice(0, THEME_BG_SLOTS_MAX);
    }

    function persistThemeBgSlotsMetaOnly() {
        try {
            localStorage.setItem(THEME_BG_SLOTS_STORAGE, JSON.stringify(_themeBgSlotsCache));
            localStorage.setItem(THEME_BG_ACTIVE_ID_STORAGE, _themeBgActiveId || "");
        } catch (err) {
            console.warn("persistThemeBgSlotsMetaOnly", err);
        }
    }

    function syncActiveThemeBgCacheFromSlots() {
        const slot = _themeBgSlotsCache.find((s) => s.id === _themeBgActiveId);
        _idbThemeBgCache = slot ? String(slot.imageData) : "";
    }

    function persistFullThemeBgFromSlots() {
        _themeBgSlotsCache = normalizeThemeBgSlots(_themeBgSlotsCache);
        if (_themeBgActiveId && !_themeBgSlotsCache.some((s) => s.id === _themeBgActiveId)) {
            _themeBgActiveId = _themeBgSlotsCache[0]?.id || "";
        }
        persistThemeBgSlotsMetaOnly();
        syncActiveThemeBgCacheFromSlots();
        persistThemeBgAsync(_idbThemeBgCache);
    }

    /** IndexedDB 已读出 `_idbThemeBgCache` 后再调用：合并本地槽位 JSON，并从旧版「单图」迁移 */
    function loadThemeBgSlotsFromStorage() {
        let parsed = [];
        try {
            parsed = parseJSON(localStorage.getItem(THEME_BG_SLOTS_STORAGE), []);
        } catch (_e) {
            parsed = [];
        }
        _themeBgSlotsCache = normalizeThemeBgSlots(parsed);
        _themeBgActiveId = String(localStorage.getItem(THEME_BG_ACTIVE_ID_STORAGE) || "").trim();

        if (!_themeBgSlotsCache.length && (_idbThemeBgCache || "").trim()) {
            const id = themeBgSlotId();
            _themeBgSlotsCache = [{ id, imageData: _idbThemeBgCache, timestamp: Date.now() }];
            _themeBgActiveId = id;
            persistThemeBgSlotsMetaOnly();
            syncActiveThemeBgCacheFromSlots();
            return;
        }
        if (_themeBgActiveId && !_themeBgSlotsCache.some((s) => s.id === _themeBgActiveId)) {
            _themeBgActiveId = _themeBgSlotsCache[0]?.id || "";
        }
        const active =
            (_themeBgActiveId && _themeBgSlotsCache.find((s) => s.id === _themeBgActiveId)) ||
            _themeBgSlotsCache[0];
        if (active) {
            _themeBgActiveId = active.id;
            _idbThemeBgCache = String(active.imageData || "");
        } else {
            _themeBgActiveId = "";
            _idbThemeBgCache = "";
        }
    }

    function isLegacyDefaultCrossThemeBgPath(imageData) {
        const t = String(imageData || "").trim();
        if (!t) return false;
        if (t === DEFAULT_THEME_BG_REL_PATH) return true;
        return /(?:^|[\\/])cross\.jpg$/i.test(t);
    }

    /** 是否已上传/选择自定义控制台主题壁纸或视频 */
    function hasCustomThemeConsoleBackground() {
        if (isThemeConsoleVideoActive()) return true;
        const userSlots = _themeBgSlotsCache.filter(
            (x) => x && x.imageData && x.id !== DEFAULT_THEME_BG_SLOT_ID
        );
        if (userSlots.length > 0) return true;
        const raw = String(_idbThemeBgCache || "").trim();
        if (!raw) return false;
        return !isLegacyDefaultCrossThemeBgPath(raw);
    }

    /** 清除旧版自动注入的十字架默认图；无自定义壁纸时不注入图片，沿用深色界面主题 */
    function stripLegacyDefaultCrossThemeBg() {
        let changed = false;
        const before = _themeBgSlotsCache.length;
        _themeBgSlotsCache = _themeBgSlotsCache.filter((s) => {
            if (s && s.id === DEFAULT_THEME_BG_SLOT_ID && isLegacyDefaultCrossThemeBgPath(s.imageData)) {
                return false;
            }
            if (s && isLegacyDefaultCrossThemeBgPath(s.imageData) && !s.id) {
                return false;
            }
            return true;
        });
        if (_themeBgSlotsCache.length !== before) changed = true;
        if (isLegacyDefaultCrossThemeBgPath(_idbThemeBgCache)) {
            _idbThemeBgCache = "";
            changed = true;
        }
        if (
            _themeBgActiveId === DEFAULT_THEME_BG_SLOT_ID ||
            (_themeBgActiveId && !_themeBgSlotsCache.some((s) => s && s.id === _themeBgActiveId))
        ) {
            _themeBgActiveId = _themeBgSlotsCache[0]?.id || "";
            changed = true;
        }
        if (changed) {
            syncActiveThemeBgCacheFromSlots();
            persistFullThemeBgFromSlots();
        }
        return changed;
    }

    function ensureDefaultThemeBackgroundAtBoot() {
        const hadLegacyCross = stripLegacyDefaultCrossThemeBg();
        if (!hasCustomThemeConsoleBackground()) {
            const isFirstVisit = !getStore(STORAGE.SETTINGS, null);
            if (isFirstVisit || hadLegacyCross) {
                state.ui.theme = "dark";
            }
        }
    }

    function removeThemeBgSlot(slotId) {
        const id = String(slotId || "").trim();
        if (!id) return;
        _themeBgSlotsCache = _themeBgSlotsCache.filter((s) => s && s.id !== id);
        persistFullThemeBgFromSlots();
        applyThemeBackground();
        showToast("已删除主题背景", $("worship-console-wallpaper-preview") || $("theme-bg-grid"));
    }

    function deleteUploadedBackgroundItem(itemId, opts) {
        const o = opts && typeof opts === "object" ? opts : {};
        const skipRender = !!o.skipRender;
        const skipToast = !!o.skipToast;
        const id = String(itemId || "").trim();
        if (!id) return;
        const itemsBefore = getUploadedBackgrounds();
        const removed = itemsBefore.find((x) => x && x.id === id);
        const arr = itemsBefore.filter((x) => x && x.id !== id);
        const wasActive =
            state.ui.bgType === "image" &&
            removed &&
            (state.ui.bgImageId === id || state.ui.bgImage === removed.imageData);
        saveUploadedBackgrounds(arr);
        pruneBgThumbUsageForId(id);
        if (removed && String(state.ui.defaultUploadedBgId || "") === id) {
            state.ui.defaultUploadedBgId = "";
            saveSettings();
        }
        if (wasActive) {
            setBackground("solid-black");
            saveSettings();
        }
        if (!skipRender) renderUploadedBackgrounds();
        if (!skipToast) showToast("已删除背景", $("my-backgrounds-container"));
    }

    let _lyricBgDeletePopoverEl = null;
    let _lyricBgDeleteOutsideHandler = null;
    let _lyricBgDeleteEscHandler = null;

    function removeLyricBgDeletePopover() {
        if (_lyricBgDeleteEscHandler) {
            document.removeEventListener("keydown", _lyricBgDeleteEscHandler, true);
            _lyricBgDeleteEscHandler = null;
        }
        if (_lyricBgDeleteOutsideHandler) {
            document.removeEventListener("mousedown", _lyricBgDeleteOutsideHandler, false);
            _lyricBgDeleteOutsideHandler = null;
        }
        if (_lyricBgDeletePopoverEl) {
            _lyricBgDeletePopoverEl.remove();
            _lyricBgDeletePopoverEl = null;
        }
    }

    function openLyricBgDeletePopover(wrap, itemId) {
        removeLyricBgDeletePopover();
        const panel = document.createElement("div");
        panel.className = "lyric-bg-delete-popover";
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");
        const p = document.createElement("p");
        p.className = "lyric-bg-delete-popover-text";
        p.id = "lyric-bg-delete-popover-desc";
        p.textContent = "删除此背景？";
        panel.setAttribute("aria-describedby", "lyric-bg-delete-popover-desc");
        const actions = document.createElement("div");
        actions.className = "lyric-bg-delete-popover-actions";
        const btnDel = document.createElement("button");
        btnDel.type = "button";
        btnDel.className = "lyric-bg-delete-popover-confirm";
        btnDel.textContent = "删除";
        const btnCancel = document.createElement("button");
        btnCancel.type = "button";
        btnCancel.className = "lyric-bg-delete-popover-cancel";
        btnCancel.textContent = "取消";
        actions.appendChild(btnCancel);
        actions.appendChild(btnDel);
        panel.appendChild(p);
        panel.appendChild(actions);
        wrap.appendChild(panel);
        _lyricBgDeletePopoverEl = panel;

        const cancel = () => removeLyricBgDeletePopover();
        btnCancel.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            cancel();
        });
        btnDel.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            removeLyricBgDeletePopover();
            beginLyricBgDeleteSequence(wrap, itemId);
        });

        _lyricBgDeleteOutsideHandler = (e) => {
            if (!panel.parentElement) return;
            if (panel.contains(e.target)) return;
            cancel();
        };
        document.addEventListener("mousedown", _lyricBgDeleteOutsideHandler, false);

        _lyricBgDeleteEscHandler = (e) => {
            if (e.key === "Escape") cancel();
        };
        document.addEventListener("keydown", _lyricBgDeleteEscHandler, true);

        try {
            btnCancel.focus({ preventScroll: true });
        } catch (_e) {
            /* ignore */
        }
    }

    function beginLyricBgDeleteSequence(wrap, itemId) {
        deleteUploadedBackgroundItem(itemId, { skipRender: true, skipToast: true });
        wrap.classList.add("lyric-bg-thumb-wrap--deleting");
        wrap.querySelectorAll(".lyric-bg-thumb-delete, .bg-share-icon").forEach((el) => el.remove());

        const bubble = document.createElement("div");
        bubble.className = "lyric-bg-delete-success-bubble";
        bubble.textContent = "✅ 已删除";
        wrap.appendChild(bubble);

        window.setTimeout(() => {
            bubble.remove();
            wrap.classList.remove("lyric-bg-thumb-wrap--deleting");
            wrap.classList.add("lyric-bg-thumb-wrap--dissolving");
            wrap.addEventListener(
                "animationend",
                (ev) => {
                    if (ev.target !== wrap) return;
                    if (!String(ev.animationName || "").includes("dissolve-particles")) return;
                    wrap.remove();
                    renderUploadedBackgrounds();
                },
                { once: true }
            );
        }, 1500);
    }

    function themeBgSlotUploadToastAnchor() {
        return (
            $("worship-console-wallpaper-preview") ||
            $("worship-console-theme-video-upload-btn") ||
            $("theme-bg-grid") ||
            $("worship-console-wallpaper-input") ||
            $("theme-bg-input")
        );
    }

    function handleThemeBgSlotFileInputChange(e) {
        const input = e.target;
        const files = input?.files;
        if (!files || !files.length) return;
        const list = Array.from(files);
        const toastAnchor = themeBgSlotUploadToastAnchor();
        const isWallpaperInput = input.id === "worship-console-wallpaper-input";

        (async () => {
            let added = 0;
            let skippedType = 0;
            let stoppedFull = false;
            let singleWasDupSwitch = false;
            for (const file of list) {
                if (isWallpaperInput && file.type && !/^image\//i.test(String(file.type))) {
                    skippedType++;
                    continue;
                }
                let dataUrl;
                try {
                    dataUrl = await readLocalFileAsDataURL(file);
                } catch {
                    continue;
                }
                if (!dataUrl) continue;
                try {
                    const dup = _themeBgSlotsCache.find((x) => x && x.imageData === dataUrl);
                    if (dup) {
                        _themeBgActiveId = dup.id;
                        added++;
                        if (list.length === 1) singleWasDupSwitch = true;
                    } else {
                        if (
                            _themeBgSlotsCache.filter((x) => x && x.imageData).length >=
                            THEME_BG_SLOTS_MAX
                        ) {
                            showToast(`已满 ${THEME_BG_SLOTS_MAX} 张，其余文件未加入`, toastAnchor);
                            stoppedFull = true;
                            break;
                        }
                        const nid = themeBgSlotId();
                        _themeBgSlotsCache = normalizeThemeBgSlots([
                            { id: nid, imageData: dataUrl, timestamp: Date.now() },
                            ..._themeBgSlotsCache
                        ]);
                        _themeBgActiveId = nid;
                        added++;
                    }
                    persistFullThemeBgFromSlots();
                    applyThemeBackground();
                } catch (err) {
                    console.warn(err);
                    showToast("主题背景存储失败（空间不足）", toastAnchor);
                    break;
                }
            }
            if (!stoppedFull && added > 0) {
                if (list.length === 1) {
                    showToast(
                        singleWasDupSwitch ? "已切换到该主题背景" : "主题背景已更新",
                        toastAnchor
                    );
                } else {
                    const tail = skippedType > 0 ? `，已跳过 ${skippedType} 个非图片` : "";
                    showToast(`已处理 ${added} 个文件${tail}`, toastAnchor);
                }
            } else if (added === 0 && skippedType > 0) {
                showToast("请选择图片文件", toastAnchor);
            } else if (added === 0 && !stoppedFull) {
                showToast("未能读取文件", toastAnchor);
            }
            input.value = "";
        })();
    }

    function resetWorshipConsoleThemeBackgrounds() {
        try {
            localStorage.removeItem("worship_theme_wallpaper");
        } catch (_e) {
            /* ignore */
        }
        try {
            localStorage.removeItem(WORSHIP_THEME_VIDEO_LS);
        } catch (_e) {
            /* ignore */
        }
        _themeConsoleVideoDataUrl = "";
        _themeBgSlotsCache = [];
        _themeBgActiveId = "";
        _idbThemeBgCache = "";
        persistFullThemeBgFromSlots();
        state.ui.theme = "dark";
        saveSettings();
        applyThemeBackground();
        if (typeof updateUIFromState === "function") updateUIFromState();
        else {
            document.body.setAttribute("data-theme", "dark");
            if ($("theme-selector")) $("theme-selector").value = "dark";
        }
        showToast("已恢复深色默认背景", $("worship-console-wallpaper-preview") || $("worship-console-wallpaper-reset"));
    }

    function loadThemeConsoleVideoFromStorage() {
        try {
            const s = String(localStorage.getItem(WORSHIP_THEME_VIDEO_LS) || "").trim();
            _themeConsoleVideoDataUrl = isLikelyThemeConsoleVideoDataUrl(s) ? s : "";
            if (s && !_themeConsoleVideoDataUrl) {
                localStorage.removeItem(WORSHIP_THEME_VIDEO_LS);
            }
        } catch (_e) {
            _themeConsoleVideoDataUrl = "";
        }
    }

    function persistThemeConsoleVideo(dataUrl) {
        const s = String(dataUrl || "").trim();
        _themeConsoleVideoDataUrl = isLikelyThemeConsoleVideoDataUrl(s) ? s : "";
        try {
            if (_themeConsoleVideoDataUrl) localStorage.setItem(WORSHIP_THEME_VIDEO_LS, _themeConsoleVideoDataUrl);
            else localStorage.removeItem(WORSHIP_THEME_VIDEO_LS);
        } catch (err) {
            console.warn(err);
            _themeConsoleVideoDataUrl = "";
            try {
                localStorage.removeItem(WORSHIP_THEME_VIDEO_LS);
            } catch (_e2) {
                /* ignore */
            }
            showToast(
                "视频过大无法保存（空间不足）",
                $("worship-console-theme-video-upload-btn") || themeBgSlotUploadToastAnchor()
            );
        }
    }

    function isThemeConsoleVideoActive() {
        return isLikelyThemeConsoleVideoDataUrl(_themeConsoleVideoDataUrl);
    }

    function clearThemeConsoleVideoOnly() {
        persistThemeConsoleVideo("");
        applyThemeBackground();
        showToast("已移除主题背景视频", $("worship-console-theme-video-upload-btn") || themeBgSlotUploadToastAnchor());
    }

    function ensureThemeConsoleVideoElement() {
        let el = document.getElementById("worship-console-theme-bg-video");
        if (!el) {
            el = document.createElement("video");
            el.id = "worship-console-theme-bg-video";
            el.setAttribute("playsinline", "");
            el.setAttribute("webkit-playsinline", "true");
            el.setAttribute("muted", "true");
            el.muted = true;
            el.loop = true;
            el.autoplay = true;
            el.controls = false;
            el.setAttribute("controlsList", "nodownload nofullscreen noremoteplayback");
            el.disablePictureInPicture = true;
            el.setAttribute("preload", "auto");
            el.setAttribute("aria-hidden", "true");
            el.setAttribute("tabindex", "-1");
            el.style.cssText =
                "position:fixed;top:0;left:0;width:100%;height:100%;object-fit:cover;object-position:center;z-index:0;pointer-events:none;display:none;";
            document.body.insertBefore(el, document.body.firstChild);
        }
        return el;
    }

    function syncThemeConsoleVideoElementOpacity() {
        const vid = document.getElementById("worship-console-theme-bg-video");
        if (!vid || vid.style.display === "none") return;
        vid.style.opacity = String(getThemeBgOpacity());
    }

    function handleThemeConsoleVideoFileChange(e) {
        const input = e.target;
        const files = input?.files;
        if (!files || !files.length) return;
        const list = Array.from(files);
        const ta = $("worship-console-theme-video-upload-btn") || themeBgSlotUploadToastAnchor();

        (async () => {
            let ok = 0;
            let skipped = 0;
            for (const file of list) {
                const name = String(file.name || "").toLowerCase();
                const okExt = /\.(mp4|webm|mov)$/i.test(name);
                const mime = String(file.type || "").toLowerCase();
                const okMime =
                    mime === "video/mp4" ||
                    mime === "video/webm" ||
                    mime === "video/quicktime" ||
                    /^video\/(mp4|webm|quicktime)$/i.test(mime);
                if (!okExt && !okMime) {
                    skipped++;
                    continue;
                }
                let dataUrl;
                try {
                    dataUrl = await readLocalFileAsDataURL(file);
                } catch {
                    skipped++;
                    continue;
                }
                if (!dataUrl || !isLikelyThemeConsoleVideoDataUrl(dataUrl)) {
                    skipped++;
                    continue;
                }
                persistThemeConsoleVideo(dataUrl);
                applyThemeBackground();
                ok++;
            }
            input.value = "";
            if (ok > 0) {
                showToast(
                    list.length === 1
                        ? "主题背景视频已更新"
                        : `已应用所选视频（${ok} 个成功${skipped ? `，${skipped} 个已跳过` : ""}）`,
                    ta
                );
            } else {
                showToast("请上传 .mp4、.webm 或 .mov 视频", ta);
            }
        })();
    }

    function appendThemeVideoSlotToGrid(grid) {
        if (!isThemeConsoleVideoActive()) return;
        const wrap = document.createElement("div");
        wrap.className = "theme-bg-slot-wrap";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "theme-bg-slot theme-bg-slot--filled theme-bg-slot--active";
        btn.dataset.slotType = "theme-console-video";
        btn.style.backgroundImage = "none";
        btn.style.background =
            "linear-gradient(160deg, rgba(10,12,20,0.98) 0%, rgba(22,28,42,0.98) 50%, rgba(12,14,22,0.98) 100%)";
        btn.style.boxShadow = "inset 0 0 0 1px rgba(255,255,255,0.1)";
        btn.title = "当前主题背景为视频（优先于壁纸）";
        const playMark = document.createElement("span");
        playMark.setAttribute("aria-hidden", "true");
        playMark.textContent = "▶";
        playMark.style.cssText =
            "display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:0.95rem;line-height:1;opacity:0.9;color:rgba(230,235,248,0.92);pointer-events:none;";
        btn.appendChild(playMark);
        btn.addEventListener("click", (ev) => {
            ev.preventDefault();
            showToast("当前已使用视频背景", btn);
        });
        const del = document.createElement("button");
        del.type = "button";
        del.className = "theme-bg-slot-delete";
        del.setAttribute("aria-label", "删除主题背景视频");
        del.title = "删除视频";
        del.textContent = "✕";
        del.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            clearThemeConsoleVideoOnly();
        });
        wrap.appendChild(btn);
        wrap.appendChild(del);
        grid.insertBefore(wrap, grid.firstChild);
    }

    function renderThemeBgGrid() {
        const host = $("worship-console-wallpaper-preview") || $("theme-bg-grid");
        if (!host) return;
        host.innerHTML = "";

        const userSlots = _themeBgSlotsCache
            .filter((x) => x && x.imageData && x.id !== DEFAULT_THEME_BG_SLOT_ID)
            .sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));

        const totalFilled = _themeBgSlotsCache.filter((x) => x && x.imageData).length;
        const canAddMore = totalFilled < THEME_BG_SLOTS_MAX;

        host.style.flexDirection = "column";
        host.style.alignItems = "stretch";
        host.style.width = "100%";
        host.style.gap = "10px";
        host.style.boxSizing = "border-box";

        const triggerFilePick = () => {
            const inp = $("worship-console-wallpaper-input") || $("theme-bg-input");
            inp?.click();
        };

        const hasVideo = isThemeConsoleVideoActive();

        if (userSlots.length === 0 && !hasVideo) {
            const emptyHint = document.createElement("p");
            emptyHint.className = "worship-console-wallpaper-empty";
            emptyHint.textContent = "暂未上传自定义壁纸";
            host.appendChild(emptyHint);

            const grid = document.createElement("div");
            grid.className = "theme-bg-grid theme-bg-grid--empty-only";
            grid.setAttribute("role", "group");
            grid.setAttribute("aria-label", "自定义主题背景");
            if (canAddMore) {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "theme-bg-slot theme-bg-slot--empty";
                btn.title = "上传主题背景";
                btn.setAttribute("aria-label", "上传主题背景");
                btn.innerHTML = '<span class="theme-bg-slot-plus" aria-hidden="true">+</span>';
                btn.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    triggerFilePick();
                });
                grid.appendChild(btn);
            }
            host.appendChild(grid);
            return;
        }

        if (userSlots.length === 0 && hasVideo) {
            const grid = document.createElement("div");
            grid.className = "theme-bg-grid theme-bg-grid--empty-only";
            grid.setAttribute("role", "group");
            grid.setAttribute("aria-label", "自定义主题背景");
            appendThemeVideoSlotToGrid(grid);
            if (canAddMore) {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "theme-bg-slot theme-bg-slot--empty";
                btn.title = "上传主题背景";
                btn.setAttribute("aria-label", "上传主题背景");
                btn.innerHTML = '<span class="theme-bg-slot-plus" aria-hidden="true">+</span>';
                btn.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    triggerFilePick();
                });
                grid.appendChild(btn);
            }
            host.appendChild(grid);
            return;
        }

        const grid = document.createElement("div");
        grid.className = "theme-bg-grid";
        grid.setAttribute("role", "group");
        grid.setAttribute("aria-label", "自定义主题背景");

        appendThemeVideoSlotToGrid(grid);

        userSlots.forEach((item) => {
            const wrap = document.createElement("div");
            wrap.className = "theme-bg-slot-wrap";

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "theme-bg-slot theme-bg-slot--filled";
            if (item.id === _themeBgActiveId && !hasVideo) btn.classList.add("theme-bg-slot--active");
            btn.dataset.slotId = item.id;
            const safe = String(item.imageData).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            btn.style.backgroundImage = `url("${safe}")`;
            btn.title = "点击切换为主题背景";
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                if (_themeBgActiveId === item.id) return;
                _themeBgActiveId = item.id;
                persistFullThemeBgFromSlots();
                applyThemeBackground();
                showToast("已切换主题背景", btn);
            });

            const del = document.createElement("button");
            del.type = "button";
            del.className = "theme-bg-slot-delete";
            del.setAttribute("aria-label", "删除此背景");
            del.title = "删除";
            del.textContent = "✕";
            del.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                removeThemeBgSlot(item.id);
            });

            wrap.appendChild(btn);
            wrap.appendChild(del);
            grid.appendChild(wrap);
        });

        if (canAddMore) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "theme-bg-slot theme-bg-slot--empty";
            btn.title = "上传主题背景";
            btn.setAttribute("aria-label", "上传主题背景");
            btn.innerHTML = '<span class="theme-bg-slot-plus" aria-hidden="true">+</span>';
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                triggerFilePick();
            });
            grid.appendChild(btn);
        }

        host.appendChild(grid);
    }

    function persistUploadedBackgroundsAsync(arr) {
        _idbUploadedCache = normalizeUploadedBackgroundsArray(arr);
        if (_bgUseIdbFallbackLs) {
            try {
                setStore(UPLOADED_BACKGROUNDS_STORAGE, _idbUploadedCache);
            } catch (err) {
                console.warn(err);
            }
            return;
        }
        openWorshipBgDatabase()
            .then((db) => idbWriteAllUploaded(db, _idbUploadedCache))
            .catch((err) => console.warn("persistUploadedBackgroundsAsync", err));
    }

    const CSS_DYNAMIC_BG_TYPES = new Set(["gentle-light", "starry-night", "cross-glow"]);

    function clearCssDynamicBgClass(el) {
        if (!el) return;
        CSS_DYNAMIC_BG_TYPES.forEach((t) => el.classList.remove(`css-bg-${t}`));
    }

    function removeProjectionCssBg() {
        $("projection-css-bg")?.remove();
    }

    function ensureProjectionCssBg(type) {
        const host = $("projection-host");
        if (!host || !CSS_DYNAMIC_BG_TYPES.has(type)) return;
        let el = $("projection-css-bg");
        if (!el) {
            el = document.createElement("div");
            el.id = "projection-css-bg";
            el.style.cssText = "position:absolute;inset:0;z-index:0;pointer-events:none;";
            host.insertBefore(el, host.firstChild);
        }
        el.className = `projection-css-bg-fill css-bg-${type}`;
    }
    const CHANNEL_NAME = "worship_channel";
    const DEFAULT_LYRICS = "奇异恩典\n何等甘甜\n我罪已得赦免\n\n前我失丧\n今被寻回\n瞎眼得看见";
    const DEFAULT_SONG = {
        title: "奇异恩典",
        lyrics: DEFAULT_LYRICS,
        key: "C",
        tempo: "72",
        notes: "",
        tags: "敬拜",
        overlayOpacityPct: 30,
        fontOpacityPct: 100
    };

    const query = new URLSearchParams(location.search || "");
    const isDisplay = query.get("display") === "1";
    const isLeader = query.get("leader") === "1";

    const channel = typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel(CHANNEL_NAME)
        : null;

    /** 在线诗歌搜索 / 云端上传（Cloudflare Worker） */
    const ONLINE_HYMN_SEARCH_WORKER_URL = "https://holy-snow-ebc5.cuirenjie123456789.workers.dev";
    let onlineHymnSearchDebounceTimer = 0;
    let onlineHymnSearchAbort = null;
    /** 诗歌库两个搜索框：获焦时各提示一次（失焦后重置），避免与 input 重复刷屏 */
    let librarySearchScopeHintShownForFocus = false;
    let onlineSearchNotReadyHintShownForFocus = false;

    let cloudUploadInFlight = false;
    let cloudUploadToastShowTimer = 0;
    let cloudUploadToastFadeTimer = 0;

    const CLOUD_UPLOAD_HISTORY_LS = "worship.cloud_upload_history.v1";
    const CLOUD_UPLOAD_HISTORY_MAX = 5;
    const CLOUD_UPLOAD_HISTORY_URL_TRUNC = 44;
    let uploadHistoryDropdownOpen = false;

    const WELCOME_DISMISS_SESSION_KEY = "worship.welcome_dismissed_day";
    let welcomeToastTimer = 0;

    /** 主窗口缓存的投屏窗口引用（?display=1），关闭或失效后置空 */
    let projectionDisplayWindowRef = null;
    /** 主控台轮询投屏窗是否仍打开（500ms） */
    let projectionDisplayWindowPollTimer = 0;
    /** 投屏窗已通过 BroadcastChannel 上报在线（弥补 window.open 返回 null 时无法持有引用） */
    let projectionDisplayAliveViaChannel = false;
    /** 主控台主动结束投屏时置 true，避免 unload 再弹出「窗口已关闭」提示 */
    let projectionCloseInitiatedByMain = false;
    /** 固定 window.name：同一时刻只保留一个投屏窗口，重复打开时聚焦并刷新状态 */
    const WORSHIP_PROJECTION_DISPLAY_WINDOW_NAME = "worship_projection_display_v1";
    /** 主控台：投屏窗关闭/退出全屏后的居中提示层 */
    let projectionClosedAttentionModal = null;
    /** 为 true 时表示翻页来自投屏窗口 BroadcastChannel，不向投屏窗口回发「控制台已翻页」提示 */
    let suppressProjectionConsoleNotify = false;

    const state = {
        songs: [],
        currentSongId: "",
        currentPage: 0,
        ui: {
            theme: "dark",
            fontFamily: "'Microsoft YaHei','PingFang SC',sans-serif",
            fontSize: 60,
            defaultLines: 4,
            posY: 40,
            bgType: "solid-black",
            bgImage: "",
            bgImageId: "",
            bgMediaType: "image",
            lyricsBgShareToCloud: false,
            fontColor: "#ffffff",
            fontWeight: "700",
            overlayOpacityPct: 30,
            fontOpacityPct: 100,
            textStrokePx: 0,
            vignetteShape: "circle",
            vignetteCenterBrightness: 0,
            vignetteEdgeDarkness: 0,
            pageTransition: "none",
            pageTransitionSpeed: 0.6,
            fontMegaMode: false,
            defaultUploadedBgId: "",
            /** 歌词编辑区：按可视高度自动缩小字号，长歌词更易一览 */
            editorAutoFontSize: false,
            editorAutoFontMinPx: 11,
            editorAutoFontMaxPx: 20
        },
        sizePreset: "M",
        autoplay: {
            timer: null,
            progressTimer: null,
            running: false,
            elapsed: 0
        },
        playlist: {
            items: [],
            running: false,
            activeIndex: -1,
            fadeNext: false,
            autoSwitch: false
        },
        /** 诗歌库视图：全部 / 分类 / 批量 */
        library: {
            viewMode: "all"
        }
    };

    /** 批量视图：勾选 id，与 state 分开避免污染 store */
    let libraryBatchSelected = new Set();
    let librarySongDragId = "";
    /** 单行删除待确认（✕ 一次进入确认态） */
    let libraryPendingDeleteId = "";
    /** 仅在切换全部/分类/批量时做内容区淡入淡出 */
    let libraryViewModeBeforeRender = null;
    /** 右键菜单当前诗歌 id */
    let contextMenuSongId = "";

    let liveState = null;
    /** 投屏层覆盖：自由敬拜时临时替换会众屏歌词与背景（不改变主窗口 currentPage） */
    let projectionDisplayOverlay = null;
    let projectionMode = isDisplay ? "display" : (isLeader ? "leader" : null);
    let projectionCanvas = null;
    let projectionCtx = null;
    let projectionParticles = [];
    let projectionBgImage = null;
    let projectionRaf = 0;
    let projectionLastTs = 0;
    /** 投屏窗口（display=1）：固定不展示预览条与翻页按钮，仅歌词与背景 */
    let displayProjectionChromeHidden = false;
    let publishInFlight = false;
    let publishBlockedBy405 = false;
    let defaultSongPosY = 45;
    const SUPABASE_URL = "https://yetcpiorfvtysqmfsdso.supabase.co";
    const SUPABASE_ANON_KEY = "sb_publishable__jbNKXA82g1YoNcOOVDUFg_eO618zti";
    const supabase = (window.supabase && typeof window.supabase.createClient === "function")
        ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
        : null;

    function $(id) {
        return document.getElementById(id);
    }

    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }

    const GALLERY_ZOOM_LS = "worship_gallery_zoom";
    let galleryZoomLevel = 1;
    try {
        const _gz = parseFloat(localStorage.getItem(GALLERY_ZOOM_LS));
        if (Number.isFinite(_gz)) galleryZoomLevel = clamp(_gz, 0.5, 2);
    } catch (_e) {
        galleryZoomLevel = 1;
    }

    function persistGalleryZoomLevel() {
        try {
            localStorage.setItem(GALLERY_ZOOM_LS, String(galleryZoomLevel));
        } catch (_e) {
            /* ignore */
        }
    }

    function updateGalleryZoom() {
        const gal = $("layout-page-gallery");
        const valEl = $("gallery-zoom-val");
        galleryZoomLevel = clamp(Number(galleryZoomLevel) || 1, 0.5, 2);
        if (gal) {
            /* 用 --page-gallery-zoom 驱动网格 min 列宽，布局真实增高/换行，避免 transform:scale 不占位被 overflow-x:hidden 裁切 */
            gal.style.transform = "";
            gal.style.transformOrigin = "";
            try {
                gal.style.setProperty("--page-gallery-zoom", String(galleryZoomLevel));
            } catch (_e) {
                /* ignore */
            }
            gal.querySelectorAll(".layout-page-gallery-pages-scale-shell").forEach((shell) => {
                shell.style.transformOrigin = "";
                shell.style.transform = "";
                shell.style.marginBottom = "";
            });
        }
        if (valEl) valEl.textContent = `${Math.round(galleryZoomLevel * 100)}%`;
        requestAnimationFrame(() => {
            syncGalleryZoomShellVerticalGap();
        });
    }

    /** 缩放改为网格真实尺寸后不再需要 margin 补偿；仍触发画廊歌词排版以适配新卡片尺寸 */
    function syncGalleryZoomShellVerticalGap() {
        const gal = $("layout-page-gallery");
        if (!gal) return;
        gal.querySelectorAll(".layout-page-gallery-pages-scale-shell").forEach((shell) => {
            shell.style.marginBottom = "";
        });
        scheduleGalleryLyricPadRelayout();
    }

    function getLyricFontSliderMax() {
        const mega = $("font-mega-mode");
        return mega && mega.checked ? 500 : 300;
    }

    function clampLyricFontSize(v) {
        const n = Number(v);
        const base = Number.isFinite(n) ? n : 56;
        return clamp(base, 8, getLyricFontSliderMax());
    }

    /** 与投屏监视、高级编辑「行间距」滑块同源，保证监视窗与真实投屏行距一致 */
    function getAdvPreviewLineHeightNumber() {
        try {
            const lhRaw = getComputedStyle(document.documentElement).getPropertyValue("--adv-preview-line-height");
            return Math.max(1.05, Math.min(3, parseFloat(lhRaw) || 1.65));
        } catch (_e) {
            return 1.65;
        }
    }

    /** 歌词垂直位置（%），与 buildLiveState.text.topPct / 滑杆 20–70 一致 */
    function projectionTextTopPctFromLive(t) {
        const v =
            t != null && t.topPct != null && String(t.topPct) !== "" && Number.isFinite(Number(t.topPct))
                ? Number(t.topPct)
                : Number(state.ui.posY);
        return clamp(Number.isFinite(v) ? v : 40, 20, 70);
    }

    /** 高级编辑字号 / 垂直位置滑杆上的参考金线（随超大模式 max 更新） */
    function syncAdvSliderRecommendedTicks() {
        const fontIn = $("font-slider");
        const fontBar = $("font-slider-tick-bar");
        if (fontIn && fontBar) {
            const min = Number(fontIn.min) || 8;
            const max = Number(fontIn.max) || 300;
            const span = Math.max(1e-6, max - min);
            const pct = (v) => `${clamp(((Number(v) - min) / span) * 100, 0, 100)}%`;
            const marks = [60, 88, 120].filter((v) => v >= min && v <= max);
            fontBar.replaceChildren();
            marks.forEach((v) => {
                const m = document.createElement("span");
                m.className = "adv-range-tick-mark";
                m.style.left = pct(v);
                m.title = `常用参考约 ${v} px`;
                fontBar.appendChild(m);
            });
        }
        const posIn = $("pos-slider");
        const posBar = $("pos-slider-tick-bar");
        if (posIn && posBar) {
            const min = Number(posIn.min) || 20;
            const max = Number(posIn.max) || 70;
            const span = Math.max(1e-6, max - min);
            const pct = (v) => `${clamp(((Number(v) - min) / span) * 100, 0, 100)}%`;
            posBar.replaceChildren();
            [40, 45].forEach((v) => {
                const m = document.createElement("span");
                m.className = "adv-range-tick-mark";
                m.style.left = pct(v);
                m.title = `常用参考约 ${v}%`;
                posBar.appendChild(m);
            });
        }
    }

    try {
        globalThis.getAdvPreviewLineHeightNumber = getAdvPreviewLineHeightNumber;
        globalThis.projectionTextTopPctFromLive = projectionTextTopPctFromLive;
        globalThis.clampLyricFontSize = clampLyricFontSize;
        globalThis.syncAdvSliderRecommendedTicks = syncAdvSliderRecommendedTicks;
    } catch (_e) {
        /* ignore */
    }

    /** 与高级编辑「翻页动画」option value 一致；投屏与 liveState 同步使用 */
    const PAGE_TRANSITION_IDS = [
        "none",
        "fade",
        "slide-left",
        "slide-right",
        "slide-up",
        "slide-down",
        "zoom-in",
        "zoom-out",
        "flip-x",
        "flip-y",
        "rotate-left",
        "rotate-right"
    ];
    const PAGE_TRANSITION_ID_SET = new Set(PAGE_TRANSITION_IDS);

    function canonicalPageTransition(trans) {
        let t = String(trans || "none");
        if (t === "slide") t = "slide-left";
        if (t === "scale") t = "zoom-in";
        return PAGE_TRANSITION_ID_SET.has(t) ? t : "none";
    }

    function isAnimatablePageTransition(trans) {
        return canonicalPageTransition(trans) !== "none";
    }

    function readUiLike(u) {
        return u && typeof u === "object" ? u : state.ui;
    }

    function applyRadialVignetteToLayer(el, ui) {
        if (!el) return;
        const u = readUiLike(ui);
        const edge = clamp(Number(u.vignetteEdgeDarkness ?? 0), 0, 90) / 100;
        const c = clamp(Number(u.vignetteCenterBrightness ?? 0), -50, 50) / 100;
        const shape =
            u.vignetteShape === "ellipse" ? "ellipse farthest-corner" : "circle farthest-corner";
        let centerCol = "rgba(0,0,0,0)";
        if (c > 0.001) centerCol = `rgba(255,255,255,${(c * 0.55).toFixed(3)})`;
        else if (c < -0.001) centerCol = `rgba(0,0,0,${(-c * 0.5).toFixed(3)})`;
        const g = `radial-gradient(${shape} at 50% 44%, ${centerCol} 0%, rgba(0,0,0,0) 40%, rgba(0,0,0,${edge.toFixed(3)}) 100%)`;
        el.style.background = g;
        const hide = edge < 0.02 && Math.abs(c) < 0.003;
        el.style.opacity = hide ? "0" : "1";
    }

    function lyricStrokeHtmlAttrFromContext(ctx) {
        const strokePx = clamp(Number(ctx.textStrokePx ?? 0), 0, 6);
        if (strokePx <= 0) return "";
        const w = String(Math.min(strokePx, 2.5));
        const lightBg = !!(ctx.lightBg || ctx.bgWhite);
        const tcol = lightBg ? "rgba(0,0,0,0.4)" : "rgba(0,0,0,0.62)";
        return ` style="-webkit-text-stroke:${w}px ${tcol};paint-order:stroke fill"`;
    }

    function applyTypographyToPreviewRow(row, ctx) {
        if (!row) return;
        const u = readUiLike(ctx);
        const fontOp = clamp(Number(u.fontOpacityPct ?? 100), 20, 100) / 100;
        const fwRaw = u.fontWeight != null ? u.fontWeight : state.ui.fontWeight;
        const fw = fwRaw == null || fwRaw === "" ? "700" : String(fwRaw);
        row.style.fontWeight = /^(400|normal)$/i.test(fw) ? "400" : fw;
        row.style.fontFamily = u.fontFamily || state.ui.fontFamily;
        /** 与 renderDisplayLyric / refreshMonitorContent 一致：填色用 fontColor；纯白底时 text.color 仅为对比参考，不覆盖用户字色 */
        const root = String(u.fontColor ?? state.ui.fontColor ?? "#ffffff").trim() || "#ffffff";
        const tContr = u.lightBg ? "#111" : root;
        const displayColor = root || tContr || "#ffffff";
        const strokeLightBg = displayColor === "#111" || tContr === "#111";
        row.style.color = displayColor;
        row.style.opacity = String(fontOp);
        const sp = clamp(Number(u.textStrokePx ?? 0), 0, 6);
        if (sp > 0) {
            const w = Math.min(sp, 2.5);
            const tcol = strokeLightBg ? "rgba(0,0,0,0.4)" : "rgba(0,0,0,0.62)";
            row.style.webkitTextStroke = `${w}px ${tcol}`;
            row.style.paintOrder = "stroke fill";
        } else {
            row.style.webkitTextStroke = "";
            row.style.paintOrder = "";
        }
    }

    /** 将一行歌词写入预览行 DOM：同一行内用「||」分隔多段时横向排列（.lyric-row--hseg） */
    function populateLyricRowElement(rowEl, line, ctx) {
        if (!rowEl) return;
        rowEl.replaceChildren();
        rowEl.classList.remove("lyric-row--hseg");
        const splitFn =
            typeof globalThis.splitLyricRowIntoDisplaySegments === "function"
                ? globalThis.splitLyricRowIntoDisplaySegments
                : function (ln) {
                      const s = String(ln ?? "");
                      if (!s.includes("||")) return [s];
                      const p = s.split(/\s*\|\|\s*/).map((x) => x.trim()).filter(Boolean);
                      return p.length ? p : [s];
                  };
        const segs = splitFn(line);
        if (segs.length <= 1) {
            rowEl.textContent = segs[0] != null ? String(segs[0]) : String(line ?? "");
            applyTypographyToPreviewRow(rowEl, ctx);
            return;
        }
        rowEl.classList.add("lyric-row--hseg");
        segs.forEach((seg) => {
            const spn = document.createElement("span");
            spn.className = "lyric-seg";
            spn.textContent = String(seg);
            applyTypographyToPreviewRow(spn, ctx);
            rowEl.appendChild(spn);
        });
    }

    function ensureMiniPreviewVignetteLayer(mini) {
        if (!mini) return;
        let v = mini.querySelector(".mini-preview-vignette-radial");
        if (!v) {
            v = document.createElement("div");
            v.className = "mini-preview-vignette-radial";
            v.setAttribute("aria-hidden", "true");
            v.style.cssText =
                "position:absolute;inset:0;pointer-events:none;z-index:2;border-radius:inherit;transition:opacity 0.12s ease,background 0.12s ease;";
            mini.appendChild(v);
        }
        applyRadialVignetteToLayer(v, state.ui);
    }

    /** 投屏歌词使用 translateY(-50%) 配合 top% 做垂直居中，所有转场变换需叠加在此之上 */
    const LYRIC_CENTER_TRANSFORM = "translateY(-50%)";

    /** 将转场 transform 与歌词居中 transform 合并 */
    function mergeLyricCenterTransform(transPreset) {
        if (!transPreset || !transPreset.transform) return LYRIC_CENTER_TRANSFORM;
        /* 如果转场变换已经包含 translateY，不再叠加（如 rotate-left/rotate-right） */
        if (transPreset.transform.includes("translateY(")) return transPreset.transform;
        return transPreset.transform + " " + LYRIC_CENTER_TRANSFORM;
    }

    function pageTransitionExitPreset(trans) {
        const t = canonicalPageTransition(trans);
        switch (t) {
            case "fade":
                return { opacity: "0", transform: mergeLyricCenterTransform({ transform: "" }) };
            case "slide-left":
                return { opacity: "0.08", transform: mergeLyricCenterTransform({ transform: "translateX(-36px)" }) };
            case "slide-right":
                return { opacity: "0.08", transform: mergeLyricCenterTransform({ transform: "translateX(36px)" }) };
            case "slide-up":
                return { opacity: "0.08", transform: mergeLyricCenterTransform({ transform: "translateY(-28px)" }) };
            case "slide-down":
                return { opacity: "0.08", transform: mergeLyricCenterTransform({ transform: "translateY(28px)" }) };
            case "zoom-in":
                return { opacity: "0.12", transform: mergeLyricCenterTransform({ transform: "scale(0.88)" }) };
            case "zoom-out":
                return { opacity: "0.12", transform: mergeLyricCenterTransform({ transform: "scale(1.12)" }) };
            case "flip-x":
                return { opacity: "0.1", transform: mergeLyricCenterTransform({ transform: "perspective(960px) rotateY(-86deg) scale(0.9)" }) };
            case "flip-y":
                return { opacity: "0.1", transform: mergeLyricCenterTransform({ transform: "perspective(960px) rotateX(-86deg) scale(0.9)" }) };
            case "rotate-left":
                return { opacity: "0.12", transform: mergeLyricCenterTransform({ transform: "rotate(-16deg) translateY(10px)" }) };
            case "rotate-right":
                return { opacity: "0.12", transform: mergeLyricCenterTransform({ transform: "rotate(16deg) translateY(10px)" }) };
            default:
                return null;
        }
    }

    function pageTransitionEnterStartPreset(trans) {
        const t = canonicalPageTransition(trans);
        switch (t) {
            case "fade":
                return { opacity: "0.02", transform: mergeLyricCenterTransform({ transform: "" }) };
            case "slide-left":
                return { opacity: "0.06", transform: mergeLyricCenterTransform({ transform: "translateX(36px)" }) };
            case "slide-right":
                return { opacity: "0.06", transform: mergeLyricCenterTransform({ transform: "translateX(-36px)" }) };
            case "slide-up":
                return { opacity: "0.06", transform: mergeLyricCenterTransform({ transform: "translateY(28px)" }) };
            case "slide-down":
                return { opacity: "0.06", transform: mergeLyricCenterTransform({ transform: "translateY(-28px)" }) };
            case "zoom-in":
                return { opacity: "0.08", transform: mergeLyricCenterTransform({ transform: "scale(1.12)" }) };
            case "zoom-out":
                return { opacity: "0.08", transform: mergeLyricCenterTransform({ transform: "scale(0.88)" }) };
            case "flip-x":
                return { opacity: "0.08", transform: mergeLyricCenterTransform({ transform: "perspective(960px) rotateY(86deg) scale(0.9)" }) };
            case "flip-y":
                return { opacity: "0.08", transform: mergeLyricCenterTransform({ transform: "perspective(960px) rotateX(86deg) scale(0.9)" }) };
            case "rotate-left":
                return { opacity: "0.1", transform: mergeLyricCenterTransform({ transform: "rotate(16deg) translateY(-10px)" }) };
            case "rotate-right":
                return { opacity: "0.1", transform: mergeLyricCenterTransform({ transform: "rotate(-16deg) translateY(-10px)" }) };
            default:
                return null;
        }
    }

    function projectionLyricTransitionTarget() {
        return $("projection-lyric-anim") || $("projection-lyric");
    }

    /** 专业投屏转场动画（ProPresenter / EasyWorship 风格）
     *
     * 使用交叉淡入淡出（cross-fade）而非文字旋转：
     * - 旧层淡出 + 新层淡入，两层的 opacity 动画同时进行
     * - 文字始终保持直立，不旋转、不倾斜
     * - 使用 rAF 同步启动动画，避免 setTimeout 造成的卡顿/闪烁
     */
    function runDisplayPageTransitionThenRender(trans, durSec, renderFn, fontOpacityPct) {
        const layer = $("projection-lyric");
        const fontOp = clamp(Number(fontOpacityPct ?? 100), 20, 100) / 100;
        const dur = clamp(Number(durSec), 0.3, 1.5);
        const t = canonicalPageTransition(trans);
        if (!layer || t === "none" || typeof renderFn !== "function") {
            if (typeof renderFn === "function") renderFn();
            return;
        }

        /* 克隆旧层（快照当前歌词内容），放在当前层下面 */
        const oldLyric = layer.cloneNode(true);
        oldLyric.id = "projection-lyric-old";
        oldLyric.style.pointerEvents = "none";
        oldLyric.style.zIndex = "9";
        oldLyric.style.transition = "none";
        oldLyric.style.opacity = "1";
        oldLyric.style.transform = LYRIC_CENTER_TRANSFORM;
        layer.parentNode.insertBefore(oldLyric, layer);

        /* 清空当前层，渲染新内容 */
        renderFn({ pageTransitionMidSwap: true });

        /* 同步新层基础样式（须保留 translateY(-50%)，否则 top% 垂直中心会失效，歌词整体偏下） */
        layer.style.transition = "none";
        layer.style.opacity = "0";
        layer.style.transform = LYRIC_CENTER_TRANSFORM;

        /* 双 rAF 确保 DOM 已渲染后再启动动画，消除闪烁 */
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const ease = "cubic-bezier(0.4, 0, 0.2, 1)";
                oldLyric.style.transition = `opacity ${dur}s ${ease}`;
                layer.style.transition = `opacity ${dur}s ${ease}`;
                oldLyric.style.opacity = "0";
                layer.style.opacity = String(fontOp);
            });
        });

        /* 动画结束后移除旧层，并恢复可复用的 transform，避免后续非转场渲染继承错误矩阵 */
        window.setTimeout(() => {
            if (oldLyric.parentNode) oldLyric.parentNode.removeChild(oldLyric);
            try {
                layer.style.transition = "";
                layer.style.transform = LYRIC_CENTER_TRANSFORM;
            } catch (_e) {
                /* ignore */
            }
        }, Math.round(dur * 1000) + 200);
    }

    try {
        globalThis.__worshipCanonicalPageTransition = canonicalPageTransition;
        globalThis.__worshipRunDisplayPageTransitionThenRender = runDisplayPageTransitionThenRender;
    } catch (_e) {
        /* ignore */
    }

    /** 投屏监视歌词翻页：独立定时器，勿与 mini 预览共用 */
    let monitorLyricTransTimer = 0;
    let monitorLyricTransPending = null;

    function flushMonitorLyricTrans() {
        if (monitorLyricTransTimer) {
            clearTimeout(monitorLyricTransTimer);
            monitorLyricTransTimer = 0;
        }
        const cb = monitorLyricTransPending;
        monitorLyricTransPending = null;
        if (cb) cb();
    }

    function runMonitorLyricExitThen(el, trans, durSec, onExitComplete) {
        const dur = clamp(Number(durSec), 0.3, 1.5);
        const ease = "cubic-bezier(0.4, 0, 0.2, 1)";
        if (!onExitComplete) {
            flushMonitorLyricTrans();
            return;
        }
        if (!el) {
            flushMonitorLyricTrans();
            onExitComplete();
            return;
        }
        flushMonitorLyricTrans();
        if (!el.isConnected) {
            onExitComplete();
            return;
        }
        const t = canonicalPageTransition(trans);
        if (t === "none") {
            onExitComplete();
            return;
        }
        const exitPreset = pageTransitionExitPreset(t);
        if (!exitPreset) {
            onExitComplete();
            return;
        }
        el.style.transition = `opacity ${dur}s ${ease}, transform ${dur}s ${ease}`;
        el.style.opacity = exitPreset.opacity;
        el.style.transform = exitPreset.transform;
        monitorLyricTransPending = onExitComplete;
        monitorLyricTransTimer = window.setTimeout(() => {
            monitorLyricTransTimer = 0;
            const fn = monitorLyricTransPending;
            monitorLyricTransPending = null;
            if (fn) fn();
        }, Math.round(dur * 1000));
    }

    /** 页面画廊歌词翻页：独立定时器，勿与投屏监视 / 迷你预览共用 */
    let galleryLyricTransTimer = 0;
    let galleryLyricTransPending = null;

    function flushGalleryLyricTrans() {
        if (galleryLyricTransTimer) {
            clearTimeout(galleryLyricTransTimer);
            galleryLyricTransTimer = 0;
        }
        const cb = galleryLyricTransPending;
        galleryLyricTransPending = null;
        if (cb) cb();
    }

    function runGalleryLyricExitThen(el, trans, durSec, onExitComplete) {
        const dur = clamp(Number(durSec), 0.3, 1.5);
        const ease = "cubic-bezier(0.4, 0, 0.2, 1)";
        if (!onExitComplete) {
            flushGalleryLyricTrans();
            return;
        }
        if (!el) {
            flushGalleryLyricTrans();
            onExitComplete();
            return;
        }
        flushGalleryLyricTrans();
        if (!el.isConnected) {
            onExitComplete();
            return;
        }
        const t = canonicalPageTransition(trans);
        if (t === "none") {
            onExitComplete();
            return;
        }
        const exitPreset = pageTransitionExitPreset(t);
        if (!exitPreset) {
            onExitComplete();
            return;
        }
        el.style.transition = `opacity ${dur}s ${ease}, transform ${dur}s ${ease}`;
        el.style.opacity = exitPreset.opacity;
        el.style.transform = exitPreset.transform;
        galleryLyricTransPending = onExitComplete;
        galleryLyricTransTimer = window.setTimeout(() => {
            galleryLyricTransTimer = 0;
            const fn = galleryLyricTransPending;
            galleryLyricTransPending = null;
            if (fn) fn();
        }, Math.round(dur * 1000));
    }

    /**
     * 快速预览 #mini-preview 不使用翻页过渡动画。
     * 原因：翻页过渡依赖 setTimeout + rAF，与连按翻页、切歌、后台标签节流叠加时易竞态，
     * 歌词层会停在离场 opacity≈0 或回调对脱离节点动画 → 用户看到「快速预览整块黑」；投屏端仍用设置里的 pageTransition。
     */
    const MINI_PREVIEW_ANIMATE_PAGE_CHANGE = false;

    /** 迷你预览翻页离场定时器：连按多页时必须取消旧定时器，否则回调在 innerHTML 清空后执行 → 黑屏/假加载 */
    let miniPageExitTimer = 0;
    /** 与 miniPageExitTimer 成对：清除定时器时必须执行，否则歌词层停在离场 opacity:0 → 快速预览全黑 */
    let miniPageExitPendingComplete = null;

    function flushMiniPageExitCompletion() {
        if (miniPageExitTimer) {
            clearTimeout(miniPageExitTimer);
            miniPageExitTimer = 0;
        }
        const done = miniPageExitPendingComplete;
        miniPageExitPendingComplete = null;
        if (done) done();
    }

    /** 迷你预览：仅离场（当前页歌词），结束后由回调替换 DOM */
    function runMiniPageTransitionExitThen(el, trans, durSec, onExitComplete) {
        const dur = clamp(Number(durSec), 0.3, 1.5);
        const ease = "cubic-bezier(0.4, 0, 0.2, 1)";
        if (!onExitComplete) {
            flushMiniPageExitCompletion();
            return;
        }
        if (!el) {
            flushMiniPageExitCompletion();
            onExitComplete();
            return;
        }
        flushMiniPageExitCompletion();
        if (!el.isConnected) {
            onExitComplete();
            return;
        }
        const t = canonicalPageTransition(trans);
        if (t === "none") {
            onExitComplete();
            return;
        }
        const exitPreset = pageTransitionExitPreset(t);
        if (!exitPreset) {
            onExitComplete();
            return;
        }
        el.style.transition = `opacity ${dur}s ${ease}, transform ${dur}s ${ease}`;
        el.style.opacity = exitPreset.opacity;
        el.style.transform = exitPreset.transform;
        miniPageExitPendingComplete = onExitComplete;
        miniPageExitTimer = window.setTimeout(() => {
            miniPageExitTimer = 0;
            const cb = miniPageExitPendingComplete;
            miniPageExitPendingComplete = null;
            if (cb) cb();
        }, Math.round(dur * 1000));
    }

    function cancelMiniPageExitTimer() {
        flushMiniPageExitCompletion();
    }

    /** 迷你预览：入场（新歌词已挂载后调用） */
    function runMiniPageTransitionEnter(el, trans, durSec, fontOpacityPct, endTransform) {
        const fontOp = clamp(Number(fontOpacityPct ?? 100), 20, 100) / 100;
        const dur = clamp(Number(durSec), 0.3, 1.5);
        const ease = "cubic-bezier(0.4, 0, 0.2, 1)";
        const t = canonicalPageTransition(trans);
        if (!el || t === "none") return;
        const in0 = pageTransitionEnterStartPreset(t);
        if (!in0) return;
        const endT = endTransform != null && String(endTransform).trim() ? String(endTransform).trim() : "";
        const extra = in0.transform && String(in0.transform).trim() ? String(in0.transform).trim() : "";
        /** 页面画廊歌词与 #monitor-lyric-layer 一致：top% 表示垂直中心，需保留 translateY(-50%) 与入场位移的合成 */
        const startTf = endT ? (extra ? `${endT} ${extra}` : endT) : extra;
        el.style.transition = "none";
        el.style.transform = startTf || "";
        el.style.opacity = in0.opacity;
        requestAnimationFrame(() => {
            el.style.transition = `opacity ${dur}s ${ease}, transform ${dur}s ${ease}`;
            el.style.opacity = String(fontOp);
            el.style.transform = endT || "";
        });
        window.setTimeout(() => {
            if (!el || !el.isConnected) return;
            el.style.opacity = String(fontOp);
            el.style.transform = endT || "";
        }, Math.round(dur * 1000) + 120);
    }

    /** 离场 → 回调重建内容 → 入场（快速预览翻页） */
    function runMiniPageTransitionThenRender(el, trans, durSec, fontOpacityPct, afterExitCb) {
        if (!afterExitCb) return;
        if (!el || canonicalPageTransition(trans) === "none") {
            afterExitCb();
            return;
        }
        runMiniPageTransitionExitThen(el, trans, durSec, () => {
            afterExitCb();
            const mini = $("mini-preview");
            const st = mini?.querySelector(".mini-preview-lyric-stage");
            if (st) runMiniPageTransitionEnter(st, trans, durSec, fontOpacityPct);
        });
    }

    /** 设置面板演示：同一段内容先离场再入场（不涉及换词） */
    function runMiniPageTransitionPreviewOnElement(el, trans, durSec, fontOpacityPct) {
        const dur = clamp(Number(durSec), 0.3, 1.5);
        if (!el || canonicalPageTransition(trans) === "none") return;
        runMiniPageTransitionExitThen(el, trans, dur, () => {
            runMiniPageTransitionEnter(el, trans, dur, fontOpacityPct);
        });
    }

    let miniPreviewTransitionDemoTimer = 0;
    /** @param {number|undefined} speedOverrideSec 拖动翻页速度滑块时传入，避免在未提交 state 前读旧值 */
    function scheduleMiniPreviewTransitionDemo(speedOverrideSec) {
        if (miniPreviewTransitionDemoTimer) window.clearTimeout(miniPreviewTransitionDemoTimer);
        miniPreviewTransitionDemoTimer = window.setTimeout(() => {
            miniPreviewTransitionDemoTimer = 0;
            const mini = $("mini-preview");
            if (!mini) return;
            const stage = mini.querySelector(".mini-preview-lyric-stage");
            if (!stage) return;
            const trans = isAnimatablePageTransition(state.ui.pageTransition)
                ? canonicalPageTransition(state.ui.pageTransition)
                : "none";
            if (trans === "none") return;
            const dur =
                speedOverrideSec != null && Number.isFinite(Number(speedOverrideSec))
                    ? clamp(Number(speedOverrideSec), 0.3, 1.5)
                    : clamp(Number(state.ui.pageTransitionSpeed ?? 0.6), 0.3, 1.5);
            runMiniPageTransitionPreviewOnElement(stage, trans, dur, state.ui.fontOpacityPct);
        }, 60);
    }

    /** 高级面板滑块拖动时合并到单帧的轻量 DOM 更新，减轻卡顿 */
    let miniSliderDomRaf = 0;
    let miniSliderDomRafFn = null;
    function scheduleMiniSliderDomPreview(fn) {
        miniSliderDomRafFn = fn;
        if (miniSliderDomRaf) return;
        miniSliderDomRaf = requestAnimationFrame(() => {
            miniSliderDomRaf = 0;
            const f = miniSliderDomRafFn;
            miniSliderDomRafFn = null;
            if (f) f();
        });
    }

    /** 拖动垂直位置时仅用 GPU transform 偏移歌词舞台，避免反复改 paddingTop */
    function applyMiniPreviewPosDragTransform(posY) {
        const mini = $("mini-preview");
        if (!mini) return;
        const stage = mini.querySelector(".mini-preview-lyric-stage");
        if (!stage) return;
        const h = mini.clientHeight;
        const targetPad = lyricBlockTopPadPx(h, posY);
        const committed = Number(mini.dataset.miniLyricPadCommitted);
        const base = Number.isFinite(committed) ? committed : targetPad;
        stage.style.transform = `translateY(${targetPad - base}px)`;
        stage.style.willChange = "transform";
    }

    function clearMiniPreviewLyricStageDragTransform() {
        const mini = $("mini-preview");
        const stage = mini?.querySelector(".mini-preview-lyric-stage");
        if (!stage) return;
        stage.style.transform = "";
        stage.style.willChange = "";
    }

    function applyMiniPreviewFontSizePx(fontSize) {
        const fs = Math.round(Math.min(140, clampLyricFontSize(fontSize) * 0.42));
        $("mini-preview")?.querySelectorAll(".preview-line").forEach((row) => {
            row.style.fontSize = fs + "px";
            row.querySelectorAll(".lyric-seg").forEach((s) => {
                s.style.fontSize = fs + "px";
            });
        });
    }

    function applyMiniPreviewFontOpacityPct(pct) {
        const p = clamp(Number(pct) || 100, 20, 100) / 100;
        $("mini-preview")?.querySelectorAll(".preview-line").forEach((row) => {
            row.style.opacity = String(p);
        });
    }

    function applyMiniPreviewProjectionMaskOpacity(pct) {
        const m = $("mini-preview")?.querySelector(".mini-preview-projection-mask");
        if (!m) return;
        const op = clamp(Number(pct), 0, 80) / 100;
        m.style.background = `rgba(0,0,0,${op})`;
    }

    function lyricBlockTopPadPx(boxHeight, posY) {
        const h = Number(boxHeight) || 0;
        const py = clamp(Number(posY) || 40, 20, 70);
        if (h <= 0) return 12;
        return Math.round(8 + ((py - 18) / 100) * h);
    }

    /** 与投屏监视 #monitor-lyric-layer、投屏 projection-lyric 一致：top% 为歌词块垂直中心（配合 translateY(-50%)） */
    function effectiveGalleryPosYForSong(song) {
        if (!song) return clamp(Number(state.ui.posY) || 40, 20, 70);
        const cur = currentSong();
        if (cur && String(cur.id) === String(song.id)) {
            return clamp(Number(state.ui.posY) || 40, 20, 70);
        }
        if (Number.isFinite(Number(song.posY))) return clamp(Number(song.posY), 20, 70);
        return clamp(Number(defaultSongPosY) || 40, 20, 70);
    }

    let galleryPadRelayoutRaf = 0;
    function scheduleGalleryLyricPadRelayout() {
        if (galleryPadRelayoutRaf) return;
        galleryPadRelayoutRaf = requestAnimationFrame(() => {
            galleryPadRelayoutRaf = 0;
            relayoutGalleryLyricVerticalPads();
        });
    }

    /** 页面画廊缩略图：与 #monitor-lyric-layer 相同语义 — top% 为歌词块垂直中心（translateY(-50%)），左右 4% 与投屏一致 */
    function applyGalleryCardLyricVerticalLayout(card, lyricAnim, song) {
        if (!card || !lyricAnim) return;
        const py = effectiveGalleryPosYForSong(song);
        const topPct = clamp(Number(py), 0, 100);
        /* 用逐个属性赋值代替 cssText，避免覆盖正在进行的转场动画的 transition / opacity / transform */
        lyricAnim.style.position = "absolute";
        lyricAnim.style.left = "4%";
        lyricAnim.style.right = "4%";
        lyricAnim.style.width = "auto";
        lyricAnim.style.zIndex = "2";
        lyricAnim.style.top = topPct + "%";
        lyricAnim.style.boxSizing = "border-box";
        lyricAnim.style.padding = "0 0 8px 0";
        lyricAnim.style.transformOrigin = "center center";
        lyricAnim.style.display = "flex";
        lyricAnim.style.flexDirection = "column";
        lyricAnim.style.alignItems = "center";
        lyricAnim.style.transform = LYRIC_CENTER_TRANSFORM;
    }

    let galleryLayoutResizeObserver = null;
    function ensureGalleryLayoutResizeObserver() {
        const gal = document.getElementById("layout-page-gallery");
        if (!gal || galleryLayoutResizeObserver) return;
        if (typeof ResizeObserver !== "function") return;
        try {
            galleryLayoutResizeObserver = new ResizeObserver(() => {
                relayoutGalleryLyricVerticalPads();
                syncGalleryZoomShellVerticalGap();
            });
            galleryLayoutResizeObserver.observe(gal);
        } catch (_e) {
            galleryLayoutResizeObserver = null;
        }
    }

    /**
     * 画廊卡片内歌词：按卡片相对 1920 投屏画布的宽度比例设置 px 字号与描边，使与投屏监视内 scale(1920) 的视觉比例一致。
     */
    function syncGalleryCardLyricFontsToProjectionScale() {
        const gal = document.getElementById("layout-page-gallery");
        if (!gal) return;
        const refW = 1920;
        const band = 0.92;
        const lh = getAdvPreviewLineHeightNumber();
        const baseFs = clampLyricFontSize(state.ui.fontSize);
        const spRaw = clamp(Number(state.ui.textStrokePx ?? 0), 0, 6);
        gal.querySelectorAll(".gallery-page-card[data-gallery-card]").forEach((card) => {
            const sid = card.getAttribute("data-song-id");
            const plSong = state.songs.find((s) => String(s.id) === String(sid || ""));
            if (!plSong) return;
            const wTotal = Math.max(1, card.getBoundingClientRect().width);
            const scale = (wTotal * band) / refW;
            const fsPx = Math.max(5, Math.round(baseFs * scale));
            const lightBg = effectiveSongBackground(plSong).bgType === "solid-white";
            const root = String(state.ui.fontColor ?? "#ffffff").trim() || "#ffffff";
            const tContr = lightBg ? "#111" : root;
            const displayColor = root || tContr || "#ffffff";
            const strokeLightBg = displayColor === "#111" || tContr === "#111";
            const tcol = strokeLightBg ? "rgba(0,0,0,0.4)" : "rgba(0,0,0,0.62)";
            const applyScaledTypography = (row) => {
                row.style.fontSize = `${fsPx}px`;
                row.style.lineHeight = String(lh);
                if (spRaw > 0) {
                    const w = Math.min(spRaw, 2.5) * scale;
                    row.style.webkitTextStroke = `${w}px ${tcol}`;
                    row.style.paintOrder = "stroke fill";
                } else {
                    row.style.webkitTextStroke = "";
                    row.style.paintOrder = "";
                }
            };
            card.querySelectorAll(".gallery-card-line").forEach((row) => {
                applyScaledTypography(row);
                row.querySelectorAll(".lyric-seg").forEach(applyScaledTypography);
            });
        });
    }

    function relayoutGalleryLyricVerticalPads() {
        const gal = document.getElementById("layout-page-gallery");
        if (!gal) return;
        gal.querySelectorAll(".gallery-page-card[data-gallery-card]").forEach((card) => {
            const sid = card.getAttribute("data-song-id");
            const plSong = state.songs.find((s) => String(s.id) === String(sid || ""));
            const lyricAnim = card.querySelector(":scope > .gallery-card-lyric-anim");
            if (!lyricAnim || !plSong) return;
            applyGalleryCardLyricVerticalLayout(card, lyricAnim, plSong);
        });
        syncGalleryCardLyricFontsToProjectionScale();
        syncGalleryZoomShellVerticalGap();
    }

    function syncPosYFromCurrentSong() {
        const song = currentSong();
        state.ui.posY = song && Number.isFinite(Number(song.posY))
            ? clamp(Number(song.posY), 20, 70)
            : defaultSongPosY;
    }

    function syncOverlayFontOpacityFromCurrentSong() {
        const song = currentSong();
        state.ui.overlayOpacityPct = song && Number.isFinite(Number(song.overlayOpacityPct))
            ? clamp(Number(song.overlayOpacityPct), 0, 80)
            : 30;
        state.ui.fontOpacityPct = song && Number.isFinite(Number(song.fontOpacityPct))
            ? clamp(Number(song.fontOpacityPct), 20, 100)
            : 100;
    }

    function uid() {
        return "song_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
    }

    function parseJSON(raw, fallback) {
        try {
            return raw ? JSON.parse(raw) : fallback;
        } catch (_e) {
            return fallback;
        }
    }

    function readLocalFileAsDataURL(file) {
        return new Promise((resolve, reject) => {
            if (!file) {
                reject(new Error("no file"));
                return;
            }
            const reader = new FileReader();
            reader.onload = () => {
                const s = String(reader.result || "").trim();
                if (s) resolve(s);
                else reject(new Error("empty"));
            };
            reader.onerror = () => reject(reader.error || new Error("read"));
            reader.readAsDataURL(file);
        });
    }

    function getStore(key, fallback) {
        return parseJSON(localStorage.getItem(key), fallback);
    }

    /** 与 index 中 input 对齐：允许图片与视频（仅改 JS，不依赖 HTML accept） */
    function ensureBgImageInputAcceptsVideo() {
        const inp = $("bg-image-input");
        if (!inp || inp.dataset.videoAcceptBound === "1") return;
        inp.dataset.videoAcceptBound = "1";
        inp.setAttribute("accept", "image/*,video/*,.jpg,.jpeg,.png,.gif,.webp,.bmp,.mp4,.webm,.mov,.m4v,.ogv,.mkv");
        if (!inp.hasAttribute("multiple")) inp.setAttribute("multiple", "multiple");
    }

    function isStorageQuotaExceededError(err) {
        if (!err) return false;
        if (err.name === "QuotaExceededError") return true;
        if (typeof err.code === "number" && err.code === 22) return true;
        return false;
    }

    /** 启动时尽量释放配额：删过大的投屏缓存、上传历史等，静默忽略异常 */
    function tryFreeLocalStorageForWorshipBoot() {
        try {
            const liveKey = STORAGE.LIVE;
            const liveRaw = localStorage.getItem(liveKey);
            if (liveRaw && liveRaw.length > 180000) {
                localStorage.removeItem(liveKey);
            }
            const histRaw = localStorage.getItem(CLOUD_UPLOAD_HISTORY_LS);
            if (histRaw && histRaw.length > 32000) {
                localStorage.removeItem(CLOUD_UPLOAD_HISTORY_LS);
            }
            const legacyLiveKeys = ["worship.live.v4", "worship.live.v3", "worship.live"];
            for (let i = 0; i < legacyLiveKeys.length; i++) {
                try {
                    localStorage.removeItem(legacyLiveKeys[i]);
                } catch (_e) {
                    /* ignore */
                }
            }
        } catch (_e) {
            /* ignore */
        }
    }

    function setStore(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (err) {
            if (isStorageQuotaExceededError(err)) return;
            throw err;
        }
    }

    function showToast(text, triggerElement, opts) {
        /* 实现见 js/utils.js 的 globalThis.showToast（支持 opts.variant、就近定位） */
        return globalThis.showToast(text, triggerElement, opts);
    }

    /** 成功类提示：与 showToast 共用 #toast，在触发控件旁显示（不再使用右下角独立条） */
    function showCornerSuccessToast(message, anchorEl) {
        showToast(String(message || "").trim(), anchorEl || null, { variant: "success" });
    }

    /** 从歌词纯文本中移除内嵌 data:*;base64，避免误传大图导致 POST 过大 */
    function stripBase64DataUrlsFromLyrics(text) {
        return String(text || "").replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=\s]+/gi, "");
    }

    /** 从 localStorage 读取分享用昵称，无则「匿名」 */
    function readCloudShareUserNicknameForPost() {
        try {
            const a = String(localStorage.getItem("worship.user_nickname") || "").trim();
            if (a) return a;
            const b = String(localStorage.getItem("user_nickname") || "").trim();
            if (b) return b;
        } catch (_e) {
            /* ignore */
        }
        return "匿名";
    }

    /**
     * 分享云端 POST：仅含 title、lyrics、author、user_nickname 四个纯字符串字段；
     * 禁止附带 settings、base64、DOM 或其它键。
     */
    function buildCloudSharePostBodyStrict(titleFromEditor, lyricsFromEditor, authorFromSong) {
        const title = String(titleFromEditor || "").trim();
        const lyrics = stripBase64DataUrlsFromLyrics(
            String(lyricsFromEditor || "")
                .replace(/\r\n/g, "\n")
                .replace(/\r/g, "\n")
        );
        const author = String(authorFromSong || "").trim() || "佚名";
        const user_nickname = readCloudShareUserNicknameForPost();
        return JSON.stringify({
            title,
            lyrics,
            author,
            user_nickname
        });
    }

    function canUploadSongToCloud() {
        const song = currentSong();
        if (!song) return false;
        const title = String($("song-title-input")?.value ?? song.title ?? "").trim();
        const lyrics = String($("lyric-editor-large")?.value ?? song.lyrics ?? "").trim();
        return title.length > 0 || lyrics.length > 0;
    }

    function updateCloudUploadBtnState() {
        const btn = $("upload-cloud-btn");
        const label = $("upload-cloud-btn-label");
        if (!btn) return;
        if (cloudUploadInFlight) {
            btn.disabled = true;
            btn.setAttribute("aria-busy", "true");
            if (label) label.textContent = "分享中...";
            return;
        }
        btn.removeAttribute("aria-busy");
        const can = canUploadSongToCloud();
        btn.disabled = !can;
        if (label) label.textContent = "分享云端";
    }

    function initCloudShareActionGroup() {
        const wrap = $("upload-cloud-action-wrap");
        const uploadBtn = $("upload-cloud-btn");
        const histBtn = $("upload-history-toggle-btn");
        const dd = $("upload-history-dropdown");
        if (wrap) {
            wrap.classList.add("cloud-share-group");
            wrap.removeAttribute("style");
        }
        if (uploadBtn) {
            uploadBtn.classList.add("cloud-share-group__btn");
            uploadBtn.title = "将当前诗歌与高级编辑设置分享至云端，生成分享链接";
        }
        if (histBtn) {
            histBtn.classList.add("cloud-share-group__btn");
            histBtn.title = "查看最近 5 条云端分享记录";
            const ht = histBtn.querySelector(".editor-action-bar-btn__text");
            if (ht) ht.textContent = "上传历史";
        }
        const uLab = $("upload-cloud-btn-label");
        if (uLab) uLab.textContent = "分享云端";
        if (dd) {
            dd.classList.add("cloud-upload-history-panel");
            dd.removeAttribute("style");
            dd.setAttribute("aria-label", "上传历史");
        }
        updateCloudUploadBtnState();
    }

    function positionFixedPanelNearElement(panel, anchor) {
        if (!panel || !anchor || typeof anchor.getBoundingClientRect !== "function") return;
        const r = anchor.getBoundingClientRect();
        const pad = 10;
        const w = Math.min(400, window.innerWidth - 20);
        let left = r.left + r.width / 2 - w / 2;
        left = Math.max(10, Math.min(left, window.innerWidth - w - 10));
        let top = r.bottom + pad;
        const reserve = Math.min(280, window.innerHeight * 0.5);
        if (top + reserve > window.innerHeight - 8) {
            top = Math.max(8, r.top - reserve - pad);
        }
        panel.style.position = "fixed";
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.width = `${w}px`;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        panel.style.transform = "none";
        panel.style.zIndex = "100051";
    }

    function dismissCloudUploadFeedbackToast() {
        const root = $("corner-cloud-upload-toast");
        if (!root) return;
        root.classList.remove("corner-success-toast--in");
        root.classList.add("corner-success-toast--out");
        if (cloudUploadToastFadeTimer) clearTimeout(cloudUploadToastFadeTimer);
        cloudUploadToastFadeTimer = setTimeout(() => {
            cloudUploadToastFadeTimer = 0;
            root.hidden = true;
        }, 360);
    }

    function showCloudUploadFeedbackToast(ok, shareUrl) {
        const root = $("corner-cloud-upload-toast");
        const msg = $("corner-cloud-upload-msg");
        const wrap = $("corner-cloud-upload-link-wrap");
        const link = $("corner-cloud-upload-link");
        if (!root || !msg) return;
        positionFixedPanelNearElement(root, $("upload-cloud-btn") || $("upload-history-toggle-btn"));
        if (cloudUploadToastShowTimer) {
            clearTimeout(cloudUploadToastShowTimer);
            cloudUploadToastShowTimer = 0;
        }
        if (cloudUploadToastFadeTimer) {
            clearTimeout(cloudUploadToastFadeTimer);
            cloudUploadToastFadeTimer = 0;
        }
        root.classList.remove("corner-success-toast--out");
        root.classList.add("corner-success-toast--in");
        root.hidden = false;
        if (ok) {
            root.style.borderColor = "rgba(46, 125, 50, 0.45)";
            root.style.color = "#c8f5d4";
            msg.textContent = "✅ 已上传云端";
            if (shareUrl && wrap && link) {
                wrap.hidden = false;
                link.href = shareUrl;
                link.textContent = shareUrl;
            } else if (wrap) {
                wrap.hidden = true;
            }
            cloudUploadToastShowTimer = setTimeout(() => {
                cloudUploadToastShowTimer = 0;
                dismissCloudUploadFeedbackToast();
            }, 12000);
        } else {
            if (wrap) wrap.hidden = true;
            root.style.borderColor = "rgba(198, 40, 40, 0.55)";
            root.style.color = "#ffcdd2";
            msg.textContent = "❌ 上传失败，请稍后重试";
            cloudUploadToastShowTimer = setTimeout(() => {
                cloudUploadToastShowTimer = 0;
                dismissCloudUploadFeedbackToast();
            }, 4500);
        }
        void root.offsetWidth;
    }

    let editorValidationHintTimer = 0;

    function getEditorTitleLyricsTrimmed() {
        return {
            title: String($("song-title-input")?.value || "").trim(),
            lyrics: String($("lyric-editor-large")?.value || "").trim()
        };
    }

    function hasUnsupportedDangerousPatterns(title, lyrics) {
        const s = `${String(title || "")}\n${String(lyrics || "")}`;
        if (/<\s*script\b/i.test(s)) return true;
        if (/<\s*\/\s*script\b/i.test(s)) return true;
        if (/\bunion\s+select\b/i.test(s)) return true;
        if (/\b(xp_cmdshell|sp_executesql)\b/i.test(s)) return true;
        if (/\b(exec|execute)\s*\(/i.test(s)) return true;
        if (/(?:^|[\s;])--(?:[\s\r\n]|$)/m.test(s)) return true;
        if (/\/\*|\*\//.test(s)) return true;
        if (/;\s*(select|insert|update|delete|drop|truncate|alter|create)\b/i.test(s)) return true;
        if (/\b(and|or)\b\s+['"]?\d+\s*=\s*\d+['"]?\b/i.test(s)) return true;
        if (/['"]\s*;\s*(drop|delete|update|insert|select)\b/i.test(s)) return true;
        return false;
    }

    function validateCloudUploadContent() {
        const { title, lyrics } = getEditorTitleLyricsTrimmed();
        if (!title) return { ok: false, message: "⚠️ 请先输入诗歌标题" };
        if (!lyrics) return { ok: false, message: "⚠️ 歌词内容为空，请先编辑歌词" };
        if (title.length > 100) return { ok: false, message: "⚠️ 标题过长，请控制在100字以内" };
        if (lyrics.length > 5000) return { ok: false, message: "⚠️ 歌词内容过长，请精简后再上传" };
        if (hasUnsupportedDangerousPatterns(title, lyrics)) {
            return { ok: false, message: "⚠️ 内容包含不支持的字符，请检查" };
        }
        return { ok: true, title, lyrics };
    }

    function normalizeUploadDedupTitle(text) {
        return String(text ?? "").trim().toLowerCase();
    }

    function normalizeUploadDedupLyricsPrefix(lyrics, maxLen) {
        const n = Math.max(0, Number(maxLen) || 100);
        return String(lyrics ?? "")
            .trim()
            .toLowerCase()
            .slice(0, n);
    }

    function findUploadDuplicateInSongLibrary(title, lyrics) {
        const wantTitle = normalizeUploadDedupTitle(title);
        const wantLyPrefix = normalizeUploadDedupLyricsPrefix(lyrics, 100);
        const cur = currentSong();
        const curId = cur && cur.id;
        if (!Array.isArray(state.songs)) return null;
        for (let i = 0; i < state.songs.length; i++) {
            const s = state.songs[i];
            if (!s || s.id === curId) continue;
            if (normalizeUploadDedupTitle(s.title) !== wantTitle) continue;
            if (normalizeUploadDedupLyricsPrefix(s.lyrics, 100) !== wantLyPrefix) continue;
            return s;
        }
        return null;
    }

    function hideEditorValidationHint() {
        const el = $("editor-validation-hint");
        if (!el) return;
        el.style.opacity = "0";
        el.style.pointerEvents = "none";
        window.setTimeout(() => {
            if (el.style.opacity === "0") el.style.display = "none";
        }, 320);
    }

    function dismissEditorValidationHintNow() {
        if (editorValidationHintTimer) {
            clearTimeout(editorValidationHintTimer);
            editorValidationHintTimer = 0;
        }
        hideEditorValidationHint();
    }

    function ensureEditorValidationHintBar() {
        let el = $("editor-validation-hint");
        if (el) return el;
        const editorArea = $("editor-area");
        if (!editorArea) return null;
        el = document.createElement("div");
        el.id = "editor-validation-hint";
        el.setAttribute("role", "alert");
        el.style.cssText = [
            "display:none",
            "opacity:0",
            "box-sizing:border-box",
            "align-items:center",
            "gap:10px",
            "margin:0 0 10px 0",
            "padding:10px 12px 10px 14px",
            "border-radius:10px",
            "border:1px solid rgba(212,168,72,0.55)",
            "border-left:4px solid #e6a82a",
            "background:linear-gradient(135deg,rgba(110,82,28,0.92),rgba(58,44,18,0.94))",
            "color:#fff",
            "font-size:0.92rem",
            "font-weight:600",
            "line-height:1.45",
            "box-shadow:0 6px 20px rgba(0,0,0,0.35)",
            "transition:opacity 0.3s ease",
            "pointer-events:auto"
        ].join(";");
        el.style.display = "none";
        const icon = document.createElement("span");
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = "⚠️";
        icon.style.flexShrink = "0";
        const msg = document.createElement("span");
        msg.id = "editor-validation-hint-msg";
        msg.style.flex = "1";
        msg.style.minWidth = "0";
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.setAttribute("aria-label", "关闭提示");
        closeBtn.textContent = "✕";
        closeBtn.style.cssText =
            "flex-shrink:0;border:none;background:rgba(255,255,255,0.12);color:#fff;width:28px;height:28px;border-radius:8px;cursor:pointer;font-size:1rem;line-height:1;padding:0;";
        closeBtn.addEventListener("click", dismissEditorValidationHintNow);
        el.appendChild(icon);
        el.appendChild(msg);
        el.appendChild(closeBtn);
        const header = $("editor-main-body");
        if (header && header.parentNode === editorArea) {
            editorArea.insertBefore(el, header);
        } else {
            editorArea.insertBefore(el, editorArea.children[1] || null);
        }
        return el;
    }

    function showEditorValidationHint(message) {
        const el = ensureEditorValidationHintBar();
        const msg = $("editor-validation-hint-msg");
        if (!el || !msg) return;
        if (editorValidationHintTimer) {
            clearTimeout(editorValidationHintTimer);
            editorValidationHintTimer = 0;
        }
        msg.textContent = String(message || "");
        el.style.display = "flex";
        el.style.opacity = "0";
        el.style.pointerEvents = "auto";
        void el.offsetWidth;
        el.style.opacity = "1";
        editorValidationHintTimer = window.setTimeout(() => {
            editorValidationHintTimer = 0;
            hideEditorValidationHint();
        }, 3000);
    }

    function readCloudUploadHistory() {
        try {
            const raw = localStorage.getItem(CLOUD_UPLOAD_HISTORY_LS);
            const a = raw ? JSON.parse(raw) : [];
            return Array.isArray(a) ? a.slice(0, CLOUD_UPLOAD_HISTORY_MAX) : [];
        } catch {
            return [];
        }
    }

    function appendCloudUploadHistoryRecord(title, url) {
        const t = String(title || "").trim() || "未命名";
        const u = String(url || "").trim();
        if (!u) return;
        let arr = readCloudUploadHistory();
        arr = arr.filter((x) => x && x.url !== u);
        arr.unshift({ title: t, at: new Date().toISOString(), url: u });
        arr = arr.slice(0, CLOUD_UPLOAD_HISTORY_MAX);
        try {
            localStorage.setItem(CLOUD_UPLOAD_HISTORY_LS, JSON.stringify(arr));
        } catch (err) {
            if (!isStorageQuotaExceededError(err)) {
                /* 其它写入失败同样静默，避免打断分享流程 */
            }
        }
    }

    function formatUploadHistoryTime(iso) {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return "";
        return d.toLocaleString("zh-CN", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit"
        });
    }

    function truncateUploadHistoryUrlForDisplay(url) {
        const u = String(url || "");
        if (u.length <= CLOUD_UPLOAD_HISTORY_URL_TRUNC) {
            return { text: u, expandable: false };
        }
        return {
            text: `${u.slice(0, CLOUD_UPLOAD_HISTORY_URL_TRUNC)}…`,
            expandable: true
        };
    }

    async function copyUploadHistoryUrlToClipboard(url, anchorEl) {
        const text = String(url || "");
        if (!text) return;
        try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
                await navigator.clipboard.writeText(text);
                showToast("已复制链接", anchorEl || $("upload-history-toggle-btn"));
                return;
            }
        } catch {
            /* fall through */
        }
        try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.setAttribute("readonly", "");
            ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            ta.remove();
            showToast("已复制链接", anchorEl || $("upload-history-toggle-btn"));
        } catch {
            showToast("复制失败", anchorEl || $("upload-history-toggle-btn"));
        }
    }

    function renderUploadHistoryDropdown() {
        const list = $("upload-history-dropdown-list");
        if (!list) return;
        const items = readCloudUploadHistory();
        list.textContent = "";
        const panelTitle = document.createElement("div");
        panelTitle.className = "cloud-upload-history__title";
        panelTitle.textContent = "📋 上传历史";
        list.appendChild(panelTitle);
        if (!items.length) {
            const empty = document.createElement("div");
            empty.className = "cloud-upload-history__empty";
            empty.textContent = "暂无上传记录";
            list.appendChild(empty);
            return;
        }
        items.forEach((rec, idx) => {
            const row = document.createElement("div");
            row.className = "cloud-upload-history__row";
            if (idx < items.length - 1) row.classList.add("cloud-upload-history__row--bordered");
            const main = document.createElement("div");
            main.className = "cloud-upload-history__row-main";
            const titleEl = document.createElement("div");
            titleEl.className = "cloud-upload-history__song-title";
            titleEl.textContent = rec.title || "未命名";
            const timeEl = document.createElement("div");
            timeEl.className = "cloud-upload-history__song-time";
            timeEl.textContent = formatUploadHistoryTime(rec.at);
            const urlBtn = document.createElement("button");
            urlBtn.type = "button";
            urlBtn.className = "js-upload-history-url cloud-upload-history__url";
            urlBtn.dataset.fullUrl = String(rec.url || "");
            urlBtn.dataset.expanded = "0";
            const disp = truncateUploadHistoryUrlForDisplay(rec.url);
            urlBtn.textContent = disp.text;
            urlBtn.title = disp.expandable ? "点击展开或收起完整链接" : String(rec.url || "");
            const copyBtn = document.createElement("button");
            copyBtn.type = "button";
            copyBtn.className = "js-upload-history-copy cloud-upload-history__copy";
            copyBtn.dataset.url = String(rec.url || "");
            copyBtn.textContent = "📋 复制链接";
            main.appendChild(titleEl);
            main.appendChild(timeEl);
            main.appendChild(urlBtn);
            row.appendChild(main);
            row.appendChild(copyBtn);
            list.appendChild(row);
        });
    }

    function uploadHistoryDocClickClose(e) {
        const wrap = $("upload-cloud-action-wrap");
        if (!uploadHistoryDropdownOpen || !wrap) return;
        if (wrap.contains(e.target)) return;
        closeUploadHistoryDropdown();
    }

    function uploadHistoryEscClose(e) {
        if (!uploadHistoryDropdownOpen) return;
        if (e.key === "Escape") closeUploadHistoryDropdown();
    }

    function closeUploadHistoryDropdown() {
        const dd = $("upload-history-dropdown");
        const toggleBtn = $("upload-history-toggle-btn");
        if (dd) dd.hidden = true;
        if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "false");
        uploadHistoryDropdownOpen = false;
        document.removeEventListener("click", uploadHistoryDocClickClose);
        document.removeEventListener("keydown", uploadHistoryEscClose, true);
    }

    function toggleUploadHistoryDropdown() {
        const dd = $("upload-history-dropdown");
        const toggleBtn = $("upload-history-toggle-btn");
        if (!dd) return;
        if (uploadHistoryDropdownOpen) {
            closeUploadHistoryDropdown();
            return;
        }
        renderUploadHistoryDropdown();
        dd.hidden = false;
        uploadHistoryDropdownOpen = true;
        if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "true");
        window.setTimeout(() => {
            document.addEventListener("click", uploadHistoryDocClickClose);
            document.addEventListener("keydown", uploadHistoryEscClose, true);
        }, 0);
    }

    function initUploadHistoryDropdownInteractions() {
        const dd = $("upload-history-dropdown");
        if (!dd || dd.dataset.uploadHistBound === "1") return;
        dd.dataset.uploadHistBound = "1";
        dd.addEventListener("click", (e) => {
            const urlBtn = e.target.closest(".js-upload-history-url");
            if (urlBtn && dd.contains(urlBtn)) {
                const full = String(urlBtn.dataset.fullUrl || "");
                if (full.length <= CLOUD_UPLOAD_HISTORY_URL_TRUNC) return;
                const expanded = urlBtn.dataset.expanded === "1";
                if (expanded) {
                    urlBtn.textContent = truncateUploadHistoryUrlForDisplay(full).text;
                    urlBtn.dataset.expanded = "0";
                } else {
                    urlBtn.textContent = full;
                    urlBtn.dataset.expanded = "1";
                }
                e.stopPropagation();
                return;
            }
            const copyBtn = e.target.closest(".js-upload-history-copy");
            if (copyBtn && dd.contains(copyBtn)) {
                e.stopPropagation();
                void copyUploadHistoryUrlToClipboard(copyBtn.dataset.url || "", copyBtn);
            }
        });
    }

    async function uploadCurrentSongToCloud() {
        if (cloudUploadInFlight) return;
        updateCloudUploadBtnState();
        const btn = $("upload-cloud-btn");
        if (!btn || btn.disabled) return;

        const chk = validateCloudUploadContent();
        if (!chk.ok) {
            showEditorValidationHint(chk.message);
            return;
        }

        if (findUploadDuplicateInSongLibrary(chk.title, chk.lyrics)) {
            showEditorValidationHint("☁️ 这首诗歌似乎已经上传过了，无需重复提交");
            return;
        }

        syncEditorToSong();
        const song = currentSong();
        if (!song) {
            updateCloudUploadBtnState();
            return;
        }
        const title = String(chk.title || "").trim();
        const lyricsEditorValue = String($("lyric-editor-large")?.value ?? chk.lyrics ?? "");
        const authorRaw = song.author;
        const authorForPost =
            typeof authorRaw === "string" && authorRaw.trim() ? authorRaw.trim() : "佚名";
        const postBody = buildCloudSharePostBodyStrict(title, lyricsEditorValue, authorForPost);
        cloudUploadInFlight = true;
        updateCloudUploadBtnState();
        try {
            const res = await fetch(ONLINE_HYMN_SEARCH_WORKER_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: postBody
            });
            let data = null;
            try {
                data = await res.json();
            } catch {
                data = null;
            }
            if (data && data.error === "duplicate") {
                showEditorValidationHint("☁️ 云端已存在相同的诗歌，请勿重复上传");
            } else if (res.ok && data && data.success === true && data.shareId) {
                const sid = encodeURIComponent(String(data.shareId));
                const shareUrl = `${ONLINE_HYMN_SEARCH_WORKER_URL}/?share=${sid}`;
                appendCloudUploadHistoryRecord(title, shareUrl);
                showCloudUploadFeedbackToast(true, shareUrl);
            } else {
                showCloudUploadFeedbackToast(false, "");
            }
        } catch (_e) {
            showCloudUploadFeedbackToast(false, "");
        } finally {
            cloudUploadInFlight = false;
            updateCloudUploadBtnState();
        }
    }

    function showPopupBlockedBanner() {
        const el = $("popup-blocked-banner");
        if (!el) return;
        el.hidden = false;
    }

    /** 首次引导完成后写入 worship_visited=true，永不再显示 */
    const WORSHIP_VISITED_LS = "worship_visited";
    const LEGACY_FIRST_VISIT_LS = "visited";

    function isWorshipFirstVisit() {
        try {
            if (localStorage.getItem(WORSHIP_VISITED_LS) === "true") return false;
            if (localStorage.getItem(LEGACY_FIRST_VISIT_LS) === "1") return false;
            return true;
        } catch (_e) {
            return false;
        }
    }

    function sanitizeWorshipExportBase(name) {
        const t = String(name || "")
            .trim()
            .replace(/[\\/:*?"<>|]/g, "_")
            .replace(/\s+/g, "_");
        return (t || "敬拜数据").slice(0, 80);
    }

    function buildExportWorshipFilename() {
        const song = currentSong();
        const base = sanitizeWorshipExportBase(song?.title || "敬拜数据");
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${base}_${y}-${m}-${day}.worship`;
    }

    function buildBatchExportWorshipFilename() {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `批量诗歌_${y}-${m}-${day}.worship`;
    }

    function updateAdvSliderSwatches() {
        const maskEl = $("projection-overlay-opacity-swatch");
        if (maskEl) {
            const pct = clamp(Number(state?.ui?.overlayOpacityPct ?? 30), 0, 80);
            const a = (pct / 80) * 0.82;
            const alpha = clamp(a, 0, 0.82);
            maskEl.style.background = `linear-gradient(rgba(0,0,0,${alpha}), rgba(0,0,0,${alpha})), #ffffff`;
            maskEl.style.opacity = "1";
        }
        const fontSw = $("font-opacity-swatch");
        if (fontSw) {
            const pct = clamp(Number(state?.ui?.fontOpacityPct ?? 100), 20, 100);
            const g = fontSw.querySelector(".adv-slider-swatch__glyph");
            if (g) g.style.opacity = String(pct / 100);
        }
        const themeSw = $("theme-bg-opacity-swatch");
        if (themeSw) {
            const slider = $("theme-bg-opacity-slider");
            const v = slider
                ? clamp(parseFloat(slider.value || "0.65"), 0.05, 1)
                : getThemeBgOpacity();
            const raw = getComputedStyle(document.documentElement).getPropertyValue("--theme-bg-image").trim();
            if (raw && raw !== "none") {
                themeSw.style.backgroundImage = raw;
            } else {
                themeSw.style.backgroundImage =
                    "linear-gradient(135deg, rgba(90,120,180,0.95), rgba(40,55,90,0.95))";
            }
            themeSw.style.backgroundSize = "cover";
            themeSw.style.backgroundPosition = "center";
            themeSw.style.opacity = String(v);
        }
    }

    function ensureFontOpacitySwatchLayout() {
        if ($("font-opacity-swatch")) return;
        const rng = $("font-opacity-slider");
        const lab =
            document.querySelector("label.adv-drawer-field-label[for=\"font-opacity-slider\"]") ||
            document.querySelector("label[for=\"font-opacity-slider\"]");
        if (!rng || !lab) return;
        if (lab.closest(".adv-drawer-slider-visual-main")) return;
        const row = document.createElement("div");
        row.className = "adv-drawer-slider-visual-row";
        const sw = document.createElement("span");
        sw.id = "font-opacity-swatch";
        sw.className = "adv-slider-swatch adv-slider-swatch--font-opacity";
        sw.setAttribute("aria-hidden", "true");
        sw.innerHTML = "<span class=\"adv-slider-swatch__glyph\">字</span>";
        const main = document.createElement("div");
        main.className = "adv-drawer-slider-visual-main";
        const p = lab.parentNode;
        if (!p) return;
        p.insertBefore(row, lab);
        row.appendChild(sw);
        row.appendChild(main);
        main.appendChild(lab);
        main.appendChild(rng);
    }

    function dismissFirstVisitOnboarding() {
        try {
            localStorage.setItem(WORSHIP_VISITED_LS, "true");
        } catch (_e) {
            /* ignore */
        }
        const el = $("first-visit-onboarding");
        if (el) el.hidden = true;
        teardownNewUserArrowGuide();
    }

    /** 首次访问：箭头式分步指引（与 worship_visited 共用，完成后不再显示）——按实际操作顺序 */
    const NEW_USER_ARROW_GUIDE_STEPS = [
        {
            selector: "#editor-lyrics-drawer-summary",
            title: "第 1 步：编辑歌词",
            text:
                "点中间栏下方的「📝 编辑歌词」标题栏展开。展开后自上而下为：歌名与字号（右侧有收起提示）；接着是「保存」「存为存档」「应用到演示屏」等按钮；下方是大块歌词编辑区（可用空行或 [page] 分段）。编辑区会浮在页面画廊之上，可向上拖动顶边加高。"
        },
        {
            selector: "#song-library",
            title: "第 2 步：加入播放列表",
            text:
                "在左侧「诗歌库」里选中要唱的诗歌，点该行右侧「+」，加入下方的「播放列表（敬拜顺序）」；可多首并拖拽排序。列表下方「💾 保存歌单」与「📋 我的歌单」并排，用于命名保存或打开本机已存歌单。（「在线搜索诗歌」当前为占位。）"
        },
        {
            selector: "#playlist-start-btn",
            title: "第 3 步：开始播放",
            text:
                "顺序排好后点「▶ 开始播放」。之后用中间「页面画廊」里的分页卡片翻页：可点击卡片，或使用键盘 ← → / 空格。"
        },
        {
            selector: "#layout-page-gallery",
            title: "第 4 步：预览页面画廊",
            text:
                "卡片区即分页预览，每张对应投屏一页。其上方同一行里：蓝色说明条介绍画廊操作，旁边有「使用帮助」「使用引导」（以及可用的「安装 App」）；再往上是征集中提示。确认分页与歌词显示无误后，再继续同步投屏。"
        },
        {
            selector: "#apply-to-display",
            title: "第 5 步：同步到演示屏",
            text:
                "在已展开的「编辑歌词」底部工具栏点「应用到演示屏」，把当前歌词与样式同步到会众投屏窗口和主领视图。（每次改词或样式后务必再点一次，会众画面才会更新。）"
        },
        {
            selector: "#open-display-btn",
            title: "第 6 步：开启与结束投屏",
            text:
                "右侧「投屏控制」有「开启投屏」「主领视角」等入口；开启投屏后会众窗打开，同一按钮变为「关闭投屏」，或按 Ctrl+Shift+E 关闭。「主领视角」可选平板/手机传数据（二维码）或在电脑打开。会众窗按 F 全屏；绿色按钮右上角 ? 可看投屏帮助。投屏时中间金色状态栏另有「结束投屏」与「分享云端」等。"
        }
    ];

    let newUserArrowGuideIndex = 0;
    let newUserArrowGuideRelayoutTimer = 0;

    function teardownNewUserArrowGuide() {
        const root = $("new-user-arrow-guide");
        if (root) {
            root.hidden = true;
            root.setAttribute("aria-hidden", "true");
        }
        if (newUserArrowGuideRelayoutTimer) {
            clearTimeout(newUserArrowGuideRelayoutTimer);
            newUserArrowGuideRelayoutTimer = 0;
        }
        const fn = teardownNewUserArrowGuide._onRelayout;
        if (fn) {
            window.removeEventListener("resize", fn);
            window.removeEventListener("scroll", fn, true);
            teardownNewUserArrowGuide._onRelayout = null;
        }
    }

    function ensureNewUserArrowGuideDom() {
        let root = $("new-user-arrow-guide");
        if (root) return root;
        root = document.createElement("div");
        root.id = "new-user-arrow-guide";
        root.className = "new-user-arrow-guide";
        root.setAttribute("role", "dialog");
        root.setAttribute("aria-modal", "true");
        root.setAttribute("aria-labelledby", "new-user-arrow-guide-title");
        root.innerHTML =
            '<div class="new-user-arrow-guide__block" aria-hidden="true"></div>' +
            '<div class="new-user-arrow-guide__ring" aria-hidden="true"></div>' +
            '<div class="new-user-arrow-guide__shaft" aria-hidden="true"></div>' +
            '<div class="new-user-arrow-guide__bubble">' +
            '<div class="new-user-arrow-guide__meta" id="new-user-arrow-guide-meta"></div>' +
            '<p class="new-user-arrow-guide__title" id="new-user-arrow-guide-title"></p>' +
            '<p class="new-user-arrow-guide__text" id="new-user-arrow-guide-text"></p>' +
            '<div class="new-user-arrow-guide__actions">' +
            '<button type="button" class="new-user-arrow-guide__skip" id="new-user-arrow-guide-skip">跳过</button>' +
            '<button type="button" class="new-user-arrow-guide__next" id="new-user-arrow-guide-next">下一步</button>' +
            "</div></div>";
        document.body.appendChild(root);
        const onSkip = () => {
            dismissFirstVisitOnboarding();
        };
        const onNext = () => {
            newUserArrowGuideIndex += 1;
            if (newUserArrowGuideIndex >= NEW_USER_ARROW_GUIDE_STEPS.length) {
                dismissFirstVisitOnboarding();
                return;
            }
            layoutNewUserArrowGuideStep();
        };
        root.querySelector("#new-user-arrow-guide-skip")?.addEventListener("click", onSkip);
        root.querySelector("#new-user-arrow-guide-next")?.addEventListener("click", onNext);
        if (!teardownNewUserArrowGuide._escBound) {
            teardownNewUserArrowGuide._escBound = true;
            document.addEventListener(
                "keydown",
                (e) => {
                    if (e.key !== "Escape") return;
                    const g = $("new-user-arrow-guide");
                    if (!g || g.hidden) return;
                    e.preventDefault();
                    dismissFirstVisitOnboarding();
                },
                true
            );
        }
        return root;
    }

    function layoutNewUserArrowGuideStep() {
        const root = $("new-user-arrow-guide");
        if (!root || root.hidden) return;
        const step = NEW_USER_ARROW_GUIDE_STEPS[newUserArrowGuideIndex];
        const ring = root.querySelector(".new-user-arrow-guide__ring");
        const shaft = root.querySelector(".new-user-arrow-guide__shaft");
        const bubble = root.querySelector(".new-user-arrow-guide__bubble");
        const meta = $("new-user-arrow-guide-meta");
        const titleEl = $("new-user-arrow-guide-title");
        const textEl = $("new-user-arrow-guide-text");
        const nextBtn = $("new-user-arrow-guide-next");
        if (!step || !ring || !shaft || !bubble || !meta || !titleEl || !textEl || !nextBtn) return;

        let target = document.querySelector(step.selector);
        if (!target) {
            for (let j = newUserArrowGuideIndex + 1; j < NEW_USER_ARROW_GUIDE_STEPS.length; j++) {
                const t2 = document.querySelector(NEW_USER_ARROW_GUIDE_STEPS[j].selector);
                if (t2) {
                    newUserArrowGuideIndex = j;
                    return layoutNewUserArrowGuideStep();
                }
            }
            dismissFirstVisitOnboarding();
            return;
        }

        try {
            target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        } catch (_e) {
            /* ignore */
        }

        const r = target.getBoundingClientRect();
        const pad = 8;
        const rx = r.left - pad;
        const ry = r.top - pad;
        const rw = r.width + pad * 2;
        const rh = r.height + pad * 2;

        ring.style.display = "block";
        ring.style.left = rx + "px";
        ring.style.top = ry + "px";
        ring.style.width = rw + "px";
        ring.style.height = rh + "px";

        meta.textContent = newUserArrowGuideIndex + 1 + " / " + NEW_USER_ARROW_GUIDE_STEPS.length;
        titleEl.textContent = step.title;
        textEl.textContent = step.text;
        const last = newUserArrowGuideIndex >= NEW_USER_ARROW_GUIDE_STEPS.length - 1;
        nextBtn.textContent = last ? "完成" : "下一步";

        bubble.style.visibility = "hidden";
        bubble.style.left = "0px";
        bubble.style.top = "0px";
        void bubble.offsetWidth;

        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const margin = 12;
        const maxBubbleW = Math.min(newUserArrowGuideIndex < 2 ? 340 : 320, vw - margin * 2);
        bubble.style.maxWidth = maxBubbleW + "px";
        bubble.style.width = maxBubbleW + "px";

        const estHeights = [215, 255, 225, 195, 205, 215];
        const estH = estHeights[newUserArrowGuideIndex] ?? 168;
        let bx = rx + rw / 2 - maxBubbleW / 2;
        bx = Math.max(margin, Math.min(bx, vw - maxBubbleW - margin));
        let by = ry + rh + 16;
        if (by + estH > vh - margin) {
            by = ry - estH - 16;
        }
        if (by < margin) {
            by = margin;
        }
        bubble.style.left = bx + "px";
        bubble.style.top = by + "px";
        bubble.style.visibility = "visible";

        const br = bubble.getBoundingClientRect();
        const tcx = r.left + r.width / 2;
        const tcy = r.top + r.height / 2;
        const bubbleCx = br.left + br.width / 2;
        const ringBottom = ry + rh;
        let x1 = bubbleCx;
        let y1 = br.top;
        if (br.top >= ringBottom - 4) {
            y1 = br.top;
        } else if (br.bottom <= ry + 4) {
            y1 = br.bottom;
        } else {
            y1 = br.top + br.height / 2;
            x1 = br.left > rx + rw ? br.left : br.right;
        }
        const x2 = tcx;
        const y2 = tcy;
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
        shaft.style.display = len < 24 ? "none" : "block";
        shaft.style.left = x1 + "px";
        shaft.style.top = y1 - 2 + "px";
        shaft.style.width = len + "px";
        shaft.style.transform = "rotate(" + ang + "deg)";
    }

    function scheduleNewUserArrowGuideRelayout() {
        if (newUserArrowGuideRelayoutTimer) clearTimeout(newUserArrowGuideRelayoutTimer);
        newUserArrowGuideRelayoutTimer = setTimeout(() => {
            newUserArrowGuideRelayoutTimer = 0;
            layoutNewUserArrowGuideStep();
        }, 48);
    }

    function startNewUserArrowGuideCore() {
        const root = ensureNewUserArrowGuideDom();
        if (!root) return;
        const prevRelayout = teardownNewUserArrowGuide._onRelayout;
        if (prevRelayout) {
            window.removeEventListener("resize", prevRelayout);
            window.removeEventListener("scroll", prevRelayout, true);
            teardownNewUserArrowGuide._onRelayout = null;
        }
        if (newUserArrowGuideRelayoutTimer) {
            clearTimeout(newUserArrowGuideRelayoutTimer);
            newUserArrowGuideRelayoutTimer = 0;
        }
        newUserArrowGuideIndex = 0;
        root.hidden = false;
        root.setAttribute("aria-hidden", "false");
        const fn = () => scheduleNewUserArrowGuideRelayout();
        teardownNewUserArrowGuide._onRelayout = fn;
        window.addEventListener("resize", fn);
        window.addEventListener("scroll", fn, true);
        const elOld = $("first-visit-onboarding");
        if (elOld) elOld.hidden = true;
        const kick = () => {
            layoutNewUserArrowGuideStep();
            try {
                $("new-user-arrow-guide-next")?.focus({ preventScroll: true });
            } catch (_e) {
                $("new-user-arrow-guide-next")?.focus();
            }
        };
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(kick, 280)));
    }

    function maybeStartNewUserArrowGuide() {
        if (isDisplay || isLeader) return;
        if (!isWorshipFirstVisit()) return;
        startNewUserArrowGuideCore();
    }

    function replayNewUserArrowGuideFromToolbar() {
        if (isDisplay || isLeader) return;
        startNewUserArrowGuideCore();
    }

    let shortcutsPanelBackdropEl = null;
    function closeShortcutsPanel() {
        if (shortcutsPanelBackdropEl) {
            shortcutsPanelBackdropEl.classList.remove("is-open");
        }
    }

    function openShortcutsPanel() {
        let bd = shortcutsPanelBackdropEl;
        if (!bd) {
            bd = document.createElement("div");
            bd.id = "shortcuts-panel-backdrop";
            bd.className = "shortcuts-panel-backdrop";
            bd.innerHTML =
                "<div class=\"shortcuts-panel\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"shortcuts-panel-title\">" +
                "<button type=\"button\" class=\"shortcuts-panel__close\" aria-label=\"关闭\">✕</button>" +
                "<h3 id=\"shortcuts-panel-title\">⌨️ 快捷键</h3>" +
                "<dl>" +
                "<dt>保存歌词</dt><dd>Ctrl+S（Windows）或 ⌘+S（Mac），等同点「保存」</dd>" +
                "<dt>翻页</dt><dd>← → 或空格；焦点在输入框/滑块时可 Alt+←/→/空格，或 Ctrl+Shift+←/→</dd>" +
                "<dt>全屏</dt><dd>F 键</dd>" +
                "<dt>黑屏 / 白屏</dt><dd>B 键 / W 键</dd>" +
                "<dt>结束投屏</dt><dd>Ctrl+Shift+E（主控台关闭会众窗口，无需切到副屏）</dd>" +
                "<dt>高级编辑</dt><dd>点击右侧「🎨 高级编辑」按钮</dd>" +
                "<dt>退出全屏</dt><dd>ESC 键</dd>" +
                "</dl></div>";
            bd.addEventListener("click", (e) => {
                if (e.target === bd) closeShortcutsPanel();
            });
            bd.querySelector(".shortcuts-panel")?.addEventListener("click", (e) => e.stopPropagation());
            bd.querySelector(".shortcuts-panel__close")?.addEventListener("click", () => closeShortcutsPanel());
            document.body.appendChild(bd);
            shortcutsPanelBackdropEl = bd;
            if (!bd.dataset.escBound) {
                bd.dataset.escBound = "1";
                document.addEventListener("keydown", (e) => {
                    if (
                        e.key === "Escape" &&
                        shortcutsPanelBackdropEl &&
                        shortcutsPanelBackdropEl.classList.contains("is-open")
                    ) {
                        closeShortcutsPanel();
                    }
                });
            }
        }
        bd.classList.add("is-open");
    }

    function getLyricTemplates() {
        const arr = getStore(LYRIC_TEMPLATES_KEY, []);
        return Array.isArray(arr) ? arr : [];
    }

    function saveLyricTemplates(list) {
        try {
            setStore(LYRIC_TEMPLATES_KEY, Array.isArray(list) ? list : []);
            return true;
        } catch (err) {
            console.warn("saveLyricTemplates", err);
            if (isStorageQuotaExceededError(err)) {
                showToast("存储空间不足，无法保存诗歌存档", $("save-as-template-btn"));
            } else {
                showToast("诗歌存档保存失败", $("save-as-template-btn"));
            }
            return false;
        }
    }

    function closeLyricTemplatePickerModal() {
        $("lyric-template-modal")?.classList.remove("is-open");
    }

    let lyricTemplateSaveModalResolve = null;

    function closeLyricTemplateSaveNameModal(result) {
        $("lyric-template-save-modal")?.classList.remove("is-open");
        const r = lyricTemplateSaveModalResolve;
        lyricTemplateSaveModalResolve = null;
        if (r) r(result);
    }

    function ensureLyricTemplateSaveNameModal() {
        let el = $("lyric-template-save-modal");
        if (el) return el;
        el = document.createElement("div");
        el.id = "lyric-template-save-modal";
        el.className = "lyric-template-save-modal";
        el.innerHTML =
            `<div class="lyric-template-save-modal-panel" role="dialog" aria-modal="true" aria-labelledby="lyric-template-save-title">` +
            `<div class="lyric-template-save-modal-head">` +
            `<h3 id="lyric-template-save-title">保存诗歌存档</h3>` +
            `<button type="button" class="lyric-template-save-modal-close" aria-label="关闭">✕</button>` +
            `</div>` +
            `<div class="lyric-template-save-modal-body">` +
            `<p class="lyric-template-save-modal-desc">将保存<b>当前歌词</b>与<b>高级编辑</b>中的样式（背景、字号、行距等）。</p>` +
            `<label class="lyric-template-save-label" for="lyric-template-save-name-input">存档名称</label>` +
            `<input type="text" id="lyric-template-save-name-input" class="lyric-template-save-input" autocomplete="off" maxlength="120" />` +
            `<div class="lyric-template-save-actions">` +
            `<button type="button" class="lyric-template-save-btn lyric-template-save-btn--secondary" id="lyric-template-save-cancel">取消</button>` +
            `<button type="button" class="lyric-template-save-btn lyric-template-save-btn--primary" id="lyric-template-save-confirm">保存</button>` +
            `</div></div></div>`;
        document.body.appendChild(el);
        const panel = el.querySelector(".lyric-template-save-modal-panel");
        const inp = el.querySelector("#lyric-template-save-name-input");
        const confirm = () => {
            const def = String(el.dataset.defaultName || "").trim() || "存档";
            const nm = String(inp?.value ?? "").trim() || def;
            closeLyricTemplateSaveNameModal(nm);
        };
        el.addEventListener("click", (e) => {
            if (e.target === el) closeLyricTemplateSaveNameModal(null);
        });
        panel?.addEventListener("click", (e) => e.stopPropagation());
        el.querySelector(".lyric-template-save-modal-close")?.addEventListener("click", () =>
            closeLyricTemplateSaveNameModal(null)
        );
        el.querySelector("#lyric-template-save-cancel")?.addEventListener("click", () =>
            closeLyricTemplateSaveNameModal(null)
        );
        el.querySelector("#lyric-template-save-confirm")?.addEventListener("click", confirm);
        inp?.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                confirm();
            }
        });
        if (!document.body.dataset.lyricTemplateSaveEscBound) {
            document.body.dataset.lyricTemplateSaveEscBound = "1";
            document.addEventListener("keydown", (e) => {
                if (e.key !== "Escape") return;
                const m = $("lyric-template-save-modal");
                if (!m || !m.classList.contains("is-open")) return;
                e.preventDefault();
                closeLyricTemplateSaveNameModal(null);
            });
        }
        return el;
    }

    function openLyricTemplateSaveNameModal(defaultName) {
        return new Promise((resolve) => {
            lyricTemplateSaveModalResolve = resolve;
            const el = ensureLyricTemplateSaveNameModal();
            el.dataset.defaultName = defaultName;
            const inp = $("lyric-template-save-name-input");
            if (inp) inp.value = defaultName;
            el.classList.add("is-open");
            requestAnimationFrame(() => {
                try {
                    inp?.focus();
                    inp?.select();
                } catch (_e) {
                    /* ignore */
                }
            });
        });
    }

    function closeSaveLyricsLibraryHintModal() {
        $("save-lyrics-library-hint-modal")?.classList.remove("is-open");
    }

    function ensureSaveLyricsLibraryHintModal() {
        let el = $("save-lyrics-library-hint-modal");
        if (el) return el;
        el = document.createElement("div");
        el.id = "save-lyrics-library-hint-modal";
        el.className = "lyric-template-save-modal";
        el.innerHTML =
            `<div class="lyric-template-save-modal-panel" role="dialog" aria-modal="true" aria-labelledby="save-lyrics-hint-title">` +
            `<div class="lyric-template-save-modal-head">` +
            `<h3 id="save-lyrics-hint-title">歌词已保存</h3>` +
            `<button type="button" class="lyric-template-save-modal-close" data-save-hint-close aria-label="关闭">✕</button>` +
            `</div>` +
            `<div class="lyric-template-save-modal-body">` +
            `<p class="lyric-template-save-modal-desc">您编辑的内容已写入本机<strong>诗歌库</strong>，系统已将该诗歌存为可随时套用的<strong>歌词模板</strong>（与当前歌名对应）。</p>` +
            `<p class="lyric-template-save-modal-desc">之后请在左侧诗歌库上方的「<b>搜索我的诗歌</b>」中输入歌名或歌词片段即可找到；下次再使用<strong>同一首诗歌</strong>时，就<strong>不必重复编辑</strong>。</p>` +
            `<div class="lyric-template-save-actions">` +
            `<button type="button" class="lyric-template-save-btn lyric-template-save-btn--secondary" id="save-lyrics-hint-search">前往搜索</button>` +
            `<button type="button" class="lyric-template-save-btn lyric-template-save-btn--primary" id="save-lyrics-hint-ok">我知道了</button>` +
            `</div></div></div>`;
        document.body.appendChild(el);
        const panel = el.querySelector(".lyric-template-save-modal-panel");
        const shut = () => closeSaveLyricsLibraryHintModal();
        el.addEventListener("click", (e) => {
            if (e.target === el) shut();
        });
        panel?.addEventListener("click", (e) => e.stopPropagation());
        el.querySelector("[data-save-hint-close]")?.addEventListener("click", shut);
        el.querySelector("#save-lyrics-hint-ok")?.addEventListener("click", shut);
        el.querySelector("#save-lyrics-hint-search")?.addEventListener("click", () => {
            shut();
            const si = $("search-input");
            const lib = $("song-library");
            if (lib) {
                try {
                    lib.scrollIntoView({ behavior: "smooth", block: "nearest" });
                } catch (_e) {
                    /* ignore */
                }
            }
            queueMicrotask(() => {
                try {
                    si?.focus();
                    si?.select();
                } catch (_e2) {
                    /* ignore */
                }
            });
        });
        if (!document.body.dataset.saveLyricsHintEscBound) {
            document.body.dataset.saveLyricsHintEscBound = "1";
            document.addEventListener("keydown", (e) => {
                if (e.key !== "Escape") return;
                const m = $("save-lyrics-library-hint-modal");
                if (!m || !m.classList.contains("is-open")) return;
                e.preventDefault();
                shut();
            });
        }
        return el;
    }

    function openSaveLyricsLibraryHintModal(songTitle) {
        const el = ensureSaveLyricsLibraryHintModal();
        const h3 = el.querySelector("#save-lyrics-hint-title");
        const t = String(songTitle || "").trim();
        if (h3) h3.textContent = t ? `「${t}」已保存` : "歌词已保存";
        el.classList.add("is-open");
    }

    function renderLyricTemplateModalList() {
        const ul = $("lyric-template-list");
        if (!ul) return;
        const tpls = getLyricTemplates();
        ul.innerHTML = "";
        if (!tpls.length) {
            ul.innerHTML =
                '<li class="lyric-template-empty">暂无诗歌存档，请先在编辑区旁点「存为存档」保存当前歌词与样式</li>';
            return;
        }
        tpls.forEach((tpl) => {
            const li = document.createElement("li");
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "lyric-template-item";
            const title = escapeHtml(tpl.name || "未命名存档");
            const dt = new Date(Number(tpl.createdAt) || 0);
            const ds = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
            btn.innerHTML = `<span>${title}</span><span class="lyric-template-item-meta">${ds}</span>`;
            btn.addEventListener("click", () => createSongFromLyricTemplate(tpl));
            li.appendChild(btn);
            ul.appendChild(li);
        });
    }

    function openLyricTemplatePickerModal() {
        let modal = $("lyric-template-modal");
        if (!modal) {
            modal = document.createElement("div");
            modal.id = "lyric-template-modal";
            modal.className = "lyric-template-modal";
            modal.innerHTML =
                "<div class=\"lyric-template-modal-panel\" role=\"presentation\">" +
                "<div class=\"lyric-template-modal-head\">" +
                "<h3>诗歌存档</h3>" +
                "<button type=\"button\" class=\"lyric-template-modal-close\" aria-label=\"关闭\">✕</button>" +
                "</div>" +
                "<p class=\"lyric-template-modal-desc\">以下为已保存在本机的诗歌存档（歌词与高级样式）。点选一项将<b>新建一首诗歌</b>并套用内容。</p>" +
                "<div class=\"lyric-template-modal-body\"><ul id=\"lyric-template-list\" class=\"lyric-template-list\"></ul></div>" +
                "</div>";
            modal.addEventListener("click", (e) => {
                if (e.target === modal) closeLyricTemplatePickerModal();
            });
            modal.querySelector(".lyric-template-modal-panel")?.addEventListener("click", (e) => e.stopPropagation());
            modal.querySelector(".lyric-template-modal-close")?.addEventListener("click", () => closeLyricTemplatePickerModal());
            document.body.appendChild(modal);
        }
        renderLyricTemplateModalList();
        modal.classList.add("is-open");
    }

    function saveCurrentAsLyricTemplate() {
        if (isDisplay || isLeader) return;
        syncEditorToSong();
        const song = currentSong();
        if (!song) return;
        const fromEd = String($("lyric-editor-large")?.value ?? "");
        const fromSong = String(song.lyrics ?? "");
        const lyricsToSave = fromEd.length >= fromSong.length ? fromEd : fromSong;
        const defaultName = `${(song.title || "未命名").trim() || "未命名"} 存档`;
        openLyricTemplateSaveNameModal(defaultName).then((nameRes) => {
            if (nameRes == null) return;
            const nm = String(nameRes).trim() || defaultName;
            let uiSnap;
            try {
                uiSnap = JSON.parse(JSON.stringify(state.ui));
            } catch (_e) {
                uiSnap = { ...state.ui };
            }
            const tpl = {
                id: "tpl_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
                name: nm,
                createdAt: Date.now(),
                lyrics: lyricsToSave,
                ui: uiSnap,
                songVisual: {
                    overlayOpacityPct: song.overlayOpacityPct,
                    fontOpacityPct: song.fontOpacityPct,
                    posY: song.posY
                },
                meta: {
                    key: song.key || "",
                    tempo: song.tempo || "",
                    notes: song.notes || "",
                    tags: song.tags || ""
                }
            };
            const list = getLyricTemplates();
            list.unshift(tpl);
            if (list.length > 40) list.length = 40;
            if (!saveLyricTemplates(list)) return;
            showCornerSuccessToast("✅ 已保存为诗歌存档", $("save-as-template-btn"));
        });
    }

    function createSongFromLyricTemplate(tpl) {
        if (!tpl || !tpl.id) return;
        syncEditorToSong();
        const baseTitle = String(tpl.name || "来自存档")
            .replace(/模板$/, "")
            .replace(/存档$/, "")
            .trim();
        const song = {
            id: uid(),
            title: baseTitle || "未命名",
            lyrics: String(tpl.lyrics || ""),
            key: tpl.meta && typeof tpl.meta === "object" ? String(tpl.meta.key || "") : "",
            tempo: tpl.meta && typeof tpl.meta === "object" ? String(tpl.meta.tempo || "") : "",
            notes: tpl.meta && typeof tpl.meta === "object" ? String(tpl.meta.notes || "") : "",
            tags: tpl.meta && typeof tpl.meta === "object" ? String(tpl.meta.tags || "") : "",
            overlayOpacityPct: 30,
            fontOpacityPct: 100
        };
        if (tpl.songVisual && typeof tpl.songVisual === "object") {
            if (Number.isFinite(Number(tpl.songVisual.overlayOpacityPct))) {
                song.overlayOpacityPct = clamp(Number(tpl.songVisual.overlayOpacityPct), 0, 80);
            }
            if (Number.isFinite(Number(tpl.songVisual.fontOpacityPct))) {
                song.fontOpacityPct = clamp(Number(tpl.songVisual.fontOpacityPct), 20, 100);
            }
            if (Number.isFinite(Number(tpl.songVisual.posY))) {
                song.posY = clamp(Number(tpl.songVisual.posY), 20, 70);
            }
        }
        const idx = Math.max(0, state.songs.findIndex((s) => s.id === state.currentSongId));
        if (!isDisplay && !isLeader) {
            persistSongBackgroundFromUi(state.currentSongId);
        }
        state.songs.splice(idx + 1, 0, song);
        saveSongs();
        if (tpl.ui && typeof tpl.ui === "object") {
            state.ui = { ...state.ui, ...tpl.ui };
            if (!state.ui.bgImageId) state.ui.bgImageId = "";
            if (state.ui.bgMediaType !== "video" && state.ui.bgMediaType !== "image") {
                state.ui.bgMediaType = "image";
            }
        }
        normalizeLegacyBgImageReference();
        state.ui.overlayOpacityPct = clamp(Number(song.overlayOpacityPct), 0, 80);
        state.ui.fontOpacityPct = clamp(Number(song.fontOpacityPct), 20, 100);
        if (Number.isFinite(Number(song.posY))) {
            state.ui.posY = clamp(Number(song.posY), 20, 70);
        }
        state.currentSongId = song.id;
        if (!isDisplay && !isLeader) {
            persistSongBackgroundFromUi(song.id);
            saveSongs();
        }
        state.currentPage = 0;
        syncPosYFromCurrentSong();
        syncOverlayFontOpacityFromCurrentSong();
        updateUIFromState();
        syncSongToEditor();
        renderSongList();
        updateSpeakerCards();
        renderMiniPreview();
        renderPlaylist();
        broadcastState();
        closeLyricTemplatePickerModal();
        showCornerSuccessToast("✅ 已从诗歌存档新建诗歌", $("new-from-template-btn"));
        queueMicrotask(() => {
            const inp = $("lyric-editor-large");
            if (inp) inp.focus();
        });
    }

    function getHelpModalInnerHtml() {
        const tpl = $("help-modal-content-template");
        return tpl ? tpl.innerHTML.trim() : "";
    }

    function openHelpModal() {
        let modal = $("help-modal");
        const html = getHelpModalInnerHtml();
        if (!modal) {
            modal = document.createElement("div");
            modal.id = "help-modal";
            modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:2500;display:flex;align-items:center;justify-content:center;";
            const panel = document.createElement("div");
            panel.style.cssText = "width:min(700px,92vw);max-height:80vh;overflow-y:auto;background:var(--bg-secondary);border-radius:20px;padding:30px;position:relative;color:var(--text-primary);";
            const closeBtn = document.createElement("button");
            closeBtn.type = "button";
            closeBtn.id = "help-modal-close";
            closeBtn.textContent = "✕";
            closeBtn.style.cssText = "position:absolute;right:14px;top:10px;border:none;background:transparent;color:var(--text-secondary);font-size:18px;cursor:pointer;";
            closeBtn.addEventListener("click", () => {
                modal.style.display = "none";
            });
            panel.appendChild(closeBtn);
            const content = document.createElement("div");
            content.className = "help-modal-body";
            content.innerHTML = html;
            panel.appendChild(content);
            modal.appendChild(panel);
            modal.addEventListener("click", (e) => {
                if (e.target === modal) modal.style.display = "none";
            });
            document.body.appendChild(modal);
        } else if (html) {
            const bodyEl = modal.querySelector(".help-modal-body");
            if (bodyEl) bodyEl.innerHTML = html;
        }
        modal.style.display = "flex";
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    function escapeAttr(text) {
        return escapeHtml(text).replace(/"/g, "&quot;");
    }

    /** 主领视角：首次自动分步引导完成后写入，不再自动弹出 */
    const LEADER_ONBOARDING_LS = "worship_leader_onboarding_v1";

    const LEADER_GUIDE_STEPS = [
        {
            title: "第 1 步：歌词与页面从哪来",
            text:
                "主领页用于<b>编辑与排版歌词</b>，不是会众投屏。<b>电脑</b>：主控台「传数据」把播放列表歌词与主领设置传到手机/平板；主领窗右下角金色「⇄ 传数据」可再次传出。<b>手机/平板</b>：扫码进入后编辑会自动保存在本机；点右下角「💾 保存」生成二维码，便于换时段或换设备后恢复。⚙ 内可改词、备注、编排。"
        },
        {
            title: "第 2 步：界面布局",
            text:
                "默认「滚动」模式：整份歌单可上下滑动。电脑右下角金色「⇄ 传数据」用于传到移动设备；手机/平板右下角「💾 保存」用于留存自己的编辑（本机自动保存 + 可截图二维码）。点 ⚙ 打开设置菜单。底部工具栏可展开，约 3 秒无操作自动收起。"
        },
        {
            title: "第 3 步：翻页与滚动",
            text:
                "「单页」：点左右 ◀ ▶ 或 ← → 翻页（画笔开启时除外）。「滚动」：上下滑动读多首；点底栏歌名跳转。「流程」：按编排卡片前进。经二维码传入的偏好若未改过，首次进入多为滚动模式。"
        },
        {
            title: "第 4 步：字号、字色与背景",
            text:
                "在 ⚙ 菜单中调节字号（±）与字色；或展开底部工具栏点 Aa / 字色圆点。背景在 ⚙ 或 🎨 中选择。显示设置保存在本机；手机/平板请定期点「💾 保存」截图二维码，以防清缓存后丢失。"
        },
        {
            title: "第 5 步：编排、备注、改词与画笔",
            text:
                "📐 编排：生成 / 模板 / 拖拽流程，点「使用」进入流程模式。✎ 改词：仅本机，不自动改会众投屏。✏️ 备注：点备注进入编辑模式，顶栏提示「点歌词行或 ⊕」；保存后行末有金点，点金点可查看（手机请直接点圆点）。✍️ 画笔：标注后点「完成」或双击空白退出；可撤销、清页。"
        },
        {
            title: "第 6 步：与会众投屏",
            text:
                "主领页侧重个人编辑（改词、备注、编排），会众观看请用主控台「开启投屏」。若主控台也在改同一首歌，改完后点「应用到演示屏」会众屏才更新。流程模式中的经文卡等仍须主控台与会众窗保持同步。"
        }
    ];

    let leaderGuideOverlayEl = null;
    let leaderGuideEscBound = false;
    let leaderGuideIndex = 0;
    let leaderGuideOpts = null;

    function leaderGuideNotifyToolbar() {
        try {
            if (typeof globalThis.__worshipLeaderShowToolbar === "function") globalThis.__worshipLeaderShowToolbar();
        } catch (_e) {
            /* ignore */
        }
    }

    function onLeaderGuideKeydown(e) {
        if (e.key === "Escape") teardownLeaderGuideModal(false);
    }

    function teardownLeaderGuideModal(markOnboardingDone) {
        if (leaderGuideEscBound) {
            document.removeEventListener("keydown", onLeaderGuideKeydown, true);
            leaderGuideEscBound = false;
        }
        if (leaderGuideOverlayEl) {
            leaderGuideOverlayEl.remove();
            leaderGuideOverlayEl = null;
        }
        if (markOnboardingDone) {
            try {
                localStorage.setItem(LEADER_ONBOARDING_LS, "1");
            } catch (_e) {
                /* ignore */
            }
        }
        leaderGuideOpts = null;
        leaderGuideNotifyToolbar();
    }

    function layoutLeaderGuideStep() {
        if (!leaderGuideOverlayEl) return;
        const step = LEADER_GUIDE_STEPS[leaderGuideIndex];
        const panel = leaderGuideOverlayEl.querySelector(".leader-guide-panel");
        if (!panel || !step) return;
        const meta = panel.querySelector(".leader-guide-meta");
        const title = panel.querySelector(".leader-guide-title");
        const body = panel.querySelector(".leader-guide-body");
        const nextBtn = panel.querySelector(".leader-guide-next");
        if (meta) meta.textContent = `第 ${leaderGuideIndex + 1} / ${LEADER_GUIDE_STEPS.length} 步`;
        if (title) title.textContent = step.title;
        if (body) body.textContent = step.text;
        if (nextBtn) {
            nextBtn.textContent =
                leaderGuideIndex >= LEADER_GUIDE_STEPS.length - 1 ? "完成" : "下一步";
        }
    }

    function openLeaderGuideModal(startIndex, opts) {
        teardownLeaderGuideModal(false);
        leaderGuideOpts = opts && typeof opts === "object" ? opts : null;
        leaderGuideIndex = clamp(Number(startIndex) || 0, 0, Math.max(0, LEADER_GUIDE_STEPS.length - 1));
        leaderGuideOverlayEl = document.createElement("div");
        leaderGuideOverlayEl.id = "leader-step-guide-overlay";
        leaderGuideOverlayEl.className = "leader-step-guide-overlay";
        leaderGuideOverlayEl.setAttribute("role", "dialog");
        leaderGuideOverlayEl.setAttribute("aria-modal", "true");
        leaderGuideOverlayEl.innerHTML =
            '<div class="leader-guide-panel">' +
            '<p class="leader-guide-meta"></p>' +
            '<h3 class="leader-guide-title"></h3>' +
            '<p class="leader-guide-body"></p>' +
            '<div class="leader-guide-actions">' +
            '<button type="button" class="leader-guide-skip btn btn-outline">跳过</button>' +
            '<button type="button" class="leader-guide-next btn">下一步</button>' +
            "</div>" +
            '<p class="leader-guide-hint">按 Esc 关闭 · 与主控台「使用引导」类似的分步说明</p>' +
            "</div>";
        leaderGuideOverlayEl.addEventListener("click", (e) => {
            if (e.target === leaderGuideOverlayEl) teardownLeaderGuideModal(!!(leaderGuideOpts && leaderGuideOpts.firstVisit));
        });
        const skipBtn = leaderGuideOverlayEl.querySelector(".leader-guide-skip");
        const nextBtn = leaderGuideOverlayEl.querySelector(".leader-guide-next");
        skipBtn?.addEventListener("click", () => {
            const mark = !!(leaderGuideOpts && leaderGuideOpts.firstVisit);
            teardownLeaderGuideModal(mark);
        });
        nextBtn?.addEventListener("click", () => {
            if (leaderGuideIndex >= LEADER_GUIDE_STEPS.length - 1) {
                teardownLeaderGuideModal(true);
                return;
            }
            leaderGuideIndex += 1;
            layoutLeaderGuideStep();
            leaderGuideNotifyToolbar();
        });
        document.addEventListener("keydown", onLeaderGuideKeydown, true);
        leaderGuideEscBound = true;
        document.body.appendChild(leaderGuideOverlayEl);
        layoutLeaderGuideStep();
        leaderGuideNotifyToolbar();
    }

    function getLeaderHelpModalInnerHtml() {
        return [
            "<h2>📖 主领视角 · 使用帮助</h2>",
            "<p style=\"opacity:.88;font-size:0.9rem;line-height:1.55;margin:0 0 14px;\">本页用于<b>编辑歌词与备注</b>，不是会众投屏。<b>电脑</b>：右下角 <b>⇄ 传数据</b> 把播放列表歌词与主领设置传到手机/平板。<b>手机/平板</b>：编辑会自动保存在本机；右下角 <b>💾 保存</b> 可生成二维码，便于日后再次打开。</p>",
            "<h3>一、数据如何同步</h3>",
            "<ul>",
            "<li>主控台改词、分页或样式后须点<b>「应用到演示屏」</b>，主领页与会众投屏才会更新。</li>",
            "<li>本页通过频道与 <code>localStorage</code> LIVE 数据监听变更；请保持主控台与本页同时打开。</li>",
            "<li><b>⇄ 传数据</b>（电脑）：传输播放列表歌词与主领设置到手机/平板。歌单很大时会拆成多个码，须依次扫描。</li>",
            "<li><b>💾 保存</b>（手机/平板）：打包歌词、改词、备注、编排与显示设置；本机自动保存，二维码供清缓存或换设备后恢复。</li>",
            "<li>主领「改词」仅更新本机曲库与当前主领画面，<b>不会</b>自动改会众投屏或主控台 LIVE。</li>",
            "</ul>",
            "<h3>二、界面与显示模式</h3>",
            "<ul>",
            "<li><b>默认滚动</b>：整份歌单可上下滑动；顶栏显示当前歌名；底栏有歌名芯片可点切歌。</li>",
            "<li><b>右下角</b>：金色 <b>⇄ 传数据</b>（⚙ 左侧）生成二维码；<b>⚙</b> 内有帮助、引导、编排、背景、画笔、备注、字色、字号、改词、歌单及<b>单页 / 滚动</b>。「流程」在编排完成后点「使用」进入。</li>",
            "<li><b>底部工具栏</b>：点 <b>∨</b> 或从下缘上滑展开；约 3 秒无操作自动收起。窄屏时以 ⚙ 为主。</li>",
            "<li><b>诗歌 / 歌单</b>：⚙ 或工具栏可粘贴传数据后的完整链接（含 <code>#wp1=</code> 或 <code>?data=</code>）或诗歌包文本载入。</li>",
            "</ul>",
            "<h3>三、翻页与快捷键</h3>",
            "<ul>",
            "<li><b>单页</b>：左右 ◀ ▶ 或键盘 <b>← →</b>（画笔开启时除外）。<b>滚动</b>：不翻页，上下阅读；点底栏歌名跳转。</li>",
            "<li>流程模式按编排卡片顺序前进，并与会众页索引联动。</li>",
            "</ul>",
            "<h3>四、字号、背景、改词、备注、画笔</h3>",
            "<ul>",
            "<li><b>字号 / 字色</b>：在 ⚙ 菜单或展开工具栏的 Aa、字色圆点调节（vw，仅本机）。</li>",
            "<li><b>背景</b>：纯黑 / 白 / 灰 / 藏青、粒子或本地上传图片。</li>",
            "<li><b>✎ 改词</b>：编辑当前诗歌全文；保存后仅本机，会众屏须主控台「应用到演示屏」。</li>",
            "<li><b>✏️ 备注</b>：点备注进入编辑，顶栏提示「点歌词行或 ⊕」；保存后行末金点可查看（手机请直接点金点）。</li>",
            "<li><b>✍️ 画笔</b>：标注后点「完成」、面板内 ✅ 或双击空白退出；可撤销、清页。</li>",
            "</ul>",
            "<h3>五、与会众画面的关系</h3>",
            "<ul>",
            "<li>主领页<b>不会</b>替代会众投屏；会众画面以主控台「开启投屏」为准。</li>",
            "<li>主控台投屏中可用「结束投屏」或 <b>Ctrl+Shift+E</b> 关闭会众窗，无需切到投影仪。</li>",
            "<li>流程中的经文覆盖层等会通过频道同步，请以现场画面为准。</li>",
            "</ul>"
        ].join("");
    }

    function closeLeaderHelpModal() {
        const m = $("leader-help-modal");
        if (m) m.style.display = "none";
    }

    function openLeaderHelpModal() {
        let modal = $("leader-help-modal");
        const html = getLeaderHelpModalInnerHtml();
        if (!modal) {
            modal = document.createElement("div");
            modal.id = "leader-help-modal";
            modal.className = "leader-help-modal-root";
            modal.style.cssText =
                "position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:2600;display:none;align-items:center;justify-content:center;";
            const panel = document.createElement("div");
            panel.className = "leader-help-modal-panel";
            panel.style.cssText =
                "width:min(700px,92vw);max-height:82vh;overflow-y:auto;background:var(--bg-secondary);border-radius:20px;padding:28px 26px 24px;position:relative;color:var(--text-primary);border:1px solid var(--border-color);box-shadow:0 20px 50px rgba(0,0,0,0.45);";
            const closeBtn = document.createElement("button");
            closeBtn.type = "button";
            closeBtn.className = "leader-help-modal-close";
            closeBtn.id = "leader-help-modal-close";
            closeBtn.textContent = "✕";
            closeBtn.setAttribute("aria-label", "关闭");
            closeBtn.style.cssText =
                "position:absolute;right:12px;top:10px;border:none;background:transparent;color:var(--text-secondary);font-size:18px;cursor:pointer;line-height:1;";
            closeBtn.addEventListener("click", () => {
                modal.style.display = "none";
            });
            panel.appendChild(closeBtn);
            const content = document.createElement("div");
            content.className = "leader-help-modal-body help-modal-body";
            content.innerHTML = html;
            panel.appendChild(content);
            modal.appendChild(panel);
            modal.addEventListener("click", (e) => {
                if (e.target === modal) modal.style.display = "none";
            });
            document.body.appendChild(modal);
        } else {
            const bodyEl = modal.querySelector(".leader-help-modal-body");
            if (bodyEl && html) bodyEl.innerHTML = html;
        }
        modal.style.display = "flex";
    }

    const WORSHIP_CHANGELOG_ENTRIES = [
        {
            version: "v2.1.0",
            label: "当前",
            lines: ["新增云端搜索、备份恢复、自动草稿、高级编辑优化"]
        },
        {
            version: "v2.0.0",
            label: "",
            lines: ["模块化架构重构、投屏引导优化、在线搜索接入"]
        },
        {
            version: "v1.5.0",
            label: "",
            lines: ["主领视图、播放列表、背景管理、导入导出"]
        }
    ];

    function closeWorshipChangelogModal() {
        const m = $("worship-changelog-modal");
        if (m) m.remove();
    }

    function copyWorshipErrorLogsRecent() {
        let arr = [];
        try {
            arr = JSON.parse(localStorage.getItem(WORSHIP_ERROR_LOG_LS) || "[]");
        } catch (_e) {
            arr = [];
        }
        if (!Array.isArray(arr)) arr = [];
        const slice = arr.slice(-WORSHIP_ERROR_LOG_COPY_LAST);
        const text = JSON.stringify(slice, null, 2);
        const done = () => showToast("已复制最近错误日志", $("worship-error-log-copy-btn"));
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(() => {
                try {
                    const ta = document.createElement("textarea");
                    ta.value = text;
                    ta.style.position = "fixed";
                    ta.style.left = "-9999px";
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand("copy");
                    ta.remove();
                    done();
                } catch (_e2) {
                    showToast("复制失败", $("worship-error-log-copy-btn"));
                }
            });
        } else {
            showToast("浏览器不支持剪贴板", $("worship-error-log-copy-btn"));
        }
    }

    function openWorshipChangelogModal() {
        closeWorshipChangelogModal();
        const wrap = document.createElement("div");
        wrap.id = "worship-changelog-modal";
        wrap.setAttribute("role", "dialog");
        wrap.setAttribute("aria-modal", "true");
        wrap.style.cssText = [
            "position:fixed",
            "inset:0",
            "z-index:100060",
            "display:flex",
            "align-items:center",
            "justify-content:center",
            "padding:20px",
            "box-sizing:border-box",
            "background:rgba(6,8,16,0.55)",
            "backdrop-filter:blur(12px)",
            "-webkit-backdrop-filter:blur(12px)"
        ].join(";");
        const card = document.createElement("div");
        card.style.cssText = [
            "width:min(440px,92vw)",
            "max-height:min(78vh,640px)",
            "overflow:hidden",
            "display:flex",
            "flex-direction:column",
            "border-radius:16px",
            "border:1px solid rgba(212,175,119,0.35)",
            "background:rgba(22,26,38,0.82)",
            "box-shadow:0 16px 48px rgba(0,0,0,0.45)",
            "color:#ececec"
        ].join(";");
        const title = document.createElement("div");
        title.textContent = "📋 更新日志";
        title.style.cssText =
            "padding:14px 18px;font-size:1.05rem;font-weight:700;border-bottom:1px solid rgba(255,255,255,0.1);";
        const body = document.createElement("div");
        body.style.cssText =
            "padding:14px 18px;overflow-y:auto;flex:1;font-size:0.9rem;line-height:1.55;";
        const ul = document.createElement("ul");
        ul.style.cssText = "margin:0;padding:0 0 0 1.1em;list-style:disc;";
        WORSHIP_CHANGELOG_ENTRIES.forEach((entry) => {
            const li = document.createElement("li");
            li.style.marginBottom = "12px";
            const head = document.createElement("div");
            head.style.fontWeight = "700";
            head.style.color = "#f5e6c8";
            head.textContent = entry.label ? `${entry.version}（${entry.label}）` : entry.version;
            li.appendChild(head);
            entry.lines.forEach((line) => {
                const p = document.createElement("div");
                p.style.marginTop = "4px";
                p.style.opacity = "0.95";
                p.textContent = `· ${line}`;
                li.appendChild(p);
            });
            ul.appendChild(li);
        });
        body.appendChild(ul);
        const foot = document.createElement("div");
        foot.style.cssText =
            "padding:12px 18px 16px;border-top:1px solid rgba(255,255,255,0.1);display:flex;flex-direction:column;gap:10px;";
        const hintRow = document.createElement("div");
        hintRow.style.cssText =
            "display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:0.78rem;color:rgba(236,240,248,0.82);";
        const hint = document.createElement("span");
        hint.textContent = "🛠️ 如遇问题，可将错误日志发送给开发者";
        hint.style.flex = "1";
        hint.style.minWidth = "160px";
        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.id = "worship-error-log-copy-btn";
        copyBtn.textContent = "📋 复制日志";
        copyBtn.style.cssText =
            "padding:6px 12px;border-radius:8px;border:1px solid rgba(212,175,119,0.45);background:rgba(255,255,255,0.08);color:#f5e6c8;cursor:pointer;font:inherit;font-size:0.78rem;";
        copyBtn.addEventListener("click", () => copyWorshipErrorLogsRecent());
        hintRow.appendChild(hint);
        hintRow.appendChild(copyBtn);
        const btnRow = document.createElement("div");
        btnRow.style.textAlign = "right";
        const ok = document.createElement("button");
        ok.type = "button";
        ok.textContent = "知道了";
        ok.style.cssText =
            "padding:8px 22px;border-radius:10px;border:1px solid rgba(255,255,255,0.45);background:transparent;color:#f0f4fc;cursor:pointer;font:inherit;";
        ok.addEventListener("click", () => closeWorshipChangelogModal());
        btnRow.appendChild(ok);
        foot.appendChild(hintRow);
        foot.appendChild(btnRow);
        card.appendChild(title);
        card.appendChild(body);
        card.appendChild(foot);
        wrap.appendChild(card);
        wrap.addEventListener("click", (e) => {
            if (e.target === wrap) closeWorshipChangelogModal();
        });
        card.addEventListener("click", (e) => e.stopPropagation());
        document.body.appendChild(wrap);
    }

    function ensureWorshipVersionFooter() {
        if (isDisplay || isLeader) return;
        if ($("worship-app-version-trigger")) return;
        const slot = $("worship-footer-version-slot");
        if (slot) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.id = "worship-app-version-trigger";
            btn.textContent = WORSHIP_APP_VERSION;
            btn.setAttribute("aria-label", "查看更新日志");
            btn.className = "worship-footer-version-btn";
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                openWorshipChangelogModal();
            });
            slot.appendChild(btn);
            return;
        }
        const panel = $("preview-panel");
        if (!panel) return;
        const hints = panel.querySelectorAll("p.hint-text");
        let anchor = null;
        hints.forEach((p) => {
            if (p.textContent && p.textContent.includes("MIT")) anchor = p;
        });
        if (!anchor) anchor = hints[hints.length - 1] || null;
        if (!anchor || !anchor.parentNode) return;
        const line = document.createElement("p");
        line.className = "hint-text worship-app-version-footer";
        line.style.cssText = "margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;";
        const lab = document.createElement("span");
        lab.textContent = "版本";
        lab.style.opacity = "0.85";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.id = "worship-app-version-trigger";
        btn.textContent = WORSHIP_APP_VERSION;
        btn.setAttribute("aria-label", "查看更新日志");
        btn.style.cssText =
            "padding:0;border:none;background:transparent;color:var(--accent);text-decoration:underline;cursor:pointer;font:inherit;font-size:inherit;";
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            openWorshipChangelogModal();
        });
        line.appendChild(lab);
        line.appendChild(btn);
        anchor.parentNode.insertBefore(line, anchor.nextSibling);
    }

    function escapeRegExp(str) {
        return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function highlightSearchHtml(text, keyLower) {
        const esc = escapeHtml(text ?? "");
        if (!keyLower) return esc;
        try {
            return esc.replace(new RegExp(`(${escapeRegExp(keyLower)})`, "gi"), "<mark>$1</mark>");
        } catch {
            return esc;
        }
    }

    /** 列表/分类：搜索匹配标题、歌词与标签 */
    function songTitleMatchesSearch(song, keyLower) {
        if (!keyLower) return true;
        const title = String(song.title || "").toLowerCase();
        const lyrics = String(song.lyrics || "").toLowerCase();
        const tags = String(song.tags || "").toLowerCase();
        return title.includes(keyLower) || lyrics.includes(keyLower) || tags.includes(keyLower);
    }

    function getLibraryFilteredSongRows() {
        const keyLower = ($("search-input")?.value || "").trim().toLowerCase();
        return state.songs
            .filter((s) => songTitleMatchesSearch(s, keyLower))
            .map((song) => ({ song, score: 0 }));
    }

    function parsePages(lyrics, linesPerPage) {
        /* ==========================================================
           [迁移标记 round1] 已迁移至 js/utils.js；以下为旧实现，保留作安全网。
           当 globalThis.parsePages 不可用时可恢复块内逻辑。
           ==========================================================
        const size = clamp(Number(linesPerPage) || 4, 1, 20);
        const input = String(lyrics || "").replace(/\r/g, "");
        if (!input.trim()) return [["..."]];

        const blocks = input.split(/\n\s*\n|(?:^|\n)\[page\]\s*(?:\n|$)/i);
        const pages = [];
        for (const block of blocks) {
            const lines = block.split("\n").map((x) => x.trim()).filter(Boolean);
            for (let i = 0; i < lines.length; i += size) {
                pages.push(lines.slice(i, i + size));
            }
        }
        return pages.length ? pages : [["..."]];
        */
        return globalThis.parsePages(lyrics, linesPerPage);
    }
    const splitPages = parsePages;

    /**
     * 粘贴较长歌词后：按每页最大行数略调字号，并把垂直位置设在「略偏上」（非画面正中央），
     * 与迷你预览 padding、投屏 topPct、页面画廊同源。
     */
    function applyAutoLyricPresentationAfterPaste(lyricsPlain) {
        const raw = String(lyricsPlain ?? "").trim();
        const linesGuess = raw ? raw.split(/\n/).length : 0;
        if (raw.length < 36 && linesGuess < 4) return;
        const song = currentSong();
        if (!song) return;
        const dl = clamp(Number(state.ui.defaultLines) || 4, 1, 20);
        let pages;
        try {
            pages = splitPages(raw, dl);
        } catch (_e) {
            return;
        }
        if (!Array.isArray(pages) || !pages.length) return;
        let maxN = 1;
        for (let i = 0; i < pages.length; i++) {
            const pg = pages[i] || [];
            const n = pg.filter((ln) => String(ln ?? "").trim().length > 0).length || 1;
            maxN = Math.max(maxN, n);
        }
        const refLines = 4;
        const denom = Math.min(Math.max(maxN, 1), 10);
        const fsGuess = Math.round(56 * Math.sqrt(refLines / denom));
        const nextFont = clampLyricFontSize(fsGuess);
        /* posY 越大 → mini 预览 padding 越大（歌词越靠下）；略偏上则用 30–38 一带，并随满页行数略抬高 */
        let posY = 35;
        if (maxN >= dl) posY -= 6;
        else if (maxN >= dl - 1) posY -= 3;
        else if (maxN <= 2) posY += 3;
        posY = clamp(posY, 24, 42);
        state.ui.fontSize = nextFont;
        state.ui.posY = posY;
        song.posY = posY;
        clearMiniPreviewLyricStageDragTransform();
        updateUIFromState();
        try {
            saveSettings();
            saveSongs();
        } catch (_e) {
            /* ignore */
        }
        updateAll();
    }

    function currentSong() {
        return state.songs.find((s) => s.id === state.currentSongId) || state.songs[0] || null;
    }

    function getCurrentSong() {
        syncEditorToSong();
        return currentSong() || { title: "", lyrics: "", tags: "" };
    }

    function getThemeBgOpacity() {
        const raw = localStorage.getItem(THEME_BG_OPACITY_STORAGE);
        const n = parseFloat(raw);
        if (!Number.isFinite(n)) return 0.65;
        return clamp(n, 0.05, 1);
    }

    function applyThemeBgOpacityVar() {
        document.documentElement.style.setProperty("--theme-bg-opacity", String(getThemeBgOpacity()));
    }

    function applyAdvPreviewCssVarsFromStorage() {
        try {
            const r = localStorage.getItem(ADV_MINI_OVERLAY_PCT_LS);
            if (r != null && r !== "") {
                const pct = clamp(parseInt(r, 10), 0, 55);
                if (Number.isFinite(pct)) {
                    document.documentElement.style.setProperty("--adv-mini-readability", (pct / 100).toFixed(3));
                }
            }
            const b = localStorage.getItem(ADV_MINI_BLUR_PX_LS);
            if (b != null && b !== "") {
                const px = clamp(parseInt(b, 10), 0, 20);
                if (Number.isFinite(px)) {
                    document.documentElement.style.setProperty("--adv-mini-blur-px", String(px));
                }
            }
            const lh = localStorage.getItem(ADV_PREVIEW_LINE_HEIGHT_LS);
            if (lh != null && lh.trim() !== "") {
                const v = clamp(parseFloat(lh), 1.2, 2.4);
                if (Number.isFinite(v)) {
                    document.documentElement.style.setProperty("--adv-preview-line-height", String(v));
                }
            }
        } catch (_) {
            /* ignore */
        }
    }

    function persistAdvPreviewCssVars() {
        try {
            const ov = $("adv-lyric-overlay-opacity");
            if (ov) localStorage.setItem(ADV_MINI_OVERLAY_PCT_LS, String(clamp(parseInt(ov.value, 10), 0, 55)));
            const bl = $("adv-lyric-layer-blur");
            if (bl) localStorage.setItem(ADV_MINI_BLUR_PX_LS, String(clamp(parseInt(bl.value, 10), 0, 20)));
            const lh = $("adv-preview-line-height");
            if (lh) {
                const v = clamp(parseFloat(lh.value), 1.2, 2.4);
                if (Number.isFinite(v)) localStorage.setItem(ADV_PREVIEW_LINE_HEIGHT_LS, String(v));
            }
        } catch (_) {
            /* ignore */
        }
    }

    function applyAdvEditSettingsDefaultsToState() {
        state.ui.theme = "dark";
        state.ui.fontFamily = "'Microsoft YaHei','PingFang SC',sans-serif";
        state.ui.fontSize = 60;
        state.ui.fontWeight = "700";
        state.ui.defaultLines = 4;
        state.ui.posY = 40;
        state.ui.fontColor = "#ffffff";
        state.ui.textStrokePx = 0;
        state.ui.vignetteShape = "circle";
        state.ui.vignetteCenterBrightness = 0;
        state.ui.vignetteEdgeDarkness = 0;
        state.ui.pageTransition = "none";
        state.ui.pageTransitionSpeed = 0.6;
        state.ui.overlayOpacityPct = 30;
        state.ui.fontOpacityPct = 100;
        state.ui.fontMegaMode = false;
        state.ui.defaultUploadedBgId = "";
        state.ui.editorAutoFontSize = false;
        state.ui.editorAutoFontMinPx = 11;
        state.ui.editorAutoFontMaxPx = 20;
        defaultSongPosY = 40;
        const song = currentSong();
        if (song) {
            song.posY = 40;
            song.overlayOpacityPct = 30;
            song.fontOpacityPct = 100;
        }
        state.currentPage = 0;
        document.body.setAttribute("data-theme", "dark");
        try {
            localStorage.setItem(THEME_BG_OPACITY_STORAGE, String(0.65));
        } catch (_) {
            /* ignore */
        }
        applyThemeBgOpacityVar();
        document.documentElement.style.setProperty("--adv-mini-readability", "0");
        document.documentElement.style.setProperty("--adv-mini-blur-px", "0");
        document.documentElement.style.setProperty("--adv-preview-line-height", "1.65");
        try {
            localStorage.removeItem(ADV_MINI_OVERLAY_PCT_LS);
            localStorage.removeItem(ADV_MINI_BLUR_PX_LS);
            localStorage.removeItem(ADV_PREVIEW_LINE_HEIGHT_LS);
        } catch (_) {
            /* ignore */
        }
    }

    function installAdvDrawerResetButton() {
        const scroll = $("adv-drawer-scroll");
        if (!scroll) return;
        let wrap = scroll.querySelector(".adv-drawer-reset-footer");
        if (!wrap) {
            wrap = document.createElement("div");
            wrap.className = "adv-drawer-reset-footer";
            wrap.style.cssText =
                "margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.12);flex-shrink:0;";
            scroll.appendChild(wrap);
        }
        if (!document.getElementById("adv-backup-all-btn")) {
            const row = document.createElement("div");
            row.className = "adv-drawer-backup-row";
            row.style.cssText =
                "display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center;";
            const backupBtn = document.createElement("button");
            backupBtn.type = "button";
            backupBtn.id = "adv-backup-all-btn";
            backupBtn.textContent = "💾 备份全部";
            backupBtn.setAttribute("aria-label", "备份全部数据");
            backupBtn.style.cssText =
                "flex:1;min-width:120px;box-sizing:border-box;padding:10px 12px;border:1px solid rgba(255,255,255,0.55);background:rgba(255,255,255,0.06);color:#f0f4fc;border-radius:10px;cursor:pointer;font:inherit;";
            const restoreBtn = document.createElement("button");
            restoreBtn.type = "button";
            restoreBtn.id = "adv-restore-backup-btn";
            restoreBtn.textContent = "📥 恢复备份";
            restoreBtn.setAttribute("aria-label", "从备份文件恢复");
            restoreBtn.style.cssText = backupBtn.style.cssText;
            const fileInp = document.createElement("input");
            fileInp.type = "file";
            fileInp.id = "worship-backup-restore-input";
            fileInp.accept = ".worship-backup,application/json";
            fileInp.hidden = true;
            fileInp.setAttribute("aria-hidden", "true");
            backupBtn.addEventListener("click", () => {
                void downloadFullWorshipBackup();
            });
            restoreBtn.addEventListener("click", () => fileInp.click());
            fileInp.addEventListener("change", (e) => {
                void handleWorshipBackupRestoreFile(e);
            });
            row.appendChild(backupBtn);
            row.appendChild(restoreBtn);
            row.appendChild(fileInp);
            wrap.insertBefore(row, wrap.firstChild);
        }
        if (!document.getElementById("adv-reset-defaults-btn")) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.id = "adv-reset-defaults-btn";
            btn.textContent = "↩ 恢复默认";
            btn.setAttribute("aria-label", "恢复默认高级设置");
            btn.style.cssText =
                "width:100%;box-sizing:border-box;padding:10px 14px;border:1px solid #ffffff;background:transparent;color:#ffffff;border-radius:10px;cursor:pointer;font:inherit;";
            btn.addEventListener("click", () => {
                if (!window.confirm("确定要恢复所有高级设置为默认值吗？")) return;
                applyAdvEditSettingsDefaultsToState();
                updateUIFromState();
                updateAll();
            });
            wrap.appendChild(btn);
        }
    }

    function syncThemeBgOpacityControls() {
        const row = $("theme-bg-opacity-row");
        const slider = $("theme-bg-opacity-slider");
        const valEl = $("theme-bg-opacity-value");
        const hasCustom =
            !!(_idbThemeBgCache || "").trim() ||
            (isThemeConsoleVideoActive() && !isDisplay && !isLeader);
        if (row) row.classList.toggle("is-disabled", !hasCustom);
        const v = getThemeBgOpacity();
        if (slider) {
            slider.disabled = !hasCustom;
            slider.value = String(v);
        }
        if (valEl) valEl.textContent = `${Math.round(v * 100)}%`;
    }

    function updateMyBackgroundThumbActiveState() {
        const root = $("my-backgrounds-container");
        if (!root) return;
        const activeUrl = state.ui.bgType === "image" ? String(state.ui.bgImage || "") : "";
        root.querySelectorAll(".lyric-bg-thumb").forEach((thumb) => {
            const id = thumb.dataset.itemId;
            const item = getUploadedBackgrounds().find((x) => x && x.id === id);
            const on = !!(item && activeUrl && item.imageData === activeUrl);
            thumb.classList.toggle("lyric-bg-thumb--active", on);
        });
    }

    function applyThemeBackground() {
        loadThemeConsoleVideoFromStorage();
        const raw = _idbThemeBgCache;
        const body = document.body;
        const root = document.documentElement;
        applyThemeBgOpacityVar();
        const hasVideo = isThemeConsoleVideoActive();
        const hasVideoUi = hasVideo && !isDisplay && !isLeader;
        const hasWallpaper = !!(raw && String(raw).trim());

        /* 有视频时壁纸仍保留在缓存，但 ::before 不绘制，避免与全屏 video 同层叠放时挡住视频 */
        if (hasVideoUi) {
            root.style.setProperty("--theme-bg-image", "none");
        } else if (hasWallpaper) {
            const safe = String(raw).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            root.style.setProperty("--theme-bg-image", `url("${safe}")`);
        } else {
            root.style.setProperty("--theme-bg-image", "none");
        }

        if (hasVideoUi || hasWallpaper) {
            body.setAttribute("data-theme-custom-bg", "1");
        } else {
            body.removeAttribute("data-theme-custom-bg");
        }

        if (!isDisplay && !isLeader) {
            const vidEl = ensureThemeConsoleVideoElement();
            const op = getThemeBgOpacity();
            if (hasVideoUi) {
                body.setAttribute("data-theme-custom-video", "1");
                vidEl.muted = true;
                vidEl.loop = true;
                vidEl.autoplay = true;
                vidEl.controls = false;
                vidEl.setAttribute("playsinline", "");
                vidEl.setAttribute("webkit-playsinline", "true");
                vidEl.src = _themeConsoleVideoDataUrl;
                vidEl.style.display = "block";
                vidEl.style.opacity = String(op);
                void vidEl.play?.().catch(() => {});
            } else {
                body.removeAttribute("data-theme-custom-video");
                try {
                    vidEl.pause();
                    vidEl.removeAttribute("src");
                    vidEl.load();
                } catch (_ve) {}
                vidEl.style.display = "none";
            }
        } else {
            body.removeAttribute("data-theme-custom-video");
            const oldVid = document.getElementById("worship-console-theme-bg-video");
            if (oldVid) {
                try {
                    oldVid.pause();
                    oldVid.remove();
                } catch (_ve) {}
            }
        }

        body.style.backgroundImage = "";
        syncThemeBgOpacityControls();
        renderThemeBgGrid();
    }

    function bgItemId() {
        return "bg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
    }

    function isUploadedItemVideo(item) {
        if (!item || !item.imageData) return false;
        return item.mediaType === "video" || inferMediaTypeFromDataUrl(item.imageData) === "video";
    }

    function analyzeCoverFrameStats(canvas) {
        const ctx = canvas.getContext("2d");
        if (!ctx || canvas.width < 2 || canvas.height < 2) return { mean: 0, variance: 0 };
        let img;
        try {
            img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        } catch (_e) {
            return { mean: 0, variance: 0 };
        }
        const d = img.data;
        const w = canvas.width;
        const h = canvas.height;
        const step = Math.max(2, Math.floor(Math.min(w, h) / 28));
        let sum = 0;
        let sumSq = 0;
        let n = 0;
        for (let y = 0; y < h; y += step) {
            for (let x = 0; x < w; x += step) {
                const i = (y * w + x) * 4;
                const r = d[i];
                const g = d[i + 1];
                const b = d[i + 2];
                const lum = 0.299 * r + 0.587 * g + 0.114 * b;
                sum += lum;
                sumSq += lum * lum;
                n++;
            }
        }
        if (!n) return { mean: 0, variance: 0 };
        const mean = sum / n;
        const variance = Math.max(0, sumSq / n - mean * mean);
        return { mean, variance };
    }

    function isCoverFrameUnusable(stats) {
        if (!stats) return true;
        return stats.mean < 22 || stats.variance < 52;
    }

    /**
     * 从视频 Data URL 截取封面：loadedmetadata 后从 0.5s 起每 0.5s 尝试截帧，过暗或过于单调则继续，最多到 5s；均不合格则用 0.5s 帧兜底。
     */
    function extractVideoCoverFromDataUrl(dataUrl) {
        const src = String(dataUrl || "").trim();
        if (!src || !/^data:video\//i.test(src)) return Promise.resolve("");

        return new Promise((resolve) => {
            let settled = false;
            const video = document.createElement("video");
            video.muted = true;
            video.defaultMuted = true;
            video.setAttribute("playsinline", "");
            video.playsInline = true;
            video.preload = "auto";
            video.style.cssText =
                "position:fixed;left:-9999px;top:0;width:320px;height:180px;opacity:0;pointer-events:none;";

            const canvas = document.createElement("canvas");
            let tid = 0;
            /** 0.5s 处截到的 JPEG，作最终兜底 */
            let fallback05Jpeg = "";
            let candidates = [];
            let idx = 0;

            const finish = (out) => {
                if (settled) return;
                settled = true;
                if (tid) clearTimeout(tid);
                try {
                    video.pause();
                    video.removeAttribute("src");
                    video.load();
                } catch (_e) {
                    /* ignore */
                }
                try {
                    video.remove();
                } catch (_e2) {
                    /* ignore */
                }
                canvas.width = 0;
                canvas.height = 0;
                resolve(String(out || "").trim());
            };

            function buildSeekTimesHalfToFive(durationSec) {
                const out = [];
                for (let s = 0.5; s <= 5.001; s += 0.5) {
                    out.push(Math.round(s * 10) / 10);
                }
                const d = Number(durationSec);
                if (Number.isFinite(d) && d > 0) {
                    const filtered = out.filter((t) => t <= d - 0.04);
                    if (filtered.length) return filtered;
                    const one = clamp(0.5, 0.05, Math.max(0.06, d - 0.05));
                    return [one];
                }
                return out;
            }

            function captureJpegFromVideoFrame() {
                const w = video.videoWidth || 0;
                const h = video.videoHeight || 0;
                if (!w || !h) return null;
                const maxSide = 400;
                let tw = w;
                let th = h;
                if (w > maxSide || h > maxSide) {
                    if (w >= h) {
                        tw = maxSide;
                        th = Math.max(1, Math.round((h * maxSide) / w));
                    } else {
                        th = maxSide;
                        tw = Math.max(1, Math.round((w * maxSide) / h));
                    }
                }
                canvas.width = tw;
                canvas.height = th;
                const ctx = canvas.getContext("2d");
                if (!ctx) return null;
                ctx.drawImage(video, 0, 0, tw, th);
                const stats = analyzeCoverFrameStats(canvas);
                let jpeg;
                try {
                    jpeg = canvas.toDataURL("image/jpeg", 0.72);
                } catch (_e) {
                    jpeg = "";
                }
                return jpeg ? { jpeg, stats } : null;
            }

            function tryNextSeek() {
                if (settled) return;
                if (idx >= candidates.length) {
                    finish(fallback05Jpeg || "");
                    return;
                }
                const slotIndex = idx;
                const t = candidates[idx++];
                const dur = Number(video.duration);
                let target = t;
                if (Number.isFinite(dur) && dur > 0.1) {
                    target = clamp(t, 0.04, Math.max(0.05, dur - 0.05));
                }
                const onSeeked = () => {
                    video.removeEventListener("seeked", onSeeked);
                    const pack = captureJpegFromVideoFrame();
                    if (pack && pack.jpeg && slotIndex === 0) {
                        fallback05Jpeg = pack.jpeg;
                    }
                    if (pack && !isCoverFrameUnusable(pack.stats)) {
                        finish(pack.jpeg);
                        return;
                    }
                    tryNextSeek();
                };
                video.addEventListener("seeked", onSeeked, { once: true });
                try {
                    video.currentTime = target;
                } catch (_e) {
                    tryNextSeek();
                }
            }

            video.addEventListener(
                "loadedmetadata",
                () => {
                    candidates = buildSeekTimesHalfToFive(video.duration);
                    idx = 0;
                    tryNextSeek();
                },
                { once: true }
            );

            video.addEventListener("error", () => finish(""), false);

            tid = window.setTimeout(() => {
                if (settled) return;
                finish(fallback05Jpeg || "");
            }, 20000);

            document.body.appendChild(video);
            video.src = src;
        });
    }

    const _videoThumbExtractingIds = new Set();
    const _coverExtractPromises = new Map();

    function extractAndPersistUploadedVideoCover(itemId) {
        const id = String(itemId || "").trim();
        if (!id) return Promise.resolve();
        const existingP = _coverExtractPromises.get(id);
        if (existingP) return existingP;

        const snapshot = getUploadedBackgrounds().find((x) => x && x.id === id);
        if (!snapshot || !isUploadedItemVideo(snapshot)) return Promise.resolve();
        if (String(snapshot.coverImage || "").trim()) return Promise.resolve();

        const p = (async () => {
            _videoThumbExtractingIds.add(id);
            renderUploadedBackgrounds();
            try {
                const cover = await extractVideoCoverFromDataUrl(snapshot.imageData);
                if (!cover) return;
                const next = getUploadedBackgrounds().map((x) =>
                    x && x.id === id ? { ...x, coverImage: cover } : x
                );
                saveUploadedBackgrounds(next);
            } finally {
                _videoThumbExtractingIds.delete(id);
                renderUploadedBackgrounds();
                try {
                    renderPageGallery();
                } catch (_e) {
                    /* ignore */
                }
            }
        })().finally(() => {
            _coverExtractPromises.delete(id);
        });

        _coverExtractPromises.set(id, p);
        return p;
    }

    let _ensureUploadedVideoCoversChain = Promise.resolve();

    function requestEnsureUploadedVideoCoversOnMineTab() {
        if (isDisplay || isLeader) return;
        _ensureUploadedVideoCoversChain = _ensureUploadedVideoCoversChain
            .then(async () => {
                const ids = getUploadedBackgrounds()
                    .filter((x) => x && isUploadedItemVideo(x) && !String(x.coverImage || "").trim())
                    .map((x) => x.id);
                for (const vid of ids) {
                    await extractAndPersistUploadedVideoCover(vid);
                }
            })
            .catch(() => {});
    }

    /** 「我的背景」缩略图使用次数与最近使用时间（仅本地） */
    const BG_THUMB_USAGE_LS = "worship_bg_thumb_usage_v1";

    function getBgThumbUsageMap() {
        const m = getStore(BG_THUMB_USAGE_LS, {});
        return m && typeof m === "object" ? m : {};
    }

    function saveBgThumbUsageMap(map) {
        setStore(BG_THUMB_USAGE_LS, map && typeof map === "object" ? map : {});
    }

    function recordBgThumbUsage(itemId) {
        const id = String(itemId || "").trim();
        if (!id) return;
        const m = { ...getBgThumbUsageMap() };
        const cur = m[id] && typeof m[id] === "object" ? m[id] : {};
        const count = (Number(cur.count) || 0) + 1;
        m[id] = { count, lastUsedAt: Date.now() };
        saveBgThumbUsageMap(m);
    }

    function pruneBgThumbUsageForId(itemId) {
        const id = String(itemId || "").trim();
        if (!id) return;
        const m = { ...getBgThumbUsageMap() };
        if (m[id]) {
            delete m[id];
            saveBgThumbUsageMap(m);
        }
    }

    function sortUploadedBackgroundsByUsage(items) {
        const arr = Array.isArray(items) ? items.filter((x) => x && x.id) : [];
        const m = getBgThumbUsageMap();
        return arr.slice().sort((a, b) => {
            const ua = Number(m[a.id]?.lastUsedAt) || 0;
            const ub = Number(m[b.id]?.lastUsedAt) || 0;
            if (ua !== ub) return ub - ua;
            const ca = Number(m[a.id]?.count) || 0;
            const cb = Number(m[b.id]?.count) || 0;
            if (ca !== cb) return cb - ca;
            const ta = Number(a.timestamp) || 0;
            const tb = Number(b.timestamp) || 0;
            return tb - ta;
        });
    }

    function getUploadedBackgrounds() {
        return Array.isArray(_idbUploadedCache) ? _idbUploadedCache : [];
    }

    /** 未单独设置背景的诗歌在画廊/恢复时用此模板（启动时从 settings.ui 克隆） */
    let backgroundDefaults = {
        bgType: "solid-black",
        bgImage: "",
        bgImageId: "",
        bgMediaType: "image"
    };

    function hydrateBackgroundSliceFromLibrary(b) {
        const out = {
            bgType: b.bgType || "solid-black",
            bgImage: b.bgImage || "",
            bgImageId: b.bgImageId || "",
            bgMediaType: b.bgMediaType === "video" ? "video" : "image"
        };
        if (out.bgType === "image" && out.bgImageId) {
            const items = getUploadedBackgrounds();
            const it = items.find((x) => x && x.id === out.bgImageId);
            if (it && it.imageData) {
                out.bgImage = it.imageData;
                out.bgMediaType = it.mediaType === "video" ? "video" : inferMediaTypeFromDataUrl(it.imageData);
            }
        }
        if (out.bgType === "image" && String(out.bgImage || "").trim()) {
            if (inferMediaTypeFromDataUrl(out.bgImage) === "video") out.bgMediaType = "video";
        }
        return out;
    }

    function refreshBackgroundDefaultsFromUi() {
        backgroundDefaults = hydrateBackgroundSliceFromLibrary({
            bgType: state.ui.bgType,
            bgImage: state.ui.bgImage || "",
            bgImageId: state.ui.bgImageId || "",
            bgMediaType: state.ui.bgMediaType || "image"
        });
    }

    function getStoredSongBackgroundOrDefaults(song) {
        if (!song) {
            return hydrateBackgroundSliceFromLibrary({ ...backgroundDefaults });
        }
        const hasId = !!(song.bgImageId && String(song.bgImageId).trim());
        const hasBlob = !!(song.bgImage && String(song.bgImage).trim());
        const hasExplicitType = typeof song.bgType === "string" && song.bgType.trim();
        /** 仅有 id/数据而未写 bgType 的旧数据：勿退回全局 backgroundDefaults，否则多首诗歌会共用当前模板、视频互相串 */
        if (hasExplicitType || hasId || hasBlob) {
            const bgType = hasExplicitType
                ? String(song.bgType).trim()
                : hasId || hasBlob
                  ? "image"
                  : String(backgroundDefaults.bgType || "solid-black");
            return hydrateBackgroundSliceFromLibrary({
                bgType,
                bgImage: song.bgImage || "",
                bgImageId: song.bgImageId || "",
                bgMediaType: song.bgMediaType || "image"
            });
        }
        return hydrateBackgroundSliceFromLibrary({ ...backgroundDefaults });
    }

    function applyBackgroundSliceToUi(slice) {
        const h = hydrateBackgroundSliceFromLibrary(slice);
        state.ui.bgType = h.bgType;
        state.ui.bgImage = h.bgImage || "";
        state.ui.bgImageId = h.bgImageId || "";
        state.ui.bgMediaType = h.bgMediaType;
    }

    function persistSongBackgroundFromUi(songId) {
        if (isDisplay || isLeader) return;
        const s = state.songs.find((x) => x.id === songId);
        if (!s) return;
        s.bgType = state.ui.bgType;
        s.bgImage = state.ui.bgImage || "";
        s.bgImageId = state.ui.bgImageId || "";
        s.bgMediaType = state.ui.bgMediaType === "video" ? "video" : "image";
    }

    function persistCurrentSongBgAfterUiChange() {
        if (isDisplay || isLeader) return;
        persistSongBackgroundFromUi(state.currentSongId);
        try {
            saveSongs();
        } catch (_e) {
            /* ignore */
        }
    }

    function hydrateCurrentSongBackgroundIntoUi() {
        const s = currentSong();
        if (!s) return;
        applyBackgroundSliceToUi(getStoredSongBackgroundOrDefaults(s));
        normalizeLegacyBgImageReference();
    }

    /** 画廊 / 逻辑用：当前诗歌与高级编辑 state.ui 同步；其余诗歌读各自持久化字段或 backgroundDefaults */
    function effectiveSongBackground(song) {
        if (!song) {
            return hydrateBackgroundSliceFromLibrary({ ...backgroundDefaults });
        }
        if (String(song.id) === String(state.currentSongId)) {
            return hydrateBackgroundSliceFromLibrary({
                bgType: state.ui.bgType,
                bgImage: state.ui.bgImage || "",
                bgImageId: state.ui.bgImageId || "",
                bgMediaType: state.ui.bgMediaType || "image"
            });
        }
        return getStoredSongBackgroundOrDefaults(song);
    }

    function isMainVideoBackground() {
        if (isDisplay || isLeader) return false;
        const s = currentSong();
        if (!s) return false;
        const eff = effectiveSongBackground(s);
        return (
            eff.bgType === "image" &&
            eff.bgMediaType === "video" &&
            !!String(eff.bgImage || "").trim()
        );
    }

    function saveUploadedBackgrounds(arr) {
        persistUploadedBackgroundsAsync(Array.isArray(arr) ? arr : []);
    }

    function normalizeLegacyBgImageReference() {
        if (state.ui.bgType !== "image") return;
        const items = getUploadedBackgrounds();
        if (state.ui.bgImageId) {
            const it = items.find((x) => x && x.id === state.ui.bgImageId);
            if (it && it.imageData) {
                state.ui.bgImage = it.imageData;
                state.ui.bgMediaType = it.mediaType === "video" ? "video" : inferMediaTypeFromDataUrl(it.imageData);
                saveSettings();
                return;
            }
            state.ui.bgImageId = "";
        }
        const bg = String(state.ui.bgImage || "").trim();
        if (!bg) return;
        let match = items.find((x) => x && x.imageData === bg);
        if (!match) {
            match = {
                id: bgItemId(),
                imageData: bg,
                mediaType: inferMediaTypeFromDataUrl(bg),
                tags: [],
                timestamp: Date.now(),
                shared: false
            };
            saveUploadedBackgrounds([match, ...items]);
        }
        state.ui.bgImageId = match.id;
        state.ui.bgMediaType = match.mediaType === "video" ? "video" : inferMediaTypeFromDataUrl(match.imageData);
        saveSettings();
    }

    function migrateLegacyUploadedBackgrounds() {
        if (getUploadedBackgrounds().length > 0) return;
        const old = getStore(LEGACY_LYRIC_BGS_STORAGE, null);
        if (old && Array.isArray(old.items) && old.items.length) {
            const mapped = old.items.map((x) => ({
                id: bgItemId(),
                imageData: String(x.dataUrl || x.imageData || "").trim(),
                mediaType: "image",
                tags: Array.isArray(x.tags) ? x.tags : [],
                timestamp: Number(x.addedAt) || Number(x.timestamp) || Date.now(),
                shared: !!x.shared
            })).filter((x) => x.imageData);
            if (mapped.length) saveUploadedBackgrounds(mapped);
            return;
        }
    }

    function seedUploadedBackgroundsFromState() {
        if (getUploadedBackgrounds().length > 0) return;
        if (state.ui.bgType === "image" && String(state.ui.bgImage || "").trim()) {
            const nid = bgItemId();
            saveUploadedBackgrounds([{
                id: nid,
                imageData: state.ui.bgImage,
                mediaType: inferMediaTypeFromDataUrl(state.ui.bgImage),
                tags: [],
                timestamp: Date.now(),
                shared: false
            }]);
            state.ui.bgImageId = nid;
            saveSettings();
        }
    }

    function addUploadedBackgroundAndApply(imageData, mediaTypeHint) {
        const data = String(imageData || "").trim();
        if (!data) return;
        const hinted = mediaTypeHint === "video" || mediaTypeHint === "image" ? mediaTypeHint : null;
        let arr = getUploadedBackgrounds().slice();
        let chosenId = "";
        const existing = arr.find((x) => x && x.imageData === data);
        if (existing) {
            chosenId = existing.id;
        } else {
            chosenId = bgItemId();
            const mt = hinted || inferMediaTypeFromDataUrl(data);
            arr = [{
                id: chosenId,
                imageData: data,
                mediaType: mt,
                tags: [],
                timestamp: Date.now(),
                shared: false
            }, ...arr];
            saveUploadedBackgrounds(arr);
        }
        state.ui.bgType = "image";
        state.ui.bgImage = data;
        state.ui.bgImageId = chosenId;
        state.ui.bgMediaType = existing
            ? (existing.mediaType === "video" ? "video" : inferMediaTypeFromDataUrl(existing.imageData))
            : (hinted || inferMediaTypeFromDataUrl(data));
        state.ui.lyricsBgShareToCloud = false;
        recordBgThumbUsage(chosenId);
        renderUploadedBackgrounds();
        const row = getUploadedBackgrounds().find((x) => x && x.id === chosenId);
        if (row && isUploadedItemVideo(row) && !String(row.coverImage || "").trim()) {
            void extractAndPersistUploadedVideoCover(chosenId);
        }
        persistCurrentSongBgAfterUiChange();
    }

    function confirmShareMyBackgroundModal() {
        return new Promise((resolve) => {
            let settled = false;
            const overlay = document.createElement("div");
            overlay.id = "share-bg-confirm-modal";
            overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:3500;display:flex;align-items:center;justify-content:center;";
            overlay.innerHTML = `
                <div style="background:var(--bg-secondary);border-radius:14px;padding:22px 24px;max-width:420px;border:1px solid var(--border-color);">
                    <p style="margin:0 0 16px;color:var(--text-primary);line-height:1.55;font-size:0.95rem;">是否将此背景共享到云端素材库？共享后其他用户将可以预览和使用此背景。</p>
                    <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;">
                        <button type="button" id="share-bg-cancel" class="btn btn-outline">取消</button>
                        <button type="button" id="share-bg-ok" class="btn">✅ 共享</button>
                    </div>
                </div>`;
            const finish = (v) => {
                if (settled) return;
                settled = true;
                document.removeEventListener("keydown", onKeyDown);
                overlay.remove();
                resolve(!!v);
            };
            const onKeyDown = (e) => {
                if (e.key === "Escape") finish(false);
            };
            overlay.querySelector("#share-bg-cancel").addEventListener("click", () => finish(false));
            overlay.querySelector("#share-bg-ok").addEventListener("click", () => finish(true));
            overlay.addEventListener("click", (e) => {
                if (e.target === overlay) finish(false);
            });
            document.addEventListener("keydown", onKeyDown);
            document.body.appendChild(overlay);
            requestAnimationFrame(() => overlay.querySelector("#share-bg-cancel")?.focus());
        });
    }

    let _bgHoverPreviewTimer = 0;

    function hideBgHoverPreview() {
        if (_bgHoverPreviewTimer) {
            clearTimeout(_bgHoverPreviewTimer);
            _bgHoverPreviewTimer = 0;
        }
        const root = $("bg-hover-preview-overlay");
        const inner = $("bg-hover-preview-inner");
        if (!root || !inner) return;
        root.classList.remove("is-visible");
        root.hidden = true;
        root.setAttribute("aria-hidden", "true");
        inner.innerHTML = "";
    }

    function scheduleBgHoverPreviewThumb(item) {
        hideBgHoverPreview();
        if (!item || !item.imageData) return;
        const root = $("bg-hover-preview-overlay");
        const inner = $("bg-hover-preview-inner");
        if (!root || !inner) return;
        _bgHoverPreviewTimer = window.setTimeout(() => {
            _bgHoverPreviewTimer = 0;
            inner.innerHTML = "";
            const isVid = item.mediaType === "video" || inferMediaTypeFromDataUrl(item.imageData) === "video";
            if (isVid) {
                const v = document.createElement("video");
                v.src = item.imageData;
                v.muted = true;
                v.loop = true;
                v.playsInline = true;
                v.autoplay = true;
                v.setAttribute("playsinline", "");
                inner.appendChild(v);
                void v.play().catch(() => {});
            } else {
                const im = document.createElement("img");
                im.alt = "";
                im.src = item.imageData;
                inner.appendChild(im);
            }
            root.hidden = false;
            root.classList.add("is-visible");
            root.setAttribute("aria-hidden", "false");
        }, 280);
    }

    function scheduleBgHoverPreviewUrl(imageUrl) {
        hideBgHoverPreview();
        const url = String(imageUrl || "").trim();
        if (!url) return;
        const root = $("bg-hover-preview-overlay");
        const inner = $("bg-hover-preview-inner");
        if (!root || !inner) return;
        _bgHoverPreviewTimer = window.setTimeout(() => {
            _bgHoverPreviewTimer = 0;
            inner.innerHTML = "";
            const im = document.createElement("img");
            im.alt = "";
            im.src = url;
            inner.appendChild(im);
            root.hidden = false;
            root.classList.add("is-visible");
            root.setAttribute("aria-hidden", "false");
        }, 280);
    }

    function reorderUploadedBackgrounds(fromId, toId) {
        const a = String(fromId || "").trim();
        const b = String(toId || "").trim();
        if (!a || !b || a === b) return;
        const arr = getUploadedBackgrounds().slice();
        const i = arr.findIndex((x) => x && x.id === a);
        const j = arr.findIndex((x) => x && x.id === b);
        if (i < 0 || j < 0) return;
        const [moved] = arr.splice(i, 1);
        arr.splice(j, 0, moved);
        saveUploadedBackgrounds(arr);
        renderUploadedBackgrounds();
    }

    function renderUploadedBackgrounds() {
        const root = $("my-backgrounds-container");
        if (!root) return;
        const items = getUploadedBackgrounds().filter((x) => x && x.imageData);
        root.innerHTML = "";
        if (!items.length) {
            root.innerHTML = '<div class="hint-text my-backgrounds-empty-hint">暂无已上传背景，请在「预设背景」中上传图片</div>';
            const emptyAdd = document.createElement("button");
            emptyAdd.type = "button";
            emptyAdd.className = "lyric-bg-slot-empty";
            emptyAdd.title = "上传背景";
            emptyAdd.setAttribute("aria-label", "上传背景");
            emptyAdd.innerHTML = '<span class="lyric-bg-slot-empty-plus" aria-hidden="true">+</span>';
            emptyAdd.addEventListener("click", (e) => {
                e.preventDefault();
                $("bg-image-input")?.click();
            });
            root.appendChild(emptyAdd);
            return;
        }
        let dragFromId = "";
        items.forEach((item) => {
            if (!item || !item.imageData) return;
            const wrap = document.createElement("div");
            wrap.className = "lyric-bg-thumb-wrap";
            wrap.dataset.wrapItemId = item.id;

            const grip = document.createElement("span");
            grip.className = "lyric-bg-drag-handle";
            grip.draggable = true;
            grip.title = "拖动排序";
            grip.setAttribute("aria-hidden", "true");
            grip.textContent = "⋮⋮";

            const isVid = item.mediaType === "video" || inferMediaTypeFromDataUrl(item.imageData) === "video";
            const thumb = document.createElement("button");
            thumb.type = "button";
            thumb.className = "lyric-bg-thumb" + (isVid ? " lyric-bg-thumb--video" : "");
            thumb.dataset.itemId = item.id;
            if (isVid) {
                const cover = String(item.coverImage || "").trim();
                const extracting = _videoThumbExtractingIds.has(item.id);
                thumb.style.position = "relative";
                thumb.style.backgroundImage = "none";
                thumb.style.background = "linear-gradient(145deg,#1e1e28,#12121a)";
                if (cover) {
                    const covImg = document.createElement("img");
                    covImg.className = "lyric-bg-thumb-cover-img";
                    covImg.alt = "";
                    covImg.draggable = false;
                    covImg.src = cover;
                    thumb.appendChild(covImg);
                }
                if (extracting) {
                    const spin = document.createElement("span");
                    spin.className = "lyric-bg-thumb-cover-spinner";
                    spin.setAttribute("aria-hidden", "true");
                    thumb.appendChild(spin);
                }
                const badge = document.createElement("span");
                badge.className = "lyric-bg-thumb-play-badge";
                badge.setAttribute("aria-hidden", "true");
                badge.style.cssText =
                    "position:absolute;right:6px;bottom:6px;width:16px;height:16px;border-radius:50%;" +
                    "background:rgba(255,255,255,0.38);display:flex;align-items:center;justify-content:center;" +
                    "pointer-events:none;box-sizing:border-box;";
                const playIc = document.createElement("span");
                playIc.className = "lyric-bg-thumb-play-icon";
                playIc.textContent = "▶";
                playIc.style.cssText = "font-size:8px;line-height:1;color:#fff;";
                badge.appendChild(playIc);
                thumb.appendChild(badge);
            } else {
                thumb.style.backgroundImage = `url("${String(item.imageData).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
            }
            thumb.title = isVid ? "点击使用视频背景" : "点击使用图片背景";
            if (state.ui.bgType === "image" && state.ui.bgImage === item.imageData) {
                thumb.classList.add("lyric-bg-thumb--active");
            }
            thumb.addEventListener("mouseenter", () => scheduleBgHoverPreviewThumb(item));
            thumb.addEventListener("mouseleave", () => hideBgHoverPreview());
            thumb.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                state.ui.bgType = "image";
                state.ui.bgImageId = item.id;
                state.ui.bgImage = item.imageData;
                state.ui.bgMediaType = isVid ? "video" : "image";
                state.ui.lyricsBgShareToCloud = false;
                recordBgThumbUsage(item.id);
                updateUIFromState();
                updateAll();
                saveSettings();
                persistCurrentSongBgAfterUiChange();
                renderUploadedBackgrounds();
                showToast("已切换背景", thumb);
            });

            const delBtn = document.createElement("button");
            delBtn.type = "button";
            delBtn.className = "lyric-bg-thumb-delete";
            delBtn.setAttribute("aria-label", "删除此背景");
            delBtn.textContent = "✕";
            delBtn.addEventListener("mousedown", (e) => e.stopPropagation());
            delBtn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                openLyricBgDeletePopover(wrap, item.id);
            });

            const defBtn = document.createElement("button");
            defBtn.type = "button";
            defBtn.className =
                "lyric-bg-default-btn" + (String(state.ui.defaultUploadedBgId || "") === item.id ? " is-on" : "");
            defBtn.textContent = String(state.ui.defaultUploadedBgId || "") === item.id ? "取消" : "设默认";
            defBtn.title = "标记或取消默认背景";
            defBtn.addEventListener("mousedown", (e) => e.stopPropagation());
            defBtn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (String(state.ui.defaultUploadedBgId || "") === item.id) {
                    state.ui.defaultUploadedBgId = "";
                    showToast("已取消默认背景", defBtn);
                } else {
                    state.ui.defaultUploadedBgId = item.id;
                    showToast("已设为默认背景", defBtn);
                }
                saveSettings();
                renderUploadedBackgrounds();
            });

            grip.addEventListener("dragstart", (e) => {
                dragFromId = item.id;
                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", item.id);
                }
                wrap.classList.add("lyric-bg-thumb-wrap--dragging");
            });
            grip.addEventListener("dragend", () => {
                dragFromId = "";
                wrap.classList.remove("lyric-bg-thumb-wrap--dragging");
            });
            wrap.addEventListener("dragover", (e) => {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            });
            wrap.addEventListener("drop", (e) => {
                e.preventDefault();
                const from =
                    dragFromId ||
                    String(e.dataTransfer?.getData("text/plain") || "").trim();
                dragFromId = "";
                reorderUploadedBackgrounds(from, item.id);
            });

            wrap.appendChild(grip);
            wrap.appendChild(thumb);
            wrap.appendChild(delBtn);
            if (!item.shared && !isVid) {
                const shareBtn = document.createElement("button");
                shareBtn.type = "button";
                shareBtn.className = "bg-share-icon";
                shareBtn.title = "共享到云端";
                shareBtn.setAttribute("aria-label", "共享此背景");
                shareBtn.textContent = "☁";
                shareBtn.addEventListener("mousedown", (e) => e.stopPropagation());
                shareBtn.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    shareMyBackgroundItem(item.id, shareBtn);
                });
                wrap.appendChild(shareBtn);
            } else if (item.shared) {
                const sb = document.createElement("span");
                sb.className = "bg-shared-badge";
                sb.title = "已共享";
                wrap.appendChild(sb);
            }
            wrap.appendChild(defBtn);
            if (String(state.ui.defaultUploadedBgId || "") === item.id) {
                const defBadge = document.createElement("span");
                defBadge.className = "lyric-bg-default-badge";
                defBadge.textContent = "默认";
                wrap.appendChild(defBadge);
            }
            root.appendChild(wrap);
        });

        if (items.length < UPLOADED_BACKGROUNDS_MAX) {
            const slot = document.createElement("button");
            slot.type = "button";
            slot.className = "lyric-bg-slot-empty";
            slot.title = "上传背景";
            slot.setAttribute("aria-label", "上传背景");
            slot.innerHTML = '<span class="lyric-bg-slot-empty-plus" aria-hidden="true">+</span>';
            slot.addEventListener("click", (e) => {
                e.preventDefault();
                $("bg-image-input")?.click();
            });
            root.appendChild(slot);
        }
    }

    async function shareMyBackgroundItem(itemId, triggerEl) {
        const arr = getUploadedBackgrounds();
        const item = arr.find((x) => x && x.id === itemId);
        if (!item || !item.imageData || item.shared) return;
        if (item.mediaType === "video" || inferMediaTypeFromDataUrl(item.imageData) === "video") {
            showToast("视频背景暂不支持共享到云端", triggerEl);
            return;
        }
        const agreed = await confirmShareMyBackgroundModal();
        if (!agreed) return;
        if (!supabase) {
            showToast("Supabase 未初始化，无法共享", triggerEl);
            return;
        }
        try {
            const { error } = await supabase.from("backgrounds").insert([{
                image_url: item.imageData,
                tags: ["背景"],
                uploaded_by: "anonymous"
            }]);
            if (error) {
                console.error("shareMyBackgroundItem Supabase error:", error);
                showToast("❌ 提交失败，请重试", triggerEl);
                return;
            }
            item.shared = true;
            saveUploadedBackgrounds(arr);
            renderUploadedBackgrounds();
            showToast("✅ 已共享到云端素材库", triggerEl);
            loadSharedBackgrounds();
        } catch (err) {
            console.error("shareMyBackgroundItem:", err);
            showToast("❌ 提交失败，请重试", triggerEl);
        }
    }

    async function loadSharedBackgrounds() {
        const root = $("shared-backgrounds-container");
        if (!root) return;
        if (!supabase) {
            root.innerHTML = '<div class="hint-text" style="grid-column:1/-1;">Supabase 未初始化</div>';
            return;
        }
        root.innerHTML = '<div class="hint-text" style="grid-column:1/-1;">加载中…</div>';
        const { data, error } = await supabase
            .from("backgrounds")
            .select("*")
            .order("created_at", { ascending: false })
            .limit(48);
        if (error) {
            console.error("loadSharedBackgrounds", error);
            root.innerHTML = '<div class="hint-text" style="grid-column:1/-1;">共享背景加载失败</div>';
            return;
        }
        const rows = Array.isArray(data) ? data : [];
        root.innerHTML = "";
        if (!rows.length) {
            root.innerHTML = '<div class="hint-text" style="grid-column:1/-1;">暂无云端共享背景</div>';
            return;
        }
        rows.forEach((row) => {
            const imageUrl = String(row.image_url || "").trim();
            if (!imageUrl) return;
            const wrap = document.createElement("div");
            wrap.className = "lyric-bg-thumb-wrap";
            const thumb = document.createElement("button");
            thumb.type = "button";
            thumb.className = "lyric-bg-thumb";
            thumb.style.backgroundImage = `url("${imageUrl.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
            const tagHint = Array.isArray(row.tags) ? row.tags.filter(Boolean).join(", ") : String(row.tags || "");
            thumb.title = tagHint || "云端共享背景";
            thumb.addEventListener("click", () => {
                state.ui.bgType = "image";
                state.ui.bgImageId = "";
                state.ui.bgImage = imageUrl;
                state.ui.bgMediaType = "image";
                state.ui.lyricsBgShareToCloud = false;
                updateUIFromState();
                updateAll();
                saveSettings();
                persistCurrentSongBgAfterUiChange();
                showToast("已应用共享背景", thumb);
            });
            thumb.addEventListener("mouseenter", () => scheduleBgHoverPreviewUrl(imageUrl));
            thumb.addEventListener("mouseleave", () => hideBgHoverPreview());
            wrap.appendChild(thumb);
            root.appendChild(wrap);
        });
    }

    function switchBgTabTo(name) {
        const tabName = name || "preset";
        document.querySelectorAll(".bg-tab").forEach((tab) => {
            const on = tab.getAttribute("data-bg-tab") === tabName;
            tab.classList.toggle("active", on);
            tab.setAttribute("aria-selected", on ? "true" : "false");
        });
        document.querySelectorAll(".bg-tab-panel").forEach((p) => {
            p.classList.toggle("active", p.id === `bg-tab-${tabName}`);
        });
        if (tabName === "shared") loadSharedBackgrounds();
        if (tabName === "mine") {
            renderUploadedBackgrounds();
            requestEnsureUploadedVideoCoversOnMineTab();
        }
    }

    function initBgTabs() {
        const tabs = document.querySelectorAll(".bg-tab");
        if (!tabs.length) return;
        tabs.forEach((tab) => {
            tab.addEventListener("click", () => {
                switchBgTabTo(tab.getAttribute("data-bg-tab") || "preset");
            });
        });
        const hoverOv = $("bg-hover-preview-overlay");
        if (hoverOv && hoverOv.dataset.dismissBound !== "1") {
            hoverOv.dataset.dismissBound = "1";
            hoverOv.addEventListener("click", (e) => {
                if (e.target === hoverOv || (e.target && e.target.classList.contains("bg-hover-preview-backdrop"))) {
                    hideBgHoverPreview();
                }
            });
        }
    }

    function openFreeBgMaterialsPanel() {
        let modal = $("free-bg-materials-modal");
        if (modal) {
            modal.style.display = "flex";
            return;
        }
        modal = document.createElement("div");
        modal.id = "free-bg-materials-modal";
        modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:3600;display:flex;align-items:center;justify-content:center;padding:16px;";
        const sites = [
            {
                name: "Pixabay",
                desc: "动态视频 / 静态图 / 粒子效果",
                kw: "推荐搜索：中文可试 敬拜、十字架、祈祷、光效｜英文 worship background, church motion, particles loop, light rays, golden glow",
                badge: "免费可商用",
                url: "https://pixabay.com/"
            },
            {
                name: "Pexels",
                desc: "高质量视频 / 自然风景",
                kw: "推荐搜索：中文可试 敬拜、十字架、祈祷、云彩｜英文 worship, church, cross, clouds, sunset, ocean",
                badge: "免费可商用",
                url: "https://www.pexels.com/"
            },
            {
                name: "Coverr",
                desc: "专门免费视频背景",
                kw: "推荐搜索：中文可试 敬拜、祈祷、抽象、自然｜英文 faith, spiritual, abstract, nature, ambient",
                badge: "免费可商用",
                url: "https://coverr.co/"
            },
            {
                name: "Canva",
                desc: "设计感强 / 宗教主题",
                kw: "推荐搜索：敬拜、十字架、祈祷、教会｜worship background, Christian, church stage",
                badge: "免费版可用，部分需署名",
                url: "https://www.canva.com/"
            }
        ];
        const inner = document.createElement("div");
        inner.style.cssText = "background:var(--bg-secondary);border-radius:16px;padding:20px 22px;max-width:560px;width:100%;max-height:90vh;overflow-y:auto;border:1px solid var(--border-color);position:relative;";
        inner.innerHTML = `<button type="button" id="free-bg-modal-close" style="position:absolute;right:12px;top:10px;border:none;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:1.1rem;">✕</button>
            <h3 class="free-bg-modal-title" style="margin:0 0 4px;color:var(--text-primary);font-size:1.05rem;display:flex;align-items:center;gap:8px;"><span class="ui-icon ui-icon--resources" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M14 17h7M17.5 14v7" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg></span>免费背景素材</h3>
            <p class="hint-text" style="margin-top:6px;">点击卡片在新标签页打开网站</p>
            <p class="hint-text" style="margin-top:10px;line-height:1.55;color:rgba(245,230,200,0.9);">在各站搜索框可中英文混合尝试，例如中文：<b>敬拜</b>、<b>十字架</b>、<b>祈祷</b>、教会、赞美、信仰、光效、粒子；英文如 <b>worship</b>、<b>cross</b>、<b>prayer</b>、church、faith、bokeh、particles、ambient 等，多换几个词组合更易找到合适背景。</p>
            <div class="free-bg-modal-grid" id="free-bg-modal-grid"></div>
            <p class="free-bg-modal-foot">下载后回到本页，用「上传背景图片」即可使用</p>`;
        const grid = inner.querySelector("#free-bg-modal-grid");
        sites.forEach((s) => {
            const card = document.createElement("button");
            card.type = "button";
            card.className = "free-bg-card";
            card.innerHTML = `<div class="free-bg-card-name">${escapeHtml(s.name)}</div>
                <div class="free-bg-card-desc">${escapeHtml(s.desc)}</div>
                <div class="free-bg-card-kw">${escapeHtml(s.kw)}</div>
                <div class="free-bg-card-badge">${escapeHtml(s.badge)}</div>`;
            card.addEventListener("click", () => window.open(s.url, "_blank", "noopener,noreferrer"));
            grid.appendChild(card);
        });
        inner.querySelector("#free-bg-modal-close").addEventListener("click", () => {
            modal.style.display = "none";
        });
        modal.appendChild(inner);
        modal.addEventListener("click", (e) => {
            if (e.target === modal) modal.style.display = "none";
        });
        document.body.appendChild(modal);
        modal.style.display = "flex";
    }

    function syncGlobalSongStoresFromState() {
        try {
            const AS = globalThis.AppState;
            if (AS && Array.isArray(AS.songs) && AS.songs !== state.songs) {
                AS.songs.length = 0;
                for (let i = 0; i < state.songs.length; i++) AS.songs.push(state.songs[i]);
                if (state.currentSongId != null) AS.currentSongId = state.currentSongId;
            }
            const rootSongs = globalThis.songs;
            if (rootSongs && rootSongs !== state.songs && Array.isArray(rootSongs)) {
                rootSongs.length = 0;
                for (let i = 0; i < state.songs.length; i++) rootSongs.push(state.songs[i]);
            }
            const WD = globalThis.WorshipData;
            if (WD && WD.songs !== state.songs) {
                WD.songs = state.songs;
                WD.currentSongId = state.currentSongId;
            }
        } catch (_e) {
            /* ignore */
        }
    }

    function saveSongs() {
        /* 必须写入 app.js 的 state.songs。若仅委托 globalThis.saveSongs（state.js），
         * 会持久化未与编辑器同步的 AppState.songs，导致「保存」后刷新丢失、搜索不到。 */
        try {
            setStore(STORAGE.SONGS, state.songs);
        } catch (err) {
            if (!isStorageQuotaExceededError(err)) console.warn("saveSongs", err);
        }
        syncGlobalSongStoresFromState();
    }

    function saveSettings() {
        try {
            if (typeof globalThis.saveSettings === "function") globalThis.saveSettings();
        } catch (_e) {
            /* ignore */
        }
        const ui = { ...state.ui };
        delete ui.overlayOpacityPct;
        delete ui.fontOpacityPct;
        if (ui.bgType === "image" && ui.bgImageId) {
            ui.bgImage = "";
        }
        try {
            setStore(STORAGE.SETTINGS, {
                currentSongId: state.currentSongId,
                currentPage: state.currentPage,
                sizePreset: state.sizePreset,
                ui
            });
        } catch (err) {
            console.warn("saveSettings setStore SETTINGS", err);
        }
    }

    function savePlaylist() {
        /* 必须写入 app.js 的 state.playlist。若委托 globalThis.savePlaylist（state.js），
         * 会持久化另一份未同步的 playlist，导致「加载歌单」后列表不保存或刷新丢失。 */
        try {
            setStore(STORAGE.PLAYLIST, {
                items: [...state.playlist.items],
                running: !!state.playlist.running,
                activeIndex: clamp(
                    Number(state.playlist.activeIndex) || 0,
                    0,
                    Math.max(0, state.playlist.items.length - 1)
                )
            });
        } catch (err) {
            if (!isStorageQuotaExceededError(err)) console.warn("savePlaylist", err);
        }
    }

    /** 从 localStorage 恢复 app.js 的 state（与 state.js 并行；刷新后 UI 与投屏设置一致） */
    function hydrateAppStateFromStorage() {
        const songs = getStore(STORAGE.SONGS, []);
        const settings = getStore(STORAGE.SETTINGS, null);

        if (Array.isArray(songs) && songs.length) {
            state.songs = songs;
            let migratedSongVisual = false;
            state.songs.forEach((s) => {
                if (!Number.isFinite(Number(s.overlayOpacityPct))) {
                    s.overlayOpacityPct = 30;
                    migratedSongVisual = true;
                }
                if (!Number.isFinite(Number(s.fontOpacityPct))) {
                    s.fontOpacityPct = 100;
                    migratedSongVisual = true;
                }
            });
            if (migratedSongVisual) saveSongs();
        } else {
            state.songs = [{ id: uid(), ...DEFAULT_SONG }];
        }

        if (settings) {
            state.currentSongId = settings.currentSongId || state.songs[0].id;
            state.currentPage = Number.isFinite(settings.currentPage) ? settings.currentPage : 0;
            state.sizePreset = settings.sizePreset || "M";
            if (settings.ui && typeof settings.ui === "object") {
                state.ui = { ...state.ui, ...settings.ui };
            }
            if (state.ui.fontWeight == null || state.ui.fontWeight === "") {
                state.ui.fontWeight = "700";
            }
            if (!state.ui.bgImageId) state.ui.bgImageId = "";
            if (state.ui.bgMediaType !== "video" && state.ui.bgMediaType !== "image") {
                state.ui.bgMediaType = "image";
            }
            if (state.ui.fontMegaMode !== true) state.ui.fontMegaMode = false;
            if (state.ui.defaultUploadedBgId == null) state.ui.defaultUploadedBgId = "";
            state.ui.editorAutoFontSize = false;
            state.ui.editorAutoFontMinPx = clamp(Number(state.ui.editorAutoFontMinPx) || 11, 9, 22);
            state.ui.editorAutoFontMaxPx = clamp(
                Number(state.ui.editorAutoFontMaxPx) || 20,
                state.ui.editorAutoFontMinPx + 1,
                32
            );
            if (Number(state.ui.fontSize) > 300) state.ui.fontMegaMode = true;
            const cap = state.ui.fontMegaMode ? 500 : 300;
            state.ui.fontSize = clamp(Number(state.ui.fontSize) || 60, 8, cap);
        } else {
            state.currentSongId = state.songs[0].id;
            state.ui.theme = "dark";
        }

        if (!state.songs.some((s) => s.id === state.currentSongId)) {
            state.currentSongId = state.songs[0].id;
        }
        const playlist = getStore(STORAGE.PLAYLIST, null);
        if (playlist && Array.isArray(playlist.items)) {
            state.playlist.items = playlist.items.filter((id) => state.songs.some((s) => s.id === id));
            state.playlist.running = !!playlist.running && state.playlist.items.length > 0;
            state.playlist.activeIndex = clamp(Number(playlist.activeIndex) || 0, 0, Math.max(0, state.playlist.items.length - 1));
        }
        state.playlist.autoSwitch = false;
        defaultSongPosY = clamp(Number(state.ui.posY) || 40, 20, 70);
        const curSong = state.songs.find((s) => s.id === state.currentSongId);
        if (curSong) {
            const pc = splitPages(curSong.lyrics || "", state.ui.defaultLines);
            state.currentPage = clamp(state.currentPage, 0, Math.max(0, pc.length - 1));
        }

        const allowedThemes = new Set(["dark", "light", "warm", "high-contrast"]);
        if (!allowedThemes.has(String(state.ui.theme || ""))) {
            state.ui.theme = "dark";
        }
        state.ui.pageTransition = canonicalPageTransition(state.ui.pageTransition);
        state.ui.pageTransitionSpeed =
            Math.round(clamp(Number(state.ui.pageTransitionSpeed) || 0.6, 0.3, 1.5) * 10) / 10;
        state.ui.vignetteShape = state.ui.vignetteShape === "ellipse" ? "ellipse" : "circle";
        state.ui.vignetteCenterBrightness = clamp(Number(state.ui.vignetteCenterBrightness) || 0, -50, 50);
        state.ui.vignetteEdgeDarkness = clamp(Number(state.ui.vignetteEdgeDarkness) || 0, 0, 90);

        loadThemeBgSlotsFromStorage();
        loadThemeConsoleVideoFromStorage();
    }

    /* ==========================================================
       loadState：持久化加载已部分迁移至 js/state.js（globalThis.loadState）。
       本包装先尝试新模块，再始终执行 hydrateAppStateFromStorage() 作为 app.js 侧回退。
       保留此结构作为安全网；未来版本可考虑收紧或移除本地 hydrate。
       ========================================================== */
    function loadState() {
        hydrateAppStateFromStorage();
        syncGlobalSongStoresFromState();
    }

    function persistStateBeforeHide() {
        if (isDisplay || isLeader) return;
        try {
            syncEditorToSong();
            persistSongBackgroundFromUi(state.currentSongId);
            saveSongs();
            saveSettings();
            persistAdvPreviewCssVars();
        } catch (_) {
            /* ignore */
        }
    }

    /** 程序化写入歌词框时置位，避免触发 input 里「每键重置页码」等逻辑（部分浏览器在赋值时仍会派发 input） */
    let _lyricEditorProgrammaticWrite = false;
    function setLyricEditorValueProgrammatically(val) {
        const ed = $("lyric-editor-large");
        if (!ed) return;
        _lyricEditorProgrammaticWrite = true;
        try {
            ed.value = String(val ?? "");
        } finally {
            _lyricEditorProgrammaticWrite = false;
        }
        scheduleFitLyricEditorFont();
    }

    /** 粘贴歌词：统一换行、去掉行尾与全文末尾的多余空格 */
    function normalizePastedLyricsText(raw) {
        let s = String(raw ?? "")
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n");
        const lines = s.split("\n").map((line) => String(line).replace(/[ \t\u3000\u00A0\uFEFF]+$/g, ""));
        s = lines.join("\n");
        s = s.replace(/[ \t\u3000\u00A0\uFEFF]+$/g, "");
        return s;
    }

    let _fitLyricEditorFontTimer = 0;
    function scheduleFitLyricEditorFont() {
        if (_fitLyricEditorFontTimer) clearTimeout(_fitLyricEditorFontTimer);
        _fitLyricEditorFontTimer = window.setTimeout(() => {
            _fitLyricEditorFontTimer = 0;
            fitLyricEditorFontToBox();
        }, 40);
    }

    /** 编辑区字号：仅使用 A+/A− 与 localStorage 中的手动字号 */
    function fitLyricEditorFontToBox() {
        const ta = $("lyric-editor-large");
        if (!ta) return;
        applyLyricEditorUserFont(readLyricEditorUserFontPx());
    }

    const LYRIC_EDITOR_HEIGHT_LS_KEY = "worship.lyricEditorHeightPx.v1";
    const LYRIC_EDITOR_USER_FONT_LS = "worship.lyricEditorUserFontPx.v1";

    function readLyricEditorUserFontPx() {
        const v = parseInt(String(localStorage.getItem(LYRIC_EDITOR_USER_FONT_LS) || "16"), 10);
        return clamp(Number.isFinite(v) ? v : 16, 10, 32);
    }

    function writeLyricEditorUserFontPx(px) {
        try {
            localStorage.setItem(LYRIC_EDITOR_USER_FONT_LS, String(clamp(Number(px) || 16, 10, 32)));
        } catch (_e) {
            /* ignore */
        }
    }

    function syncLyricEditorFontSizeDisplay() {
        const ta = $("lyric-editor-large");
        const disp = $("editor-font-size-display");
        if (!ta || !disp) return;
        const fs = window.getComputedStyle(ta).fontSize;
        const n = Math.round(parseFloat(fs) || 16);
        disp.textContent = String(n);
    }

    function applyLyricEditorUserFont(px) {
        const ta = $("lyric-editor-large");
        if (!ta) return;
        const p = clamp(Number(px) || 16, 10, 32);
        ta.style.fontSize = `${p}px`;
        syncLyricEditorFontSizeDisplay();
    }

    function bumpLyricEditorUserFont(delta) {
        const ta = $("lyric-editor-large");
        if (!ta) return;
        const next = clamp(readLyricEditorUserFontPx() + delta, 10, 32);
        writeLyricEditorUserFontPx(next);
        applyLyricEditorUserFont(next);
    }

    function syncLyricDrawerOverlayClass() {
        const d = $("editor-lyrics-drawer");
        if (!d) return;
        d.classList.toggle("editor-lyrics-drawer--overlay", !!d.open);
    }

    /** 点击编辑抽屉外部时收起（排除投屏监视等浮层） */
    function installLyricEditorDrawerOutsideClose() {
        if (installLyricEditorDrawerOutsideClose._bound) return;
        const drawer = $("editor-lyrics-drawer");
        if (!drawer) return;
        installLyricEditorDrawerOutsideClose._bound = true;
        document.addEventListener(
            "click",
            (e) => {
                if (!drawer.open) return;
                if (Date.now() < (installLyricEditorDrawerOutsideClose._suppressUntil || 0)) return;
                const t = e.target;
                if (!(t instanceof Element)) return;
                if (t.closest("#editor-lyrics-drawer")) return;
                if (t.closest("#projection-preview-monitor")) return;
                drawer.open = false;
            },
            false
        );
    }

    /** 顶边拖动调节高度（向上拉高）；展开时为浮层覆盖页面画廊 */
    function installLyricEditorDrawerResize() {
        const drawer = $("editor-lyrics-drawer");
        if (drawer && !installLyricEditorDrawerResize._toggleBound) {
            installLyricEditorDrawerResize._toggleBound = true;
            drawer.addEventListener("toggle", () => {
                syncLyricDrawerOverlayClass();
                if (drawer.open) scheduleFitLyricEditorFont();
            });
            installLyricEditorDrawerOutsideClose();
        }
        syncLyricDrawerOverlayClass();

        if (installLyricEditorDrawerResize._bound) return;
        const handle = $("editor-lyrics-drawer-height-handle");
        const ta = $("lyric-editor-large");
        if (!handle || !ta) return;
        installLyricEditorDrawerResize._bound = true;

        /* 顶边手柄上的 click 勿冒泡到 summary，否则会误触 <details> 收起 */
        handle.addEventListener("click", (e) => e.stopPropagation());

        const clampEditorHeight = (h) =>
            clamp(Math.round(Number(h) || 0), 120, Math.min(920, Math.floor(window.innerHeight * 0.92)));

        function applyLyricEditorHeight(px) {
            const h = clampEditorHeight(px);
            ta.style.height = h + "px";
            try {
                localStorage.setItem(LYRIC_EDITOR_HEIGHT_LS_KEY, String(h));
            } catch (_e) {
                /* ignore */
            }
            scheduleFitLyricEditorFont();
        }

        const saved = parseInt(localStorage.getItem(LYRIC_EDITOR_HEIGHT_LS_KEY), 10);
        if (Number.isFinite(saved)) applyLyricEditorHeight(saved);
        else applyLyricEditorHeight(280);

        let dragging = false;
        let resizeDragMoved = false;
        let startY = 0;
        let startH = 0;

        function onMove(e) {
            if (!dragging) return;
            if (Math.abs(e.clientY - startY) >= 2) resizeDragMoved = true;
            /* 顶边手柄：鼠标上移 → 高度增加（浮层向上盖住画廊） */
            applyLyricEditorHeight(startH + (startY - e.clientY));
        }
        function onUp() {
            if (!dragging) return;
            const didMove = resizeDragMoved;
            dragging = false;
            resizeDragMoved = false;
            document.removeEventListener("mousemove", onMove, true);
            document.removeEventListener("mouseup", onUp, true);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            /* 避免松手在画廊等区域时，紧随的 click 被当成「点外部」而误收起 */
            installLyricEditorDrawerOutsideClose._suppressUntil = Date.now() + 600;
            if (didMove) {
                const swallow = (e) => {
                    document.removeEventListener("click", swallow, true);
                    const h = $("editor-lyrics-drawer-height-handle");
                    if (h && e.target instanceof Element && (e.target === h || h.contains(e.target))) {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                    }
                };
                document.addEventListener("click", swallow, true);
            }
        }

        handle.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            dragging = true;
            resizeDragMoved = false;
            startY = e.clientY;
            startH = ta.getBoundingClientRect().height;
            document.body.style.cursor = "ns-resize";
            document.body.style.userSelect = "none";
            document.addEventListener("mousemove", onMove, true);
            document.addEventListener("mouseup", onUp, true);
        });

        window.addEventListener(
            "resize",
            () => {
                const h = ta.getBoundingClientRect().height;
                if (h > window.innerHeight * 0.92) applyLyricEditorHeight(window.innerHeight * 0.92);
                else scheduleFitLyricEditorFont();
            },
            { passive: true }
        );
    }

    function syncSongToEditor() {
        const song = currentSong();
        if (!song) return;
        if ($("song-title-input")) $("song-title-input").value = song.title || "";
        setLyricEditorValueProgrammatically(song.lyrics || "");
        if ($("song-key")) $("song-key").value = song.key || "";
        if ($("song-tempo")) $("song-tempo").value = song.tempo || "";
        if ($("song-notes")) $("song-notes").value = song.notes || "";
        if ($("song-tags")) $("song-tags").value = song.tags || "";
    }

    function syncEditorToSong() {
        /** 主领 / 投屏窗口无完整编辑区，勿把空 DOM 写回 state，否则扫码导入后一广播歌词即被清空 */
        if (isDisplay || isLeader) return;
        const song = currentSong();
        if (!song) return;
        song.title = ($("song-title-input")?.value || "").trim() || "未命名";
        song.lyrics = $("lyric-editor-large")?.value || "";
        song.key = ($("song-key")?.value || "").trim();
        song.tempo = ($("song-tempo")?.value || "").trim();
        song.notes = ($("song-notes")?.value || "").trim();
        song.tags = ($("song-tags")?.value || "").trim();
        song.overlayOpacityPct = clamp(Number(state.ui.overlayOpacityPct), 0, 80);
        song.fontOpacityPct = clamp(Number(state.ui.fontOpacityPct), 20, 100);
    }

    /** 分页用歌词：取编辑器与曲库中较长的一段，避免一侧瞬时空串或未写回时 pages 塌成 1 页、#card-container 被重绘成一张卡 */
    function getLyricsSourceStringForPaging() {
        const ed = $("lyric-editor-large");
        const fromEditor = ed ? String(ed.value ?? "") : "";
        const song = currentSong();
        const fromSong = song ? String(song.lyrics ?? "") : "";
        if (fromEditor.length >= fromSong.length) return fromEditor;
        return fromSong.length ? fromSong : fromEditor;
    }

    /**
     * 与 updateAll 内 merge 逻辑一致（不执行 syncEditorToSong）：用于 changePage / jumpToPage / 画廊，
     * 避免「此处算出来 2 页、updateAll 里 4 页」→ 误判已在末页而切播放列表或 clamp 回前几页。
     */
    function getStablePagingLyricsForPageSplit() {
        const preLyrics = getLyricsSourceStringForPaging();
        const ed = String($("lyric-editor-large")?.value ?? "");
        return mergeLyricsPagingSnapshot(preLyrics, ed);
    }

    function mergeLyricsPagingSnapshot(pre, post) {
        const x = String(pre ?? "");
        const y = String(post ?? "");
        return x.length >= y.length ? x : y;
    }

    /** 仅在 updateAll 周期内置入：sync 前后取较长串，防止 sync 用空 textarea 覆盖 song.lyrics 后分页只剩 1 页 */
    let _lyricsPagingSplitOverride = null;
    function lyricsForPaginationSplit() {
        return _lyricsPagingSplitOverride != null ? _lyricsPagingSplitOverride : getLyricsSourceStringForPaging();
    }

    /** 投屏预览卡片固定高度 200px，上下各 10px 内边距 → 可用内容高度 180px；字号随全局歌词字号比例缩放 */
    const SPEAKER_CARD_INNER_HEIGHT_PX = 180;

    function speakerPreviewCardFontPx(lineCount) {
        const n = Math.max(1, Math.floor(Number(lineCount)) || 1);
        const inner =
            typeof window !== "undefined" &&
            window.matchMedia &&
            window.matchMedia("(max-width: 768px)").matches
                ? 130
                : SPEAKER_CARD_INNER_HEIGHT_PX;
        const base = Math.min(20, Math.max(10, (inner - n * 8) / n));
        const scale = clampLyricFontSize(state.ui.fontSize) / 56;
        return Math.min(52, Math.max(8, base * scale));
    }

    /**
     * 「我的背景」里视频素材的封面图（若有），供页面画廊非当前诗歌等仍显示该视频的视觉而非通用占位。
     */
    function getUploadedVideoCoverByImageId(bgImageId) {
        const id = String(bgImageId || "").trim();
        if (!id) return "";
        const items = getUploadedBackgrounds();
        const it = items.find((x) => x && x.id === id);
        return String(it?.coverImage || "").trim();
    }

    /** 画廊占位：无 bgImageId 时按 data URL 在「我的背景」里反查封面 */
    function resolveGalleryVideoCoverForSlice(slice) {
        if (!slice || slice.bgMediaType !== "video") return "";
        let c = getUploadedVideoCoverByImageId(slice.bgImageId);
        if (c) return c;
        const blob = String(slice.bgImage || "").trim();
        if (!blob) return "";
        const items = getUploadedBackgrounds();
        const it = items.find((x) => x && isUploadedItemVideo(x) && String(x.imageData || "") === blob);
        return String(it?.coverImage || "").trim();
    }

    /**
     * @param {{ galleryThumb?: boolean; song?: object }} [opts]
     * 画廊里视频背景：各首诗歌的分页卡均使用真实 video 元素播放（与投屏监视一致）；不再对非当前诗歌降级为静帧封面，避免「像一张图」的观感。
     * 传入 opts.song 时按该诗歌独立背景渲染；否则按当前诗歌（与中间预览一致）。
     */
    function applyCardBackgroundFromSlice(card, slice, opts) {
        const galleryThumb = !!(opts && opts.galleryThumb);
        card.querySelector(".card-video-bg")?.remove();
        card.querySelector(".gallery-video-stub")?.remove();
        card.querySelector(".gallery-card-css-dyn-bg")?.remove();
        clearCssDynamicBgClass(card);
        card.style.background = "#000";
        card.style.backgroundImage = "none";
        const bt = slice.bgType;
        if (CSS_DYNAMIC_BG_TYPES.has(bt)) {
            card.style.background = "";
            const fill = document.createElement("div");
            fill.className = `gallery-card-css-dyn-bg projection-css-bg-fill css-bg-${bt}`;
            fill.setAttribute("aria-hidden", "true");
            fill.style.cssText =
                "position:absolute;inset:0;z-index:0;border-radius:inherit;pointer-events:none;box-sizing:border-box;";
            card.insertBefore(fill, card.firstChild);
            return;
        }
        if (bt === "solid-white") {
            card.style.background = "#fff";
        } else if (bt === "solid-gray") {
            card.style.background = "#444";
        } else if (bt === "gradient") {
            card.style.background = "linear-gradient(135deg,#1a2f59,#0a0f1d)";
        } else if (bt === "image" && slice.bgImage) {
            if (slice.bgMediaType === "video") {
                card.style.position = "relative";
                card.style.overflow = "hidden";
                card.style.backgroundImage = "none";
                if (galleryThumb) {
                    const coverUrl = resolveGalleryVideoCoverForSlice(slice);
                    if (coverUrl) {
                        card.style.position = "relative";
                        card.style.overflow = "hidden";
                        card.style.background = "#0a0a12";
                        card.style.backgroundImage = `url("${coverUrl.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
                        card.style.backgroundSize = "cover";
                        card.style.backgroundPosition = "center";
                        return;
                    }
                    card.style.background =
                        "linear-gradient(165deg,#1a0d18 0%,#2a1530 38%,#0f1a2e 72%,#120808 100%)";
                    const stub = document.createElement("div");
                    stub.className = "gallery-video-stub";
                    stub.setAttribute("aria-hidden", "true");
                    stub.style.cssText =
                        "position:absolute;inset:0;pointer-events:none;z-index:0;" +
                        "background:radial-gradient(ellipse 85% 55% at 50% 42%,rgba(255,130,70,0.22) 0%,transparent 58%)," +
                        "linear-gradient(180deg,rgba(0,0,0,0.15) 0%,rgba(0,0,0,0.5) 100%);";
                    card.insertBefore(stub, card.firstChild);
                    return;
                }
                card.style.background = "#000";
                const v = document.createElement("video");
                v.className = "card-video-bg";
                v.src = slice.bgImage;
                v.muted = true;
                v.loop = true;
                v.playsInline = true;
                v.setAttribute("playsinline", "");
                v.setAttribute("autoplay", "");
                v.style.cssText =
                    "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center;z-index:0;pointer-events:none;";
                card.insertBefore(v, card.firstChild);
                void v.play().catch(() => {});
            } else {
                card.style.backgroundImage = `url("${slice.bgImage}")`;
                card.style.backgroundSize = "cover";
                card.style.backgroundPosition = "center";
            }
        }
    }

    function applyCardBackground(card, opts) {
        const song = opts && opts.song;
        const slice = song ? effectiveSongBackground(song) : effectiveSongBackground(currentSong());
        applyCardBackgroundFromSlice(card, slice, opts || {});
    }

    /** 投屏预览 #card-container：翻页后将当前页卡片水平滚入可视区。
     * 禁止使用 scrollIntoView：会连带滚动 #editor-area，把上方的页面画廊滚出视口。 */
    function scrollSpeakerPreviewCardIntoView() {
        const container = $("card-container");
        if (!container) return;
        const cards = container.querySelectorAll(".card");
        if (!cards.length) return;
        const idx = clamp(state.currentPage, 0, cards.length - 1);
        const card = cards[idx];
        if (!card) return;
        const maxL = Math.max(0, container.scrollWidth - container.clientWidth);
        const margin = 10;
        const viewL = container.scrollLeft;
        const viewR = viewL + container.clientWidth;
        const cRect = card.getBoundingClientRect();
        const boxRect = container.getBoundingClientRect();
        const cardL = viewL + (cRect.left - boxRect.left);
        const cardR = cardL + cRect.width;
        let target = viewL;
        if (cardR > viewR - margin) target = cardR - container.clientWidth + margin;
        else if (cardL < viewL + margin) target = cardL - margin;
        container.scrollTo({ left: clamp(target, 0, maxL), behavior: "smooth" });
    }

    function updateSpeakerCards(options = {}) {
        const container = $("card-container");
        if (!container) {
            const song = currentSong();
            const pages = song ? splitPages(lyricsForPaginationSplit(), state.ui.defaultLines) : [];
            syncPageIndicatorFromState(pages.length);
            renderAllPagesThumbnails(pages);
            renderPageGallery();
            return;
        }
        const song = currentSong();
        const pages = splitPages(lyricsForPaginationSplit(), state.ui.defaultLines);
        state.currentPage = clamp(state.currentPage, 0, pages.length - 1);

        if (options.linesOnly && isMainVideoBackground()) {
            const cards = container.querySelectorAll(".card");
            if (cards.length === pages.length && pages.length > 0) {
                let lineCountsMatch = true;
                cards.forEach((card, idx) => {
                    const pl = pages[idx] || [];
                    const rows = card.querySelectorAll(".card-line");
                    if (rows.length !== pl.length) lineCountsMatch = false;
                });
                if (lineCountsMatch) {
                    cards.forEach((card, idx) => {
                        card.classList.toggle("active", idx === state.currentPage);
                        const pl = pages[idx] || [];
                        const rows = card.querySelectorAll(".card-line");
                        rows.forEach((row, i) => {
                            populateLyricRowElement(row, pl[i] || "", {
                                fontFamily: state.ui.fontFamily,
                                fontColor: state.ui.fontColor,
                                fontOpacityPct: state.ui.fontOpacityPct,
                                textStrokePx: state.ui.textStrokePx,
                                lightBg: state.ui.bgType === "solid-white"
                            });
                        });
                    });
                    syncPageIndicatorFromState(pages.length);
                    renderAllPagesThumbnails(pages);
                    renderPageGallery();
                    requestAnimationFrame(() => {
                        requestAnimationFrame(scrollSpeakerPreviewCardIntoView);
                    });
                    return;
                }
            }
        }

        container.innerHTML = "";

        let dragLineIndex = -1;

        const commitPageLineReorder = (fromIndex, toIndex) => {
            if (!song || fromIndex === toIndex) return;
            const pageIndex = clamp(state.currentPage, 0, Math.max(0, pages.length - 1));
            const pageLines = Array.isArray(pages[pageIndex]) ? [...pages[pageIndex]] : [];
            if (!pageLines.length) return;
            if (fromIndex < 0 || toIndex < 0 || fromIndex >= pageLines.length || toIndex >= pageLines.length) return;
            const [moved] = pageLines.splice(fromIndex, 1);
            pageLines.splice(toIndex, 0, moved);
            pages[pageIndex] = pageLines;
            song.lyrics = pages.map((p) => (p || []).join("\n")).join("\n\n");
            saveSongs();
            updateAll({ linesOnly: isMainVideoBackground() });
        };

        pages.forEach((lines, idx) => {
            const card = document.createElement("div");
            card.className = "card" + (idx === state.currentPage ? " active" : "");
            applyCardBackground(card);
            card.style.boxSizing = "border-box";
            card.style.padding = "10px 20px";
            card.style.position = "relative";
            card.style.overflow = "hidden";
            const vig = document.createElement("div");
            vig.className = "card-vignette-radial";
            vig.style.cssText =
                "position:absolute;inset:0;pointer-events:none;z-index:1;border-radius:inherit;";
            card.appendChild(vig);
            applyRadialVignetteToLayer(vig, state.ui);
            const cardFontPx = speakerPreviewCardFontPx(lines.length);
            lines.forEach((line, lineIndex) => {
                const row = document.createElement("div");
                row.className = "card-line";
                row.draggable = true;
                row.style.fontSize = `${cardFontPx}px`;
                row.style.lineHeight = "1.5";
                row.style.position = "relative";
                row.style.zIndex = "2";
                populateLyricRowElement(row, line, {
                    fontFamily: state.ui.fontFamily,
                    fontColor: state.ui.fontColor,
                    fontOpacityPct: state.ui.fontOpacityPct,
                    textStrokePx: state.ui.textStrokePx,
                    lightBg: state.ui.bgType === "solid-white"
                });
                row.addEventListener("dragstart", (e) => {
                    if (idx !== state.currentPage) return;
                    dragLineIndex = lineIndex;
                    if (e.dataTransfer) {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", String(lineIndex));
                    }
                });
                row.addEventListener("dragover", (e) => {
                    if (idx !== state.currentPage) return;
                    e.preventDefault();
                    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                });
                row.addEventListener("drop", (e) => {
                    if (idx !== state.currentPage) return;
                    e.preventDefault();
                    const from = dragLineIndex;
                    const to = lineIndex;
                    dragLineIndex = -1;
                    commitPageLineReorder(from, to);
                });
                row.addEventListener("dragend", () => {
                    dragLineIndex = -1;
                });
                card.appendChild(row);
            });
            card.addEventListener("click", () => {
                state.currentPage = idx;
                updateAll({ linesOnly: isMainVideoBackground() });
            });
            container.appendChild(card);
        });

        syncPageIndicatorFromState(pages.length);
        renderAllPagesThumbnails(pages);
        requestAnimationFrame(() => {
            requestAnimationFrame(scrollSpeakerPreviewCardIntoView);
        });
        renderPageGallery();
    }

    function getPlaylistSongIdsOrderedForGallery() {
        const plItems = Array.isArray(state.playlist?.items) ? state.playlist.items : [];
        let songIdsOrdered =
            plItems.length > 0
                ? plItems.filter((sid) => state.songs.some((s) => String(s.id) === String(sid)))
                : [];
        if (!songIdsOrdered.length && state.currentSongId) {
            songIdsOrdered = [state.currentSongId];
        }
        return songIdsOrdered;
    }

    /** 多首连播时：每首分区右侧页码；单首时隐藏分区页码、使用工具栏全局页码 */
    function refreshGallerySectionPageIndicators() {
        const gal = $("layout-page-gallery");
        const songIdsOrdered = getPlaylistSongIdsOrderedForGallery();
        const multi = songIdsOrdered.length > 1;
        const curSid = String(state.currentSongId || "");

        if (!gal || !multi || !gal.classList.contains("layout-page-gallery--multi-strip")) {
            return;
        }

        gal.querySelectorAll(":scope > .gallery-song-section").forEach((sec) => {
            const sid = sec.getAttribute("data-song-id");
            if (!sid) return;
            const meta = sec.querySelector(".gallery-song-section-page-meta");
            if (!meta) return;
            const plSong = state.songs.find((s) => String(s.id) === String(sid));
            if (!plSong) return;
            const isCurrent = String(sid) === curSid;
            const lyricsSrc = isCurrent ? getStablePagingLyricsForPageSplit() : String(plSong.lyrics ?? "");
            const pages = splitPages(lyricsSrc, state.ui.defaultLines);
            const pn = Math.max(1, pages.length);
            const cp = isCurrent ? clamp(state.currentPage, 0, Math.max(0, pages.length - 1)) : 0;

            const wrapI = meta.querySelector('[data-gallery-page-mode="interactive"]');
            const wrapS = meta.querySelector('[data-gallery-page-mode="static"]');
            if (wrapI) {
                wrapI.hidden = !isCurrent;
                const inp = wrapI.querySelector(".gallery-section-page-input");
                const tot = wrapI.querySelector(".page-indicator-total");
                if (tot) tot.textContent = `/${pn}`;
                if (inp) {
                    inp.setAttribute("max", String(pn));
                    inp.setAttribute("min", "1");
                    inp.value = String(clamp(cp + 1, 1, pn));
                }
            }
            if (wrapS) {
                wrapS.hidden = isCurrent;
                const sum = wrapS.querySelector(".gallery-section-page-summary");
                if (sum) sum.textContent = `共 ${pn} 页`;
            }
        });
    }

    function syncPageIndicatorFromState(pageCount) {
        const n = Math.max(1, Number(pageCount) || 1);
        const songIdsOrdered = getPlaylistSongIdsOrderedForGallery();
        const multi = songIdsOrdered.length > 1;
        const globalMeta = document.querySelector(".speaker-view-page-meta");
        if (globalMeta) globalMeta.hidden = !!multi;
        const inp = $("page-indicator-input");
        const total = $("page-indicator-total");
        if (inp && total && !multi) {
            total.textContent = `/${n}`;
            inp.setAttribute("max", String(n));
            inp.setAttribute("min", "1");
            inp.value = String(clamp(state.currentPage + 1, 1, n));
        }
    }

    function renderAllPagesThumbnails(pages) {
        const root = $("all-pages-thumbs");
        if (!root) return;
        const list = Array.isArray(pages) ? pages : [];
        root.innerHTML = "";
        if (!list.length) return;
        list.forEach((lines, idx) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "all-pages-thumb" + (idx === state.currentPage ? " is-active" : "");
            btn.setAttribute("role", "listitem");
            const preview = (lines || []).map((x) => String(x || "").trim()).filter(Boolean).join(" ") || "…";
            btn.innerHTML =
                `<span class="all-pages-thumb-index">第 ${idx + 1} 页</span>` +
                `<span class="all-pages-thumb-preview">${escapeHtml(preview.slice(0, 120))}</span>`;
            btn.addEventListener("click", () => {
                state.currentPage = idx;
                updateAll({ linesOnly: isMainVideoBackground() });
            });
            root.appendChild(btn);
        });
    }

    function scrollGalleryActiveIntoView(gal) {
        if (!gal || !gal.isConnected) return;
        requestAnimationFrame(() => {
            const active = gal.querySelector(".gallery-page-card.is-active");
            if (!active || !gal.isConnected) return;
            try {
                active.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
            } catch (_e) {
                active.scrollIntoView(false);
            }
        });
    }

    /** 与 LIVE 快照对齐的转场参数，使画廊动效与投屏监视 / 会众投屏一致 */
    function galleryPageTransitionSource() {
        const curSid = String(state.currentSongId || "");
        const ls = liveState && liveState.pages && String(liveState.songId || "") === curSid ? liveState : null;
        const trans = canonicalPageTransition(ls ? ls.pageTransition : state.ui.pageTransition);
        const dur = clamp(Number(ls != null ? ls.pageTransitionSpeed : state.ui.pageTransitionSpeed), 0.3, 1.5);
        const fontOpacityPct = ls != null && ls.fontOpacityPct != null ? ls.fontOpacityPct : state.ui.fontOpacityPct;
        return { trans, dur, fontOpacityPct };
    }

    function appendGalleryLinesToLyricAnim(lyricAnim, lineList, plSong) {
        if (!lyricAnim || !plSong) return;
        lyricAnim.replaceChildren();
        lineList.forEach((l) => {
            const row = document.createElement("div");
            row.className = "gallery-card-line";
            row.style.position = "relative";
            row.style.zIndex = "2";
            populateLyricRowElement(row, l, {
                fontFamily: state.ui.fontFamily,
                fontColor: state.ui.fontColor,
                fontOpacityPct: state.ui.fontOpacityPct,
                textStrokePx: state.ui.textStrokePx,
                fontWeight: state.ui.fontWeight,
                lightBg: effectiveSongBackground(plSong).bgType === "solid-white"
            });
            lyricAnim.appendChild(row);
        });
    }

    /** 页面画廊：翻页/点击后当前卡片轻量动效（键盘与鼠标共用） */
    function runGalleryCardSwitchAnimation(gal) {
        if (!gal || !gal.isConnected) return;
        gal.querySelectorAll(".gallery-page-card.gallery-card-switch-pulse").forEach((el) => {
            el.classList.remove("gallery-card-switch-pulse");
        });
        const active = gal.querySelector(".gallery-page-card.is-active");
        if (!active) return;
        active.classList.remove("gallery-card-switch-pulse");
        void active.offsetWidth;
        active.classList.add("gallery-card-switch-pulse");
        active.addEventListener(
            "animationend",
            (ev) => {
                if (ev.target !== active || ev.animationName !== "galleryCardSwitchPulse") return;
                active.classList.remove("gallery-card-switch-pulse");
            },
            { once: true }
        );
    }

    function scheduleGalleryCardSwitchAnimation() {
        if (scheduleGalleryCardSwitchAnimation._raf) {
            cancelAnimationFrame(scheduleGalleryCardSwitchAnimation._raf);
        }
        scheduleGalleryCardSwitchAnimation._raf = requestAnimationFrame(() => {
            scheduleGalleryCardSwitchAnimation._raf = 0;
            const gal = $("layout-page-gallery");
            runGalleryCardSwitchAnimation(gal);
            runGalleryActiveLyricEnterOnly(gal);
        });
    }

    /** 全量重建画廊时：当前页歌词入场（增量补丁中已做离场→换词→入场时置 galLyricSkipScheduleEnter，此处跳过以免双重入场） */
    function runGalleryActiveLyricEnterOnly(gal) {
        if (!gal || !gal.isConnected) return;
        if (gal.dataset.galLyricSkipScheduleEnter === "1") {
            delete gal.dataset.galLyricSkipScheduleEnter;
            return;
        }
        const prevP = gal.dataset.galLyricLastPage;
        const prevS = gal.dataset.galLyricLastSongId;
        const curSid = String(state.currentSongId || "");
        const idx = state.currentPage;
        const src = galleryPageTransitionSource();
        const trans = src.trans;
        const dur = src.dur;
        const shouldAnim =
            !projectionDisplayIsVideoBackground() &&
            prevP !== undefined &&
            trans !== "none" &&
            (String(prevP) !== String(idx) || String(prevS || "") !== curSid);
        if (shouldAnim) {
            const active = gal.querySelector(".gallery-page-card.is-active .gallery-card-lyric-anim");
            if (active) runMiniPageTransitionEnter(active, trans, dur, src.fontOpacityPct, "translateY(-50%)");
        }
        gal.dataset.galLyricLastPage = String(idx);
        gal.dataset.galLyricLastSongId = curSid;
    }

    /** 页面画廊结构签名与增量补丁用：区分不同上传 id 或不同 data URL（仅取前 120 字时多段 mp4 的 base64 前缀极易相同，会导致误判「结构未变」而不重建/不换 <video> src） */
    function pageGalleryBackgroundIdentityKey(eff) {
        if (!eff) return "none";
        const id = String(eff.bgImageId || "").trim();
        const s = String(eff.bgImage || "").trim();
        const t = String(eff.bgType || "");
        const m = eff.bgMediaType === "video" ? "video" : "image";
        if (id) {
            if (m === "video") {
                const cov = getUploadedVideoCoverByImageId(id);
                const cv = cov ? `cv:${cov.length}:${cov.slice(0, 28)}` : "cv:0";
                return `${t}|${m}|id:${id}|${cv}`;
            }
            return `${t}|${m}|id:${id}`;
        }
        if (!s) return `${t}|${m}|empty`;
        const len = s.length;
        if (m === "video") {
            const cov = resolveGalleryVideoCoverForSlice({
                bgType: t,
                bgImage: s,
                bgImageId: id,
                bgMediaType: "video"
            });
            const cv = cov ? `cv:${cov.length}:${cov.slice(0, 28)}` : "cv:0";
            return `${t}|${m}|len${len}|head:${s.slice(0, 96)}|tail:${s.slice(-96)}|${cv}`;
        }
        return `${t}|${m}|len${len}|head:${s.slice(0, 96)}|tail:${s.slice(-96)}`;
    }

    function computePageGalleryStructureSig(songIdsOrdered) {
        const parts = [];
        parts.push(songIdsOrdered.join(","));
        parts.push(String(state.ui.defaultLines));
        parts.push(String(state.ui.vignetteShape || ""));
        parts.push(String(state.ui.vignetteCenterBrightness ?? ""));
        parts.push(String(state.ui.vignetteEdgeDarkness ?? ""));
        const curSid = String(state.currentSongId || "");
        songIdsOrdered.forEach((sid) => {
            const plSong = state.songs.find((s) => String(s.id) === String(sid));
            if (!plSong) {
                parts.push("x:0");
                return;
            }
            const isCurrent = String(sid) === curSid;
            const lyricsSrc = isCurrent ? getStablePagingLyricsForPageSplit() : String(plSong.lyrics ?? "");
            const pages = splitPages(lyricsSrc, state.ui.defaultLines);
            const eff = effectiveSongBackground(plSong);
            parts.push(`${sid}:${pages.length}:${pageGalleryBackgroundIdentityKey(eff)}`);
        });
        return parts.join("\x1e");
    }

    /** 结构未变时只改高亮与歌词，保留 video 节点，避免翻页黑闪 */
    function tryPatchPageGalleryInPlace(gal, songIdsOrdered) {
        const sections = gal.querySelectorAll(":scope > .gallery-song-section");
        if (sections.length !== songIdsOrdered.length) return false;
        flushGalleryLyricTrans();
        const gsrc = galleryPageTransitionSource();
        const prevGalP = gal.dataset.galLyricLastPage;
        const prevGalS = gal.dataset.galLyricLastSongId;
        const idxNav = state.currentPage;
        const curSid = String(state.currentSongId || "");
        const needGalLyricTrans =
            !projectionDisplayIsVideoBackground() &&
            prevGalP !== undefined &&
            gsrc.trans !== "none" &&
            (String(prevGalP) !== String(idxNav) || String(prevGalS || "") !== curSid);

        for (let si = 0; si < songIdsOrdered.length; si++) {
            const sid = String(songIdsOrdered[si]);
            const sec = sections[si];
            if (sec.getAttribute("data-song-id") !== sid) return false;
            const plSong = state.songs.find((s) => String(s.id) === String(sid));
            if (!plSong) return false;
            if (!sec.querySelector(".gallery-song-section-page-meta")) return false;
            if (!sec.querySelector(":scope > .layout-page-gallery-pages-scale-shell")) return false;

            const headTitle = sec.querySelector(".gallery-song-section-title");
            if (headTitle) headTitle.textContent = plSong.title || "未命名";

            const isCurrent = sid === curSid;
            const pageMetaEl = sec.querySelector(".gallery-song-section-page-meta");
            if (pageMetaEl) {
                const wrapI = pageMetaEl.querySelector('[data-gallery-page-mode="interactive"]');
                const wrapS = pageMetaEl.querySelector('[data-gallery-page-mode="static"]');
                if (wrapI) wrapI.hidden = !isCurrent;
                if (wrapS) wrapS.hidden = isCurrent;
            }
            const lyricsSrc = isCurrent ? getStablePagingLyricsForPageSplit() : String(plSong.lyrics ?? "");
            const pages = splitPages(lyricsSrc, state.ui.defaultLines);
            const cp = isCurrent ? clamp(state.currentPage, 0, Math.max(0, pages.length - 1)) : -1;

            const effStrip = effectiveSongBackground(plSong);
            const galleryLiveVideoBgThis =
                effStrip.bgType === "image" && effStrip.bgMediaType === "video" && !!effStrip.bgImage;
            const wantBgSig = pageGalleryBackgroundIdentityKey(effStrip);

            const zoomShell = sec.querySelector(":scope > .layout-page-gallery-pages-scale-shell");
            const scrollRow = zoomShell
                ? zoomShell.querySelector(":scope > .layout-page-gallery-pages")
                : sec.querySelector(":scope > .layout-page-gallery-pages");
            if (!scrollRow) return false;
            const cards = scrollRow.querySelectorAll(":scope > .gallery-page-card[data-gallery-card]");
            if (cards.length !== pages.length) return false;

            for (let pi = 0; pi < pages.length; pi++) {
                const card = cards[pi];
                if (card.getAttribute("data-song-id") !== sid || card.getAttribute("data-page-idx") !== String(pi))
                    return false;
                const act = isCurrent && pi === cp;
                card.className = "gallery-page-card" + (act ? " is-active" : "");
                const borderCol = act ? "#d4af37" : "rgba(255,255,255,0.12)";
                card.style.border = "2px solid " + borderCol;
                card.style.boxShadow = act
                    ? "0 0 0 1px rgba(212,175,55,0.35), 0 8px 28px rgba(0,0,0,0.35)"
                    : "";

                const vig = card.querySelector(".card-vignette-radial");
                if (vig) applyRadialVignetteToLayer(vig, state.ui);

                let lyricAnim = card.querySelector(":scope > .gallery-card-lyric-anim");
                if (!lyricAnim) {
                    lyricAnim = document.createElement("div");
                    lyricAnim.className = "gallery-card-lyric-anim";
                    lyricAnim.style.cssText =
                        "position:relative;z-index:2;width:100%;transform-origin:center center;display:flex;flex-direction:column;align-items:center;";
                    if (vig && vig.nextSibling) card.insertBefore(lyricAnim, vig.nextSibling);
                    else card.appendChild(lyricAnim);
                }

                const lines = pages[pi] || [];
                let lineList = Array.isArray(lines)
                    ? lines.map((x) => String(x ?? "").trim()).filter((s) => s.length > 0)
                    : [];
                if (!lineList.length) lineList = ["…"];

                const prevBgSig = card.getAttribute("data-gallery-bg-sig") || "";
                if (prevBgSig !== wantBgSig) {
                    applyCardBackground(card, {
                        galleryThumb: !galleryLiveVideoBgThis,
                        song: plSong
                    });
                    card.setAttribute("data-gallery-bg-sig", wantBgSig);
                }

                const hasPriorLines = !!lyricAnim.querySelector(".gallery-card-line");
                if (act && needGalLyricTrans && hasPriorLines) {
                    runGalleryLyricExitThen(lyricAnim, gsrc.trans, gsrc.dur, () => {
                        appendGalleryLinesToLyricAnim(lyricAnim, lineList, plSong);
                        applyGalleryCardLyricVerticalLayout(card, lyricAnim, plSong);
                        runMiniPageTransitionEnter(lyricAnim, gsrc.trans, gsrc.dur, gsrc.fontOpacityPct, "translateY(-50%)");
                        gal.dataset.galLyricLastPage = String(idxNav);
                        gal.dataset.galLyricLastSongId = curSid;
                        gal.dataset.galLyricSkipScheduleEnter = "1";
                        requestAnimationFrame(() => relayoutGalleryLyricVerticalPads());
                    });
                } else {
                    card.querySelectorAll(".gallery-card-line").forEach((n) => n.remove());
                    appendGalleryLinesToLyricAnim(lyricAnim, lineList, plSong);
                    applyGalleryCardLyricVerticalLayout(card, lyricAnim, plSong);
                }
            }
        }
        refreshGallerySectionPageIndicators();
        requestAnimationFrame(() => relayoutGalleryLyricVerticalPads());
        return true;
    }

    function noteProjectionDisplayAlive() {
        projectionDisplayAliveViaChannel = true;
        try {
            globalThis.__displayWindowOpened = true;
        } catch (_e) {
            /* ignore */
        }
        try {
            syncProjectionPanelControls();
            updateGalleryStatusBar();
        } catch (_e2) {
            /* ignore */
        }
    }

    function noteProjectionDisplayGone() {
        projectionDisplayAliveViaChannel = false;
        try {
            globalThis.__displayWindowOpened = false;
        } catch (_e) {
            /* ignore */
        }
    }

    function isProjectionDisplayWindowOpen() {
        let w = projectionDisplayWindowRef;
        if (w) {
            if (w.closed) {
                projectionDisplayWindowRef = null;
            } else {
                return true;
            }
        }
        return projectionDisplayAliveViaChannel;
    }

    function syncProjectionPanelControls() {
        const open = isProjectionDisplayWindowOpen();
        const panelClose = $("close-projection-panel-btn");
        const galleryClose = $("close-projection-display-btn");
        const displayBtn = $("open-display-btn");
        if (panelClose) panelClose.hidden = !open;
        if (galleryClose) galleryClose.hidden = !open;
        if (displayBtn) {
            displayBtn.classList.toggle("projection-action-card--live", open);
            const titleEl = displayBtn.querySelector(".projection-action-card__title");
            const hintEl = displayBtn.querySelector(".projection-action-card__hint");
            if (titleEl) titleEl.textContent = open ? "关闭投屏" : "开启投屏";
            if (hintEl) hintEl.textContent = "会众大屏";
        }
    }

    function onProjectionDisplayWindowClosed() {
        projectionDisplayWindowRef = null;
        noteProjectionDisplayGone();
        try {
            renderPageGallery();
        } catch (_e2) {
            /* ignore */
        }
        try {
            syncProjectionPanelControls();
            updateGalleryStatusBar();
        } catch (_e3) {
            /* ignore */
        }
        if (projectionCloseInitiatedByMain) {
            projectionCloseInitiatedByMain = false;
            hideRestoreProjectionBanner();
            return;
        }
        showRestoreProjectionBanner();
    }

    function watchProjectionDisplayWindowRef() {
        if (isDisplay || isLeader) return;
        let w = projectionDisplayWindowRef;
        if (!w) return;
        if (!w.closed) return;
        onProjectionDisplayWindowClosed();
    }

    function startProjectionDisplayWindowWatch() {
        if (projectionDisplayWindowPollTimer) return;
        projectionDisplayWindowPollTimer = window.setInterval(watchProjectionDisplayWindowRef, 500);
    }

    function updateGalleryStatusBar() {
        const bar = $("gallery-status-bar");
        const open = isProjectionDisplayWindowOpen();
        syncProjectionPanelControls();
        if (!open) {
            if (bar) bar.style.display = "none";
            return;
        }
        if (bar) bar.style.display = "flex";

        const songEl = $("gallery-status-song");
        const pageEl = $("gallery-status-page");
        if (!songEl || !pageEl) return;
        const plItems = Array.isArray(state.playlist?.items) ? state.playlist.items : [];
        if (!plItems.length) {
            songEl.textContent = "—";
            pageEl.textContent = "—";
            return;
        }
        const curId = state.currentSongId;
        const idx = plItems.findIndex((id) => String(id) === String(curId));
        const song = state.songs?.find((s) => String(s.id) === String(curId));
        if (idx < 0 || !song) {
            songEl.textContent = "—";
            pageEl.textContent = "—";
            return;
        }
        const ord = idx + 1;
        songEl.textContent = `第${ord}首 ${song.title || "未命名"}`;
        let linesSrc = "";
        try {
            linesSrc = getStablePagingLyricsForPageSplit();
        } catch (_e) {
            linesSrc = String(song.lyrics ?? "");
        }
        const pages = splitPages(linesSrc, state.ui.defaultLines);
        const total = Math.max(1, pages.length);
        const y = clamp(state.currentPage, 0, total - 1) + 1;
        pageEl.textContent = `第${y}/${total}页`;
    }

    function resetGalleryWrapperScroll() {
        const gal = $("layout-page-gallery");
        if (!gal) return;
        const wrap = gal.parentElement;
        if (!wrap) return;
        wrap.style.overflowX = "auto";
        wrap.style.maxWidth = "100%";
        wrap.scrollLeft = 0;
    }

    function renderPageGallery() {
        const gal = document.getElementById("layout-page-gallery");
        const finishGalleryChrome = () => {
            updateGalleryStatusBar();
            updateGalleryZoom();
            resetGalleryWrapperScroll();
        };

        if (!gal) {
            finishGalleryChrome();
            return;
        }
        if (!state.songs || !state.songs.length || !state.currentSongId) {
            gal.innerHTML = "";
            delete gal.dataset.galleryStructSig;
            const globalMeta = document.querySelector(".speaker-view-page-meta");
            if (globalMeta) globalMeta.hidden = false;
            finishGalleryChrome();
            return;
        }

        const songIdsOrdered = getPlaylistSongIdsOrderedForGallery();
        if (!songIdsOrdered.length) {
            gal.innerHTML = "";
            delete gal.dataset.galleryStructSig;
            const globalMeta = document.querySelector(".speaker-view-page-meta");
            if (globalMeta) globalMeta.hidden = false;
            finishGalleryChrome();
            return;
        }

        const newSig = computePageGalleryStructureSig(songIdsOrdered);
        if (
            gal.dataset.galleryStructSig === newSig &&
            gal.querySelector(".gallery-page-card") &&
            tryPatchPageGalleryInPlace(gal, songIdsOrdered)
        ) {
            scrollGalleryActiveIntoView(gal);
            scheduleGalleryCardSwitchAnimation();
            refreshGallerySectionPageIndicators();
            ensureGalleryLayoutResizeObserver();
            requestAnimationFrame(() => relayoutGalleryLyricVerticalPads());
            finishGalleryChrome();
            return;
        }

        gal.innerHTML = "";
        gal.classList.add("layout-page-gallery--hero");
        gal.classList.toggle("layout-page-gallery--multi-strip", songIdsOrdered.length > 1);

        songIdsOrdered.forEach((sid, songOrd) => {
            const plSong = state.songs.find((s) => String(s.id) === String(sid));
            if (!plSong) return;

            const section = document.createElement("section");
            section.className = "gallery-song-section";
            section.setAttribute("data-song-id", String(sid));

            const head = document.createElement("header");
            head.className = "gallery-song-section-head";
            const headMain = document.createElement("div");
            headMain.className = "gallery-song-section-head-main";
            const idxLabel = document.createElement("span");
            idxLabel.className = "gallery-song-section-index";
            idxLabel.textContent = `第 ${songOrd + 1} 首`;
            const titleEl = document.createElement("span");
            titleEl.className = "gallery-song-section-title";
            titleEl.textContent = plSong.title || "未命名";
            headMain.appendChild(idxLabel);
            headMain.appendChild(titleEl);
            head.appendChild(headMain);

            const isCurrent = String(sid) === String(state.currentSongId);
            const lyricsSrc = isCurrent ? getStablePagingLyricsForPageSplit() : String(plSong.lyrics ?? "");
            const pages = splitPages(lyricsSrc, state.ui.defaultLines);
            const cp = clamp(state.currentPage, 0, Math.max(0, pages.length - 1));

            const pageMeta = document.createElement("div");
            pageMeta.className = "gallery-song-section-page-meta";
            const wrapInteractive = document.createElement("span");
            wrapInteractive.className = "page-indicator-wrap";
            wrapInteractive.setAttribute("data-gallery-page-mode", "interactive");
            wrapInteractive.title = "输入页码后按回车跳转";
            wrapInteractive.hidden = !isCurrent;
            const inpPg = document.createElement("input");
            inpPg.type = "text";
            inpPg.inputMode = "numeric";
            inpPg.pattern = "[0-9]*";
            inpPg.className = "page-indicator-input gallery-section-page-input";
            inpPg.setAttribute("aria-label", `「${plSong.title || "诗歌"}」当前页码`);
            const totI = document.createElement("span");
            totI.className = "page-indicator-total";
            totI.textContent = `/${Math.max(1, pages.length)}`;
            wrapInteractive.appendChild(inpPg);
            wrapInteractive.appendChild(totI);

            const wrapStatic = document.createElement("span");
            wrapStatic.className = "page-indicator-wrap gallery-section-page-wrap-static";
            wrapStatic.setAttribute("data-gallery-page-mode", "static");
            wrapStatic.title = "当前未选中本首；翻页请先在上方卡片选中本首诗歌";
            wrapStatic.hidden = isCurrent;
            const sumSpan = document.createElement("span");
            sumSpan.className = "gallery-section-page-summary";
            sumSpan.textContent = `共 ${Math.max(1, pages.length)} 页`;
            wrapStatic.appendChild(sumSpan);

            pageMeta.appendChild(wrapInteractive);
            pageMeta.appendChild(wrapStatic);
            head.appendChild(pageMeta);
            section.appendChild(head);

            const zoomShell = document.createElement("div");
            zoomShell.className = "layout-page-gallery-pages-scale-shell";

            const scrollRow = document.createElement("div");
            scrollRow.className = "layout-page-gallery-pages";
            scrollRow.setAttribute("role", "list");
            scrollRow.setAttribute("aria-label", `${plSong.title || "诗歌"} 分页`);
            const effStrip = effectiveSongBackground(plSong);
            const galleryLiveVideoBgThis =
                effStrip.bgType === "image" && effStrip.bgMediaType === "video" && !!effStrip.bgImage;

            pages.forEach((lines, pi) => {
                const act = isCurrent && pi === cp;
                const card = document.createElement("div");
                card.setAttribute("data-gallery-card", "1");
                card.setAttribute("data-song-id", String(sid));
                card.setAttribute("data-page-idx", String(pi));
                card.className = "gallery-page-card" + (act ? " is-active" : "");
                card.setAttribute("role", "listitem");
                card.style.cssText =
                    "border-radius:16px;border:2px solid " +
                    (act ? "#d4af37" : "rgba(255,255,255,0.12)") +
                    ";padding:10px 12px;cursor:pointer;box-sizing:border-box;overflow:hidden;flex-shrink:0;transition:border-color 0.15s ease,box-shadow 0.15s ease;position:relative;";
                if (act) card.style.boxShadow = "0 0 0 1px rgba(212,175,55,0.35), 0 8px 28px rgba(0,0,0,0.35)";
                applyCardBackground(card, {
                    galleryThumb: !galleryLiveVideoBgThis,
                    song: plSong
                });
                card.setAttribute("data-gallery-bg-sig", pageGalleryBackgroundIdentityKey(effStrip));
                const vig = document.createElement("div");
                vig.className = "card-vignette-radial";
                vig.style.cssText =
                    "position:absolute;inset:0;pointer-events:none;z-index:1;border-radius:inherit;";
                card.appendChild(vig);
                applyRadialVignetteToLayer(vig, state.ui);
                const lyricAnim = document.createElement("div");
                lyricAnim.className = "gallery-card-lyric-anim";
                lyricAnim.style.cssText =
                    "position:relative;z-index:2;width:100%;transform-origin:center center;display:flex;flex-direction:column;align-items:center;";
                card.appendChild(lyricAnim);
                let lineList = Array.isArray(lines)
                    ? lines.map((x) => String(x ?? "").trim()).filter((s) => s.length > 0)
                    : [];
                if (!lineList.length) lineList = ["…"];
                lineList.forEach((l) => {
                    const row = document.createElement("div");
                    row.className = "gallery-card-line";
                    row.style.position = "relative";
                    row.style.zIndex = "2";
                    populateLyricRowElement(row, l, {
                        fontFamily: state.ui.fontFamily,
                        fontColor: state.ui.fontColor,
                        fontOpacityPct: state.ui.fontOpacityPct,
                        textStrokePx: state.ui.textStrokePx,
                        fontWeight: state.ui.fontWeight,
                        lightBg: effectiveSongBackground(plSong).bgType === "solid-white"
                    });
                    lyricAnim.appendChild(row);
                });
                applyGalleryCardLyricVerticalLayout(card, lyricAnim, plSong);
                card.addEventListener("click", () => {
                    if (String(sid) === String(state.currentSongId)) {
                        jumpToPage(pi);
                    } else {
                        switchSong(sid, { page: pi });
                        broadcastState();
                    }
                });
                scrollRow.appendChild(card);
            });

            zoomShell.appendChild(scrollRow);
            section.appendChild(zoomShell);
            gal.appendChild(section);
        });

        gal.dataset.galleryStructSig = newSig;
        scrollGalleryActiveIntoView(gal);
        scheduleGalleryCardSwitchAnimation();
        refreshGallerySectionPageIndicators();
        ensureGalleryLayoutResizeObserver();
        requestAnimationFrame(() => {
            relayoutGalleryLyricVerticalPads();
            requestAnimationFrame(() => relayoutGalleryLyricVerticalPads());
        });
        finishGalleryChrome();
    }
    window.renderPageGallery = renderPageGallery;

    function syncLibraryChrome() {
        const batchBar = $("song-batch-bar");
        if (batchBar) {
            batchBar.style.display = state.library.viewMode === "batch" ? "flex" : "none";
        }
        const allB = $("library-view-all");
        const catB = $("library-view-category");
        const batB = $("library-view-batch");
        if (allB) {
            allB.classList.toggle("is-active", state.library.viewMode === "all");
            allB.setAttribute("aria-selected", state.library.viewMode === "all" ? "true" : "false");
        }
        if (catB) {
            catB.classList.toggle("is-active", state.library.viewMode === "category");
            catB.setAttribute("aria-selected", state.library.viewMode === "category" ? "true" : "false");
        }
        if (batB) {
            batB.classList.toggle("is-active", state.library.viewMode === "batch");
            batB.setAttribute("aria-selected", state.library.viewMode === "batch" ? "true" : "false");
        }
    }

    function hideSongContextMenu() {
        const menu = $("song-context-menu");
        if (menu) menu.hidden = true;
        contextMenuSongId = "";
    }

    function showSongContextMenu(clientX, clientY, songId) {
        const menu = $("song-context-menu");
        if (!menu) return;
        contextMenuSongId = songId;
        menu.hidden = false;
        const pad = 8;
        const estW = 168;
        const estH = 108;
        const x = clamp(clientX, pad, window.innerWidth - estW - pad);
        const y = clamp(clientY, pad, window.innerHeight - estH - pad);
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
    }

    function duplicateSong(songId) {
        const song = state.songs.find((s) => s.id === songId);
        if (!song) return;
        const copy = {
            ...song,
            id: uid(),
            title: `${song.title || "未命名"} 副本`
        };
        const idx = state.songs.findIndex((s) => s.id === songId);
        state.songs.splice(Math.max(0, idx + 1), 0, copy);
        saveSongs();
        hideSongContextMenu();
        switchSong(copy.id);
        showToast("已复制诗歌", $("add-song-btn"));
    }

    function buildSongCategoryPanels(filteredSongsInOrder) {
        const map = new Map();
        const untagged = [];
        filteredSongsInOrder.forEach((song) => {
            const tags = String(song.tags || "")
                .split(/[,\s]+/)
                .map((t) => t.trim())
                .filter(Boolean);
            if (!tags.length) {
                untagged.push(song);
                return;
            }
            tags.forEach((tag) => {
                if (!map.has(tag)) map.set(tag, []);
                map.get(tag).push(song);
            });
        });
        const panels = [...map.entries()]
            .sort((a, b) => a[0].localeCompare(b[0], "zh"))
            .map(([label, songs]) => ({
                label,
                songs,
                count: songs.length
            }));
        if (untagged.length) {
            panels.push({
                label: "其他",
                songs: untagged,
                count: untagged.length
            });
        }
        return panels;
    }

    function appendSongLibraryRow(parent, song, keyLower, opts) {
        const showDragHandle = !!(opts && opts.showDragHandle);
        const variant = (opts && opts.variant) || "list";
        const showBatchCb = !!(opts && opts.showBatchCb);

        const row = document.createElement("div");
        row.className = "song-item" + (song.id === state.currentSongId ? " active" : "");
        row.classList.add(variant === "category" ? "song-item--category" : "song-item--list");
        row.dataset.songId = song.id;

        const pendingDelete = libraryPendingDeleteId === song.id;
        if (pendingDelete) row.classList.add("song-item--confirm-delete");

        const titleHtml = highlightSearchHtml(song.title || "未命名", keyLower);
        const pageCount = splitPages(song.lyrics, state.ui.defaultLines).length;
        const tagLine = String(song.tags || "").trim() || "—";
        const tagsHtml = highlightSearchHtml(tagLine, keyLower);

        const cbHtml = showBatchCb
            ? `<input type="checkbox" class="song-batch-cb" aria-label="选择" data-song-id="${song.id}" ${libraryBatchSelected.has(song.id) ? "checked" : ""}>`
            : "";

        const handleHtml = showDragHandle
            ? `<span class="song-drag-handle" draggable="true" title="拖拽排序">⋮⋮</span>`
            : `<span class="song-drag-spacer" aria-hidden="true"></span>`;

        const deleteBtnHtml = pendingDelete
            ? `<button type="button" class="song-delete-btn song-delete-btn--pending" data-song-id="${song.id}">确认删除？</button>`
            : `<button type="button" class="song-delete-btn" title="删除" data-song-id="${song.id}">✕</button>`;

        row.innerHTML = `${cbHtml}${handleHtml}
<div class="song-item-main">
  <div class="song-item-text">
    <div class="song-item-title">${titleHtml}</div>
    <div class="song-item-meta"><span class="song-item-tags">${tagsHtml}</span><span class="song-item-pages">${pageCount} 页</span></div>
  </div>
</div>
${deleteBtnHtml}
<button type="button" class="song-add-btn" title="加入播放列表" data-song-id="${song.id}">+</button>`;

        const openSong = () => {
            switchSong(song.id);
        };

        row.addEventListener("click", (e) => {
            if (e.target.closest(".song-delete-btn") || e.target.closest(".song-add-btn") || e.target.closest(".song-batch-cb")) {
                return;
            }
            if (e.target.closest(".song-drag-handle")) return;

            if (libraryPendingDeleteId === song.id) {
                e.stopPropagation();
                libraryPendingDeleteId = "";
                deleteSong(song.id);
                return;
            }

            openSong();
        });

        row.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            hideSongContextMenu();
            showSongContextMenu(e.clientX, e.clientY, song.id);
        });

        row.querySelector(".song-delete-btn")?.addEventListener("click", (e) => {
            e.stopPropagation();
            if (libraryPendingDeleteId === song.id) {
                libraryPendingDeleteId = "";
                deleteSong(song.id);
                return;
            }
            libraryPendingDeleteId = song.id;
            renderSongList();
        });

        row.querySelector(".song-add-btn")?.addEventListener("click", (e) => {
            e.stopPropagation();
            addToPlaylist(song.id, e.currentTarget);
        });

        const handleEl = row.querySelector(".song-drag-handle");
        if (showDragHandle && handleEl) {
            handleEl.addEventListener("mousedown", (e) => e.stopPropagation());
            handleEl.addEventListener("click", (e) => e.stopPropagation());
            handleEl.addEventListener("dragstart", (e) => {
                e.stopPropagation();
                librarySongDragId = song.id;
                row.classList.add("song-item-dragging");
                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", song.id);
                }
            });
            handleEl.addEventListener("dragend", () => {
                librarySongDragId = "";
                row.classList.remove("song-item-dragging");
            });
        }

        if (showDragHandle) {
            row.addEventListener("dragover", (e) => {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            });
            row.addEventListener("drop", (e) => {
                e.preventDefault();
                const fromId = librarySongDragId || String(e.dataTransfer?.getData("text/plain") || "");
                reorderLibrarySongs(fromId, song.id);
            });
        }

        parent.appendChild(row);
    }

    function renderSongListBodyCore() {
        const list = $("song-list");
        const hint = $("search-result-hint");
        if (!list) return;

        const keyLower = ($("search-input")?.value || "").trim().toLowerCase();

        if (state.library.viewMode === "category") {
            const filtered = state.songs.filter((s) => songTitleMatchesSearch(s, keyLower));
            const panels = buildSongCategoryPanels(filtered);

            if (hint) {
                hint.textContent = keyLower ? `共找到 ${filtered.length} 首匹配诗歌` : "";
            }

            list.innerHTML = "";
            panels.forEach(({ label, songs: sg, count }) => {
                const det = document.createElement("details");
                det.className = "song-cat-details";
                det.open = true;
                const sum = document.createElement("summary");
                sum.className = "song-cat-summary";
                sum.textContent = `${label}（${count}首）`;
                const body = document.createElement("div");
                body.className = "song-cat-body";
                sg.forEach((song) =>
                    appendSongLibraryRow(body, song, keyLower, {
                        showDragHandle: false,
                        showBatchCb: false,
                        variant: "category"
                    })
                );
                det.appendChild(sum);
                det.appendChild(body);
                list.appendChild(det);
            });
            return;
        }

        const ordered = getLibraryFilteredSongRows();
        if (hint) {
            hint.textContent = keyLower ? `共找到 ${ordered.length} 首匹配诗歌` : "";
        }

        list.innerHTML = "";

        const batchMode = state.library.viewMode === "batch";
        const showDragHandle = state.library.viewMode === "all";

        ordered.forEach(({ song }) =>
            appendSongLibraryRow(list, song, keyLower, {
                showDragHandle,
                showBatchCb: batchMode,
                variant: "list"
            })
        );
    }

    function renderSongList() {
        const vm = state.library.viewMode;
        const fade = libraryViewModeBeforeRender !== null && libraryViewModeBeforeRender !== vm;
        libraryViewModeBeforeRender = vm;

        const inner = $("library-view-inner");

        const run = () => {
            syncLibraryChrome();
            renderSongListBodyCore();
        };

        if (!fade || !inner) {
            run();
            return;
        }

        inner.style.opacity = "0";
        window.setTimeout(() => {
            run();
            inner.style.opacity = "1";
        }, 200);
    }

    function renderPlaylist() {
        const list = $("playlist-list");
        if (!list) return;
        list.innerHTML = "";
        let dragFromIndex = -1;
        if (!state.playlist.items.length) {
            list.innerHTML =
                '<li class="playlist-empty-hint" role="status">点击左侧诗歌旁的 ＋ 添加到播放列表</li>';
            return;
        }
        state.playlist.items.forEach((songId, idx) => {
            const song = state.songs.find((s) => s.id === songId);
            if (!song) return;
            const li = document.createElement("li");
            li.className = "playlist-item" + (state.playlist.running && idx === state.playlist.activeIndex ? " active" : "");
            li.draggable = true;
            li.dataset.idx = String(idx);
            li.innerHTML = `<span>${escapeHtml(song.title || "未命名")}</span><button class="playlist-remove-btn" title="移出">✕</button>`;
            li.querySelector(".playlist-remove-btn")?.addEventListener("click", () => removeFromPlaylist(songId));
            li.addEventListener("dragstart", (e) => {
                dragFromIndex = idx;
                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", String(idx));
                }
            });
            li.addEventListener("dragover", (e) => {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            });
            li.addEventListener("drop", (e) => {
                e.preventDefault();
                const dragIndex = dragFromIndex >= 0 ? dragFromIndex : Number(e.dataTransfer?.getData("text/plain"));
                const targetIndex = idx;
                dragFromIndex = -1;
                if (!Number.isFinite(dragIndex) || dragIndex < 0 || dragIndex >= state.playlist.items.length) return;
                if (dragIndex === targetIndex) return;
                const [moved] = state.playlist.items.splice(dragIndex, 1);
                state.playlist.items.splice(targetIndex, 0, moved);
                if (state.playlist.activeIndex === dragIndex) {
                    state.playlist.activeIndex = targetIndex;
                } else if (state.playlist.activeIndex > dragIndex && state.playlist.activeIndex <= targetIndex) {
                    state.playlist.activeIndex -= 1;
                } else if (state.playlist.activeIndex < dragIndex && state.playlist.activeIndex >= targetIndex) {
                    state.playlist.activeIndex += 1;
                }
                savePlaylist();
                renderPlaylist();
            });
            li.addEventListener("dragend", () => {
                dragFromIndex = -1;
                savePlaylist();
            });
            list.appendChild(li);
        });
    }

    function loadSavedSetlists() {
        const raw = parseJSON(localStorage.getItem(WORSHIP_SETLISTS_LS), []);
        if (!Array.isArray(raw)) return [];
        return raw
            .map((x) => {
                if (!x || typeof x !== "object" || !x.id) return null;
                const songs = Array.isArray(x.songs)
                    ? x.songs
                    : Array.isArray(x.items)
                      ? x.items
                      : null;
                if (!songs) return null;
                return { ...x, songs };
            })
            .filter(Boolean);
    }

    function persistSavedSetlists(arr) {
        localStorage.setItem(WORSHIP_SETLISTS_LS, JSON.stringify(arr));
    }

    function closeSetlistModal() {
        const m = $("setlist-modal");
        if (!m) return;
        m.hidden = true;
        m.setAttribute("aria-hidden", "true");
    }

    function openSetlistModal() {
        const m = $("setlist-modal");
        if (!m) return;
        try {
            upgradeSavedSetlistsInPlace();
        } catch (_e) {
            /* ignore */
        }
        renderSetlistModalList();
        m.hidden = false;
        m.setAttribute("aria-hidden", "false");
    }

    function renderSetlistModalList() {
        const root = $("setlist-list");
        if (!root) return;
        root.innerHTML = "";
        const lists = loadSavedSetlists();
        if (!lists.length) {
            const p = document.createElement("p");
            p.className = "setlist-modal__empty";
            p.textContent = "暂无已保存的歌单。";
            root.appendChild(p);
            return;
        }
        lists.forEach((sl) => {
            const card = document.createElement("div");
            card.className = "setlist-card";
            const nameEl = document.createElement("p");
            nameEl.className = "setlist-card__name";
            nameEl.textContent = String(sl.name || "未命名歌单");
            const meta = document.createElement("p");
            meta.className = "setlist-card__meta";
            const n = Array.isArray(sl.songs) ? sl.songs.length : 0;
            const when = sl.createdAt ? new Date(sl.createdAt).toLocaleString() : "—";
            meta.textContent = `${n} 首 · 保存于 ${when}`;
            const actions = document.createElement("div");
            actions.className = "setlist-card__actions";
            const loadBtn = document.createElement("button");
            loadBtn.type = "button";
            loadBtn.className = "small-btn";
            loadBtn.textContent = "加载";
            loadBtn.addEventListener("click", () => applySavedSetlist(sl, loadBtn));
            const delBtn = document.createElement("button");
            delBtn.type = "button";
            delBtn.className = "small-btn";
            delBtn.textContent = "删除";
            delBtn.addEventListener("click", () => deleteSavedSetlist(sl.id, delBtn));
            actions.appendChild(loadBtn);
            actions.appendChild(delBtn);
            card.appendChild(nameEl);
            card.appendChild(meta);
            card.appendChild(actions);
            root.appendChild(card);
        });
    }

    function applySavedSetlist(sl, triggerBtn) {
        const next = resolveSetlistPlaylistIds(sl);
        if (!next.length) {
            closeSetlistModal();
            const hadBackup =
                (Array.isArray(sl.songEntries) && sl.songEntries.length > 0) ||
                (Array.isArray(sl.librarySnapshots) && sl.librarySnapshots.length > 0);
            showToast(
                hadBackup
                    ? "歌单恢复失败，请重试；若仍失败请重新保存该歌单"
                    : "歌单中的诗歌已不在本机曲库。请先把各首诗歌点「保存歌词」写入曲库，再重新「保存歌单」后加载",
                triggerBtn || $("load-setlist-btn")
            );
            return;
        }
        const pres = sl.presentation;
        const hasSnap =
            !isDisplay &&
            !isLeader &&
            pres &&
            Number(pres.v) === SETLIST_PRESENTATION_SNAPSHOT_V &&
            pres.defaults &&
            typeof pres.defaults === "object";
        if (hasSnap) {
            applySetlistTypographyDefaultsToUi(pres.defaults);
        }
        const tracks = hasSnap && Array.isArray(pres.tracks) ? pres.tracks : null;
        state.playlist.items = next;
        state.playlist.activeIndex = next.length ? 0 : -1;
        state.playlist.running = false;
        savePlaylist();
        if (next.length) {
            switchSong(next[0], { page: 0 });
        } else {
            syncSongToEditor();
            renderPlaylist();
            renderMiniPreview();
            updateSpeakerCards();
            renderPageGallery();
        }
        if (tracks && tracks.length) {
            const byId = new Map(state.songs.map((s) => [String(s.id), s]));
            tracks.forEach((tr) => {
                const song = byId.get(String(tr.id));
                if (song) applySetlistTrackPresentationToSong(song, tr);
            });
            try {
                saveSongs();
            } catch (_e) {
                /* ignore */
            }
            refreshBackgroundDefaultsFromUi();
            if (!isDisplay && !isLeader) {
                hydrateCurrentSongBackgroundIntoUi();
                normalizeLegacyBgImageReference();
                syncPosYFromCurrentSong();
                syncOverlayFontOpacityFromCurrentSong();
                updateUIFromState();
                renderSongList();
                updateSpeakerCards();
                renderMiniPreview();
                renderPlaylist();
                renderPageGallery();
            }
        }
        if (hasSnap) {
            try {
                saveSettings();
            } catch (_e) {
                /* ignore */
            }
            if (!tracks || !tracks.length) {
                updateUIFromState();
            }
        }
        broadcastState();
        closeSetlistModal();
        showToast(
            hasSnap ? "已加载歌单（含背景与排版）" : "已加载歌单",
            triggerBtn || $("load-setlist-btn")
        );
    }

    function deleteSavedSetlist(id, triggerBtn) {
        if (!window.confirm("确定删除该歌单？")) return;
        const next = loadSavedSetlists().filter((x) => String(x.id) !== String(id));
        try {
            persistSavedSetlists(next);
        } catch (_e) {
            showToast("删除失败", triggerBtn || $("load-setlist-btn"));
            return;
        }
        showToast("已删除歌单", triggerBtn || $("load-setlist-btn"));
        renderSetlistModalList();
    }

    function installSetlistModalHandlers() {
        if (installSetlistModalHandlers._done) return;
        installSetlistModalHandlers._done = true;
        $("setlist-modal-backdrop")?.addEventListener("click", () => closeSetlistModal());
        $("setlist-modal-close")?.addEventListener("click", () => closeSetlistModal());
    }

    let setlistNameModalCtx = null;

    function closeSetlistNameModal() {
        const m = $("setlist-name-modal");
        if (m) {
            m.style.display = "none";
            m.style.paddingTop = "";
            m.style.alignItems = "";
            m.style.justifyContent = "";
            m.style.flexDirection = "";
        }
        const inp = $("setlist-name-input");
        if (inp) inp.value = "";
        setlistNameModalCtx = null;
    }

    function openSetlistNameModal(defaultName, ids, triggerBtn) {
        const m = $("setlist-name-modal");
        const inp = $("setlist-name-input");
        if (!m || !inp) return false;
        setlistNameModalCtx = { ids: [...ids], triggerBtn };
        inp.value = defaultName;
        m.style.display = "flex";
        m.style.flexDirection = "row";
        m.style.alignItems = "flex-start";
        m.style.justifyContent = "center";
        m.style.paddingTop = "18vh";
        window.requestAnimationFrame(() => {
            inp.focus();
            inp.select();
        });
        return true;
    }

    /** 歌单快照 v1：defaults=保存瞬间的全局歌词排版；tracks=各首在曲库中的背景与垂直/透明度（与投屏一致） */
    const SETLIST_PRESENTATION_SNAPSHOT_V = 1;

    function normalizeSetlistSongRef(ref) {
        if (ref == null || ref === "") return null;
        if (typeof ref === "object") {
            if (ref.id != null && ref.id !== "") return String(ref.id);
            return null;
        }
        return String(ref);
    }

    function songFromSetlistSnapshot(snap) {
        const bg = snap.background && typeof snap.background === "object" ? snap.background : {};
        const song = {
            id: snap.id,
            title: String(snap.title ?? "").trim() || "未命名",
            lyrics: String(snap.lyrics ?? ""),
            key: String(snap.key ?? "").trim(),
            tempo: String(snap.tempo ?? "").trim(),
            notes: String(snap.notes ?? "").trim(),
            tags: String(snap.tags ?? "").trim(),
            overlayOpacityPct: Number.isFinite(Number(snap.overlayOpacityPct))
                ? clamp(Number(snap.overlayOpacityPct), 0, 80)
                : 30,
            fontOpacityPct: Number.isFinite(Number(snap.fontOpacityPct))
                ? clamp(Number(snap.fontOpacityPct), 20, 100)
                : 100,
            bgType: String(bg.bgType || snap.bgType || "particles").trim() || "particles",
            bgImage: String(bg.bgImage ?? snap.bgImage ?? ""),
            bgImageId: String(bg.bgImageId ?? snap.bgImageId ?? ""),
            bgMediaType: bg.bgMediaType === "video" || snap.bgMediaType === "video" ? "video" : "image"
        };
        if (snap.posY != null && Number.isFinite(Number(snap.posY))) {
            song.posY = clamp(Number(snap.posY), 20, 70);
        }
        return song;
    }

    /** 将歌单内嵌的诗歌副本写回本机曲库（按 id 合并或新增） */
    function ensureSongFromSetlistSnapshot(snap) {
        if (!snap || snap.id == null || snap.id === "") return null;
        const sid = String(snap.id);
        let hit = state.songs.find((s) => String(s.id) === sid);
        if (hit) {
            const snapLy = String(snap.lyrics ?? "");
            const curLy = String(hit.lyrics ?? "");
            if (snapLy.length > curLy.length) hit.lyrics = snapLy;
            const snapTitle = String(snap.title ?? "").trim();
            if (snapTitle && (!String(hit.title || "").trim() || hit.title === "未命名")) {
                hit.title = snapTitle;
            }
            return hit;
        }
        hit = songFromSetlistSnapshot(snap);
        state.songs.push(hit);
        return hit;
    }

    function restoreAllSetlistSnapshots(sl) {
        const pools = [];
        if (Array.isArray(sl.songEntries)) pools.push(...sl.songEntries);
        if (Array.isArray(sl.librarySnapshots)) pools.push(...sl.librarySnapshots);
        const presTracks = sl.presentation?.tracks;
        if (Array.isArray(presTracks)) {
            presTracks.forEach((tr) => {
                if (tr && tr.id != null && (tr.lyrics != null || tr.title != null)) pools.push(tr);
            });
        }
        let touched = false;
        const seen = new Set();
        pools.forEach((snap) => {
            if (!snap || snap.id == null || snap.id === "") return;
            const sid = String(snap.id);
            if (seen.has(sid)) return;
            seen.add(sid);
            if (ensureSongFromSetlistSnapshot(snap)) touched = true;
        });
        if (touched) {
            try {
                saveSongs();
                renderSongList();
            } catch (_e) {
                /* ignore */
            }
        }
        return touched;
    }

    /** 解析歌单播放顺序：优先用内嵌诗歌副本，再回退到 id 列表 */
    function resolveSetlistPlaylistIds(sl) {
        restoreAllSetlistSnapshots(sl);
        const ordered = [];
        const seen = new Set();
        const pushRef = (ref) => {
            const id = normalizeSetlistSongRef(ref);
            if (!id || seen.has(id)) return;
            const hit = state.songs.find((s) => String(s.id) === id);
            if (!hit) return;
            seen.add(id);
            ordered.push(hit.id);
        };

        const snapOrder = Array.isArray(sl.librarySnapshots) ? sl.librarySnapshots : [];
        if (snapOrder.length) {
            snapOrder.forEach((snap) => pushRef(snap));
            if (ordered.length) return ordered;
        }

        const entries = Array.isArray(sl.songEntries) ? sl.songEntries : [];
        if (entries.length) {
            entries.forEach((snap) => pushRef(snap));
            if (ordered.length) return ordered;
        }

        const raw = Array.isArray(sl.songs) ? sl.songs : Array.isArray(sl.items) ? sl.items : [];
        raw.forEach((ref) => pushRef(ref));

        if (!ordered.length && Array.isArray(sl.presentation?.tracks)) {
            sl.presentation.tracks.forEach((tr) => pushRef(tr));
        }

        return ordered;
    }

    /** 启动时：旧歌单若曲库中仍有对应诗歌，补全 songEntries 便于刷新后加载 */
    function upgradeSavedSetlistsInPlace() {
        const lists = loadSavedSetlists();
        let changed = false;
        lists.forEach((sl) => {
            if (Array.isArray(sl.songEntries) && sl.songEntries.length) return;
            const ids = [];
            const raw = Array.isArray(sl.songs) ? sl.songs : Array.isArray(sl.items) ? sl.items : [];
            raw.forEach((ref) => {
                const id = normalizeSetlistSongRef(ref);
                if (id && !ids.includes(id)) ids.push(id);
            });
            if (!ids.length) return;
            const entries = [];
            ids.forEach((id) => {
                const s = state.songs.find((x) => String(x.id) === String(id));
                if (s) entries.push(JSON.parse(JSON.stringify(s)));
            });
            if (!entries.length) return;
            sl.songEntries = entries;
            if (!Array.isArray(sl.librarySnapshots) || !sl.librarySnapshots.length) {
                sl.librarySnapshots = entries.map((s) => gatherSetlistSongLibrarySnapshot(s.id)).filter(Boolean);
            }
            changed = true;
        });
        if (changed) {
            try {
                persistSavedSetlists(lists);
            } catch (_e) {
                /* ignore */
            }
        }
    }

    /** 保存歌单时附带各首诗歌副本，刷新后 ID 对不上时仍可还原进本机曲库 */
    function gatherSetlistSongLibrarySnapshot(songId) {
        const song = state.songs.find((s) => String(s.id) === String(songId));
        if (!song) return null;
        const bg = getStoredSongBackgroundOrDefaults(song);
        const row = {
            id: String(songId),
            title: String(song.title ?? ""),
            lyrics: String(song.lyrics ?? ""),
            key: String(song.key ?? "").trim(),
            tempo: String(song.tempo ?? "").trim(),
            notes: String(song.notes ?? "").trim(),
            tags: String(song.tags ?? "").trim(),
            background: {
                bgType: bg.bgType,
                bgImage: String(bg.bgImage || ""),
                bgImageId: String(bg.bgImageId || ""),
                bgMediaType: bg.bgMediaType === "video" ? "video" : "image"
            }
        };
        if (Number.isFinite(Number(song.overlayOpacityPct))) {
            row.overlayOpacityPct = clamp(Number(song.overlayOpacityPct), 0, 80);
        }
        if (Number.isFinite(Number(song.fontOpacityPct))) {
            row.fontOpacityPct = clamp(Number(song.fontOpacityPct), 20, 100);
        }
        if (Number.isFinite(Number(song.posY))) row.posY = clamp(Number(song.posY), 20, 70);
        return row;
    }

    function gatherSetlistTypographyDefaultsForSnapshot() {
        const u = state.ui;
        return {
            fontFamily: u.fontFamily,
            fontSize: u.fontSize,
            fontColor: u.fontColor,
            fontWeight: u.fontWeight,
            textStrokePx: u.textStrokePx,
            defaultLines: u.defaultLines,
            fontMegaMode: !!u.fontMegaMode,
            vignetteShape: u.vignetteShape,
            vignetteCenterBrightness: u.vignetteCenterBrightness,
            vignetteEdgeDarkness: u.vignetteEdgeDarkness,
            pageTransition: u.pageTransition,
            pageTransitionSpeed: u.pageTransitionSpeed
        };
    }

    function gatherSetlistTrackPresentationSnapshot(songId) {
        const song = state.songs.find((s) => String(s.id) === String(songId));
        if (!song) return null;
        const bg = getStoredSongBackgroundOrDefaults(song);
        const row = {
            id: String(songId),
            title: String(song.title ?? ""),
            lyrics: String(song.lyrics ?? ""),
            background: {
                bgType: bg.bgType,
                bgImage: String(bg.bgImage || ""),
                bgImageId: String(bg.bgImageId || ""),
                bgMediaType: bg.bgMediaType === "video" ? "video" : "image"
            }
        };
        if (Number.isFinite(Number(song.posY))) row.posY = clamp(Number(song.posY), 20, 70);
        if (Number.isFinite(Number(song.overlayOpacityPct))) {
            row.overlayOpacityPct = clamp(Number(song.overlayOpacityPct), 0, 80);
        }
        if (Number.isFinite(Number(song.fontOpacityPct))) {
            row.fontOpacityPct = clamp(Number(song.fontOpacityPct), 20, 100);
        }
        return row;
    }

    function applySetlistTypographyDefaultsToUi(d) {
        if (!d || typeof d !== "object") return;
        if (d.fontMegaMode != null) state.ui.fontMegaMode = !!d.fontMegaMode;
        if (d.fontFamily != null && String(d.fontFamily).trim()) {
            state.ui.fontFamily = String(d.fontFamily).trim();
        }
        if (d.fontColor != null && String(d.fontColor).trim()) {
            state.ui.fontColor = String(d.fontColor).trim();
        }
        if (d.fontWeight != null && String(d.fontWeight).trim()) {
            state.ui.fontWeight = String(d.fontWeight).trim();
        }
        if (d.fontSize != null) state.ui.fontSize = clampLyricFontSize(Number(d.fontSize));
        if (d.textStrokePx != null) state.ui.textStrokePx = clamp(Number(d.textStrokePx), 0, 6);
        if (d.defaultLines != null) {
            state.ui.defaultLines = clamp(Math.floor(Number(d.defaultLines)), 1, 20);
        }
        if (d.vignetteShape === "ellipse" || d.vignetteShape === "circle") {
            state.ui.vignetteShape = d.vignetteShape;
        }
        if (d.vignetteCenterBrightness != null && Number.isFinite(Number(d.vignetteCenterBrightness))) {
            state.ui.vignetteCenterBrightness = clamp(Number(d.vignetteCenterBrightness), -50, 50);
        }
        if (d.vignetteEdgeDarkness != null && Number.isFinite(Number(d.vignetteEdgeDarkness))) {
            state.ui.vignetteEdgeDarkness = clamp(Number(d.vignetteEdgeDarkness), 0, 90);
        }
        if (d.pageTransition != null) {
            state.ui.pageTransition = canonicalPageTransition(d.pageTransition);
        }
        if (d.pageTransitionSpeed != null && Number.isFinite(Number(d.pageTransitionSpeed))) {
            state.ui.pageTransitionSpeed = clamp(Number(d.pageTransitionSpeed), 0.3, 1.5);
        }
    }

    function applySetlistTrackPresentationToSong(song, track) {
        if (!song || !track || typeof track !== "object") return;
        const bg = track.background;
        if (bg && typeof bg === "object") {
            if (bg.bgType != null && String(bg.bgType).trim()) song.bgType = String(bg.bgType).trim();
            song.bgImage = String(bg.bgImage ?? "");
            song.bgImageId = String(bg.bgImageId ?? "");
            song.bgMediaType = bg.bgMediaType === "video" ? "video" : "image";
        }
        if (track.posY != null && Number.isFinite(Number(track.posY))) {
            song.posY = clamp(Number(track.posY), 20, 70);
        }
        if (track.overlayOpacityPct != null && Number.isFinite(Number(track.overlayOpacityPct))) {
            song.overlayOpacityPct = clamp(Number(track.overlayOpacityPct), 0, 80);
        }
        if (track.fontOpacityPct != null && Number.isFinite(Number(track.fontOpacityPct))) {
            song.fontOpacityPct = clamp(Number(track.fontOpacityPct), 20, 100);
        }
    }

    function commitSetlistNameModalSave() {
        const inp = $("setlist-name-input");
        const ctx = setlistNameModalCtx;
        if (!inp || !ctx) return;
        const trimmed = String(inp.value || "").trim();
        if (!trimmed) {
            showToast("请输入歌单名称", $("setlist-name-confirm"));
            return;
        }
        if (!isDisplay && !isLeader) {
            syncEditorToSong();
            persistSongBackgroundFromUi(state.currentSongId);
        }
        try {
            saveSongs();
        } catch (_e) {
            /* ignore */
        }
        const librarySnapshots = [];
        const songEntries = [];
        const tracks = [];
        ctx.ids.forEach((id) => {
            const song = state.songs.find((s) => String(s.id) === String(id));
            if (song) {
                try {
                    songEntries.push(JSON.parse(JSON.stringify(song)));
                } catch (_e) {
                    songEntries.push({ ...song });
                }
            }
            const libSnap = gatherSetlistSongLibrarySnapshot(id);
            if (libSnap) librarySnapshots.push(libSnap);
            const row = gatherSetlistTrackPresentationSnapshot(id);
            if (row) tracks.push(row);
        });
        let lists = loadSavedSetlists();
        const entry = {
            id: "setlist_" + Date.now(),
            name: trimmed,
            songs: [...ctx.ids],
            createdAt: Date.now(),
            songEntries,
            librarySnapshots,
            presentation: {
                v: SETLIST_PRESENTATION_SNAPSHOT_V,
                defaults: gatherSetlistTypographyDefaultsForSnapshot(),
                tracks
            }
        };
        const btn = ctx.triggerBtn;
        try {
            lists.push(entry);
            persistSavedSetlists(lists);
        } catch (err) {
            console.warn("persist setlists", err);
            showToast("歌单保存失败", btn);
            closeSetlistNameModal();
            return;
        }
        closeSetlistNameModal();
        showToast("歌单已保存", btn, { variant: "success" });
    }

    function installSetlistNameModalHandlers() {
        if (installSetlistNameModalHandlers._bound) return;
        installSetlistNameModalHandlers._bound = true;
        const modal = $("setlist-name-modal");
        const cancel = $("setlist-name-cancel");
        const confirm = $("setlist-name-confirm");
        const inp = $("setlist-name-input");
        cancel?.addEventListener("click", () => closeSetlistNameModal());
        confirm?.addEventListener("click", () => commitSetlistNameModalSave());
        modal?.addEventListener("click", (e) => {
            if (e.target === modal) closeSetlistNameModal();
        });
        inp?.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                closeSetlistNameModal();
            } else if (e.key === "Enter") {
                e.preventDefault();
                commitSetlistNameModalSave();
            }
        });
    }

    function addToPlaylist(songId, triggerElement) {
        if (!songId || state.playlist.items.includes(songId)) return;
        state.playlist.items.push(songId);
        savePlaylist();
        renderPlaylist();
        showToast("已加入播放列表", triggerElement || $("playlist-start-btn"));
    }

    function removeFromPlaylist(songId) {
        const idx = state.playlist.items.indexOf(songId);
        if (idx < 0) return;
        state.playlist.items.splice(idx, 1);
        if (state.playlist.activeIndex >= state.playlist.items.length) {
            state.playlist.activeIndex = Math.max(0, state.playlist.items.length - 1);
        }
        if (!state.playlist.items.length) {
            state.playlist.running = false;
            state.playlist.activeIndex = -1;
        }
        savePlaylist();
        renderPlaylist();
    }

    /** @param {"first"|"last"} [whichPage] 切到该首的第 1 页或最后一页（用于键盘跨歌翻页） */
    function switchToPlaylistSong(index, withFade, whichPage) {
        if (index < 0 || index >= state.playlist.items.length) return false;
        const songId = state.playlist.items[index];
        if (!state.songs.some((s) => s.id === songId)) return false;
        state.playlist.running = true;
        state.playlist.activeIndex = index;
        if (withFade) state.playlist.fadeNext = true;
        switchSong(songId);
        if (whichPage === "last") {
            const lp = splitPages(getStablePagingLyricsForPageSplit(), state.ui.defaultLines);
            state.currentPage = Math.max(0, lp.length - 1);
        }
        updateSpeakerCards();
        renderMiniPreview();
        renderPlaylist();
        broadcastState();
        savePlaylist();
        return true;
    }

    function startPlaylistPlayback() {
        if (!state.playlist.items.length) {
            showToast("播放列表为空", $("playlist-start-btn"));
            return;
        }
        switchToPlaylistSong(0, true);
        showToast("播放列表已开始", $("playlist-start-btn"));
    }

    function bindMainMiniPreviewVideoVisibility() {
        if (bindMainMiniPreviewVideoVisibility._done) return;
        bindMainMiniPreviewVideoVisibility._done = true;
        document.addEventListener("visibilitychange", () => {
            const v = document.querySelector("#mini-preview .mini-preview-bg-video");
            if (!v) return;
            if (document.hidden) v.pause();
            else void v.play().catch(() => {});
        });
    }

    function appendMiniPreviewProjectionMask(mini) {
        if (!mini) return;
        const op = clamp(Number(state.ui.overlayOpacityPct), 0, 80) / 100;
        const m = document.createElement("div");
        m.className = "mini-preview-projection-mask";
        m.setAttribute("aria-hidden", "true");
        m.style.cssText =
            "position:absolute;inset:0;pointer-events:none;z-index:1;background:rgba(0,0,0," +
            op +
            ");border-radius:inherit;transition:background 0.12s ease;";
        mini.appendChild(m);
    }

    function renderMiniPreview(options) {
        const mini = $("mini-preview");
        if (!mini) return;
        const song = currentSong();
        const pages = splitPages(lyricsForPaginationSplit(), state.ui.defaultLines);
        const lines = pages[state.currentPage] || [];

        if (options && options.linesOnly && isMainVideoBackground()) {
            const transLo = isAnimatablePageTransition(state.ui.pageTransition)
                ? canonicalPageTransition(state.ui.pageTransition)
                : "none";
            const durLo = clamp(Number(state.ui.pageTransitionSpeed ?? 0.6), 0.3, 1.5);
            const prevPLo = mini.dataset._miniTransPage;
            const pageChangedLo = prevPLo !== undefined && prevPLo !== String(state.currentPage);
            const stageLo0 = mini.querySelector(".mini-preview-lyric-stage");
            if (
                MINI_PREVIEW_ANIMATE_PAGE_CHANGE &&
                !(options && options.skipPageTransition) &&
                pageChangedLo &&
                transLo !== "none" &&
                stageLo0 &&
                stageLo0.isConnected
            ) {
                mini.dataset._miniTransPage = String(state.currentPage);
                runMiniPageTransitionThenRender(stageLo0, transLo, durLo, state.ui.fontOpacityPct, () => {
                    renderMiniPreview({ ...options, skipPageTransition: true });
                });
                return;
            }
            cancelMiniPageExitTimer();
            mini.querySelectorAll(".mini-preview-lyric-stage").forEach((n) => n.remove());
            mini.querySelectorAll(".preview-line").forEach((n) => n.remove());
            mini.querySelectorAll(".mini-preview-projection-mask").forEach((n) => n.remove());
            mini.querySelectorAll(".mini-preview-vignette-radial").forEach((n) => n.remove());
            mini.style.display = "flex";
            mini.style.flexDirection = "column";
            mini.style.justifyContent = "flex-start";
            mini.style.alignItems = "center";
            mini.style.boxSizing = "border-box";
            const padLo = lyricBlockTopPadPx(mini.clientHeight, state.ui.posY);
            mini.style.paddingTop = `${padLo}px`;
            mini.dataset.miniLyricPadCommitted = String(padLo);
            mini.style.paddingBottom = "12px";
            mini.style.paddingLeft = "12px";
            mini.style.paddingRight = "12px";
            appendMiniPreviewProjectionMask(mini);
            ensureMiniPreviewVignetteLayer(mini);
            const stageLo = document.createElement("div");
            stageLo.className = "mini-preview-lyric-stage";
            mini.appendChild(stageLo);
            lines.forEach((line) => {
                const row = document.createElement("div");
                row.className = "preview-line";
                row.style.fontSize =
                    Math.round(Math.min(140, clampLyricFontSize(state.ui.fontSize) * 0.42)) + "px";
                row.style.position = "relative";
                row.style.zIndex = "3";
                populateLyricRowElement(row, line, {
                    fontFamily: state.ui.fontFamily,
                    fontColor: state.ui.fontColor,
                    fontOpacityPct: state.ui.fontOpacityPct,
                    textStrokePx: state.ui.textStrokePx,
                    lightBg: state.ui.bgType === "solid-white"
                });
                stageLo.appendChild(row);
            });
            if ($("preview-line-counter")) $("preview-line-counter").textContent = `(${lines.length} 行)`;
            mini.dataset._miniTransPage = String(state.currentPage);
            return;
        }

        const prevPage = mini.dataset._miniTransPage;
        const pageChanged = prevPage !== undefined && prevPage !== String(state.currentPage);
        const transUi = isAnimatablePageTransition(state.ui.pageTransition)
            ? canonicalPageTransition(state.ui.pageTransition)
            : "none";
        const durUi = clamp(Number(state.ui.pageTransitionSpeed ?? 0.6), 0.3, 1.5);
        const stageExist = mini.querySelector(".mini-preview-lyric-stage");
        if (
            MINI_PREVIEW_ANIMATE_PAGE_CHANGE &&
            !(options && options.skipPageTransition) &&
            pageChanged &&
            transUi !== "none" &&
            stageExist &&
            stageExist.isConnected
        ) {
            mini.dataset._miniTransPage = String(state.currentPage);
            runMiniPageTransitionThenRender(stageExist, transUi, durUi, state.ui.fontOpacityPct, () => {
                renderMiniPreview({ ...options, skipPageTransition: true });
            });
            return;
        }

        cancelMiniPageExitTimer();
        mini.innerHTML = "";
        clearCssDynamicBgClass(mini);
        mini.style.background = "rgba(0, 0, 0, 0.55)";
        mini.style.backgroundImage = "none";
        mini.style.position = "relative";
        if (CSS_DYNAMIC_BG_TYPES.has(state.ui.bgType)) {
            mini.style.background = "";
            mini.classList.add(`css-bg-${state.ui.bgType}`);
        } else if (state.ui.bgType === "solid-white") mini.style.background = "rgba(255, 255, 255, 0.55)";
        else if (state.ui.bgType === "solid-gray") mini.style.background = "rgba(68, 68, 68, 0.55)";
        else if (state.ui.bgType === "gradient") {
            mini.style.background = "linear-gradient(140deg, rgba(27, 47, 89, 0.55), rgba(10, 15, 29, 0.55))";
        } else if (state.ui.bgType === "image" && state.ui.bgImage && state.ui.bgMediaType === "video") {
            mini.style.background = "#000";
            let v = mini.querySelector(".mini-preview-bg-video");
            if (!v) {
                v = document.createElement("video");
                v.className = "mini-preview-bg-video";
                v.muted = true;
                v.loop = true;
                v.playsInline = true;
                v.setAttribute("playsinline", "");
                v.setAttribute("autoplay", "");
                v.style.cssText =
                    "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;pointer-events:none;";
                if (mini.firstChild) mini.insertBefore(v, mini.firstChild);
                else mini.appendChild(v);
            }
            if (v.src !== state.ui.bgImage) v.src = state.ui.bgImage;
            void v.play().catch(() => {});
        } else if (state.ui.bgType === "image" && state.ui.bgImage) {
            mini.style.backgroundImage = `url("${state.ui.bgImage}")`;
            mini.style.backgroundSize = "cover";
            mini.style.backgroundPosition = "center";
        }

        mini.style.display = "flex";
        mini.style.flexDirection = "column";
        mini.style.justifyContent = "flex-start";
        mini.style.alignItems = "center";
        mini.style.boxSizing = "border-box";
        const padPx = lyricBlockTopPadPx(mini.clientHeight, state.ui.posY);
        mini.style.paddingTop = `${padPx}px`;
        mini.dataset.miniLyricPadCommitted = String(padPx);
        mini.style.paddingBottom = "12px";
        mini.style.paddingLeft = "12px";
        mini.style.paddingRight = "12px";

        appendMiniPreviewProjectionMask(mini);
        ensureMiniPreviewVignetteLayer(mini);
        const stage = document.createElement("div");
        stage.className = "mini-preview-lyric-stage";
        mini.appendChild(stage);
        lines.forEach((line) => {
            const row = document.createElement("div");
            row.className = "preview-line";
            row.style.fontSize =
                Math.round(Math.min(140, clampLyricFontSize(state.ui.fontSize) * 0.42)) + "px";
            row.style.position = "relative";
            row.style.zIndex = "3";
            populateLyricRowElement(row, line, {
                fontFamily: state.ui.fontFamily,
                fontColor: state.ui.fontColor,
                fontOpacityPct: state.ui.fontOpacityPct,
                textStrokePx: state.ui.textStrokePx,
                lightBg: state.ui.bgType === "solid-white"
            });
            stage.appendChild(row);
        });
        if ($("preview-line-counter")) $("preview-line-counter").textContent = `(${lines.length} 行)`;
        mini.dataset._miniTransPage = String(state.currentPage);
    }

    /** 从 Worker 行数据拼出完整歌词：优先 lines 用 \n 拼接，其次 lyrics / content */
    function onlineHymnLyricsFromRow(row) {
        if (!row || typeof row !== "object") return "";
        if (Array.isArray(row.lines) && row.lines.length) {
            return row.lines
                .map((ln) => {
                    if (ln == null) return "";
                    if (typeof ln === "string") return ln;
                    if (typeof ln === "object" && "text" in ln) return String(ln.text ?? "");
                    return String(ln);
                })
                .join("\n");
        }
        if (typeof row.lyrics === "string" && row.lyrics.trim()) return row.lyrics.trim();
        if (typeof row.content === "string" && row.content.trim()) return row.content.trim();
        return "";
    }

    function onlineHymnAuthorFromRow(row) {
        if (!row || typeof row !== "object") return "—";
        const v = row.author ?? row.writer ?? row.source;
        const s = v == null ? "" : String(v).trim();
        return s || "—";
    }

    /** 若 #online-results 被挂到诗歌库外，移回 #song-library（仅占位，搜索结果在浮层展示） */
    function rehomeOnlineResultsPanelIfNeeded() {
        const lib = $("song-library");
        const panel = document.getElementById("online-results");
        if (!lib || !panel) return;
        if (lib.contains(panel)) return;
        const anchor = $("tag-filter");
        try {
            if (anchor && anchor.parentNode === lib) {
                lib.insertBefore(panel, anchor);
            } else {
                const sl = $("song-list");
                if (sl && sl.parentNode === lib) lib.insertBefore(panel, sl);
                else lib.appendChild(panel);
            }
        } catch (_e) {
            /* ignore */
        }
    }

    function clearLegacyOnlineResultsSlot() {
        const slot = document.getElementById("online-results");
        if (slot) {
            slot.className = "";
            slot.innerHTML = "";
        }
    }

    let onlineSearchOverlayEscBound = false;
    function ensureOnlineSearchOverlay() {
        if ($("online-search-overlay")) return;
        const root = document.createElement("div");
        root.id = "online-search-overlay";
        root.className = "online-search-overlay";
        root.setAttribute("aria-hidden", "true");

        const backdrop = document.createElement("div");
        backdrop.className = "online-search-overlay__backdrop";
        backdrop.addEventListener("click", () => closeOnlineSearchOverlay());

        const panel = document.createElement("aside");
        panel.className = "online-search-overlay__panel";
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");
        panel.setAttribute("aria-label", "在线搜索结果");

        const head = document.createElement("div");
        head.className = "online-search-overlay__head";
        const h2 = document.createElement("h2");
        h2.className = "online-search-overlay__title";
        h2.textContent = "在线搜索结果";
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "online-search-overlay__close";
        closeBtn.setAttribute("aria-label", "关闭");
        closeBtn.textContent = "✕";
        closeBtn.addEventListener("click", () => closeOnlineSearchOverlay());
        head.appendChild(h2);
        head.appendChild(closeBtn);

        const body = document.createElement("div");
        body.id = "online-search-overlay-body";
        body.className = "online-search-overlay__body";

        panel.appendChild(head);
        panel.appendChild(body);
        root.appendChild(backdrop);
        root.appendChild(panel);
        document.body.appendChild(root);

        if (!onlineSearchOverlayEscBound) {
            onlineSearchOverlayEscBound = true;
            document.addEventListener("keydown", (e) => {
                const ov = $("online-search-overlay");
                if (!ov || !ov.classList.contains("is-open")) return;
                if (e.key === "Escape") {
                    e.preventDefault();
                    closeOnlineSearchOverlay();
                }
            });
        }
    }

    function getOnlineSearchResultsHost() {
        ensureOnlineSearchOverlay();
        return $("online-search-overlay-body");
    }

    function openOnlineSearchOverlay() {
        ensureOnlineSearchOverlay();
        const ov = $("online-search-overlay");
        if (!ov) return;
        clearLegacyOnlineResultsSlot();
        ov.classList.add("is-open");
        ov.setAttribute("aria-hidden", "false");
        document.body.classList.add("online-search-overlay-open");
    }

    function closeOnlineSearchOverlay() {
        if (onlineHymnSearchAbort) {
            onlineHymnSearchAbort.abort();
            onlineHymnSearchAbort = null;
        }
        const ov = $("online-search-overlay");
        if (ov) {
            ov.classList.remove("is-open");
            ov.setAttribute("aria-hidden", "true");
            const body = $("online-search-overlay-body");
            if (body) body.innerHTML = "";
        }
        document.body.classList.remove("online-search-overlay-open");
        clearLegacyOnlineResultsSlot();
    }

    /** 新建并写入诗歌库：插入列表最上方（不修改当前编辑区 textarea） */
    function addNewSong(song, anchorEl) {
        state.songs.unshift(song);
        saveSongs();
        renderSongList();
        showCornerSuccessToast("✅ 已导入", anchorEl || $("online-search-input"));
    }

    /** 导入后切换到该诗歌并广播到投屏（等同「保存 + 应用到演示屏」） */
    function importOnlineRowAndProject(row, anchorEl) {
        const song = buildImportedSongFromOnlineRow(row);
        if (!String(song.lyrics || "").trim()) {
            showToast("导入失败：歌词为空", anchorEl || null);
            return;
        }
        state.songs.unshift(song);
        saveSongs();
        renderSongList();
        switchSong(song.id);
        try {
            saveCurrentLyrics({ silent: true });
            broadcastState();
        } catch (err) {
            console.warn("importOnlineRowAndProject", err);
        }
        showCornerSuccessToast("✅ 已导入并应用投屏", anchorEl || $("online-search-input"));
    }

    function onlineHymnLyricsLinesArray(text) {
        return String(text || "").replace(/\r\n/g, "\n").split("\n");
    }

    function onlineHymnAuthorDisplayFromRow(row) {
        const a = onlineHymnAuthorFromRow(row);
        return a === "—" ? "佚名" : a;
    }

    function onlineHymnPageEstimateFromLyrics(lyricsText, linesPerPage) {
        const n = Math.max(1, onlineHymnLyricsLinesArray(lyricsText).length);
        const per = Math.max(1, Number(linesPerPage) || 4);
        return Math.max(1, Math.ceil(n / per));
    }

    function mountOnlineSearchCardPreview(card, previewWrap, lyricsFull) {
        const linesArr = onlineHymnLyricsLinesArray(lyricsFull);
        const rebuild = (expanded) => {
            previewWrap.innerHTML = "";
            if (expanded) {
                const full = document.createElement("div");
                full.className = "online-search-card__preview-full";
                full.textContent = lyricsFull;
                previewWrap.appendChild(full);
                const collapseBtn = document.createElement("button");
                collapseBtn.type = "button";
                collapseBtn.className = "online-search-card__expand-toggle";
                collapseBtn.textContent = "收起";
                collapseBtn.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    card.classList.remove("is-expanded");
                    rebuild(false);
                });
                previewWrap.appendChild(collapseBtn);
                return;
            }
            const total = linesArr.length;
            const needExpand = total > 6;
            const visibleCount = needExpand ? 5 : Math.min(6, total);
            for (let i = 0; i < visibleCount; i++) {
                const lineEl = document.createElement("div");
                lineEl.className = "online-search-card__preview-line";
                lineEl.textContent = linesArr[i];
                previewWrap.appendChild(lineEl);
            }
            if (needExpand) {
                const exp = document.createElement("button");
                exp.type = "button";
                exp.className = "online-search-card__expand-toggle";
                exp.textContent = "... 展开查看更多";
                exp.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    card.classList.add("is-expanded");
                    rebuild(true);
                });
                previewWrap.appendChild(exp);
            }
        };
        card.classList.remove("is-expanded");
        rebuild(false);
    }

    function buildImportedSongFromOnlineRow(row) {
        const lyrics = onlineHymnLyricsFromRow(row);
        const titleStr = String(row.title || "未命名").trim() || "未命名";
        const authorLine = onlineHymnAuthorFromRow(row);
        let notes = String(row.notes || "").trim();
        if (authorLine && authorLine !== "—") {
            const authPrefix = `作者：${authorLine}`;
            notes = notes ? `${authPrefix}\n${notes}` : authPrefix;
        }
        return {
            id: uid(),
            title: titleStr,
            lyrics,
            key: String(row.key || "").trim(),
            tempo: String(row.tempo || "").trim(),
            notes,
            tags: Array.isArray(row.tags) ? row.tags.join(",") : String(row.tags || "").trim(),
            overlayOpacityPct: 30,
            fontOpacityPct: 100
        };
    }

    function renderOnlineSearchResult() {
        const input = $("online-search-input");
        rehomeOnlineResultsPanelIfNeeded();
        if (input) {
            input.disabled = false;
            input.removeAttribute("disabled");
        }
        if (!input) return;
        if (onlineHymnSearchDebounceTimer) {
            window.clearTimeout(onlineHymnSearchDebounceTimer);
            onlineHymnSearchDebounceTimer = 0;
        }
        const raw = String(input.value || "").trim();
        if (!raw) {
            closeOnlineSearchOverlay();
            return;
        }
        onlineHymnSearchDebounceTimer = window.setTimeout(() => {
            onlineHymnSearchDebounceTimer = 0;
            void searchOnlineHymns();
        }, 300);
    }

    async function searchOnlineHymns() {
        const input = $("online-search-input");
        rehomeOnlineResultsPanelIfNeeded();
        if (!input) return;
        input.disabled = false;
        input.removeAttribute("disabled");
        const q = String(input.value || "").trim();
        if (!q) {
            closeOnlineSearchOverlay();
            return;
        }
        if (onlineHymnSearchAbort) {
            onlineHymnSearchAbort.abort();
        }
        const ac = new AbortController();
        onlineHymnSearchAbort = ac;

        openOnlineSearchOverlay();
        const host = getOnlineSearchResultsHost();
        if (!host) return;
        host.className = "online-search-overlay__body online-search-overlay__body--results";
        host.innerHTML = "";
        const loadingEl = document.createElement("div");
        loadingEl.className = "online-results__state online-results__state--loading";
        loadingEl.textContent = "🔍 搜索中...";
        host.appendChild(loadingEl);

        const url = `${ONLINE_HYMN_SEARCH_WORKER_URL}/?q=${encodeURIComponent(q)}`;
        try {
            const res = await fetch(url, {
                method: "GET",
                signal: ac.signal,
                headers: { Accept: "application/json" }
            });
            const text = await res.text();
            let payload = null;
            try {
                payload = text ? JSON.parse(text) : null;
            } catch (_e) {
                host.innerHTML = "";
                const errEl = document.createElement("div");
                errEl.className = "online-results__state online-results__state--error";
                errEl.textContent = "搜索失败，请稍后重试";
                host.appendChild(errEl);
                return;
            }
            if (payload && typeof payload === "object" && !Array.isArray(payload) && payload.error) {
                host.innerHTML = "";
                const errEl = document.createElement("div");
                errEl.className = "online-results__state online-results__state--error";
                errEl.textContent = "搜索失败，请稍后重试";
                host.appendChild(errEl);
                return;
            }
            if (!res.ok) {
                host.innerHTML = "";
                const errEl = document.createElement("div");
                errEl.className = "online-results__state online-results__state--error";
                errEl.textContent = "搜索失败，请稍后重试";
                host.appendChild(errEl);
                return;
            }
            const matches = Array.isArray(payload) ? payload.slice(0, 24) : [];
            if (!matches.length) {
                host.innerHTML = "";
                const emptyEl = document.createElement("div");
                emptyEl.className = "online-results__state online-results__state--empty";
                emptyEl.textContent = "未找到相关诗歌，试试其他关键词";
                host.appendChild(emptyEl);
                return;
            }

            host.innerHTML = "";
            const summary = document.createElement("div");
            summary.className = "online-results__summary online-results__summary--count";
            summary.textContent = `找到 ${matches.length} 首诗歌`;
            host.appendChild(summary);

            const list = document.createElement("div");
            list.className = "online-results__list";
            host.appendChild(list);

            matches.forEach((row) => {
                if (!row || typeof row !== "object") return;
                const lyricsFull = onlineHymnLyricsFromRow(row);
                const titleStr = String(row.title || "未命名").trim() || "未命名";

                const card = document.createElement("article");
                card.className = "online-search-card";

                const top = document.createElement("div");
                top.className = "online-search-card__top";

                const titleEl = document.createElement("h3");
                titleEl.className = "online-search-card__title";
                titleEl.textContent = titleStr;

                const importBtn = document.createElement("button");
                importBtn.type = "button";
                importBtn.className = "online-search-card__import";
                importBtn.textContent = "＋ 导入";
                importBtn.addEventListener("click", () => {
                    const song = buildImportedSongFromOnlineRow(row);
                    if (!String(song.lyrics || "").trim()) {
                        showToast("导入失败：歌词为空", importBtn);
                        return;
                    }
                    addNewSong(song, importBtn);
                });

                top.appendChild(titleEl);
                top.appendChild(importBtn);

                const authorEl = document.createElement("div");
                authorEl.className = "online-search-card__author";
                authorEl.textContent = onlineHymnAuthorDisplayFromRow(row);

                const previewWrap = document.createElement("div");
                previewWrap.className = "online-search-card__preview";
                mountOnlineSearchCardPreview(card, previewWrap, lyricsFull);

                const footer = document.createElement("div");
                footer.className = "online-search-card__footer";
                const pagesEl = document.createElement("div");
                pagesEl.className = "online-search-card__pages";
                const pageN = onlineHymnPageEstimateFromLyrics(lyricsFull, 4);
                pagesEl.textContent = `约 ${pageN} 页（按每页 4 行）`;

                const projBtn = document.createElement("button");
                projBtn.type = "button";
                projBtn.className = "online-search-card__proj";
                projBtn.textContent = "📺";
                projBtn.setAttribute("aria-label", "导入并投屏");
                projBtn.title = "导入并投屏";
                projBtn.addEventListener("click", () => importOnlineRowAndProject(row, projBtn));

                footer.appendChild(pagesEl);
                footer.appendChild(projBtn);

                card.appendChild(top);
                card.appendChild(authorEl);
                card.appendChild(previewWrap);
                card.appendChild(footer);
                list.appendChild(card);
            });
        } catch (err) {
            if (err && err.name === "AbortError") return;
            const h = getOnlineSearchResultsHost();
            if (!h) return;
            h.innerHTML = "";
            const errEl = document.createElement("div");
            errEl.className = "online-results__state online-results__state--error";
            errEl.textContent = "搜索失败，请稍后重试";
            h.appendChild(errEl);
        }
    }

    function bindFontOpacitySlider() {
        const rng = $("font-opacity-slider");
        if (!rng || rng.dataset.bound === "1") return;
        rng.dataset.bound = "1";
        rng.addEventListener("input", () => {
            const pct = clamp(Number(rng.value || 100), 20, 100);
            state.ui.fontOpacityPct = pct;
            const fv = $("font-opacity-val");
            if (fv) fv.textContent = String(pct);
            updateAdvSliderSwatches();
            scheduleMiniSliderDomPreview(() => applyMiniPreviewFontOpacityPct(pct));
            scheduleLiveStyleProjectionPush({ fontOpacityPct: pct });
        });
        rng.addEventListener("change", () => {
            state.ui.fontOpacityPct = clamp(Number(rng.value || 100), 20, 100);
            const fv = $("font-opacity-val");
            if (fv) fv.textContent = String(state.ui.fontOpacityPct);
            const song = currentSong();
            if (song) song.fontOpacityPct = state.ui.fontOpacityPct;
            updateAdvSliderSwatches();
            saveSongs();
            updateAll();
        });
    }

    function initFontFamilySelector() {
        const sel = $("font-family-selector");
        if (!sel || !globalThis.WorshipFontData || typeof globalThis.WorshipFontData.populateFontFamilySelect !== "function") {
            return;
        }
        let fixed = false;
        globalThis.WorshipFontData.populateFontFamilySelect(sel, {
            currentValue: state.ui.fontFamily,
            uiForPresetMatch: {
                fontFamily: state.ui.fontFamily,
                fontColor: state.ui.fontColor,
                fontWeight: state.ui.fontWeight
            },
            onMissing: (resolved) => {
                state.ui.fontFamily = resolved;
                fixed = true;
            }
        });
        if (fixed) saveSettings();
    }

    function ensureFontColorControls() {
        if ($("font-color-custom") && !$("font-opacity-slider")) {
            const grp = $("font-color-custom").closest(".setting-group") || $("font-color-custom").closest(".adv-drawer-acc-panel-inner");
            if (grp) {
                const lab = document.createElement("label");
                lab.className = "adv-drawer-field-label";
                lab.setAttribute("for", "font-opacity-slider");
                lab.style.marginTop = "4px";
                lab.innerHTML = '字体透明度 <span id="font-opacity-val">100</span>%';
                const rng = document.createElement("input");
                rng.type = "range";
                rng.id = "font-opacity-slider";
                rng.className = "projection-tint-range";
                rng.min = "20";
                rng.max = "100";
                rng.value = "100";
                rng.step = "1";
                rng.setAttribute("aria-label", "投屏歌词字体透明度");
                grp.insertBefore(lab, $("font-color-custom"));
                grp.insertBefore(rng, $("font-color-custom"));
                bindFontOpacitySlider();
                ensureFontOpacitySwatchLayout();
            }
        }
        if ($("font-color-custom")) {
            ensureFontOpacitySwatchLayout();
            return;
        }
        const slot = $("adv-font-color-slot");
        const panel = $("preview-panel");
        if (!panel) return;
        const group = document.createElement("div");
        group.className = "setting-group";
        group.innerHTML =
            '<label>🎨 字体颜色</label><div id="font-color-chips" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;"></div>' +
            '<div class="adv-drawer-slider-visual-row">' +
            '<span id="font-opacity-swatch" class="adv-slider-swatch adv-slider-swatch--font-opacity" aria-hidden="true"><span class="adv-slider-swatch__glyph">字</span></span>' +
            '<div class="adv-drawer-slider-visual-main">' +
            '<label class="adv-drawer-field-label" for="font-opacity-slider" style="margin-top:4px;">字体透明度 <span id="font-opacity-val">100</span>%</label>' +
            '<input type="range" id="font-opacity-slider" class="projection-tint-range" min="20" max="100" value="100" step="1" aria-label="投屏歌词字体透明度">' +
            "</div></div>" +
            '<input id="font-color-custom" type="text" placeholder="#ffffff" style="width:100%;margin-top:8px;padding:8px;border-radius:10px;border:1px solid var(--border-color);background:var(--editor-bg);color:var(--text-primary);">';
        if (slot) slot.appendChild(group);
        else {
            const target = $("theme-selector")?.closest(".setting-group");
            if (target?.parentElement) target.parentElement.insertBefore(group, target);
            else panel.appendChild(group);
        }
        const colors = [
            "#ffffff",
            "#f5f5f5",
            "#e8e8e8",
            "#d9d9d9",
            "#111111",
            "#fff8e7",
            "#ffe4b5",
            "#ffd54f",
            "#ffd700",
            "#d4af37",
            "#ffb74d",
            "#ff8a65",
            "#ffab91",
            "#ffc0cb",
            "#f48fb1",
            "#e1bee7",
            "#ce93d8",
            "#b39ddb",
            "#90caf9",
            "#80deea",
            "#80cbc4",
            "#a5d6a7",
            "#c5e1a5",
            "#e6ee9c",
            "#fff59d"
        ];
        const chips = $("font-color-chips");
        colors.forEach((c) => {
            const chip = document.createElement("button");
            chip.className = "font-color-chip";
            chip.dataset.color = c;
            chip.style.cssText = `width:22px;height:22px;border-radius:50%;border:2px solid rgba(255,255,255,.35);background:${c};cursor:pointer;`;
            chip.addEventListener("click", () => {
                state.ui.fontColor = c;
                updateUIFromState();
                saveSettings();
                updateSpeakerCards();
                renderMiniPreview();
                scheduleLiveStyleProjectionPush({ fontColor: c });
            });
            chips.appendChild(chip);
        });
        $("font-color-custom")?.addEventListener("change", () => {
            const val = ($("font-color-custom").value || "").trim();
            if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(val)) {
                state.ui.fontColor = val;
                updateUIFromState();
                saveSettings();
                updateSpeakerCards();
                renderMiniPreview();
                scheduleLiveStyleProjectionPush({ fontColor: val });
            } else {
                showToast("请输入有效颜色", $("font-color-custom"));
            }
        });
        bindFontOpacitySlider();
    }

    function ensureProjectionOverlayOpacitySlider() {
        const slot = $("adv-projection-mask-slot");
        const anchor = slot || $("adv-bg-fine-body");
        if (!anchor) return;
        let wrap = anchor.querySelector(".projection-overlay-opacity-field");
        if (!wrap) {
            wrap = document.createElement("div");
            wrap.className = "projection-overlay-opacity-field";
            anchor.appendChild(wrap);
        }
        if (!wrap.querySelector("#projection-overlay-opacity-swatch")) {
            wrap.innerHTML =
                '<div class="adv-drawer-slider-visual-row">' +
                '<span id="projection-overlay-opacity-swatch" class="adv-slider-swatch adv-slider-swatch--mask" aria-hidden="true"></span>' +
                '<div class="adv-drawer-slider-visual-main">' +
                '<label class="adv-drawer-field-label" for="projection-overlay-opacity-slider">蒙版浓度 <span id="projection-overlay-opacity-val">30</span>%</label>' +
                '<input type="range" id="projection-overlay-opacity-slider" class="projection-tint-range" min="0" max="80" value="30" step="1" aria-label="投屏背景蒙版浓度">' +
                "</div></div>";
        }
        const rng = $("projection-overlay-opacity-slider");
        if (rng && rng.dataset.bound !== "1") {
            rng.dataset.bound = "1";
            rng.addEventListener("input", () => {
                const pct = clamp(Number(rng.value || 0), 0, 80);
                state.ui.overlayOpacityPct = pct;
                const ov = $("projection-overlay-opacity-val");
                if (ov) ov.textContent = String(pct);
                updateAdvSliderSwatches();
                scheduleMiniSliderDomPreview(() => applyMiniPreviewProjectionMaskOpacity(pct));
                refreshMonitorContent();
            });
            rng.addEventListener("change", () => {
                state.ui.overlayOpacityPct = clamp(Number(rng.value || 0), 0, 80);
                const ov = $("projection-overlay-opacity-val");
                if (ov) ov.textContent = String(state.ui.overlayOpacityPct);
                const song = currentSong();
                if (song) song.overlayOpacityPct = state.ui.overlayOpacityPct;
                updateAdvSliderSwatches();
                saveSongs();
                updateAll();
            });
        }
    }

    function updateBgImageThumb() {
        const imageOption = document.querySelector('.bg-option[data-bg="image"]');
        if (!imageOption) return;
        if (state.ui.bgImage && state.ui.bgMediaType === "video") {
            imageOption.style.backgroundImage = "none";
            imageOption.style.background = "linear-gradient(145deg,#2a2a3c,#121218)";
            imageOption.style.backgroundSize = "";
            imageOption.style.backgroundPosition = "";
            imageOption.style.borderStyle = "solid";
            imageOption.title = "视频背景";
        } else if (state.ui.bgImage) {
            imageOption.style.background = "";
            imageOption.style.backgroundImage = `url("${state.ui.bgImage}")`;
            imageOption.style.backgroundSize = "cover";
            imageOption.style.backgroundPosition = "center";
            imageOption.style.borderStyle = "solid";
            imageOption.title = "从文件上传";
        } else {
            imageOption.style.background = "";
            imageOption.style.backgroundImage = "";
            imageOption.style.borderStyle = "dashed";
        }
    }

    function updateUIFromState() {
        try {
            document.documentElement.style.setProperty(
                "--worship-app-font-family",
                state.ui.fontFamily || "'Microsoft YaHei','PingFang SC',sans-serif"
            );
        } catch (_e) {
            /* ignore */
        }
        if ($("theme-selector")) $("theme-selector").value = state.ui.theme;
        const fontSel = $("font-family-selector");
        if (fontSel && globalThis.WorshipFontData && typeof globalThis.WorshipFontData.syncFontFamilySelectToState === "function") {
            globalThis.WorshipFontData.syncFontFamilySelectToState(fontSel, state.ui);
        } else if (fontSel) {
            fontSel.value = state.ui.fontFamily;
        }
        const megaEl = $("font-mega-mode");
        if (megaEl) megaEl.checked = !!state.ui.fontMegaMode;
        const fmax = getLyricFontSliderMax();
        if ($("font-slider")) {
            $("font-slider").min = "8";
            $("font-slider").max = String(fmax);
            $("font-slider").value = String(clamp(Number(state.ui.fontSize) || 60, 8, fmax));
        }
        state.ui.fontSize = clamp(Number(state.ui.fontSize) || 60, 8, fmax);
        if ($("font-val")) $("font-val").textContent = String(state.ui.fontSize);
        if ($("default-lines-input")) $("default-lines-input").value = String(state.ui.defaultLines);
        if ($("pos-slider")) $("pos-slider").value = String(state.ui.posY);
        if ($("pos-val")) $("pos-val").textContent = String(state.ui.posY);
        if ($("projection-overlay-opacity-slider")) {
            $("projection-overlay-opacity-slider").value = String(
                clamp(Number(state.ui.overlayOpacityPct), 0, 80)
            );
        }
        if ($("projection-overlay-opacity-val")) {
            $("projection-overlay-opacity-val").textContent = String(
                clamp(Number(state.ui.overlayOpacityPct), 0, 80)
            );
        }
        if ($("font-opacity-slider")) {
            $("font-opacity-slider").value = String(clamp(Number(state.ui.fontOpacityPct), 20, 100));
        }
        if ($("font-opacity-val")) {
            $("font-opacity-val").textContent = String(clamp(Number(state.ui.fontOpacityPct), 20, 100));
        }
        document.body.setAttribute("data-theme", state.ui.theme);
        updateBgImageThumb();
        if ($("font-color-custom")) $("font-color-custom").value = state.ui.fontColor;
        document.querySelectorAll(".font-color-chip").forEach((chip) => {
            chip.classList.toggle("active", chip.dataset.color === state.ui.fontColor);
        });
        document.querySelectorAll(".bg-option").forEach((node) => {
            node.classList.toggle("active", node.getAttribute("data-bg") === state.ui.bgType);
        });
        syncThemeBgOpacityControls();
        updateMyBackgroundThumbActiveState();
        const lh = String(
            getComputedStyle(document.documentElement).getPropertyValue("--adv-preview-line-height") || "1.65"
        ).trim();
        if ($("adv-preview-line-height")) $("adv-preview-line-height").value = lh || "1.65";
        const mr = parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue("--adv-mini-readability") || "0"
        );
        if ($("adv-lyric-overlay-opacity") && Number.isFinite(mr)) {
            $("adv-lyric-overlay-opacity").value = String(clamp(Math.round(mr * 100), 0, 55));
        }
        const blurPx = parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue("--adv-mini-blur-px") || "0"
        );
        if ($("adv-lyric-layer-blur") && Number.isFinite(blurPx)) {
            $("adv-lyric-layer-blur").value = String(clamp(Math.round(blurPx), 0, 20));
        }
        if ($("text-stroke-slider")) $("text-stroke-slider").value = String(clamp(Number(state.ui.textStrokePx), 0, 6));
        if ($("text-stroke-val")) $("text-stroke-val").textContent = String(clamp(Number(state.ui.textStrokePx), 0, 6));
        if ($("vignette-shape-select")) $("vignette-shape-select").value = state.ui.vignetteShape === "ellipse" ? "ellipse" : "circle";
        if ($("vignette-center-slider")) {
            $("vignette-center-slider").value = String(clamp(Number(state.ui.vignetteCenterBrightness), -50, 50));
        }
        if ($("vignette-center-val")) {
            $("vignette-center-val").textContent = String(clamp(Number(state.ui.vignetteCenterBrightness), -50, 50));
        }
        if ($("vignette-edge-slider")) {
            $("vignette-edge-slider").value = String(clamp(Number(state.ui.vignetteEdgeDarkness), 0, 90));
        }
        if ($("vignette-edge-val")) {
            $("vignette-edge-val").textContent = String(clamp(Number(state.ui.vignetteEdgeDarkness), 0, 90));
        }
        if ($("page-transition-select")) {
            $("page-transition-select").value = canonicalPageTransition(state.ui.pageTransition);
        }
        const psp = clamp(Math.round(Number(state.ui.pageTransitionSpeed) * 10) / 10, 0.3, 1.5);
        if ($("page-transition-speed-slider")) $("page-transition-speed-slider").value = String(psp);
        if ($("page-transition-speed-val")) $("page-transition-speed-val").textContent = psp.toFixed(1);
        ensureFontOpacitySwatchLayout();
        updateAdvSliderSwatches();
        updateCloudUploadBtnState();
        try {
            syncGlobalProjectionUiFallback();
        } catch (_e) {
            /* ignore */
        }
        scheduleFitLyricEditorFont();
        syncAdvSliderRecommendedTicks();
    }

    const ADV_ACC_STORAGE_KEY = "adv-drawer-accordion-v1";

    function readAdvAccordionState() {
        try {
            const raw = localStorage.getItem(ADV_ACC_STORAGE_KEY);
            const o = raw ? JSON.parse(raw) : null;
            return o && typeof o === "object" ? o : null;
        } catch {
            return null;
        }
    }

    function writeAdvAccordionState(map) {
        try {
            localStorage.setItem(ADV_ACC_STORAGE_KEY, JSON.stringify(map));
        } catch {
            /* ignore quota */
        }
    }

    function initAdvDrawerAccordion() {
        const stored = readAdvAccordionState() || {};
        document.querySelectorAll("[data-adv-acc]").forEach((section) => {
            const id = section.getAttribute("data-adv-acc-id");
            if (!id) return;
            const trig = section.querySelector(".adv-drawer-acc-trigger");
            if (!trig) return;
            const open = stored[id] !== false;
            section.classList.toggle("is-open", open);
            trig.setAttribute("aria-expanded", open ? "true" : "false");

            if (trig.dataset.accBound === "1") return;
            trig.dataset.accBound = "1";
            trig.addEventListener("click", () => {
                const willOpen = !section.classList.contains("is-open");
                section.classList.toggle("is-open", willOpen);
                trig.setAttribute("aria-expanded", willOpen ? "true" : "false");
                const next = { ...(readAdvAccordionState() || {}) };
                next[id] = willOpen;
                writeAdvAccordionState(next);
            });
        });
    }

    function buildLiveState() {
        const preLyrics = getLyricsSourceStringForPaging();
        syncEditorToSong();
        const song = currentSong();
        const pages = splitPages(
            mergeLyricsPagingSnapshot(preLyrics, getLyricsSourceStringForPaging()),
            state.ui.defaultLines
        );
        state.currentPage = clamp(state.currentPage, 0, pages.length - 1);
        const fadeNow = !!state.playlist.fadeNext;
        state.playlist.fadeNext = false;
        const overlayPct = clamp(Number(state.ui.overlayOpacityPct), 0, 80);
        const fontOpPct = clamp(Number(state.ui.fontOpacityPct), 20, 100);
        const base = {
            version: 1,
            updatedAt: Date.now(),
            songId: song?.id || "",
            title: song?.title || "",
            fontColor: state.ui.fontColor || "#ffffff",
            overlayOpacityPct: overlayPct,
            fontOpacityPct: fontOpPct,
            playlistFade: fadeNow,
            pages,
            pageIndex: state.currentPage,
            text: {
                fontFamily: state.ui.fontFamily,
                fontSize: clampLyricFontSize(state.ui.fontSize),
                fontWeight: state.ui.fontWeight == null || state.ui.fontWeight === "" ? "700" : String(state.ui.fontWeight),
                topPct: state.ui.posY,
                color: state.ui.bgType === "solid-white" ? "#111" : state.ui.fontColor,
                strokePx: clamp(Number(state.ui.textStrokePx), 0, 6)
            },
            pageTransition: canonicalPageTransition(state.ui.pageTransition),
            pageTransitionSpeed:
                Math.round(clamp(Number(state.ui.pageTransitionSpeed), 0.3, 1.5) * 10) / 10,
            vignetteShape: state.ui.vignetteShape === "ellipse" ? "ellipse" : "circle",
            vignetteCenterBrightness: clamp(Number(state.ui.vignetteCenterBrightness), -50, 50),
            vignetteEdgeDarkness: clamp(Number(state.ui.vignetteEdgeDarkness), 0, 90),
            background: {
                type: state.ui.bgType,
                imageData: state.ui.bgImage,
                mediaType: state.ui.bgType === "image" && state.ui.bgMediaType === "video" ? "video" : "image"
            },
            worshipFlow: song?.leaderWorshipFlow || null
        };
        if (projectionDisplayOverlay && projectionDisplayOverlay.kind === "verse") {
            const raw = projectionDisplayOverlay.lines;
            const versePages = Array.isArray(raw) && raw.length
                ? raw.map((line) => (Array.isArray(line) ? line : [String(line || "")]))
                : [["你们要赞美耶和华！"]];
            base.pages = versePages;
            base.pageIndex = 0;
            base.background = {
                type: projectionDisplayOverlay.bgType || "solid-black",
                imageData: "",
                mediaType: "image"
            };
        }
        return base;
    }

    function respondCurrentState() {
        if (!channel) return;
        pushLiveStateToProjectionClients(buildLiveState());
    }

    function broadcastState() {
        /** 勿调用旧的 globalThis.broadcastState（router 存根会写死字体并污染 LIVE / 投屏）；此处为唯一权威广播 */
        liveState = buildLiveState();
        if (typeof globalThis !== "undefined") globalThis.worshipLiveState = liveState;
        try {
            persistAdvPreviewCssVars();
        } catch (_) {
            /* ignore */
        }
        try {
            saveSongs();
            saveSettings();
        } catch (err) {
            console.warn("broadcastState persist songs/settings", err);
        }
        try {
            syncGlobalProjectionUiFallback();
        } catch (_e) {
            /* ignore */
        }
        try {
            refreshMonitorContent(undefined, liveState);
        } catch (_) {
            /* ignore */
        }
        return liveState;
    }

    /** 与 js/ui.js 中 renderDisplayLyric 的 fallback（__projectionUi）对齐，避免 payload 缺字段时退回雅黑 */
    function syncGlobalProjectionUiFallback() {
        try {
            const u = globalThis.__projectionUi;
            if (!u || typeof u !== "object") return;
            u.fontFamily = state.ui.fontFamily;
            u.fontSize = state.ui.fontSize;
            u.fontColor = state.ui.fontColor;
            u.posY = state.ui.posY;
            u.bgType = state.ui.bgType;
        } catch (_e) {
            /* ignore */
        }
    }
    try {
        globalThis.__worshipAppBroadcastState = broadcastState;
        globalThis.broadcastState = broadcastState;
    } catch (_e) {
        /* ignore */
    }

    const MONITOR_RECT_LS_KEY = "worship_projection_preview_monitor_rect_v1";
    const MONITOR_COLLAPSED_LS_KEY = "worship_projection_preview_monitor_collapsed_v1";
    /** 监视窗按此画布铺版再整体缩放，使 px 字号与全屏投屏上的视觉比例一致；页面画廊卡片歌词按同一 1920 参考宽度比例缩放 */
    const MONITOR_STAGE_REF_W = 1920;
    const MONITOR_STAGE_REF_H = 1080;
    const MONITOR_CONTENT_ASPECT = MONITOR_STAGE_REF_W / MONITOR_STAGE_REF_H;

    /**
     * 将监视窗外框调整为：内容区（#monitor-content）严格 16:9，与投屏画布比例一致，避免 contain 缩放产生的黑边。
     * reqTotalW/H 为用户拖拽期望的大致外框尺寸（含标题栏）。
     */
    function normalizeProjectionMonitorFrame(el, reqTotalW, reqTotalH) {
        if (!el) return;
        if (el.classList.contains("is-monitor-collapsed")) {
            el.style.width = "auto";
            el.style.height = "auto";
            el.style.maxHeight = "";
            return;
        }
        const header = el.querySelector("#monitor-header") || $("monitor-header");
        const hh = header ? header.offsetHeight : 40;
        const minContentW = 160;
        const minContentH = 90;
        const minTotalH = hh + minContentH;
        const maxW = Math.max(minContentW, window.innerWidth - 16);
        const maxH = Math.max(minTotalH, window.innerHeight - 16);
        let nw = clamp(Number(reqTotalW) || minContentW, minContentW, maxW);
        let nh = clamp(Number(reqTotalH) || minTotalH, minTotalH, maxH);
        let cw = nw;
        let ch = cw / MONITOR_CONTENT_ASPECT;
        let totalH = hh + ch;
        if (totalH > nh) {
            ch = Math.max(minContentH, nh - hh);
            cw = ch * MONITOR_CONTENT_ASPECT;
        }
        cw = clamp(cw, minContentW, maxW);
        el.style.width = `${Math.round(cw)}px`;
        /** 高度由 #monitor-content 的 aspect-ratio 与标题栏自动撑起，避免与 16:9 差 1px 再出现细黑边 */
        el.style.height = "auto";
    }

    function layoutMonitorPreviewScale() {
        if (isDisplay || isLeader) return;
        const host = $("projection-preview-monitor");
        if (host && host.classList.contains("is-monitor-collapsed")) return;
        const content = $("monitor-content");
        const stage = $("monitor-preview-stage");
        if (!content || !stage) return;
        const cw = Math.max(1, content.clientWidth);
        const ch = Math.max(1, content.clientHeight);
        /** 内容区为 16:9；用 min 吸收取整误差，避免画布超出产生裁切闪烁 */
        const s = Math.min(cw / MONITOR_STAGE_REF_W, ch / MONITOR_STAGE_REF_H);
        stage.style.transform = `scale(${s})`;
    }

    function setProjectionMonitorCollapsedUi(el, collapsed) {
        if (!el) return;
        const btn = $("monitor-collapse-btn");
        el.classList.toggle("is-monitor-collapsed", !!collapsed);
        if (btn) {
            btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
            btn.textContent = collapsed ? "▸" : "▾";
        }
        try {
            localStorage.setItem(MONITOR_COLLAPSED_LS_KEY, collapsed ? "1" : "0");
        } catch (_) {
            /* ignore */
        }
        if (collapsed) {
            el.style.width = "auto";
            el.style.height = "auto";
            el.style.maxHeight = "";
        }
    }

    function collapseProjectionMonitorFromUi() {
        const el = $("projection-preview-monitor");
        if (!el || el.classList.contains("is-monitor-collapsed")) return;
        persistProjectionMonitorRect();
        setProjectionMonitorCollapsedUi(el, true);
    }

    function expandProjectionMonitorFromUi() {
        const el = $("projection-preview-monitor");
        if (!el || !el.classList.contains("is-monitor-collapsed")) return;
        setProjectionMonitorCollapsedUi(el, false);
        let w = 280;
        let h = 220;
        try {
            const raw = localStorage.getItem(MONITOR_RECT_LS_KEY);
            const o = raw ? JSON.parse(raw) : null;
            if (o && typeof o === "object") {
                if (Number.isFinite(Number(o.width))) w = Number(o.width);
                if (Number.isFinite(Number(o.height))) h = Number(o.height);
            }
        } catch (_) {
            /* ignore */
        }
        normalizeProjectionMonitorFrame(el, w, h);
        layoutMonitorPreviewScale();
        refreshMonitorContent();
    }

    function toggleProjectionMonitorCollapsed() {
        const el = $("projection-preview-monitor");
        if (!el) return;
        if (el.classList.contains("is-monitor-collapsed")) expandProjectionMonitorFromUi();
        else collapseProjectionMonitorFromUi();
    }

    /** 拖动字号/位置/颜色时复用已有 LIVE 快照，避免每次 buildLiveState 重算分页导致投屏卡顿 */
    function getProjectionSnapshotBase() {
        if (liveState && Array.isArray(liveState.pages) && liveState.pages.length) {
            return {
                ...liveState,
                text: { ...(liveState.text || {}) },
                background: liveState.background ? { ...liveState.background } : liveState.background
            };
        }
        return buildLiveState();
    }

    function mergeMonitorProjectionSnapshot(overrides, baseSnap) {
        const snap =
            baseSnap && typeof baseSnap === "object"
                ? { ...baseSnap, text: { ...(baseSnap.text || {}) } }
                : getProjectionSnapshotBase();
        if (!overrides || typeof overrides !== "object" || !Object.keys(overrides).length) return snap;
        const o = overrides;
        const text = { ...(snap.text || {}) };
        if (o.fontSize != null) text.fontSize = clampLyricFontSize(o.fontSize);
        if (o.posY != null) text.topPct = clamp(Number(o.posY), 20, 70);
        if (o.textStrokePx != null) text.strokePx = clamp(Number(o.textStrokePx), 0, 6);
        if (o.fontColor != null) {
            const c = String(o.fontColor).trim();
            snap.fontColor = c;
            const bgType = snap.background?.type || state.ui.bgType;
            text.color = bgType === "solid-white" ? "#111" : c;
        }
        let fontOpacityPct = snap.fontOpacityPct;
        if (o.fontOpacityPct != null) fontOpacityPct = clamp(Number(o.fontOpacityPct), 20, 100);
        return { ...snap, text, fontOpacityPct };
    }

    let _liveStylePushRaf = 0;
    let _liveStyleOverrides = null;

    /** 合并同一帧内的多次滑块 input，轻量推送到真实投屏窗口 */
    function scheduleLiveStyleProjectionPush(overrides) {
        if (!overrides || typeof overrides !== "object") return;
        _liveStyleOverrides = _liveStyleOverrides
            ? { ..._liveStyleOverrides, ...overrides }
            : { ...overrides };
        if (_liveStylePushRaf) return;
        _liveStylePushRaf = requestAnimationFrame(() => {
            _liveStylePushRaf = 0;
            const o = _liveStyleOverrides;
            _liveStyleOverrides = null;
            refreshMonitorContent(o, null, { persist: false, styleOnly: true });
        });
    }

    /** 与 refreshMonitorContent 使用同一套 merge 快照，保证监视窗 / 页面画廊 / 真实投屏窗口同源 */
    function pushLiveStateToProjectionClients(snap, pushOpts) {
        if (isDisplay || isLeader) return;
        if (!snap || typeof snap !== "object" || !snap.pages) return;
        const persist = !(pushOpts && pushOpts.persist === false);
        const styleOnly = !!(pushOpts && pushOpts.styleOnly);
        liveState = snap;
        if (typeof globalThis !== "undefined") globalThis.worshipLiveState = liveState;
        if (persist) {
            try {
                setStore(STORAGE.LIVE, liveState);
            } catch (err) {
                console.warn("pushLiveStateToProjectionClients setStore LIVE", err);
            }
        }
        if (channel) {
            try {
                channel.postMessage({
                    type: "update",
                    payload: liveState,
                    source: "main",
                    styleOnly
                });
            } catch (err) {
                console.warn("pushLiveStateToProjectionClients channel", err);
            }
        }
    }

    function ensureMonitorPreviewLayers(content) {
        const stage = content.querySelector("#monitor-preview-stage");
        const lyr = stage?.querySelector("#monitor-lyric-layer");
        const videoEl = content.querySelector("#monitor-video-bg");
        const bgEl = content.querySelector(".monitor-preview-bg-layer");
        const mask = content.querySelector(".monitor-preview-bg-mask");
        const vig = content.querySelector(".monitor-preview-vignette");
        if (stage && lyr && videoEl && bgEl && mask && vig) {
            return { bgEl, videoEl, mask, vig, lyr, stage };
        }
        content.innerHTML = "";
        const scaler = document.createElement("div");
        scaler.id = "monitor-preview-scaler";
        const nStage = document.createElement("div");
        nStage.id = "monitor-preview-stage";
        const W = MONITOR_STAGE_REF_W;
        const H = MONITOR_STAGE_REF_H;
        nStage.style.cssText = `position:absolute;left:50%;top:50%;width:${W}px;height:${H}px;margin-left:${-W / 2}px;margin-top:${-H / 2}px;transform-origin:center center;box-sizing:border-box;`;
        const nBg = document.createElement("div");
        nBg.className = "monitor-preview-bg-layer projection-css-bg-fill";
        const nVid = document.createElement("video");
        nVid.id = "monitor-video-bg";
        nVid.setAttribute("muted", "");
        nVid.muted = true;
        nVid.defaultMuted = true;
        nVid.loop = true;
        nVid.playsInline = true;
        nVid.setAttribute("playsinline", "");
        nVid.setAttribute("aria-hidden", "true");
        nVid.style.cssText =
            "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center;z-index:0;display:none;pointer-events:none;";
        const nMask = document.createElement("div");
        nMask.className = "monitor-preview-bg-mask";
        const nVig = document.createElement("div");
        nVig.className = "monitor-preview-vignette";
        const nLyr = document.createElement("div");
        nLyr.id = "monitor-lyric-layer";
        nStage.appendChild(nBg);
        nStage.appendChild(nVid);
        nStage.appendChild(nMask);
        nStage.appendChild(nVig);
        nStage.appendChild(nLyr);
        scaler.appendChild(nStage);
        content.appendChild(scaler);
        return { bgEl: nBg, videoEl: nVid, mask: nMask, vig: nVig, lyr: nLyr, stage: nStage };
    }

    /** 监视窗歌词 DOM 是否与当前页一致（用于拖动字号/位置等时跳过 innerHTML，减少闪烁） */
    function monitorLyricDomStructureSig(songId, pageIdx, lines, strokeAttr) {
        const arr = Array.isArray(lines) ? lines : [];
        return (
            `${String(songId || "")}\x1d${String(pageIdx)}\x1d` +
            arr.map((x) => String(x ?? "")).join("\x1e") +
            "\x1f" +
            String(strokeAttr || "")
        );
    }

    function refreshMonitorContent(overrides, snapshot, pushOpts) {
        if (isDisplay || isLeader) return;
        const snap = mergeMonitorProjectionSnapshot(overrides, snapshot);
        pushLiveStateToProjectionClients(snap, pushOpts);
        const host = $("projection-preview-monitor");
        const content = $("monitor-content");
        if (!host || !content) return;
        const pages = snap.pages || [];
        const idx = clamp(snap.pageIndex || 0, 0, Math.max(0, pages.length - 1));
        const lines = pages[idx] || [];
        const t = snap.text || {};
        const fontColor = snap.fontColor || t.color || "#ffffff";
        const fontOp = clamp(Number(snap.fontOpacityPct ?? 100), 20, 100) / 100;
        const lightBg = fontColor === "#111" || (t.color || "") === "#111";
        const strokeAttr = lyricStrokeHtmlAttrFromContext({
            textStrokePx: t.strokePx,
            lightBg
        });
        const lh = getAdvPreviewLineHeightNumber();

        const { bgEl, videoEl, mask, vig, lyr } = ensureMonitorPreviewLayers(content);
        if (!bgEl || !videoEl || !mask || !vig || !lyr) return;

        const bgState = snap.background || {};
        const type = bgState.type || "solid-black";
        const urlForMedia = String(bgState.imageData || "");
        let mediaType = bgState.mediaType;
        if (mediaType !== "video" && mediaType !== "image") {
            mediaType = inferMediaTypeFromDataUrl(urlForMedia);
        }
        if (!mediaType) mediaType = "image";
        const isVideoBg = type === "image" && mediaType === "video" && !!bgState.imageData;

        clearCssDynamicBgClass(bgEl);
        bgEl.style.background = "#000";
        bgEl.style.backgroundImage = "none";

        if (isVideoBg) {
            videoEl.style.display = "block";
            const want = String(bgState.imageData || "");
            if (videoEl.dataset.worshipBgUrl !== want) {
                videoEl.dataset.worshipBgUrl = want;
                videoEl.src = want;
                void videoEl.play().catch(() => {});
            } else if (videoEl.paused) {
                void videoEl.play().catch(() => {});
            }
        } else {
            videoEl.pause();
            videoEl.removeAttribute("src");
            delete videoEl.dataset.worshipBgUrl;
            try {
                videoEl.load();
            } catch (_e) {
                /* ignore */
            }
            videoEl.style.display = "none";
            if (CSS_DYNAMIC_BG_TYPES.has(type)) {
                bgEl.style.background = "";
                bgEl.classList.add(`css-bg-${type}`);
            } else if (type === "solid-white") {
                bgEl.style.background = "#fff";
            } else if (type === "solid-gray") {
                bgEl.style.background = "#444";
            } else if (type === "gradient") {
                bgEl.style.background = "linear-gradient(135deg,#1a2f59,#0a0f1d)";
            } else if (type === "image" && bgState.imageData) {
                bgEl.style.backgroundImage = `url("${bgState.imageData}")`;
                bgEl.style.backgroundSize = "cover";
                bgEl.style.backgroundPosition = "center";
            } else {
                bgEl.style.background = "#000";
            }
        }

        const maskOp = clamp(Number(snap.overlayOpacityPct ?? 30), 0, 80) / 100;
        mask.style.background = `rgba(0,0,0,${maskOp})`;

        applyRadialVignetteToLayer(vig, snap);

        lyr.style.top = `${projectionTextTopPctFromLive(t)}%`;
        const monFf = (t.fontFamily && String(t.fontFamily).trim()) || state.ui.fontFamily;
        lyr.style.fontFamily = monFf;
        lyr.style.fontSize = `${clampLyricFontSize(Number(t.fontSize) || 60)}px`;
        lyr.style.fontWeight =
            t.fontWeight != null && t.fontWeight !== ""
                ? String(t.fontWeight)
                : String(state.ui.fontWeight || "700");
        lyr.style.color = fontColor;
        lyr.style.lineHeight = String(lh);
        lyr.style.opacity = "1";

        let anim = lyr.querySelector("#monitor-lyric-anim");
        if (!anim) {
            anim = document.createElement("div");
            anim.id = "monitor-lyric-anim";
            anim.style.cssText = "width:100%;transform-origin:center center;";
            while (lyr.firstChild) anim.appendChild(lyr.firstChild);
            lyr.appendChild(anim);
        }

        const curSid = String(snap.songId ?? "");
        const lyricDomSig = monitorLyricDomStructureSig(curSid, idx, lines, strokeAttr);
        const fillMonitorLyricInner = () => {
            const buildRow =
                typeof globalThis.buildLyricRowHtmlForProjectionLine === "function"
                    ? globalThis.buildLyricRowHtmlForProjectionLine
                    : (line, attr) => `<div class="monitor-lyric-line"${attr}>${escapeHtml(line)}</div>`;
            anim.innerHTML = lines.map((line) => buildRow(line, strokeAttr, "monitor-lyric-line")).join("");
            anim.querySelectorAll(".monitor-lyric-line").forEach((row) => {
                row.style.fontFamily = monFf;
            });
            try {
                host.dataset.monitorLyricDomSig = lyricDomSig;
            } catch (_e) {
                /* ignore */
            }
        };

        const transEff = canonicalPageTransition(snap.pageTransition);
        const durTrans = clamp(Number(snap.pageTransitionSpeed), 0.3, 1.5);
        const prevP = host.dataset.monitorLastPage;
        const prevS = host.dataset.monitorLastSongId;
        const navChanged =
            prevP !== undefined &&
            (String(prevP) !== String(idx) || String(prevS || "") !== curSid);
        const shouldTrans =
            navChanged &&
            !snap.playlistFade &&
            !projectionDisplayIsVideoBackground(snap) &&
            transEff !== "none";

        const finishMonitorNavState = () => {
            host.dataset.monitorLastPage = String(idx);
            host.dataset.monitorLastSongId = curSid;
        };

        const applyStaticLyricPresentation = () => {
            flushMonitorLyricTrans();
            const patchTypographyOnly =
                !shouldTrans &&
                anim &&
                anim.querySelector(".monitor-lyric-line") &&
                host.dataset.monitorLyricDomSig === lyricDomSig;
            if (!patchTypographyOnly) {
                fillMonitorLyricInner();
            }
            anim.style.transition = "none";
            anim.style.opacity = String(fontOp);
            anim.style.transform = "";
            finishMonitorNavState();
            layoutMonitorPreviewScale();
        };

        if (!shouldTrans) {
            applyStaticLyricPresentation();
        } else {
            layoutMonitorPreviewScale();
            runMonitorLyricExitThen(anim, transEff, durTrans, () => {
                fillMonitorLyricInner();
                runMiniPageTransitionEnter(anim, transEff, durTrans, snap.fontOpacityPct);
                finishMonitorNavState();
                layoutMonitorPreviewScale();
            });
        }
    }

    function persistProjectionMonitorRect() {
        const el = $("projection-preview-monitor");
        if (!el) return;
        try {
            const r = el.getBoundingClientRect();
            let o = {};
            try {
                const raw = localStorage.getItem(MONITOR_RECT_LS_KEY);
                const p = raw ? JSON.parse(raw) : null;
                if (p && typeof p === "object") o = { ...p };
            } catch (_) {
                /* ignore */
            }
            o.left = r.left;
            o.top = r.top;
            if (!el.classList.contains("is-monitor-collapsed")) {
                o.width = r.width;
                o.height = r.height;
            } else if (!Number.isFinite(Number(o.width)) || Number(o.width) < 160) {
                o.width = 280;
                o.height = 220;
            }
            localStorage.setItem(MONITOR_RECT_LS_KEY, JSON.stringify(o));
        } catch (_) {
            /* ignore */
        }
    }

    function restoreProjectionMonitorRect(el) {
        if (!el) return;
        try {
            const raw = localStorage.getItem(MONITOR_RECT_LS_KEY);
            if (!raw) return;
            const o = JSON.parse(raw);
            if (!o || typeof o !== "object") return;
            const w = Number(o.width);
            const h = Number(o.height);
            const l = Number(o.left);
            const t = Number(o.top);
            if (Number.isFinite(w) && Number.isFinite(h) && w >= 160 && h >= 100) {
                el.style.width = `${clamp(w, 160, Math.max(160, window.innerWidth - 8))}px`;
                el.style.height = "auto";
            }
            if (Number.isFinite(l) && Number.isFinite(t)) {
                el.style.left = `${clamp(l, 0, Math.max(0, window.innerWidth - 48))}px`;
                el.style.top = `${clamp(t, 0, Math.max(0, window.innerHeight - 48))}px`;
                el.style.right = "auto";
                el.style.bottom = "auto";
            }
        } catch (_) {
            /* ignore */
        }
    }

    function initProjectionPreviewMonitor() {
        if (isDisplay || isLeader) return;
        const el = $("projection-preview-monitor");
        const header = $("monitor-header");
        const handle = $("monitor-resize-handle");
        if (!el || !header || !handle) return;
        if (el.dataset.monitorBound === "1") return;
        el.dataset.monitorBound = "1";

        restoreProjectionMonitorRect(el);
        let monCollapsed = false;
        try {
            monCollapsed = localStorage.getItem(MONITOR_COLLAPSED_LS_KEY) === "1";
        } catch (_) {
            /* ignore */
        }
        if (monCollapsed) {
            setProjectionMonitorCollapsedUi(el, true);
        } else {
            const r0 = el.getBoundingClientRect();
            normalizeProjectionMonitorFrame(el, r0.width, r0.height);
        }

        const cbtn = $("monitor-collapse-btn");
        if (cbtn && cbtn.dataset.monitorCollapseBound !== "1") {
            cbtn.dataset.monitorCollapseBound = "1";
            const stopProp = (e) => e.stopPropagation();
            cbtn.addEventListener("mousedown", stopProp);
            cbtn.addEventListener("touchstart", stopProp, { passive: false });
            cbtn.addEventListener("click", (e) => {
                e.stopPropagation();
                e.preventDefault();
                toggleProjectionMonitorCollapsed();
            });
        }

        let drag = null;
        const onMove = (e) => {
            if (!drag) return;
            const cx = e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX;
            const cy = e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY;
            if (drag.mode === "move") {
                const nx = cx - drag.dx;
                const ny = cy - drag.dy;
                el.style.left = `${clamp(nx, 0, Math.max(0, window.innerWidth - 48))}px`;
                el.style.top = `${clamp(ny, 0, Math.max(0, window.innerHeight - 48))}px`;
                el.style.right = "auto";
                el.style.bottom = "auto";
            } else if (drag.mode === "size") {
                const headerEl = el.querySelector("#monitor-header") || $("monitor-header");
                const hh = headerEl ? headerEl.offsetHeight : 40;
                const minNH = Math.max(100, Math.ceil(hh + 90));
                const nw = clamp(drag.startW + (cx - drag.startX), 160, Math.max(160, window.innerWidth - 16));
                const nh = clamp(drag.startH + (cy - drag.startY), minNH, Math.max(minNH, window.innerHeight - 16));
                el.style.maxHeight = "";
                normalizeProjectionMonitorFrame(el, nw, nh);
            }
        };
        const onUp = () => {
            if (!drag) return;
            drag = null;
            el.classList.remove("is-monitor-dragging", "is-monitor-resizing");
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            window.removeEventListener("touchmove", onMove);
            window.removeEventListener("touchend", onUp);
            window.removeEventListener("touchcancel", onUp);
            persistProjectionMonitorRect();
            refreshMonitorContent();
        };

        const startMove = (e) => {
            if (e.pointerType !== "touch" && e.button != null && e.button !== 0) return;
            const rect = el.getBoundingClientRect();
            const cx = e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX;
            const cy = e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY;
            el.style.left = `${rect.left}px`;
            el.style.top = `${rect.top}px`;
            el.style.right = "auto";
            el.style.bottom = "auto";
            drag = { mode: "move", dx: cx - rect.left, dy: cy - rect.top };
            el.classList.add("is-monitor-dragging");
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
            window.addEventListener("touchmove", onMove, { passive: false });
            window.addEventListener("touchend", onUp);
            window.addEventListener("touchcancel", onUp);
            e.preventDefault();
        };

        const startSize = (e) => {
            if (e.pointerType !== "touch" && e.button != null && e.button !== 0) return;
            e.stopPropagation();
            const rect = el.getBoundingClientRect();
            const cx = e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX;
            const cy = e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY;
            el.style.left = `${rect.left}px`;
            el.style.top = `${rect.top}px`;
            el.style.width = `${rect.width}px`;
            el.style.height = "auto";
            el.style.maxHeight = "";
            el.style.right = "auto";
            el.style.bottom = "auto";
            drag = { mode: "size", startX: cx, startY: cy, startW: rect.width, startH: rect.height };
            el.classList.add("is-monitor-resizing");
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
            window.addEventListener("touchmove", onMove, { passive: false });
            window.addEventListener("touchend", onUp);
            window.addEventListener("touchcancel", onUp);
            e.preventDefault();
        };

        const titleEl = el.querySelector(".monitor-header-title");
        const dragHost = titleEl || header;
        dragHost.addEventListener("mousedown", startMove);
        dragHost.addEventListener("touchstart", startMove, { passive: false });
        handle.addEventListener("mousedown", startSize);
        handle.addEventListener("touchstart", startSize, { passive: false });

        const mc = $("monitor-content");
        if (mc && typeof ResizeObserver !== "undefined" && !initProjectionPreviewMonitor._ro) {
            initProjectionPreviewMonitor._ro = new ResizeObserver(() => layoutMonitorPreviewScale());
            initProjectionPreviewMonitor._ro.observe(mc);
        }
        if (!initProjectionPreviewMonitor._winResize) {
            initProjectionPreviewMonitor._winResize = true;
            window.addEventListener("resize", () => layoutMonitorPreviewScale(), { passive: true });
        }
        layoutMonitorPreviewScale();
    }

    /** 避免 localStorage 配额/序列化异常阻断投屏等关键路径 */
    function safeBroadcastState(reason) {
        try {
            broadcastState();
        } catch (err) {
            console.warn(reason || "broadcastState", err);
        }
    }

    /** 与当前页面同源解析，避免相对路径在部分部署下解析错误 */
    function projectionEntryUrl(kind) {
        const q = kind === "leader" ? "leader=1" : "display=1";
        try {
            return new URL(`./index.html?${q}`, location.href).href;
        } catch (_e) {
            return `./index.html?${q}`;
        }
    }

    /** 手机扫码用：本地 file / localhost 无法被另一台设备打开，可让用户填写局域网 http 根地址 */
    const LEADER_QR_BASE_LS_KEY = "worship.leaderJoinBaseUrl.v1";

    function hostnameLooksPrivateOrLocal(host) {
        const h = String(host || "").toLowerCase();
        if (!h || h === "localhost" || h === "[::1]") return true;
        if (h === "127.0.0.1") return true;
        if (h.endsWith(".local")) return true;
        const parts = h.split(".");
        if (parts.length === 4) {
            const a = parseInt(parts[0], 10);
            const b = parseInt(parts[1], 10);
            if (a === 10) return true;
            if (a === 127) return true;
            if (a === 192 && b === 168) return true;
            if (a === 172 && b >= 16 && b <= 31) return true;
            if (a === 169 && b === 254) return true;
        }
        return false;
    }

    /** 从当前页推导「站点根」（仅当 https 且非公网保留地址时可用，便于 GitHub Pages 等一键扫码跨网） */
    function derivePublicHttpsLeaderJoinBaseFromLocation() {
        try {
            const u = new URL(location.href);
            if (u.protocol !== "https:") return "";
            if (hostnameLooksPrivateOrLocal(u.hostname)) return "";
            let path = u.pathname || "/";
            if (/\.html?$/i.test(path)) path = path.replace(/[^/]+$/i, "");
            if (!path.endsWith("/")) path += "/";
            return u.origin + path;
        } catch (_e) {
            return "";
        }
    }

    function resolveLeaderJoinUrlForQr() {
        const pageJoin = projectionEntryUrl("leader");
        let pageAbs;
        try {
            pageAbs = new URL(pageJoin, location.href).href;
        } catch (_e) {
            pageAbs = pageJoin;
        }
        let custom = "";
        try {
            custom = String(localStorage.getItem(LEADER_QR_BASE_LS_KEY) || "").trim();
        } catch (_e) {
            /* ignore */
        }
        if (custom) {
            try {
                let base = custom;
                if (!/^https?:\/\//i.test(base)) base = "http://" + base;
                const normalized = base.replace(/\/?$/, "/");
                const join = new URL("index.html?leader=1", normalized).href;
                const ju = new URL(join);
                const crossInternetOk = ju.protocol === "https:" && !hostnameLooksPrivateOrLocal(ju.hostname);
                return {
                    qrEncode: join,
                    pageAbs,
                    mode: "custom",
                    needsLanHint: !crossInternetOk,
                    crossInternetOk
                };
            } catch (_e) {
                /* fall through */
            }
        }
        let u;
        try {
            u = new URL(pageAbs);
        } catch (_e) {
            return { qrEncode: null, pageAbs, mode: "broken", needsLanHint: true, crossInternetOk: false };
        }
        const badForPhone =
            u.protocol === "file:" ||
            u.hostname === "localhost" ||
            u.hostname === "127.0.0.1" ||
            u.hostname === "[::1]";
        if (badForPhone) {
            return { qrEncode: null, pageAbs: u.href, mode: "local", needsLanHint: true, crossInternetOk: false };
        }
        const joinDirect = u.href;
        const priv = hostnameLooksPrivateOrLocal(u.hostname);
        const crossInternetOk = u.protocol === "https:" && !priv;
        if (u.protocol === "http:" && priv) {
            return {
                qrEncode: joinDirect,
                pageAbs: u.href,
                mode: "lan-http",
                needsLanHint: true,
                crossInternetOk: false
            };
        }
        if (u.protocol === "https:" && priv) {
            return {
                qrEncode: joinDirect,
                pageAbs: u.href,
                mode: "lan-https",
                needsLanHint: true,
                crossInternetOk: false
            };
        }
        return {
            qrEncode: joinDirect,
            pageAbs: u.href,
            mode: "ok",
            needsLanHint: false,
            crossInternetOk
        };
    }

    /** 投屏/主领新窗口打开后抢焦点时，尽量把键盘控制权留在主窗口（放映员操作） */
    function refocusMainWindowForOperator() {
        const tryFocus = () => {
            try {
                window.focus();
                const appEl = $("app");
                if (appEl) {
                    if (!appEl.hasAttribute("tabindex")) appEl.setAttribute("tabindex", "-1");
                    appEl.focus({ preventScroll: true });
                }
            } catch (e) {
                /* ignore */
            }
        };
        tryFocus();
        requestAnimationFrame(() => {
            tryFocus();
            requestAnimationFrame(tryFocus);
        });
        [50, 200, 500, 1200].forEach((ms) => setTimeout(tryFocus, ms));
    }

    function updateAll(options) {
        const o = options || {};
        const preLyrics = getLyricsSourceStringForPaging();
        syncEditorToSong();
        const mergedPaging = mergeLyricsPagingSnapshot(preLyrics, getLyricsSourceStringForPaging());
        _lyricsPagingSplitOverride = mergedPaging;
        try {
            const lineOnlyFlip = !!(o.linesOnly && isMainVideoBackground());
            if (lineOnlyFlip) {
                updateSpeakerCards({ linesOnly: true });
                renderMiniPreview({ linesOnly: true });
            } else {
                updateSpeakerCards();
                renderMiniPreview();
            }
            renderPlaylist();
            broadcastState();
            renderPageGallery();
        } finally {
            const song = currentSong();
            if (song && mergedPaging.length > String(song.lyrics || "").length) {
                song.lyrics = mergedPaging;
                setLyricEditorValueProgrammatically(mergedPaging);
            }
            _lyricsPagingSplitOverride = null;
            try {
                const AS = globalThis.AppState;
                if (AS) {
                    AS.currentSongId = state.currentSongId;
                    AS.currentPageIndex = state.currentPage;
                    AS.currentCardPage = state.currentPage;
                    const s = currentSong();
                    if (s && typeof globalThis.parsePages === "function") {
                        AS.currentPages = globalThis.parsePages(String(s.lyrics || ""), state.ui.defaultLines);
                    }
                }
            } catch (_e) {
                /* ignore */
            }
        }
    }

    function setBackground(bgType) {
        state.ui.bgType = bgType || "solid-black";
        if (state.ui.bgType !== "image") {
            state.ui.lyricsBgShareToCloud = false;
            state.ui.bgImage = "";
            state.ui.bgImageId = "";
            state.ui.bgMediaType = "image";
        }
        updateUIFromState();
        updateAll();
        persistCurrentSongBgAfterUiChange();
    }

    function reorderLibrarySongs(fromSongId, toSongId) {
        if (!fromSongId || !toSongId || fromSongId === toSongId) return;
        const arr = [...state.songs];
        const fi = arr.findIndex((s) => s.id === fromSongId);
        if (fi < 0) return;
        const [moved] = arr.splice(fi, 1);
        const insertAt = arr.findIndex((s) => s.id === toSongId);
        if (insertAt < 0) return;
        arr.splice(insertAt, 0, moved);
        state.songs = arr;
        saveSongs();
        renderSongList();
    }

    function deleteSong(songId) {
        if (!songId) return;
        libraryPendingDeleteId = "";
        const idx = state.songs.findIndex((s) => s.id === songId);
        if (idx < 0) return;
        state.songs.splice(idx, 1);
        libraryBatchSelected.delete(songId);
        if (!state.songs.length) {
            state.songs.push({ id: uid(), ...DEFAULT_SONG });
        }
        state.playlist.items = state.playlist.items.filter((id) => id !== songId);
        savePlaylist();
        if (state.currentSongId === songId) {
            state.currentSongId = state.songs[0].id;
            state.currentPage = 0;
            if (!isDisplay && !isLeader) {
                hydrateCurrentSongBackgroundIntoUi();
            }
            syncPosYFromCurrentSong();
            syncOverlayFontOpacityFromCurrentSong();
            syncSongToEditor();
        }
        saveSongs();
        updateUIFromState();
        renderSongList();
        updateSpeakerCards();
        renderMiniPreview();
        renderPlaylist();
        broadcastState();
    }

    function batchDeleteSelectedSongs() {
        const ids = [...libraryBatchSelected];
        if (!ids.length) {
            showToast("请先勾选诗歌", $("batch-delete-btn"));
            return;
        }
        if (!confirm(`确定删除选中的 ${ids.length} 首诗歌？`)) return;
        const rm = new Set(ids);
        state.songs = state.songs.filter((s) => !rm.has(s.id));
        libraryBatchSelected.clear();
        if (!state.songs.length) {
            state.songs.push({ id: uid(), ...DEFAULT_SONG });
        }
        state.playlist.items = state.playlist.items.filter((id) => !rm.has(id));
        savePlaylist();
        if (!state.songs.some((s) => s.id === state.currentSongId)) {
            state.currentSongId = state.songs[0].id;
            state.currentPage = 0;
            if (!isDisplay && !isLeader) {
                hydrateCurrentSongBackgroundIntoUi();
            }
            syncPosYFromCurrentSong();
            syncOverlayFontOpacityFromCurrentSong();
            syncSongToEditor();
        }
        saveSongs();
        updateUIFromState();
        renderSongList();
        updateSpeakerCards();
        renderMiniPreview();
        renderPlaylist();
        broadcastState();
    }

    function batchExportSelectedWorship() {
        const ids = [...libraryBatchSelected];
        if (!ids.length) {
            showToast("请先勾选诗歌", $("batch-export-btn"));
            return;
        }
        const subset = state.songs.filter((s) => ids.includes(s.id));
        const blob = new Blob([JSON.stringify({ songs: subset, settings: {} }, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const fname = buildBatchExportWorshipFilename();
        a.download = fname;
        a.click();
        URL.revokeObjectURL(url);
        showCornerSuccessToast(`✅ 已导出为 ${fname}，可在浏览器下载记录中查看`, $("batch-export-btn"));
    }

    function switchSong(songId, opts) {
        if (!state.songs.some((s) => s.id === songId)) return;
        libraryPendingDeleteId = "";
        if (!isDisplay && !isLeader) {
            persistSongBackgroundFromUi(state.currentSongId);
            saveSongs();
        }
        state.currentSongId = songId;
        if (!isDisplay && !isLeader) {
            hydrateCurrentSongBackgroundIntoUi();
        }
        syncPosYFromCurrentSong();
        syncOverlayFontOpacityFromCurrentSong();
        updateUIFromState();
        syncSongToEditor();
        const pages = splitPages(getStablePagingLyricsForPageSplit(), state.ui.defaultLines);
        const wantPage = opts && opts.page != null && Number.isFinite(Number(opts.page)) ? Math.floor(Number(opts.page)) : 0;
        state.currentPage = clamp(wantPage, 0, Math.max(0, pages.length - 1));
        renderSongList();
        updateSpeakerCards();
        renderMiniPreview();
        renderPlaylist();
        saveSettings();
        renderPageGallery();
    }

    let lyricDraftSaveTimer = 0;

    function readLyricDraft() {
        return parseJSON(localStorage.getItem(WORSHIP_DRAFT_LS), null);
    }

    function hideLyricDraftBanner() {
        const b = $("lyric-draft-banner");
        if (b) b.remove();
    }

    function clearLyricDraft() {
        try {
            localStorage.removeItem(WORSHIP_DRAFT_LS);
        } catch (_e) {
            /* ignore */
        }
        hideLyricDraftBanner();
    }

    function persistLyricDraftNow() {
        const ta = $("lyric-editor-large");
        if (!ta || isDisplay || isLeader) return;
        const text = String(ta.value || "");
        if (!text.trim()) {
            clearLyricDraft();
            return;
        }
        const payload = {
            text,
            songId: String(state.currentSongId || ""),
            savedAt: Date.now()
        };
        try {
            localStorage.setItem(WORSHIP_DRAFT_LS, JSON.stringify(payload));
        } catch (err) {
            if (!isStorageQuotaExceededError(err)) console.warn("persistLyricDraftNow", err);
        }
    }

    function scheduleLyricDraftSave() {
        if (lyricDraftSaveTimer) window.clearTimeout(lyricDraftSaveTimer);
        lyricDraftSaveTimer = window.setTimeout(() => {
            lyricDraftSaveTimer = 0;
            persistLyricDraftNow();
        }, 3000);
    }

    function formatDraftAgeMinutes(savedAt) {
        const t = Number(savedAt) || 0;
        if (!t) return "刚刚";
        const mins = Math.floor((Date.now() - t) / 60000);
        if (mins <= 0) return "刚刚";
        return `${mins} 分钟`;
    }

    function maybeOfferLyricDraftRestore() {
        if (isDisplay || isLeader) return;
        const draft = readLyricDraft();
        const raw = String(draft?.text || "").trim();
        if (!raw) return;
        const song = currentSong();
        const onDisk = String(song?.lyrics || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const draftNorm = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const sid = String(draft?.songId || "");
        if (draftNorm === onDisk && sid === String(state.currentSongId || "")) {
            clearLyricDraft();
            return;
        }
        if ($("lyric-draft-banner")) return;
        const col = document.querySelector(".editor-lyric-column");
        if (!col) return;
        const bar = document.createElement("div");
        bar.id = "lyric-draft-banner";
        bar.className = "lyric-draft-banner";
        bar.style.cssText = [
            "display:flex",
            "flex-wrap:wrap",
            "align-items:center",
            "gap:8px 10px",
            "padding:8px 10px",
            "margin-bottom:8px",
            "border-radius:10px",
            "box-sizing:border-box",
            "background:rgba(212,175,55,0.12)",
            "border:1px solid rgba(212,175,55,0.35)",
            "color:var(--text-primary)",
            "font-size:0.82rem",
            "line-height:1.45"
        ].join(";");
        const age = formatDraftAgeMinutes(draft?.savedAt);
        const msg = document.createElement("span");
        msg.style.flex = "1";
        msg.style.minWidth = "140px";
        msg.textContent = `📝 检测到未保存的草稿（保存于 ${age}前），是否恢复？`;
        const btnRestore = document.createElement("button");
        btnRestore.type = "button";
        btnRestore.textContent = "恢复";
        btnRestore.className = "small-btn";
        btnRestore.style.cssText = "padding:4px 12px;border-radius:8px;cursor:pointer;font:inherit;";
        btnRestore.addEventListener("click", () => {
            setLyricEditorValueProgrammatically(draftNorm);
            hideLyricDraftBanner();
            clearLyricDraft();
            syncEditorToSong();
            state.currentPage = 0;
            updateSpeakerCards();
            renderMiniPreview();
            refreshMonitorContent();
            updateCloudUploadBtnState();
            renderPageGallery();
        });
        const btnDismiss = document.createElement("button");
        btnDismiss.type = "button";
        btnDismiss.textContent = "忽略";
        btnDismiss.className = "small-btn";
        btnDismiss.style.cssText = btnRestore.style.cssText;
        btnDismiss.addEventListener("click", () => {
            clearLyricDraft();
        });
        bar.appendChild(msg);
        bar.appendChild(btnRestore);
        bar.appendChild(btnDismiss);
        col.insertBefore(bar, col.firstChild);
    }

    function collectWorshipBackupLocalExtras() {
        const keys = [
            THEME_BG_OPACITY_STORAGE,
            ADV_MINI_OVERLAY_PCT_LS,
            ADV_MINI_BLUR_PX_LS,
            ADV_PREVIEW_LINE_HEIGHT_LS,
            ADV_ACC_STORAGE_KEY,
            "worship_theme_wallpaper",
            "playlist_auto_switch",
            WORSHIP_VISITED_LS,
            LEGACY_FIRST_VISIT_LS,
            "worship.user_nickname",
            "user_nickname",
            CLOUD_UPLOAD_HISTORY_LS
        ];
        const o = {};
        keys.forEach((k) => {
            try {
                const v = localStorage.getItem(k);
                if (v != null) o[k] = v;
            } catch (_e) {
                /* ignore */
            }
        });
        return o;
    }

    async function buildFullWorshipBackupPayload() {
        syncEditorToSong();
        saveSongs();
        saveSettings();
        const tpl = getStore(LYRIC_TEMPLATES_KEY, null);
        return {
            version: 1,
            format: WORSHIP_BACKUP_FORMAT,
            backupAt: Date.now(),
            backupAtIso: new Date().toISOString(),
            nickname: readCloudShareUserNicknameForPost(),
            songs: JSON.parse(JSON.stringify(state.songs)),
            settings: getStore(STORAGE.SETTINGS, null),
            playlist: getStore(STORAGE.PLAYLIST, null),
            live: getStore(STORAGE.LIVE, null),
            lyricTemplates: tpl,
            backgrounds: {
                themeBgCache: _idbThemeBgCache,
                uploadedBackgrounds: JSON.parse(JSON.stringify(getUploadedBackgrounds())),
                themeBgSlots: JSON.parse(JSON.stringify(_themeBgSlotsCache || [])),
                themeBgActiveId: _themeBgActiveId || ""
            },
            localStorageExtras: collectWorshipBackupLocalExtras()
        };
    }

    async function downloadFullWorshipBackup() {
        try {
            const payload = await buildFullWorshipBackupPayload();
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            const d = new Date();
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, "0");
            const day = String(d.getDate()).padStart(2, "0");
            a.download = `worship-backup-${y}-${m}-${day}.worship-backup`;
            a.rel = "noopener";
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            showCornerSuccessToast("✅ 已生成备份文件", $("adv-backup-all-btn"));
        } catch (err) {
            console.warn("downloadFullWorshipBackup", err);
            showToast("备份失败", $("adv-backup-all-btn"));
        }
    }

    function countBackupBackgroundItems(bg) {
        if (!bg || typeof bg !== "object") return 0;
        const up = Array.isArray(bg.uploadedBackgrounds) ? bg.uploadedBackgrounds.length : 0;
        const slots = Array.isArray(bg.themeBgSlots) ? bg.themeBgSlots.filter((x) => x && x.imageData).length : 0;
        return up + slots;
    }

    function formatBackupConfirmLabel(iso, ts) {
        if (iso && typeof iso === "string") {
            const d = new Date(iso);
            if (!Number.isNaN(d.getTime())) return d.toLocaleString();
        }
        const n = Number(ts) || 0;
        if (n) return new Date(n).toLocaleString();
        return "未知时间";
    }

    async function applyWorshipBackupPayload(data) {
        const bg = data.backgrounds && typeof data.backgrounds === "object" ? data.backgrounds : {};
        _themeBgSlotsCache = normalizeThemeBgSlots(Array.isArray(bg.themeBgSlots) ? bg.themeBgSlots : []);
        _themeBgActiveId = String(bg.themeBgActiveId || "").trim();
        if (!_themeBgActiveId && _themeBgSlotsCache.length) {
            _themeBgActiveId = _themeBgSlotsCache[0].id;
        }
        if (String(bg.themeBgCache || "").trim()) {
            _idbThemeBgCache = String(bg.themeBgCache);
        } else {
            syncActiveThemeBgCacheFromSlots();
        }
        persistThemeBgSlotsMetaOnly();
        _idbUploadedCache = normalizeUploadedBackgroundsArray(
            Array.isArray(bg.uploadedBackgrounds) ? bg.uploadedBackgrounds : []
        );
        if (!_bgUseIdbFallbackLs) {
            const db = await openWorshipBgDatabase();
            if (!_idbThemeBgCache.trim()) await idbClearThemeBg(db);
            else await idbWriteThemeBg(db, _idbThemeBgCache);
            await idbWriteAllUploaded(db, _idbUploadedCache);
        } else {
            persistThemeBgAsync(_idbThemeBgCache);
            try {
                setStore(UPLOADED_BACKGROUNDS_STORAGE, _idbUploadedCache);
            } catch (err) {
                console.warn(err);
            }
        }

        if (Array.isArray(data.songs) && data.songs.length) {
            state.songs = data.songs;
        }
        const st = data.settings && typeof data.settings === "object" ? data.settings : {};
        state.currentSongId = st.currentSongId || state.songs[0]?.id || state.currentSongId;
        state.currentPage = Number.isFinite(st.currentPage) ? st.currentPage : 0;
        state.sizePreset = st.sizePreset || state.sizePreset || "M";
        if (st.ui && typeof st.ui === "object") {
            state.ui = { ...state.ui, ...st.ui };
        }
        if (state.ui.fontWeight == null || state.ui.fontWeight === "") state.ui.fontWeight = "700";
        if (!state.ui.bgImageId) state.ui.bgImageId = "";
        setStore(STORAGE.SONGS, state.songs);
        setStore(STORAGE.SETTINGS, {
            currentSongId: state.currentSongId,
            currentPage: state.currentPage,
            sizePreset: state.sizePreset,
            ui: state.ui
        });

        if (data.playlist && typeof data.playlist === "object") {
            state.playlist.items = Array.isArray(data.playlist.items) ? data.playlist.items : [];
            state.playlist.running = !!data.playlist.running;
            state.playlist.activeIndex = clamp(
                Number(data.playlist.activeIndex) || 0,
                0,
                Math.max(0, state.playlist.items.length - 1)
            );
            setStore(STORAGE.PLAYLIST, {
                items: state.playlist.items,
                running: state.playlist.running,
                activeIndex: state.playlist.activeIndex
            });
        }
        if (data.live != null) {
            try {
                setStore(STORAGE.LIVE, data.live);
            } catch (_e) {
                /* ignore */
            }
        }
        if (data.lyricTemplates != null) {
            try {
                setStore(LYRIC_TEMPLATES_KEY, data.lyricTemplates);
            } catch (_e) {
                /* ignore */
            }
        }
        const extras = data.localStorageExtras && typeof data.localStorageExtras === "object" ? data.localStorageExtras : {};
        Object.keys(extras).forEach((k) => {
            try {
                const v = extras[k];
                if (v == null) localStorage.removeItem(k);
                else localStorage.setItem(k, String(v));
            } catch (_e) {
                /* ignore */
            }
        });
        const nick = String(data.nickname || "").trim();
        if (nick && nick !== "匿名") {
            try {
                localStorage.setItem("worship.user_nickname", nick);
            } catch (_e) {
                /* ignore */
            }
        }
        try {
            localStorage.removeItem(WORSHIP_DRAFT_LS);
        } catch (_e) {
            /* ignore */
        }
        saveSongs();
        saveSettings();
        savePlaylist();
        normalizeLegacyBgImageReference();
        const nSong = Array.isArray(data.songs) ? data.songs.length : state.songs.length;
        const nBg = countBackupBackgroundItems(data.backgrounds);
        showCornerSuccessToast(`✅ 已恢复 ${nSong} 首诗歌，${nBg} 个背景`, $("adv-restore-backup-btn"));
        window.setTimeout(() => {
            location.reload();
        }, 650);
    }

    async function handleWorshipBackupRestoreFile(ev) {
        const input = ev.target;
        const file = input?.files?.[0];
        if (input) input.value = "";
        if (!file) return;
        const name = String(file.name || "").toLowerCase();
        if (!name.endsWith(".worship-backup") && !name.endsWith(".json")) {
            showToast("请选择 .worship-backup 文件", $("adv-restore-backup-btn"));
            return;
        }
        const reader = new FileReader();
        reader.onload = async () => {
            const data = parseJSON(String(reader.result || ""), null);
            const songs = data && Array.isArray(data.songs) ? data.songs : [];
            if (!data || !songs.length) {
                showToast("备份文件无效", $("adv-restore-backup-btn"));
                return;
            }
            const okFormat = data.format === WORSHIP_BACKUP_FORMAT || data.backupAt != null;
            if (!okFormat && !data.settings) {
                showToast("备份文件格式不正确", $("adv-restore-backup-btn"));
                return;
            }
            const when = formatBackupConfirmLabel(data.backupAtIso, data.backupAt);
            const nBg = countBackupBackgroundItems(data.backgrounds);
            const msg = `即将恢复备份数据（含 ${songs.length} 首诗歌，备份于 ${when}）。当前数据将被覆盖，是否继续？`;
            if (!window.confirm(msg)) return;
            try {
                await applyWorshipBackupPayload(data);
            } catch (err) {
                console.warn("applyWorshipBackupPayload", err);
                showToast("恢复失败", $("adv-restore-backup-btn"));
            }
        };
        reader.onerror = () => showToast("读取文件失败", $("adv-restore-backup-btn"));
        reader.readAsText(file, "utf-8");
    }

    function saveCurrentLyrics(opts) {
        const silent = !!(opts && typeof opts === "object" && opts.silent);
        if (!silent) {
            const { title, lyrics } = getEditorTitleLyricsTrimmed();
            if (!title) {
                showEditorValidationHint("⚠️ 请先输入诗歌标题");
                return;
            }
            if (!lyrics) {
                showEditorValidationHint("⚠️ 歌词内容为空，请先编辑歌词");
                return;
            }
        }
        syncEditorToSong();
        saveSongs();
        renderSongList();
        updateSpeakerCards();
        renderMiniPreview();
        broadcastState();
        clearLyricDraft();
        if (!silent) {
            const st = currentSong();
            openSaveLyricsLibraryHintModal(st?.title || "");
        }
    }

    try {
        globalThis.saveCurrentLyrics = saveCurrentLyrics;
    } catch (_e) {
        /* ignore */
    }

    function createNewSong() {
        const song = {
            id: uid(),
            title: "",
            lyrics: "",
            key: "",
            tempo: "",
            notes: "",
            tags: "",
            overlayOpacityPct: 30,
            fontOpacityPct: 100
        };
        const currentIndex = Math.max(0, state.songs.findIndex((s) => s.id === state.currentSongId));
        state.songs.splice(currentIndex + 1, 0, song);
        saveSongs();
        switchSong(song.id);
        showToast("✅ 已新建诗歌，请编辑歌词", $("add-song-btn"));
        queueMicrotask(() => {
            const inp = $("song-title-input");
            if (inp) {
                inp.focus();
                inp.select();
            }
        });
    }

    async function publishSong() {
        const s = getCurrentSong();
        if (!s.lyrics || !s.lyrics.length) {
            showToast("无歌词可发布", $("publish-song-btn"));
            return;
        }
        const url = 'https://holy-snow-ebc5.cuirenjie123456789.workers.dev';
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: s.title, lyrics: s.lyrics, tags: s.tags || [] })
            });
            if (response.ok) {
                showToast("✅ 已发布到云端", $("publish-song-btn"));
            } else {
                showToast("❌ 发布失败，请重试", $("publish-song-btn"));
            }
        } catch (e) {
            console.error('发布失败:', e);
            showToast("❌ 发布失败，请重试", $("publish-song-btn"));
        }
    }

    function notifyProjectionConsoleReadyForGuide() {
        if (suppressProjectionConsoleNotify || isDisplay || isLeader) return;
        if (channel) channel.postMessage({ type: "projection_console_ready", source: "main" });
    }

    function hideProjectionClosedAttentionModal() {
        if (projectionClosedAttentionModal?.parentNode) {
            projectionClosedAttentionModal.remove();
        }
        projectionClosedAttentionModal = null;
    }

    function showProjectionClosedAttentionModal() {
        if (isDisplay || isLeader) return;
        if (projectionClosedAttentionModal?.parentNode) return;

        const wrap = document.createElement("div");
        wrap.id = "projection-closed-attention-modal";
        wrap.setAttribute("role", "dialog");
        wrap.setAttribute("aria-modal", "true");
        wrap.setAttribute("aria-labelledby", "projection-closed-attention-title");
        wrap.style.cssText = [
            "position:fixed",
            "inset:0",
            "z-index:45000",
            "display:flex",
            "align-items:center",
            "justify-content:center",
            "padding:24px",
            "box-sizing:border-box",
            "background:rgba(6,8,16,0.55)",
            "backdrop-filter:blur(14px)",
            "-webkit-backdrop-filter:blur(14px)",
            "opacity:0",
            "transition:opacity 0.3s ease"
        ].join(";");

        const card = document.createElement("div");
        card.style.cssText = [
            "width:min(450px,90vw)",
            "max-width:100%",
            "box-sizing:border-box",
            "background:rgba(22,26,38,0.78)",
            "backdrop-filter:blur(22px) saturate(1.2)",
            "-webkit-backdrop-filter:blur(22px) saturate(1.2)",
            "border-radius:16px",
            "padding:32px 28px 28px",
            "border:1px solid rgba(255,255,255,0.14)",
            "box-shadow:0 28px 72px rgba(0,0,0,0.55),0 0 0 1px rgba(0,0,0,0.35),0 12px 40px rgba(74,111,165,0.12)",
            "text-align:center",
            "color:#eef1f8"
        ].join(";");

        const icon = document.createElement("div");
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = "📺";
        icon.style.cssText =
            "font-size:48px;line-height:1;margin:0 0 16px;filter:drop-shadow(0 4px 12px rgba(0,0,0,0.35));";

        const title = document.createElement("h2");
        title.id = "projection-closed-attention-title";
        title.textContent = "投屏窗口已关闭或退出全屏";
        title.style.cssText =
            "margin:0 0 28px;font-size:1.5rem;font-weight:700;line-height:1.35;letter-spacing:0.02em;color:#f6f8fc;text-shadow:0 1px 2px rgba(0,0,0,0.35);";

        const row = document.createElement("div");
        row.style.cssText =
            "display:flex;gap:16px;justify-content:center;align-items:center;flex-wrap:wrap;margin-top:4px;";

        const btnRestore = document.createElement("button");
        btnRestore.type = "button";
        btnRestore.textContent = "🔄 恢复投屏";
        btnRestore.style.cssText = [
            "padding:13px 26px",
            "border-radius:12px",
            "border:none",
            "cursor:pointer",
            "font-size:1rem",
            "font-weight:700",
            "letter-spacing:0.03em",
            "background:linear-gradient(180deg,#e8c85a,#d4af37 55%,#b8922e)",
            "color:#1a1510",
            "box-shadow:0 6px 20px rgba(212,175,55,0.45),inset 0 1px 0 rgba(255,255,255,0.35)",
            "transition:transform 0.15s ease,box-shadow 0.15s ease,filter 0.15s ease"
        ].join(";");
        btnRestore.addEventListener("mouseenter", () => {
            btnRestore.style.filter = "brightness(1.06)";
            btnRestore.style.transform = "translateY(-1px)";
        });
        btnRestore.addEventListener("mouseleave", () => {
            btnRestore.style.filter = "";
            btnRestore.style.transform = "";
        });

        const btnClose = document.createElement("button");
        btnClose.type = "button";
        btnClose.textContent = "✕ 关闭";
        btnClose.style.cssText = [
            "padding:13px 26px",
            "border-radius:12px",
            "cursor:pointer",
            "font-size:1rem",
            "font-weight:600",
            "letter-spacing:0.02em",
            "background:transparent",
            "color:#f0f4fc",
            "border:1px solid rgba(255,255,255,0.55)",
            "box-shadow:inset 0 0 0 1px rgba(0,0,0,0.15)",
            "transition:background 0.15s ease,border-color 0.15s ease,transform 0.15s ease"
        ].join(";");
        btnClose.addEventListener("mouseenter", () => {
            btnClose.style.background = "rgba(255,255,255,0.08)";
            btnClose.style.borderColor = "rgba(255,255,255,0.75)";
        });
        btnClose.addEventListener("mouseleave", () => {
            btnClose.style.background = "transparent";
            btnClose.style.borderColor = "rgba(255,255,255,0.55)";
        });

        row.appendChild(btnRestore);
        row.appendChild(btnClose);
        card.appendChild(icon);
        card.appendChild(title);
        card.appendChild(row);
        wrap.appendChild(card);

        wrap.addEventListener("click", (e) => {
            if (e.target === wrap) hideProjectionClosedAttentionModal();
        });
        card.addEventListener("click", (e) => e.stopPropagation());
        btnClose.addEventListener("click", () => hideProjectionClosedAttentionModal());
        btnRestore.addEventListener("click", () => {
            hideProjectionClosedAttentionModal();
            openDisplayWindow();
        });

        document.body.appendChild(wrap);
        projectionClosedAttentionModal = wrap;
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                wrap.style.opacity = "1";
            });
        });
    }

    function showRestoreProjectionBanner() {
        if (isDisplay || isLeader) return;
        const el = $("restore-projection-overlay");
        if (el) el.hidden = true;
        showProjectionClosedAttentionModal();
    }

    function hideRestoreProjectionBanner() {
        hideProjectionClosedAttentionModal();
        const el = $("restore-projection-overlay");
        if (el) el.hidden = true;
    }

    function attachProjectionDisplayWindow(win) {
        if (!win) return;
        projectionDisplayWindowRef = win;
        if (win.__worshipProjectionUnloadBound) return;
        win.__worshipProjectionUnloadBound = true;
        try {
            win.addEventListener("unload", () => {
                if (projectionDisplayWindowRef === win) onProjectionDisplayWindowClosed();
            });
        } catch (_) {
            /* ignore */
        }
    }

    /** 主控台通知投屏窗自行关闭（window.postMessage） */
    function requestCloseProjectionDisplayViaPostMessage() {
        projectionCloseInitiatedByMain = true;
        hideRestoreProjectionBanner();
        let w = projectionDisplayWindowRef;
        if (w && w.closed) {
            onProjectionDisplayWindowClosed();
            return;
        }
        if (!w) {
            try {
                if (channel) channel.postMessage({ type: "main_projection_end", source: "main", target: "display" });
            } catch (_e0) {
                /* ignore */
            }
            noteProjectionDisplayGone();
            purgeOrphanProjectionDisplayWindows();
            syncProjectionPanelControls();
            window.setTimeout(() => {
                projectionCloseInitiatedByMain = false;
            }, 400);
            return;
        }
        try {
            w.postMessage({ action: "close_display" }, "*");
        } catch (_e) {
            try {
                w.close();
            } catch (_e2) {
                /* ignore */
            }
            onProjectionDisplayWindowClosed();
            return;
        }
        window.setTimeout(() => {
            const ref = projectionDisplayWindowRef;
            if (ref && !ref.closed) {
                try {
                    ref.close();
                } catch (_e3) {
                    /* ignore */
                }
            }
            watchProjectionDisplayWindowRef();
        }, 800);
    }

    /**
     * 通知所有会众投屏页自行关闭，并关闭主控台仍持有的窗口引用。
     * 与固定 window.name 配合，保证再次「开启投屏」时不会残留后台窗口。
     */
    function purgeOrphanProjectionDisplayWindows() {
        try {
            if (channel) channel.postMessage({ type: "main_projection_end", source: "main", target: "display" });
        } catch (_e) {
            /* ignore */
        }
        try {
            const old = projectionDisplayWindowRef;
            if (old && !old.closed) old.close();
        } catch (_e2) {
            /* ignore */
        }
        projectionDisplayWindowRef = null;
        noteProjectionDisplayGone();
    }

    function closeProjectionDisplayWindow(opts) {
        const silent = !!(opts && opts.silent);
        if (!silent) {
            let w = projectionDisplayWindowRef;
            if (w && w.closed) {
                projectionDisplayWindowRef = null;
                w = null;
            }
            if (w && !w.closed) {
                requestCloseProjectionDisplayViaPostMessage();
                return;
            }
        }
        if (!silent) projectionCloseInitiatedByMain = true;
        purgeOrphanProjectionDisplayWindows();
        hideRestoreProjectionBanner();
        try {
            syncProjectionPanelControls();
            refocusMainWindowForOperator();
        } catch (_eSync) {
            /* ignore */
        }
        if (!silent) {
            try {
                showToast(
                    "已结束投屏",
                    $("close-projection-panel-btn") ||
                        $("close-projection-display-btn") ||
                        $("open-display-btn")
                );
            } catch (_e3) {
                /* ignore */
            }
        }
    }

    /** 主领「诗歌包」二维码：标题+歌词 + 可选主领偏好（lp），gzip 压缩单码 */
    /** 扫码打开链接总长度上限（含 #wp1=）；单码 gzip 压缩，跨网络可用 */
    const LEADER_QR_OPEN_URL_MAX = 3800;
    /** wp1 诗歌包最大字符（W1 压缩后） */
    const WORSHIP_QR_PACK_MAX_CHARS = 2900;
    /** 旧 ?data= 分页上限（仅兼容旧链接解析，不再用于生成） */
    const LEADER_DATA_QR_MAX_BYTES = 2500;
    const LEADER_DATA_QR_SONGS_PER_PAGE = 3;
    const LEADER_QR_PUBLIC_BASE = "https://jack-ja-ck.github.io/--app/";
    const LEADER_SCAN_ACC_KEY = "worship.leaderScanAcc.v2";
    const LEADER_LOCAL_SNAPSHOT_LS_KEY = "worship.leaderLocalSnapshot.v2";

    function isLeaderMobileViewport() {
        return (
            typeof window !== "undefined" &&
            window.matchMedia &&
            window.matchMedia("(max-width: 767px)").matches
        );
    }

    function isLeaderCompactBackupViewport() {
        return (
            typeof window !== "undefined" &&
            window.matchMedia &&
            window.matchMedia("(max-width: 1024px)").matches
        );
    }

    function isLeaderHandheldViewport() {
        return isLeaderCompactBackupViewport();
    }

    function persistLeaderLocalSnapshot() {
        if (!isLeader) return;
        try {
            const collapsed = buildLeaderShareCollapsedBase({ backup: true });
            if (!Array.isArray(collapsed.s) || !collapsed.s.length) return;
            collapsed.savedAt = Date.now();
            localStorage.setItem(LEADER_LOCAL_SNAPSHOT_LS_KEY, JSON.stringify(collapsed));
        } catch (_e) {
            /* ignore */
        }
    }

    function tryRestoreLeaderLocalSnapshot() {
        if (!isLeader) return false;
        try {
            if (new URLSearchParams(location.search).get("data")) return false;
            const raw = localStorage.getItem(LEADER_LOCAL_SNAPSHOT_LS_KEY);
            if (!raw) return false;
            const collapsed = parseJSON(raw, null);
            if (!collapsed || !Array.isArray(collapsed.s) || !collapsed.s.length) return false;
            const pl = state.playlist?.items;
            if (Array.isArray(pl) && pl.length > 0) return false;
            return applyLeaderSharePayloadToState(expandLeaderSharePayload(collapsed), { fromSnapshot: true });
        } catch (_e2) {
            return false;
        }
    }

    function leaderSongToCollapsed(s) {
        const o = {
            i: String(s.id),
            t: String(s.title || ""),
            l: String(s.lyrics || ""),
            n: String(s.notes || ""),
            g: String(s.tags || "")
        };
        if (s.leaderWorshipFlow) o.f = s.leaderWorshipFlow;
        return o;
    }

    function leaderSongFromCollapsed(entry) {
        const id = String(entry.i ?? entry.id ?? uid());
        const prev = state.songs.find((x) => String(x.id) === id);
        return {
            ...(prev || { ...DEFAULT_SONG, id }),
            id,
            title: String(entry.t ?? entry.title ?? prev?.title ?? ""),
            lyrics: String(entry.l ?? entry.lyrics ?? prev?.lyrics ?? ""),
            notes: String(entry.n ?? entry.notes ?? prev?.notes ?? ""),
            tags: String(entry.g ?? entry.tags ?? prev?.tags ?? ""),
            leaderWorshipFlow: entry.f || entry.leaderWorshipFlow || prev?.leaderWorshipFlow || null
        };
    }

    function expandLeaderSharePayload(raw) {
        if (!raw || typeof raw !== "object") return null;
        const songsIn = Array.isArray(raw.s) ? raw.s : Array.isArray(raw.songs) ? raw.songs : [];
        return {
            playlist: Array.isArray(raw.p) ? raw.p.map(String) : Array.isArray(raw.playlist) ? raw.playlist.map(String) : [],
            songs: songsIn.map(leaderSongFromCollapsed),
            page: Number(raw.page) || 1,
            total: Number(raw.total) || 1,
            backup: !!(raw.b || raw.backup),
            displayMode: raw.dm != null ? String(raw.dm) : raw.displayMode,
            bgMode: raw.bm != null ? String(raw.bm) : raw.bgMode,
            leaderFontSize: raw.fs != null ? String(raw.fs) : raw.leaderFontSize,
            toolbarCollapsed: raw.tc,
            leader_notes: raw.nt || raw.leader_notes
        };
    }

    function parseLeaderSharePayloadFromParam(rawParam) {
        const raw = String(rawParam || "").trim();
        if (!raw) return null;
        try {
            const json = decodeURIComponent(raw);
            return expandLeaderSharePayload(parseJSON(json, null));
        } catch (_e) {
            return null;
        }
    }

    function leaderEncodedDataLength(collapsed) {
        return encodeURIComponent(JSON.stringify(collapsed)).length;
    }

    function getLeaderQrShareEntryUrl() {
        try {
            const custom = String(localStorage.getItem(LEADER_QR_BASE_LS_KEY) || "").trim();
            if (custom) {
                let base = custom;
                if (!/^https?:\/\//i.test(base)) base = "https://" + base;
                return new URL("index.html?leader=1", base.replace(/\/?$/, "/")).href.split("#")[0];
            }
        } catch (_e) {
            /* ignore */
        }
        const pub = derivePublicHttpsLeaderJoinBaseFromLocation();
        const base =
            pub && String(pub).startsWith("https://") && !hostnameLooksPrivateOrLocal(new URL(pub).hostname)
                ? pub
                : LEADER_QR_PUBLIC_BASE;
        try {
            return new URL("index.html?leader=1", base.replace(/\/?$/, "/")).href.split("#")[0];
        } catch (_e2) {
            return LEADER_QR_PUBLIC_BASE.replace(/\/?$/, "/") + "index.html?leader=1";
        }
    }

    function getLeaderQrPageBaseUrl() {
        return getLeaderQrShareEntryUrl().replace(/\?leader=1.*$/, "/").replace(/index\.html$/, "") || LEADER_QR_PUBLIC_BASE;
    }

    function getLeaderQrReachabilityMeta() {
        let crossInternet = true;
        try {
            const entry = getLeaderQrShareEntryUrl();
            crossInternet =
                entry.startsWith("https://") && !hostnameLooksPrivateOrLocal(new URL(entry).hostname);
        } catch (_e) {
            crossInternet = true;
        }
        return {
            ok: true,
            crossInternet,
            hint:
                "💡 歌词与设置已压缩进二维码/链接，<b>手机可用任意网络</b>扫描（无需与电脑同 Wi‑Fi）。<b>同一码可多台设备</b>使用。若扫不出，请点「复制链接」发微信，或「复制分享码」到主领页「诗歌」粘贴。"
        };
    }

    async function refreshLeaderShareQrPages(force) {
        const bundle = await buildLeaderShareQrBundle({ force: !!force });
        return bundle.pages || [];
    }

    function renderLeaderShareQrView(container, bundle) {
        if (!container || !bundle) return;
        const root = container.closest(".leader-backup-dialog") || container;
        const img = root.querySelector("#leader-panel-qr-img, #leader-qr-popup-img, #leader-backup-qr-img");
        const tipEl = root.querySelector("#leader-panel-qr-tip, #leader-qr-popup-tip, #leader-backup-tip");
        const isBackup = !!root.classList?.contains("leader-backup-dialog");
        const compactBackup = isBackup && isLeaderCompactBackupViewport();
        if (bundle.url) setLeaderQrImageSrc(img, bundle.url);
        else if (img) {
            img.removeAttribute("src");
            img.alt = "无法生成";
        }
        if (!compactBackup) syncLeaderQrShareHint(container, bundle);
        if (tipEl && !bundle.url) {
            tipEl.textContent = bundle.note || "歌单为空或内容过多，请减少诗歌后重试，或使用「复制分享码」/「导出」。";
        } else if (tipEl && bundle.url) {
            tipEl.textContent = compactBackup
                ? "请截图保存下方二维码，或点「复制链接」存到微信/备忘录，日后可恢复本次编辑。"
                : "💡 扫描下方二维码打开主领页；也可复制链接或分享码发给其他设备。";
        }
    }

    let leaderShareQrBundleCache = null;

    async function buildLeaderShareQrBundle(opts) {
        const force = !!(opts && opts.force);
        if (!force && leaderShareQrBundleCache) return leaderShareQrBundleCache;
        const baseFull = getLeaderQrShareEntryUrl();
        let maxPack = Math.min(
            WORSHIP_QR_PACK_MAX_CHARS,
            Math.max(900, LEADER_QR_OPEN_URL_MAX - baseFull.length - 14)
        );
        let built = await buildLeaderSongPackQrPayload(maxPack);
        let openUrl = "";
        for (let attempt = 0; attempt < 14 && built.qrText; attempt++) {
            openUrl = `${baseFull}#wp1=${encodeURIComponent(built.qrText)}`;
            if (openUrl.length <= LEADER_QR_OPEN_URL_MAX) break;
            maxPack = Math.max(420, Math.floor(maxPack * 0.82));
            built = await buildLeaderSongPackQrPayload(maxPack);
        }
        const ok = !!(built.qrText && openUrl && openUrl.length <= LEADER_QR_OPEN_URL_MAX);
        const bundle = {
            url: ok ? openUrl : "",
            pasteText: built.qrText || "",
            songCount: built.songCount,
            totalWanted: built.totalWanted,
            truncated: !!built.truncated,
            note: built.note || "",
            pages: ok ? [{ page: 1, total: 1, url: openUrl, pasteText: built.qrText }] : []
        };
        leaderShareQrBundleCache = bundle;
        return bundle;
    }

    /** @deprecated 请用 buildLeaderShareQrBundle；保留空实现避免旧调用报错 */
    function buildLeaderUnifiedQrPages() {
        return leaderShareQrBundleCache?.pages?.length
            ? leaderShareQrBundleCache.pages
            : [];
    }

    const LEADER_QR_SHARE_ROW_HTML =
        '<div class="leader-qr-share-row">' +
        '<p class="leader-qr-share-hint" id="leader-qr-share-hint"></p>' +
        '<div class="leader-qr-share-actions">' +
        '<button type="button" class="leader-panel-lan-btn leader-panel-lan-btn--primary" data-leader-copy-link>复制链接</button>' +
        '<button type="button" class="leader-panel-lan-btn" data-leader-copy-pack>复制分享码</button>' +
        "</div></div>";

    function syncLeaderQrShareHint(container, bundle) {
        if (!container) return;
        const hint = container.querySelector(".leader-qr-share-hint, #leader-qr-share-hint");
        if (!hint) return;
        const meta = getLeaderQrReachabilityMeta();
        let text = meta.hint || "";
        if (bundle?.truncated && bundle.note) {
            text += " " + bundle.note;
        } else if (bundle?.songCount && bundle.totalWanted && bundle.songCount < bundle.totalWanted) {
            text += ` 当前含 ${bundle.songCount}/${bundle.totalWanted} 首（已自动精简以放进一个码）。`;
        }
        hint.innerHTML = text;
        hint.hidden = !text;
    }

    async function copyLeaderShareToClipboard(text, anchor) {
        const t = String(text || "").trim();
        if (!t) {
            showToast("暂无可复制内容", anchor);
            return false;
        }
        try {
            await navigator.clipboard.writeText(t);
            showCornerSuccessToast("已复制", anchor);
            return true;
        } catch (_e) {
            showToast("复制失败，请长按全选后手动复制", anchor);
            return false;
        }
    }

    function bindLeaderQrShareRow(container, refreshBundle) {
        if (!container || container.dataset.leaderQrShareBound) return;
        container.dataset.leaderQrShareBound = "1";
        container.querySelector("[data-leader-copy-link]")?.addEventListener("click", async (e) => {
            const bundle = await refreshBundle(true);
            await copyLeaderShareToClipboard(bundle.url, e.currentTarget);
        });
        container.querySelector("[data-leader-copy-pack]")?.addEventListener("click", async (e) => {
            const bundle = await refreshBundle(true);
            await copyLeaderShareToClipboard(bundle.pasteText, e.currentTarget);
        });
    }

    function syncLeaderQrLanWarn(container) {
        syncLeaderQrShareHint(container, leaderShareQrBundleCache);
    }

    function buildLeaderOpenUrlFromCollapsed(collapsed) {
        const root = getLeaderQrPageBaseUrl();
        if (!root) return "";
        try {
            const enc = encodeURIComponent(JSON.stringify(collapsed));
            return new URL(`index.html?leader=1&data=${enc}`, root).href;
        } catch (_e) {
            return "";
        }
    }

    function buildLeaderShareCollapsedBase(opts) {
        const isBackup = !!(opts && opts.backup);
        const { songs: ordered } = collectLeaderShareSongsOrdered();
        const base = {
            p: ordered.map((s) => String(s.id)),
            s: ordered.map(leaderSongToCollapsed)
        };
        if (isBackup) {
            base.b = 1;
            const prefs = readLeaderQrPackPrefsForExport();
            base.dm = prefs.dm;
            base.bm = prefs.bm;
            base.tc = prefs.tc;
            if (prefs.fs) base.fs = prefs.fs;
            const nt = readLeaderQrPackNotesForExport(500000);
            if (nt) base.nt = nt;
        }
        return base;
    }

    function paginateLeaderCollapsedPayload(collapsed, maxBytes) {
        const songs = Array.isArray(collapsed.s) ? collapsed.s : [];
        const tryPages = (per) => {
            const chunks = [];
            for (let i = 0; i < songs.length; i += per) chunks.push(songs.slice(i, i + per));
            if (!chunks.length) chunks.push([]);
            const total = chunks.length;
            return chunks.map((chunk, idx) => {
                const pg = { ...collapsed, s: chunk, p: chunk.map((x) => x.i), page: idx + 1, total };
                return pg;
            });
        };
        let per = LEADER_DATA_QR_SONGS_PER_PAGE;
        while (per >= 1) {
            const pages = tryPages(per);
            const ok = pages.every((pg) => leaderEncodedDataLength(pg) <= maxBytes);
            if (ok) return pages;
            per -= 1;
        }
        const singlePages = tryPages(1);
        const fits = singlePages.filter((pg) => leaderEncodedDataLength(pg) <= maxBytes);
        return fits.length ? fits : singlePages.slice(0, 1);
    }

    /** 电脑传数据 / 手机保存：见 buildLeaderShareQrBundle（单码 gzip #wp1=） */

    function buildLeaderDataQrPages(opts) {
        const collapsed = buildLeaderShareCollapsedBase(opts);
        if (leaderEncodedDataLength(collapsed) <= LEADER_DATA_QR_MAX_BYTES) {
            const url = buildLeaderOpenUrlFromCollapsed(collapsed);
            return url ? [{ page: 1, total: 1, url }] : [];
        }
        const pages = paginateLeaderCollapsedPayload(collapsed, LEADER_DATA_QR_MAX_BYTES);
        return pages.map((pg) => ({
            page: pg.page,
            total: pg.total,
            url: buildLeaderOpenUrlFromCollapsed(pg)
        })).filter((pg) => pg.url);
    }

    function setLeaderQrImageSrc(img, openUrl) {
        if (!img || !openUrl) return;
        const enc = encodeURIComponent(openUrl);
        const len = openUrl.length;
        const size = len > 3200 ? 420 : len > 2400 ? 380 : len > 1600 ? 320 : 260;
        const ecc = len > 2800 ? "L" : "M";
        const primary = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=6&ecc=${ecc}&data=${enc}`;
        const fallback = `https://quickchart.io/qr?size=${size}&margin=1&ecLevel=${ecc}&text=${enc}`;
        img.onerror = function () {
            img.onerror = null;
            img.src = fallback;
        };
        img.src = primary;
    }

    function leaderLocalNotesHasContent() {
        try {
            const raw = localStorage.getItem("leader_notes");
            if (!raw) return false;
            const o = parseJSON(raw, null);
            if (!o || typeof o !== "object") return false;
            return Object.keys(o).some((k) => {
                const v = o[k];
                if (typeof v === "string") return !!v.trim();
                return !!(v && String(v.note || "").trim());
            });
        } catch (_e) {
            return false;
        }
    }

    function applyLeaderSharePayloadToState(expanded, opts) {
        const anchor = (opts && opts.anchor) || null;
        if (!expanded || !Array.isArray(expanded.songs)) return false;
        const isBackup = !!expanded.backup;
        const isPaged = (expanded.total || 1) > 1;
        let mergedSongs = expanded.songs;
        let mergedPlaylist = expanded.playlist;

        if (isPaged) {
            let acc = getStore(LEADER_SCAN_ACC_KEY, null);
            if (!acc || typeof acc !== "object") acc = { songs: {}, playlist: [], pages: [], total: expanded.total };
            expanded.songs.forEach((s) => {
                acc.songs[String(s.id)] = s;
            });
            expanded.playlist.forEach((id) => {
                const sid = String(id);
                if (!acc.playlist.includes(sid)) acc.playlist.push(sid);
            });
            if (!acc.pages.includes(expanded.page)) acc.pages.push(expanded.page);
            acc.total = expanded.total;
            setStore(LEADER_SCAN_ACC_KEY, acc);
            mergedPlaylist = acc.playlist.slice();
            mergedSongs = mergedPlaylist.map((id) => acc.songs[id]).filter(Boolean);
            if (acc.pages.length >= expanded.total) {
                try {
                    localStorage.removeItem(LEADER_SCAN_ACC_KEY);
                } catch (_e) {
                    /* ignore */
                }
            }
        } else {
            try {
                localStorage.removeItem(LEADER_SCAN_ACC_KEY);
            } catch (_e2) {
                /* ignore */
            }
        }

        const byId = new Map(state.songs.map((s) => [String(s.id), s]));
        mergedSongs.forEach((s) => byId.set(String(s.id), s));
        state.songs = mergedPlaylist.length
            ? mergedPlaylist.map((id) => byId.get(String(id))).filter(Boolean)
            : Array.from(byId.values());

        state.playlist.items = mergedPlaylist.length ? mergedPlaylist.slice() : state.songs.map((x) => x.id);
        state.playlist.running = state.playlist.items.length > 0;
        state.playlist.activeIndex = 0;
        if (state.playlist.items.length) {
            state.currentSongId = state.playlist.items[0];
            state.currentPage = 0;
        }

        if (isBackup && expanded.leader_notes) {
            try {
                setStore("leader_notes", expanded.leader_notes);
            } catch (_e3) {
                /* ignore */
            }
        } else if (!leaderLocalNotesHasContent() && expanded.leader_notes) {
            try {
                setStore("leader_notes", expanded.leader_notes);
            } catch (_e4) {
                /* ignore */
            }
        }

        const applyPref = (key, val, force) => {
            if (val == null || val === "") return;
            try {
                if (!force && localStorage.getItem(key) != null) return;
                localStorage.setItem(key, String(val));
            } catch (_e5) {
                /* ignore */
            }
        };
        if (isBackup) {
            if (expanded.displayMode && ["multi", "scroll", "flow"].includes(expanded.displayMode)) {
                applyPref("leader_display_mode", expanded.displayMode, true);
            }
            if (expanded.bgMode) applyPref("leader_bg_mode", expanded.bgMode, true);
            if (expanded.leaderFontSize) applyPref("leader_font_size", expanded.leaderFontSize, true);
            if (expanded.toolbarCollapsed === 0 || expanded.toolbarCollapsed === 1 || expanded.toolbarCollapsed === "0" || expanded.toolbarCollapsed === "1") {
                applyPref("leader_toolbar_collapsed", expanded.toolbarCollapsed === 1 || expanded.toolbarCollapsed === "1" ? "1" : "0", true);
            }
        } else {
            applyPref("leader_display_mode", "multi", false);
        }

        try {
            setStore(STORAGE.SONGS, state.songs);
            savePlaylist();
            saveSettings();
        } catch (_e6) {
            /* ignore */
        }
        try {
            hydrateAppStateFromStorage();
        } catch (_e7) {
            /* ignore */
        }
        if (!isDisplay && !isLeader) {
            syncSongToEditor();
            updateAll();
        }
        if (isLeader) {
            try {
                liveState = buildLiveState();
                setStore(STORAGE.LIVE, liveState);
                globalThis.liveState = liveState;
            } catch (_eLs) {
                /* ignore */
            }
            if (typeof globalThis.__leaderReloadAfterPackImport === "function") {
                globalThis.__leaderReloadAfterPackImport({
                    page: expanded.page,
                    total: expanded.total,
                    pagedIncomplete: isPaged && expanded.page < expanded.total
                });
            }
        }
        if (!isLeader) showCornerSuccessToast(`已同步 ${mergedSongs.length} 首诗歌`, anchor);
        if (isLeader) persistLeaderLocalSnapshot();
        return true;
    }

    let leaderQrPopupPages = [];
    let leaderQrPopupIndex = 0;
    let leaderPanelQrPages = [];
    let leaderPanelQrIndex = 0;

    function ensureLeaderPanelModal() {
        let modal = $("leader-panel-modal");
        if (modal && !modal.querySelector("#leader-panel-qr-view .leader-qr-share-row")) {
            modal.remove();
            modal = null;
        }
        if (modal) return modal;
        modal = document.createElement("div");
        modal.id = "leader-panel-modal";
        modal.innerHTML =
            '<div class="leader-panel-dialog" role="dialog" aria-modal="true">' +
            '<button type="button" class="leader-panel-close-x" data-leader-panel-x aria-label="关闭">✕</button>' +
            '<div id="leader-panel-chooser">' +
            '<h2 class="leader-panel-title">📱 主领视角</h2>' +
            '<p class="leader-panel-desc">在不同设备上编辑、排版歌词与备注；会众投屏请用主控台「开启投屏」</p>' +
            '<div class="leader-panel-choice-row">' +
            '<button type="button" class="leader-panel-choice-btn" data-leader-panel-mode="qr"><span class="leader-panel-choice-icon leader-panel-choice-icon--sync" aria-hidden="true">⇄</span><span>平板/手机传数据</span></button>' +
            '<button type="button" class="leader-panel-choice-btn" data-leader-panel-mode="desktop"><span class="leader-panel-choice-icon leader-panel-choice-icon--device" aria-hidden="true">💻</span><span>在电脑上打开</span></button>' +
            "</div>" +
            '<div class="leader-panel-tip-box" data-v="2">' +
            "<p><b>平板/手机传数据</b>：生成<b>一个二维码</b>（歌词与设置已压缩在内），手机可用<b>任意网络</b>扫描，<b>同一码可多台设备</b>使用。</p>" +
            "<p><b>扫不出？</b>点「复制链接」发微信，或「复制分享码」到主领页 ⚙ →「诗歌」粘贴。无需填写局域网地址。</p>" +
            "</div>" +
            "</div>" +
            '<div id="leader-panel-qr-view" hidden>' +
            '<h2 class="leader-panel-title">⇄ 传数据到平板/手机</h2>' +
            '<div class="leader-panel-qr-wrap">' +
            '<img id="leader-panel-qr-img" class="leader-panel-qr-img" width="200" height="200" alt="传数据二维码">' +
            '<div class="leader-panel-pager" id="leader-panel-pager" hidden>' +
            '<button type="button" data-leader-panel-prev aria-label="上一页">‹</button>' +
            '<span id="leader-panel-pager-label">第1/1页</span>' +
            '<button type="button" data-leader-panel-next aria-label="下一页">›</button>' +
            "</div>" +
            '<div class="leader-panel-tip" id="leader-panel-qr-tip">正在生成二维码…</div>' +
            LEADER_QR_SHARE_ROW_HTML +
            "</div>" +
            '<button type="button" class="leader-panel-close-btn" data-leader-panel-close>返回</button>' +
            "</div></div>";
        document.body.appendChild(modal);
        const panelQrRoot = modal.querySelector("#leader-panel-qr-view");
        bindLeaderQrShareRow(panelQrRoot, (force) => buildLeaderShareQrBundle({ force }));
        modal.addEventListener("click", (e) => {
            if (e.target === modal) setLeaderPanelModalOpen(false);
        });
        modal.querySelector(".leader-panel-dialog")?.addEventListener("click", (e) => e.stopPropagation());
        modal.querySelectorAll("[data-leader-panel-x],[data-leader-panel-close]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const qrView = modal.querySelector("#leader-panel-qr-view");
                const chooser = modal.querySelector("#leader-panel-chooser");
                if (qrView && !qrView.hidden) {
                    qrView.hidden = true;
                    if (chooser) chooser.hidden = false;
                    return;
                }
                setLeaderPanelModalOpen(false);
            });
        });
        modal.querySelector('[data-leader-panel-mode="qr"]')?.addEventListener("click", () => {
            void showLeaderPanelQrView(modal);
        });
        modal.querySelector('[data-leader-panel-mode="desktop"]')?.addEventListener("click", () => {
            setLeaderPanelModalOpen(false);
            openLeaderWindow();
        });
        modal.querySelector("[data-leader-panel-prev]")?.addEventListener("click", () => {
            if (leaderPanelQrIndex > 0) {
                leaderPanelQrIndex--;
                renderLeaderPanelQrPage(modal);
            }
        });
        modal.querySelector("[data-leader-panel-next]")?.addEventListener("click", () => {
            if (leaderPanelQrIndex < leaderPanelQrPages.length - 1) {
                leaderPanelQrIndex++;
                renderLeaderPanelQrPage(modal);
            }
        });
        return modal;
    }

    async function showLeaderPanelQrView(modal) {
        leaderShareQrBundleCache = null;
        const chooser = modal.querySelector("#leader-panel-chooser");
        const qrView = modal.querySelector("#leader-panel-qr-view");
        if (chooser) chooser.hidden = true;
        if (qrView) qrView.hidden = false;
        const tipEl = modal.querySelector("#leader-panel-qr-tip");
        if (tipEl) tipEl.textContent = "正在生成二维码…";
        const bundle = await buildLeaderShareQrBundle({ force: true });
        leaderPanelQrPages = bundle.pages || [];
        leaderPanelQrIndex = 0;
        if (!bundle.url) showToast(bundle.note || "无法生成，请减少诗歌或改用「复制分享码」", $("open-leader-btn"));
        renderLeaderShareQrView(qrView, bundle);
    }

    function renderLeaderPanelQrPage(modal) {
        renderLeaderShareQrView(modal.querySelector("#leader-panel-qr-view"), leaderShareQrBundleCache);
    }

    function setLeaderPanelModalOpen(open) {
        const modal = $("leader-panel-modal");
        if (!modal) return;
        modal.classList.toggle("is-open", !!open);
        modal.style.display = open ? "flex" : "none";
        if (!open) {
            const chooser = modal.querySelector("#leader-panel-chooser");
            const qrView = modal.querySelector("#leader-panel-qr-view");
            if (chooser) chooser.hidden = false;
            if (qrView) qrView.hidden = true;
        }
    }

    function openLeaderPanelModal() {
        if (isDisplay || isLeader) return;
        leaderShareQrBundleCache = null;
        const modal = ensureLeaderPanelModal();
        setLeaderPanelModalOpen(true);
    }

    function ensureLeaderQrPopup() {
        let popup = $("leader-qr-popup");
        if (popup && !popup.querySelector(".leader-qr-share-row")) {
            popup.remove();
            popup = null;
        }
        if (popup) return popup;
        popup = document.createElement("div");
        popup.id = "leader-qr-popup";
        popup.innerHTML =
            '<div class="leader-qr-popup-dialog" role="dialog" aria-modal="true">' +
            '<button type="button" class="leader-panel-close-x" data-leader-qr-popup-x aria-label="关闭">✕</button>' +
            '<h2 class="leader-panel-title">⇄ 传数据到平板/手机</h2>' +
            '<div class="leader-panel-qr-wrap">' +
            '<img id="leader-qr-popup-img" class="leader-panel-qr-img" width="200" height="200" alt="传数据二维码">' +
            '<div class="leader-panel-pager" id="leader-qr-popup-pager" hidden>' +
            '<button type="button" data-leader-qr-popup-prev aria-label="上一页">‹</button>' +
            '<span id="leader-qr-popup-pager-label">第1/1页</span>' +
            '<button type="button" data-leader-qr-popup-next aria-label="下一页">›</button>' +
            "</div>" +
            '<div class="leader-panel-tip" id="leader-qr-popup-tip">💡 用手机或平板扫描，可载入歌单、歌词、备注与编排。</div>' +
            LEADER_QR_SHARE_ROW_HTML +
            '<p class="leader-qr-popup-foot">建议截图保存；同一码可多台设备扫描（任意网络）</p>' +
            "</div>" +
            '<button type="button" class="leader-panel-close-btn" data-leader-qr-popup-close>关闭</button>' +
            "</div>";
        document.body.appendChild(popup);
        bindLeaderQrShareRow(popup.querySelector(".leader-qr-popup-dialog"), (force) => buildLeaderShareQrBundle({ force }));
        popup.addEventListener("click", (e) => {
            if (e.target === popup) setLeaderQrPopupOpen(false);
        });
        popup.querySelector(".leader-qr-popup-dialog")?.addEventListener("click", (e) => e.stopPropagation());
        popup.querySelectorAll("[data-leader-qr-popup-x],[data-leader-qr-popup-close]").forEach((btn) => {
            btn.addEventListener("click", () => setLeaderQrPopupOpen(false));
        });
        popup.querySelector("[data-leader-qr-popup-prev]")?.addEventListener("click", () => {
            if (leaderQrPopupIndex > 0) {
                leaderQrPopupIndex--;
                renderLeaderQrPopupPage(popup);
            }
        });
        popup.querySelector("[data-leader-qr-popup-next]")?.addEventListener("click", () => {
            if (leaderQrPopupIndex < leaderQrPopupPages.length - 1) {
                leaderQrPopupIndex++;
                renderLeaderQrPopupPage(popup);
            }
        });
        return popup;
    }

    function setLeaderQrPopupOpen(open) {
        const popup = $("leader-qr-popup");
        if (!popup) return;
        popup.classList.toggle("is-open", !!open);
        popup.style.display = open ? "flex" : "none";
    }

    function renderLeaderQrPopupPage(popup) {
        renderLeaderShareQrView(popup.querySelector(".leader-qr-popup-dialog"), leaderShareQrBundleCache);
    }

    async function openLeaderQrPopup() {
        leaderShareQrBundleCache = null;
        const popup = ensureLeaderQrPopup();
        const tipEl = popup.querySelector("#leader-qr-popup-tip");
        if (tipEl) tipEl.textContent = "正在生成二维码…";
        setLeaderQrPopupOpen(true);
        const bundle = await buildLeaderShareQrBundle({ force: true });
        leaderQrPopupPages = bundle.pages || [];
        leaderQrPopupIndex = 0;
        if (!bundle.url) showToast(bundle.note || "无法生成，请减少诗歌或复制分享码", null);
        renderLeaderShareQrView(popup.querySelector(".leader-qr-popup-dialog"), bundle);
    }

    function ensureLeaderBackupModal() {
        let modal = $("leader-backup-modal");
        if (modal && !modal.querySelector('[data-backup-v="4"]')) {
            modal.remove();
            modal = null;
        }
        if (modal) return modal;
        modal = document.createElement("div");
        modal.id = "leader-backup-modal";
        modal.innerHTML =
            '<div class="leader-backup-dialog" data-backup-v="4" role="dialog" aria-modal="true" style="width:min(450px,92vw);">' +
            '<button type="button" class="leader-panel-close-x" data-leader-backup-x aria-label="关闭">✕</button>' +
            '<h2 class="leader-panel-title leader-backup-head--mobile">💾 保存我的编辑</h2>' +
            '<h2 class="leader-panel-title leader-backup-head--desktop">💾 保存我的主领数据</h2>' +
            '<p class="leader-backup-purpose leader-backup-head--mobile">将您在本页修改的<b>歌单、歌词、改词、备注、编排与显示设置</b>打包保存。换手机、换浏览器或清除缓存后，扫描下方二维码或打开复制的链接，即可恢复当前内容。</p>' +
            '<p class="leader-panel-desc leader-backup-desc--desktop">打包播放列表歌词、改词、备注、编排与显示设置。截图保存下方二维码，日后扫描可恢复。</p>' +
            '<div class="leader-panel-qr-wrap">' +
            '<img id="leader-backup-qr-img" class="leader-panel-qr-img" width="200" height="200" alt="保存数据二维码">' +
            '<div class="leader-backup-warn" id="leader-backup-tip">正在生成…</div>' +
            '<button type="button" class="leader-backup-copy-link-btn" data-leader-backup-copy-link>复制链接</button>' +
            LEADER_QR_SHARE_ROW_HTML +
            "</div>" +
            '<button type="button" class="leader-panel-close-btn" data-leader-backup-close>关闭</button>' +
            "</div>";
        document.body.appendChild(modal);
        bindLeaderQrShareRow(modal.querySelector(".leader-backup-dialog"), (force) => buildLeaderShareQrBundle({ force }));
        const backupDialog = modal.querySelector(".leader-backup-dialog");
        backupDialog?.querySelector("[data-leader-backup-copy-link]")?.addEventListener("click", async (e) => {
            const bundle = await buildLeaderShareQrBundle({ force: true });
            await copyLeaderShareToClipboard(bundle.url, e.currentTarget);
        });
        modal.addEventListener("click", (e) => {
            if (e.target === modal) setLeaderBackupModalOpen(false);
        });
        backupDialog?.addEventListener("click", (e) => e.stopPropagation());
        modal.querySelectorAll("[data-leader-backup-x],[data-leader-backup-close]").forEach((btn) => {
            btn.addEventListener("click", () => setLeaderBackupModalOpen(false));
        });
        return modal;
    }

    let leaderBackupQrPages = [];
    let leaderBackupQrIndex = 0;

    function setLeaderBackupModalOpen(open) {
        const modal = $("leader-backup-modal");
        if (!modal) return;
        modal.classList.toggle("is-open", !!open);
        modal.style.display = open ? "flex" : "none";
    }

    function renderLeaderBackupQrPage(modal) {
        renderLeaderShareQrView(modal.querySelector(".leader-backup-dialog"), leaderShareQrBundleCache);
    }

    async function openLeaderBackupModal() {
        persistLeaderLocalSnapshot();
        leaderShareQrBundleCache = null;
        const modal = ensureLeaderBackupModal();
        setLeaderBackupModalOpen(true);
        const bundle = await buildLeaderShareQrBundle({ force: true });
        leaderBackupQrPages = bundle.pages || [];
        leaderBackupQrIndex = 0;
        if (!bundle.url) {
            showToast(bundle.note || "暂无歌单可保存", null);
        } else if (isLeaderCompactBackupViewport()) {
            showCornerSuccessToast("已保存到本机，请截图或复制链接", null);
        } else {
            showCornerSuccessToast("已保存到本机，请截图或复制链接/分享码", null);
        }
        renderLeaderShareQrView(modal.querySelector(".leader-backup-dialog"), bundle);
    }

    function collectLeaderShareSongsOrdered() {
        const pl = Array.isArray(state.playlist?.items) ? state.playlist.items : [];
        const byId = new Map(state.songs.map((s) => [String(s.id), s]));
        let ordered = [];
        if (pl.length) {
            const seen = new Set();
            for (const id of pl) {
                const sid = String(id);
                if (seen.has(sid)) continue;
                const s = byId.get(sid);
                if (s) {
                    seen.add(sid);
                    ordered.push(s);
                }
            }
        } else {
            ordered = Array.isArray(state.songs) ? [...state.songs] : [];
        }
        const cur = String(state.currentSongId || "");
        const ix = ordered.findIndex((x) => String(x.id) === cur);
        const currentIndex = ix >= 0 ? ix : 0;
        return { songs: ordered, currentIndex };
    }

    /** 扫码包内可选字段：主领本机偏好（与主领页 localStorage 键一致；不含自定义背景图与画笔图层以控制体积） */
    function readLeaderQrPackPrefsForExport() {
        const get = (k) => {
            try {
                return localStorage.getItem(k);
            } catch (_e) {
                return null;
            }
        };
        let dm = get("leader_display_mode") || "scroll";
        if (dm === "single") dm = "scroll";
        if (!["multi", "scroll", "flow"].includes(dm)) dm = "scroll";
        let bm = get("leader_bg_mode") || "particles";
        if (!["black", "white", "gray", "navy", "particles", "custom"].includes(bm)) bm = "particles";
        if (bm === "custom") bm = "particles";
        const tc = get("leader_toolbar_collapsed") === "1" ? 1 : 0;
        const fs = String(get("leader_font_size") || "").trim();
        const lc = String(get("leader_lyric_color_v1") || "").trim();
        const out = { dm, bm, tc };
        if (fs) out.fs = fs;
        if (lc) out.lc = lc;
        return out;
    }

    function readLeaderQrPackNotesForExport(maxRaw) {
        try {
            const raw = localStorage.getItem("leader_notes");
            if (!raw || raw.length > maxRaw) return null;
            const o = parseJSON(raw, null);
            if (!o || typeof o !== "object" || Array.isArray(o)) return null;
            return o;
        } catch (_e) {
            return null;
        }
    }

    function buildLeaderQrPackWfForExport(orderedSongs, count) {
        const wf = [];
        for (let i = 0; i < count; i++) {
            const s = orderedSongs[i];
            const f = s && s.leaderWorshipFlow;
            if (f && Array.isArray(f.cards) && f.cards.length) {
                wf.push({ v: Number(f.version) || 1, c: f.cards });
            } else wf.push(null);
        }
        return wf;
    }

    function buildLeaderQrPackLpTiers(orderedSongs, songCount) {
        const prefs = readLeaderQrPackPrefsForExport();
        const wf = buildLeaderQrPackWfForExport(orderedSongs, songCount);
        const wfHas = wf.some(Boolean);
        const nt = readLeaderQrPackNotesForExport(8000);
        const tiers = [];
        if (wfHas && nt) tiers.push({ ...prefs, wf, nt });
        if (wfHas) tiers.push({ ...prefs, wf });
        if (nt) tiers.push({ ...prefs, nt });
        tiers.push({ ...prefs });
        const seen = new Set();
        const out = [];
        tiers.forEach((t) => {
            const k = JSON.stringify(t);
            if (seen.has(k)) return;
            seen.add(k);
            out.push(t);
        });
        return out;
    }

    function normalizeLeaderPackLyricColorImport(raw) {
        const s = String(raw || "").trim();
        if (!s) return "";
        if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
        if (/^#[0-9a-fA-F]{3}$/.test(s)) {
            const a = s.slice(1);
            return ("#" + a[0] + a[0] + a[1] + a[1] + a[2] + a[2]).toLowerCase();
        }
        return "";
    }

    function applyLeaderQrPackPrefsFromImport(lp, songsOut) {
        if (!lp || typeof lp !== "object") return;
        const safeSet = (k, v) => {
            try {
                if (v === undefined || v === null) return;
                const s = String(v);
                if (!s && k !== "leader_toolbar_collapsed") return;
                localStorage.setItem(k, s);
            } catch (_e) {
                /* ignore */
            }
        };
        try {
            if (lp.dm && ["multi", "scroll", "flow"].includes(String(lp.dm))) safeSet("leader_display_mode", String(lp.dm));
            if (lp.bm && ["black", "white", "gray", "navy", "particles"].includes(String(lp.bm))) {
                safeSet("leader_bg_mode", String(lp.bm));
            }
            if (lp.tc === 0 || lp.tc === 1 || lp.tc === "0" || lp.tc === "1") {
                safeSet("leader_toolbar_collapsed", lp.tc === 1 || lp.tc === "1" ? "1" : "0");
            }
            if (lp.fs != null && String(lp.fs).trim()) safeSet("leader_font_size", String(lp.fs).trim());
            const lcOk = normalizeLeaderPackLyricColorImport(lp.lc);
            if (lcOk) safeSet("leader_lyric_color_v1", lcOk);
            else if (lp.lc === "" || lp.lc === null) {
                try {
                    localStorage.removeItem("leader_lyric_color_v1");
                } catch (_e2) {
                    /* ignore */
                }
            }
            if (lp.nt && typeof lp.nt === "object" && !Array.isArray(lp.nt)) {
                if (typeof setStore === "function") setStore("leader_notes", lp.nt);
                else localStorage.setItem("leader_notes", JSON.stringify(lp.nt));
            }
        } catch (_e3) {
            /* ignore */
        }
        if (Array.isArray(lp.wf) && Array.isArray(songsOut) && songsOut.length) {
            lp.wf.forEach((entry, ix) => {
                if (ix >= songsOut.length) return;
                if (entry && Array.isArray(entry.c) && entry.c.length) {
                    songsOut[ix].leaderWorshipFlow = { version: Number(entry.v) || 1, cards: entry.c };
                }
            });
        }
    }

    function bytesToBase64Url(u8) {
        const CHUNK = 0x8000;
        let b = "";
        for (let i = 0; i < u8.length; i += CHUNK) {
            b += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CHUNK, u8.length)));
        }
        const bin = btoa(b);
        return bin.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    }

    function base64UrlToBytes(s) {
        let t = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
        while (t.length % 4) t += "=";
        const bin = atob(t);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return u8;
    }

    async function gzipU8(u8) {
        const cs = new CompressionStream("gzip");
        const buf = await new Response(new Blob([u8]).stream().pipeThrough(cs)).arrayBuffer();
        return new Uint8Array(buf);
    }

    async function gunzipU8(u8) {
        const ds = new DecompressionStream("gzip");
        const buf = await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
        return new Uint8Array(buf);
    }

    async function encodeWorshipPackForQrString(payload) {
        const json = JSON.stringify(payload);
        const enc = new TextEncoder().encode(json);
        if (typeof CompressionStream !== "undefined") {
            try {
                const gz = await gzipU8(enc);
                return "W1" + bytesToBase64Url(gz);
            } catch (_e) {
                /* fall through */
            }
        }
        return "W0" + bytesToBase64Url(enc);
    }

    async function buildLeaderSongPackQrPayload(maxLen = WORSHIP_QR_PACK_MAX_CHARS) {
        const { songs: ordered, currentIndex: origCi } = collectLeaderShareSongsOrdered();
        if (!ordered.length) {
            return { qrText: "", songCount: 0, totalWanted: 0, truncated: false, note: "当前没有可分享的诗歌" };
        }
        let list = ordered.map((s) => ({ title: s.title || "", lyrics: s.lyrics || "" }));
        let ci = clamp(origCi, 0, list.length - 1);
        let truncated = false;
        let note = "";

        const tryPack = async (lite) => {
            const sty = {
                ff: state.ui.fontFamily,
                fc: state.ui.fontColor,
                fs: state.ui.fontSize,
                fw: state.ui.fontWeight,
                py: state.ui.posY,
                dl: state.ui.defaultLines
            };
            const basePayload = () => ({
                v: 1,
                ci: clamp(ci, 0, Math.max(0, lite.length - 1)),
                s: lite.map((x) => [x.title, x.lyrics]),
                sty
            });
            const tiers = buildLeaderQrPackLpTiers(ordered, lite.length);
            for (let t = 0; t < tiers.length; t++) {
                const payload = basePayload();
                payload.lp = tiers[t];
                const text = await encodeWorshipPackForQrString(payload);
                if (text.length <= maxLen) return text;
            }
            return encodeWorshipPackForQrString(basePayload());
        };

        while (list.length >= 1) {
            let text = await tryPack(list);
            if (text.length <= maxLen) {
                return {
                    qrText: text,
                    songCount: list.length,
                    totalWanted: ordered.length,
                    truncated: truncated || list.length < ordered.length,
                    note: note || (list.length < ordered.length ? `含 ${list.length}/${ordered.length} 首` : "")
                };
            }
            if (list.length === 1) {
                const fullLy = String(list[0].lyrics || "");
                let L = fullLy;
                let guard = 0;
                while (L.length > 24 && guard++ < 40) {
                    L = L.slice(0, Math.floor(L.length * 0.62));
                    const one = { title: list[0].title || "", lyrics: L + (L.length < fullLy.length ? "\n…（已缩短）" : "") };
                    list = [one];
                    text = await tryPack(list);
                    if (text.length <= maxLen) {
                        return {
                            qrText: text,
                            songCount: 1,
                            totalWanted: ordered.length,
                            truncated: true,
                            note: "歌词过长已自动缩短，完整版请用「导出」"
                        };
                    }
                }
                return {
                    qrText: "",
                    songCount: 0,
                    totalWanted: ordered.length,
                    truncated: true,
                    note: "内容仍超出单码容量，请减少诗歌或删减歌词，或使用「导出」分享文件"
                };
            }
            list = list.slice(0, -1);
            ci = Math.min(ci, list.length - 1);
            truncated = true;
            note = `已自动省略部分诗歌，当前 ${list.length}/${ordered.length} 首`;
        }
        return { qrText: "", songCount: 0, totalWanted: ordered.length, truncated: true, note: "无法生成" };
    }

    /** 生成「手机浏览器可打开」的主领链接：?leader=1#wp1=诗歌包（gzip 单码，跨网） */
    async function buildLeaderSongPackAndOpenUrl() {
        const baseFull = getLeaderQrShareEntryUrl();
        if (!baseFull) {
            const built = await buildLeaderSongPackQrPayload();
            return {
                ...built,
                openUrl: "",
                scanKind: "empty",
                scanHint: "无法确定分享地址"
            };
        }
        let maxPack = Math.min(
            WORSHIP_QR_PACK_MAX_CHARS,
            Math.max(900, LEADER_QR_OPEN_URL_MAX - baseFull.length - 14)
        );
        let built = await buildLeaderSongPackQrPayload(maxPack);
        let openUrl = "";
        for (let attempt = 0; attempt < 14; attempt++) {
            if (!built.qrText) break;
            openUrl = `${baseFull}#wp1=${encodeURIComponent(built.qrText)}`;
            if (openUrl.length <= LEADER_QR_OPEN_URL_MAX) break;
            maxPack = Math.max(420, Math.floor(maxPack * 0.82));
            built = await buildLeaderSongPackQrPayload(maxPack);
        }
        if (built.qrText && openUrl && openUrl.length <= LEADER_QR_OPEN_URL_MAX) {
            return { ...built, openUrl, scanKind: "url", scanHint: "" };
        }
        return {
            qrText: built.qrText || "",
            songCount: built.songCount,
            totalWanted: built.totalWanted,
            truncated: true,
            note: built.note || "",
            openUrl: "",
            scanKind: built.qrText ? "too-long" : "empty",
            scanHint: built.qrText
                ? "诗歌内容过多，请减少诗歌或使用「复制分享码」/「导出」。"
                : built.note || "无法生成"
        };
    }

    async function decodeWorshipPackFromRawString(raw) {
        const s = String(raw || "").trim().replace(/\s+/g, "");
        if (!/^W[01]/.test(s)) throw new Error("应以 W0 或 W1 开头");
        const mode = s.slice(0, 2);
        const b64 = s.slice(2);
        let bytes = base64UrlToBytes(b64);
        if (mode === "W1") bytes = await gunzipU8(bytes);
        const obj = parseJSON(new TextDecoder().decode(bytes), null);
        if (!obj || obj.v !== 1) throw new Error("数据版本无效");
        return obj;
    }

    function applyWorshipSongPackFromObject(data, anchorEl) {
        const anchor = anchorEl || $("import-data-btn") || $("leader-qr-btn");
        if (!data || data.v !== 1 || !Array.isArray(data.s)) {
            showToast("诗歌包无效", anchor);
            return false;
        }
        const rows = data.s.filter((x) => Array.isArray(x) && x.length >= 2);
        if (!rows.length) {
            showToast("包内无歌词", anchor);
            return false;
        }
        const songs = rows.map(([title, lyrics]) => ({
            id: uid(),
            ...DEFAULT_SONG,
            title: String(title ?? ""),
            lyrics: String(lyrics ?? "")
        }));
        if (data.sty && typeof data.sty === "object") {
            const st = data.sty;
            if (st.ff != null && String(st.ff).trim()) state.ui.fontFamily = String(st.ff);
            if (st.fc != null && String(st.fc).trim()) state.ui.fontColor = String(st.fc);
            if (st.fs != null) state.ui.fontSize = clampLyricFontSize(st.fs);
            if (st.fw != null && String(st.fw).trim()) state.ui.fontWeight = String(st.fw);
            if (st.py != null && Number.isFinite(Number(st.py))) state.ui.posY = clamp(Number(st.py), 20, 70);
            if (st.dl != null && Number.isFinite(Number(st.dl))) state.ui.defaultLines = clamp(Number(st.dl), 1, 12);
        }
        applyLeaderQrPackPrefsFromImport(data.lp, songs);
        const ci = clamp(Number(data.ci) || 0, 0, songs.length - 1);
        state.songs = songs;
        state.playlist.items = songs.map((x) => x.id);
        state.playlist.activeIndex = ci;
        state.playlist.running = state.playlist.items.length > 0;
        state.currentSongId = songs[ci].id;
        state.currentPage = 0;
        if (!isDisplay && !isLeader) {
            refreshBackgroundDefaultsFromUi();
            hydrateCurrentSongBackgroundIntoUi();
        }
        try {
            setStore(STORAGE.SONGS, state.songs);
        } catch (_e) {
            /* ignore */
        }
        try {
            savePlaylist();
            saveSettings();
        } catch (_e) {
            /* ignore */
        }
        try {
            if (typeof globalThis.loadState === "function") globalThis.loadState();
        } catch (_e) {
            /* ignore */
        }
        try {
            hydrateAppStateFromStorage();
        } catch (_e) {
            /* ignore */
        }
        syncSongToEditor();
        broadcastState();
        try {
            if (typeof globalThis.applyLive === "function") globalThis.applyLive("leader", liveState);
        } catch (_e) {
            /* ignore */
        }
        if (isLeader && typeof globalThis.__leaderReloadAfterPackImport === "function") {
            try {
                globalThis.__leaderReloadAfterPackImport();
            } catch (_e) {
                /* ignore */
            }
        } else if (!isLeader) {
            updateAll();
        }
        showCornerSuccessToast(`已导入 ${songs.length} 首诗歌`, anchor);
        return true;
    }

    globalThis.decodeWorshipPackFromRawString = decodeWorshipPackFromRawString;
    globalThis.applyWorshipSongPackFromObject = applyWorshipSongPackFromObject;

    async function refreshLeaderQrModalContent(modal) {
        const img = modal.querySelector("#leader-qr-image");
        const warn = modal.querySelector("#leader-qr-warn");
        const status = modal.querySelector("#leader-qr-pack-status");
        if (img) img.style.opacity = "0.4";
        let built;
        try {
            built = await buildLeaderSongPackAndOpenUrl();
        } catch (e) {
            built = {
                qrText: "",
                openUrl: "",
                songCount: 0,
                totalWanted: 0,
                truncated: true,
                note: String(e.message || e),
                scanKind: "error",
                scanHint: String(e.message || e)
            };
        }
        const cnt = Number(built.songCount);
        const songN = Number.isFinite(cnt) ? cnt : 0;
        const adv = modal.querySelector("#leader-qr-adv");
        if (status) {
            const extra = [built.note, built.truncated ? "部分内容已精简" : ""].filter(Boolean).join(" · ");
            if (built.scanKind === "url" && built.openUrl) {
                status.textContent = `含 ${songN} 首 · 手机扫二维码打开主领页${extra ? `（${extra}）` : ""}`;
            } else if (built.qrText) {
                status.textContent = `含 ${songN} 首 · ${built.scanHint || "请配置下方访问地址"}`;
            } else {
                status.textContent = built.scanHint || built.note || "无法生成二维码";
            }
        }
        if (warn) {
            if (built.scanKind === "url" && built.openUrl) {
                warn.hidden = true;
            } else {
                warn.hidden = false;
                warn.textContent =
                    built.scanHint ||
                    built.note ||
                    (built.qrText
                        ? "无法生成网页链接码（file/localhost 或未填地址）。勿扫纯文本备用码；请配置下方地址或主领页「诗歌」粘贴导入。"
                        : "生成失败");
            }
        }
        if (adv) adv.open = !(built.scanKind === "url" && built.openUrl);
        const scanUrl = String(built.openUrl || "").trim();
        const packFallback = String(built.qrText || "").trim();
        const ph = modal.querySelector("#leader-qr-placeholder");
        const imgWrap = modal.querySelector("#leader-qr-img-wrap");
        if (imgWrap) imgWrap.style.display = scanUrl ? "" : "none";
        if (ph) ph.hidden = !!scanUrl;
        if (img) {
            if (scanUrl) {
                img.hidden = false;
                img.alt = "打开主领页链接";
                if (scanUrl) modal.dataset.lastOpenUrl = scanUrl;
                else delete modal.dataset.lastOpenUrl;
                if (packFallback) modal.dataset.lastPackQr = packFallback;
                else delete modal.dataset.lastPackQr;
                const enc = encodeURIComponent(scanUrl);
                const primary = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&data=${enc}`;
                const fallback = `https://quickchart.io/qr?size=220&margin=1&text=${enc}`;
                img.onerror = function () {
                    img.onerror = null;
                    img.src = fallback;
                };
                img.src = primary;
                img.style.opacity = "1";
            } else {
                delete modal.dataset.lastOpenUrl;
                if (packFallback) modal.dataset.lastPackQr = packFallback;
                else delete modal.dataset.lastPackQr;
                img.removeAttribute("src");
                img.style.opacity = "0.2";
                img.onerror = null;
                img.hidden = true;
            }
        }
    }

    function setLeaderQrModalOpen(modal, open) {
        if (!modal) return;
        modal.classList.toggle("is-open", !!open);
        modal.style.display = open ? "flex" : "none";
    }

    function openLeaderQrModal() {
        let modal = $("leader-qr-modal");
        if (modal && !modal.querySelector(".leader-qr-panel")) {
            modal.remove();
            modal = null;
        }
        if (!modal) {
            modal = document.createElement("div");
            modal.id = "leader-qr-modal";
            modal.innerHTML = `
                <div class="leader-qr-panel" role="dialog" aria-modal="true" aria-labelledby="leader-qr-title">
                    <button type="button" id="leader-qr-close" class="leader-qr-close" aria-label="关闭">✕</button>
                    <h2 id="leader-qr-title" class="leader-qr-title">⇄ 传数据到平板/手机</h2>
                    <p id="leader-qr-pack-status" class="leader-qr-status">正在生成…</p>
                    <div id="leader-qr-img-wrap" class="leader-qr-img-wrap">
                        <img id="leader-qr-image" width="220" height="220" alt="传数据二维码">
                    </div>
                    <div id="leader-qr-placeholder" class="leader-qr-placeholder" hidden>
                        暂无法显示链接二维码。请展开下方「配置访问地址」填写站点根路径后点「保存地址」。
                    </div>
                    <div id="leader-qr-warn" class="leader-qr-warn" hidden></div>
                    <details id="leader-qr-help" class="leader-qr-details">
                        <summary>使用说明</summary>
                        <div class="leader-qr-details-body">
                            <p>用手机或平板扫上方码，打开<b>主领视角</b>并载入歌单、歌词、备注与编排，便于在移动设备上继续编辑。</p>
                            <ul>
                                <li><b>多个二维码</b>：内容过多时会拆成多页（显示「第 1/3 个码」等）。请先扫第 1 个，再在本窗点 › 显示第 2 个并扫描，依此类推，直到扫完；手机会提示是否还需继续扫。</li>
                                <li><b>公网 https</b>：平板/手机可与电脑不同 Wi‑Fi（如 GitHub Pages、自有域名、ngrok 等）。</li>
                                <li><b>局域网地址</b>：须与电脑同一 Wi‑Fi。</li>
                                <li>无法扫描：配置下方地址，或在主领页「诗歌」粘贴完整链接导入。</li>
                            </ul>
                        </div>
                    </details>
                    <details id="leader-qr-adv" class="leader-qr-details">
                        <summary>配置访问地址</summary>
                        <div class="leader-qr-details-body">
                            <label class="leader-qr-base-label" for="leader-qr-base-input">站点根地址（以 <code>/</code> 结尾，指向含 index.html 的目录）</label>
                            <input type="url" id="leader-qr-base-input" class="leader-qr-base-input" placeholder="https://你的域名/WorshipApp/" autocomplete="url" inputmode="url">
                            <p id="leader-qr-url-hint" class="leader-qr-url-hint"></p>
                            <div class="leader-qr-actions">
                                <button type="button" id="leader-qr-use-public-base" class="btn btn-outline">填入当前 https</button>
                                <button type="button" id="leader-qr-save-base" class="btn btn-outline">保存地址</button>
                                <button type="button" id="leader-qr-copy-url" class="btn btn-outline">复制链接</button>
                            </div>
                        </div>
                    </details>
                    <div class="leader-qr-footer">
                        <button type="button" id="leader-qr-copy" class="btn btn-outline">复制链接或备用文本</button>
                    </div>
                </div>
            `;
            modal.addEventListener("click", (e) => {
                if (e.target === modal) setLeaderQrModalOpen(modal, false);
            });
            modal.querySelector(".leader-qr-panel")?.addEventListener("click", (e) => e.stopPropagation());
            document.body.appendChild(modal);
            modal.querySelector("#leader-qr-close")?.addEventListener("click", () => {
                setLeaderQrModalOpen(modal, false);
            });
            try {
                const inp = modal.querySelector("#leader-qr-base-input");
                if (inp) inp.value = String(localStorage.getItem(LEADER_QR_BASE_LS_KEY) || "");
            } catch (_e) {
                /* ignore */
            }
            modal.querySelector("#leader-qr-save-base")?.addEventListener("click", (e) => {
                const inp = modal.querySelector("#leader-qr-base-input");
                const v = String(inp?.value || "").trim();
                try {
                    if (v) localStorage.setItem(LEADER_QR_BASE_LS_KEY, v);
                    else localStorage.removeItem(LEADER_QR_BASE_LS_KEY);
                } catch (_e) {
                    /* ignore */
                }
                const hint = modal.querySelector("#leader-qr-url-hint");
                const r = resolveLeaderJoinUrlForQr();
                if (hint) hint.textContent = r.qrEncode || r.pageAbs || "（未填写）";
                showCornerSuccessToast(v ? "已保存" : "已清除", e.currentTarget);
                void refreshLeaderQrModalContent(modal);
            });
            modal.querySelector("#leader-qr-use-public-base")?.addEventListener("click", (e) => {
                const pub = String(derivePublicHttpsLeaderJoinBaseFromLocation() || "").trim();
                const inp = modal.querySelector("#leader-qr-base-input");
                if (!pub) {
                    showToast("当前页不是公网 https，请手动粘贴部署或穿透地址。", e.currentTarget);
                    return;
                }
                if (inp) inp.value = pub;
                try {
                    localStorage.setItem(LEADER_QR_BASE_LS_KEY, pub);
                } catch (_e) {
                    /* ignore */
                }
                const hint = modal.querySelector("#leader-qr-url-hint");
                const r = resolveLeaderJoinUrlForQr();
                if (hint) hint.textContent = r.qrEncode || r.pageAbs || pub;
                showCornerSuccessToast("已填入并保存公网根地址", e.currentTarget);
                void refreshLeaderQrModalContent(modal);
            });
            modal.querySelector("#leader-qr-copy-url")?.addEventListener("click", async (e) => {
                const text = String(modal.dataset.lastOpenUrl || "").trim();
                if (!text) {
                    showToast("请先生成可扫描的传数据链接（填写地址并保存）", e.currentTarget);
                    return;
                }
                try {
                    await navigator.clipboard.writeText(text);
                    showCornerSuccessToast("已复制传数据链接", e.currentTarget);
                } catch (_e) {
                    showToast("复制失败", e.currentTarget);
                }
            });
            modal.querySelector("#leader-qr-copy")?.addEventListener("click", async (e) => {
                const openU = String(modal.dataset.lastOpenUrl || "").trim();
                const pack = String(modal.dataset.lastPackQr || "").trim();
                const text = openU || pack;
                if (!text) {
                    showToast("暂无可复制内容", e.currentTarget);
                    return;
                }
                try {
                    await navigator.clipboard.writeText(text);
                    showCornerSuccessToast(
                        openU ? "已复制打开链接" : "已复制备用文本，可在主领页「诗歌」里粘贴",
                        e.currentTarget
                    );
                } catch (_e) {
                    showToast("复制失败", e.currentTarget);
                }
            });
        }
        const hint0 = modal.querySelector("#leader-qr-url-hint");
        if (hint0) {
            const r = resolveLeaderJoinUrlForQr();
            hint0.textContent = r.qrEncode
                ? `将生成：${r.qrEncode}${r.crossInternetOk ? "（可跨网）" : "（跨网请用公网 https）"}`
                : "未配置地址：公网 https 可跨 Wi‑Fi；局域网须同网。在公网页可点「填入当前 https」。";
        }
        void refreshLeaderQrModalContent(modal);
        setLeaderQrModalOpen(modal, true);
    }

    function exportData() {
        syncEditorToSong();
        saveSongs();
        saveSettings();
        const payload = {
            songs: state.songs,
            settings: {
                currentSongId: state.currentSongId,
                currentPage: state.currentPage,
                sizePreset: state.sizePreset,
                ui: state.ui
            }
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const fname = buildExportWorshipFilename();
        a.download = fname;
        a.click();
        URL.revokeObjectURL(url);
        showCornerSuccessToast(`✅ 已导出为 ${fname}，可在浏览器下载记录中查看`, $("export-data-btn"));
    }

    function importData(file) {
        const reader = new FileReader();
        reader.onload = () => {
            const data = parseJSON(String(reader.result || ""), null);
            if (!data || !Array.isArray(data.songs) || !data.songs.length) {
                showToast("导入失败", $("import-data-btn"));
                return;
            }
            state.songs = data.songs;
            const settings = data.settings || {};
            state.currentSongId = settings.currentSongId || state.songs[0].id;
            state.currentPage = Number.isFinite(settings.currentPage) ? settings.currentPage : 0;
            state.sizePreset = settings.sizePreset || "M";
            if (settings.ui && typeof settings.ui === "object") {
                state.ui = { ...state.ui, ...settings.ui };
            }
            if (state.ui.fontWeight == null || state.ui.fontWeight === "") {
                state.ui.fontWeight = "700";
            }
            if (!state.ui.bgImageId) state.ui.bgImageId = "";
            normalizeLegacyBgImageReference();
            refreshBackgroundDefaultsFromUi();
            hydrateCurrentSongBackgroundIntoUi();
            updateUIFromState();
            syncSongToEditor();
            renderSongList();
            updateSpeakerCards();
            renderMiniPreview();
            renderPlaylist();
            broadcastState();
            showCornerSuccessToast("✅ 已导入", $("import-data-btn"));
        };
        reader.readAsText(file, "utf-8");
    }

    function stopAutoplay() {
        if (state.autoplay.timer) clearInterval(state.autoplay.timer);
        if (state.autoplay.progressTimer) clearInterval(state.autoplay.progressTimer);
        state.autoplay.timer = null;
        state.autoplay.progressTimer = null;
        state.autoplay.running = false;
        state.autoplay.elapsed = 0;
        if ($("autoplay-progress")) $("autoplay-progress").style.width = "0%";
    }

    function startAutoplay() {
        stopAutoplay();
        const seconds = clamp(Number($("autoplay-interval")?.value || 5), 1, 30);
        const interval = seconds * 1000;
        state.autoplay.running = true;
        state.autoplay.timer = setInterval(() => {
            const pages = splitPages(getStablePagingLyricsForPageSplit(), state.ui.defaultLines);
            if (!pages.length) return;
            state.currentPage = (state.currentPage + 1) % pages.length;
            updateAll();
            state.autoplay.elapsed = 0;
        }, interval);
        state.autoplay.progressTimer = setInterval(() => {
            state.autoplay.elapsed += 100;
            const pct = clamp((state.autoplay.elapsed / interval) * 100, 0, 100);
            if ($("autoplay-progress")) $("autoplay-progress").style.width = pct + "%";
        }, 100);
    }

    /** 投屏/主领弹窗：用于窗口尺寸与 Safari（macOS）兼容策略 */
    function isWorshipMacLikePlatform() {
        const p = navigator.platform || "";
        const ua = navigator.userAgent || "";
        if (/^Win/i.test(p)) return false;
        if (/^Mac/i.test(p)) return true;
        return /Mac OS X|iPhone|iPad/i.test(ua);
    }

    /**
     * 估算投屏窗口位置与大小。
     * macOS / Safari：用当前工作区内「居中、略小于满屏」的尺寸打开，避免整屏 window.open + resizeTo 被忽略或窗口落到错误桌面空间。
     * Windows / Linux 多屏：在疑似扩展屏时仍将窗口起点放在主屏工作区右侧（便于拖到投影仪），尺寸同样略小于满屏以提升弹窗通过率。
     */
    function getDisplayWindowPlacement() {
        const scr = window.screen;
        const availLeft = Number(scr.availLeft) || 0;
        const availTop = Number(scr.availTop) || 0;
        const availWidth = Math.max(400, Number(scr.availWidth) || 1280);
        const availHeight = Math.max(300, Number(scr.availHeight) || 720);
        const screenWidth = Number(scr.width) || availWidth;

        const maxW = Math.floor(availWidth * 0.96);
        const maxH = Math.floor(availHeight * 0.96);
        const w = clamp(Math.floor(availWidth * 0.92), 800, maxW);
        const h = clamp(Math.floor(availHeight * 0.92), 540, maxH);

        const centerIn = (workLeft, workTop, workW, workH) => ({
            left: workLeft + Math.max(0, Math.floor((workW - w) / 2)),
            top: workTop + Math.max(0, Math.floor((workH - h) / 2)),
            width: w,
            height: h
        });

        const mac = isWorshipMacLikePlatform();
        if (mac) {
            return centerIn(availLeft, availTop, availWidth, availHeight);
        }

        const likelySingleScreen = availLeft === 0 && screenWidth <= availWidth + 2;
        if (likelySingleScreen) {
            return centerIn(availLeft, availTop, availWidth, availHeight);
        }
        return {
            left: availLeft + availWidth,
            top: availTop + Math.max(0, Math.floor((availHeight - h) / 2)),
            width: w,
            height: h
        };
    }

    try {
        globalThis.__worshipGetProjectionWindowPlacement = getDisplayWindowPlacement;
    } catch (_e) {
        /* ignore */
    }

    function openDisplayOnSecondScreen(url, windowName, toastAnchor) {
        const { left, top, width, height } = getDisplayWindowPlacement();
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
        const name =
            String(windowName || "").trim() ||
            "worship_proj_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
        const targetUrl = String(url || "").trim() || "./index.html";
        /** 直接打开目标 URL，避免 about:blank 再 replace 在部分环境与策略下失败 */
        let win = null;
        try {
            win = window.open(targetUrl, name, feats);
        } catch (err) {
            console.warn("window.open", err);
        }
        if (!win) {
            try {
                win = window.open(targetUrl, name);
            } catch (err2) {
                console.warn("window.open fallback", err2);
            }
        }
        if (!win) {
            showPopupBlockedBanner();
            showToast(
                "无法打开窗口，请允许弹窗",
                toastAnchor || $("open-display-btn") || $("open-leader-btn")
            );
            return null;
        }
        const applyPlacement = () => {
            try {
                win.moveTo(left, top);
                win.resizeTo(width, height);
            } catch (e) {
                console.log("定位投屏窗口失败", e);
            }
        };
        applyPlacement();
        if (isWorshipMacLikePlatform()) {
            window.setTimeout(applyPlacement, 100);
            window.setTimeout(applyPlacement, 380);
        }
        /** 新窗口打开后焦点回到主控台，便于继续在控制台操作或点「结束投屏」 */
        if (!isDisplay && !isLeader) refocusMainWindowForOperator();
        return win;
    }

    function openDisplayWindow() {
        const anchor = $("open-display-btn");
        let w = projectionDisplayWindowRef;
        if (w && w.closed) {
            projectionDisplayWindowRef = null;
            w = null;
        }
        if (w && !w.closed) {
            try {
                w.focus();
            } catch (_e) {
                /* ignore */
            }
            safeBroadcastState("openDisplayWindow:focus-existing");
            noteProjectionDisplayAlive();
            hideRestoreProjectionBanner();
            syncProjectionPanelControls();
            return;
        }
        /** 新开前：通知所有会众投屏页自行关闭并释放主控引用，避免多窗口残留后台；仍须与 window.open 同一次点击栈内完成 */
        closeProjectionDisplayWindow({ silent: true });
        /** 先 window.open（须留在用户点击的同步栈内），再广播状态，避免 broadcastState 抛错或耗时导致弹窗被拦截 */
        let newWin = openDisplayOnSecondScreen(
            projectionEntryUrl("display"),
            WORSHIP_PROJECTION_DISPLAY_WINDOW_NAME,
            anchor
        );
        safeBroadcastState("openDisplayWindow:after-open");
        if (newWin && !newWin.closed) {
            projectionDisplayWindowRef = newWin;
            attachProjectionDisplayWindow(newWin);
            noteProjectionDisplayAlive();
            hideRestoreProjectionBanner();
            syncProjectionPanelControls();
            return;
        }
        noteProjectionDisplayGone();
        syncProjectionPanelControls();
    }

    function handleOpenDisplayBtnClick() {
        if (projectionDisplayWindowRef && !projectionDisplayWindowRef.closed) {
            requestCloseProjectionDisplayViaPostMessage();
            return;
        }
        if (projectionDisplayAliveViaChannel) {
            noteProjectionDisplayGone();
            try {
                if (channel) channel.postMessage({ type: "main_projection_end", source: "main" });
            } catch (_e) {
                /* ignore */
            }
        }
        openDisplayWindow();
    }

    function openLeaderWindow() {
        const anchor = $("open-leader-btn");
        const leaderWinName =
            "worship_leader_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
        openDisplayOnSecondScreen(projectionEntryUrl("leader"), leaderWinName, anchor);
        safeBroadcastState("openLeaderWindow:after-open");
    }

    try {
        globalThis.__worshipOpenDisplayWindow = openDisplayWindow;
        globalThis.__worshipOpenLeaderWindow = openLeaderWindow;
        globalThis.__worshipCloseProjectionDisplayWindow = closeProjectionDisplayWindow;
    } catch (_e) {
        /* ignore */
    }

    function initResizable() {
        const left = $("song-library");
        const right = $("preview-panel");
        const r1 = $("resize1");
        const r2 = $("resize2");
        if (!left || !right || !r1 || !r2) return;
        const bind = (handle, target, min, max, invert = false) => {
            let active = false;
            let sx = 0;
            let sw = 0;
            handle.style.cursor = "ew-resize";
            handle.style.touchAction = "none";
            const start = (clientX) => {
                active = true;
                sx = clientX;
                sw = target.getBoundingClientRect().width;
                handle.classList.add("active");
                document.body.style.userSelect = "none";
            };
            const move = (clientX) => {
                if (!active) return;
                const dx = clientX - sx;
                const w = clamp(sw + (invert ? -dx : dx), min, max);
                target.style.width = w + "px";
            };
            const end = () => {
                if (!active) return;
                active = false;
                handle.classList.remove("active");
                document.body.style.userSelect = "";
            };
            handle.addEventListener("mousedown", (e) => {
                start(e.clientX);
                e.preventDefault();
            });
            handle.addEventListener("touchstart", (e) => {
                const t = e.touches?.[0];
                if (!t) return;
                start(t.clientX);
                e.preventDefault();
            }, { passive: false });
            window.addEventListener("mousemove", (e) => {
                move(e.clientX);
            });
            window.addEventListener("touchmove", (e) => {
                const t = e.touches?.[0];
                if (!t) return;
                move(t.clientX);
                if (active) e.preventDefault();
            }, { passive: false });
            window.addEventListener("mouseup", () => {
                end();
            });
            window.addEventListener("touchend", () => {
                end();
            });
            window.addEventListener("touchcancel", () => {
                end();
            });
        };
        bind(r1, left, 200, 520, false);
        bind(r2, right, 240, 900, true);
    }

    function initPreviewResize() {
        const handle = $("preview-resize-handle");
        const mini = $("mini-preview");
        if (!handle || !mini) return;
        let active = false;
        let sy = 0;
        let sh = 0;
        handle.style.cursor = "ns-resize";
        handle.addEventListener("mousedown", (e) => {
            active = true;
            sy = e.clientY;
            sh = mini.getBoundingClientRect().height;
            document.body.style.userSelect = "none";
            e.preventDefault();
        });
        window.addEventListener("mousemove", (e) => {
            if (!active) return;
            const h = clamp(sh + (e.clientY - sy), 90, 420);
            mini.style.height = h + "px";
            mini.style.aspectRatio = "auto";
        });
        window.addEventListener("mouseup", () => {
            if (!active) return;
            active = false;
            document.body.style.userSelect = "";
        });
    }

    let openDisplayHelpBackdropEl = null;
    let openDisplayHelpPanelEl = null;
    let openDisplayHelpRepositionHandler = null;
    let openDisplayHelpEscapeHandler = null;

    function closeOpenDisplayHelpPanel() {
        if (openDisplayHelpRepositionHandler) {
            window.removeEventListener("resize", openDisplayHelpRepositionHandler);
            window.removeEventListener("scroll", openDisplayHelpRepositionHandler, true);
            openDisplayHelpRepositionHandler = null;
        }
        if (openDisplayHelpEscapeHandler) {
            document.removeEventListener("keydown", openDisplayHelpEscapeHandler);
            openDisplayHelpEscapeHandler = null;
        }
        if (openDisplayHelpBackdropEl) {
            openDisplayHelpBackdropEl.remove();
            openDisplayHelpBackdropEl = null;
        }
        if (openDisplayHelpPanelEl) {
            openDisplayHelpPanelEl.remove();
            openDisplayHelpPanelEl = null;
        }
    }

    function positionOpenDisplayHelpPanel() {
        const anchor = document.querySelector("#open-display-btn .open-display-help-icon");
        const panel = openDisplayHelpPanelEl;
        if (!anchor || !panel) return;
        const pad = 10;
        const rect = anchor.getBoundingClientRect();
        const pw = clamp(window.innerWidth - 24, 260, 420);
        panel.style.width = `${pw}px`;
        panel.style.visibility = "hidden";
        panel.style.display = "block";
        const ph = panel.offsetHeight || 1;
        panel.style.visibility = "visible";
        let left = rect.right + pad;
        if (left + pw > window.innerWidth - 8) {
            left = rect.left - pw - pad;
        }
        left = clamp(left, 8, Math.max(8, window.innerWidth - pw - 8));
        let top = rect.bottom + pad;
        if (top + ph > window.innerHeight - 8) {
            top = Math.max(8, rect.top - ph - pad);
        }
        top = clamp(top, 8, Math.max(8, window.innerHeight - ph - 8));
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
    }

    function openOpenDisplayHelpPanel(ev) {
        if (isDisplay || isLeader) return;
        if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
        }
        if (openDisplayHelpPanelEl) {
            closeOpenDisplayHelpPanel();
            return;
        }
        if (!document.querySelector("#open-display-btn .open-display-help-icon")) return;

        const backdrop = document.createElement("div");
        backdrop.id = "open-display-help-backdrop";
        backdrop.style.cssText =
            "position:fixed;inset:0;z-index:2600;background:rgba(0,0,0,0.15);cursor:default;";
        backdrop.addEventListener("click", () => closeOpenDisplayHelpPanel());

        const panel = document.createElement("div");
        panel.id = "open-display-help-panel";
        panel.style.cssText =
            "position:fixed;z-index:2601;max-width:min(420px,calc(100vw - 20px));padding:16px 18px 14px;" +
            "border-radius:14px;background:rgba(28,32,48,0.93);color:#fff;" +
            "box-shadow:0 12px 40px rgba(0,0,0,0.48);border:1px solid rgba(255,255,255,0.12);" +
            "font-size:0.88rem;line-height:1.55;backdrop-filter:blur(10px);";
        panel.innerHTML =
            '<button type="button" data-open-display-help-x aria-label="关闭" ' +
            'style="position:absolute;top:8px;right:8px;width:28px;height:28px;border:none;border-radius:50%;' +
            "cursor:pointer;display:flex;align-items:center;justify-content:center;" +
            'font-size:15px;line-height:1;color:rgba(255,255,255,0.92);background:rgba(255,255,255,0.18);">✕</button>' +
            '<div style="margin:0 32px 12px 0;font-size:1.08rem;font-weight:700;">📺 投屏操作提示</div>' +
            '<div style="color:rgba(255,255,255,0.92);">' +
            '<p style="margin:0 0 10px;font-weight:600;">第一步：移动窗口到投影仪屏幕</p>' +
            "<p style=\"margin:0 0 6px;\">Windows：按 Win + Shift + → 将窗口移动到投影仪，或直接用鼠标拖拽。</p>" +
            "<p style=\"margin:0 0 6px;\">macOS：投屏页会在当前屏幕居中打开，请拖到投影仪或副屏；若未弹出，请在 Safari「设置 → 网站 → 弹出式窗口」中将本站设为「允许」，再点一次「开启投屏」。</p>" +
            "<p style=\"margin:0 0 14px;\">Linux：请使用桌面环境的窗口管理快捷键，或将窗口拖拽到副屏（各发行版可能不同）。</p>" +
            '<p style="margin:0 0 10px;font-weight:600;">第二步：在投影仪上全屏</p>' +
            "<p style=\"margin:0 0 14px;\">按键盘的 F 键（macOS 亦可 Control+Command+F），或点击画面中央的 □ 按钮。</p>" +
            '<p style="margin:0 0 10px;font-weight:600;">第三步：在控制台翻页</p>' +
            "<p style=\"margin:0 0 10px;\">在控制台页面，使用 ← → 方向键或空格 控制下一页/上一页。</p>" +
            "<p style=\"margin:0 0 6px;\">此窗口仅您可见，投屏画面保持干净。</p>" +
            '<p style="margin:0 0 10px;font-weight:600;">结束投屏</p>' +
            "<p style=\"margin:0 0 14px;\">在主控台投屏区点「结束投屏」，或按 <b>Ctrl+Shift+E</b>，无需切换到投影仪窗口。</p>" +
            "<p style=\"margin:0;color:rgba(255,255,255,0.72);font-size:0.82rem;\">因浏览器安全策略限制，暂不支持一键自动全屏。</p>" +
            "</div>";

        panel.addEventListener("click", (e) => e.stopPropagation());
        panel.querySelector("[data-open-display-help-x]")?.addEventListener("click", () => closeOpenDisplayHelpPanel());

        document.body.appendChild(backdrop);
        document.body.appendChild(panel);
        openDisplayHelpBackdropEl = backdrop;
        openDisplayHelpPanelEl = panel;

        openDisplayHelpRepositionHandler = () => positionOpenDisplayHelpPanel();
        window.addEventListener("resize", openDisplayHelpRepositionHandler);
        window.addEventListener("scroll", openDisplayHelpRepositionHandler, true);
        openDisplayHelpEscapeHandler = (e) => {
            if (e.key === "Escape") closeOpenDisplayHelpPanel();
        };
        document.addEventListener("keydown", openDisplayHelpEscapeHandler);

        positionOpenDisplayHelpPanel();
    }

    function installOpenDisplayProjectionHelp() {
        if (isDisplay || isLeader) return;
        const btn = $("open-display-btn");
        if (!btn) return;

        let addons = btn.querySelector(".projection-action-card__addons");
        if (!addons) {
            addons = document.createElement("span");
            addons.className = "projection-action-card__addons";
            btn.appendChild(addons);
        }

        const attachShortcutsIcon = () => {
            if (addons.querySelector(".open-display-shortcuts-icon")) return;
            const shortcuts = document.createElement("span");
            shortcuts.className = "open-display-shortcuts-icon";
            shortcuts.setAttribute("role", "button");
            shortcuts.setAttribute("tabindex", "0");
            shortcuts.setAttribute("aria-label", "快捷键");
            shortcuts.title = "快捷键";
            shortcuts.textContent = "⌨";
            const onShortcutsActivate = (e) => {
                e.preventDefault();
                e.stopPropagation();
                openShortcutsPanel();
            };
            shortcuts.addEventListener("click", onShortcutsActivate);
            shortcuts.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") onShortcutsActivate(e);
            });
            addons.appendChild(shortcuts);
        };

        if (addons.querySelector(".open-display-help-icon")) {
            attachShortcutsIcon();
            return;
        }

        const help = document.createElement("span");
        help.className = "open-display-help-icon";
        help.setAttribute("role", "button");
        help.setAttribute("tabindex", "0");
        help.setAttribute("aria-label", "投屏帮助");
        help.title = "投屏帮助";
        help.textContent = "?";

        const onHelpActivate = (e) => {
            e.preventDefault();
            e.stopPropagation();
            openOpenDisplayHelpPanel(e);
        };
        help.addEventListener("click", onHelpActivate);
        help.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") onHelpActivate(e);
        });

        addons.appendChild(help);
        attachShortcutsIcon();
    }

    function bindEvents() {
        const on = (id, event, fn) => {
            const el = $(id);
            if (el) el.addEventListener(event, fn);
        };

        on("first-visit-onboarding-dismiss", "click", dismissFirstVisitOnboarding);
        on("save-as-template-btn", "click", saveCurrentAsLyricTemplate);
        on("new-from-template-btn", "click", openLyricTemplatePickerModal);
        on("add-song-btn", "click", createNewSong);
        on("new-song-btn", "click", createNewSong);
        on("save-song-btn", "click", saveCurrentLyrics);
        if (!document.body.dataset.boundWorshipCtrlS) {
            document.body.dataset.boundWorshipCtrlS = "1";
            document.addEventListener(
                "keydown",
                (e) => {
                    if (isDisplay || isLeader) return;
                    if (e.isComposing) return;
                    if (e.key !== "s" && e.key !== "S") return;
                    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    saveCurrentLyrics();
                },
                true
            );
        }
        on("upload-cloud-btn", "click", () => {
            void uploadCurrentSongToCloud();
        });
        initUploadHistoryDropdownInteractions();
        on("upload-history-toggle-btn", "click", (e) => {
            e.stopPropagation();
            toggleUploadHistoryDropdown();
        });
        {
            const pageInd = $("page-indicator-input");
            if (pageInd && !pageInd.dataset.boundPageInd) {
                pageInd.dataset.boundPageInd = "1";
                pageInd.addEventListener("keydown", (e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    const pages = splitPages(getStablePagingLyricsForPageSplit(), state.ui.defaultLines);
                    const maxP = Math.max(1, pages.length);
                    const raw = String(pageInd.value || "").trim();
                    const n = parseInt(raw, 10);
                    const v = clamp(Number.isFinite(n) ? n : state.currentPage + 1, 1, maxP);
                    jumpToPage(v - 1);
                    pageInd.blur();
                });
            }
        }
        if (!document.body.dataset.boundGallerySectionPageInd) {
            document.body.dataset.boundGallerySectionPageInd = "1";
            document.body.addEventListener("keydown", (e) => {
                if (e.key !== "Enter") return;
                const t = e.target;
                if (!(t instanceof Element) || !t.classList.contains("gallery-section-page-input")) return;
                e.preventDefault();
                const pages = splitPages(getStablePagingLyricsForPageSplit(), state.ui.defaultLines);
                const maxP = Math.max(1, pages.length);
                const raw = String(t.value || "").trim();
                const n = parseInt(raw, 10);
                const v = clamp(Number.isFinite(n) ? n : state.currentPage + 1, 1, maxP);
                jumpToPage(v - 1);
                t.blur();
            });
        }
        on("gallery-zoom-out", "click", () => {
            galleryZoomLevel = clamp(Math.round((galleryZoomLevel - 0.1) * 10) / 10, 0.5, 2);
            persistGalleryZoomLevel();
            updateGalleryZoom();
        });
        on("gallery-zoom-in", "click", () => {
            galleryZoomLevel = clamp(Math.round((galleryZoomLevel + 0.1) * 10) / 10, 0.5, 2);
            persistGalleryZoomLevel();
            updateGalleryZoom();
        });
        on("gallery-zoom-reset", "click", () => {
            galleryZoomLevel = 1;
            persistGalleryZoomLevel();
            updateGalleryZoom();
        });
        on("publish-song-btn", "click", publishSong);
        on("apply-to-display", "click", (e) => {
            saveCurrentLyrics({ silent: true });
            broadcastState();
            showToast("✅ 已应用", e.currentTarget, { variant: "success" });
        });
        on("reset-current-song", "click", () => {
            setLyricEditorValueProgrammatically(DEFAULT_LYRICS);
            saveCurrentLyrics();
            updateCloudUploadBtnState();
        });
        on("ocr-btn", "click", () => $("ocr-file-input")?.click());
        on("help-btn", "click", openHelpModal);
        on("usage-guide-btn", "click", () => {
            const hm = $("help-modal");
            if (hm) hm.style.display = "none";
            replayNewUserArrowGuideFromToolbar();
        });
        on("ocr-file-input", "change", async (e) => {
            const input = e.target;
            const file = input?.files?.[0];
            if (!file) return;
            const waitTesseractReady = () =>
                new Promise((resolve) => {
                    if (typeof Tesseract !== "undefined") {
                        resolve(true);
                        return;
                    }
                    const t0 = Date.now();
                    const maxMs = 45000;
                    const step = () => {
                        if (typeof Tesseract !== "undefined") {
                            resolve(true);
                            return;
                        }
                        if (Date.now() - t0 >= maxMs) {
                            resolve(false);
                            return;
                        }
                        window.setTimeout(step, 150);
                    };
                    step();
                });
            if (typeof Tesseract === "undefined") {
                showToast("Tesseract.js 正在加载，请稍候…", $("ocr-btn"));
                const ok = await waitTesseractReady();
                if (!ok) {
                    showToast("OCR 尚未就绪，请刷新页面或稍后再试", $("ocr-btn"));
                    input.value = "";
                    return;
                }
            }
            showToast("OCR 识别中…", $("ocr-btn"));
            try {
                const res = await Tesseract.recognize(file, "chi_sim+eng", { logger: () => {} });
                const raw = String(res?.data?.text || "")
                    .replace(/\r\n/g, "\n")
                    .replace(/\r/g, "\n")
                    .trim();
                if (!raw) {
                    showToast("未识别到文字", $("ocr-btn"));
                    input.value = "";
                    return;
                }
                const cur = String($("lyric-editor-large")?.value || "").trim();
                setLyricEditorValueProgrammatically(cur ? `${cur}\n${raw}` : raw);
                saveCurrentLyrics();
                updateCloudUploadBtnState();
                showToast("已填入歌词编辑区", $("ocr-btn"));
            } catch (_e) {
                showToast("OCR 失败", $("ocr-btn"));
            } finally {
                input.value = "";
            }
        });

        on("export-data-btn", "click", exportData);
        on("import-data-btn", "click", () => $("import-file-input")?.click());
        on("import-file-input", "change", (e) => {
            const file = e.target.files?.[0];
            if (file) importData(file);
        });
        on("batch-import-btn", "click", () => {
            if ($("batch-import-modal")) $("batch-import-modal").style.display = "flex";
        });
        on("batch-import-cancel", "click", () => {
            if ($("batch-import-modal")) $("batch-import-modal").style.display = "none";
        });
        on("batch-import-modal", "click", (e) => {
            if (e.target && e.target.id === "batch-import-modal") e.target.style.display = "none";
        });
        on("batch-import-confirm", "click", () => {
            const raw = $("batch-import-textarea")?.value || "";
            const chunks = raw.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
            let count = 0;
            chunks.forEach((chunk) => {
                const lines = chunk.split("\n").map((x) => x.trim()).filter(Boolean);
                if (!lines.length) return;
                state.songs.push({
                    id: uid(),
                    title: lines[0] || `未命名 ${state.songs.length + 1}`,
                    lyrics: lines.slice(1).join("\n"),
                    key: "",
                    tempo: "",
                    notes: "",
                    tags: ""
                });
                count += 1;
            });
            if ($("batch-import-modal")) $("batch-import-modal").style.display = "none";
            if ($("batch-import-textarea")) $("batch-import-textarea").value = "";
            saveSongs();
            renderSongList();
            renderPlaylist();
            if (count > 0) showCornerSuccessToast("✅ 已导入", $("batch-import-confirm"));
        });
        on("playlist-start-btn", "click", startPlaylistPlayback);
        installSetlistModalHandlers();
        installSetlistNameModalHandlers();
        on("save-setlist-btn", "click", (e) => {
            const btn = e.currentTarget;
            const ids = Array.isArray(state.playlist.items) ? [...state.playlist.items] : [];
            if (!ids.length) {
                showToast("播放列表为空，请先添加诗歌", btn);
                return;
            }
            const defaultName = "敬拜歌单 " + new Date().toLocaleDateString();
            openSetlistNameModal(defaultName, ids, btn);
        });
        on("load-setlist-btn", "click", (e) => {
            const btn = e.currentTarget;
            if (!loadSavedSetlists().length) {
                showToast("暂无已保存的歌单，请先点「💾 保存歌单」命名保存", btn);
                return;
            }
            openSetlistModal();
        });

        on("search-input", "input", renderSongList);
        on("search-input", "focus", () => {
            if (librarySearchScopeHintShownForFocus) return;
            librarySearchScopeHintShownForFocus = true;
            showToast("仅搜索您已保存在本机的诗歌（标题与歌词），不会搜索网络。", $("search-input"));
        });
        on("search-input", "blur", () => {
            librarySearchScopeHintShownForFocus = false;
        });
        on("library-view-all", "click", () => {
            if (state.library.viewMode === "batch") libraryBatchSelected.clear();
            state.library.viewMode = "all";
            renderSongList();
        });
        on("library-view-category", "click", () => {
            if (state.library.viewMode === "batch") libraryBatchSelected.clear();
            state.library.viewMode = "category";
            renderSongList();
        });
        on("library-view-batch", "click", () => {
            state.library.viewMode = "batch";
            renderSongList();
        });
        on("batch-delete-btn", "click", batchDeleteSelectedSongs);
        on("batch-export-btn", "click", batchExportSelectedWorship);

        const songCtxMenu = $("song-context-menu");
        if (songCtxMenu) {
            songCtxMenu.addEventListener("click", (e) => {
                const btn = e.target.closest("[data-action]");
                if (!btn) return;
                e.stopPropagation();
                const action = btn.getAttribute("data-action");
                const sid = contextMenuSongId;
                hideSongContextMenu();
                if (!sid) return;
                if (action === "edit") switchSong(sid);
                else if (action === "copy") duplicateSong(sid);
                else if (action === "delete") {
                    libraryPendingDeleteId = sid;
                    renderSongList();
                }
            });
        }

        document.addEventListener(
            "mousedown",
            (e) => {
                if (e.button !== 0) return;
                const ctx = $("song-context-menu");
                if (ctx && !ctx.hidden && !e.target.closest("#song-context-menu")) {
                    hideSongContextMenu();
                }
                if (libraryPendingDeleteId) {
                    if (e.target.closest("#song-context-menu")) return;
                    const row = e.target.closest(".song-item");
                    if (row && row.dataset.songId === libraryPendingDeleteId) return;
                    libraryPendingDeleteId = "";
                    renderSongList();
                }
            },
            true
        );

        document.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            hideSongContextMenu();
            if (libraryPendingDeleteId) {
                libraryPendingDeleteId = "";
                renderSongList();
            }
        });

        $("song-list")?.addEventListener("change", (e) => {
            const t = e.target;
            if (!(t instanceof HTMLInputElement) || !t.classList.contains("song-batch-cb")) return;
            const id = t.dataset.songId;
            if (!id) return;
            if (t.checked) libraryBatchSelected.add(id);
            else libraryBatchSelected.delete(id);
        });

        on("online-search-input", "input", renderOnlineSearchResult);
        on("online-search-input", "focus", () => {
            if (onlineSearchNotReadyHintShownForFocus) return;
            onlineSearchNotReadyHintShownForFocus = true;
            showToast("输入关键词后将搜索在线诗歌库；需联网。结果可导入到本机诗歌库。", $("online-search-input"));
        });
        on("online-search-input", "blur", () => {
            onlineSearchNotReadyHintShownForFocus = false;
        });

        on("font-slider", "input", () => {
            const v = clampLyricFontSize($("font-slider").value || 60);
            state.ui.fontSize = v;
            if ($("font-val")) $("font-val").textContent = String(v);
            scheduleMiniSliderDomPreview(() => applyMiniPreviewFontSizePx(v));
            scheduleLiveStyleProjectionPush({ fontSize: v });
            scheduleGalleryLyricPadRelayout();
        });
        on("font-slider", "change", () => {
            state.ui.fontSize = clampLyricFontSize($("font-slider").value || 60);
            if ($("font-val")) $("font-val").textContent = String(state.ui.fontSize);
            saveSettings();
            updateAll();
        });
        on("font-mega-mode", "change", () => {
            state.ui.fontMegaMode = !!($("font-mega-mode") && $("font-mega-mode").checked);
            const mx = getLyricFontSliderMax();
            state.ui.fontSize = clamp(Number(state.ui.fontSize) || 60, 8, mx);
            if ($("font-slider")) {
                $("font-slider").max = String(mx);
                $("font-slider").value = String(state.ui.fontSize);
            }
            if ($("font-val")) $("font-val").textContent = String(state.ui.fontSize);
            saveSettings();
            updateAll();
            syncAdvSliderRecommendedTicks();
        });
        on("default-lines-input", "input", () => {
            state.ui.defaultLines = clamp(Number($("default-lines-input").value || 4), 1, 20);
            state.currentPage = 0;
            renderMiniPreview();
        });
        on("default-lines-input", "change", () => {
            state.ui.defaultLines = clamp(Number($("default-lines-input").value || 4), 1, 20);
            state.currentPage = 0;
            saveSettings();
            updateAll();
        });
        on("pos-slider", "input", () => {
            const v = clamp(Number($("pos-slider").value || 40), 20, 70);
            if ($("pos-val")) $("pos-val").textContent = String(v);
            state.ui.posY = v;
            scheduleMiniSliderDomPreview(() => applyMiniPreviewPosDragTransform(v));
            scheduleLiveStyleProjectionPush({ posY: v });
            scheduleGalleryLyricPadRelayout();
        });
        on("pos-slider", "change", () => {
            state.ui.posY = clamp(Number($("pos-slider").value || 40), 20, 70);
            if ($("pos-val")) $("pos-val").textContent = String(state.ui.posY);
            const song = currentSong();
            if (song) song.posY = state.ui.posY;
            clearMiniPreviewLyricStageDragTransform();
            saveSongs();
            saveSettings();
            updateAll();
        });
        on("font-family-selector", "change", () => {
            const val = $("font-family-selector").value;
            const WFD = globalThis.WorshipFontData;
            if (WFD && typeof WFD.isPresetSelectValue === "function" && WFD.isPresetSelectValue(val)) {
                const p = WFD.getPresetFromSelectValue(val);
                if (p) {
                    state.ui.fontFamily = p.fontFamily;
                    state.ui.fontColor = p.fontColor;
                    state.ui.fontWeight = p.fontWeight;
                }
            } else {
                state.ui.fontFamily = val;
            }
            updateUIFromState();
            saveSettings();
            updateAll();
        });
        on("theme-selector", "change", () => {
            state.ui.theme = $("theme-selector").value;
            document.body.setAttribute("data-theme", state.ui.theme);
            updateAll();
        });
        /* 仅「上传背景图片」按钮打开文件框；预设网格中的图片入口切换到「我的背景」并应用已有缩略图 */
        on("upload-bg-trigger", "click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            switchBgTabTo("mine");
            const items = getUploadedBackgrounds();
            if (!items.length) {
                showToast('请先点击下方「上传背景图片」添加图片', $("upload-bg-btn"));
                return;
            }
            const prefer = state.ui.bgImageId ? items.find((x) => x && x.id === state.ui.bgImageId) : null;
            const pick = prefer || items[0];
            if (!pick || !pick.imageData) return;
            state.ui.bgType = "image";
            state.ui.bgImageId = pick.id;
            state.ui.bgImage = pick.imageData;
            state.ui.bgMediaType =
                pick.mediaType === "video" || inferMediaTypeFromDataUrl(pick.imageData) === "video"
                    ? "video"
                    : "image";
            state.ui.lyricsBgShareToCloud = false;
            recordBgThumbUsage(pick.id);
            updateUIFromState();
            updateAll();
            saveSettings();
            persistCurrentSongBgAfterUiChange();
            renderUploadedBackgrounds();
            showToast("已应用歌词背景", $("upload-bg-trigger"));
        });
        on("upload-bg-btn", "click", (e) => {
            e.preventDefault();
            $("bg-image-input")?.click();
        });
        document.querySelectorAll(".bg-option").forEach((node) => {
            if (node.id === "upload-bg-trigger") return;
            node.addEventListener("click", () => setBackground(node.getAttribute("data-bg") || "solid-black"));
        });
        initBgTabs();
        on("bg-image-input", "change", (e) => {
            const input = e.target;
            const files = input.files;
            if (!files || !files.length) return;
            const toastAnchor = $("upload-bg-btn") || $("upload-bg-trigger");
            const list = Array.from(files);
            let ok = 0;
            let readFail = 0;
            let saveFail = 0;
            (async () => {
                for (const file of list) {
                    let dataUrl;
                    try {
                        dataUrl = await readLocalFileAsDataURL(file);
                    } catch {
                        readFail++;
                        continue;
                    }
                    try {
                        const name = String(file.name || "").toLowerCase();
                        const videoByExt = /\.(mp4|webm|mov|m4v|ogv|ogg|mkv|avi)$/i.test(name);
                        const videoByMime = String(file.type || "").startsWith("video/");
                        const videoByDataUrl = /^data:video\//i.test(dataUrl);
                        const mt = videoByMime || videoByExt || videoByDataUrl ? "video" : "image";
                        addUploadedBackgroundAndApply(dataUrl, mt);
                        ok++;
                    } catch (err) {
                        console.warn(err);
                        saveFail++;
                    }
                }
                if (ok) {
                    updateUIFromState();
                    updateAll();
                    saveSettings();
                    switchBgTabTo("mine");
                    if (list.length === 1 && !readFail && !saveFail) {
                        showToast("已应用背景并加入「我的背景」", toastAnchor);
                    } else {
                        const parts = [`成功添加 ${ok} 个`];
                        if (readFail) parts.push(`${readFail} 个读取失败`);
                        if (saveFail) parts.push(`${saveFail} 个保存失败`);
                        showToast(parts.join("，"), toastAnchor);
                    }
                } else if (readFail || saveFail) {
                    showToast("未能添加背景", toastAnchor);
                }
                input.value = "";
            })();
        });
        on("theme-bg-input", "change", handleThemeBgSlotFileInputChange);
        on("worship-console-wallpaper-input", "change", handleThemeBgSlotFileInputChange);
        on("worship-console-wallpaper-upload-btn", "click", () => {
            const inp = $("worship-console-wallpaper-input") || $("theme-bg-input");
            inp?.click();
        });
        on("worship-console-wallpaper-reset", "click", () => {
            resetWorshipConsoleThemeBackgrounds();
        });
        on("worship-console-theme-video-upload-btn", "click", () => {
            $("worship-console-theme-video-input")?.click();
        });
        on("worship-console-theme-video-input", "change", handleThemeConsoleVideoFileChange);
        on("theme-bg-opacity-slider", "input", () => {
            const v = clamp(parseFloat($("theme-bg-opacity-slider").value || "0.65"), 0.05, 1);
            document.documentElement.style.setProperty("--theme-bg-opacity", String(v));
            if ($("theme-bg-opacity-value")) $("theme-bg-opacity-value").textContent = `${Math.round(v * 100)}%`;
            syncThemeConsoleVideoElementOpacity();
            updateAdvSliderSwatches();
        });
        on("theme-bg-opacity-slider", "change", () => {
            const v = clamp(parseFloat($("theme-bg-opacity-slider").value || "0.65"), 0.05, 1);
            try {
                localStorage.setItem(THEME_BG_OPACITY_STORAGE, String(v));
            } catch (_e) {
                /* ignore */
            }
            document.documentElement.style.setProperty("--theme-bg-opacity", String(v));
            if ($("theme-bg-opacity-value")) $("theme-bg-opacity-value").textContent = `${Math.round(v * 100)}%`;
            syncThemeConsoleVideoElementOpacity();
            updateAdvSliderSwatches();
            updateAll();
        });
        on("free-bg-link", "click", () => openFreeBgMaterialsPanel());

        on("autoplay-toggle", "click", () => {
            if (state.autoplay.running) {
                stopAutoplay();
                showToast("自动播放已停止", $("autoplay-toggle"));
            } else {
                startAutoplay();
                showToast("自动播放已开始", $("autoplay-toggle"));
            }
        });
        on("autoplay-stop", "click", () => {
            stopAutoplay();
            showToast("自动播放已停止", $("autoplay-stop"));
        });

        on("open-display-btn", "click", handleOpenDisplayBtnClick);
        on("close-projection-display-btn", "click", () => closeProjectionDisplayWindow());
        on("close-projection-panel-btn", "click", () => closeProjectionDisplayWindow());
        if (!document.body.dataset.boundCloseProjectionHotkey) {
            document.body.dataset.boundCloseProjectionHotkey = "1";
            document.addEventListener("keydown", (e) => {
                if (isDisplay || isLeader) return;
                const endChord = e.ctrlKey && e.shiftKey && (e.key === "E" || e.key === "e");
                if (!endChord) return;
                if (!isProjectionDisplayWindowOpen()) return;
                const t = e.target;
                if (t && t instanceof Element) {
                    if (t.isContentEditable) return;
                    if (t.tagName === "TEXTAREA") return;
                    if (t.tagName === "SELECT") return;
                    if (t.tagName === "INPUT") {
                        const ty = (t.type || "text").toLowerCase();
                        if (ty !== "button" && ty !== "submit" && ty !== "reset") return;
                    }
                }
                e.preventDefault();
                closeProjectionDisplayWindow();
            });
        }
        on("restore-projection-btn", "click", openDisplayWindow);
        on("restore-projection-dismiss", "click", hideRestoreProjectionBanner);
        on("restore-projection-overlay", "click", (e) => {
            const el = $("restore-projection-overlay");
            if (el && e.target === el) hideRestoreProjectionBanner();
        });
        on("open-leader-btn", "click", openLeaderPanelModal);

        on("lyric-editor-large", "input", () => {
            if (_lyricEditorProgrammaticWrite) return;
            syncEditorToSong();
            const nPages = splitPages(getLyricsSourceStringForPaging(), state.ui.defaultLines).length;
            const maxIdx = Math.max(0, nPages - 1);
            if (state.currentPage > maxIdx) state.currentPage = maxIdx;
            updateSpeakerCards({ linesOnly: isMainVideoBackground() });
            renderMiniPreview({ linesOnly: isMainVideoBackground() });
            refreshMonitorContent();
            updateCloudUploadBtnState();
            scheduleLyricDraftSave();
            renderPageGallery();
            scheduleFitLyricEditorFont();
        });
        on("lyric-editor-large", "paste", (e) => {
            if (_lyricEditorProgrammaticWrite) return;
            const ta = $("lyric-editor-large");
            if (!ta || e.target !== ta) return;
            const clip = e.clipboardData?.getData("text/plain");
            if (clip == null) return;
            e.preventDefault();
            const normalized = normalizePastedLyricsText(clip);
            const start = typeof ta.selectionStart === "number" ? ta.selectionStart : 0;
            const end = typeof ta.selectionEnd === "number" ? ta.selectionEnd : start;
            const v = String(ta.value);
            ta.value = v.slice(0, start) + normalized + v.slice(end);
            const caret = start + normalized.length;
            requestAnimationFrame(() => {
                try {
                    ta.selectionStart = ta.selectionEnd = caret;
                } catch (_e) {
                    /* ignore */
                }
            });
            ta.dispatchEvent(new Event("input", { bubbles: true }));
            applyAutoLyricPresentationAfterPaste(ta.value);
        });
        on("editor-font-increase", "click", () => bumpLyricEditorUserFont(1));
        on("editor-font-decrease", "click", () => bumpLyricEditorUserFont(-1));
        on("song-title-input", "input", () => {
            syncEditorToSong();
            renderSongList();
            updateCloudUploadBtnState();
        });
        on("song-key", "input", syncEditorToSong);
        on("song-tempo", "input", syncEditorToSong);
        on("song-notes", "input", syncEditorToSong);
        on("song-tags", "input", () => {
            syncEditorToSong();
        });

        on("adv-lyric-overlay-opacity", "input", () => {
            const v = clamp(Number($("adv-lyric-overlay-opacity").value || 0), 0, 55);
            document.documentElement.style.setProperty("--adv-mini-readability", (v / 100).toFixed(3));
        });
        on("adv-lyric-overlay-opacity", "change", () => {
            persistAdvPreviewCssVars();
            updateAll();
        });
        on("adv-lyric-layer-blur", "input", () => {
            const v = clamp(Number($("adv-lyric-layer-blur").value || 0), 0, 20);
            document.documentElement.style.setProperty("--adv-mini-blur-px", String(v));
        });
        on("adv-lyric-layer-blur", "change", () => {
            persistAdvPreviewCssVars();
            updateAll();
        });
        on("adv-preview-line-height", "input", () => {
            document.documentElement.style.setProperty(
                "--adv-preview-line-height",
                String($("adv-preview-line-height").value || "1.65")
            );
            updateAll();
        });
        on("text-stroke-slider", "input", () => {
            const sp = clamp(Number($("text-stroke-slider").value || 0), 0, 6);
            if ($("text-stroke-val")) $("text-stroke-val").textContent = String(sp);
            const lightBg = state.ui.bgType === "solid-white";
            scheduleMiniSliderDomPreview(() => {
                $("mini-preview")?.querySelectorAll(".preview-line").forEach((row) => {
                    const applyStroke = (el) => {
                        if (sp > 0) {
                            const w = Math.min(sp, 2.5);
                            const tcol = lightBg ? "rgba(0,0,0,0.4)" : "rgba(0,0,0,0.62)";
                            el.style.webkitTextStroke = `${w}px ${tcol}`;
                            el.style.paintOrder = "stroke fill";
                        } else {
                            el.style.webkitTextStroke = "";
                            el.style.paintOrder = "";
                        }
                    };
                    applyStroke(row);
                    row.querySelectorAll(".lyric-seg").forEach(applyStroke);
                });
                scheduleLiveStyleProjectionPush({ textStrokePx: sp });
                scheduleGalleryLyricPadRelayout();
            });
        });
        on("text-stroke-slider", "change", () => {
            state.ui.textStrokePx = clamp(Number($("text-stroke-slider").value || 0), 0, 6);
            if ($("text-stroke-val")) $("text-stroke-val").textContent = String(state.ui.textStrokePx);
            saveSettings();
            updateAll();
        });
        on("vignette-shape-select", "change", () => {
            state.ui.vignetteShape = $("vignette-shape-select").value === "ellipse" ? "ellipse" : "circle";
            updateAll();
        });
        on("vignette-center-slider", "input", () => {
            state.ui.vignetteCenterBrightness = clamp(Number($("vignette-center-slider").value || 0), -50, 50);
            if ($("vignette-center-val")) {
                $("vignette-center-val").textContent = String(state.ui.vignetteCenterBrightness);
            }
            updateAll();
        });
        on("vignette-edge-slider", "input", () => {
            state.ui.vignetteEdgeDarkness = clamp(Number($("vignette-edge-slider").value || 0), 0, 90);
            if ($("vignette-edge-val")) $("vignette-edge-val").textContent = String(state.ui.vignetteEdgeDarkness);
            updateAll();
        });
        on("page-transition-select", "change", () => {
            state.ui.pageTransition = canonicalPageTransition($("page-transition-select").value);
            updateAll();
            scheduleMiniPreviewTransitionDemo();
        });
        on("page-transition-speed-slider", "input", () => {
            const raw = parseFloat($("page-transition-speed-slider").value || "0.6");
            const sp = clamp(Math.round(raw * 10) / 10, 0.3, 1.5);
            if ($("page-transition-speed-val")) $("page-transition-speed-val").textContent = String(sp.toFixed(1));
            scheduleMiniPreviewTransitionDemo(sp);
        });
        on("page-transition-speed-slider", "change", () => {
            const raw = parseFloat($("page-transition-speed-slider").value || "0.6");
            state.ui.pageTransitionSpeed = clamp(Math.round(raw * 10) / 10, 0.3, 1.5);
            if ($("page-transition-speed-slider")) {
                $("page-transition-speed-slider").value = String(state.ui.pageTransitionSpeed);
            }
            if ($("page-transition-speed-val")) {
                $("page-transition-speed-val").textContent = state.ui.pageTransitionSpeed.toFixed(1);
            }
            saveSettings();
            updateAll();
            scheduleMiniPreviewTransitionDemo();
        });

        const popupBlockedBanner = $("popup-blocked-banner");
        const popupBlockedClose = popupBlockedBanner?.querySelector(".popup-blocked-banner__close");
        if (popupBlockedClose && !popupBlockedClose.dataset.boundPopup) {
            popupBlockedClose.dataset.boundPopup = "1";
            popupBlockedClose.addEventListener("click", () => {
                if (popupBlockedBanner) popupBlockedBanner.hidden = true;
            });
        }

        document.addEventListener("keydown", (e) => {
            const t = e.target;
            const isSpace = e.code === "Space" || e.key === " ";
            const isRight = e.code === "ArrowRight" || e.key === "ArrowRight";
            const isLeft = e.code === "ArrowLeft" || e.key === "ArrowLeft";
            const isUp = e.code === "ArrowUp" || e.key === "ArrowUp";
            const isDown = e.code === "ArrowDown" || e.key === "ArrowDown";

            const chordAlt = e.altKey && (isSpace || isRight || isLeft || isUp || isDown);
            const chordCtrlShift = e.ctrlKey && e.shiftKey && (isRight || isLeft || isUp || isDown);
            if (chordAlt || chordCtrlShift) {
                e.preventDefault();
                if (isSpace) changePage(1);
                else if (isRight) changePage(1);
                else if (isLeft) changePage(-1);
                else if (isUp) prevPage();
                else if (isDown) nextPage();
                return;
            }

            function mainPagingKeysBlocked() {
                if (!t || !(t instanceof Element)) return false;
                if (t.isContentEditable) return true;
                if (t.closest?.("#lyric-editor-large")) return true;
                if (t.tagName === "TEXTAREA") return true;
                if (t.tagName === "SELECT") return true;
                if (t.tagName === "INPUT") {
                    if (t.id === "page-indicator-input") return false;
                    if (t.classList.contains("gallery-section-page-input")) return false;
                    if (
                        (t.id === "song-title-input" ||
                            t.id === "search-input" ||
                            t.id === "online-search-input") &&
                        (isSpace || isRight || isLeft || isUp || isDown)
                    )
                        return false;
                    const ty = (t.type || "text").toLowerCase();
                    if (ty === "button" || ty === "submit" || ty === "reset" || ty === "image") return isSpace;
                    if (ty === "checkbox" || ty === "radio" || ty === "range" || ty === "file" || ty === "color")
                        return true;
                    return true;
                }
                if (isSpace && (t.tagName === "BUTTON" || (t.tagName === "A" && t.getAttribute("href"))))
                    return true;
                return false;
            }
            if (mainPagingKeysBlocked()) return;

            if (isSpace) {
                e.preventDefault();
                changePage(1);
            } else if (isRight) {
                e.preventDefault();
                changePage(1);
            } else if (isLeft) {
                e.preventDefault();
                changePage(-1);
            } else if (isUp) {
                e.preventDefault();
                prevPage();
            } else if (isDown) {
                e.preventDefault();
                nextPage();
            }
        });
    }

    function installProjectionUI(mode) {
        const app = $("app");
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
            displayVid.setAttribute("preload", "auto");
            /** 始终占位，用 opacity 切换；GPU 合成层减轻与歌词更新抢资源时的卡顿 */
            displayVid.style.cssText =
                "position:fixed;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:0;" +
                "pointer-events:none;opacity:0;display:block;" +
                "transform:translateZ(0);backface-visibility:hidden;-webkit-backface-visibility:hidden;will-change:opacity;";
            host.appendChild(displayVid);
        }

        const canvas = document.createElement("canvas");
        canvas.id = "projection-bg";
        canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;z-index:0;";
        host.appendChild(canvas);
        projectionCanvas = canvas;
        projectionCtx = canvas.getContext("2d");
        globalThis.projectionCanvas = projectionCanvas;
        globalThis.projectionCtx = projectionCtx;

        const gifImg = document.createElement("img");
        gifImg.id = "projection-bg-image";
        gifImg.alt = "";
        gifImg.style.cssText =
            "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center;display:none;" +
            "pointer-events:none;z-index:0;transform:translateZ(0);backface-visibility:hidden;-webkit-backface-visibility:hidden;";
        host.appendChild(gifImg);

        const mask = document.createElement("div");
        mask.id = "projection-bg-mask";
        mask.setAttribute("aria-hidden", "true");
        mask.style.cssText =
            "position:absolute;inset:0;z-index:5;pointer-events:none;background:rgba(0,0,0,0.3);transition:background 0.12s ease;";
        host.appendChild(mask);

        const vig = document.createElement("div");
        vig.id = "projection-vignette-radial";
        vig.setAttribute("aria-hidden", "true");
        vig.style.cssText =
            "position:absolute;inset:0;z-index:6;pointer-events:none;transition:opacity 0.15s ease,background 0.15s ease;";
        host.appendChild(vig);

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
            "font-weight:" + String(state.ui.fontWeight == null || state.ui.fontWeight === "" ? "700" : state.ui.fontWeight),
            "text-shadow:0 2px 10px rgba(0,0,0,.85)",
            "z-index:10"
        ].join(";");
        if (mode === "leader") lyric.style.textAlign = "left";
        host.appendChild(lyric);

        if (mode === "leader") {
            const nav = document.createElement("div");
            nav.style.cssText =
                "position:absolute;left:0;right:0;bottom:24px;display:flex;justify-content:center;gap:12px;z-index:12;";
            nav.innerHTML =
                '<button id="projection-prev-btn" class="display-control-btn">上一页</button><button id="projection-next-btn" class="display-control-btn">下一页</button>';
            host.appendChild(nav);
        }
    }

    function ensureProjectionCanvas() {
        if (!projectionCanvas || !projectionCtx) return;
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const w = Math.max(1, window.innerWidth);
        const h = Math.max(1, window.innerHeight);
        if (projectionCanvas.width !== Math.floor(w * dpr) || projectionCanvas.height !== Math.floor(h * dpr)) {
            projectionCanvas.width = Math.floor(w * dpr);
            projectionCanvas.height = Math.floor(h * dpr);
            projectionCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            projectionParticles = [];
        }
    }

    /** 粒子动态背景：数量 / 尺寸 / 速度与配色（仅此处维护） */
    const PARTICLE_BG_COUNT = 135;

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
            const tint = rollParticleTint();
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
        const ctx = projectionCtx;
        if (!ctx) return;
        if (projectionParticles.length !== PARTICLE_BG_COUNT) {
            projectionParticles = createAmbientParticles(w, h, PARTICLE_BG_COUNT);
        }
        projectionParticles.forEach((p) => {
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            if (p.x < 0 || p.x > w) p.vx *= -1;
            if (p.y < 0 || p.y > h) p.vy *= -1;
            p.x = clamp(p.x, 0, w);
            p.y = clamp(p.y, 0, h);
            applyParticleShadow(ctx, p);
            applyParticleFill(ctx, p);
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.shadowBlur = 0;
    }

    function projectionDisplayIsVideoBackground(lsOverride) {
        const st = lsOverride && typeof lsOverride === "object" ? lsOverride : liveState;
        if (!st) return false;
        const bgState = st.background || {};
        const type = bgState.type || "solid-black";
        const mediaType =
            bgState.mediaType === "video" || inferMediaTypeFromDataUrl(bgState.imageData || "") === "video"
                ? "video"
                : "image";
        return type === "image" && mediaType === "video" && !!bgState.imageData;
    }

    function projectionLiveBackgroundSignature(bg) {
        if (!bg || typeof bg !== "object") return "";
        const type = String(bg.type || "");
        const mt = String(bg.mediaType || "");
        const s = String(bg.imageData || "").trim();
        if (!s) return [type, mt, "empty"].join("\x1e");
        const len = s.length;
        return [type, mt, "len" + len, s.slice(0, 96), s.slice(-96)].join("\x1e");
    }

    function drawBg(ts) {
        if (typeof globalThis !== "undefined" && typeof globalThis.drawBg === "function") {
            return globalThis.drawBg(ts);
        }
        /* ==========================================================
           以下为 drawBg 的旧实现，已被 js/ui.js 中的 globalThis.drawBg 接管。
           保留此代码作为安全网，当新模块不可用时自动回退。
           未来版本可考虑移除。
           ========================================================== */
        if (!projectionCtx || !liveState) return;
        const bgState = liveState.background || {};
        const type = bgState.type || "solid-black";
        const gifLayer = $("projection-bg-image");
        const mediaType =
            bgState.mediaType === "video" || inferMediaTypeFromDataUrl(bgState.imageData || "") === "video"
                ? "video"
                : "image";
        const isVideoBg = type === "image" && mediaType === "video" && bgState.imageData;
        const dispV = $("display-video-bg");

        if (CSS_DYNAMIC_BG_TYPES.has(type)) {
            if (dispV) {
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
            ensureProjectionCssBg(type);
            if (gifLayer) gifLayer.style.display = "none";
            if (projectionCanvas) projectionCanvas.style.display = "none";
            projectionLastTs = ts;
            projectionRaf = 0;
            return;
        }

        if (isVideoBg && dispV && bgState.imageData) {
            removeProjectionCssBg();
            if (gifLayer) gifLayer.style.display = "none";
            if (projectionCanvas) projectionCanvas.style.display = "none";
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
            projectionLastTs = ts;
            projectionRaf = 0;
            return;
        }

        if (dispV) {
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

        removeProjectionCssBg();
        if (projectionCanvas) projectionCanvas.style.display = "block";

        ensureProjectionCanvas();
        const ctx = projectionCtx;
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
            const isGif = mediaType !== "video" && /^data:image\/gif/i.test(bgState.imageData);
            if (isGif && gifLayer) {
                if (projectionBgImage) projectionBgImage = null;
                if (gifLayer.src !== bgState.imageData) gifLayer.src = bgState.imageData;
                gifLayer.style.display = "block";
                if (projectionCanvas) projectionCanvas.style.display = "none";
            } else {
                ctx.fillStyle = "#000";
                ctx.fillRect(0, 0, w, h);
                if (!projectionBgImage || projectionBgImage.src !== bgState.imageData) {
                    projectionBgImage = new Image();
                    projectionBgImage.src = bgState.imageData;
                }
                if (projectionBgImage.complete && projectionBgImage.naturalWidth > 0) {
                    const ratio = Math.max(w / projectionBgImage.naturalWidth, h / projectionBgImage.naturalHeight);
                    const dw = projectionBgImage.naturalWidth * ratio;
                    const dh = projectionBgImage.naturalHeight * ratio;
                    const dx = (w - dw) / 2;
                    const dy = (h - dh) / 2;
                    ctx.drawImage(projectionBgImage, dx, dy, dw, dh);
                }
            }
        } else if (type === "particles") {
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, w, h);
            const dt = clamp((ts - (projectionLastTs || ts)) / 16.67, 0.3, 2.5);
            drawParticles(w, h, dt);
        } else {
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, w, h);
        }
        projectionLastTs = ts;
        const imgRasterLoading =
            type === "image" &&
            !isVideoBg &&
            projectionBgImage &&
            !projectionBgImage.complete;
        let loop = type === "particles" || imgRasterLoading;
        if (loop) projectionRaf = requestAnimationFrame(drawBg);
        else projectionRaf = 0;
    }

    function restartBg() {
        if (typeof globalThis !== "undefined" && typeof globalThis.restartBg === "function") {
            return globalThis.restartBg();
        }
        /* ==========================================================
           以下为 restartBg 的旧实现，已被 js/ui.js 中的 globalThis.restartBg 接管。
           保留此代码作为安全网，当新模块不可用时自动回退。
           未来版本可考虑移除。
           ========================================================== */
        if (projectionRaf) cancelAnimationFrame(projectionRaf);
        projectionRaf = requestAnimationFrame(drawBg);
    }

    function applyProjectionMaskFromLiveState() {
        const el = $("projection-bg-mask");
        if (!el || !liveState) return;
        const p = clamp(Number(liveState.overlayOpacityPct ?? 30), 0, 80) / 100;
        el.style.background = `rgba(0,0,0,${p})`;
    }

    function applyProjectionVignetteFromLiveState() {
        applyRadialVignetteToLayer($("projection-vignette-radial"), liveState);
    }

    function renderDisplayLyric(opts) {
        const layer = $("projection-lyric");
        if (!layer || !liveState) return;
        const skipOT = !!(opts && opts.pageTransitionMidSwap);
        const pages = liveState.pages || [];
        const idx = clamp(liveState.pageIndex || 0, 0, Math.max(0, pages.length - 1));
        const lines = pages[idx] || [];
        const t = liveState.text || {};
        const fontColor = liveState.fontColor || t.color || "#ffffff";
        const fontOp = clamp(Number(liveState.fontOpacityPct ?? 100), 20, 100) / 100;
        const lightBg = fontColor === "#111" || (t.color || "") === "#111";
        const strokeAttr = lyricStrokeHtmlAttrFromContext({
            textStrokePx: t.strokePx,
            lightBg
        });
        layer.style.textAlign = "center";
        layer.style.top = `${projectionTextTopPctFromLive(t)}%`;
        layer.style.transform = LYRIC_CENTER_TRANSFORM;
        layer.style.fontFamily = t.fontFamily || state.ui.fontFamily;
        layer.style.fontSize = `${clampLyricFontSize(Number(t.fontSize) || 60)}px`;
        layer.style.lineHeight = String(getAdvPreviewLineHeightNumber());
        layer.style.fontWeight =
            t.fontWeight != null && t.fontWeight !== ""
                ? String(t.fontWeight)
                : String(state.ui.fontWeight || "700");
        layer.style.color = fontColor;
        const applyFade = !!liveState.playlistFade && !skipOT;
        if (applyFade) layer.style.transition = "opacity 300ms ease";
        else if (!skipOT) layer.style.transition = "";
        if (applyFade) layer.style.opacity = "0";
        const buildRow =
            typeof globalThis.buildLyricRowHtmlForProjectionLine === "function"
                ? globalThis.buildLyricRowHtmlForProjectionLine
                : (line, attr) => `<div${attr}>${escapeHtml(line)}</div>`;
        layer.innerHTML = lines.map((line) => buildRow(line, strokeAttr, undefined)).join("");
        if (!skipOT) {
            if (applyFade) {
                requestAnimationFrame(() => {
                    layer.style.opacity = String(fontOp);
                });
            } else {
                layer.style.opacity = String(fontOp);
            }
        }
        updateDisplayCardPreview();
        applyProjectionVignetteFromLiveState();
    }

    function renderLeaderLyric(opts) {
        const layer = $("projection-lyric");
        if (!layer || !liveState) return;
        const skipOT = !!(opts && opts.pageTransitionMidSwap);
        const pages = liveState.pages || [];
        const idx = clamp(liveState.pageIndex || 0, 0, Math.max(0, pages.length - 1));
        const current = pages[idx] || [];
        const next = pages[idx + 1] || [];
        const t = liveState.text || {};
        const fontColor = liveState.fontColor || t.color || "#ffffff";
        const fontOp = clamp(Number(liveState.fontOpacityPct ?? 100), 20, 100) / 100;
        layer.style.textAlign = "left";
        layer.style.fontFamily = t.fontFamily || state.ui.fontFamily;
        layer.style.fontWeight =
            t.fontWeight != null && t.fontWeight !== ""
                ? String(t.fontWeight)
                : String(state.ui.fontWeight || "700");
        layer.style.color = fontColor;
        layer.style.fontSize = "44px";
        const applyFade = !!liveState.playlistFade && !skipOT;
        if (applyFade) layer.style.transition = "opacity 300ms ease";
        else if (!skipOT) layer.style.transition = "";
        if (applyFade) layer.style.opacity = "0";
        const sp = clamp(Number(t.strokePx ?? liveState.textStrokePx ?? 0), 0, 6);
        layer.style.webkitTextStroke =
            sp > 0 ? `${String(Math.min(sp, 2.5))}px rgba(0,0,0,0.55)` : "";
        const fmtLine =
            typeof globalThis.formatLyricLineForCompactPreview === "function"
                ? globalThis.formatLyricLineForCompactPreview
                : (ln) => String(ln ?? "");
        layer.innerHTML = [
            `<div style="position:absolute;top:-90px;right:0;font-size:16px;opacity:.9;">第 ${idx + 1}/${Math.max(1, pages.length)} 页</div>`,
            `<div style="line-height:1.35;margin-bottom:20px;">${current.map((x) => escapeHtml(fmtLine(x))).join("<br>") || "..."}</div>`,
            `<div style="font-size:22px;opacity:.75;">下页：${next.length ? next.map((x) => escapeHtml(fmtLine(x))).join(" / ") : "（无）"}</div>`
        ].join("");
        if (!skipOT) {
            if (applyFade) {
                requestAnimationFrame(() => {
                    layer.style.opacity = String(fontOp);
                });
            } else {
                layer.style.opacity = String(fontOp);
            }
        }
        applyProjectionVignetteFromLiveState();
    }

    function updateDisplayCardPreview() {
        const holder = $("display-card-preview");
        if (!holder || !liveState || displayProjectionChromeHidden) return;
        holder.innerHTML = "";
        const pages = liveState.pages || [];
        if (!pages.length) return;
        const cardsPerRow = clamp(Math.floor((window.innerWidth - 120) / 120), 4, 10);
        pages.forEach((lines, i) => {
            const card = document.createElement("div");
            card.className = "display-mini-card" + (i === liveState.pageIndex ? " active" : "");
            card.style.setProperty("--cards-per-row", String(cardsPerRow));
            const fmt =
                typeof globalThis.formatLyricLineForCompactPreview === "function"
                    ? globalThis.formatLyricLineForCompactPreview
                    : (ln) => String(ln ?? "");
            const l1 = fmt(lines?.[0] || "");
            const l2 = fmt(lines?.[1] || "");
            card.innerHTML = `<div style="font-weight:700;white-space:normal;">${escapeHtml(l1)}</div><div style="opacity:.75;margin-top:4px;white-space:normal;">${escapeHtml(l2)}</div>`;
            card.addEventListener("click", () => {
                if (channel) channel.postMessage({ type: "goto", page: i });
            });
            holder.appendChild(card);
        });
    }

    function applyLive(mode, payload, opts) {
        if (typeof globalThis !== "undefined" && typeof globalThis.applyLive === "function") {
            return globalThis.applyLive(mode, payload, opts);
        }
        /* ==========================================================
           以下为 applyLive 的旧实现，已被 js/ui.js 中的 globalThis.applyLive 接管。
           保留此代码作为安全网，当新模块不可用时自动回退。
           未来版本可考虑移除。
           ========================================================== */
        if (payload === undefined && mode && typeof mode === "object") {
            payload = mode;
            mode = projectionMode || "display";
        }
        if (!payload || !payload.pages) return;
        const prev = liveState;
        const prevIdx = Number(prev?.pageIndex) || 0;
        liveState = payload;
        if (typeof globalThis !== "undefined") globalThis.worshipLiveState = liveState;
        globalThis.liveState = liveState;
        applyProjectionMaskFromLiveState();
        applyProjectionVignetteFromLiveState();
        const newIdx = Number(liveState.pageIndex) || 0;
        const isDisp = (mode || projectionMode) === "display";
        const pageChanged =
            !!prev &&
            String(prev.songId || "") === String(liveState.songId || "") &&
            prevIdx !== newIdx &&
            (prev.pages || []).length === (liveState.pages || []).length;
        const trans = canonicalPageTransition(liveState.pageTransition || "none");
        const dur = clamp(Number(liveState.pageTransitionSpeed ?? 0.6), 0.3, 1.5);
        const doAnim = isDisp && prev && pageChanged && !liveState.playlistFade && trans !== "none";
        const fontOpForAnim = clamp(Number(liveState.fontOpacityPct ?? 100), 20, 100);

        const rerenderLyrics = (animOpts) => {
            if (isDisp) renderDisplayLyric(animOpts);
            else renderLeaderLyric(animOpts);
            applyProjectionMaskFromLiveState();
            applyProjectionVignetteFromLiveState();
        };

        if (doAnim) {
            runDisplayPageTransitionThenRender(trans, dur, rerenderLyrics, fontOpForAnim);
        } else {
            rerenderLyrics();
        }
        const sigPrev = projectionLiveBackgroundSignature(prev?.background);
        const sigNew = projectionLiveBackgroundSignature(liveState.background);
        const skipRestart =
            (mode || projectionMode) === "display" && !!prev && sigPrev === sigNew;
        if (!skipRestart) restartBg();
    }

    function initDisplayMode() {
        /* ==========================================================
           initDisplayMode：投屏入口由 app.js 的 init() 在 isDisplay 时优先分流调用。
           以下为本函数体内的旧实现；与 js/ui.js 中 initDisplayMode 并存，新 UI 管线
           完整时可考虑委托。保留作为安全网。
           未来版本可考虑移除。
           ========================================================== */
        tryFreeLocalStorageForWorshipBoot();
        try {
            document.body.classList.add("worship-audience-projection");
        } catch (_e) {
            /* ignore */
        }
        const pmHost = $("projection-preview-monitor");
        if (pmHost) pmHost.style.display = "none";
        projectionMode = "display";
        installProjectionUI("display");
        displayProjectionChromeHidden = true;

        window.addEventListener("message", (ev) => {
            const d = ev && ev.data;
            if (!d || typeof d !== "object" || d.action !== "close_display") return;
            try {
                window.close();
            } catch (_e) {
                /* ignore */
            }
        });

        if (!document.getElementById("worship-display-pro-style")) {
            const st = document.createElement("style");
            st.id = "worship-display-pro-style";
            st.textContent =
                "html.projection-cursor-idle,html.projection-cursor-idle body,html.projection-cursor-idle #projection-host{cursor:none!important;}";
            document.head.appendChild(st);
        }

        let cursorIdleTimer = 0;
        let bwMaskEl = null;
        let bwMaskKind = null;

        let fullscreenGuideOverlay = null;
        let displayGuideIdleTimer = 0;
        let displayHadFullscreenSession = false;
        let guideMovePollTimer = 0;
        /** 显示主引导面板时用于检测「整窗移到另一块屏」的起点 */
        let guideWindowBaseline = null;

        function clearGuideIdleTimer() {
            if (displayGuideIdleTimer) {
                window.clearTimeout(displayGuideIdleTimer);
                displayGuideIdleTimer = 0;
            }
        }

        function resetGuideIdleTimer() {
            clearGuideIdleTimer();
            if (!fullscreenGuideOverlay) return;
            const mv = fullscreenGuideOverlay.querySelector("#display-fs-zone-move");
            const step2Visible = mv && getComputedStyle(mv).display !== "none";
            /** 第 1 步仅全屏说明时：已进入全屏则暂不自动关（等待第 2 步）；窗口模式照常计时 */
            if (document.fullscreenElement && !step2Visible) return;
            const ms = step2Visible ? 12000 : 10000;
            displayGuideIdleTimer = window.setTimeout(() => removeFullscreenGuide(false), ms);
        }

        function captureGuideWindowBaseline() {
            return {
                left: window.screenLeft ?? window.screenX ?? 0,
                top: window.screenTop ?? window.screenY ?? 0
            };
        }

        function stopGuideMovePoll() {
            if (guideMovePollTimer) {
                window.clearInterval(guideMovePollTimer);
                guideMovePollTimer = 0;
            }
            guideWindowBaseline = null;
        }

        function maybeDismissGuideForWindowMove() {
            if (!fullscreenGuideOverlay || document.fullscreenElement || !guideWindowBaseline) return;
            const mv = fullscreenGuideOverlay.querySelector("#display-fs-zone-move");
            if (!mv || getComputedStyle(mv).display === "none") return;
            const cur = captureGuideWindowBaseline();
            const dl = Math.abs(cur.left - guideWindowBaseline.left);
            const dt = Math.abs(cur.top - guideWindowBaseline.top);
            if (dl > 72 || dt > 72) {
                removeFullscreenGuide(true);
            }
        }

        /** 第 2 步：在已阅读全屏说明后，再展示「将窗口移到投影仪」快捷键（与专业投屏软件分步引导一致） */
        function advanceProjectionGuideToStep2() {
            if (!fullscreenGuideOverlay) return;
            const mv = fullscreenGuideOverlay.querySelector("#display-fs-zone-move");
            if (mv && getComputedStyle(mv).display !== "none") return;
            const fs = fullscreenGuideOverlay.querySelector("#display-fs-zone-fs");
            const step = fullscreenGuideOverlay.querySelector("#display-fs-guide-step-label");
            const nextBtn = fullscreenGuideOverlay.querySelector("#display-fs-guide-next-btn");
            const hLine = fullscreenGuideOverlay.querySelector("#display-fs-guide-h-shortcut");
            const autoMsg = fullscreenGuideOverlay.querySelector("#display-fs-guide-auto-msg");
            const isMac = isMacLikePlatform();
            if (fs) fs.style.display = "none";
            if (nextBtn) nextBtn.style.display = "none";
            if (mv) mv.style.display = "block";
            if (step) step.textContent = "第 2 / 2 步 · 将窗口移到投影仪屏幕";
            if (hLine) hLine.style.display = "block";
            if (autoMsg) {
                autoMsg.textContent = isMac
                    ? "（可用 Shift+Option+Command+方向键 移动窗口；12 秒内无操作将关闭本提示）"
                    : "（可用 Win+Shift+方向键 将窗口移到另一块屏幕；12 秒内无操作将关闭本提示）";
            }
            if (!document.fullscreenElement) startGuideMovePoll();
            resetGuideIdleTimer();
        }

        function startGuideMovePoll() {
            stopGuideMovePoll();
            guideWindowBaseline = captureGuideWindowBaseline();
            guideMovePollTimer = window.setInterval(maybeDismissGuideForWindowMove, 400);
        }

        function removeFullscreenGuide(immediate) {
            if (typeof UI !== "undefined" && typeof UI.removeFullscreenGuide === "function") {
                return UI.removeFullscreenGuide(immediate);
            }
            /* ==========================================================
               以下为 removeFullscreenGuide 的旧实现，已被 UI.removeFullscreenGuide 接管。
               保留此代码作为安全网，当新模块不可用时自动回退。
               未来版本可考虑移除。
               ========================================================== */
            stopGuideMovePoll();
            clearGuideIdleTimer();
            if (!fullscreenGuideOverlay) return;
            const el = fullscreenGuideOverlay;
            if (immediate) {
                el.remove();
                fullscreenGuideOverlay = null;
                return;
            }
            el.style.opacity = "0";
            window.setTimeout(() => {
                el.remove();
                if (fullscreenGuideOverlay === el) fullscreenGuideOverlay = null;
            }, 380);
        }

        function hideFullscreenGuideFsZone() {
            if (!fullscreenGuideOverlay) return;
            const fs = fullscreenGuideOverlay.querySelector("#display-fs-zone-fs");
            if (fs) fs.style.display = "none";
        }

        /**
         * 投屏窗口：区分桌面平台用于单栏引导文案（非 Mac 按 Windows 文案处理，含 Linux）。
         */
        function isMacLikePlatform() {
            const p = navigator.platform || "";
            const ua = navigator.userAgent || "";
            if (/^Win/i.test(p)) return false;
            if (/^Mac/i.test(p)) return true;
            return /Mac OS X/i.test(ua);
        }

        /**
         * @param {{ helpMode?: boolean }} [opts] helpMode 为 true 时展示 Windows/macOS 双栏帮助；否则为「投屏中」单栏引导。
         */
        function showFullscreenGuidePanel(opts) {
            if (typeof UI !== "undefined" && typeof UI.showFullscreenGuidePanel === "function") {
                return UI.showFullscreenGuidePanel(opts);
            }
            /* ==========================================================
               以下为 showFullscreenGuidePanel 的旧实现，已被 UI.showFullscreenGuidePanel 接管。
               保留此代码作为安全网，当新模块不可用时自动回退。
               未来版本可考虑移除。
               ========================================================== */
            const helpMode = !!(opts && opts.helpMode);
            removeFullscreenGuide(true);
            if (document.fullscreenElement) return;

            const overlay = document.createElement("div");
            overlay.className = "display-fs-guide-overlay";
            overlay.style.opacity = "1";

            if (helpMode) {
                overlay.innerHTML = `
                <div class="display-fs-guide-panel display-fs-guide-panel--help">
                    <div class="display-fs-help-columns">
                        <div class="display-fs-help-col">
                            <div class="display-fs-help-col-title">Windows</div>
                            <ul>
                                <li><kbd>F</kbd> 全屏</li>
                                <li><kbd>Win</kbd>+<kbd>P</kbd> 切换屏幕</li>
                                <li><kbd>Win</kbd>+<kbd>Shift</kbd>+<kbd>→</kbd> 移动窗口</li>
                                <li><kbd>Esc</kbd> 退出全屏</li>
                                <li><kbd>B</kbd> 黑屏 · <kbd>W</kbd> 白屏</li>
                            </ul>
                        </div>
                        <div class="display-fs-help-col">
                            <div class="display-fs-help-col-title">macOS</div>
                            <ul>
                                <li><kbd>Control</kbd>+<kbd>Command</kbd>+<kbd>F</kbd> 全屏</li>
                                <li><kbd>Option</kbd>+<kbd>F1</kbd> 切换屏幕</li>
                                <li><kbd>Shift</kbd>+<kbd>Option</kbd>+<kbd>Command</kbd>+<kbd>→</kbd> 移动窗口</li>
                                <li><kbd>Esc</kbd> 退出全屏</li>
                                <li><kbd>B</kbd> 黑屏 · <kbd>W</kbd> 白屏</li>
                            </ul>
                        </div>
                    </div>
                    <p class="display-fs-guide-note">因浏览器安全策略限制，暂不支持一键自动投屏</p>
                    <p id="display-fs-guide-auto-msg" class="display-fs-guide-timer">（10 秒内无操作将自动关闭）</p>
                </div>`;
            } else {
                const isMac = isMacLikePlatform();
                const fsHint = isMac ? "或按 Control+Command+F 全屏" : "或按 F 键全屏";
                const moveHint = isMac
                    ? "或按 Shift+Option+Command+→ 移到投影仪"
                    : "或按 Win+Shift+→ 移到投影仪";
                overlay.innerHTML = `
                <div class="display-fs-guide-panel">
                    <p id="display-fs-guide-step-label" class="display-fs-guide-step">第 1 / 2 步 · 请先全屏放映</p>
                    <div id="display-fs-zone-fs" class="display-fs-zone-fs">
                        <button type="button" id="display-fs-guide-fs-btn" class="display-fs-guide-big-btn">📺 点击此处全屏</button>
                        <p class="display-fs-guide-sub">${escapeHtml(fsHint)}</p>
                        <p class="display-fs-guide-note">因浏览器安全策略暂不支持一键自动投屏，敬请谅解</p>
                    </div>
                    <button type="button" id="display-fs-guide-next-btn" class="display-fs-guide-next-btn">下一步：移到投影仪</button>
                    <div id="display-fs-zone-move" class="display-fs-zone-move" style="display:none;">
                        <p class="display-fs-guide-sub">${escapeHtml(moveHint)}</p>
                    </div>
                    <p id="display-fs-guide-auto-msg" class="display-fs-guide-timer">（第 1 步：请先全屏；10 秒内无操作将自动关闭）</p>
                    <p id="display-fs-guide-h-shortcut" class="display-fs-guide-timer" style="display:none;margin-top:10px;opacity:.88;">按 H 键打开 Windows / macOS 快捷键一览</p>
                </div>`;
            }

            document.body.appendChild(overlay);
            fullscreenGuideOverlay = overlay;

            const panel = overlay.querySelector(".display-fs-guide-panel");
            overlay.addEventListener("click", (e) => {
                if (e.target === overlay) removeFullscreenGuide(false);
            });
            panel?.addEventListener("click", (e) => {
                e.stopPropagation();
            });

            if (!helpMode) {
                overlay.querySelector("#display-fs-guide-fs-btn")?.addEventListener("click", async (e) => {
                    e.preventDefault();
                    try {
                        await document.documentElement.requestFullscreen({ navigationUI: "hide" });
                        hideFullscreenGuideFsZone();
                        resetGuideIdleTimer();
                    } catch (_) {
                        /* ignore */
                    }
                });
                overlay.querySelector("#display-fs-guide-next-btn")?.addEventListener("click", (e) => {
                    e.preventDefault();
                    advanceProjectionGuideToStep2();
                });
            } else {
                stopGuideMovePoll();
            }
            resetGuideIdleTimer();
        }

        document.addEventListener(
            "fullscreenchange",
            () => {
                if (document.fullscreenElement) {
                    displayHadFullscreenSession = true;
                    hideFullscreenGuideFsZone();
                    advanceProjectionGuideToStep2();
                    if (channel) channel.postMessage({ type: "projection_fs_active", source: "display" });
                } else if (displayHadFullscreenSession) {
                    if (channel) channel.postMessage({ type: "projection_attention", reason: "fs_exit", source: "display" });
                    window.requestAnimationFrame(() => {
                        if (!document.fullscreenElement) {
                            try {
                                showFullscreenGuidePanel({});
                            } catch (_e) {
                                /* ignore */
                            }
                        }
                    });
                }
            },
            false
        );

        window.addEventListener(
            "pagehide",
            () => {
                try {
                    if (channel) channel.postMessage({ type: "projection_attention", reason: "pagehide", source: "display" });
                } catch (_) {
                    /* ignore */
                }
            },
            false
        );

        window.addEventListener(
            "beforeunload",
            () => {
                try {
                    if (channel) channel.postMessage({ type: "projection_attention", reason: "beforeunload", source: "display" });
                } catch (_) {
                    /* ignore */
                }
            },
            false
        );

        function bumpCursorIdle() {
            if (!displayProjectionChromeHidden) return;
            document.documentElement.classList.remove("projection-cursor-idle");
            clearTimeout(cursorIdleTimer);
            cursorIdleTimer = window.setTimeout(() => {
                document.documentElement.classList.add("projection-cursor-idle");
            }, 2000);
        }

        function onProjectionPointerActivity() {
            bumpCursorIdle();
        }

        function tryProjectionFullscreenOnce() {
            const el = document.documentElement;
            if (!el.requestFullscreen) return;
            el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
        }

        /** 静默尝试一次自动全屏；若仍非全屏则在延迟后展示引导面板（多数浏览器会因用户手势策略拦截） */
        requestAnimationFrame(() => requestAnimationFrame(() => tryProjectionFullscreenOnce()));
        window.setTimeout(() => {
            if (document.fullscreenElement) return;
            showFullscreenGuidePanel({});
        }, 750);

        document.addEventListener("mousemove", onProjectionPointerActivity, { passive: true });
        document.addEventListener("mousedown", onProjectionPointerActivity, { passive: true });
        document.addEventListener("touchstart", onProjectionPointerActivity, { passive: true });
        document.addEventListener(
            "wheel",
            () => {
                bumpCursorIdle();
            },
            { passive: true }
        );

        function ensureBwMask() {
            if (bwMaskEl) return bwMaskEl;
            const host = $("projection-host");
            if (!host) return null;
            bwMaskEl = document.createElement("div");
            bwMaskEl.id = "projection-bw-mask";
            bwMaskEl.setAttribute("aria-hidden", "true");
            bwMaskEl.style.cssText = "display:none;position:absolute;inset:0;z-index:20;pointer-events:none;";
            host.appendChild(bwMaskEl);
            return bwMaskEl;
        }

        function toggleBwMask(kind) {
            const m = ensureBwMask();
            if (!m) return;
            if (bwMaskKind === kind) {
                m.style.display = "none";
                bwMaskKind = null;
                return;
            }
            bwMaskKind = kind;
            m.style.background = kind === "black" ? "#000" : "#fff";
            m.style.display = "block";
        }

        async function toggleProjectionFullscreen() {
            if (typeof UI !== "undefined" && typeof UI.toggleProjectionFullscreen === "function") {
                return UI.toggleProjectionFullscreen();
            }
            /* ==========================================================
               以下为 toggleProjectionFullscreen 的旧实现，已被 UI.toggleProjectionFullscreen 接管。
               保留此代码作为安全网，当新模块不可用时自动回退。
               未来版本可考虑移除。
               ========================================================== */
            try {
                if (document.fullscreenElement) await document.exitFullscreen();
                else {
                    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
                    hideFullscreenGuideFsZone();
                    resetGuideIdleTimer();
                }
            } catch (_) {
                /* ignore */
            }
        }

        function applyDisplayLiveFromPayload(payload) {
            if (!payload || !payload.pages) return;
            const prev = liveState;
            const prevIdx = prev ? (prev.pageIndex || 0) : -1;
            const newIdx = payload.pageIndex || 0;
            const pageChanged = prevIdx !== newIdx;
            const trans = canonicalPageTransition(payload.pageTransition || "none");
            const dur = clamp(Number(payload.pageTransitionSpeed || 0.6), 0.3, 1.5);
            const fontOpForAnim = clamp(Number(payload.fontOpacityPct || 100), 20, 100);

            const rerenderLyrics = (animOpts) => {
                renderDisplayLyric(animOpts);
                applyProjectionMaskFromLiveState();
                applyProjectionVignetteFromLiveState();
            };

            if (pageChanged && trans !== "none" && prev && !payload.playlistFade) {
                runDisplayPageTransitionThenRender(trans, dur, rerenderLyrics, fontOpForAnim);
            } else {
                rerenderLyrics();
            }
            applyLive("display", payload);
            const bg = payload.background || {};
            const mediaType =
                bg.mediaType === "video" || inferMediaTypeFromDataUrl(bg.imageData || "") === "video"
                    ? "video"
                    : "image";
            const isVideoBg = bg.type === "image" && mediaType === "video" && !!bg.imageData;
            requestAnimationFrame(() => {
                if (isVideoBg) {
                    const dispV = $("display-video-bg");
                    if (dispV && bg.imageData) {
                        const want = String(bg.imageData);
                        const srcChanged = dispV.dataset.worshipBgUrl !== want;
                        if (srcChanged) {
                            dispV.dataset.worshipBgUrl = want;
                            dispV.src = want;
                        }
                        dispV.style.opacity = "1";
                        if (srcChanged || dispV.paused || dispV.ended) {
                            void dispV.play().catch(() => {});
                        }
                    }
                } else {
                    requestAnimationFrame(() => {
                        restartBg();
                    });
                }
            });
        }

        const initState = getStore(STORAGE.LIVE, null);
        if (initState) applyDisplayLiveFromPayload(initState);
        const onPrev = () => channel && channel.postMessage({ type: "flip", delta: -1 });
        const onNext = () => channel && channel.postMessage({ type: "flip", delta: 1 });

        document.addEventListener("keydown", (e) => {
            if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
            const k = e.key;
            const isArrowLeft = k === "ArrowLeft" || e.code === "ArrowLeft";
            const isArrowRight = k === "ArrowRight" || e.code === "ArrowRight";
            if (k === "h" || k === "H") {
                e.preventDefault();
                showFullscreenGuidePanel({ helpMode: true });
                bumpCursorIdle();
                return;
            }
            if (isArrowLeft) {
                e.preventDefault();
                onPrev();
                resetGuideIdleTimer();
                bumpCursorIdle();
                return;
            }
            if (isArrowRight) {
                e.preventDefault();
                onNext();
                resetGuideIdleTimer();
                bumpCursorIdle();
                return;
            }
            if (k === "f" || k === "F") {
                e.preventDefault();
                void toggleProjectionFullscreen();
                resetGuideIdleTimer();
                bumpCursorIdle();
                return;
            }
            if (k === "b" || k === "B") {
                e.preventDefault();
                toggleBwMask("black");
                resetGuideIdleTimer();
                bumpCursorIdle();
                return;
            }
            if (k === "w" || k === "W") {
                e.preventDefault();
                toggleBwMask("white");
                resetGuideIdleTimer();
                bumpCursorIdle();
                return;
            }
        });

        if (channel) {
            channel.onmessage = (e) => {
                const d = e.data;
                if (d && d.type === "main_projection_end" && d.source === "main") {
                    if (!d.target || d.target === "display") {
                        try {
                            window.close();
                        } catch (_e) {
                            /* ignore */
                        }
                    }
                    return;
                }
                if (d && d.type === "projection_console_ready" && d.source === "main") {
                    removeFullscreenGuide(true);
                    return;
                }
                if (d && d.type === "update" && d.payload && d.payload.pages) {
                    applyDisplayLiveFromPayload(d.payload);
                }
            };
            channel.postMessage({ type: "projection_display_ready", source: "display" });
            channel.postMessage({ type: "request_state", source: "display" });
        }

        window.addEventListener("storage", (e) => {
            if (e.key === STORAGE.LIVE && e.newValue) {
                applyDisplayLiveFromPayload(parseJSON(e.newValue, null));
            }
        });
        window.addEventListener("resize", () => {
            if (projectionDisplayIsVideoBackground()) return;
            restartBg();
        });

        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) restartBg();
        });

        bumpCursorIdle();
    }

    function uidFlowCard() {
        return "fc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
    }

    function segmentLetterFromPageIndex(i) {
        return String.fromCharCode(65 + Math.min(Math.max(0, i | 0), 25));
    }

    function generateDefaultWorshipFlowFromPages(pageCount) {
        const n = Math.max(0, pageCount | 0);
        const cards = [];
        for (let pi = 0; pi < n; pi++) {
            if (pi > 0) {
                cards.push({ id: uidFlowCard(), type: "bridge", label: "【连接词】", body: "" });
            }
            const L = segmentLetterFromPageIndex(pi);
            cards.push({ id: uidFlowCard(), type: "lyrics", label: `【${L}段】`, pageIndex: pi });
        }
        return { version: 1, cards };
    }

    function worshipFlowFromPageSequence(seq, pageCount) {
        const max = Math.max(0, pageCount | 0);
        const seqC = (Array.isArray(seq) ? seq : []).map((x) => x | 0).filter((pi) => pi >= 0 && pi < max);
        const cards = [];
        seqC.forEach((pi, idx) => {
            if (idx > 0 && seqC[idx - 1] !== pi) {
                cards.push({ id: uidFlowCard(), type: "bridge", label: "【连接词】", body: "" });
            }
            const L = segmentLetterFromPageIndex(pi);
            cards.push({ id: uidFlowCard(), type: "lyrics", label: `【${L}段】`, pageIndex: pi });
        });
        return { version: 1, cards };
    }

    /** 快速模板：将 A/B/C 页序映射到当前诗歌实际页数内，避免页数不足时生成空流程 */
    function worshipFlowTemplateBuild(templateKey, pageCount) {
        const max = Math.max(1, pageCount | 0);
        const hi = Math.max(0, max - 1);
        let seq;
        if (templateKey === "standard") seq = [0, 1, 2, 1, 2];
        else if (templateKey === "repeat") seq = [0, 0, 1, 2, 1, 2, 1];
        else seq = [0, 1, 2];
        const mapped = seq.map((pi) => clamp(Number(pi) || 0, 0, hi));
        return worshipFlowFromPageSequence(mapped, max);
    }

    function initLeaderView() {
        tryFreeLocalStorageForWorshipBoot();
        try {
            loadState();
        } catch (_e) {
            /* ignore */
        }
        let leaderScanPageMeta = { page: 0, total: 0, show: false };
        const leaderUrlDataParam = new URLSearchParams(location.search).get("data");
        if (leaderUrlDataParam) {
            const expandedFromUrl = parseLeaderSharePayloadFromParam(leaderUrlDataParam);
            if (expandedFromUrl) {
                applyLeaderSharePayloadToState(expandedFromUrl);
                if ((expandedFromUrl.total || 1) > 1) {
                    leaderScanPageMeta = {
                        page: expandedFromUrl.page,
                        total: expandedFromUrl.total,
                        show: expandedFromUrl.page < expandedFromUrl.total
                    };
                }
                try {
                    history.replaceState(null, "", location.pathname + "?leader=1");
                } catch (_eUrl) {
                    /* ignore */
                }
            }
        }
        {
            const pmHostLeader = $("projection-preview-monitor");
            if (pmHostLeader) pmHostLeader.style.display = "none";
            projectionMode = "leader";
            document.title = "主领视角";
            installProjectionUI("leader");
            const NOTES_KEY = "leader_notes";
            const DISPLAY_MODE_KEY = "leader_display_mode";
            const BG_MODE_KEY = "leader_bg_mode";
            const TOOLBAR_COLLAPSED_KEY = "leader_toolbar_collapsed";
            const FONT_SIZE_KEY = "leader_font_size";
            const LEADER_LYRIC_COLOR_LS_KEY = "leader_lyric_color_v1";
            const LEADER_BRUSH_DRAWINGS_LS = "leader_brush_page_drawings_v1";
            const LEADER_BG_CUSTOM_IMAGE_LS = "leader_bg_custom_image_dataurl_v1";
            const host = $("projection-host");
            const lyricLayer = $("projection-lyric");
            const bgCanvas = $("projection-bg");
            const bgImg = $("projection-bg-image");
            const oldNav = $("projection-prev-btn")?.parentElement;
            if (!host || !lyricLayer || !bgCanvas) return;
            if (oldNav) oldNav.style.display = "none";
            if (projectionRaf) {
                cancelAnimationFrame(projectionRaf);
                projectionRaf = 0;
            }

            /** 主领窗不响应投屏关闭指令，避免与「结束投屏」共用逻辑时被误关 */
            window.addEventListener(
                "message",
                (ev) => {
                    const d = ev && ev.data;
                    if (d && typeof d === "object" && d.action === "close_display") {
                        ev.stopImmediatePropagation();
                    }
                },
                true
            );

            let displayMode = localStorage.getItem(DISPLAY_MODE_KEY) || "scroll";
            if (displayMode === "single") displayMode = "scroll";
            if (!["multi", "scroll", "flow"].includes(displayMode)) displayMode = "scroll";
            let bgMode = localStorage.getItem(BG_MODE_KEY) || "particles";
            if (!["black", "white", "gray", "navy", "particles", "custom"].includes(bgMode)) bgMode = "particles";
            let leaderBgCustomDataUrl = "";
            try {
                leaderBgCustomDataUrl = String(localStorage.getItem(LEADER_BG_CUSTOM_IMAGE_LS) || "");
            } catch (_e) {
                leaderBgCustomDataUrl = "";
            }
            if (bgMode === "custom" && !leaderBgCustomDataUrl) {
                bgMode = "particles";
                try {
                    localStorage.setItem(BG_MODE_KEY, bgMode);
                } catch (_e2) {
                    /* ignore */
                }
            }
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
            const notesMapRaw = getStore(NOTES_KEY, {});
            let notesMap = migrateLeaderNotes(notesMapRaw);
            if (JSON.stringify(notesMapRaw) !== JSON.stringify(notesMap)) setStore(NOTES_KEY, notesMap);
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
            let colorPanel = null;
            let colorHideTimer = 0;
            let currentPageKey = "";
            let pageDrawings = {};
            try {
                const raw = localStorage.getItem(LEADER_BRUSH_DRAWINGS_LS);
                const parsed = parseJSON(raw || "", null);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) pageDrawings = parsed;
            } catch (_e) {
                pageDrawings = {};
            }
            let leaderBrushPersistTimer = 0;
            /** 主领画笔：每页撤销栈（仅存内存，按笔画 mousedown 前快照） */
            const brushUndoStacks = Object.create(null);
            const BRUSH_UNDO_MAX = 24;
            const clearBrushUndoStackForKey = (key) => {
                if (key && brushUndoStacks[key]) delete brushUndoStacks[key];
            };
            /** 画笔 canvas 内部为 devicePixelRatio 倍分辨率，且 ctx 已 setTransform(dpr)，clear/drawImage 的目标尺寸须用 CSS 像素，否则会缩放错位（撤销后偏移） */
            const getLeaderBrushCssSize = () => {
                if (!brushCanvas) return { w: 1, h: 1 };
                const sw = parseFloat(brushCanvas.style.width);
                const sh = parseFloat(brushCanvas.style.height);
                const dpr = Math.max(1, window.devicePixelRatio || 1);
                const w = Number.isFinite(sw) && sw > 0 ? sw : brushCanvas.width / dpr;
                const h = Number.isFinite(sh) && sh > 0 ? sh : brushCanvas.height / dpr;
                return { w: Math.max(1, w), h: Math.max(1, h) };
            };
            const pushBrushUndoSnapshot = () => {
                if (!brushCanvas || !brushCtx || !currentPageKey) return;
                try {
                    const snap = brushCanvas.toDataURL("image/png");
                    let stack = brushUndoStacks[currentPageKey];
                    if (!stack) stack = brushUndoStacks[currentPageKey] = [];
                    stack.push(snap);
                    if (stack.length > BRUSH_UNDO_MAX) stack.shift();
                } catch (_e) {
                    /* ignore */
                }
            };
            const applyBrushSnapshotDataUrl = (dataUrl) => {
                if (!brushCanvas || !brushCtx) return;
                if (!dataUrl) {
                    const { w: cw, h: ch } = getLeaderBrushCssSize();
                    brushCtx.clearRect(0, 0, cw, ch);
                    delete pageDrawings[currentPageKey];
                    schedulePersistPageDrawings();
                    return;
                }
                const img = new Image();
                img.onload = () => {
                    const { w: cw, h: ch } = getLeaderBrushCssSize();
                    brushCtx.clearRect(0, 0, cw, ch);
                    brushCtx.drawImage(img, 0, 0, cw, ch);
                    saveCurrentDrawing();
                };
                img.onerror = () => {
                    /* ignore */
                };
                img.src = dataUrl;
            };
            const undoBrushStroke = (anchorEl) => {
                const key = currentPageKey;
                const stack = key ? brushUndoStacks[key] : null;
                if (!stack || !stack.length) {
                    showToast("没有可撤销的笔画", anchorEl || null);
                    return;
                }
                const prev = stack.pop();
                applyBrushSnapshotDataUrl(prev);
            };
            let brushHudEl = null;
            const FLOW_CACHE_PREFIX = "leader_worship_flow_v1::";
            let localWorshipFlow = null;
            let flowCursor = 0;
            let flowEditorWrap = null;
            let flowCtxMenuEl = null;
            let flowLongPressTimer = 0;
            let flowLongPressCardId = null;
            let flowDragId = null;
            let lastFlowWasVerseOverlay = false;
            let leaderFontSize = localStorage.getItem(FONT_SIZE_KEY) || "5vw";
            const parsedLeaderFont = parseFloat(leaderFontSize);
            if (!Number.isFinite(parsedLeaderFont) || parsedLeaderFont < 3 || parsedLeaderFont > 8) leaderFontSize = "5vw";
            function normalizeLeaderLyricHex(raw) {
                const s = String(raw || "").trim();
                if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
                if (/^#[0-9a-fA-F]{3}$/.test(s)) {
                    const a = s.slice(1);
                    return ("#" + a[0] + a[0] + a[1] + a[1] + a[2] + a[2]).toLowerCase();
                }
                return "";
            }
            let leaderLyricColorOverride = "";
            try {
                const cr = localStorage.getItem(LEADER_LYRIC_COLOR_LS_KEY);
                leaderLyricColorOverride = normalizeLeaderLyricHex(cr);
                if (cr && !leaderLyricColorOverride) localStorage.removeItem(LEADER_LYRIC_COLOR_LS_KEY);
            } catch (_e) {
                leaderLyricColorOverride = "";
            }
            const getLeaderLyricColorForRender = () => {
                if (leaderLyricColorOverride) return leaderLyricColorOverride;
                return liveState?.fontColor || liveState?.text?.color || "#ffffff";
            };
            const persistLeaderLyricColorOverride = (hex) => {
                leaderLyricColorOverride = normalizeLeaderLyricHex(hex);
                try {
                    if (leaderLyricColorOverride) localStorage.setItem(LEADER_LYRIC_COLOR_LS_KEY, leaderLyricColorOverride);
                    else localStorage.removeItem(LEADER_LYRIC_COLOR_LS_KEY);
                } catch (_e) {
                    /* ignore */
                }
            };
            const updateLeaderColorBtnSwatch = () => {
                const dot = toolbar.querySelector(".leader-color-dot");
                if (!dot) return;
                const c = getLeaderLyricColorForRender();
                dot.style.background = c;
                const low = c.toLowerCase();
                dot.style.boxShadow =
                    low === "#ffffff" || low === "#fff" ? "0 0 0 1px rgba(255,255,255,0.4) inset" : "none";
            };
            let touchStartY = 0;
            let swipeFromBottomY = null;
            let mouseBottomStartY = null;
            const leaderTabletRange = window.matchMedia("(min-width: 768px) and (max-width: 1024px)");
            const leaderBottomSwipeBand = () => (leaderTabletRange.matches ? 140 : 100);
            const leaderBottomSwipeMinDy = () => (leaderTabletRange.matches ? 36 : 20);

            host.classList.add("leader-host", "leader-minimal-chrome", "leader-has-bottom-rail", "leader-has-gear-dock");
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

            const syncLeaderSideNav = () => {
                const hideArrows = displayMode === "scroll";
                leftArrow.style.display = hideArrows ? "none" : "";
                rightArrow.style.display = hideArrows ? "none" : "";
                host.classList.toggle("leader-show-side-arrows", !hideArrows);
            };

            const toolbar = document.createElement("div");
            toolbar.className = "leader-toolbar leader-toolbar--sr-proxy";
            toolbar.innerHTML =
                '<div class="leader-toolbar-cluster leader-toolbar-cluster--aux">' +
                '<button class="leader-mini-btn leader-mini-btn--compact-icon" data-action="leader-help" title="主领视角使用说明（与控制台使用帮助类似）"><span class="leader-btn-icon">❓</span><span class="leader-btn-label">帮助</span></button>' +
                '<button class="leader-mini-btn leader-mini-btn--compact-icon" data-action="leader-guide" title="分步引导：同步、工具栏、翻页等"><span class="leader-btn-icon">🎯</span><span class="leader-btn-label">引导</span></button>' +
                '</div><div class="leader-toolbar-cluster leader-toolbar-cluster--main">' +
                '<button class="leader-mini-btn" data-mode="multi" title="分页翻页（当前页多行）"><span class="leader-btn-icon">📄</span><span class="leader-btn-label">翻页</span></button><button class="leader-mini-btn" data-mode="scroll" title="滚动"><span class="leader-btn-icon">📜</span><span class="leader-btn-label">滚动</span></button><button class="leader-mini-btn" data-mode="flow" title="流程视图"><span class="leader-btn-icon">🗂️</span><span class="leader-btn-label">流程</span></button><button class="leader-mini-btn" data-action="flow-arrange" title="编排 / 生成流程"><span class="leader-btn-icon">📐</span><span class="leader-btn-label">编排</span></button><button class="leader-mini-btn" data-action="import-pack" title="导入诗歌包（文本或完整链接）"><span class="leader-btn-icon">📥</span><span class="leader-btn-label">诗歌</span></button><button class="leader-mini-btn" data-action="leader-playlist" title="切换播放列表中的诗歌"><span class="leader-btn-icon">📋</span><span class="leader-btn-label">歌单</span></button><button class="leader-mini-btn" data-action="leader-edit-lyrics" title="编辑当前诗歌歌词（仅本机曲库与主领，不自动改投屏）"><span class="leader-btn-icon">✎</span><span class="leader-btn-label">改词</span></button><button class="leader-mini-btn" data-action="font-panel" title="字号"><span class="leader-btn-icon leader-font-aa">Aa</span><span class="leader-btn-label">字号</span></button><button class="leader-mini-btn" data-action="color-panel" title="歌词颜色（仅主领本机）"><span class="leader-btn-icon leader-color-icon" aria-hidden="true"><span class="leader-color-dot"></span></span><span class="leader-btn-label">字色</span></button><button class="leader-mini-btn" data-action="note" title="备注"><span class="leader-btn-icon">✏️</span><span class="leader-btn-label">备注</span></button><button class="leader-mini-btn leader-brush-btn" data-action="brush" title="标注"><span class="leader-btn-icon">✍️</span><span class="leader-btn-label">画笔</span><span class="leader-brush-indicator"></span></button><button class="leader-mini-btn" data-action="bg-panel" title="背景"><span class="leader-btn-icon">🎨</span><span class="leader-btn-label">背景</span></button><button type="button" class="leader-mini-btn" id="leader-save-qr-btn" data-action="leader-save-qr" title="生成备份二维码"><span class="leader-btn-icon">📸</span><span class="leader-btn-label">备份</span></button>' +
                "</div>";
            host.appendChild(toolbar);
            let leaderScanPageHintEl = null;
            const updateLeaderScanPageHint = (meta) => {
                if (!meta || !meta.total || meta.total <= 1) {
                    if (leaderScanPageHintEl) leaderScanPageHintEl.style.display = "none";
                    return;
                }
                if (!leaderScanPageHintEl) {
                    leaderScanPageHintEl = document.createElement("div");
                    leaderScanPageHintEl.id = "leader-scan-page-hint";
                    document.body.appendChild(leaderScanPageHintEl);
                }
                leaderScanPageHintEl.textContent = meta.show
                    ? `已扫第 ${meta.page}/${meta.total} 个码 · 请回电脑点 › 显示下一码并继续扫，扫齐 ${meta.total} 个后歌单才完整`
                    : `已扫齐 ${meta.total} 个码 · 歌单与编辑内容已完整载入`;
                leaderScanPageHintEl.style.display = "block";
            };
            if (leaderScanPageMeta.total > 1) updateLeaderScanPageHint(leaderScanPageMeta);
            const toolbarRail = document.createElement("div");
            toolbarRail.className = "leader-toolbar-rail";
            toolbarRail.innerHTML = '<button type="button" class="leader-expand-fab" aria-label="展开工具栏"><span class="leader-expand-fab-icon">∨</span></button>';
            host.appendChild(toolbarRail);
            toolbarRail.style.display = "none";

            const hideFontPanel = () => {
                if (fontHideTimer) {
                    clearTimeout(fontHideTimer);
                    fontHideTimer = 0;
                }
                if (fontPanel) fontPanel.style.display = "none";
            };
            const hideColorPanel = () => {
                if (colorHideTimer) {
                    clearTimeout(colorHideTimer);
                    colorHideTimer = 0;
                }
                if (colorPanel) colorPanel.style.display = "none";
            };
            const positionFontPanel = () => {
                if (!fontPanel || fontPanel.style.display === "none") return;
                const aaBtn = getLeaderUiAnchorEl();
                if (!aaBtn) return;
                const hostRect = host.getBoundingClientRect();
                const btnRect = aaBtn.getBoundingClientRect();
                const pw = fontPanel.offsetWidth || 160;
                const left = clamp(btnRect.left + btnRect.width / 2 - pw / 2 - hostRect.left, 8, hostRect.width - pw - 8);
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
                    const v = clamp(parseFloat(range.value) || 5, 3, 8);
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
                hideColorPanel();
                const range = fontPanel.querySelector(".leader-font-range");
                const parsed = parseFloat(leaderFontSize);
                range.value = String(Number.isFinite(parsed) ? clamp(parsed, 3, 8) : 5);
                fontPanel.style.display = "block";
                positionFontPanel();
                resetFontPanelHideTimer();
            };
            const positionColorPanel = () => {
                if (!colorPanel || colorPanel.style.display === "none") return;
                const cBtn = getLeaderUiAnchorEl();
                if (!cBtn) return;
                const hostRect = host.getBoundingClientRect();
                const btnRect = cBtn.getBoundingClientRect();
                const pw = colorPanel.offsetWidth || 200;
                const left = clamp(btnRect.left + btnRect.width / 2 - pw / 2 - hostRect.left, 8, hostRect.width - pw - 8);
                const top = btnRect.top - hostRect.top - colorPanel.offsetHeight - 8;
                colorPanel.style.left = `${left}px`;
                colorPanel.style.top = `${Math.max(8, top)}px`;
            };
            const resetColorPanelHideTimer = () => {
                if (colorHideTimer) clearTimeout(colorHideTimer);
                colorHideTimer = setTimeout(() => hideColorPanel(), 4000);
            };
            const syncLeaderColorPickerValue = () => {
                if (!colorPanel) return;
                const inp = colorPanel.querySelector(".leader-color-input");
                if (!inp) return;
                const v = normalizeLeaderLyricHex(inp.value) || getLeaderLyricColorForRender();
                inp.value = /^#[0-9a-fA-F]{6}$/.test(v) ? v : "#ffffff";
            };
            const ensureColorPanel = () => {
                if (colorPanel) return;
                colorPanel = document.createElement("div");
                colorPanel.className = "leader-color-pop";
                const presets = ["#ffffff", "#f5f0e6", "#ffd966", "#ff8a80", "#81c784", "#90caf9", "#212121"];
                colorPanel.innerHTML =
                    '<div class="leader-color-pop-title">歌词颜色</div>' +
                    '<div class="leader-color-swatches">' +
                    presets
                        .map(
                            (hex) =>
                                `<button type="button" class="leader-color-swatch" data-lyric-color="${hex}" title="${hex}" style="background:${hex};"></button>`
                        )
                        .join("") +
                    "</div>" +
                    '<label class="leader-color-custom"><span>自定义</span><input type="color" class="leader-color-input" aria-label="自定义歌词颜色"></label>' +
                    '<button type="button" class="leader-color-sync small-btn">与演示同步</button>';
                host.appendChild(colorPanel);
                colorPanel.querySelectorAll("[data-lyric-color]").forEach((b) => {
                    b.addEventListener("click", (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        const hex = normalizeLeaderLyricHex(b.getAttribute("data-lyric-color"));
                        if (!hex) return;
                        persistLeaderLyricColorOverride(hex);
                        syncLeaderColorPickerValue();
                        render();
                        updateLeaderColorBtnSwatch();
                        resetColorPanelHideTimer();
                        positionColorPanel();
                    });
                });
                const inp = colorPanel.querySelector(".leader-color-input");
                inp.addEventListener("input", () => {
                    const hex = normalizeLeaderLyricHex(inp.value);
                    if (!hex) return;
                    persistLeaderLyricColorOverride(hex);
                    render();
                    updateLeaderColorBtnSwatch();
                    resetColorPanelHideTimer();
                });
                colorPanel.querySelector(".leader-color-sync")?.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    persistLeaderLyricColorOverride("");
                    syncLeaderColorPickerValue();
                    render();
                    updateLeaderColorBtnSwatch();
                    resetColorPanelHideTimer();
                });
                colorPanel.addEventListener("mousedown", (e) => e.stopPropagation());
                colorPanel.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
            };
            const toggleColorPanel = () => {
                ensureColorPanel();
                if (colorPanel.style.display === "block") {
                    hideColorPanel();
                    return;
                }
                hideFontPanel();
                syncLeaderColorPickerValue();
                colorPanel.style.display = "block";
                positionColorPanel();
                resetColorPanelHideTimer();
            };
            const showToolbar = () => {
                if (host.classList.contains("leader-minimal-chrome")) {
                    if (hideTimer) clearTimeout(hideTimer);
                    hideTimer = setTimeout(() => setToolbarCollapsed(true), 3000);
                    return;
                }
                if (toolbarCollapsed) return;
                toolbar.classList.remove("hidden");
                if (hideTimer) clearTimeout(hideTimer);
                hideTimer = setTimeout(() => setToolbarCollapsed(true), 3000);
            };
            const setToolbarCollapsed = (collapsed) => {
                toolbarCollapsed = !!collapsed;
                localStorage.setItem(TOOLBAR_COLLAPSED_KEY, toolbarCollapsed ? "1" : "0");
                if (host.classList.contains("leader-minimal-chrome")) {
                    toolbar.classList.add("hidden", "collapsed");
                    toolbarRail.classList.remove("active");
                    if (toolbarCollapsed) {
                        hideFontPanel();
                        hideColorPanel();
                    }
                    return;
                }
                toolbar.classList.toggle("collapsed", toolbarCollapsed);
                toolbarRail.classList.toggle("active", toolbarCollapsed);
                if (toolbarCollapsed) {
                    hideFontPanel();
                    hideColorPanel();
                }
                if (!toolbarCollapsed) {
                    toolbar.classList.remove("hidden");
                    showToolbar();
                }
            };
            const leaderNoteStorageKey = (lineIndex, songId) => {
                if (displayMode === "scroll" && songId != null && String(songId) !== "") {
                    return `${String(songId)}::${lineIndex}`;
                }
                return String(lineIndex);
            };
            const saveNote = (lineIndex, note, songId) => {
                const key = leaderNoteStorageKey(lineIndex, songId);
                const text = String(note || "").trim();
                if (!text) delete notesMap[key];
                else notesMap[key] = { note: text, icon: "💬" };
                setStore(NOTES_KEY, notesMap);
            };
            const lookupLeaderNoteEntry = (lineIndex, songId) => {
                const primary = leaderNoteStorageKey(lineIndex, songId);
                if (notesMap[primary] != null) return notesMap[primary];
                if (displayMode === "scroll" && songId != null && String(songId) !== "") {
                    const legacy = notesMap[String(lineIndex)];
                    if (legacy != null) return legacy;
                }
                return null;
            };
            const loadNote = (lineIndex, songId) => {
                const v = lookupLeaderNoteEntry(lineIndex, songId);
                if (v == null) return "";
                if (typeof v === "string") return v;
                return String(v.note || "");
            };
            const loadNoteRecord = (lineIndex, songId) => {
                const v = lookupLeaderNoteEntry(lineIndex, songId);
                if (v == null) return null;
                if (typeof v === "string") {
                    const t = v.trim();
                    return t ? { note: t, icon: "💬" } : null;
                }
                const t = String(v.note || "").trim();
                return t ? { note: t, icon: String(v.icon || "💬") } : null;
            };
            const resolveLeaderNoteSongId = (el, attrSongId) => {
                const fromAttr = attrSongId != null ? String(attrSongId) : "";
                if (fromAttr) return fromAttr;
                const block = el && el.closest ? el.closest("[data-song-id]") : null;
                if (block) {
                    const sid = block.getAttribute("data-song-id");
                    if (sid) return String(sid);
                }
                return String(liveState?.songId || state.currentSongId || "");
            };
            const closeOverlay = () => {
                if (overlay?.parentNode) overlay.parentNode.removeChild(overlay);
                overlay = null;
                document.body.classList.remove("leader-note-modal-open");
                document.body.style.overflow = "";
            };
            let leaderNoteBannerEl = null;
            const exitNoteEditMode = () => {
                if (!noteEditMode) return;
                noteEditMode = false;
                closeOverlay();
                syncNoteEditBanner();
                syncLeaderSideRailUI();
                render();
            };
            const syncNoteEditBanner = () => {
                if (!leaderNoteBannerEl) {
                    leaderNoteBannerEl = document.createElement("div");
                    leaderNoteBannerEl.className = "leader-note-edit-banner";
                    leaderNoteBannerEl.setAttribute("role", "status");
                    leaderNoteBannerEl.innerHTML =
                        '<span class="leader-note-edit-banner-text">' +
                        (isLeaderHandheldViewport()
                            ? "备注模式：点歌词行或 ⊕ 添加备注（手机请直接点 ⊕）"
                            : "备注模式：点歌词行或右侧 ⊕ 添加备注") +
                        '</span><button type="button" class="leader-note-edit-banner-done">完成</button>';
                    leaderNoteBannerEl.querySelector(".leader-note-edit-banner-done")?.addEventListener("click", () => exitNoteEditMode());
                    host.appendChild(leaderNoteBannerEl);
                }
                leaderNoteBannerEl.style.display = noteEditMode ? "flex" : "none";
                host.classList.toggle("leader-note-edit-active", noteEditMode);
            };
            const getPages = () => {
                let pages = Array.isArray(liveState?.pages) ? liveState.pages : [];
                if (!pages.length) {
                    const sid = String(liveState?.songId || state.currentSongId || state.songs[0]?.id || "");
                    const song = sid ? state.songs.find((s) => s && String(s.id) === sid) : state.songs[0] || null;
                    if (song) {
                        const lyrics = String(song.lyrics ?? "").replace(/\r/g, "");
                        const defaultLines = clamp(Number(state.ui?.defaultLines) || 5, 1, 12);
                        pages = splitPages(lyrics, defaultLines);
                        if (!pages.length) pages = [[""]];
                        liveState = {
                            ...(liveState && typeof liveState === "object" ? liveState : {}),
                            version: 1,
                            updatedAt: Date.now(),
                            songId: String(song.id),
                            title: String(song.title || ""),
                            pages,
                            pageIndex: clamp(
                                Number(liveState?.pageIndex ?? state.currentPage ?? 0),
                                0,
                                Math.max(0, pages.length - 1)
                            )
                        };
                        if (typeof globalThis !== "undefined") globalThis.worshipLiveState = liveState;
                    }
                }
                const idx = clamp(liveState?.pageIndex || 0, 0, Math.max(0, (liveState?.pages || pages).length - 1));
                return { pages: liveState?.pages || pages, idx };
            };
            const globalIndex = (pages, pageIndex, lineIndex) => pages.slice(0, pageIndex).reduce((n, p) => n + (p || []).length, 0) + lineIndex;
            const getLeaderHeaderTitle = () => {
                const t = String(liveState?.title || "").trim();
                if (t) return t;
                const sid = String(liveState?.songId || state.currentSongId || "");
                const song = sid ? state.songs.find((s) => s && String(s.id) === sid) : null;
                return String(song?.title || "").trim() || "当前诗歌";
            };
            const buildPageKey = () => {
                if (displayMode === "scroll") {
                    const songs = getLeaderPlaylistOrderedSongs();
                    const ids = songs.map((s) => String(s?.id ?? "")).join("\u0001");
                    return `pl-scroll::${ids || "empty"}`;
                }
                if (displayMode === "flow") {
                    return `flow::${flowCursor}::${String(liveState?.title || "")}`;
                }
                const { idx } = getPages();
                const song = String(liveState?.title || "");
                return `${song}::${idx}`;
            };
            const updateBrushIndicator = () => {
                const indicator = toolbar.querySelector(".leader-brush-indicator");
                if (!indicator) return;
                indicator.style.display = brushMode ? "block" : "none";
                indicator.style.background = brushColor;
                const size = clamp(brushWidth + 2, 4, 8);
                indicator.style.width = `${size}px`;
                indicator.style.height = `${size}px`;
            };
            const schedulePersistPageDrawings = () => {
                if (leaderBrushPersistTimer) clearTimeout(leaderBrushPersistTimer);
                leaderBrushPersistTimer = setTimeout(() => {
                    leaderBrushPersistTimer = 0;
                    try {
                        localStorage.setItem(LEADER_BRUSH_DRAWINGS_LS, JSON.stringify(pageDrawings));
                    } catch (err) {
                        if (isStorageQuotaExceededError(err)) showToast("标注存储已满，可清除自定义背景图或浏览器数据后重试", null);
                    }
                }, 400);
            };
            const saveCurrentDrawing = () => {
                if (!brushCanvas || !currentPageKey) return;
                pageDrawings[currentPageKey] = brushCanvas.toDataURL("image/png");
                schedulePersistPageDrawings();
            };
            const restoreCurrentDrawing = () => {
                if (!brushCanvas || !brushCtx) return;
                const dataUrl = pageDrawings[currentPageKey];
                if (!dataUrl) return;
                const img = new Image();
                img.onload = () => {
                    const { w: cw, h: ch } = getLeaderBrushCssSize();
                    brushCtx.clearRect(0, 0, cw, ch);
                    brushCtx.drawImage(img, 0, 0, cw, ch);
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
                const panelHeight = brushPanel.offsetHeight || 120;
                const left = clamp(hostRect.width / 2 - panelWidth / 2, 8, hostRect.width - panelWidth - 8);
                let top;
                if (brushHudEl && brushMode && brushHudEl.style.display !== "none") {
                    const hudRect = brushHudEl.getBoundingClientRect();
                    const hudTopInHost = hudRect.top - hostRect.top;
                    const gap = 12;
                    top = hudTopInHost - panelHeight - gap;
                } else {
                    top = hostRect.height - panelHeight - 72;
                }
                brushPanel.style.left = `${left}px`;
                brushPanel.style.top = `${Math.max(8, Math.min(top, hostRect.height - panelHeight - 8))}px`;
            };
            const showBgPanel = () => {
                if (!bgPanel) return;
                hideFontPanel();
                hideColorPanel();
                const bgBtn = getLeaderUiAnchorEl();
                if (!bgBtn) return;
                bgPanel.style.display = "block";
                const hostRect = host.getBoundingClientRect();
                const btnRect = bgBtn.getBoundingClientRect();
                const panelWidth = bgPanel.offsetWidth || 170;
                const left = clamp(btnRect.left + btnRect.width / 2 - panelWidth / 2 - hostRect.left, 8, hostRect.width - panelWidth - 8);
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
                requestAnimationFrame(() => updateBrushPanelPosition());
            };
            const ensureBrushPanel = () => {
                if (brushPanel) return;
                brushPanel = document.createElement("div");
                brushPanel.className = "leader-brush-panel";
                brushPanel.innerHTML = '<div class="leader-brush-row"><button class="leader-brush-color" data-brush-color="#ffff00" style="background:#ffff00;" title="黄色"></button><button class="leader-brush-color" data-brush-color="#ff6666" style="background:#ff6666;" title="红色"></button><button class="leader-brush-color" data-brush-color="#66ccff" style="background:#66ccff;" title="蓝色"></button><button class="leader-brush-color" data-brush-color="#ffffff" style="background:#ffffff;" title="白色"></button><button class="leader-brush-color" data-brush-color="#66ff66" style="background:#66ff66;" title="绿色"></button><button class="leader-brush-color" data-brush-color="#cc66ff" style="background:#cc66ff;" title="紫色"></button></div><div class="leader-brush-row"><button class="leader-brush-width" data-brush-width="2" title="细">2px</button><button class="leader-brush-width" data-brush-width="4" title="中">4px</button><button class="leader-brush-width" data-brush-width="6" title="粗">6px</button><button class="leader-brush-clear" data-action="clear-brush" title="清除本页标注">🗑️</button><button class="leader-brush-done" data-action="done-brush" title="完成画笔">✅</button></div>';
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
                            const { w: cw, h: ch } = getLeaderBrushCssSize();
                            brushCtx.clearRect(0, 0, cw, ch);
                            delete pageDrawings[currentPageKey];
                            clearBrushUndoStackForKey(currentPageKey);
                            schedulePersistPageDrawings();
                        }
                        hideBrushPanel();
                    }
                });
            };
            const ensureBgPanel = () => {
                if (bgPanel) return;
                bgPanel = document.createElement("div");
                bgPanel.className = "leader-bg-panel";
                bgPanel.innerHTML =
                    '<button type="button" class="leader-bg-item" data-bg="black">纯黑</button>' +
                    '<button type="button" class="leader-bg-item" data-bg="white">纯白</button>' +
                    '<button type="button" class="leader-bg-item" data-bg="gray">深灰</button>' +
                    '<button type="button" class="leader-bg-item" data-bg="navy">藏青</button>' +
                    '<button type="button" class="leader-bg-item" data-bg="particles">粒子</button>' +
                    '<button type="button" class="leader-bg-item" data-bg="custom">我的图片</button>' +
                    '<label class="leader-bg-upload-btn">' +
                    '<input type="file" class="leader-bg-file-input" accept="image/*" />' +
                    "上传图片…" +
                    "</label>" +
                    '<button type="button" class="leader-bg-item leader-bg-item--ghost" data-action="leader-bg-clear-upload">清除上传图</button>';
                host.appendChild(bgPanel);
                bgPanel.addEventListener("click", (e) => {
                    if (e.target.closest(".leader-bg-file-input")) return;
                    const clr = e.target.closest("[data-action='leader-bg-clear-upload']");
                    if (clr) {
                        leaderBgCustomDataUrl = "";
                        try {
                            localStorage.removeItem(LEADER_BG_CUSTOM_IMAGE_LS);
                        } catch (_e) {
                            /* ignore */
                        }
                        if (bgMode === "custom") {
                            bgMode = "black";
                            try {
                                localStorage.setItem(BG_MODE_KEY, bgMode);
                            } catch (_e2) {
                                /* ignore */
                            }
                        }
                        applyBg();
                        if (bgPanel.style.display === "block") showBgPanel();
                        return;
                    }
                    const btn = e.target.closest("[data-bg]");
                    if (!btn) return;
                    bgMode = btn.getAttribute("data-bg") || "black";
                    if (bgMode === "custom" && !leaderBgCustomDataUrl) {
                        showToast("请先上传一张图片", btn);
                        return;
                    }
                    try {
                        localStorage.setItem(BG_MODE_KEY, bgMode);
                    } catch (_e3) {
                        /* ignore */
                    }
                    applyBg();
                    hideBgPanel();
                });
                const fi = bgPanel.querySelector(".leader-bg-file-input");
                fi?.addEventListener("change", () => {
                    const file = fi.files && fi.files[0];
                    fi.value = "";
                    if (!file || !file.type.startsWith("image/")) return;
                    if (file.size > 4 * 1024 * 1024) {
                        showToast("图片请小于 4MB", fi);
                        return;
                    }
                    const rd = new FileReader();
                    rd.onload = () => {
                        const url = String(rd.result || "");
                        if (!/^data:image\//.test(url)) {
                            showToast("无法读取该图片", fi);
                            return;
                        }
                        leaderBgCustomDataUrl = url;
                        try {
                            localStorage.setItem(LEADER_BG_CUSTOM_IMAGE_LS, url);
                        } catch (err) {
                            if (isStorageQuotaExceededError(err)) {
                                showToast("存储空间不足，无法保存背景图", fi);
                                return;
                            }
                        }
                        bgMode = "custom";
                        try {
                            localStorage.setItem(BG_MODE_KEY, bgMode);
                        } catch (_e4) {
                            /* ignore */
                        }
                        applyBg();
                        if (bgPanel.style.display === "block") showBgPanel();
                    };
                    rd.readAsDataURL(file);
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
                pushBrushUndoSnapshot();
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
                    brushCtx.clearRect(0, 0, cssW, cssH);
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
                leaderSideRailEl?.querySelector('[data-action="brush"]')?.classList.toggle("is-active", brushMode);
                ensureBrushHud();
                if (brushHudEl) brushHudEl.style.display = brushMode ? "flex" : "none";
                if (brushMode) {
                    if (hideTimer) {
                        clearTimeout(hideTimer);
                        hideTimer = 0;
                    }
                    hideFontPanel();
                    hideColorPanel();
                    setToolbarCollapsed(false);
                    ensureBrushPanel();
                    hideBgPanel();
                    showBrushPanel();
                } else {
                    saveCurrentDrawing();
                    hideBrushPanel();
                    showToolbar();
                }
                setupBrushCanvas();
                updateBrushIndicator();
            };
            function toggleDrawMode() {
                setBrushMode(!brushMode);
            }

            const ensureBrushHud = () => {
                if (brushHudEl) return;
                brushHudEl = document.createElement("div");
                brushHudEl.className = "leader-brush-hud";
                brushHudEl.setAttribute("role", "toolbar");
                brushHudEl.innerHTML =
                    '<button type="button" class="leader-brush-hud-btn" data-hud="brush-done">完成</button>' +
                    '<button type="button" class="leader-brush-hud-btn" data-hud="brush-clear">清除本页</button>' +
                    '<button type="button" class="leader-brush-hud-btn" data-hud="brush-undo">撤销上一步</button>' +
                    '<button type="button" class="leader-brush-hud-btn" data-hud="brush-style">颜色 / 粗细</button>';
                host.appendChild(brushHudEl);
                brushHudEl.addEventListener("click", (e) => {
                    const b = e.target.closest("[data-hud]");
                    if (!b) return;
                    e.stopPropagation();
                    const act = b.getAttribute("data-hud");
                    if (act === "brush-done") setBrushMode(false);
                    else if (act === "brush-clear") {
                        if (brushCtx && brushCanvas) {
                            const { w: cw, h: ch } = getLeaderBrushCssSize();
                            brushCtx.clearRect(0, 0, cw, ch);
                            delete pageDrawings[currentPageKey];
                            clearBrushUndoStackForKey(currentPageKey);
                            schedulePersistPageDrawings();
                        }
                    } else if (act === "brush-undo") {
                        undoBrushStroke(b);
                    } else if (act === "brush-style") {
                        ensureBrushPanel();
                        showBrushPanel();
                        requestAnimationFrame(() => updateBrushPanelPosition());
                    }
                });
                brushHudEl.addEventListener("mousedown", (e) => e.stopPropagation());
                brushHudEl.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
            };

            function openNote(lineIndex, readOnly, anchorEl, songId) {
                closeOverlay();
                hideFontPanel();
                hideColorPanel();
                const wrap = document.createElement("div");
                wrap.className = "leader-note-pop-wrap leader-note-pop-wrap--modal";
                wrap.dataset.noteReadonly = readOnly ? "1" : "0";
                const box = document.createElement("div");
                box.className = "leader-note-pop";
                const stopBoxBubble = (ev) => ev.stopPropagation();
                box.addEventListener("mousedown", stopBoxBubble);
                box.addEventListener("touchstart", stopBoxBubble, { passive: true });
                const rec = loadNoteRecord(lineIndex, songId);
                const noteVal = rec ? rec.note : "";
                const closeBtn = document.createElement("button");
                closeBtn.type = "button";
                closeBtn.className = "leader-note-close";
                closeBtn.setAttribute("aria-label", "关闭");
                closeBtn.textContent = "✕";
                closeBtn.addEventListener("click", closeOverlay);
                box.appendChild(closeBtn);
                if (readOnly) {
                    const view = document.createElement("div");
                    view.className = "leader-note-view";
                    view.textContent = rec ? `${rec.icon} ${rec.note}` : "（无备注）";
                    box.appendChild(view);
                    const foot = document.createElement("div");
                    foot.className = "leader-note-actions";
                    foot.innerHTML =
                        '<button type="button" class="leader-note-btn secondary leader-note-dismiss-btn">关闭</button>';
                    foot.querySelector(".leader-note-dismiss-btn")?.addEventListener("click", closeOverlay);
                    box.appendChild(foot);
                } else {
                    box.insertAdjacentHTML(
                        "beforeend",
                        '<textarea class="leader-note-input" placeholder="输入主领提示…"></textarea><div class="leader-note-actions"><button type="button" class="leader-note-btn leader-note-save-btn">保存</button><button type="button" class="leader-note-btn secondary leader-note-cancel-btn">取消</button></div>'
                    );
                    const ta = box.querySelector(".leader-note-input");
                    ta.value = noteVal;
                    box.querySelector(".leader-note-save-btn")?.addEventListener("click", () => {
                        saveNote(lineIndex, ta.value, songId);
                        closeOverlay();
                        render();
                    });
                    box.querySelector(".leader-note-cancel-btn")?.addEventListener("click", closeOverlay);
                    requestAnimationFrame(() => ta.focus());
                }
                wrap.appendChild(box);
                const onBackdropClose = (e) => {
                    if (e.target !== wrap) return;
                    e.preventDefault();
                    closeOverlay();
                };
                wrap.addEventListener("click", onBackdropClose);
                wrap.addEventListener("touchend", onBackdropClose, { passive: false });
                document.body.appendChild(wrap);
                document.body.classList.add("leader-note-modal-open");
                document.body.style.overflow = "hidden";
                overlay = wrap;
            }

            function drawBgLeader(ts) {
                if (bgMode !== "particles") return;
                ensureProjectionCanvas();
                const ctx = projectionCtx;
                if (!ctx) return;
                const w = window.innerWidth;
                const h = window.innerHeight;
                const g = ctx.createRadialGradient(w * 0.5, h * 0.45, Math.min(w, h) * 0.1, w * 0.5, h * 0.55, Math.max(w, h) * 0.8);
                g.addColorStop(0, "#0f1f3f");
                g.addColorStop(1, "#000");
                ctx.fillStyle = g;
                ctx.fillRect(0, 0, w, h);
                if (pts.length !== PARTICLE_BG_COUNT) {
                    pts = createAmbientParticles(w, h, PARTICLE_BG_COUNT);
                }
                const dt = clamp((ts - (projectionLastTs || ts)) / 16.67, 0.5, 1.8);
                projectionLastTs = ts;
                pts.forEach((p) => {
                    p.x += p.vx * dt;
                    p.y += p.vy * dt;
                    if (p.x < 0 || p.x > w) p.vx *= -1;
                    if (p.y < 0 || p.y > h) p.vy *= -1;
                    p.x = clamp(p.x, 0, w);
                    p.y = clamp(p.y, 0, h);
                    applyParticleShadow(ctx, p);
                    applyParticleFill(ctx, p);
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
                if (bgImg) {
                    bgImg.style.display = "none";
                    bgImg.removeAttribute("src");
                    delete bgImg.dataset.leaderCustomSrc;
                }
                let solid = "#000000";
                if (bgMode === "white") solid = "#ffffff";
                else if (bgMode === "gray") solid = "#2a2d35";
                else if (bgMode === "navy") solid = "#0a1428";
                else if (bgMode === "particles") solid = "#000000";
                else if (bgMode === "custom") solid = "#000000";
                host.style.background = solid;

                if (bgMode === "particles") {
                    bgCanvas.style.display = "block";
                    pts = [];
                    projectionLastTs = 0;
                    bgLoop = requestAnimationFrame(drawBgLeader);
                } else {
                    bgCanvas.style.display = "none";
                    if (bgMode === "custom" && leaderBgCustomDataUrl && bgImg) {
                        bgImg.style.display = "block";
                        if (bgImg.dataset.leaderCustomSrc !== leaderBgCustomDataUrl) {
                            bgImg.dataset.leaderCustomSrc = leaderBgCustomDataUrl;
                            bgImg.src = leaderBgCustomDataUrl;
                        }
                    }
                }
                bgPanel?.querySelectorAll("[data-bg]").forEach((btn) => btn.classList.toggle("active", btn.getAttribute("data-bg") === bgMode));
            }

            const loadLeaderFlowSnapshot = () => {
                const fromPayload = liveState?.worshipFlow;
                if (fromPayload?.cards?.length) {
                    localWorshipFlow = fromPayload;
                    return;
                }
                const key = FLOW_CACHE_PREFIX + encodeURIComponent(String(liveState?.title || ""));
                const cached = parseJSON(localStorage.getItem(key) || "", null);
                if (cached?.cards?.length) localWorshipFlow = cached;
                else localWorshipFlow = null;
            };

            const persistLeaderFlowLocal = (flow) => {
                const key = FLOW_CACHE_PREFIX + encodeURIComponent(String(liveState?.title || ""));
                try {
                    localStorage.setItem(key, JSON.stringify(flow));
                } catch (_) {}
            };

            const saveLeaderFlowToMain = (flow) => {
                localWorshipFlow = flow;
                persistLeaderFlowLocal(flow);
                if (channel) channel.postMessage({ type: "leader_flow_save", songId: liveState?.songId || "", flow });
            };

            const getLeaderFlowCards = () => (localWorshipFlow?.cards && Array.isArray(localWorshipFlow.cards) ? localWorshipFlow.cards : []);

            const clampFlowCursor = () => {
                const n = getLeaderFlowCards().length;
                flowCursor = clamp(flowCursor, 0, Math.max(0, n - 1));
            };

            const syncFlowCursorFromLivePage = () => {
                const { pages, idx } = getPages();
                if (!pages.length) return;
                const cards = getLeaderFlowCards();
                if (!cards.length) {
                    flowCursor = 0;
                    return;
                }
                let found = -1;
                for (let i = 0; i < cards.length; i++) {
                    const c = cards[i];
                    if (c.type === "lyrics" && Number(c.pageIndex) === idx) {
                        found = i;
                        break;
                    }
                }
                flowCursor = found >= 0 ? found : 0;
            };

            const applyLeaderFlowCardToMain = (card) => {
                if (!channel || !card) return;
                if (card.type === "lyrics") {
                    lastFlowWasVerseOverlay = false;
                    channel.postMessage({ type: "goto", page: Number(card.pageIndex) || 0 });
                    return;
                }
                if (card.type === "repeat") {
                    lastFlowWasVerseOverlay = false;
                    channel.postMessage({ type: "goto", page: Number(card.targetPageIndex) || 0 });
                    return;
                }
                if (card.type === "free") {
                    lastFlowWasVerseOverlay = true;
                    const line = String(card.verseText || "你们要赞美耶和华！").trim() || "你们要赞美耶和华！";
                    channel.postMessage({ type: "leader_overlay", action: "verse", lines: [line], bgType: card.bgType || "solid-black" });
                    return;
                }
                if (card.type === "bridge" || card.type === "speech") {
                    if (lastFlowWasVerseOverlay) channel.postMessage({ type: "leader_overlay", action: "clear" });
                    lastFlowWasVerseOverlay = false;
                }
            };

            const navigateLeaderFlow = (delta) => {
                loadLeaderFlowSnapshot();
                const d = Number(delta) || 0;
                const cards = getLeaderFlowCards();
                if (displayMode !== "flow" || !cards.length) {
                    if (channel) channel.postMessage({ type: "flip", delta: d });
                    return;
                }
                const n = cards.length;
                const next = clamp(flowCursor + d, 0, n - 1);
                if (next === flowCursor && d !== 0) return;
                flowCursor = next;
                applyLeaderFlowCardToMain(cards[flowCursor]);
                render();
            };

            const hideFlowCtxMenu = () => {
                if (flowCtxMenuEl?.parentNode) flowCtxMenuEl.parentNode.removeChild(flowCtxMenuEl);
                flowCtxMenuEl = null;
            };

            const closeFlowEditor = () => {
                hideFlowCtxMenu();
                if (flowEditorWrap?.parentNode) flowEditorWrap.parentNode.removeChild(flowEditorWrap);
                flowEditorWrap = null;
                if (flowLongPressTimer) {
                    clearTimeout(flowLongPressTimer);
                    flowLongPressTimer = 0;
                }
                flowLongPressCardId = null;
            };

            const refreshFlowEditorList = () => {
                if (!flowEditorWrap) return;
                const list = flowEditorWrap.querySelector(".leader-flow-editor-list");
                if (!list) return;
                const cards = getLeaderFlowCards();
                list.innerHTML =
                    cards
                        .map((c) => {
                            const typeLabel =
                                c.type === "lyrics"
                                    ? "歌词"
                                    : c.type === "bridge"
                                        ? "连接词"
                                        : c.type === "repeat"
                                            ? "重复"
                                            : c.type === "speech"
                                                ? "说话"
                                                : c.type === "free"
                                                    ? "自由"
                                                    : c.type;
                            const sub =
                                c.type === "lyrics"
                                    ? `第 ${Number(c.pageIndex) + 1} 页`
                                    : c.type === "repeat"
                                        ? `→第${Number(c.targetPageIndex) + 1}页 ×${Math.max(1, Number(c.count) || 1)}`
                                        : c.type === "free"
                                            ? (String(c.leaderHint || "").slice(0, 40) || "提示词")
                                            : String(c.body || "").slice(0, 48);
                            return `<div class="leader-flow-editor-card" draggable="true" data-flow-card-id="${escapeHtml(c.id)}"><span class="leader-flow-drag-h">⠿</span><div class="leader-flow-editor-card-main"><div class="leader-flow-editor-card-title">${escapeHtml(c.label || "")} <span class="leader-flow-type-tag">${typeLabel}</span></div><div class="leader-flow-editor-card-sub">${escapeHtml(sub)}</div></div><div class="leader-flow-move-col"><button type="button" class="leader-flow-move-btn" data-flow-move="up" aria-label="上移">↑</button><button type="button" class="leader-flow-move-btn" data-flow-move="down" aria-label="下移">↓</button></div></div>`;
                        })
                        .join("") || "<div class='leader-flow-editor-empty'>暂无卡片，点击「生成流程」</div>";
            };

            const moveFlowCard = (cardId, delta) => {
                const cards = getLeaderFlowCards();
                const ix = cards.findIndex((c) => c.id === cardId);
                if (ix < 0) return;
                const to = ix + delta;
                if (to < 0 || to >= cards.length) return;
                const [moved] = cards.splice(ix, 1);
                cards.splice(to, 0, moved);
                saveLeaderFlowToMain({ version: 1, cards });
                refreshFlowEditorList();
            };

            const openFlowTemplateModal = () => {
                hideFlowCtxMenu();
                let modal = flowEditorWrap.querySelector(".leader-flow-template-modal");
                if (!modal) {
                    modal = document.createElement("div");
                    modal.className = "leader-flow-template-modal";
                    modal.innerHTML =
                        '<div class="leader-flow-template-box"><h3>快速模板</h3><p class="leader-flow-template-desc">选择后将清空当前流程并按模板生成；页数不足时会自动压缩到现有段落。</p><button type="button" data-tpl="standard">标准 A-B-C-B-C</button><button type="button" data-tpl="repeat">反复 A-A-B-C-B-C-B</button><button type="button" data-tpl="short">简短 A-B-C</button><button type="button" class="leader-flow-tpl-close" data-tpl-close>取消</button></div>';
                    flowEditorWrap.appendChild(modal);
                    modal.addEventListener("click", (e) => {
                        if (e.target.closest("[data-tpl-close]") || e.target.closest(".leader-flow-tpl-close")) {
                            modal.style.display = "none";
                            return;
                        }
                        if (e.target === modal) {
                            modal.style.display = "none";
                            return;
                        }
                        const b = e.target.closest("[data-tpl]");
                        if (!b) return;
                        const key = b.getAttribute("data-tpl");
                        const { pages: pp } = getPages();
                        const pn = pp.length;
                        if (!pn) {
                            showToast("当前没有歌词分页，请先在主控台分页或同步诗歌", b);
                            return;
                        }
                        const f = worshipFlowTemplateBuild(key, pn);
                        if (!f.cards.length) {
                            showToast("无法生成流程", b);
                            return;
                        }
                        saveLeaderFlowToMain(f);
                        flowCursor = 0;
                        modal.style.display = "none";
                        refreshFlowEditorList();
                    });
                }
                modal.style.display = "flex";
            };

            const openFlowCardEditor = (cardId) => {
                const cards = getLeaderFlowCards();
                const c = cards.find((x) => x.id === cardId);
                if (!c) return;
                hideFlowCtxMenu();
                const sheet = document.createElement("div");
                sheet.className = "leader-flow-sheet";
                let inner = "";
                if (c.type === "bridge" || c.type === "speech") {
                    inner = `<label>内容</label><textarea class="leader-flow-sheet-ta">${escapeHtml(String(c.body || ""))}</textarea><div class="leader-flow-sheet-actions"><button type="button" data-save>保存</button><button type="button" data-cancel>取消</button></div>`;
                } else if (c.type === "repeat") {
                    inner = `<label>目标段落页码（从 1 开始）</label><input type="number" class="leader-flow-sheet-inp" min="1" value="${Number(c.targetPageIndex) + 1}" data-rep-page /><label>重复次数</label><input type="number" class="leader-flow-sheet-inp" min="1" max="12" value="${Math.max(1, Number(c.count) || 1)}" data-rep-count /><div class="leader-flow-sheet-actions"><button type="button" data-save>保存</button><button type="button" data-cancel>取消</button></div>`;
                } else if (c.type === "free") {
                    inner = `<label>会众屏经文（单行）</label><textarea class="leader-flow-sheet-ta" data-verse>${escapeHtml(String(c.verseText || ""))}</textarea><label>主领提示词</label><textarea class="leader-flow-sheet-ta" data-hint>${escapeHtml(String(c.leaderHint || ""))}</textarea><div class="leader-flow-sheet-actions"><button type="button" data-save>保存</button><button type="button" data-cancel>取消</button></div>`;
                } else {
                    inner = '<p>歌词卡片由段落生成，可删除后重新点「生成流程」。</p><div class="leader-flow-sheet-actions"><button type="button" data-cancel>关闭</button></div>';
                }
                sheet.innerHTML = `<div class="leader-flow-sheet-inner"><h3>${escapeHtml(c.label || "")}</h3>${inner}</div>`;
                flowEditorWrap.appendChild(sheet);
                const closeSheet = () => {
                    if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
                };
                sheet.querySelector("[data-cancel]")?.addEventListener("click", closeSheet);
                sheet.addEventListener("click", (e) => {
                    if (e.target === sheet) closeSheet();
                });
                sheet.querySelector("[data-save]")?.addEventListener("click", () => {
                    if (c.type === "bridge" || c.type === "speech") {
                        c.body = sheet.querySelector(".leader-flow-sheet-ta")?.value || "";
                    } else if (c.type === "repeat") {
                        const p1 = Math.max(1, parseInt(String(sheet.querySelector("[data-rep-page]")?.value || "1"), 10)) - 1;
                        const { pages: px } = getPages();
                        c.targetPageIndex = clamp(p1, 0, Math.max(0, px.length - 1));
                        c.count = clamp(parseInt(String(sheet.querySelector("[data-rep-count]")?.value || "1"), 10) || 1, 1, 12);
                    } else if (c.type === "free") {
                        c.verseText = sheet.querySelector("[data-verse]")?.value || "";
                        c.leaderHint = sheet.querySelector("[data-hint]")?.value || "";
                    }
                    saveLeaderFlowToMain({ version: 1, cards: [...cards] });
                    closeSheet();
                    refreshFlowEditorList();
                });
            };

            const showFlowCardContextMenu = (clientX, clientY, cardId) => {
                hideFlowCtxMenu();
                flowCtxMenuEl = document.createElement("div");
                flowCtxMenuEl.className = "leader-flow-ctx-menu";
                flowCtxMenuEl.innerHTML =
                    '<button type="button" data-ctx="edit">编辑</button><button type="button" data-ctx="copy">复制</button><button type="button" data-ctx="delete">删除</button>';
                flowEditorWrap.appendChild(flowCtxMenuEl);
                const pad = 6;
                const w = 140;
                const h = 110;
                const left = clamp(clientX, pad, window.innerWidth - w - pad);
                const top = clamp(clientY, pad, window.innerHeight - h - pad);
                flowCtxMenuEl.style.left = `${left}px`;
                flowCtxMenuEl.style.top = `${top}px`;
                flowCtxMenuEl.onclick = (e) => {
                    const b = e.target.closest("[data-ctx]");
                    if (!b) return;
                    const act = b.getAttribute("data-ctx");
                    const cards = getLeaderFlowCards();
                    const ix = cards.findIndex((x) => x.id === cardId);
                    if (act === "edit") {
                        openFlowCardEditor(cardId);
                    } else if (act === "copy" && ix >= 0) {
                        const copy = { ...cards[ix], id: uidFlowCard() };
                        cards.splice(ix + 1, 0, copy);
                        saveLeaderFlowToMain({ version: 1, cards });
                    } else if (act === "delete" && ix >= 0) {
                        cards.splice(ix, 1);
                        saveLeaderFlowToMain({ version: 1, cards });
                    }
                    hideFlowCtxMenu();
                    refreshFlowEditorList();
                };
            };

            const openFlowEditor = () => {
                hideFontPanel();
                hideColorPanel();
                ensureLeaderLiveState();
                loadLeaderFlowSnapshot();
                closeFlowEditor();
                flowEditorWrap = document.createElement("div");
                flowEditorWrap.className = "leader-flow-editor-overlay";
                flowEditorWrap.innerHTML =
                    '<div class="leader-flow-editor-panel"><div class="leader-flow-editor-head"><span>敬拜流程编排</span><button type="button" class="leader-flow-editor-x" data-flow-close>✕</button></div><div class="leader-flow-editor-toolbar"><button type="button" data-gen>生成流程</button><button type="button" data-tpl-open>快速模板</button><button type="button" data-add="repeat">＋重复</button><button type="button" data-add="speech">＋说话/祷告</button><button type="button" data-add="free">＋自由敬拜</button></div><div class="leader-flow-editor-list" role="list"></div><p class="leader-flow-editor-tip" data-tip="desktop">拖拽卡片排序 · 长按或右键打开菜单</p><p class="leader-flow-editor-tip" data-tip="handheld">点卡片编辑 · 用 ↑↓ 调整顺序</p><div class="leader-flow-editor-footer"><button type="button" class="leader-flow-editor-use-btn" data-flow-apply-use>使用</button></div></div>';
                host.appendChild(flowEditorWrap);

                flowEditorWrap.querySelector("[data-flow-close]")?.addEventListener("click", closeFlowEditor);
                flowEditorWrap.addEventListener("click", (e) => {
                    if (e.target === flowEditorWrap) closeFlowEditor();
                });
                flowEditorWrap.querySelector("[data-gen]")?.addEventListener("click", () => {
                    const { pages: pp } = getPages();
                    const f = generateDefaultWorshipFlowFromPages(pp.length);
                    saveLeaderFlowToMain(f);
                    refreshFlowEditorList();
                });
                flowEditorWrap.querySelector("[data-tpl-open]")?.addEventListener("click", () => openFlowTemplateModal());
                flowEditorWrap.querySelectorAll("[data-add]").forEach((btn) => {
                    btn.addEventListener("click", () => {
                        const kind = btn.getAttribute("data-add");
                        const cards = getLeaderFlowCards();
                        if (kind === "repeat") {
                            cards.push({
                                id: uidFlowCard(),
                                type: "repeat",
                                label: "【重复】",
                                targetPageIndex: 0,
                                count: 2
                            });
                        } else if (kind === "speech") {
                            cards.push({
                                id: uidFlowCard(),
                                type: "speech",
                                label: "【说话/祷告】",
                                body: ""
                            });
                        } else if (kind === "free") {
                            cards.push({
                                id: uidFlowCard(),
                                type: "free",
                                label: "【自由敬拜】",
                                leaderHint: "自由敬拜中…跟随圣灵回应",
                                verseText: "诗篇 46:10 你们要休息，要知道我是 神。",
                                bgType: "solid-black"
                            });
                        }
                        saveLeaderFlowToMain({ version: 1, cards });
                        refreshFlowEditorList();
                    });
                });

                flowEditorWrap.querySelector("[data-flow-apply-use]")?.addEventListener("click", () => {
                    const cc = getLeaderFlowCards();
                    if (!cc.length) {
                        showToast("请先生成或添加流程卡片", flowEditorWrap.querySelector("[data-flow-apply-use]"));
                        return;
                    }
                    displayMode = "flow";
                    try {
                        localStorage.setItem(DISPLAY_MODE_KEY, displayMode);
                    } catch (_e) {
                        /* ignore */
                    }
                    loadLeaderFlowSnapshot();
                    syncFlowCursorFromLivePage();
                    clampFlowCursor();
                    const cardsNow = getLeaderFlowCards();
                    if (cardsNow.length) applyLeaderFlowCardToMain(cardsNow[flowCursor]);
                    closeFlowEditor();
                    render();
                    showToolbar();
                });

                const list = flowEditorWrap.querySelector(".leader-flow-editor-list");
                list.addEventListener("click", (e) => {
                    const moveBtn = e.target.closest("[data-flow-move]");
                    if (moveBtn) {
                        e.preventDefault();
                        const row = moveBtn.closest("[data-flow-card-id]");
                        const cid = row?.getAttribute("data-flow-card-id");
                        if (cid) moveFlowCard(cid, moveBtn.getAttribute("data-flow-move") === "up" ? -1 : 1);
                        return;
                    }
                    if (isLeaderHandheldViewport()) {
                        const row = e.target.closest("[data-flow-card-id]");
                        if (row && !e.target.closest(".leader-flow-move-col")) {
                            openFlowCardEditor(row.getAttribute("data-flow-card-id"));
                        }
                    }
                });
                list.addEventListener("dragstart", (e) => {
                    const row = e.target.closest("[data-flow-card-id]");
                    if (!row || !list.contains(row)) return;
                    flowDragId = row.getAttribute("data-flow-card-id");
                    if (e.dataTransfer) {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", flowDragId);
                    }
                });
                list.addEventListener("dragover", (e) => {
                    e.preventDefault();
                    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                });
                list.addEventListener("drop", (e) => {
                    e.preventDefault();
                    const row = e.target.closest("[data-flow-card-id]");
                    if (!row || !flowDragId) return;
                    const toId = row.getAttribute("data-flow-card-id");
                    const cards = getLeaderFlowCards();
                    const fromIx = cards.findIndex((c) => c.id === flowDragId);
                    const toIx = cards.findIndex((c) => c.id === toId);
                    flowDragId = null;
                    if (fromIx < 0 || toIx < 0 || fromIx === toIx) return;
                    const [moved] = cards.splice(fromIx, 1);
                    cards.splice(toIx, 0, moved);
                    saveLeaderFlowToMain({ version: 1, cards });
                    refreshFlowEditorList();
                });
                list.addEventListener("dragend", () => {
                    flowDragId = null;
                });

                list.addEventListener("contextmenu", (e) => {
                    const row = e.target.closest("[data-flow-card-id]");
                    if (!row) return;
                    e.preventDefault();
                    showFlowCardContextMenu(e.clientX, e.clientY, row.getAttribute("data-flow-card-id"));
                });

                list.addEventListener(
                    "touchstart",
                    (e) => {
                        const row = e.target.closest("[data-flow-card-id]");
                        if (!row) return;
                        const id = row.getAttribute("data-flow-card-id");
                        flowLongPressCardId = id;
                        if (flowLongPressTimer) clearTimeout(flowLongPressTimer);
                        flowLongPressTimer = window.setTimeout(() => {
                            flowLongPressTimer = 0;
                            const t = e.changedTouches?.[0] || e.touches?.[0];
                            if (t && flowLongPressCardId === id) showFlowCardContextMenu(t.clientX, t.clientY, id);
                        }, 520);
                    },
                    { passive: true }
                );
                list.addEventListener("touchend", () => {
                    if (flowLongPressTimer) {
                        clearTimeout(flowLongPressTimer);
                        flowLongPressTimer = 0;
                    }
                    flowLongPressCardId = null;
                });
                list.addEventListener(
                    "touchmove",
                    () => {
                        if (flowLongPressTimer) {
                            clearTimeout(flowLongPressTimer);
                            flowLongPressTimer = 0;
                        }
                        flowLongPressCardId = null;
                    },
                    { passive: true }
                );

                refreshFlowEditorList();
            };

            let leaderBrowseIx = 0;
            let leaderScrollIO = null;
            let leaderBottomRailEl = null;
            let leaderBottomRailWired = false;
            let leaderSideRailEl = null;
            let leaderSideRailWired = false;
            let leaderSideSettingsOpen = false;
            let leaderSideSettingsBackdropEl = null;
            let lastLeaderFollowSongId = "";
            let leaderPendingScrollIx = null;
            let leaderLastPlaylistSig = "";
            let leaderSkipNextFullRender = false;
            let leaderSuppressRenderUntil = 0;
            let leaderPlaylistSyncTimer = 0;
            let leaderScrollLockIO = false;

            function getLeaderUiAnchorEl() {
                const bgBtn = leaderSideRailEl?.querySelector?.('[data-action="bg-panel"]');
                if (bgBtn) return bgBtn;
                return toolbar.querySelector('[data-action="bg-panel"]') || host;
            }

            const getLeaderPlaylistOrderedSongs = () => {
                const ids = Array.isArray(state.playlist?.items) ? state.playlist.items.filter(Boolean) : [];
                if (ids.length) {
                    return ids
                        .map((id) => state.songs.find((s) => s && String(s.id) === String(id)))
                        .filter((s) => !!s);
                }
                const sid = String(liveState?.songId || state.currentSongId || "");
                const one = sid ? state.songs.find((s) => s && String(s.id) === sid) : null;
                if (one) return [one];
                const cur = typeof currentSong === "function" ? currentSong() : null;
                return cur ? [cur] : [];
            };

            function getLeaderActiveSongId() {
                if (displayMode === "scroll") {
                    const songs = getLeaderPlaylistOrderedSongs();
                    if (songs.length) {
                        const ix = clamp(leaderBrowseIx, 0, songs.length - 1);
                        return String(songs[ix]?.id || "");
                    }
                }
                return String(liveState?.songId || state.currentSongId || state.songs[0]?.id || "");
            }

            function buildLeaderLocalLiveState(songIdOverride) {
                const sid = String(songIdOverride || getLeaderActiveSongId() || "");
                const song = sid ? state.songs.find((s) => s && String(s.id) === sid) : null;
                if (!song) return null;
                const lyrics = String(song.lyrics ?? "").replace(/\r/g, "");
                const defaultLines = clamp(Number(state.ui?.defaultLines) || 5, 1, 12);
                let pages = splitPages(lyrics, defaultLines);
                if (!pages.length) pages = [[""]];
                const prevIdx =
                    liveState && String(liveState.songId || "") === sid ? Number(liveState.pageIndex) || 0 : 0;
                return {
                    version: 1,
                    updatedAt: Date.now(),
                    songId: sid,
                    title: String(song.title || ""),
                    fontColor: liveState?.fontColor || "#ffffff",
                    pages,
                    pageIndex: clamp(prevIdx, 0, Math.max(0, pages.length - 1)),
                    worshipFlow: song.leaderWorshipFlow || liveState?.worshipFlow || null
                };
            }

            function ensureLeaderLiveState(forceSongId) {
                const sid = String(forceSongId || getLeaderActiveSongId() || "");
                if (liveState?.pages?.length && String(liveState.songId || "") === sid && sid) return liveState;
                const built = buildLeaderLocalLiveState(sid);
                if (built) {
                    liveState = built;
                    if (typeof globalThis !== "undefined") globalThis.worshipLiveState = liveState;
                }
                return liveState;
            }

            const syncLeaderHandheldChrome = () => {
                host.classList.toggle("leader-handheld", isLeaderHandheldViewport());
            };

            const buildLeaderTopBarHtml = (leftTitle, progressText) => {
                const lt = String(leftTitle || "").trim() || "当前诗歌";
                const pl = String(progressText || "").trim() || "—";
                return `<header class="leader-top-bar leader-top-bar--minimal" role="banner"><div class="leader-top-bar-left"><div class="leader-top-bar-title">${escapeHtml(lt)}</div></div><div class="leader-top-bar-right"><span class="leader-top-bar-progress">${escapeHtml(pl)}</span></div></header>`;
            };

            const teardownLeaderScrollIO = () => {
                if (leaderScrollIO) {
                    try {
                        leaderScrollIO.disconnect();
                    } catch (_e) {
                        /* ignore */
                    }
                    leaderScrollIO = null;
                }
            };

            const getLeaderFmtLine = (ln) =>
                typeof globalThis.formatLyricLineForCompactPreview === "function"
                    ? globalThis.formatLyricLineForCompactPreview(ln)
                    : String(ln ?? "");

            const updateLeaderTopBarReadout = () => {
                const songs = getLeaderPlaylistOrderedSongs();
                const ix = clamp(leaderBrowseIx, 0, Math.max(0, songs.length - 1));
                const tit = lyricLayer.querySelector(".leader-top-bar-title");
                const prog = lyricLayer.querySelector(".leader-top-bar-progress");
                if (tit) tit.textContent = String(songs[ix]?.title || getLeaderHeaderTitle()).trim() || "当前诗歌";
                if (prog) prog.textContent = `第 ${ix + 1} 首 / 共 ${Math.max(1, songs.length)} 首`;
            };

            const updateBottomRailHighlight = () => {
                if (!leaderBottomRailEl) return;
                const ix = leaderBrowseIx;
                leaderBottomRailEl.querySelectorAll("[data-rail-ix]").forEach((btn) => {
                    const i = parseInt(btn.getAttribute("data-rail-ix") || "0", 10) || 0;
                    btn.classList.toggle("is-active", i === ix);
                });
            };

            const ensureLeaderBottomRail = () => {
                if (leaderBottomRailEl) return leaderBottomRailEl;
                leaderBottomRailEl = document.createElement("div");
                leaderBottomRailEl.className = "leader-bottom-rail";
                leaderBottomRailEl.setAttribute("role", "navigation");
                leaderBottomRailEl.setAttribute("aria-label", "诗歌快速定位");
                leaderBottomRailEl.innerHTML = "<div class=\"leader-rail-scroll\"></div>";
                host.insertBefore(leaderBottomRailEl, toolbar);
                return leaderBottomRailEl;
            };

            const leaderToastAnchor = () => leaderSideRailEl || leaderBottomRailEl || null;

            const renderBottomRailChips = (songs) => {
                const el = ensureLeaderBottomRail();
                const track = el.querySelector(".leader-rail-scroll");
                if (!track) return;
                el.style.display = "flex";
                if (!songs || !songs.length) {
                    track.innerHTML = '<span class="leader-rail-empty">暂无诗歌</span>';
                    return;
                }
                const ixActive = clamp(leaderBrowseIx, 0, Math.max(0, songs.length - 1));
                track.innerHTML = songs
                    .map(
                        (s, i) =>
                            `<button type="button" class="leader-rail-chip${i === ixActive ? " is-active" : ""}" data-rail-ix="${i}">${escapeHtml(s.title || "未命名")}</button>`
                    )
                    .join("");
            };

            const leaderPlaylistSignature = (songs) =>
                (songs || [])
                    .map((s) => String(s?.id ?? ""))
                    .join("\u0001");

            const leaderPlaylistScrollDomReady = (expectedCount) => {
                if (displayMode !== "scroll") return false;
                const root = lyricLayer.querySelector(".leader-playlist-scroll-root");
                if (!root) return false;
                const n = Number(expectedCount) || 0;
                if (n < 1) return false;
                return root.querySelectorAll(".leader-song-block[data-pl-ix]").length === n;
            };

            const leaderApplyPlaylistIndexLocal = (targetIx) => {
                const items = state.playlist?.items || [];
                const ix = clamp(Number(targetIx) || 0, 0, Math.max(0, items.length - 1));
                if (!items.length) return false;
                const songId = items[ix];
                if (!state.songs.some((s) => s && s.id === songId)) return false;
                state.playlist.running = true;
                state.playlist.activeIndex = ix;
                if (String(state.currentSongId) !== String(songId)) {
                    state.currentSongId = songId;
                    state.currentPage = 0;
                }
                return true;
            };

            const scheduleLeaderPlaylistSync = (targetIx, opts = {}) => {
                if (leaderPlaylistSyncTimer) clearTimeout(leaderPlaylistSyncTimer);
                leaderPlaylistSyncTimer = setTimeout(() => {
                    leaderPlaylistSyncTimer = 0;
                    try {
                        if (channel) channel.postMessage({ type: "leader_select_song", index: targetIx });
                    } catch (_e) {
                        /* ignore */
                    }
                    const items = state.playlist?.items || [];
                    const plSongs = getLeaderPlaylistOrderedSongs();
                    if (opts.light) {
                        leaderApplyPlaylistIndexLocal(targetIx);
                        try {
                            liveState = buildLiveState();
                            globalThis.worshipLiveState = liveState;
                        } catch (_e2) {
                            /* ignore */
                        }
                    } else if (items.length && typeof switchToPlaylistSong === "function") {
                        switchToPlaylistSong(targetIx, false, "first");
                    } else {
                        const song = plSongs[targetIx];
                        if (song?.id && typeof switchSong === "function") switchSong(song.id);
                    }
                    if (!opts.light) {
                        try {
                            liveState = buildLiveState();
                            globalThis.worshipLiveState = liveState;
                        } catch (_e2) {
                            /* ignore */
                        }
                    }
                }, opts.light ? 48 : 0);
            };

            const scrollLeaderToPlaylistIndex = (ix, behavior = "instant") => {
                const root = lyricLayer.querySelector(".leader-playlist-scroll-root");
                const anchor = document.getElementById(`leader-song-anchor-${ix}`);
                if (!root || !anchor) return false;
                const rootRect = root.getBoundingClientRect();
                const anchorRect = anchor.getBoundingClientRect();
                const targetTop = Math.max(0, anchorRect.top - rootRect.top + root.scrollTop - 60);
                const beh = behavior === "smooth" ? "smooth" : "auto";
                leaderScrollLockIO = true;
                try {
                    root.scrollTo({ top: targetTop, behavior: beh });
                } catch (_e) {
                    root.scrollTop = targetTop;
                }
                const releaseLock = () => {
                    leaderScrollLockIO = false;
                };
                if (beh === "smooth") {
                    let frames = 0;
                    const watch = () => {
                        if (Math.abs(root.scrollTop - targetTop) < 3 || frames > 72) releaseLock();
                        else {
                            frames += 1;
                            requestAnimationFrame(watch);
                        }
                    };
                    requestAnimationFrame(watch);
                } else {
                    requestAnimationFrame(releaseLock);
                }
                return true;
            };

            const jumpLeaderToPlaylistIndex = (ix, opts = {}) => {
                const plSongs = getLeaderPlaylistOrderedSongs();
                const n = plSongs.length;
                if (n < 1) return;
                const targetIx = clamp(Number(ix) || 0, 0, n - 1);
                leaderBrowseIx = targetIx;
                const sig = leaderPlaylistSignature(plSongs);
                const canLightScroll =
                    displayMode === "scroll" &&
                    opts.forceRender !== true &&
                    leaderPlaylistScrollDomReady(n) &&
                    sig === leaderLastPlaylistSig;

                if (canLightScroll) {
                    leaderPendingScrollIx = null;
                    leaderSkipNextFullRender = true;
                    leaderSuppressRenderUntil = Date.now() + 180;
                    scrollLeaderToPlaylistIndex(targetIx, "smooth");
                    const targetSong = plSongs[targetIx];
                    if (targetSong?.id) lastLeaderFollowSongId = String(targetSong.id);
                    updateLeaderTopBarReadout();
                    updateBottomRailHighlight();
                    scheduleLeaderPlaylistSync(targetIx, { light: true });
                    showToolbar();
                    return;
                }

                if (displayMode === "scroll") leaderPendingScrollIx = targetIx;
                scheduleLeaderPlaylistSync(targetIx);
                if (opts.render !== false) render();
                else {
                    updateLeaderTopBarReadout();
                    updateBottomRailHighlight();
                }
                showToolbar();
            };


            const applyLeaderLiveUpdateFromPayload = (payload) => {
                if (!payload?.pages) return false;
                liveState = payload;
                if (liveState?.worshipFlow?.cards?.length) localWorshipFlow = liveState.worshipFlow;
                const plSongs = getLeaderPlaylistOrderedSongs();
                const plN = plSongs.length;
                const sig = leaderPlaylistSignature(plSongs);
                const lightOk =
                    displayMode === "scroll" &&
                    plN > 0 &&
                    sig === leaderLastPlaylistSig &&
                    leaderPlaylistScrollDomReady(plN);
                const suppressRender =
                    leaderSkipNextFullRender || Date.now() < leaderSuppressRenderUntil;
                if (!lightOk && !suppressRender) return false;
                leaderSkipNextFullRender = false;
                const sid = String(liveState?.songId || "");
                let syncIx = plSongs.findIndex((s) => String(s.id) === sid);
                if (syncIx < 0) syncIx = clamp(state.playlist?.activeIndex ?? 0, 0, plN - 1);
                leaderBrowseIx = syncIx;
                updateLeaderTopBarReadout();
                updateBottomRailHighlight();
                return true;
            };
            const wireLeaderBottomRailOnce = () => {
                if (leaderBottomRailWired || !leaderBottomRailEl) return;
                leaderBottomRailWired = true;
                leaderBottomRailEl.addEventListener("click", (e) => {
                    const chip = e.target.closest("[data-rail-ix]");
                    if (!chip) return;
                    e.preventDefault();
                    const ix = clamp(parseInt(chip.getAttribute("data-rail-ix") || "0", 10) || 0, 0, 999);
                    jumpLeaderToPlaylistIndex(ix);
                });
            };

            const bindLeaderScrollObserver = (scrollRoot, blockCount) => {
                teardownLeaderScrollIO();
                if (!scrollRoot || blockCount < 1) return;
                leaderScrollIO = new IntersectionObserver(
                    (ents) => {
                        let best = null;
                        let bestR = 0;
                        ents.forEach((en) => {
                            if (!en.isIntersecting || en.target?.dataset?.plIx == null) return;
                            const r = en.intersectionRatio;
                            if (r > bestR) {
                                bestR = r;
                                best = en.target;
                            }
                        });
                        if (leaderScrollLockIO) return;
                        if (best?.dataset?.plIx != null) {
                            const nx = clamp(parseInt(best.dataset.plIx, 10) || 0, 0, Math.max(0, blockCount - 1));
                            if (nx !== leaderBrowseIx) {
                                leaderBrowseIx = nx;
                                updateLeaderTopBarReadout();
                                updateBottomRailHighlight();
                            }
                        }
                    },
                    { root: scrollRoot, rootMargin: "-10% 0px -32% 0px", threshold: [0, 0.12, 0.28, 0.5, 0.75, 1] }
                );
                scrollRoot.querySelectorAll(".leader-song-block[data-pl-ix]").forEach((el) => leaderScrollIO.observe(el));
            };

            function delegateLeaderToolbarButton(btn) {
                if (!btn) return;
                if (btn.dataset.action === "leader-help") {
                    openLeaderHelpModal();
                } else if (btn.dataset.action === "leader-guide") {
                    openLeaderGuideModal(0, null);
                } else if (btn.dataset.mode) {
                    displayMode = btn.dataset.mode;
                    localStorage.setItem(DISPLAY_MODE_KEY, displayMode);
                    if (displayMode === "scroll") lastLeaderFollowSongId = "";
                    if (displayMode === "flow") {
                        loadLeaderFlowSnapshot();
                        syncFlowCursorFromLivePage();
                        const cc = getLeaderFlowCards();
                        if (cc.length) applyLeaderFlowCardToMain(cc[flowCursor]);
                    }
                    render();
                } else if (btn.dataset.action === "flow-arrange") {
                    openFlowEditor();
                } else if (btn.dataset.action === "import-pack") {
                    openLeaderSongPackImportUI();
                } else if (btn.dataset.action === "leader-playlist") {
                    openLeaderPlaylistSheet();
                } else if (btn.dataset.action === "leader-edit-lyrics") {
                    openLeaderLyricEditor();
                } else if (btn.dataset.action === "leader-show-qr") {
                    openLeaderQrPopup();
                } else if (btn.dataset.action === "leader-save-qr") {
                    openLeaderBackupModal();
                } else if (btn.dataset.bg) {
                    bgMode = btn.dataset.bg;
                    localStorage.setItem(BG_MODE_KEY, bgMode);
                    applyBg();
                } else if (btn.dataset.action === "bg-panel") {
                    ensureBgPanel();
                    if (bgPanel?.style.display === "block") hideBgPanel();
                    else showBgPanel();
                } else if (btn.dataset.action === "font-minus") {
                    adjustLeaderFontSize(-0.2);
                } else if (btn.dataset.action === "font-plus") {
                    adjustLeaderFontSize(0.2);
                } else if (btn.dataset.action === "font-panel") {
                    toggleFontPanel();
                } else if (btn.dataset.action === "color-panel") {
                    toggleColorPanel();
                } else if (btn.dataset.action === "note") {
                    if (noteEditMode) exitNoteEditMode();
                    else {
                        noteEditMode = true;
                        closeOverlay();
                        closeLeaderSideSettingsPanel();
                        syncNoteEditBanner();
                        syncLeaderSideRailUI();
                        render();
                    }
                } else if (btn.dataset.action === "brush") {
                    toggleDrawMode();
                }
                showToolbar();
            }

            const adjustLeaderFontSize = (delta) => {
                let v = parseFloat(leaderFontSize);
                if (!Number.isFinite(v)) v = 5;
                v = clamp(v + delta, 3, 8);
                leaderFontSize = `${Number(v.toFixed(1))}vw`;
                localStorage.setItem(FONT_SIZE_KEY, leaderFontSize);
                render();
            };

            const closeLeaderSideSettingsPanel = () => {
                if (!leaderSideSettingsOpen) return;
                leaderSideSettingsOpen = false;
                host.classList.remove("leader-side-settings-open");
                leaderSideRailEl?.classList.remove("settings-open");
                const panel = leaderSideRailEl?.querySelector(".leader-gear-menu");
                const fab = leaderSideRailEl?.querySelector(".leader-gear-fab");
                if (fab) fab.setAttribute("aria-expanded", "false");
                if (panel) panel.setAttribute("aria-hidden", "true");
                if (leaderSideSettingsBackdropEl?.parentNode) {
                    leaderSideSettingsBackdropEl.parentNode.removeChild(leaderSideSettingsBackdropEl);
                }
                leaderSideSettingsBackdropEl = null;
            };

            const openLeaderSideSettingsPanel = () => {
                if (leaderSideSettingsOpen) return;
                leaderSideSettingsOpen = true;
                host.classList.add("leader-side-settings-open");
                leaderSideRailEl?.classList.add("settings-open");
                const panel = leaderSideRailEl?.querySelector(".leader-gear-menu");
                const fab = leaderSideRailEl?.querySelector(".leader-gear-fab");
                if (panel) panel.setAttribute("aria-hidden", "false");
                if (fab) fab.setAttribute("aria-expanded", "true");
                if (!leaderSideSettingsBackdropEl) {
                    leaderSideSettingsBackdropEl = document.createElement("button");
                    leaderSideSettingsBackdropEl.type = "button";
                    leaderSideSettingsBackdropEl.className = "leader-side-settings-backdrop";
                    leaderSideSettingsBackdropEl.setAttribute("aria-label", "关闭设置");
                    leaderSideSettingsBackdropEl.addEventListener("click", () => closeLeaderSideSettingsPanel());
                    host.appendChild(leaderSideSettingsBackdropEl);
                }
            };

            const toggleLeaderSideSettingsPanel = () => {
                if (leaderSideSettingsOpen) closeLeaderSideSettingsPanel();
                else openLeaderSideSettingsPanel();
            };

            const syncLeaderSideRailUI = () => {
                if (!leaderSideRailEl) return;
                leaderSideRailEl.querySelector('[data-mode="multi"]')?.classList.toggle("is-active", displayMode === "multi");
                leaderSideRailEl.querySelector('[data-mode="scroll"]')?.classList.toggle("is-active", displayMode === "scroll");
                leaderSideRailEl.querySelector('[data-action="note"]')?.classList.toggle("is-active", noteEditMode);
                leaderSideRailEl.querySelector('[data-action="brush"]')?.classList.toggle("is-active", brushMode);
                leaderSideRailEl.querySelector(".leader-gear-fab")?.classList.toggle("is-active", leaderSideSettingsOpen);
                const colorInp = leaderSideRailEl.querySelector(".leader-side-color-input");
                if (colorInp) {
                    const c = getLeaderLyricColorForRender();
                    const hex = normalizeLeaderLyricHex(c) || "#ffffff";
                    colorInp.value = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#ffffff";
                }
            };

            const buildLeaderSideRailHtml = () =>
                '<div class="leader-gear-menu" role="menu" aria-label="主领工具" aria-hidden="true">' +
                '<button type="button" class="leader-gear-item" data-action="leader-help" role="menuitem"><span class="leader-gear-icon">\u2753</span><span class="leader-gear-label">帮助</span></button>' +
                '<button type="button" class="leader-gear-item" data-action="leader-guide" role="menuitem"><span class="leader-gear-icon">\u25CE</span><span class="leader-gear-label">引导</span></button>' +
                '<button type="button" class="leader-gear-item" data-action="flow-arrange" role="menuitem"><span class="leader-gear-icon">\u2692</span><span class="leader-gear-label">编排</span></button>' +
                '<button type="button" class="leader-gear-item" data-action="bg-panel" role="menuitem"><span class="leader-gear-icon">\u25A0</span><span class="leader-gear-label">背景</span></button>' +
                '<button type="button" class="leader-gear-item leader-gear-item--sync" data-action="leader-show-qr" role="menuitem"><span class="leader-gear-icon">\u21C4</span><span class="leader-gear-label">传数据</span></button>' +
                '<button type="button" class="leader-gear-item leader-gear-item--backup" data-action="leader-save-qr" role="menuitem"><span class="leader-gear-icon">\uD83D\uDCBE</span><span class="leader-gear-label">保存</span></button>' +
                '<button type="button" class="leader-gear-item" data-action="brush" role="menuitem"><span class="leader-gear-icon">\u270D</span><span class="leader-gear-label">画笔</span></button>' +
                '<button type="button" class="leader-gear-item" data-action="note" role="menuitem"><span class="leader-gear-icon">\u270F</span><span class="leader-gear-label">备注</span></button>' +
                '<label class="leader-gear-item leader-gear-item--color" title="字色" role="menuitem"><span class="leader-gear-icon">\u25CF</span><span class="leader-gear-label">字色</span><input type="color" class="leader-side-color-input" aria-label="歌词颜色"></label>' +
                '<div class="leader-gear-item leader-gear-item--font" aria-label="字号" role="group">' +
                '<span class="leader-gear-label">字号</span>' +
                '<div class="leader-side-font-row">' +
                '<button type="button" class="leader-side-font-btn" data-action="font-minus" title="缩小">\u2212</button>' +
                '<button type="button" class="leader-side-font-btn" data-action="font-plus" title="放大">+</button>' +
                "</div></div>" +
                '<button type="button" class="leader-gear-item" data-action="leader-edit-lyrics" role="menuitem"><span class="leader-gear-icon">\u270E</span><span class="leader-gear-label">改词</span></button>' +
                '<button type="button" class="leader-gear-item" data-action="leader-playlist" role="menuitem"><span class="leader-gear-icon">\u2630</span><span class="leader-gear-label">歌单</span></button>' +
                '<div class="leader-gear-mode-row" role="group" aria-label="显示模式">' +
                '<button type="button" class="leader-gear-mode-btn" data-mode="multi" title="单页模式">单页</button>' +
                '<button type="button" class="leader-gear-mode-btn" data-mode="scroll" title="滚动模式">滚动</button>' +
                "</div></div>" +
                '<div class="leader-dock-actions" data-dock-v="4">' +
                '<button type="button" class="leader-save-fab" data-action="leader-save-qr" title="保存播放列表歌词、改词、备注与显示设置，便于日后再次打开" aria-label="保存">' +
                '<span class="leader-save-fab__icon" aria-hidden="true">💾</span><span class="leader-save-fab__label">保存</span></button>' +
                '<button type="button" class="leader-data-sync-fab" id="leader-show-qr-btn" data-action="leader-show-qr" title="传输播放列表歌词与主领设置到手机/平板" aria-label="传数据">' +
                '<span class="leader-data-sync-fab__icon" aria-hidden="true">⇄</span><span class="leader-data-sync-fab__label">传数据</span></button>' +
                '<button type="button" class="leader-gear-fab" title="设置" aria-label="设置" aria-expanded="false" aria-haspopup="menu">\u2699\uFE0F</button>' +
                "</div>";

            const ensureLeaderSideRail = () => {
                const needsRebuild =
                    !leaderSideRailEl ||
                    !leaderSideRailEl.querySelector('.leader-dock-actions[data-dock-v="4"]') ||
                    !leaderSideRailEl.querySelector(".leader-data-sync-fab");
                if (!leaderSideRailEl) {
                    leaderSideRailEl = document.createElement("div");
                    leaderSideRailEl.className = "leader-gear-dock";
                    host.appendChild(leaderSideRailEl);
                } else if (leaderSideRailEl.classList.contains("leader-side-rail")) {
                    leaderSideRailEl.className = "leader-gear-dock";
                }
                if (!leaderSideRailEl.innerHTML || needsRebuild) {
                    leaderSideRailEl.innerHTML = buildLeaderSideRailHtml();
                    leaderSideRailWired = false;
                }
                return leaderSideRailEl;
            };

            const handleLeaderSideRailAction = (btn) => {
                if (!btn) return;
                const isMode = btn.dataset.mode === "multi" || btn.dataset.mode === "scroll";
                const fromSettings = !!btn.closest(".leader-gear-menu");
                if (fromSettings) closeLeaderSideSettingsPanel();
                if (isMode) {
                    const m = btn.dataset.mode;
                    if (m !== displayMode) {
                        displayMode = m;
                        localStorage.setItem(DISPLAY_MODE_KEY, displayMode);
                        if (m === "scroll") lastLeaderFollowSongId = "";
                        render();
                    }
                    syncLeaderSideRailUI();
                    return;
                }
                delegateLeaderToolbarButton(btn);
                syncLeaderSideRailUI();
            };

            const wireLeaderSideRailOnce = () => {
                if (leaderSideRailWired || !leaderSideRailEl) return;
                leaderSideRailWired = true;
                leaderSideRailEl.addEventListener("click", (e) => {
                    const saveToggle = e.target.closest(".leader-save-fab");
                    if (saveToggle) {
                        e.preventDefault();
                        e.stopPropagation();
                        closeLeaderSideSettingsPanel();
                        openLeaderBackupModal();
                        showToolbar();
                        return;
                    }
                    const syncToggle = e.target.closest(".leader-data-sync-fab");
                    if (syncToggle) {
                        e.preventDefault();
                        e.stopPropagation();
                        closeLeaderSideSettingsPanel();
                        openLeaderQrPopup();
                        showToolbar();
                        return;
                    }
                    const settingsToggle = e.target.closest(".leader-gear-fab");
                    if (settingsToggle) {
                        e.preventDefault();
                        e.stopPropagation();
                        toggleLeaderSideSettingsPanel();
                        syncLeaderSideRailUI();
                        return;
                    }
                    if (e.target.closest(".leader-side-color-input")) return;
                    const btn = e.target.closest("button");
                    if (!btn || btn.classList.contains("leader-gear-fab") || btn.classList.contains("leader-data-sync-fab") || btn.classList.contains("leader-save-fab")) return;
                    e.preventDefault();
                    e.stopPropagation();
                    handleLeaderSideRailAction(btn);
                });
                const colorInp = leaderSideRailEl.querySelector(".leader-side-color-input");
                colorInp?.addEventListener("input", () => {
                    const hex = normalizeLeaderLyricHex(colorInp.value);
                    if (!hex) return;
                    persistLeaderLyricColorOverride(hex);
                    render();
                    syncLeaderSideRailUI();
                });
                colorInp?.addEventListener("click", (e) => e.stopPropagation());
            };

            function renderLeaderFlowView() {
                host.classList.toggle("leader-scroll-mode", false);
                host.classList.add("leader-has-bottom-rail");
                teardownLeaderScrollIO();
                const plSongsFlow = getLeaderPlaylistOrderedSongs();
                if (leaderBottomRailEl) leaderBottomRailEl.style.display = "flex";
                renderBottomRailChips(plSongsFlow);
                wireLeaderBottomRailOnce();
                const { pages, idx } = getPages();
                const color = getLeaderLyricColorForRender();
                const cards = getLeaderFlowCards();
                clampFlowCursor();
                const card = cards[flowCursor];
                let content = "";
                if (!cards.length) {
                    content = `<div class="leader-brush-mount leader-brush-mount--fit"><div class="leader-flow-empty"><p>尚无敬拜流程</p><p class="leader-flow-empty-hint">点「编排」根据段落自动生成，或使用快速模板</p><p class="leader-flow-empty-hint">当前页（传统翻页）：${idx + 1}/${Math.max(1, pages.length)}</p></div></div>`;
                } else if (card && (card.type === "lyrics" || card.type === "repeat")) {
                    const pi = clamp(
                        card.type === "lyrics" ? Number(card.pageIndex) || 0 : Number(card.targetPageIndex) || 0,
                        0,
                        Math.max(0, pages.length - 1)
                    );
                    const lines = pages[pi] || [];
                    content = `<div class="leader-brush-mount leader-brush-mount--fit"><div class="leader-current leader-multi" style="color:${color};font-size:${leaderFontSize};">${lines
                        .map((line, i) => {
                            const gi = globalIndex(pages, pi, i);
                            return `<div class="leader-line" data-line="${gi}">${escapeHtml(line)}${!noteEditMode && loadNote(gi) ? `<span class="leader-note-dot" data-line="${gi}" role="button" tabindex="0" aria-label="查看备注"></span>` : ""}${noteEditMode ? `<span class="leader-plus-dot" data-line="${gi}" title="添加备注" role="button" tabindex="0" aria-label="添加备注">⊕</span>` : ""}</div>`;
                        })
                        .join("") || "<div class='leader-line'>...</div>"}</div></div>`;
                } else if (card && card.type === "bridge") {
                    content = `<div class="leader-brush-mount leader-brush-mount--fit"><div class="leader-flow-stage"><div class="leader-flow-badge">${escapeHtml(card.label)}</div><div class="leader-flow-big" style="color:${color};">${escapeHtml(card.body || "（在编排中填写过渡语）")}</div></div></div>`;
                } else if (card && card.type === "speech") {
                    content = `<div class="leader-brush-mount leader-brush-mount--fit"><div class="leader-flow-stage"><div class="leader-flow-badge">${escapeHtml(card.label)}</div><div class="leader-flow-big" style="color:${color};">${escapeHtml(card.body || "")}</div><div class="leader-flow-stage-note">仅主领平板 · 会众屏保持上一页歌词</div></div></div>`;
                } else if (card && card.type === "free") {
                    content = `<div class="leader-brush-mount leader-brush-mount--fit"><div class="leader-flow-stage"><div class="leader-flow-badge">${escapeHtml(card.label)}</div><div class="leader-flow-stage-note">会众屏：经文 / 纯色背景</div><div class="leader-flow-hint">${escapeHtml(card.leaderHint || "")}</div></div></div>`;
                }
                let curPlIx = plSongsFlow.findIndex((s) => String(s.id) === String(liveState?.songId || state.currentSongId || ""));
                if (curPlIx < 0) curPlIx = 0;
                const topBar = buildLeaderTopBarHtml(
                    String(plSongsFlow[curPlIx]?.title || getLeaderHeaderTitle()).trim() || "当前诗歌",
                    `第 ${curPlIx + 1} 首 / 共 ${Math.max(1, plSongsFlow.length)} 首`
                );
                lyricLayer.innerHTML = `${topBar}<div class="leader-main">${content}</div>`;
                syncLeaderSideNav();
                ensureLeaderSideRail();
                wireLeaderSideRailOnce();
                syncLeaderSideRailUI();
                requestAnimationFrame(() => setupBrushCanvas());
                updateLeaderColorBtnSwatch();
            }

            /** 主歌/副歌等：行首标记行可加样式间距 */
            const isLeaderLyricSectionHeaderLine = (raw) => {
                const t = String(raw || "").trim();
                if (!t) return false;
                if (/^【[^】]{1,16}】/.test(t)) return true;
                if (/^\[[^\]]{1,22}\]\s*/i.test(t)) return true;
                if (/^(主歌|副歌|桥段|预副歌?|间奏|尾声|尾奏|齐唱|合唱)\s*$/i.test(t)) return true;
                if (/^(Verse|Chorus|Bridge|Pre-Chorus|Tag|Outro)(\s+\d+)?\s*$/i.test(t)) return true;
                return false;
            };

            const buildLeaderPlaylistSongBlocksHtml = (songs, color) => {
                return songs
                    .map((song, six) => {
                        const raw = String(song.lyrics ?? "").replace(/\r/g, "");
                        const rawLines = raw.split("\n");
                        const sidForNotes = String(song.id ?? six);
const linesHtml = rawLines
    .map((line, li) => {
        const disp = getLeaderFmtLine(line);
        const sec = isLeaderLyricSectionHeaderLine(line);
        const cls = sec ? " leader-pl-line--section" : "";
        if (!String(line).trim()) {
            return '<div class="leader-pl-line leader-pl-line--blank" aria-hidden="true"></div>';
        }
        const noteMarks =
            !noteEditMode && loadNote(li, sidForNotes)
                ? `<span class="leader-note-dot" data-line="${li}" data-song-id="${escapeAttr(sidForNotes)}" title="查看备注" role="button" tabindex="0" aria-label="查看备注"></span>`
                : noteEditMode
                  ? `<span class="leader-plus-dot" data-line="${li}" data-song-id="${escapeAttr(sidForNotes)}" title="添加备注" role="button" tabindex="0" aria-label="添加备注">⊕</span>`
                  : "";
        return `<div class="leader-pl-line${cls}" data-line="${li}">${escapeHtml(disp)}${noteMarks}</div>`;
    })
                            .join("");
                        const sidAttr = escapeHtml(String(song.id ?? six));
                        return `<section class="leader-song-block" id="leader-song-anchor-${six}" data-pl-ix="${six}" data-song-id="${sidAttr}"><div class="leader-song-divider" aria-hidden="true"></div><h2 class="leader-song-block-title">${escapeHtml(song.title || "未命名")}</h2><div class="leader-song-lyrics" style="color:${escapeHtml(color)}">${linesHtml || '<div class="leader-pl-line">…</div>'}</div></section>`;
                    })
                    .join("");
            };

            function render() {
                const keepOverlay = overlay && overlay.classList.contains("leader-note-pop-wrap");
                if (!keepOverlay) {
                    closeOverlay();
                    closeLeaderSideSettingsPanel();
                }
                if (displayMode === "flow") {
                    loadLeaderFlowSnapshot();
                    renderLeaderFlowView();
                    return;
                }
                const color = getLeaderLyricColorForRender();
                const plSongs = getLeaderPlaylistOrderedSongs();
                host.classList.add("leader-has-bottom-rail");
                if (leaderBottomRailEl) leaderBottomRailEl.style.display = "flex";
                renderBottomRailChips(plSongs);
                wireLeaderBottomRailOnce();

                if (displayMode === "scroll") {
                    host.classList.add("leader-scroll-mode");
                    lyricLayer.classList.add("leader-lyric-shell--playlist");
                    lyricLayer.classList.remove("leader-lyric-shell--multi");
                    const curSid = String(liveState?.songId || state.currentSongId || "");
                    let syncIx = plSongs.findIndex((s) => String(s.id) === curSid);
                    if (syncIx < 0) syncIx = clamp(state.playlist?.activeIndex ?? 0, 0, Math.max(0, plSongs.length - 1));
                    let snapToSong = false;
                    if (curSid && curSid !== lastLeaderFollowSongId) {
                        lastLeaderFollowSongId = curSid;
                        leaderBrowseIx = clamp(syncIx, 0, Math.max(0, plSongs.length - 1));
                        snapToSong = true;
                    } else {
                        leaderBrowseIx = clamp(leaderBrowseIx, 0, Math.max(0, plSongs.length - 1));
                    }
                    const topLeft = String(plSongs[leaderBrowseIx]?.title || getLeaderHeaderTitle()).trim() || "当前诗歌";
                    const topBar = buildLeaderTopBarHtml(
                        topLeft,
                        `第 ${leaderBrowseIx + 1} 首 / 共 ${Math.max(1, plSongs.length)} 首`
                    );
                    const blocks =
                        plSongs.length > 0
                            ? buildLeaderPlaylistSongBlocksHtml(plSongs, color)
                            : `<section class="leader-song-block" id="leader-song-anchor-0" data-pl-ix="0"><div class="leader-song-divider" aria-hidden="true"></div><h2 class="leader-song-block-title">（暂无诗歌）</h2><div class="leader-song-lyrics" style="color:${escapeHtml(color)}"><div class="leader-pl-line">请使用「诗歌」导入或等待主控台同步</div></div></section>`;
                    const playlistMain = `<div class="leader-playlist-layout"><div class="leader-playlist-scroll-root"><div class="leader-brush-mount leader-brush-mount--scroll">${blocks}</div></div></div>`;
                    leaderLastPlaylistSig = leaderPlaylistSignature(plSongs);
                    lyricLayer.innerHTML = `${topBar}<div class="leader-main leader-main-scroll leader-main--playlist">${playlistMain}</div>`;
                    const rawFsMul = parseFloat(leaderFontSize);
                    lyricLayer.style.setProperty(
                        "--leader-song-fs-mul",
                        String(Number.isFinite(rawFsMul) ? clamp(rawFsMul / 5, 0.72, 1.45) : 1)
                    );
                    requestAnimationFrame(() => {
                        const root = lyricLayer.querySelector(".leader-playlist-scroll-root");
                        bindLeaderScrollObserver(root, plSongs.length);
                        if (leaderPendingScrollIx != null) {
                            scrollLeaderToPlaylistIndex(leaderPendingScrollIx, "smooth");
                            leaderBrowseIx = leaderPendingScrollIx;
                            leaderPendingScrollIx = null;
                        } else if (snapToSong) {
                            scrollLeaderToPlaylistIndex(leaderBrowseIx, "instant");
                        }
                        updateLeaderTopBarReadout();
                        updateBottomRailHighlight();
                    });
                } else {
                    host.classList.remove("leader-scroll-mode");
                    lyricLayer.classList.remove("leader-lyric-shell--playlist");
                    lyricLayer.classList.add("leader-lyric-shell--multi");
                    teardownLeaderScrollIO();
                    const { pages, idx } = getPages();
                    const lines = pages[idx] || [];
                    const nextLine = pages[idx + 1]?.[0] || "（无）";
                    const curSid = String(liveState?.songId || state.currentSongId || "");
                    let syncIx = plSongs.findIndex((s) => String(s.id) === curSid);
                    if (syncIx < 0) syncIx = 0;
                    leaderBrowseIx = syncIx;
                    const topBar = buildLeaderTopBarHtml(
                        getLeaderHeaderTitle(),
                        `第 ${idx + 1} 页 / 共 ${Math.max(1, pages.length)} 页`
                    );
                    const pageHtml = lines
                        .map((line, i) => {
                            const gi = globalIndex(pages, idx, i);
                            return `<div class="leader-line" data-line="${gi}">${escapeHtml(line)}${!noteEditMode && loadNote(gi) ? `<span class="leader-note-dot" data-line="${gi}" role="button" tabindex="0" aria-label="查看备注"></span>` : ""}${noteEditMode ? `<span class="leader-plus-dot" data-line="${gi}" title="添加备注" role="button" tabindex="0" aria-label="添加备注">⊕</span>` : ""}</div>`;
                        })
                        .join("") || "<div class='leader-line'>...</div>";
                    const content = `<div class="leader-brush-mount leader-brush-mount--fit"><div class="leader-current leader-multi" style="color:${escapeHtml(color)};font-size:${leaderFontSize};">${pageHtml}</div></div>`;
                    const nextHtml = `<div class="leader-next">下句：${escapeHtml(nextLine)}</div>`;
                    lyricLayer.innerHTML = `${topBar}<div class="leader-main leader-main--page">${content}${nextHtml}</div>`;
                    lyricLayer.style.removeProperty("--leader-song-fs-mul");
                }
                syncLeaderSideNav();
                ensureLeaderSideRail();
                wireLeaderSideRailOnce();
                syncLeaderSideRailUI();
                requestAnimationFrame(() => setupBrushCanvas());
                updateLeaderColorBtnSwatch();
                syncNoteEditBanner();
            }

            const openLeaderLyricEditor = () => {
                hideBgPanel();
                hideFontPanel();
                hideColorPanel();
                closeOverlay();
                ensureLeaderLiveState();
                const sid = getLeaderActiveSongId();
                const song = sid ? state.songs.find((s) => s && String(s.id) === String(sid)) : null;
                if (!song) {
                    showToast("未找到当前诗歌，请先导入诗歌包或切换歌单", leaderToastAnchor());
                    return;
                }
                overlay = document.createElement("div");
                overlay.className = "leader-note-pop-wrap";
                overlay.innerHTML = `<div class="leader-note-pop leader-lyric-editor-pop" style="max-width:min(94vw,560px);text-align:left;">
                    <div style="font-weight:700;margin-bottom:8px;">编辑歌词 · ${escapeHtml(song.title || "未命名")}</div>
                    <p style="font-size:12px;color:rgba(220,220,220,0.78);margin:0 0 8px;line-height:1.45;">保存后写入<b>本机</b>曲库并仅更新主领画面。段落之间用<b>空行</b>分段（与主控台一致）；主领「滚动」下可在行首写 <b>【主歌】</b>、<b>【副歌】</b> 等标记，会在该处留出主歌/副歌式的大空隙。另可用空行分段留出中等空隙。<b>不会</b>直接改动会众投屏；投屏仍由主控台点「应用到演示屏」更新。</p>
                    <textarea class="leader-lyric-editor-ta" rows="14" style="width:100%;box-sizing:border-box;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:#12151f;color:#eee;padding:10px;font-size:max(16px,14px);line-height:1.45;"></textarea>
                    <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end;flex-wrap:wrap;">
                        <button type="button" class="leader-note-btn secondary" data-ly-edit-cancel>取消</button>
                        <button type="button" class="leader-note-btn" data-ly-edit-save>保存</button>
                    </div></div>`;
                document.body.appendChild(overlay);
                const ta = overlay.querySelector(".leader-lyric-editor-ta");
                ta.value = String(song.lyrics ?? "");
                const shut = () => closeOverlay();
                overlay.querySelector("[data-ly-edit-cancel]")?.addEventListener("click", shut);
                overlay.addEventListener("click", (e) => {
                    if (e.target === overlay) shut();
                });
                overlay.querySelector("[data-ly-edit-save]")?.addEventListener("click", () => {
                    const text = normalizePastedLyricsText(ta.value);
                    song.lyrics = text;
                    try {
                        saveSongs();
                    } catch (err) {
                        showToast("保存失败：" + (err && err.message ? err.message : String(err)), overlay.querySelector("[data-ly-edit-save]"));
                        return;
                    }
                    try {
                        liveState = buildLeaderLocalLiveState(sid) || liveState;
                    } catch (_e) {
                        /* ignore */
                    }
                    render();
                    shut();
                    showToast("歌词已保存（仅本机主领）", leaderToastAnchor());
                });
            };

            const openLeaderSongPackImportUI = () => {
                hideBgPanel();
                hideFontPanel();
                hideColorPanel();
                closeOverlay();
                overlay = document.createElement("div");
                overlay.className = "leader-note-pop-wrap";
                overlay.setAttribute("data-pack-import", "1");
                overlay.innerHTML = `<div class="leader-note-pop leader-pack-import-pop" style="max-width:min(92vw,480px);text-align:left;">
                    <div style="font-weight:700;margin-bottom:8px;">导入诗歌包</div>
                    <p style="font-size:13px;color:rgba(230,230,230,0.78);margin:0 0 10px;line-height:1.45;">方式一：粘贴以 <b>W1</b> / <b>W0</b> 开头的整段包文本（与电脑「传数据」生成的一致，可含主领偏好字段）。方式二：粘贴手机/平板扫描后浏览器地址栏里的<b>完整链接</b>（须含 <code>#wp1=</code> 或 <code>?data=</code>）。</p>
                    <label style="font-size:12px;color:rgba(200,200,200,0.9);display:block;margin-bottom:4px;">包文本</label>
                    <textarea id="leader-pack-import-ta" rows="5" style="width:100%;box-sizing:border-box;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:#12151f;color:#eee;padding:8px;font-size:13px;" placeholder="W1..."></textarea>
                    <label style="font-size:12px;color:rgba(200,200,200,0.9);display:block;margin:12px 0 4px;">或 完整链接（可选）</label>
                    <input type="text" id="leader-pack-import-url" autocomplete="off" style="width:100%;box-sizing:border-box;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:#12151f;color:#eee;padding:8px;font-size:13px;" placeholder="http://192.168.x.x/.../index.html?leader=1#wp1=...">
                    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;justify-content:flex-end;">
                        <button type="button" class="leader-note-btn secondary" data-pack-cancel>关闭</button>
                        <button type="button" class="leader-note-btn secondary" data-pack-clip>读剪贴板到包文本</button>
                        <button type="button" class="leader-note-btn secondary" data-pack-from-url>从链接载入</button>
                        <button type="button" class="leader-note-btn" data-pack-go>导入包文本</button>
                    </div></div>`;
                document.body.appendChild(overlay);
                const ta = overlay.querySelector("#leader-pack-import-ta");
                const urlIn = overlay.querySelector("#leader-pack-import-url");
                const shut = () => {
                    closeOverlay();
                };
                const extractWp1FromUrlString = (rawU) => {
                    const s = String(rawU || "").trim();
                    if (!s) return "";
                    try {
                        const u = new URL(/^https?:/i.test(s) ? s : "http://" + s, location.href);
                        const h = (u.hash || "").replace(/^#/, "");
                        if (!h.startsWith("wp1=")) return "";
                        let p = h.slice(4);
                        try {
                            p = decodeURIComponent(p);
                        } catch (_e) {
                            /* keep */
                        }
                        return p;
                    } catch (_e2) {
                        return "";
                    }
                };
                const tryImportPackString = async (rawPack, anchorEl) => {
                    const s = String(rawPack || "").trim();
                    if (!s) {
                        showToast("内容为空", anchorEl);
                        return false;
                    }
                    let payload = s;
                    if (/^https?:\/\//i.test(s) || s.includes("#wp1=") || s.includes("wp1%3D")) {
                        payload = extractWp1FromUrlString(s);
                        if (!payload) {
                            showToast("链接中未找到 #wp1= 诗歌数据", anchorEl);
                            return false;
                        }
                    }
                    const data = await decodeWorshipPackFromRawString(payload);
                    applyWorshipSongPackFromObject(data, anchorEl);
                    return true;
                };
                overlay.querySelector("[data-pack-cancel]")?.addEventListener("click", shut);
                overlay.addEventListener("click", (e) => {
                    if (e.target === overlay) shut();
                });
                overlay.querySelector("[data-pack-clip]")?.addEventListener("click", async (e) => {
                    try {
                        const t = await navigator.clipboard.readText();
                        if (!t) return;
                        const v = String(t).trim();
                        if (ta && v) ta.value = v;
                        if (urlIn && (/^https?:/i.test(v) || v.includes("#wp1="))) urlIn.value = v;
                    } catch (_e) {
                        showToast("无法读取剪贴板，请长按输入框手动粘贴", e.currentTarget);
                    }
                });
                overlay.querySelector("[data-pack-from-url]")?.addEventListener("click", async (e) => {
                    const rawU = String(urlIn?.value || "").trim();
                    if (!rawU) {
                        showToast("请先在「完整链接」框粘贴传数据后的网址", e.currentTarget);
                        return;
                    }
                    try {
                        if (await tryImportPackString(rawU, e.currentTarget)) shut();
                    } catch (err) {
                        showToast("导入失败：" + (err.message || String(err)), e.currentTarget);
                    }
                });
                overlay.querySelector("[data-pack-go]")?.addEventListener("click", async (e) => {
                    const raw = String(ta?.value || "").trim();
                    if (!raw) {
                        showToast("请粘贴包文本，或使用下方「从链接载入」", e.currentTarget);
                        return;
                    }
                    try {
                        if (await tryImportPackString(raw, e.currentTarget)) shut();
                    } catch (err) {
                        showToast("导入失败：" + (err.message || String(err)), e.currentTarget);
                    }
                });
            };

            const openLeaderPlaylistSheet = () => {
                hideBgPanel();
                hideFontPanel();
                hideColorPanel();
                closeOverlay();
                const ids = Array.isArray(state.playlist.items) ? state.playlist.items : [];
                if (!ids.length) {
                    showToast("播放列表为空。请先在主控台加入诗歌，或在本机「诗歌」导入包。", leaderToastAnchor());
                    return;
                }
                overlay = document.createElement("div");
                overlay.className = "leader-note-pop-wrap";
                const rows = ids
                    .map((id, ix) => {
                        const song = state.songs.find((s) => s && String(s.id) === String(id));
                        const title = escapeHtml(song?.title || id || "未命名");
                        const cur = String(id) === String(state.currentSongId);
                        return `<button type="button" class="leader-playlist-row${cur ? " is-current" : ""}" data-pl-ix="${ix}"><span class="leader-playlist-ix">${ix + 1}</span><span class="leader-playlist-title">${title}</span>${cur ? '<span class="leader-playlist-badge">当前</span>' : ""}</button>`;
                    })
                    .join("");
                overlay.innerHTML = `<div class="leader-note-pop leader-playlist-pop" style="max-width:min(92vw,420px);text-align:left;">
                    <div style="font-weight:700;margin-bottom:8px;">播放列表 · 切歌</div>
                    <p style="font-size:12px;color:rgba(220,220,220,0.75);margin:0 0 10px;line-height:1.45;">点选诗歌即可切换（与主控台播放列表一致）。若已打开主控台，会同步到电脑端。</p>
                    <div class="leader-playlist-list" style="max-height:min(52vh,360px);overflow-y:auto;">${rows}</div>
                    <div style="display:flex;justify-content:flex-end;margin-top:10px;"><button type="button" class="leader-note-btn secondary" data-pl-close>关闭</button></div>
                </div>`;
                document.body.appendChild(overlay);
                const shut = () => closeOverlay();
                overlay.querySelector("[data-pl-close]")?.addEventListener("click", shut);
                overlay.addEventListener("click", (e) => {
                    if (e.target === overlay) shut();
                });
                overlay.querySelector(".leader-playlist-list")?.addEventListener("click", (e) => {
                    const row = e.target.closest("[data-pl-ix]");
                    if (!row) return;
                    const ix = clamp(parseInt(row.getAttribute("data-pl-ix") || "0", 10) || 0, 0, ids.length - 1);
                    shut();
                    jumpLeaderToPlaylistIndex(ix);
                });
            };

            const flip = (delta) => navigateLeaderFlow(delta);

            let leaderLyricNotePtrDown = null;
            let leaderLyricNoteSuppressClick = false;

            const handleLeaderLyricNoteTarget = (hitEl, ev) => {
                if (!hitEl || !(hitEl instanceof Element)) return false;
                if (brushMode) return false;
                const plus = hitEl.closest(".leader-plus-dot");
                if (plus) {
                    ev?.preventDefault?.();
                    ev?.stopPropagation?.();
                    openNote(
                        Number(plus.getAttribute("data-line")) || 0,
                        false,
                        plus,
                        resolveLeaderNoteSongId(plus, plus.getAttribute("data-song-id"))
                    );
                    return true;
                }
                const dot = hitEl.closest(".leader-note-dot");
                if (dot) {
                    ev?.preventDefault?.();
                    ev?.stopPropagation?.();
                    openNote(
                        Number(dot.getAttribute("data-line")) || 0,
                        true,
                        dot,
                        resolveLeaderNoteSongId(dot, dot.getAttribute("data-song-id"))
                    );
                    return true;
                }
                if (noteEditMode && (displayMode === "scroll" || displayMode === "multi" || displayMode === "flow")) {
                    const line = hitEl.closest(".leader-pl-line:not(.leader-pl-line--blank), .leader-line");
                    if (line && !hitEl.closest(".leader-plus-dot,.leader-note-dot")) {
                        ev?.preventDefault?.();
                        ev?.stopPropagation?.();
                        const li = parseInt(line.getAttribute("data-line") || "0", 10) || 0;
                        openNote(li, false, line, resolveLeaderNoteSongId(line, line.getAttribute("data-song-id")));
                        return true;
                    }
                }
                return false;
            };

            lyricLayer.addEventListener(
                "pointerdown",
                (e) => {
                    if (brushMode || e.pointerType === "mouse") return;
                    leaderLyricNotePtrDown = {
                        id: e.pointerId,
                        x: e.clientX,
                        y: e.clientY
                    };
                },
                { passive: true }
            );
            lyricLayer.addEventListener(
                "pointerup",
                (e) => {
                    if (brushMode || !leaderLyricNotePtrDown || e.pointerId !== leaderLyricNotePtrDown.id) return;
                    const dx = e.clientX - leaderLyricNotePtrDown.x;
                    const dy = e.clientY - leaderLyricNotePtrDown.y;
                    leaderLyricNotePtrDown = null;
                    if (dx * dx + dy * dy > 28 * 28) return;
                    const hit =
                        document.elementFromPoint(e.clientX, e.clientY) ||
                        (e.target instanceof Element ? e.target : null);
                    if (!hit || !lyricLayer.contains(hit)) return;
                    if (handleLeaderLyricNoteTarget(hit, e)) {
                        leaderLyricNoteSuppressClick = true;
                        window.setTimeout(() => {
                            leaderLyricNoteSuppressClick = false;
                        }, 480);
                    }
                },
                { passive: false }
            );
            lyricLayer.addEventListener(
                "touchend",
                (e) => {
                    if (brushMode) return;
                    const t = e.changedTouches?.[0];
                    if (!t) return;
                    let hit = e.target instanceof Element ? e.target : null;
                    if (!hit || !lyricLayer.contains(hit)) {
                        hit = document.elementFromPoint(t.clientX, t.clientY);
                    }
                    if (!hit || !lyricLayer.contains(hit)) return;
                    if (handleLeaderLyricNoteTarget(hit, e)) {
                        e.preventDefault();
                        leaderLyricNoteSuppressClick = true;
                        window.setTimeout(() => {
                            leaderLyricNoteSuppressClick = false;
                        }, 480);
                    }
                },
                { capture: true, passive: false }
            );
            lyricLayer.addEventListener("click", (e) => {
                if (leaderLyricNoteSuppressClick) {
                    leaderLyricNoteSuppressClick = false;
                    return;
                }
                handleLeaderLyricNoteTarget(e.target, e);
            });
            toolbar.addEventListener("click", (e) => {
                const btn = e.target.closest("button");
                if (!btn) return;
                delegateLeaderToolbarButton(btn);
            });
            toolbarRail.addEventListener("click", (e) => {
                if (host.classList.contains("leader-minimal-chrome")) return;
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
                if (!host.classList.contains("leader-minimal-chrome") && toolbarCollapsed && !brushMode) setToolbarCollapsed(false);
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
                if (displayMode !== "scroll" && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) flip(dx < 0 ? 1 : -1);
                if (!host.classList.contains("leader-minimal-chrome") && toolbarCollapsed && swipeFromBottomY != null && y < swipeFromBottomY - leaderBottomSwipeMinDy()) setToolbarCollapsed(false);
                swipeFromBottomY = null;
                showToolbar();
            }, { passive: true });
            host.addEventListener("dblclick", (e) => {
                if (!brushMode) return;
                if (e.target?.closest?.(".leader-brush-panel")) return;
                setBrushMode(false);
            });
            document.addEventListener("keydown", (e) => {
                if (e.key === "Escape" && flowEditorWrap) {
                    closeFlowEditor();
                    showToolbar();
                    return;
                }
                if (!brushMode && displayMode !== "scroll" && e.key === "ArrowLeft") flip(-1);
                if (!brushMode && displayMode !== "scroll" && e.key === "ArrowRight") flip(1);
                if (brushMode && e.key === "Escape") setBrushMode(false);
                if (e.key === "Escape") {
                    if (overlay?.classList?.contains("leader-note-pop-wrap")) {
                        closeOverlay();
                        showToolbar();
                        return;
                    }
                    if (noteEditMode) {
                        exitNoteEditMode();
                        showToolbar();
                        return;
                    }
                    closeOverlay();
                }
                showToolbar();
            });
            document.addEventListener("mousemove", () => {
                if (!host.classList.contains("leader-minimal-chrome") && toolbarCollapsed && !brushMode) {
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
                if (!host.classList.contains("leader-minimal-chrome") && toolbarCollapsed && e.clientY < mouseBottomStartY - leaderBottomSwipeMinDy()) setToolbarCollapsed(false);
                mouseBottomStartY = null;
            });
            document.addEventListener("click", (e) => {
                if (overlay && e.target === overlay && overlay.classList.contains("leader-note-pop-wrap")) {
                    closeOverlay();
                } else if (overlay && e.target === overlay) {
                    closeOverlay();
                }
                if (fontPanel && fontPanel.style.display !== "none") {
                    const inFont = e.target?.closest?.(".leader-font-pop");
                    const inAa =
                        e.target?.closest?.('[data-action="font-panel"]') || e.target?.closest?.(".leader-gear-dock");
                    if (!inFont && !inAa) hideFontPanel();
                }
                if (colorPanel && colorPanel.style.display !== "none") {
                    const inColor = e.target?.closest?.(".leader-color-pop");
                    const inColorBtn =
                        e.target?.closest?.('[data-action="color-panel"]') || e.target?.closest?.(".leader-gear-dock");
                    if (!inColor && !inColorBtn) hideColorPanel();
                }
                if (bgPanel && bgPanel.style.display !== "none") {
                    const inBgPanel = e.target?.closest?.(".leader-bg-panel");
                    const inBgBtn =
                        e.target?.closest?.('[data-action="bg-panel"]') || e.target?.closest?.(".leader-gear-dock");
                    if (!inBgPanel && !inBgBtn) hideBgPanel();
                }
                if (flowCtxMenuEl && !e.target?.closest?.(".leader-flow-ctx-menu")) hideFlowCtxMenu();
                if (toolbarCollapsed && !host.classList.contains("leader-minimal-chrome")) {
                    const inToolbar = e.target?.closest?.(".leader-toolbar");
                    const inFab = e.target?.closest?.(".leader-expand-fab");
                    const inRail = e.target?.closest?.(".leader-bottom-rail");
                    const inLeaderModal =
                        e.target?.closest?.("#leader-help-modal") ||
                        e.target?.closest?.("#leader-step-guide-overlay") ||
                        e.target?.closest?.("#leader-qr-popup") ||
                        e.target?.closest?.("#leader-backup-modal") ||
                        e.target?.closest?.(".leader-note-pop-wrap");
                    if (!inToolbar && !inFab && !inLeaderModal && !inRail) setToolbarCollapsed(false);
                }
                showToolbar();
            });

            if (channel) {
                channel.onmessage = (e) => {
                    const d = e.data;
                    if (d?.type === "main_projection_end" && d.source === "main") return;
                    if (d?.type === "update" && d.payload?.pages) {
                        if (!applyLeaderLiveUpdateFromPayload(d.payload)) render();
                    }
                };
                channel.postMessage({ type: "request_state", source: "leader" });
            }
            window.addEventListener("storage", (e) => {
                if (e.key === STORAGE.LIVE && e.newValue) {
                    const payload = parseJSON(e.newValue, null);
                    if (payload?.pages) {
                        if (!applyLeaderLiveUpdateFromPayload(payload)) render();
                    }
                }
            });
            window.addEventListener("resize", () => {
                syncLeaderHandheldChrome();
                applyBg();
                render();
                updateBrushPanelPosition();
                positionFontPanel();
                positionColorPanel();
                if (bgPanel?.style.display === "block") showBgPanel();
            });

            const initState = getStore(STORAGE.LIVE, null);
            if (initState?.pages) liveState = initState;
            else ensureLeaderLiveState();
            syncLeaderHandheldChrome();
            ensureBrushHud();
            ensureLeaderSideRail();
            wireLeaderSideRailOnce();
            applyBg();
            render();
            setToolbarCollapsed(toolbarCollapsed);
            updateBrushIndicator();
            showToolbar();
            try {
                globalThis.__worshipLeaderShowToolbar = showToolbar;
            } catch (_e) {
                /* ignore */
            }
            globalThis.__worshipLeaderApplyLive = function () {
                try {
                    const ls = globalThis.liveState;
                    if (ls && typeof ls === "object") {
                        liveState = ls;
                        globalThis.worshipLiveState = liveState;
                    }
                    render();
                } catch (_e2) {
                    /* ignore */
                }
            };
            try {
                if (localStorage.getItem(LEADER_ONBOARDING_LS) !== "1") {
                    queueMicrotask(() => openLeaderGuideModal(0, { firstVisit: true }));
                }
            } catch (_e) {
                /* ignore */
            }
            globalThis.__leaderReloadAfterPackImport = (meta) => {
                try {
                    if (meta && meta.total > 1) {
                        updateLeaderScanPageHint({
                            page: meta.page,
                            total: meta.total,
                            show: !!meta.pagedIncomplete
                        });
                    }
                    displayMode = localStorage.getItem(DISPLAY_MODE_KEY) || "scroll";
                    if (displayMode === "single") displayMode = "scroll";
                    if (!["multi", "scroll", "flow"].includes(displayMode)) displayMode = "scroll";
                    bgMode = localStorage.getItem(BG_MODE_KEY) || "particles";
                    if (!["black", "white", "gray", "navy", "particles", "custom"].includes(bgMode)) bgMode = "particles";
                    try {
                        leaderBgCustomDataUrl = String(localStorage.getItem(LEADER_BG_CUSTOM_IMAGE_LS) || "");
                    } catch (_e0) {
                        leaderBgCustomDataUrl = "";
                    }
                    if (bgMode === "custom" && !leaderBgCustomDataUrl) {
                        bgMode = "particles";
                        try {
                            localStorage.setItem(BG_MODE_KEY, bgMode);
                        } catch (_e1) {
                            /* ignore */
                        }
                    }
                    toolbarCollapsed = localStorage.getItem(TOOLBAR_COLLAPSED_KEY) === "1";
                    if (localStorage.getItem(TOOLBAR_COLLAPSED_KEY) === null && window.innerWidth < 480) toolbarCollapsed = true;
                    setToolbarCollapsed(toolbarCollapsed);
                    leaderFontSize = localStorage.getItem(FONT_SIZE_KEY) || "5vw";
                    const parsedLf = parseFloat(leaderFontSize);
                    if (!Number.isFinite(parsedLf) || parsedLf < 3 || parsedLf > 8) leaderFontSize = "5vw";
                    const cr = localStorage.getItem(LEADER_LYRIC_COLOR_LS_KEY);
                    leaderLyricColorOverride = normalizeLeaderLyricHex(cr);
                    if (cr && !leaderLyricColorOverride) {
                        try {
                            localStorage.removeItem(LEADER_LYRIC_COLOR_LS_KEY);
                        } catch (_e2) {
                            /* ignore */
                        }
                    }
                    const nm = migrateLeaderNotes(getStore(NOTES_KEY, {}));
                    notesMap = nm;
                    try {
                        setStore(NOTES_KEY, notesMap);
                    } catch (_e3) {
                        /* ignore */
                    }
                    loadLeaderFlowSnapshot();
                    applyBg();
                    hideFontPanel();
                    hideColorPanel();
                    const rangeEl = fontPanel?.querySelector(".leader-font-range");
                    if (rangeEl) {
                        const parsed = parseFloat(leaderFontSize);
                        if (Number.isFinite(parsed)) rangeEl.value = String(parsed);
                    }
                    render();
                    updateBrushPanelPosition();
                    positionFontPanel();
                    positionColorPanel();
                    updateLeaderColorBtnSwatch();
                    persistLeaderLocalSnapshot();
                } catch (_e) {
                    /* ignore */
                }
            };

            document.addEventListener("visibilitychange", () => {
                if (document.visibilityState === "hidden") persistLeaderLocalSnapshot();
            });
            if (!leaderUrlDataParam && tryRestoreLeaderLocalSnapshot()) {
                globalThis.__leaderReloadAfterPackImport?.();
            }
            const consumeLeaderWp1HashFromLocation = async () => {
                if (leaderWp1PackImportLock) return;
                const rawHash = location.hash.replace(/^#/, "");
                if (!rawHash.startsWith("wp1=")) return;
                leaderWp1PackImportLock = true;
                let packStr = rawHash.slice(4);
                try {
                    packStr = decodeURIComponent(packStr);
                } catch (_e) {
                    /* keep raw */
                }
                const anchor = toolbar.querySelector('[data-action="import-pack"]');
                try {
                    const data = await decodeWorshipPackFromRawString(packStr);
                    applyWorshipSongPackFromObject(data, anchor);
                    try {
                        history.replaceState(null, "", location.pathname + location.search);
                    } catch (_e2) {
                        /* ignore */
                    }
                } catch (err) {
                    try {
                        showToast("链接内诗歌无效：" + (err.message || String(err)), anchor);
                    } catch (_e3) {
                        /* ignore */
                    }
                } finally {
                    leaderWp1PackImportLock = false;
                }
            };

            void consumeLeaderWp1HashFromLocation();
            window.addEventListener("hashchange", () => {
                void consumeLeaderWp1HashFromLocation();
            });
            window.addEventListener("pageshow", (ev) => {
                if (ev.persisted) void consumeLeaderWp1HashFromLocation();
            });

            return;
        }
        try {
            globalThis.__worshipAppInitLeaderView = initLeaderView;
        } catch (_eAssign) {
            /* ignore */
        }
    }

    function changePage(delta) {
        projectionDisplayOverlay = null;
        const pages = splitPages(getStablePagingLyricsForPageSplit(), state.ui.defaultLines);
        const maxIdx = Math.max(0, pages.length - 1);
        state.currentPage = clamp(state.currentPage, 0, maxIdx);
        const cur = state.currentPage;
        const d = Number(delta);
        if (!Number.isFinite(d) || d === 0) return;

        if (d < 0) {
            if (cur > 0) {
                state.currentPage = cur + d;
                updateAll({ linesOnly: isMainVideoBackground() });
                notifyProjectionConsoleReadyForGuide();
            } else {
                const items = state.playlist.items || [];
                const base = items.indexOf(state.currentSongId);
                if (base <= 0) return;
                const prevIdx = base - 1;
                if (
                    switchToPlaylistSong(
                        prevIdx,
                        !!(state.playlist.running && state.playlist.autoSwitch),
                        "last"
                    )
                ) {
                    notifyProjectionConsoleReadyForGuide();
                }
            }
        } else if (cur >= maxIdx) {
            const items = state.playlist.items || [];
            const songIdx = items.indexOf(state.currentSongId);
            const base = songIdx >= 0 ? songIdx : clamp(state.playlist.activeIndex, 0, Math.max(0, items.length - 1));
            const nextIdx = base + 1;
            /** 当前曲在歌单内时：最后一页「下一页」直接进下一首，不必先点「开始播放列表」；否则仍按「连播已开始」逻辑 */
            const canNextSong =
                nextIdx < items.length && (state.playlist.running || songIdx >= 0);
            if (canNextSong) {
                if (
                    switchToPlaylistSong(
                        nextIdx,
                        !!(state.playlist.running && state.playlist.autoSwitch)
                    )
                ) {
                    notifyProjectionConsoleReadyForGuide();
                }
            } else {
                updateAll({ linesOnly: isMainVideoBackground() });
            }
        } else {
            state.currentPage = Math.min(cur + d, maxIdx);
            updateAll({ linesOnly: isMainVideoBackground() });
            notifyProjectionConsoleReadyForGuide();
        }
        /** 勿重复 broadcastState / refreshMonitorContent：updateAll 与 switchToPlaylistSong 已广播；
         * 连播会破坏监视窗转场（flushMonitorLyricTrans 取消离场动画）。 */
    }

    function prevPage() {
        changePage(-1);
    }

    function nextPage() {
        changePage(1);
    }

    function jumpToPage(pageIndex) {
        projectionDisplayOverlay = null;
        const pages = splitPages(getStablePagingLyricsForPageSplit(), state.ui.defaultLines);
        state.currentPage = clamp(Number(pageIndex) || 0, 0, Math.max(0, pages.length - 1));
        updateAll({ linesOnly: isMainVideoBackground() });
    }

    /** 覆盖 state.js 里仅维护 AppState 的占位实现，供 UI 自动播放等调用 */
    globalThis.changePage = changePage;
    globalThis.prevPage = prevPage;
    globalThis.nextPage = nextPage;
    globalThis.jumpToPage = jumpToPage;

    function handleControlMessage(msg) {
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "leader_overlay") {
            suppressProjectionConsoleNotify = true;
            if (msg.action === "clear") {
                projectionDisplayOverlay = null;
            } else if (msg.action === "verse") {
                const lines = Array.isArray(msg.lines) ? msg.lines : [];
                projectionDisplayOverlay = {
                    kind: "verse",
                    lines: lines.length ? lines : [msg.text || "你们要赞美耶和华！"],
                    bgType: msg.bgType || "solid-black"
                };
            }
            broadcastState();
            suppressProjectionConsoleNotify = false;
            return;
        }
        if (msg.type === "leader_flow_save" && msg.flow && typeof msg.flow === "object") {
            suppressProjectionConsoleNotify = true;
            const sid = String(msg.songId || "");
            const song = (sid && state.songs.find((s) => s.id === sid)) || currentSong();
            if (song) {
                song.leaderWorshipFlow = msg.flow;
                saveSongs();
            }
            broadcastState();
            suppressProjectionConsoleNotify = false;
            return;
        }
        if (msg.type === "leader_select_song") {
            suppressProjectionConsoleNotify = true;
            const n = state.playlist.items.length;
            if (n > 0) {
                const ix = clamp(Math.floor(Number(msg.index) || 0), 0, n - 1);
                switchToPlaylistSong(ix, false, "first");
            }
            suppressProjectionConsoleNotify = false;
            return;
        }
        if (msg.type === "leader_lyrics_save" && typeof msg.lyrics === "string") {
            suppressProjectionConsoleNotify = true;
            const sid = String(msg.songId || "");
            const song = sid ? state.songs.find((s) => s && String(s.id) === String(sid)) : null;
            if (song) {
                song.lyrics = msg.lyrics;
                saveSongs();
                const cur = currentSong();
                if (cur && String(cur.id) === String(song.id)) {
                    setLyricEditorValueProgrammatically(msg.lyrics);
                }
            }
            broadcastState();
            try {
                renderPageGallery();
            } catch (_e) {
                /* ignore */
            }
            suppressProjectionConsoleNotify = false;
            return;
        }
        if (msg.type === "flip") {
            suppressProjectionConsoleNotify = true;
            changePage(Number(msg.delta) || 0);
            suppressProjectionConsoleNotify = false;
            return;
        }
        if (msg.type === "goto") {
            suppressProjectionConsoleNotify = true;
            jumpToPage(Number(msg.page));
            suppressProjectionConsoleNotify = false;
            return;
        }
    }

    function welcomeTodayKey() {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
    }

    function welcomeToastDismissedToday() {
        try {
            return sessionStorage.getItem(WELCOME_DISMISS_SESSION_KEY) === welcomeTodayKey();
        } catch (_) {
            return false;
        }
    }

    function dismissWelcomeToast(overlayEl, options) {
        const o = options && typeof options === "object" ? options : {};
        const remember = !!o.remember;
        if (welcomeToastTimer) {
            clearTimeout(welcomeToastTimer);
            welcomeToastTimer = 0;
        }
        if (!overlayEl || !overlayEl.parentNode) return;
        if (remember) {
            try {
                sessionStorage.setItem(WELCOME_DISMISS_SESSION_KEY, welcomeTodayKey());
            } catch (_) {}
        }
        const box = overlayEl.querySelector(".welcome-toast-box");
        const fadeTarget = box || overlayEl;
        fadeTarget.style.transition = "opacity 0.3s ease";
        fadeTarget.style.opacity = "0";
        window.setTimeout(() => {
            overlayEl.remove();
        }, 300);
    }

    function maybeShowWelcomeToast() {
        if (isDisplay || isLeader) return;
        if (welcomeToastDismissedToday()) return;
        const wrap = document.createElement("div");
        wrap.className = "welcome-toast-overlay";
        const box = document.createElement("div");
        box.className = "welcome-toast-box";
        box.id = "welcome-toast";
        box.style.opacity = "0";
        box.style.transition = "opacity 0.35s ease";
        const p = document.createElement("p");
        p.className = "welcome-toast-text";
        p.textContent = "✨ 尊贵的用户，欢迎您使用 😊";
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "welcome-toast-close";
        closeBtn.setAttribute("aria-label", "关闭欢迎提示");
        closeBtn.textContent = "✕";
        closeBtn.addEventListener("click", () => dismissWelcomeToast(wrap, { remember: true }));
        box.appendChild(p);
        box.appendChild(closeBtn);
        wrap.appendChild(box);
        document.body.appendChild(wrap);
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                box.style.opacity = "1";
            });
        });
        welcomeToastTimer = window.setTimeout(() => {
            welcomeToastTimer = 0;
            dismissWelcomeToast(wrap, { remember: false });
        }, 3500);
    }

    function initMain() {
        const boot = () => {
            tryFreeLocalStorageForWorshipBoot();
            ensureBgImageInputAcceptsVideo();
            loadState();
            try {
                upgradeSavedSetlistsInPlace();
            } catch (_e) {
                /* ignore */
            }
            noteProjectionDisplayGone();
            applyAdvPreviewCssVarsFromStorage();
            ensureDefaultThemeBackgroundAtBoot();
            normalizeLegacyBgImageReference();
            refreshBackgroundDefaultsFromUi();
            hydrateCurrentSongBackgroundIntoUi();
            applyThemeBackground();
            const left = $("song-library");
            const right = $("preview-panel");
            if (left && !left.style.width) left.style.width = "260px";
            if (right && !right.style.width) right.style.width = "300px";
            initFontFamilySelector();
            ensureFontColorControls();
            ensureProjectionOverlayOpacitySlider();
            initAdvDrawerAccordion();
            installAdvDrawerResetButton();
            syncPosYFromCurrentSong();
            syncOverlayFontOpacityFromCurrentSong();
            updateUIFromState();
            syncSongToEditor();
            renderSongList();
            updateSpeakerCards();
            renderMiniPreview();
            renderPlaylist();
            bindEvents();
            startProjectionDisplayWindowWatch();
            installLyricEditorDrawerResize();
            initProjectionPreviewMonitor();
            queueMicrotask(() => {
                maybeOfferLyricDraftRestore();
            });
            initCloudShareActionGroup();
            rehomeOnlineResultsPanelIfNeeded();
            const onlineSearchInp = $("online-search-input");
            if (onlineSearchInp) {
                onlineSearchInp.disabled = false;
                onlineSearchInp.removeAttribute("disabled");
            }
            ["open-display-btn", "open-leader-btn"].forEach((id) => {
                const b = $(id);
                if (b && b.tagName === "BUTTON") b.setAttribute("type", "button");
            });
            const legacyLeaderQrBtn = $("leader-qr-btn");
            if (legacyLeaderQrBtn) legacyLeaderQrBtn.hidden = true;
            installOpenDisplayProjectionHelp();
            bindMainMiniPreviewVideoVisibility();
            initResizable();
            initPreviewResize();
            migrateLegacyUploadedBackgrounds();
            seedUploadedBackgroundsFromState();
            renderUploadedBackgrounds();
            loadSharedBackgrounds();

            if (channel) {
                channel.onmessage = (e) => {
                    const d = e.data;
                    if (!d || typeof d !== "object") return;
                    if (d.type === "main_projection_end" && d.source === "main") {
                        return;
                    }
                    if (d.type === "projection_display_ready" && d.source === "display") {
                        noteProjectionDisplayAlive();
                        hideRestoreProjectionBanner();
                        return;
                    }
                    if (d.type === "projection_fs_active" && d.source === "display") {
                        noteProjectionDisplayAlive();
                        hideRestoreProjectionBanner();
                        return;
                    }
                    if (d.type === "projection_attention" && d.source === "display") {
                        const reason = String(d.reason || "");
                        if (reason === "pagehide" || reason === "beforeunload") {
                            onProjectionDisplayWindowClosed();
                            return;
                        }
                        showRestoreProjectionBanner();
                        return;
                    }
                    if (d.type === "request_state") {
                        if (d.source === "display") {
                            noteProjectionDisplayAlive();
                            hideRestoreProjectionBanner();
                        }
                        respondCurrentState();
                        return;
                    }
                    if (d.type === "update" && d.payload) {
                        if (d.source === "main") return;
                        liveState = d.payload;
                        setStore(STORAGE.LIVE, liveState);
                        return;
                    }
                    handleControlMessage(d);
                };
            }
            broadcastState();
            try {
                window.__worshipDebugState = state;
            } catch (e) {}
            renderPageGallery();
            if (typeof EventBus !== "undefined" && EventBus.on) {
                EventBus.on("page:changed", function () {
                    renderPageGallery();
                });
                EventBus.on("song:changed", function () {
                    renderPageGallery();
                });
            }
            if (!window.__worshipPagehideBound) {
                window.__worshipPagehideBound = true;
                window.addEventListener("pagehide", persistStateBeforeHide);
            }
            maybeShowWelcomeToast();
            maybeStartNewUserArrowGuide();
            ensureWorshipVersionFooter();
            updateGalleryStatusBar();
            updateGalleryZoom();
            if (typeof UI !== "undefined" && UI.init) UI.init();
            // ====== 强制初始化页面画廊 ======
            setTimeout(function () {
                console.log("[画廊] initMain 完成，尝试渲染画廊...");
                var songsLen =
                    typeof state !== "undefined" && state.songs && state.songs.length
                        ? state.songs.length
                        : 0;
                var plLen =
                    state.playlist && state.playlist.items && state.playlist.items.length
                        ? state.playlist.items.length
                        : 0;
                console.log(
                    "[画廊] 延迟检查 songs:",
                    songsLen,
                    "playlist items:",
                    plLen,
                    "currentSongId:",
                    state.currentSongId
                );
                if (songsLen) {
                    console.log("[画廊] state 就绪，songs数量:", songsLen);
                } else {
                    console.warn("[画廊] state 可能未完全就绪，仍调度画廊渲染");
                }
                renderPageGallery();
            }, 500);
            requestEnsureUploadedVideoCoversOnMineTab();
        };
        initBackgroundImageIndexedDb().then(boot).catch((err) => {
            console.error(err);
            boot();
        });
    }

    function init() {
        if (isDisplay) return initDisplayMode();
        if (isLeader) return initLeaderView();
        initMain();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();