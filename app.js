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
    /** 无自定义主题背景时的默认壁纸（相对路径，置于项目根目录） */
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

    /** 仅在 IndexedDB / 本地槽位均无主题背景时注入默认十字架图（不写存储，不影响已有用户数据） */
    function ensureDefaultThemeBackgroundAtBoot() {
        if ((_idbThemeBgCache || "").trim()) return;
        if (Array.isArray(_themeBgSlotsCache) && _themeBgSlotsCache.length > 0) return;
        _idbThemeBgCache = DEFAULT_THEME_BG_REL_PATH;
        _themeBgSlotsCache = [{
            id: DEFAULT_THEME_BG_SLOT_ID,
            imageData: DEFAULT_THEME_BG_REL_PATH,
            timestamp: Date.now()
        }];
        _themeBgActiveId = DEFAULT_THEME_BG_SLOT_ID;
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

    function removeLyricBgDeletePopover() {
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
        const p = document.createElement("p");
        p.className = "lyric-bg-delete-popover-text";
        p.textContent = "确认删除此背景图？";
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
        actions.appendChild(btnDel);
        actions.appendChild(btnCancel);
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
        const file = input?.files?.[0];
        if (!file) return;
        if (input.id === "worship-console-wallpaper-input" && file.type && !/^image\//i.test(String(file.type))) {
            showToast("请选择图片文件", themeBgSlotUploadToastAnchor());
            input.value = "";
            return;
        }
        const reader = new FileReader();
        const toastAnchor = themeBgSlotUploadToastAnchor();
        reader.onload = () => {
            const dataUrl = String(reader.result || "").trim();
            if (!dataUrl) {
                showToast("未能读取图片", toastAnchor);
                input.value = "";
                return;
            }
            try {
                const dup = _themeBgSlotsCache.find((x) => x && x.imageData === dataUrl);
                if (dup) {
                    _themeBgActiveId = dup.id;
                    persistFullThemeBgFromSlots();
                    applyThemeBackground();
                    showToast("已切换到该主题背景", toastAnchor);
                } else {
                    if (
                        _themeBgSlotsCache.filter((x) => x && x.imageData).length >=
                        THEME_BG_SLOTS_MAX
                    ) {
                        showToast("已满 4 张，请先删除一张", toastAnchor);
                        input.value = "";
                        return;
                    }
                    const nid = themeBgSlotId();
                    _themeBgSlotsCache = normalizeThemeBgSlots([
                        { id: nid, imageData: dataUrl, timestamp: Date.now() },
                        ..._themeBgSlotsCache
                    ]);
                    _themeBgActiveId = nid;
                    persistFullThemeBgFromSlots();
                    applyThemeBackground();
                    showToast("主题背景已更新", toastAnchor);
                }
            } catch (err) {
                console.warn(err);
                showToast("主题背景存储失败（空间不足）", toastAnchor);
            } finally {
                input.value = "";
            }
        };
        reader.onerror = () => {
            showToast("读取文件失败", toastAnchor);
            input.value = "";
        };
        reader.readAsDataURL(file);
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
        persistFullThemeBgFromSlots();
        ensureDefaultThemeBackgroundAtBoot();
        persistFullThemeBgFromSlots();
        applyThemeBackground();
        showToast("已恢复默认主题背景", $("worship-console-wallpaper-preview") || $("worship-console-wallpaper-reset"));
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
        const file = input?.files?.[0];
        if (!file) return;
        const name = String(file.name || "").toLowerCase();
        const okExt = /\.(mp4|webm|mov)$/i.test(name);
        const mime = String(file.type || "").toLowerCase();
        const okMime =
            mime === "video/mp4" ||
            mime === "video/webm" ||
            mime === "video/quicktime" ||
            /^video\/(mp4|webm|quicktime)$/i.test(mime);
        if (!okExt && !okMime) {
            showToast(
                "请上传 .mp4、.webm 或 .mov 视频",
                $("worship-console-theme-video-upload-btn") || themeBgSlotUploadToastAnchor()
            );
            input.value = "";
            return;
        }
        const reader = new FileReader();
        const ta = $("worship-console-theme-video-upload-btn") || themeBgSlotUploadToastAnchor();
        reader.onload = () => {
            const dataUrl = String(reader.result || "").trim();
            if (!dataUrl || !isLikelyThemeConsoleVideoDataUrl(dataUrl)) {
                showToast("未能读取视频", ta);
                input.value = "";
                return;
            }
            persistThemeConsoleVideo(dataUrl);
            applyThemeBackground();
            showToast("主题背景视频已更新", ta);
            input.value = "";
        };
        reader.onerror = () => {
            showToast("读取视频失败", ta);
            input.value = "";
        };
        reader.readAsDataURL(file);
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
            /* 缩放只作用在分页卡片容器上，避免整栏 scale 后被父级 overflow-x:hidden 裁掉右侧「x / n 共 n 页」 */
            gal.style.transform = "";
            gal.style.transformOrigin = "";
            gal.querySelectorAll(".layout-page-gallery-pages-scale-shell").forEach((shell) => {
                shell.style.transformOrigin = "top left";
                shell.style.transform = `scale(${galleryZoomLevel})`;
            });
        }
        if (valEl) valEl.textContent = `${Math.round(galleryZoomLevel * 100)}%`;
        requestAnimationFrame(() => {
            syncGalleryZoomShellVerticalGap();
            requestAnimationFrame(syncGalleryZoomShellVerticalGap);
        });
    }

    /**
     * transform:scale 不改变布局高度，放大后卡片会盖住下一首分区标题；用 margin-bottom 补足 (zoom-1)*行高。
     */
    function syncGalleryZoomShellVerticalGap() {
        const gal = $("layout-page-gallery");
        if (!gal) return;
        const z = clamp(Number(galleryZoomLevel) || 1, 0.5, 2);
        gal.querySelectorAll(".layout-page-gallery-pages-scale-shell").forEach((shell) => {
            const row = shell.querySelector(":scope > .layout-page-gallery-pages");
            const h = row ? row.offsetHeight : 0;
            if (z <= 1.001 || h <= 0) {
                shell.style.marginBottom = "";
                return;
            }
            const extra = Math.round(h * (z - 1)) + 6;
            shell.style.marginBottom = `${extra}px`;
        });
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
        row.style.color = u.lightBg ? "#111" : (u.fontColor || state.ui.fontColor || "#ffffff");
        row.style.opacity = String(fontOp);
        const sp = clamp(Number(u.textStrokePx ?? 0), 0, 6);
        if (sp > 0) {
            const w = Math.min(sp, 2.5);
            const tcol = u.lightBg ? "rgba(0,0,0,0.4)" : "rgba(0,0,0,0.62)";
            row.style.webkitTextStroke = `${w}px ${tcol}`;
            row.style.paintOrder = "stroke fill";
        } else {
            row.style.webkitTextStroke = "";
            row.style.paintOrder = "";
        }
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

    function pageTransitionExitPreset(trans) {
        const t = canonicalPageTransition(trans);
        switch (t) {
            case "fade":
                return { opacity: "0", transform: "" };
            case "slide-left":
                return { opacity: "0.08", transform: "translateX(-36px)" };
            case "slide-right":
                return { opacity: "0.08", transform: "translateX(36px)" };
            case "slide-up":
                return { opacity: "0.08", transform: "translateY(-28px)" };
            case "slide-down":
                return { opacity: "0.08", transform: "translateY(28px)" };
            case "zoom-in":
                return { opacity: "0.12", transform: "scale(0.88)" };
            case "zoom-out":
                return { opacity: "0.12", transform: "scale(1.12)" };
            case "flip-x":
                return { opacity: "0.1", transform: "perspective(960px) rotateY(-86deg) scale(0.9)" };
            case "flip-y":
                return { opacity: "0.1", transform: "perspective(960px) rotateX(-86deg) scale(0.9)" };
            case "rotate-left":
                return { opacity: "0.12", transform: "rotate(-16deg) translateY(10px)" };
            case "rotate-right":
                return { opacity: "0.12", transform: "rotate(16deg) translateY(10px)" };
            default:
                return null;
        }
    }

    function pageTransitionEnterStartPreset(trans) {
        const t = canonicalPageTransition(trans);
        switch (t) {
            case "fade":
                return { opacity: "0.02", transform: "" };
            case "slide-left":
                return { opacity: "0.06", transform: "translateX(36px)" };
            case "slide-right":
                return { opacity: "0.06", transform: "translateX(-36px)" };
            case "slide-up":
                return { opacity: "0.06", transform: "translateY(28px)" };
            case "slide-down":
                return { opacity: "0.06", transform: "translateY(-28px)" };
            case "zoom-in":
                return { opacity: "0.08", transform: "scale(1.12)" };
            case "zoom-out":
                return { opacity: "0.08", transform: "scale(0.88)" };
            case "flip-x":
                return { opacity: "0.08", transform: "perspective(960px) rotateY(86deg) scale(0.9)" };
            case "flip-y":
                return { opacity: "0.08", transform: "perspective(960px) rotateX(86deg) scale(0.9)" };
            case "rotate-left":
                return { opacity: "0.1", transform: "rotate(16deg) translateY(-10px)" };
            case "rotate-right":
                return { opacity: "0.1", transform: "rotate(-16deg) translateY(-10px)" };
            default:
                return null;
        }
    }

    function projectionLyricTransitionTarget() {
        return $("projection-lyric-anim") || $("projection-lyric");
    }

    function runDisplayPageTransitionThenRender(trans, durSec, renderFn, fontOpacityPct) {
        const ly = projectionLyricTransitionTarget();
        const fontOp = clamp(Number(fontOpacityPct ?? 100), 20, 100) / 100;
        const dur = clamp(Number(durSec), 0.3, 1.5);
        const ease = "cubic-bezier(0.4, 0, 0.2, 1)";
        const t = canonicalPageTransition(trans);
        if (!ly || t === "none" || typeof renderFn !== "function") {
            if (typeof renderFn === "function") renderFn();
            return;
        }
        const exitPreset = pageTransitionExitPreset(t);
        if (!exitPreset) {
            renderFn();
            return;
        }
        const midSwap = { pageTransitionMidSwap: true };
        const afterExit = () => {
            renderFn(midSwap);
            ly.style.transition = "none";
            const in0 = pageTransitionEnterStartPreset(t) || { opacity: "0.01", transform: "" };
            ly.style.transform = in0.transform;
            ly.style.opacity = in0.opacity;
            requestAnimationFrame(() => {
                ly.style.transition = `opacity ${dur}s ${ease}, transform ${dur}s ${ease}`;
                ly.style.opacity = String(fontOp);
                ly.style.transform = "";
            });
        };
        ly.style.transition = `opacity ${dur}s ${ease}, transform ${dur}s ${ease}`;
        ly.style.opacity = exitPreset.opacity;
        ly.style.transform = exitPreset.transform;
        window.setTimeout(afterExit, Math.round(dur * 1000));
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
    function runMiniPageTransitionEnter(el, trans, durSec, fontOpacityPct) {
        const fontOp = clamp(Number(fontOpacityPct ?? 100), 20, 100) / 100;
        const dur = clamp(Number(durSec), 0.3, 1.5);
        const ease = "cubic-bezier(0.4, 0, 0.2, 1)";
        const t = canonicalPageTransition(trans);
        if (!el || t === "none") return;
        const in0 = pageTransitionEnterStartPreset(t);
        if (!in0) return;
        el.style.transition = "none";
        el.style.transform = in0.transform;
        el.style.opacity = in0.opacity;
        requestAnimationFrame(() => {
            el.style.transition = `opacity ${dur}s ${ease}, transform ${dur}s ${ease}`;
            el.style.opacity = String(fontOp);
            el.style.transform = "";
        });
        window.setTimeout(() => {
            if (!el || !el.isConnected) return;
            el.style.opacity = String(fontOp);
            el.style.transform = "";
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

    /** 与投屏监视 #monitor-lyric-layer、投屏 projection-lyric 一致：歌词层用 top 百分比（posY 20–70） */
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

    /** 页面画廊缩略图：垂直位置与投屏监视同源（top 百分比），字号仍由 CSS 固定 */
    function applyGalleryCardLyricVerticalLayout(card, lyricAnim, song) {
        if (!card || !lyricAnim) return;
        const py = effectiveGalleryPosYForSong(song);
        const topPct = clamp(Number(py), 0, 100);
        lyricAnim.style.cssText =
            "position:absolute;left:0;right:0;width:100%;z-index:2;" +
            `top:${topPct}%;` +
            "box-sizing:border-box;padding:0 0 8px 0;" +
            "transform-origin:center center;display:flex;flex-direction:column;align-items:center;";
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

    function getStore(key, fallback) {
        return parseJSON(localStorage.getItem(key), fallback);
    }

    /** 与 index 中 input 对齐：允许图片与视频（仅改 JS，不依赖 HTML accept） */
    function ensureBgImageInputAcceptsVideo() {
        const inp = $("bg-image-input");
        if (!inp || inp.dataset.videoAcceptBound === "1") return;
        inp.dataset.videoAcceptBound = "1";
        inp.setAttribute("accept", "image/*,video/*,.jpg,.jpeg,.png,.gif,.webp,.bmp,.mp4,.webm,.mov,.m4v,.ogv,.mkv");
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
            title: "第 6 步：开启投屏",
            text:
                "在右侧「投屏控制」点「开启投屏」打开会众窗口（若被拦截请在地址栏允许弹窗）。投屏窗口可按 F 全屏。主控台可用「投屏监视」小窗查看现场；投屏中后，中间还会出现金色状态栏，可「分享云端」等。"
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
                "<dt>翻页</dt><dd>← → 或空格；焦点在输入框/滑块时可 Alt+←/→/空格，或 Ctrl+Shift+←/→</dd>" +
                "<dt>全屏</dt><dd>F 键</dd>" +
                "<dt>黑屏 / 白屏</dt><dd>B 键 / W 键</dd>" +
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
        const name = window.prompt("存档名称（将保存当前歌词与高级编辑设置）", defaultName);
        if (name === null) return;
        const nm = String(name).trim() || defaultName;
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

    /** 列表/分类：搜索仅匹配标题 */
    function songTitleMatchesSearch(song, keyLower) {
        if (!keyLower) return true;
        return String(song.title || "")
            .toLowerCase()
            .includes(keyLower);
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
                if (!window.confirm("确定删除此背景？")) return;
                beginLyricBgDeleteSequence(wrap, item.id);
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
                kw: "推荐搜索：worship background, church motion, particles loop, light rays, golden glow",
                badge: "免费可商用",
                url: "https://pixabay.com/"
            },
            {
                name: "Pexels",
                desc: "高质量视频 / 自然风景",
                kw: "推荐搜索：worship, church, cross, clouds, sunset, ocean",
                badge: "免费可商用",
                url: "https://www.pexels.com/"
            },
            {
                name: "Coverr",
                desc: "专门免费视频背景",
                kw: "推荐搜索：faith, spiritual, abstract, nature, ambient",
                badge: "免费可商用",
                url: "https://coverr.co/"
            },
            {
                name: "Canva",
                desc: "设计感强 / 宗教主题",
                kw: "推荐搜索：worship background, Christian, church stage, 十字架, 敬拜",
                badge: "免费版可用，部分需署名",
                url: "https://www.canva.com/"
            }
        ];
        const inner = document.createElement("div");
        inner.style.cssText = "background:var(--bg-secondary);border-radius:16px;padding:20px 22px;max-width:560px;width:100%;max-height:90vh;overflow-y:auto;border:1px solid var(--border-color);position:relative;";
        inner.innerHTML = `<button type="button" id="free-bg-modal-close" style="position:absolute;right:12px;top:10px;border:none;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:1.1rem;">✕</button>
            <h3 style="margin:0 0 4px;color:var(--text-primary);font-size:1.05rem;">🎨 免费背景素材</h3>
            <p class="hint-text" style="margin-top:6px;">点击卡片在新标签页打开网站</p>
            <div class="free-bg-modal-grid" id="free-bg-modal-grid"></div>
            <p class="free-bg-modal-foot">💡 下载后回到本页，用「上传背景图片」即可使用</p>`;
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

    function saveSongs() {
        /* ==========================================================
           [迁移标记 round1] 已迁移至 js/state.js；以下为旧实现，保留作安全网。
           当 globalThis.saveSongs 不可用时可恢复块内逻辑。
           ==========================================================
        setStore(STORAGE.SONGS, state.songs);
        */
        return globalThis.saveSongs();
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
        let ret;
        if (typeof globalThis.loadState === "function") {
            ret = globalThis.loadState();
        }
        hydrateAppStateFromStorage();
        return ret;
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
                            row.textContent = pl[i] || "";
                            applyTypographyToPreviewRow(row, {
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
                row.textContent = line;
                applyTypographyToPreviewRow(row, {
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
            const trans = canonicalPageTransition(state.ui.pageTransition);
            if (trans === "none") runGalleryCardSwitchAnimation(gal);
            runGalleryActiveLyricEnterOnly(gal);
        });
    }

    /** 画廊当前页歌词：与用户设置的翻页特效一致（入场；避免与外层卡片 transform 冲突） */
    function runGalleryActiveLyricEnterOnly(gal) {
        if (!gal || !gal.isConnected) return;
        const prevP = gal.dataset.galLyricLastPage;
        const prevS = gal.dataset.galLyricLastSongId;
        const curSid = String(state.currentSongId || "");
        const idx = state.currentPage;
        const trans = canonicalPageTransition(state.ui.pageTransition);
        const dur = clamp(Number(state.ui.pageTransitionSpeed), 0.3, 1.5);
        const shouldAnim =
            prevP !== undefined &&
            trans !== "none" &&
            (String(prevP) !== String(idx) || String(prevS || "") !== curSid);
        if (shouldAnim) {
            const active = gal.querySelector(".gallery-page-card.is-active .gallery-card-lyric-anim");
            if (active) runMiniPageTransitionEnter(active, trans, dur, state.ui.fontOpacityPct);
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
        const curSid = String(state.currentSongId || "");

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

                card.querySelectorAll(".gallery-card-line").forEach((n) => n.remove());
                let lyricAnim = card.querySelector(":scope > .gallery-card-lyric-anim");
                if (!lyricAnim) {
                    lyricAnim = document.createElement("div");
                    lyricAnim.className = "gallery-card-lyric-anim";
                    lyricAnim.style.cssText =
                        "position:relative;z-index:2;width:100%;transform-origin:center center;display:flex;flex-direction:column;align-items:center;";
                    if (vig && vig.nextSibling) card.insertBefore(lyricAnim, vig.nextSibling);
                    else card.appendChild(lyricAnim);
                }
                lyricAnim.replaceChildren();
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
                lineList.forEach((l) => {
                    const row = document.createElement("div");
                    row.className = "gallery-card-line";
                    row.style.lineHeight = "1.45";
                    row.style.position = "relative";
                    row.style.zIndex = "2";
                    row.textContent = l;
                    applyTypographyToPreviewRow(row, {
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
            }
        }
        refreshGallerySectionPageIndicators();
        requestAnimationFrame(() => relayoutGalleryLyricVerticalPads());
        return true;
    }

    function updateGalleryStatusBar() {
        const bar = $("gallery-status-bar");
        if (!globalThis.__displayWindowOpened) {
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
                    row.style.lineHeight = "1.45";
                    row.style.position = "relative";
                    row.style.zIndex = "2";
                    row.textContent = l;
                    applyTypographyToPreviewRow(row, {
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
        const rawIds = Array.isArray(sl.songs) ? sl.songs : Array.isArray(sl.items) ? sl.items : [];
        const next = [];
        rawIds.forEach((songId) => {
            const hit = state.songs.find((s) => String(s.id) === String(songId));
            if (!hit) return;
            if (!next.some((id) => String(id) === String(hit.id))) next.push(hit.id);
        });
        if (!next.length && rawIds.length > 0) {
            closeSetlistModal();
            showToast("歌单中的诗歌已不在本机曲库，无法加载", triggerBtn || $("load-setlist-btn"));
            return;
        }
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
        broadcastState();
        closeSetlistModal();
        showToast("已加载歌单", triggerBtn || $("load-setlist-btn"));
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

    function commitSetlistNameModalSave() {
        const inp = $("setlist-name-input");
        const ctx = setlistNameModalCtx;
        if (!inp || !ctx) return;
        const trimmed = String(inp.value || "").trim();
        if (!trimmed) {
            showToast("请输入歌单名称", $("setlist-name-confirm"));
            return;
        }
        let lists = loadSavedSetlists();
        const entry = {
            id: "setlist_" + Date.now(),
            name: trimmed,
            songs: [...ctx.ids],
            createdAt: Date.now()
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
                row.textContent = line;
                applyTypographyToPreviewRow(row, {
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
            row.textContent = line;
            applyTypographyToPreviewRow(row, {
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
            refreshMonitorContent({ fontOpacityPct: pct });
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
        const colors = ["#ffffff", "#d9d9d9", "#ffd700", "#b8f5b8", "#ffc0cb"];
        const chips = $("font-color-chips");
        colors.forEach((c) => {
            const chip = document.createElement("button");
            chip.className = "font-color-chip";
            chip.dataset.color = c;
            chip.style.cssText = `width:22px;height:22px;border-radius:50%;border:2px solid rgba(255,255,255,.35);background:${c};cursor:pointer;`;
            chip.addEventListener("click", () => {
                state.ui.fontColor = c;
                updateUIFromState();
                updateAll();
            });
            chips.appendChild(chip);
        });
        $("font-color-custom")?.addEventListener("change", () => {
            const val = ($("font-color-custom").value || "").trim();
            if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(val)) {
                state.ui.fontColor = val;
                updateUIFromState();
                updateAll();
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
        const payload = buildLiveState();
        liveState = payload;
        channel.postMessage({ type: "update", payload, source: "main" });
    }

    function broadcastState() {
        /** 勿调用旧的 globalThis.broadcastState（router 存根会写死字体并污染 LIVE / 投屏）；此处为唯一权威广播 */
        liveState = buildLiveState();
        if (typeof globalThis !== "undefined") globalThis.worshipLiveState = liveState;
        try {
            setStore(STORAGE.LIVE, liveState);
        } catch (err) {
            console.warn("broadcastState setStore LIVE", err);
        }
        if (channel) {
            try {
                const msg = { type: "update", payload: liveState, source: "main" };
                channel.postMessage(msg);
                if (typeof requestAnimationFrame === "function") {
                    requestAnimationFrame(() => {
                        try {
                            channel.postMessage(msg);
                        } catch (e2) {
                            console.warn("broadcastState channel rAF", e2);
                        }
                    });
                }
            } catch (err) {
                console.warn("broadcastState channel", err);
            }
        }
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
    /** 监视窗按此画布铺版再整体缩放，使 px 字号与全屏投屏上的视觉比例一致（页面画廊不参与） */
    const MONITOR_STAGE_REF_W = 1920;
    const MONITOR_STAGE_REF_H = 1080;
    const MONITOR_CONTENT_ASPECT = MONITOR_STAGE_REF_W / MONITOR_STAGE_REF_H;

    /**
     * 将监视窗外框调整为：内容区（#monitor-content）严格 16:9，与投屏画布比例一致，避免 contain 缩放产生的黑边。
     * reqTotalW/H 为用户拖拽期望的大致外框尺寸（含标题栏）。
     */
    function normalizeProjectionMonitorFrame(el, reqTotalW, reqTotalH) {
        if (!el) return;
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
        const content = $("monitor-content");
        const stage = $("monitor-preview-stage");
        if (!content || !stage) return;
        const cw = Math.max(1, content.clientWidth);
        const ch = Math.max(1, content.clientHeight);
        /** 内容区为 16:9；用 min 吸收取整误差，避免画布超出产生裁切闪烁 */
        const s = Math.min(cw / MONITOR_STAGE_REF_W, ch / MONITOR_STAGE_REF_H);
        stage.style.transform = `scale(${s})`;
    }

    function mergeMonitorProjectionSnapshot(overrides, baseSnap) {
        const snap =
            baseSnap && typeof baseSnap === "object"
                ? { ...baseSnap, text: { ...(baseSnap.text || {}) } }
                : buildLiveState();
        if (!overrides || typeof overrides !== "object" || !Object.keys(overrides).length) return snap;
        const o = overrides;
        const text = { ...(snap.text || {}) };
        if (o.fontSize != null) text.fontSize = clampLyricFontSize(o.fontSize);
        if (o.posY != null) text.topPct = clamp(Number(o.posY), 20, 70);
        if (o.textStrokePx != null) text.strokePx = clamp(Number(o.textStrokePx), 0, 6);
        let fontOpacityPct = snap.fontOpacityPct;
        if (o.fontOpacityPct != null) fontOpacityPct = clamp(Number(o.fontOpacityPct), 20, 100);
        return { ...snap, text, fontOpacityPct };
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

    function refreshMonitorContent(overrides, snapshot) {
        if (isDisplay || isLeader) return;
        const host = $("projection-preview-monitor");
        const content = $("monitor-content");
        if (!host || !content) return;
        const snap = mergeMonitorProjectionSnapshot(overrides, snapshot);
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
        const lhRaw =
            typeof getComputedStyle === "function"
                ? getComputedStyle(document.documentElement).getPropertyValue("--adv-preview-line-height")
                : "";
        const lh = Math.max(1.05, Math.min(3, parseFloat(lhRaw) || 1.65));

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

        lyr.style.top = `${t.topPct != null ? clamp(Number(t.topPct), 0, 100) : 45}%`;
        const monFf = (t.fontFamily && String(t.fontFamily).trim()) || state.ui.fontFamily;
        lyr.style.fontFamily = monFf;
        /* 与 js/ui.js renderDisplayLyric 一致：全屏投屏上 clamp 为 24–160px */
        lyr.style.fontSize = `${clamp(Number(t.fontSize) || 60, 24, 160)}px`;
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

        const fillMonitorLyricInner = () => {
            anim.innerHTML = lines
                .map((line) => `<div class="monitor-lyric-line"${strokeAttr}>${escapeHtml(line)}</div>`)
                .join("");
            anim.querySelectorAll(".monitor-lyric-line").forEach((row) => {
                row.style.fontFamily = monFf;
            });
        };

        const transEff = canonicalPageTransition(snap.pageTransition);
        const durTrans = clamp(Number(snap.pageTransitionSpeed), 0.3, 1.5);
        const curSid = String(snap.songId ?? "");
        const prevP = host.dataset.monitorLastPage;
        const prevS = host.dataset.monitorLastSongId;
        const navChanged =
            prevP !== undefined &&
            (String(prevP) !== String(idx) || String(prevS || "") !== curSid);
        const shouldTrans = navChanged && !snap.playlistFade && transEff !== "none";

        const finishMonitorNavState = () => {
            host.dataset.monitorLastPage = String(idx);
            host.dataset.monitorLastSongId = curSid;
        };

        const applyStaticLyricPresentation = () => {
            flushMonitorLyricTrans();
            fillMonitorLyricInner();
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
            localStorage.setItem(
                MONITOR_RECT_LS_KEY,
                JSON.stringify({
                    left: r.left,
                    top: r.top,
                    width: r.width,
                    height: r.height
                })
            );
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
        const r0 = el.getBoundingClientRect();
        normalizeProjectionMonitorFrame(el, r0.width, r0.height);

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

        header.addEventListener("mousedown", startMove);
        header.addEventListener("touchstart", startMove, { passive: false });
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
                return { qrEncode: join, pageAbs, mode: "custom", needsLanHint: false };
            } catch (_e) {
                /* fall through */
            }
        }
        let u;
        try {
            u = new URL(pageAbs);
        } catch (_e) {
            return { qrEncode: null, pageAbs, mode: "broken", needsLanHint: true };
        }
        const badForPhone =
            u.protocol === "file:" ||
            u.hostname === "localhost" ||
            u.hostname === "127.0.0.1" ||
            u.hostname === "[::1]";
        if (badForPhone) {
            return { qrEncode: null, pageAbs: u.href, mode: "local", needsLanHint: true };
        }
        return { qrEncode: u.href, pageAbs: u.href, mode: "ok", needsLanHint: false };
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
        if (typeof WorshipActions !== "undefined") WorshipActions.saveLyrics();
        saveSongs();
        renderSongList();
        updateSpeakerCards();
        renderMiniPreview();
        broadcastState();
        clearLyricDraft();
        if (!silent) showCornerSuccessToast("✅ 已保存", $("save-song-btn"));
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
        try {
            win.addEventListener("unload", () => {
                if (projectionDisplayWindowRef === win) projectionDisplayWindowRef = null;
                try {
                    globalThis.__displayWindowOpened = false;
                } catch (_e) {
                    /* ignore */
                }
                try {
                    renderPageGallery();
                } catch (_e2) {
                    /* ignore */
                }
                showRestoreProjectionBanner();
            });
        } catch (_) {
            /* ignore */
        }
    }

    /**
     * 通知所有会众投屏页自行关闭，并关闭主控台仍持有的窗口引用。
     * 与固定 window.name 配合，保证再次「开启投屏」时不会残留后台窗口。
     */
    function purgeOrphanProjectionDisplayWindows() {
        try {
            if (channel) channel.postMessage({ type: "main_projection_end", source: "main" });
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
    }

    function closeProjectionDisplayWindow(opts) {
        const silent = !!(opts && opts.silent);
        purgeOrphanProjectionDisplayWindows();
        try {
            globalThis.__displayWindowOpened = false;
        } catch (_e) {
            /* ignore */
        }
        try {
            updateGalleryStatusBar();
        } catch (_e2) {
            /* ignore */
        }
        hideRestoreProjectionBanner();
        if (!silent) {
            try {
                showToast("已结束投屏", $("close-projection-display-btn") || $("open-display-btn"));
            } catch (_e3) {
                /* ignore */
            }
        }
    }

    /** 主领「诗歌包」二维码：仅标题+歌词，离线可扫（手机主领页「诗歌」→ 粘贴导入） */
    const WORSHIP_QR_PACK_MAX_CHARS = 2400;
    /** 扫码打开链接总长度上限（含 #wp1=），兼顾常见二维码生成接口 */
    const LEADER_QR_OPEN_URL_MAX = 3000;

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
            const payload = {
                v: 1,
                ci: clamp(ci, 0, Math.max(0, lite.length - 1)),
                s: lite.map((x) => [x.title, x.lyrics]),
                /** 与电脑主领/歌词区一致的精简样式（短键省体积） */
                sty: {
                    ff: state.ui.fontFamily,
                    fc: state.ui.fontColor,
                    fs: state.ui.fontSize,
                    fw: state.ui.fontWeight,
                    py: state.ui.posY,
                    dl: state.ui.defaultLines
                }
            };
            return encodeWorshipPackForQrString(payload);
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

    /** 生成「手机浏览器可打开」的主领链接：?leader=1#wp1=诗歌包 */
    async function buildLeaderSongPackAndOpenUrl() {
        const resolved = resolveLeaderJoinUrlForQr();
        const baseFull = resolved.qrEncode ? String(resolved.qrEncode).split("#")[0].trim() : "";
        if (!baseFull) {
            const built = await buildLeaderSongPackQrPayload();
            return {
                ...built,
                openUrl: "",
                scanKind: "need-http",
                scanHint: "请填写下方「手机可访问的站点根地址」并保存，二维码将变为可扫码打开的网页链接（与电脑同 Wi‑Fi）。"
            };
        }
        let maxPack = Math.min(
            WORSHIP_QR_PACK_MAX_CHARS,
            Math.max(480, LEADER_QR_OPEN_URL_MAX - baseFull.length - 12)
        );
        let built = await buildLeaderSongPackQrPayload(maxPack);
        let openUrl = "";
        for (let attempt = 0; attempt < 14; attempt++) {
            if (!built.qrText) break;
            openUrl = `${baseFull}#wp1=${encodeURIComponent(built.qrText)}`;
            if (openUrl.length <= LEADER_QR_OPEN_URL_MAX) break;
            maxPack = Math.max(400, Math.floor(maxPack * 0.82));
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
                ? "诗歌内容过多，链接超出扫码限制。请删减诗歌或使用「导出」分享。"
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
            saveSongs();
            savePlaylist();
            saveSettings();
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
        if (status) {
            const extra = [built.note, built.truncated ? "（为适配扫码可能已省略部分诗歌或歌词）" : ""]
                .filter(Boolean)
                .join("");
            if (built.scanKind === "url" && built.openUrl) {
                status.textContent = `含 ${songN} 首诗歌 · 扫码用手机浏览器打开主领页并载入歌词${extra ? " · " + extra : ""}`;
            } else if (built.qrText) {
                status.textContent = `含 ${songN} 首诗歌 · ${built.scanHint || "请按下方提示完成设置"}`;
            } else {
                status.textContent = built.scanHint || built.note || "无法生成";
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
                        ? "当前二维码为纯文本数据，部分手机只会显示代码。请填写局域网地址后点「保存地址」刷新，即可变为可打开的链接。"
                        : "生成失败");
            }
        }
        const qrData = built.openUrl || built.qrText || "";
        if (img) {
            img.hidden = false;
            img.alt = built.openUrl ? "打开主领页链接" : "诗歌数据";
            if (qrData) {
                if (built.openUrl) modal.dataset.lastOpenUrl = built.openUrl;
                else delete modal.dataset.lastOpenUrl;
                if (built.qrText) modal.dataset.lastPackQr = built.qrText;
                else delete modal.dataset.lastPackQr;
                const enc = encodeURIComponent(qrData);
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
                delete modal.dataset.lastPackQr;
                img.removeAttribute("src");
                img.style.opacity = "0.2";
                img.onerror = null;
            }
        }
    }

    function openLeaderQrModal() {
        let modal = $("leader-qr-modal");
        if (!modal) {
            modal = document.createElement("div");
            modal.id = "leader-qr-modal";
            modal.style.cssText =
                "position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:2600;display:flex;align-items:center;justify-content:center;padding:16px;";
            modal.innerHTML = `
                <div style="background:var(--bg-secondary);border-radius:16px;padding:18px 20px;text-align:center;max-width:360px;width:100%;position:relative;box-sizing:border-box;">
                    <button type="button" id="leader-qr-close" style="position:absolute;right:8px;top:6px;border:none;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:1.1rem;">✕</button>
                    <div style="font-weight:600;color:var(--text-primary);margin-bottom:6px;">主领诗歌 · 扫码同步</div>
                    <p id="leader-qr-pack-status" style="margin:0 0 10px;font-size:0.82rem;line-height:1.45;color:var(--text-secondary);text-align:left;">正在生成…</p>
                    <img id="leader-qr-image" width="220" height="220" alt="" style="width:220px;height:220px;border-radius:10px;background:#fff;padding:8px;box-sizing:border-box;margin:0 auto;display:block;">
                    <div style="margin-top:10px;color:var(--text-secondary);font-size:0.82rem;line-height:1.5;text-align:left;">配置好下方地址后，用<b>手机自带浏览器</b>（Chrome / Safari）扫码，将直接打开<b>主领视角</b>并载入本机诗歌。电脑与手机需在同一 Wi‑Fi。若仅显示乱码，请展开下方填写局域网地址后点「保存地址」再刷新本窗口。</div>
                    <div id="leader-qr-warn" hidden style="margin-top:10px;padding:10px 12px;border-radius:10px;text-align:left;font-size:0.82rem;line-height:1.5;color:#e8c96b;background:rgba(212,175,55,0.12);border:1px solid rgba(212,175,55,0.35);"></div>
                    <details id="leader-qr-adv" style="margin-top:14px;text-align:left;" open>
                        <summary style="cursor:pointer;color:var(--text-secondary);font-size:0.8rem;">手机访问地址（局域网，扫码必需）</summary>
                        <label style="display:block;font-size:0.75rem;color:var(--text-secondary);margin-top:8px;">站点根地址（与电脑浏览器地址栏一致，到含 index.html 的文件夹）</label>
                        <input type="text" id="leader-qr-base-input" placeholder="例：http://192.168.1.5:5500/WorshipApp/" style="width:100%;margin-top:4px;box-sizing:border-box;padding:8px 10px;border-radius:10px;border:1px solid var(--editor-border);background:var(--editor-bg);color:var(--text-primary);font-size:0.86rem;">
                        <p id="leader-qr-url-hint" style="margin:6px 0 0;font-size:0.72rem;color:var(--text-secondary);word-break:break-all;"></p>
                        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
                            <button type="button" id="leader-qr-save-base" class="btn btn-outline" style="font-size:0.82rem;">保存地址</button>
                            <button type="button" id="leader-qr-copy-url" class="btn btn-outline" style="font-size:0.82rem;">复制扫码链接</button>
                        </div>
                    </details>
                    <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;justify-content:center;">
                        <button type="button" id="leader-qr-copy" class="btn btn-outline" style="font-size:0.86rem;">复制链接或备用文本</button>
                    </div>
                </div>
            `;
            modal.addEventListener("click", (e) => {
                if (e.target === modal) modal.style.display = "none";
            });
            document.body.appendChild(modal);
            modal.querySelector("#leader-qr-close")?.addEventListener("click", () => {
                modal.style.display = "none";
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
                if (hint) hint.textContent = r.qrEncode || r.pageAbs || "（未填写则无法用网页链接打开）";
                showCornerSuccessToast(v ? "已保存" : "已清除", e.currentTarget);
                void refreshLeaderQrModalContent(modal);
            });
            modal.querySelector("#leader-qr-copy-url")?.addEventListener("click", async (e) => {
                const text = String(modal.dataset.lastOpenUrl || "").trim();
                if (!text) {
                    showToast("请先生成可扫码链接（填写地址并保存后刷新本窗口）", e.currentTarget);
                    return;
                }
                try {
                    await navigator.clipboard.writeText(text);
                    showCornerSuccessToast("已复制扫码链接", e.currentTarget);
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
                    showCornerSuccessToast(openU ? "已复制打开链接" : "已复制备用文本，可在主领页「诗歌」里粘贴", e.currentTarget);
                } catch (_e) {
                    showToast("复制失败", e.currentTarget);
                }
            });
        }
        const hint0 = modal.querySelector("#leader-qr-url-hint");
        if (hint0) {
            const r = resolveLeaderJoinUrlForQr();
            hint0.textContent = r.qrEncode
                ? `主领页基础地址：${r.qrEncode}`
                : "填写本机 Live Server / http 服务地址并保存，例如 http://192.168.1.5:5500/WorshipApp/";
        }
        void refreshLeaderQrModalContent(modal);
        modal.style.display = "flex";
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
        /** 会众投屏窗（display=1）保留焦点，便于副屏上 Alt+F4 / Ctrl+W 直接关闭，无需先点进窗口 */
        const audienceProjectionUrl = /\bdisplay=1\b/.test(targetUrl);
        if (!isDisplay && !isLeader && !audienceProjectionUrl) refocusMainWindowForOperator();
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
            hideRestoreProjectionBanner();
            try {
                globalThis.__displayWindowOpened = true;
            } catch (_e) {
                /* ignore */
            }
            return;
        }
        /** 新开前：通知所有会众投屏页自行关闭并释放主控引用，避免多窗口残留后台；仍须与 window.open 同一次点击栈内完成 */
        closeProjectionDisplayWindow({ silent: true });
        /** 先 window.open（须留在用户点击的同步栈内），再广播状态，避免 broadcastState 抛错或耗时导致弹窗被拦截 */
        const newWin = openDisplayOnSecondScreen(
            projectionEntryUrl("display"),
            WORSHIP_PROJECTION_DISPLAY_WINDOW_NAME,
            anchor
        );
        safeBroadcastState("openDisplayWindow:after-open");
        if (newWin) {
            attachProjectionDisplayWindow(newWin);
            try {
                globalThis.__displayWindowOpened = true;
            } catch (_e) {
                /* ignore */
            }
        }
        hideRestoreProjectionBanner();
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
        if (btn.querySelector(".open-display-shortcuts-icon")) return;

        const attachShortcutsIcon = () => {
            if (btn.querySelector(".open-display-shortcuts-icon")) return;
            const shortcuts = document.createElement("span");
            shortcuts.className = "open-display-shortcuts-icon";
            shortcuts.setAttribute("role", "button");
            shortcuts.setAttribute("tabindex", "0");
            shortcuts.setAttribute("aria-label", "快捷键");
            shortcuts.title = "快捷键";
            shortcuts.textContent = "⌨️";
            const onShortcutsActivate = (e) => {
                e.preventDefault();
                e.stopPropagation();
                openShortcutsPanel();
            };
            shortcuts.addEventListener("click", onShortcutsActivate);
            shortcuts.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") onShortcutsActivate(e);
            });
            btn.appendChild(shortcuts);
        };

        if (btn.querySelector(".open-display-help-icon")) {
            attachShortcutsIcon();
            return;
        }

        const prevLabel = (btn.textContent || "").trim() || "📺 开启投屏";
        btn.textContent = "";
        btn.style.display = "flex";
        btn.style.alignItems = "center";
        btn.style.justifyContent = "center";
        btn.style.gap = "14px";
        btn.style.flexWrap = "wrap";
        btn.style.boxSizing = "border-box";
        btn.style.whiteSpace = "normal";
        btn.style.wordBreak = "break-word";
        btn.style.minWidth = "80px";
        btn.style.padding = "8px 12px";

        const lab = document.createElement("span");
        lab.className = "open-display-btn-label";
        lab.style.flex = "1 1 auto";
        lab.style.minWidth = "0";
        lab.style.whiteSpace = "normal";
        lab.style.wordBreak = "break-word";
        lab.style.textAlign = "center";
        lab.textContent = prevLabel;

        const help = document.createElement("span");
        help.className = "open-display-help-icon";
        help.setAttribute("role", "button");
        help.setAttribute("tabindex", "0");
        help.setAttribute("aria-label", "投屏帮助");
        help.title = "投屏帮助";
        help.textContent = "❓";
        help.style.cssText = [
            "flex-shrink:0",
            "width:20px",
            "height:20px",
            "min-width:20px",
            "min-height:20px",
            "border-radius:50%",
            "display:inline-flex",
            "align-items:center",
            "justify-content:center",
            "font-size:12px",
            "line-height:1",
            "cursor:pointer",
            "background:rgba(255,255,255,0.28)",
            "color:inherit",
            "user-select:none",
            "box-sizing:border-box"
        ].join(";");

        const onHelpActivate = (e) => {
            e.preventDefault();
            e.stopPropagation();
            openOpenDisplayHelpPanel(e);
        };
        help.addEventListener("click", onHelpActivate);
        help.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") onHelpActivate(e);
        });

        btn.appendChild(lab);
        btn.appendChild(help);
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
        on("save-song-btn", "click", saveCurrentLyrics);
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

        on("font-slider", "input", () => {
            const v = clampLyricFontSize($("font-slider").value || 60);
            if ($("font-val")) $("font-val").textContent = String(v);
            scheduleMiniSliderDomPreview(() => applyMiniPreviewFontSizePx(v));
            refreshMonitorContent({ fontSize: v });
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
            refreshMonitorContent({ posY: v });
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
            const file = input.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            const toastAnchor = $("upload-bg-btn") || $("upload-bg-trigger");
            reader.onload = () => {
                const dataUrl = String(reader.result || "").trim();
                if (!dataUrl) {
                    showToast("未能读取文件", toastAnchor);
                    input.value = "";
                    return;
                }
                try {
                    const name = String(file.name || "").toLowerCase();
                    const videoByExt = /\.(mp4|webm|mov|m4v|ogv|ogg|mkv|avi)$/i.test(name);
                    const videoByMime = String(file.type || "").startsWith("video/");
                    const videoByDataUrl = /^data:video\//i.test(dataUrl);
                    const mt = videoByMime || videoByExt || videoByDataUrl ? "video" : "image";
                    addUploadedBackgroundAndApply(dataUrl, mt);
                    updateUIFromState();
                    updateAll();
                    saveSettings();
                    switchBgTabTo("mine");
                    showToast("已应用背景并加入「我的背景」", toastAnchor);
                } catch (err) {
                    console.warn(err);
                    showToast("保存背景失败（存储空间不足）", toastAnchor);
                } finally {
                    input.value = "";
                }
            };
            reader.onerror = () => {
                showToast("读取文件失败", toastAnchor);
                input.value = "";
            };
            reader.readAsDataURL(file);
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

        on("open-display-btn", "click", openDisplayWindow);
        on("close-projection-display-btn", "click", () => closeProjectionDisplayWindow());
        on("restore-projection-btn", "click", openDisplayWindow);
        on("restore-projection-dismiss", "click", hideRestoreProjectionBanner);
        on("restore-projection-overlay", "click", (e) => {
            const el = $("restore-projection-overlay");
            if (el && e.target === el) hideRestoreProjectionBanner();
        });
        on("open-leader-btn", "click", openLeaderWindow);
        on("leader-qr-btn", "click", openLeaderQrModal);

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
                    if (sp > 0) {
                        const w = Math.min(sp, 2.5);
                        const tcol = lightBg ? "rgba(0,0,0,0.4)" : "rgba(0,0,0,0.62)";
                        row.style.webkitTextStroke = `${w}px ${tcol}`;
                        row.style.paintOrder = "stroke fill";
                    } else {
                        row.style.webkitTextStroke = "";
                        row.style.paintOrder = "";
                    }
                });
                refreshMonitorContent({ textStrokePx: sp });
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
            /** 始终占位，用 opacity 切换，避免 display:none 导致反复解码/重载 */
            displayVid.style.cssText =
                "position:fixed;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:0;" +
                "pointer-events:none;opacity:0;display:block;";
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
            "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center;display:none;pointer-events:none;z-index:2;";
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

    function projectionDisplayIsVideoBackground() {
        if (!liveState) return false;
        const bgState = liveState.background || {};
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
        const gifAnimating =
            type === "image" &&
            mediaType !== "video" &&
            typeof bgState.imageData === "string" &&
            /^data:image\/gif/i.test(bgState.imageData);
        const imgRasterLoading =
            type === "image" &&
            !isVideoBg &&
            projectionBgImage &&
            !projectionBgImage.complete;
        let loop = type === "particles" || gifAnimating || imgRasterLoading;
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
        layer.style.top = (t.topPct || 40) + "%";
        layer.style.fontFamily = t.fontFamily || state.ui.fontFamily;
        layer.style.fontSize = clamp(Number(t.fontSize) || 60, 8, 500) + "px";
        layer.style.fontWeight =
            t.fontWeight != null && t.fontWeight !== ""
                ? String(t.fontWeight)
                : String(state.ui.fontWeight || "700");
        layer.style.color = fontColor;
        const applyFade = !!liveState.playlistFade && !skipOT;
        if (applyFade) layer.style.transition = "opacity 300ms ease";
        else if (!skipOT) layer.style.transition = "";
        if (applyFade) layer.style.opacity = "0";
        layer.innerHTML = lines
            .map((line) => `<div${strokeAttr}>${escapeHtml(line)}</div>`)
            .join("");
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
        layer.innerHTML = [
            `<div style="position:absolute;top:-90px;right:0;font-size:16px;opacity:.9;">第 ${idx + 1}/${Math.max(1, pages.length)} 页</div>`,
            `<div style="line-height:1.35;margin-bottom:20px;">${current.map((x) => escapeHtml(x)).join("<br>") || "..."}</div>`,
            `<div style="font-size:22px;opacity:.75;">下页：${next.length ? next.map((x) => escapeHtml(x)).join(" / ") : "（无）"}</div>`
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
            const l1 = lines?.[0] || "";
            const l2 = lines?.[1] || "";
            card.innerHTML = `<div style="font-weight:700;white-space:normal;">${escapeHtml(l1)}</div><div style="opacity:.75;margin-top:4px;white-space:normal;">${escapeHtml(l2)}</div>`;
            card.addEventListener("click", () => {
                if (channel) channel.postMessage({ type: "goto", page: i });
            });
            holder.appendChild(card);
        });
    }

    function applyLive(mode, payload) {
        if (typeof globalThis !== "undefined" && typeof globalThis.applyLive === "function") {
            return globalThis.applyLive(mode, payload);
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
            (mode || projectionMode) === "display" &&
            projectionDisplayIsVideoBackground() &&
            sigPrev === sigNew;
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
                    try {
                        window.close();
                    } catch (_e) {
                        /* ignore */
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
            channel.postMessage({ type: "request_state" });
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

    function initLeaderView() {
        tryFreeLocalStorageForWorshipBoot();
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
            const host = $("projection-host");
            const lyricLayer = $("projection-lyric");
            const bgCanvas = $("projection-bg");
            const bgImg = $("projection-bg-image");
            const oldNav = $("projection-prev-btn")?.parentElement;
            if (!host || !lyricLayer || !bgCanvas) return;
            if (bgImg) bgImg.style.display = "none";
            if (oldNav) oldNav.style.display = "none";
            if (projectionRaf) {
                cancelAnimationFrame(projectionRaf);
                projectionRaf = 0;
            }

            let displayMode = localStorage.getItem(DISPLAY_MODE_KEY) || "multi";
            if (!["single", "multi", "scroll", "flow"].includes(displayMode)) displayMode = "multi";
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
            let currentPageKey = "";
            const pageDrawings = {};
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
            toolbar.innerHTML = '<button class="leader-mini-btn" data-mode="single" title="单句"><span class="leader-btn-icon">🔍</span><span class="leader-btn-label">单句</span></button><button class="leader-mini-btn" data-mode="multi" title="多句"><span class="leader-btn-icon">📋</span><span class="leader-btn-label">多句</span></button><button class="leader-mini-btn" data-mode="scroll" title="滚动"><span class="leader-btn-icon">📜</span><span class="leader-btn-label">滚动</span></button><button class="leader-mini-btn" data-mode="flow" title="流程视图"><span class="leader-btn-icon">🗂️</span><span class="leader-btn-label">流程</span></button><button class="leader-mini-btn" data-action="flow-arrange" title="编排 / 生成流程"><span class="leader-btn-icon">📐</span><span class="leader-btn-label">编排</span></button><button class="leader-mini-btn" data-action="import-pack" title="导入电脑上的诗歌二维码文本"><span class="leader-btn-icon">📥</span><span class="leader-btn-label">诗歌</span></button><button class="leader-mini-btn" data-action="prev" title="上一页"><span class="leader-btn-icon">◀</span><span class="leader-btn-label">上页</span></button><button class="leader-mini-btn" data-action="next" title="下一页"><span class="leader-btn-icon">▶</span><span class="leader-btn-label">下页</span></button><button class="leader-mini-btn" data-action="font-panel" title="字号"><span class="leader-btn-icon leader-font-aa">Aa</span><span class="leader-btn-label">字号</span></button><button class="leader-mini-btn" data-action="note" title="备注"><span class="leader-btn-icon">✏️</span><span class="leader-btn-label">备注</span></button><button class="leader-mini-btn leader-brush-btn" data-action="brush" title="标注"><span class="leader-btn-icon">✍️</span><span class="leader-btn-label">画笔</span><span class="leader-brush-indicator"></span></button><button class="leader-mini-btn" data-action="bg-panel" title="背景"><span class="leader-btn-icon">🎨</span><span class="leader-btn-label">背景</span></button>';
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
                const range = fontPanel.querySelector(".leader-font-range");
                const parsed = parseFloat(leaderFontSize);
                range.value = String(Number.isFinite(parsed) ? clamp(parsed, 3, 8) : 5);
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
                setStore(NOTES_KEY, notesMap);
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
                const pages = Array.isArray(liveState?.pages) ? liveState.pages : [];
                const idx = clamp(liveState?.pageIndex || 0, 0, Math.max(0, pages.length - 1));
                return { pages, idx };
            };
            const globalIndex = (pages, pageIndex, lineIndex) => pages.slice(0, pageIndex).reduce((n, p) => n + (p || []).length, 0) + lineIndex;
            const buildPageKey = () => {
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
                const left = clamp(hostRect.width / 2 - panelWidth / 2, 8, hostRect.width - panelWidth - 8);
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
                    const left = clamp(rect.left + rect.width / 2 - 150, 12, window.innerWidth - 312);
                    const top = clamp(rect.bottom + 8, 12, window.innerHeight - 240);
                    box.style.position = "absolute";
                    box.style.left = `${left}px`;
                    box.style.top = `${top}px`;
                }
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
                host.style.background = "#000";
                if (bgMode === "particles") {
                    bgCanvas.style.display = "block";
                    pts = [];
                    projectionLastTs = 0;
                    bgLoop = requestAnimationFrame(drawBgLeader);
                } else {
                    bgCanvas.style.display = "none";
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
                            return `<div class="leader-flow-editor-card" draggable="true" data-flow-card-id="${escapeHtml(c.id)}"><span class="leader-flow-drag-h">⠿</span><div class="leader-flow-editor-card-main"><div class="leader-flow-editor-card-title">${escapeHtml(c.label || "")} <span class="leader-flow-type-tag">${typeLabel}</span></div><div class="leader-flow-editor-card-sub">${escapeHtml(sub)}</div></div></div>`;
                        })
                        .join("") || "<div class='leader-flow-editor-empty'>暂无卡片，点击「生成流程」</div>";
            };

            const openFlowTemplateModal = () => {
                hideFlowCtxMenu();
                let modal = flowEditorWrap.querySelector(".leader-flow-template-modal");
                if (!modal) {
                    modal = document.createElement("div");
                    modal.className = "leader-flow-template-modal";
                    modal.innerHTML =
                        '<div class="leader-flow-template-box"><h3>快速模板</h3><p class="leader-flow-template-desc">选择后将清空当前流程并按模板生成（需分栏页数足够）</p><button type="button" data-tpl="standard">标准 A-B-C-B-C</button><button type="button" data-tpl="repeat">反复 A-A-B-C-B-C-B</button><button type="button" data-tpl="short">简短 A-B-C</button><button type="button" class="leader-flow-tpl-close" data-tpl-close>取消</button></div>';
                    flowEditorWrap.appendChild(modal);
                    modal.addEventListener("click", (e) => {
                        if (e.target.matches("[data-tpl-close]") || e.target === modal) {
                            modal.style.display = "none";
                            return;
                        }
                        const b = e.target.closest("[data-tpl]");
                        if (!b) return;
                        const { pages: pp } = getPages();
                        const pn = pp.length;
                        let seq;
                        if (b.getAttribute("data-tpl") === "standard") seq = [0, 1, 2, 1, 2];
                        else if (b.getAttribute("data-tpl") === "repeat") seq = [0, 0, 1, 2, 1, 2, 1];
                        else seq = [0, 1, 2];
                        const f = worshipFlowFromPageSequence(seq, pn);
                        if (!f.cards.length) return;
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
                loadLeaderFlowSnapshot();
                closeFlowEditor();
                flowEditorWrap = document.createElement("div");
                flowEditorWrap.className = "leader-flow-editor-overlay";
                flowEditorWrap.innerHTML =
                    '<div class="leader-flow-editor-panel"><div class="leader-flow-editor-head"><span>敬拜流程编排</span><button type="button" class="leader-flow-editor-x" data-flow-close>✕</button></div><div class="leader-flow-editor-toolbar"><button type="button" data-gen>生成流程</button><button type="button" data-tpl-open>快速模板</button><button type="button" data-add="repeat">＋重复</button><button type="button" data-add="speech">＋说话/祷告</button><button type="button" data-add="free">＋自由敬拜</button></div><div class="leader-flow-editor-list" role="list"></div><p class="leader-flow-editor-tip">拖拽卡片排序 · 长按或右键打开菜单</p></div>';
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

                const list = flowEditorWrap.querySelector(".leader-flow-editor-list");
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

            function renderLeaderFlowView() {
                host.classList.toggle("leader-scroll-mode", false);
                const { pages, idx } = getPages();
                const color = liveState?.fontColor || liveState?.text?.color || "#ffffff";
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
                            return `<div class="leader-line">${escapeHtml(line)}${!noteEditMode && loadNote(gi) ? `<span class="leader-note-dot" data-line="${gi}"></span>` : ""}${noteEditMode ? `<span class="leader-plus-dot" data-line="${gi}" title="添加备注">⊕</span>` : ""}</div>`;
                        })
                        .join("") || "<div class='leader-line'>...</div>"}</div></div>`;
                } else if (card && card.type === "bridge") {
                    content = `<div class="leader-brush-mount leader-brush-mount--fit"><div class="leader-flow-stage"><div class="leader-flow-badge">${escapeHtml(card.label)}</div><div class="leader-flow-big">${escapeHtml(card.body || "（在编排中填写过渡语）")}</div></div></div>`;
                } else if (card && card.type === "speech") {
                    content = `<div class="leader-brush-mount leader-brush-mount--fit"><div class="leader-flow-stage"><div class="leader-flow-badge">${escapeHtml(card.label)}</div><div class="leader-flow-big">${escapeHtml(card.body || "")}</div><div class="leader-flow-stage-note">仅主领平板 · 会众屏保持上一页歌词</div></div></div>`;
                } else if (card && card.type === "free") {
                    content = `<div class="leader-brush-mount leader-brush-mount--fit"><div class="leader-flow-stage"><div class="leader-flow-badge">${escapeHtml(card.label)}</div><div class="leader-flow-stage-note">会众屏：经文 / 纯色背景</div><div class="leader-flow-hint">${escapeHtml(card.leaderHint || "")}</div></div></div>`;
                }
                const step = cards.length ? `${flowCursor + 1} / ${cards.length}` : "—";
                const cap = card ? escapeHtml(card.label || "") : "";
                lyricLayer.innerHTML = `<div class="leader-page">流程 ${step}${cap ? " · " + cap : ""}</div><div class="leader-main">${content}</div>`;
                toolbar.querySelectorAll("[data-mode]").forEach((btn) => btn.classList.toggle("active", btn.getAttribute("data-mode") === displayMode));
                toolbar.querySelector('[data-action="note"]')?.classList.toggle("active", noteEditMode);
                requestAnimationFrame(() => setupBrushCanvas());
            }

            function render() {
                closeOverlay();
                if (displayMode === "flow") {
                    loadLeaderFlowSnapshot();
                    renderLeaderFlowView();
                    return;
                }
                const { pages, idx } = getPages();
                const lines = pages[idx] || [];
                const nextLine = pages[idx + 1]?.[0] || "（无）";
                const color = liveState?.fontColor || liveState?.text?.color || "#ffffff";
                const curStart = pages.slice(0, idx).reduce((n, p) => n + (p || []).length, 0);
                const curEnd = curStart + lines.length - 1;
                let content = "";
                if (displayMode === "single") {
                    const gi = globalIndex(pages, idx, 0);
                    content = `<div class="leader-brush-mount leader-brush-mount--fit"><div class="leader-current leader-single" style="color:${color};font-size:${leaderFontSize};"><div class="leader-line">${escapeHtml(lines[0] || "...")}${!noteEditMode && loadNote(gi) ? `<span class="leader-note-dot" data-line="${gi}"></span>` : ""}${noteEditMode ? `<span class="leader-plus-dot" data-line="${gi}" title="添加备注">⊕</span>` : ""}</div></div></div>`;
                } else if (displayMode === "scroll") {
                    const all = pages.flat();
                    content = `<div class="leader-current leader-scroll" style="color:${color};font-size:${leaderFontSize};"><div class="leader-brush-mount leader-brush-mount--scroll">${all.map((line, i) => `<div class="leader-line${i >= curStart && i <= curEnd ? " current" : ""}" style="text-align:center;">${escapeHtml(line)}${!noteEditMode && loadNote(i) ? `<span class="leader-note-dot" data-line="${i}"></span>` : ""}${noteEditMode ? `<span class="leader-plus-dot" data-line="${i}" title="添加备注">⊕</span>` : ""}</div>`).join("")}</div></div>`;
                } else {
                    content = `<div class="leader-brush-mount leader-brush-mount--fit"><div class="leader-current leader-multi" style="color:${color};font-size:${leaderFontSize};">${lines.map((line, i) => {
                        const gi = globalIndex(pages, idx, i);
                        return `<div class="leader-line">${escapeHtml(line)}${!noteEditMode && loadNote(gi) ? `<span class="leader-note-dot" data-line="${gi}"></span>` : ""}${noteEditMode ? `<span class="leader-plus-dot" data-line="${gi}" title="添加备注">⊕</span>` : ""}</div>`;
                    }).join("") || "<div class='leader-line'>...</div>"}</div></div>`;
                }
                const nextHtml = displayMode === "scroll" ? "" : `<div class="leader-next">下句：${escapeHtml(nextLine)}</div>`;
                host.classList.toggle("leader-scroll-mode", displayMode === "scroll");
                const mainClass = displayMode === "scroll" ? "leader-main leader-main-scroll" : "leader-main";
                lyricLayer.innerHTML = `<div class="leader-page">${idx + 1}/${Math.max(1, pages.length)}</div><div class="${mainClass}">${content}</div>${nextHtml}`;
                toolbar.querySelectorAll("[data-mode]").forEach((btn) => btn.classList.toggle("active", btn.getAttribute("data-mode") === displayMode));
                toolbar.querySelector('[data-action="note"]')?.classList.toggle("active", noteEditMode);
                requestAnimationFrame(() => setupBrushCanvas());
            }

            const openLeaderSongPackImportUI = () => {
                hideBgPanel();
                hideFontPanel();
                closeOverlay();
                overlay = document.createElement("div");
                overlay.className = "leader-note-pop-wrap";
                overlay.setAttribute("data-pack-import", "1");
                overlay.innerHTML = `<div class="leader-note-pop" style="max-width:min(92vw,440px);text-align:left;">
                    <div style="font-weight:700;margin-bottom:8px;">导入诗歌包</div>
                    <p style="font-size:13px;color:rgba(230,230,230,0.78);margin:0 0 8px;line-height:1.45;">粘贴电脑上二维码对应的整段文本（以 <b>W1</b> 或 <b>W0</b> 开头）。也可先点「从剪贴板粘贴」。</p>
                    <textarea id="leader-pack-import-ta" rows="6" style="width:100%;box-sizing:border-box;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:#12151f;color:#eee;padding:8px;font-size:13px;" placeholder="W1..."></textarea>
                    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;justify-content:flex-end;">
                        <button type="button" class="leader-note-btn secondary" data-pack-cancel>取消</button>
                        <button type="button" class="leader-note-btn secondary" data-pack-clip>从剪贴板粘贴</button>
                        <button type="button" class="leader-note-btn" data-pack-go>导入</button>
                    </div></div>`;
                host.appendChild(overlay);
                const ta = overlay.querySelector("#leader-pack-import-ta");
                const shut = () => {
                    closeOverlay();
                };
                overlay.querySelector("[data-pack-cancel]")?.addEventListener("click", shut);
                overlay.addEventListener("click", (e) => {
                    if (e.target === overlay) shut();
                });
                overlay.querySelector("[data-pack-clip]")?.addEventListener("click", async (e) => {
                    try {
                        const t = await navigator.clipboard.readText();
                        if (ta && t) ta.value = String(t).trim();
                    } catch (_e) {
                        showToast("无法读取剪贴板，请长按输入框粘贴", e.currentTarget);
                    }
                });
                overlay.querySelector("[data-pack-go]")?.addEventListener("click", async (e) => {
                    const raw = String(ta?.value || "").trim();
                    if (!raw) return;
                    try {
                        const data = await decodeWorshipPackFromRawString(raw);
                        applyWorshipSongPackFromObject(data, e.currentTarget);
                        shut();
                    } catch (err) {
                        showToast("导入失败：" + (err.message || String(err)), e.currentTarget);
                    }
                });
            };

            const flip = (delta) => navigateLeaderFlow(delta);

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
                if (e.key === "Escape" && flowEditorWrap) {
                    closeFlowEditor();
                    showToolbar();
                    return;
                }
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
                if (flowCtxMenuEl && !e.target?.closest?.(".leader-flow-ctx-menu")) hideFlowCtxMenu();
                if (toolbarCollapsed) {
                    const inToolbar = e.target?.closest?.(".leader-toolbar");
                    const inFab = e.target?.closest?.(".leader-expand-fab");
                    if (!inToolbar && !inFab) setToolbarCollapsed(false);
                }
                showToolbar();
            });

            if (channel) {
                channel.onmessage = (e) => {
                    if (e.data?.type === "update" && e.data.payload?.pages) {
                        liveState = e.data.payload;
                        if (liveState?.worshipFlow?.cards?.length) localWorshipFlow = liveState.worshipFlow;
                        render();
                    }
                };
                channel.postMessage({ type: "request_state" });
            }
            window.addEventListener("storage", (e) => {
                if (e.key === STORAGE.LIVE && e.newValue) {
                    const payload = parseJSON(e.newValue, null);
                    if (payload?.pages) {
                        liveState = payload;
                        if (liveState?.worshipFlow?.cards?.length) localWorshipFlow = liveState.worshipFlow;
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

            const initState = getStore(STORAGE.LIVE, null);
            if (initState?.pages) liveState = initState;
            applyBg();
            render();
            setToolbarCollapsed(toolbarCollapsed);
            updateBrushIndicator();
            showToolbar();
            globalThis.__leaderReloadAfterPackImport = () => {
                try {
                    loadLeaderFlowSnapshot();
                    render();
                } catch (_e) {
                    /* ignore */
                }
            };

            void (async () => {
                const rawHash = location.hash.replace(/^#/, "");
                if (!rawHash.startsWith("wp1=")) return;
                let packStr = rawHash.slice(4);
                try {
                    packStr = decodeURIComponent(packStr);
                } catch (_e) {
                    /* keep raw */
                }
                try {
                    const data = await decodeWorshipPackFromRawString(packStr);
                    applyWorshipSongPackFromObject(
                        data,
                        toolbar.querySelector('[data-action="import-pack"]')
                    );
                    try {
                        history.replaceState(null, "", location.pathname + location.search);
                    } catch (_e2) {
                        /* ignore */
                    }
                } catch (err) {
                    try {
                        showToast(
                            "链接内诗歌无效：" + (err.message || String(err)),
                            toolbar.querySelector('[data-action="import-pack"]')
                        );
                    } catch (_e3) {
                        /* ignore */
                    }
                }
            })();

            return;
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
            let base = items.indexOf(state.currentSongId);
            if (base < 0) base = clamp(state.playlist.activeIndex, 0, Math.max(0, items.length - 1));
            const nextIdx = base + 1;
            if (state.playlist.running && nextIdx < items.length) {
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
                globalThis.__displayWindowOpened = false;
            } catch (_e) {
                /* ignore */
            }
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
                    if (d.type === "projection_fs_active" && d.source === "display") {
                        hideRestoreProjectionBanner();
                        return;
                    }
                    if (d.type === "projection_attention" && d.source === "display") {
                        showRestoreProjectionBanner();
                        return;
                    }
                    if (d.type === "request_state") {
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