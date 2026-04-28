(() => {
    "use strict";

    const STORAGE = {
        SONGS: "worship.songs.v5",
        SETTINGS: "worship.settings.v5",
        LIVE: "worship.live.v5",
        PLAYLIST: "playlist"
    };
    const THEME_BG_STORAGE = "worship.theme_bg.v1";
    const THEME_BG_OPACITY_STORAGE = "theme_bg_opacity";
    /** 自定义主题背景：最多保留 4 张缩略图（localStorage JSON），超出丢弃最旧 */
    const THEME_BG_SLOTS_STORAGE = "worship.theme_bg_slots.v1";
    const THEME_BG_ACTIVE_ID_STORAGE = "worship.theme_bg_active.v1";
    const THEME_BG_SLOTS_MAX = 4;
    const UPLOADED_BACKGROUNDS_STORAGE = "uploaded_backgrounds";
    /** 「我的背景」本地槽位上限；超出时丢弃最旧（按 timestamp） */
    const UPLOADED_BACKGROUNDS_MAX = 4;

    function normalizeUploadedBackgroundsArray(arr) {
        const list = Array.isArray(arr) ? arr.filter((x) => x && x.id && x.imageData) : [];
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

    function removeThemeBgSlot(slotId) {
        const id = String(slotId || "").trim();
        if (!id) return;
        _themeBgSlotsCache = _themeBgSlotsCache.filter((s) => s && s.id !== id);
        persistFullThemeBgFromSlots();
        applyThemeBackground();
        showToast("已删除主题背景", $("theme-bg-grid"));
    }

    function renderThemeBgGrid() {
        const grid = $("theme-bg-grid");
        if (!grid) return;
        grid.innerHTML = "";
        const filled = _themeBgSlotsCache
            .filter((x) => x && x.imageData)
            .sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));

        grid.classList.toggle("theme-bg-grid--empty-only", filled.length === 0);

        filled.forEach((item) => {
            const wrap = document.createElement("div");
            wrap.className = "theme-bg-slot-wrap";

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "theme-bg-slot theme-bg-slot--filled";
            if (item.id === _themeBgActiveId) btn.classList.add("theme-bg-slot--active");
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

        if (filled.length < THEME_BG_SLOTS_MAX) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "theme-bg-slot theme-bg-slot--empty";
            btn.title = "上传主题背景";
            btn.setAttribute("aria-label", "上传主题背景");
            btn.innerHTML = '<span class="theme-bg-slot-plus" aria-hidden="true">+</span>';
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                $("theme-bg-input")?.click();
            });
            grid.appendChild(btn);
        }
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
        tags: "敬拜"
    };

    const query = new URLSearchParams(location.search || "");
    const isDisplay = query.get("display") === "1";
    const isLeader = query.get("leader") === "1";

    const channel = typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel(CHANNEL_NAME)
        : null;

    const state = {
        songs: [],
        currentSongId: "",
        currentPage: 0,
        ui: {
            theme: "dark",
            fontFamily: "'Microsoft YaHei','PingFang SC',sans-serif",
            fontSize: 56,
            defaultLines: 4,
            posY: 45,
            bgType: "solid-black",
            bgImage: "",
            bgImageId: "",
            lyricsBgShareToCloud: false,
            fontColor: "#ffffff"
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
        }
    };

    let liveState = null;
    let projectionMode = isDisplay ? "display" : (isLeader ? "leader" : null);
    let projectionCanvas = null;
    let projectionCtx = null;
    let projectionParticles = [];
    let projectionBgImage = null;
    let projectionRaf = 0;
    let projectionLastTs = 0;
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

    function lyricBlockTopPadPx(boxHeight, posY) {
        const h = Number(boxHeight) || 0;
        const py = clamp(Number(posY) || 45, 20, 70);
        if (h <= 0) return 12;
        return Math.round(8 + ((py - 18) / 100) * h);
    }

    function syncPosYFromCurrentSong() {
        const song = currentSong();
        state.ui.posY = song && Number.isFinite(Number(song.posY))
            ? clamp(Number(song.posY), 20, 70)
            : defaultSongPosY;
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

    function setStore(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
    }

    function showToast(text, triggerElement) {
        const t = $("toast");
        if (!t) return;
        t.textContent = text;
        t.style.position = "fixed";
        t.classList.remove("bounceIn");
        const anchor = triggerElement && typeof triggerElement.getBoundingClientRect === "function" ? triggerElement : null;
        if (anchor) {
            const rect = anchor.getBoundingClientRect();
            const pad = 8;
            const estW = Math.min(280, window.innerWidth - 16);
            let left = rect.right + pad;
            if (left + estW > window.innerWidth - 8) {
                left = rect.left - estW - pad;
            }
            left = clamp(left, 8, Math.max(8, window.innerWidth - estW - 8));
            const top = rect.top + rect.height / 2;
            t.style.left = `${left}px`;
            t.style.top = `${clamp(top, 24, window.innerHeight - 24)}px`;
            t.style.bottom = "auto";
            t.style.right = "auto";
            t.style.transform = "translateY(-50%)";
            void t.offsetHeight;
            t.style.opacity = "1";
        } else {
            t.style.left = "50%";
            t.style.bottom = "30px";
            t.style.top = "auto";
            t.style.right = "auto";
            t.style.transform = "translateX(-50%)";
            t.classList.add("bounceIn");
            t.style.opacity = "1";
        }
        setTimeout(() => {
            t.style.opacity = "0";
            t.classList.remove("bounceIn");
        }, 1500);
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

    function splitPages(lyrics, linesPerPage) {
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
        if (!Number.isFinite(n)) return 0.75;
        return clamp(n, 0.3, 1);
    }

    function applyThemeBgOpacityVar() {
        document.documentElement.style.setProperty("--theme-bg-opacity", String(getThemeBgOpacity()));
    }

    function syncThemeBgOpacityControls() {
        const row = $("theme-bg-opacity-row");
        const slider = $("theme-bg-opacity-slider");
        const valEl = $("theme-bg-opacity-value");
        const hasCustom = !!(_idbThemeBgCache || "").trim();
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
        const raw = _idbThemeBgCache;
        const body = document.body;
        const root = document.documentElement;
        applyThemeBgOpacityVar();
        if (raw && String(raw).trim()) {
            const safe = String(raw).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            const val = `url("${safe}")`;
            root.style.setProperty("--theme-bg-image", val);
            body.setAttribute("data-theme-custom-bg", "1");
        } else {
            root.style.setProperty("--theme-bg-image", "none");
            body.removeAttribute("data-theme-custom-bg");
        }
        body.style.backgroundImage = "";
        syncThemeBgOpacityControls();
        renderThemeBgGrid();
    }

    function bgItemId() {
        return "bg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
    }

    function getUploadedBackgrounds() {
        return Array.isArray(_idbUploadedCache) ? _idbUploadedCache : [];
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
                tags: [],
                timestamp: Date.now(),
                shared: false
            };
            saveUploadedBackgrounds([match, ...items]);
        }
        state.ui.bgImageId = match.id;
        saveSettings();
    }

    function migrateLegacyUploadedBackgrounds() {
        if (getUploadedBackgrounds().length > 0) return;
        const old = getStore(LEGACY_LYRIC_BGS_STORAGE, null);
        if (old && Array.isArray(old.items) && old.items.length) {
            const mapped = old.items.map((x) => ({
                id: bgItemId(),
                imageData: String(x.dataUrl || x.imageData || "").trim(),
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
                tags: [],
                timestamp: Date.now(),
                shared: false
            }]);
            state.ui.bgImageId = nid;
            saveSettings();
        }
    }

    function addUploadedBackgroundAndApply(imageData) {
        const data = String(imageData || "").trim();
        if (!data) return;
        let arr = getUploadedBackgrounds().slice();
        let chosenId = "";
        const existing = arr.find((x) => x && x.imageData === data);
        if (existing) {
            chosenId = existing.id;
        } else {
            chosenId = bgItemId();
            arr = [{
                id: chosenId,
                imageData: data,
                tags: [],
                timestamp: Date.now(),
                shared: false
            }, ...arr];
            saveUploadedBackgrounds(arr);
        }
        state.ui.bgType = "image";
        state.ui.bgImage = data;
        state.ui.bgImageId = chosenId;
        state.ui.lyricsBgShareToCloud = false;
        renderUploadedBackgrounds();
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

    function renderUploadedBackgrounds() {
        const root = $("my-backgrounds-container");
        if (!root) return;
        const items = getUploadedBackgrounds();
        root.innerHTML = "";
        if (!items.length) {
            root.innerHTML = '<div class="hint-text" style="grid-column:1/-1;">暂无已上传背景，请在「预设背景」中上传图片</div>';
            return;
        }
        items.forEach((item) => {
            if (!item || !item.imageData) return;
            const wrap = document.createElement("div");
            wrap.className = "lyric-bg-thumb-wrap";
            const thumb = document.createElement("button");
            thumb.type = "button";
            thumb.className = "lyric-bg-thumb";
            thumb.dataset.itemId = item.id;
            thumb.style.backgroundImage = `url("${String(item.imageData).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
            thumb.title = "设为当前歌词背景";
            if (state.ui.bgType === "image" && state.ui.bgImage === item.imageData) {
                thumb.classList.add("lyric-bg-thumb--active");
            }
            thumb.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                state.ui.bgType = "image";
                state.ui.bgImageId = item.id;
                state.ui.bgImage = item.imageData;
                state.ui.lyricsBgShareToCloud = false;
                updateUIFromState();
                updateAll();
                saveSettings();
                renderUploadedBackgrounds();
                showToast("已切换背景", thumb);
            });
            wrap.appendChild(thumb);
            if (!item.shared) {
                const shareBtn = document.createElement("button");
                shareBtn.type = "button";
                shareBtn.className = "bg-share-icon";
                shareBtn.title = "共享到云端";
                shareBtn.setAttribute("aria-label", "共享此背景");
                shareBtn.textContent = "☁";
                shareBtn.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    shareMyBackgroundItem(item.id, shareBtn);
                });
                wrap.appendChild(shareBtn);
            } else {
                const badge = document.createElement("span");
                badge.className = "bg-shared-badge";
                badge.title = "已共享";
                wrap.appendChild(badge);
            }
            root.appendChild(wrap);
        });
    }

    async function shareMyBackgroundItem(itemId, triggerEl) {
        const arr = getUploadedBackgrounds();
        const item = arr.find((x) => x && x.id === itemId);
        if (!item || !item.imageData || item.shared) return;
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
                state.ui.lyricsBgShareToCloud = false;
                updateUIFromState();
                updateAll();
                saveSettings();
                showToast("已应用共享背景", thumb);
            });
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
        if (tabName === "mine") renderUploadedBackgrounds();
    }

    function initBgTabs() {
        const tabs = document.querySelectorAll(".bg-tab");
        if (!tabs.length) return;
        tabs.forEach((tab) => {
            tab.addEventListener("click", () => {
                switchBgTabTo(tab.getAttribute("data-bg-tab") || "preset");
            });
        });
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
        setStore(STORAGE.SONGS, state.songs);
    }

    function saveSettings() {
        const ui = { ...state.ui };
        if (ui.bgType === "image" && ui.bgImageId) {
            ui.bgImage = "";
        }
        setStore(STORAGE.SETTINGS, {
            currentSongId: state.currentSongId,
            currentPage: state.currentPage,
            sizePreset: state.sizePreset,
            ui
        });
    }

    function savePlaylist() {
        setStore(STORAGE.PLAYLIST, {
            items: state.playlist.items,
            running: state.playlist.running,
            activeIndex: state.playlist.activeIndex
        });
    }

    function loadState() {
        const songs = getStore(STORAGE.SONGS, []);
        const settings = getStore(STORAGE.SETTINGS, null);

        if (Array.isArray(songs) && songs.length) {
            state.songs = songs;
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
            if (!state.ui.bgImageId) state.ui.bgImageId = "";
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
        state.playlist.autoSwitch = localStorage.getItem("playlist_auto_switch") === "1";
        defaultSongPosY = clamp(Number(state.ui.posY) || 45, 20, 70);
    }

    function syncSongToEditor() {
        const song = currentSong();
        if (!song) return;
        if ($("song-title-input")) $("song-title-input").value = song.title || "";
        if ($("lyric-editor-large")) $("lyric-editor-large").value = song.lyrics || "";
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
    }

    function applyCardBackground(card) {
        clearCssDynamicBgClass(card);
        card.style.background = "#000";
        card.style.backgroundImage = "none";
        if (CSS_DYNAMIC_BG_TYPES.has(state.ui.bgType)) {
            card.style.background = "";
            card.classList.add(`css-bg-${state.ui.bgType}`);
            return;
        }
        if (state.ui.bgType === "solid-white") {
            card.style.background = "#fff";
        } else if (state.ui.bgType === "solid-gray") {
            card.style.background = "#444";
        } else if (state.ui.bgType === "gradient") {
            card.style.background = "linear-gradient(135deg,#1a2f59,#0a0f1d)";
        } else if (state.ui.bgType === "image" && state.ui.bgImage) {
            card.style.backgroundImage = `url("${state.ui.bgImage}")`;
            card.style.backgroundSize = "cover";
            card.style.backgroundPosition = "center";
        }
    }

    function updateSpeakerCards() {
        const container = $("card-container");
        if (!container) return;
        const song = currentSong();
        const pages = splitPages(song?.lyrics || "", state.ui.defaultLines);
        state.currentPage = clamp(state.currentPage, 0, pages.length - 1);
        container.innerHTML = "";

        const scale = state.sizePreset === "S" ? 0.8 : state.sizePreset === "L" ? 1.2 : 1;
        const size = Math.round(state.ui.fontSize * 0.34 * scale);
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
            updateAll();
        };

        pages.forEach((lines, idx) => {
            const card = document.createElement("div");
            card.className = "card" + (idx === state.currentPage ? " active" : "");
            applyCardBackground(card);
            card.style.boxSizing = "border-box";
            card.style.paddingLeft = "20px";
            card.style.paddingRight = "20px";
            card.style.paddingBottom = "20px";
            card.style.paddingTop = `${lyricBlockTopPadPx(200, state.ui.posY)}px`;
            lines.forEach((line, lineIndex) => {
                const row = document.createElement("div");
                row.className = "card-line";
                row.draggable = true;
                row.style.fontSize = size + "px";
                row.style.color = state.ui.bgType === "solid-white" ? "#111" : state.ui.fontColor;
                row.textContent = line;
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
                updateAll();
            });
            container.appendChild(card);
        });

        if ($("page-indicator")) $("page-indicator").textContent = `${state.currentPage + 1}/${pages.length}`;
    }

    function renderSongList() {
        const list = $("song-list");
        if (!list) return;
        const key = ($("search-input")?.value || "").trim().toLowerCase();
        list.innerHTML = "";
        state.songs.forEach((song) => {
            const hay = `${song.title || ""}\n${song.lyrics || ""}\n${song.tags || ""}`.toLowerCase();
            if (key && !hay.includes(key)) return;
            const li = document.createElement("li");
            li.className = "song-item" + (song.id === state.currentSongId ? " active" : "");
            li.innerHTML = `<div class="song-item-main"><span>${escapeHtml(song.title || "未命名")}</span><span style="opacity:.65">${splitPages(song.lyrics, state.ui.defaultLines).length}页</span></div><button class="song-add-btn" title="加入播放列表" data-song-id="${song.id}">+</button>`;
            li.addEventListener("click", () => switchSong(song.id));
            li.querySelector(".song-add-btn")?.addEventListener("click", (e) => {
                e.stopPropagation();
                addToPlaylist(song.id, e.currentTarget);
            });
            list.appendChild(li);
        });
    }

    function renderPlaylist() {
        const list = $("playlist-list");
        if (!list) return;
        list.innerHTML = "";
        let dragFromIndex = -1;
        if (!state.playlist.items.length) {
            list.innerHTML = '<li class="playlist-empty">将诗歌拖入或点击 + 添加</li>';
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

    function switchToPlaylistSong(index, withFade) {
        if (index < 0 || index >= state.playlist.items.length) return false;
        const songId = state.playlist.items[index];
        if (!state.songs.some((s) => s.id === songId)) return false;
        state.playlist.running = true;
        state.playlist.activeIndex = index;
        if (withFade) state.playlist.fadeNext = true;
        switchSong(songId);
        state.currentPage = 0;
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

    function renderTagFilter() {
        const root = $("tag-filter");
        if (!root) return;
        const tags = new Set();
        state.songs.forEach((s) => {
            (s.tags || "").split(/[,\s]+/).map((t) => t.trim()).filter(Boolean).forEach((t) => tags.add(t));
        });
        root.innerHTML = "";
        [...tags].slice(0, 20).forEach((tag) => {
            const b = document.createElement("button");
            b.className = "small-btn";
            b.style.width = "auto";
            b.style.padding = "4px 8px";
            b.style.marginTop = "0";
            b.textContent = tag;
            b.addEventListener("click", () => {
                if ($("search-input")) $("search-input").value = tag;
                renderSongList();
            });
            root.appendChild(b);
        });
    }

    function renderMiniPreview() {
        const mini = $("mini-preview");
        if (!mini) return;
        const song = currentSong();
        const pages = splitPages(song?.lyrics || "", state.ui.defaultLines);
        const lines = pages[state.currentPage] || [];

        mini.innerHTML = "";
        clearCssDynamicBgClass(mini);
        mini.style.background = "var(--preview-bg)";
        mini.style.backgroundImage = "none";
        if (CSS_DYNAMIC_BG_TYPES.has(state.ui.bgType)) {
            mini.style.background = "";
            mini.classList.add(`css-bg-${state.ui.bgType}`);
        } else if (state.ui.bgType === "solid-white") mini.style.background = "#fff";
        else if (state.ui.bgType === "solid-gray") mini.style.background = "#444";
        else if (state.ui.bgType === "gradient") mini.style.background = "linear-gradient(140deg,#1b2f59,#0a0f1d)";
        else if (state.ui.bgType === "image" && state.ui.bgImage) {
            mini.style.backgroundImage = `url("${state.ui.bgImage}")`;
            mini.style.backgroundSize = "cover";
            mini.style.backgroundPosition = "center";
        }

        mini.style.display = "flex";
        mini.style.flexDirection = "column";
        mini.style.justifyContent = "flex-start";
        mini.style.alignItems = "center";
        mini.style.boxSizing = "border-box";
        mini.style.paddingTop = `${lyricBlockTopPadPx(mini.clientHeight, state.ui.posY)}px`;
        mini.style.paddingBottom = "12px";
        mini.style.paddingLeft = "12px";
        mini.style.paddingRight = "12px";

        lines.forEach((line) => {
            const row = document.createElement("div");
            row.className = "preview-line";
            row.style.fontFamily = state.ui.fontFamily;
            row.style.fontSize = Math.round(state.ui.fontSize * 0.42) + "px";
            row.style.color = state.ui.bgType === "solid-white" ? "#111" : state.ui.fontColor;
            row.textContent = line;
            mini.appendChild(row);
        });
        if ($("preview-line-counter")) $("preview-line-counter").textContent = `(${lines.length} 行)`;
    }

    async function searchOnlineHymns() {
        const input = $("online-search-input");
        const panel = $("online-results");
        if (!input || !panel) return;
        const q = input.value.trim().toLowerCase();
        panel.innerHTML = "";
        if (!q) return;
        if (!supabase) {
            panel.innerHTML = '<div class="hint-text">Supabase 未初始化</div>';
            return;
        }
        const { data, error } = await supabase
            .from("hymns")
            .select("*")
            .ilike("title", `%${q}%`)
            .limit(12);
        if (error) {
            panel.innerHTML = '<div class="hint-text">云端搜索失败</div>';
            return;
        }
        const matches = Array.isArray(data) ? data : [];
        if (!matches.length) {
            panel.innerHTML = '<div class="hint-text">未找到云端匹配</div>';
            return;
        }
        matches.forEach((row) => {
            const box = document.createElement("div");
            box.style.cssText = "display:flex;gap:6px;align-items:center;margin-top:4px;";
            const title = document.createElement("div");
            title.className = "hint-text";
            title.style.cssText = "flex:1;text-align:left;padding:0 4px;";
            title.textContent = row.title || "未命名";
            const btn = document.createElement("button");
            btn.className = "small-btn";
            btn.style.cssText = "width:auto;margin-top:0;padding:4px 8px;white-space:nowrap;";
            btn.textContent = "导入";
            btn.addEventListener("click", () => {
                const imported = {
                    id: uid(),
                    title: String(row.title || "未命名"),
                    lyrics: String(row.lyrics || ""),
                    key: "",
                    tempo: "",
                    notes: "",
                    tags: Array.isArray(row.tags) ? row.tags.join(",") : String(row.tags || "")
                };
                state.songs.push(imported);
                saveSongs();
                renderSongList();
                renderTagFilter();
                showToast("已导入云端诗歌", btn);
            });
            box.appendChild(title);
            box.appendChild(btn);
            panel.appendChild(box);
        });
    }

    function renderOnlineSearchResult() {
        return searchOnlineHymns();
    }

    function ensureFontColorControls() {
        if ($("font-color-custom")) return;
        const panel = $("preview-panel");
        if (!panel) return;
        const group = document.createElement("div");
        group.className = "setting-group";
        group.innerHTML = '<label>🎨 字体颜色</label><div id="font-color-chips" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;"></div><input id="font-color-custom" type="text" placeholder="#ffffff" style="width:100%;padding:8px;border-radius:10px;border:1px solid var(--border-color);background:var(--editor-bg);color:var(--text-primary);">';
        const target = $("theme-selector")?.closest(".setting-group");
        if (target?.parentElement) target.parentElement.insertBefore(group, target);
        else panel.appendChild(group);
        const colors = ["#ffffff", "#d9d9d9", "#ffd700", "#9fd3ff", "#b8f5b8", "#ffc0cb"];
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
    }

    function updateBgImageThumb() {
        const imageOption = document.querySelector('.bg-option[data-bg="image"]');
        if (!imageOption) return;
        if (state.ui.bgImage) {
            imageOption.style.backgroundImage = `url("${state.ui.bgImage}")`;
            imageOption.style.backgroundSize = "cover";
            imageOption.style.backgroundPosition = "center";
            imageOption.style.borderStyle = "solid";
        } else {
            imageOption.style.borderStyle = "dashed";
        }
    }

    function updateUIFromState() {
        if ($("theme-selector")) $("theme-selector").value = state.ui.theme;
        if ($("font-family-selector")) $("font-family-selector").value = state.ui.fontFamily;
        if ($("font-slider")) $("font-slider").value = String(state.ui.fontSize);
        if ($("font-val")) $("font-val").textContent = String(state.ui.fontSize);
        if ($("default-lines-input")) $("default-lines-input").value = String(state.ui.defaultLines);
        if ($("pos-slider")) $("pos-slider").value = String(state.ui.posY);
        if ($("pos-val")) $("pos-val").textContent = String(state.ui.posY);
        document.body.setAttribute("data-theme", state.ui.theme);
        updateBgImageThumb();
        if ($("font-color-custom")) $("font-color-custom").value = state.ui.fontColor;
        document.querySelectorAll(".font-color-chip").forEach((chip) => {
            chip.classList.toggle("active", chip.dataset.color === state.ui.fontColor);
        });
        document.querySelectorAll(".bg-option").forEach((node) => {
            node.classList.toggle("active", node.getAttribute("data-bg") === state.ui.bgType);
        });
        ["size-s", "size-m", "size-l"].forEach((id) => {
            const el = $(id);
            if (el) el.classList.toggle("active", state.sizePreset === id.split("-")[1].toUpperCase());
        });
        syncThemeBgOpacityControls();
        updateMyBackgroundThumbActiveState();
    }

    function buildLiveState() {
        syncEditorToSong();
        const song = currentSong();
        const pages = splitPages(song?.lyrics || "", state.ui.defaultLines);
        state.currentPage = clamp(state.currentPage, 0, pages.length - 1);
        const fadeNow = !!state.playlist.fadeNext;
        state.playlist.fadeNext = false;
        return {
            version: 1,
            updatedAt: Date.now(),
            title: song?.title || "",
            fontColor: state.ui.fontColor || "#ffffff",
            playlistFade: fadeNow,
            pages,
            pageIndex: state.currentPage,
            text: {
                fontFamily: state.ui.fontFamily,
                fontSize: state.ui.fontSize,
                topPct: state.ui.posY,
                color: state.ui.bgType === "solid-white" ? "#111" : state.ui.fontColor
            },
            background: {
                type: state.ui.bgType,
                imageData: state.ui.bgImage
            }
        };
    }

    function respondCurrentState() {
        if (!channel) return;
        const payload = buildLiveState();
        liveState = payload;
        channel.postMessage({ type: "update", payload, source: "main" });
    }

    function broadcastState() {
        liveState = buildLiveState();
        setStore(STORAGE.LIVE, liveState);
        if (channel) {
            const msg = { type: "update", payload: liveState, source: "main" };
            channel.postMessage(msg);
            requestAnimationFrame(() => {
                channel.postMessage(msg);
            });
        }
        saveSongs();
        saveSettings();
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

    function updateAll() {
        updateSpeakerCards();
        renderMiniPreview();
        renderPlaylist();
        broadcastState();
    }

    function setBackground(bgType) {
        state.ui.bgType = bgType || "solid-black";
        if (state.ui.bgType !== "image") {
            state.ui.lyricsBgShareToCloud = false;
            state.ui.bgImage = "";
            state.ui.bgImageId = "";
        }
        updateUIFromState();
        updateAll();
    }

    function switchSong(songId) {
        if (!state.songs.some((s) => s.id === songId)) return;
        state.currentSongId = songId;
        state.currentPage = 0;
        syncPosYFromCurrentSong();
        updateUIFromState();
        syncSongToEditor();
        renderSongList();
        updateSpeakerCards();
        renderMiniPreview();
        renderPlaylist();
        saveSettings();
    }

    function saveCurrentLyrics() {
        syncEditorToSong();
        saveSongs();
        renderSongList();
        renderTagFilter();
        updateSpeakerCards();
        renderMiniPreview();
        broadcastState();
        showToast("已保存歌词", $("save-song-btn"));
    }

    function createNewSong() {
        const title = (prompt("请输入诗歌标题", "新诗歌") || "").trim();
        if (!title) return;
        const song = { id: uid(), title, lyrics: "", key: "", tempo: "", notes: "", tags: "" };
        const currentIndex = Math.max(0, state.songs.findIndex((s) => s.id === state.currentSongId));
        state.songs.splice(currentIndex + 1, 0, song);
        saveSongs();
        switchSong(song.id);
        renderTagFilter();
        showToast("已新建诗歌", $("new-song-btn"));
    }

    async function publishSong() {
        const s = getCurrentSong();
        if (!s.lyrics || !s.lyrics.length) { showToast('无歌词可发布'); return; }
        const url = 'https://spring-bush-d415.cuirenjie123456789.workers.dev';
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: s.title, lyrics: s.lyrics, tags: s.tags || [] })
            });
            if (response.ok) { showToast('✅ 已发布到云端'); }
            else { showToast('❌ 发布失败，请重试'); }
        } catch(e) { console.error('发布失败:', e); showToast('❌ 发布失败，请重试'); }
    }

    function openLeaderQrModal() {
        let modal = $("leader-qr-modal");
        const leaderUrl = `${location.origin}${location.pathname}?leader=1`;
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(leaderUrl)}`;
        if (!modal) {
            modal = document.createElement("div");
            modal.id = "leader-qr-modal";
            modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:2600;display:flex;align-items:center;justify-content:center;";
            modal.innerHTML = `
                <div style="background:var(--bg-secondary);border-radius:16px;padding:16px 18px;text-align:center;min-width:220px;position:relative;">
                    <button id="leader-qr-close" style="position:absolute;right:8px;top:6px;border:none;background:transparent;color:var(--text-secondary);cursor:pointer;">✕</button>
                    <img id="leader-qr-image" alt="leader qr" style="width:150px;height:150px;border-radius:10px;background:#fff;padding:6px;">
                    <div style="margin-top:10px;color:var(--text-secondary);font-size:0.9rem;">📱 扫码进入主领视角</div>
                </div>
            `;
            modal.addEventListener("click", (e) => {
                if (e.target === modal) modal.style.display = "none";
            });
            document.body.appendChild(modal);
            modal.querySelector("#leader-qr-close")?.addEventListener("click", () => {
                modal.style.display = "none";
            });
        }
        const img = modal.querySelector("#leader-qr-image");
        if (img) img.src = qrUrl;
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
        a.download = "worship-data.worship";
        a.click();
        URL.revokeObjectURL(url);
        showToast("已导出", $("export-data-btn"));
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
            if (!state.ui.bgImageId) state.ui.bgImageId = "";
            normalizeLegacyBgImageReference();
            updateUIFromState();
            syncSongToEditor();
            renderSongList();
            renderTagFilter();
            updateSpeakerCards();
            renderMiniPreview();
            renderPlaylist();
            broadcastState();
            showToast("导入成功", $("import-data-btn"));
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
            const pages = splitPages(currentSong()?.lyrics || "", state.ui.defaultLines);
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

    async function openDisplayOnSecondScreen(url, windowName, toastAnchor) {
        const FULLSCREEN_HINT = "📺 请将此窗口拖动到投影仪屏幕上，然后按 F 全屏";
        const W = 1280;
        const H = 720;
        const win = window.open("about:blank", windowName, `width=${W},height=${H}`);
        if (!win) {
            if (toastAnchor) showToast("无法打开窗口，请允许弹窗", toastAnchor);
            return;
        }
        win.onload = () => {
            try {
                const h = String(win.location.href || "");
                if (h.includes("display=1") || h.includes("leader=1")) {
                    win.document.documentElement.requestFullscreen();
                }
            } catch (e) {
                /* 部分环境需用户再次手势 */
            }
        };

        let showDragHint = true;
        if ("getScreenDetails" in window && typeof window.getScreenDetails === "function") {
            try {
                const screenDetails = await window.getScreenDetails();
                const screens = screenDetails.screens;
                const secondaryScreen = screens.find((s) => !s.isPrimary) || screens[screens.length - 1];
                if (secondaryScreen) {
                    const left = Math.round(secondaryScreen.availLeft + (secondaryScreen.availWidth - W) / 2);
                    const top = Math.round(secondaryScreen.availTop + (secondaryScreen.availHeight - H) / 2);
                    try {
                        win.moveTo(left, top);
                        win.resizeTo(W, H);
                    } catch (moveErr) {
                        console.log("移动窗口到目标屏幕失败", moveErr);
                    }
                    if (screens.some((s) => !s.isPrimary) && secondaryScreen && !secondaryScreen.isPrimary) {
                        showDragHint = false;
                    }
                }
            } catch (e) {
                console.log("多屏幕API失败，使用回退方案", e);
            }
        }
        if (showDragHint && toastAnchor) showToast(FULLSCREEN_HINT, toastAnchor);
        try {
            win.location.replace(url);
        } catch (e) {
            win.location.href = url;
        }
        if (!isDisplay && !isLeader) refocusMainWindowForOperator();
    }

    function openDisplayWindow() {
        broadcastState();
        refocusMainWindowForOperator();
        void openDisplayOnSecondScreen("./index.html?display=1", "_blank", $("open-display-btn"));
    }

    function openLeaderWindow() {
        broadcastState();
        refocusMainWindowForOperator();
        void openDisplayOnSecondScreen("./index.html?leader=1", "worship_leader", $("open-leader-btn"));
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

    function bindEvents() {
        const on = (id, event, fn) => {
            const el = $(id);
            if (el) el.addEventListener(event, fn);
        };

        on("new-song-btn", "click", createNewSong);
        on("add-song-btn", "click", createNewSong);
        on("save-song-btn", "click", saveCurrentLyrics);
        on("publish-song-btn", "click", publishSong);
        on("apply-to-display", "click", () => {
            saveCurrentLyrics();
            broadcastState();
            showToast("已同步到演示", $("apply-to-display"));
        });
        on("reset-current-song", "click", () => {
            if ($("lyric-editor-large")) $("lyric-editor-large").value = DEFAULT_LYRICS;
            saveCurrentLyrics();
        });
        on("ocr-btn", "click", () => $("ocr-file-input")?.click());
        on("help-btn", "click", openHelpModal);
        on("ocr-file-input", "change", async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            if (typeof Tesseract === "undefined") {
                showToast("OCR 组件未加载", $("ocr-btn"));
                return;
            }
            showToast("OCR 识别中...", $("ocr-btn"));
            try {
                const res = await Tesseract.recognize(file, "chi_sim+eng", { logger: () => {} });
                const text = [$("lyric-editor-large")?.value || "", res?.data?.text || ""].filter(Boolean).join("\n");
                if ($("lyric-editor-large")) $("lyric-editor-large").value = text;
                saveCurrentLyrics();
            } catch (_e) {
                showToast("OCR 失败", $("ocr-btn"));
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
            renderTagFilter();
            renderPlaylist();
            showToast(`已导入 ${count} 首`, $("batch-import-btn"));
        });
        on("playlist-start-btn", "click", startPlaylistPlayback);
        on("playlist-auto-switch", "change", () => {
            state.playlist.autoSwitch = !!$("playlist-auto-switch")?.checked;
            localStorage.setItem("playlist_auto_switch", state.playlist.autoSwitch ? "1" : "0");
        });

        on("search-input", "input", renderSongList);
        on("online-search-input", "input", renderOnlineSearchResult);

        on("font-slider", "input", () => {
            state.ui.fontSize = clamp(Number($("font-slider").value || 56), 24, 120);
            if ($("font-val")) $("font-val").textContent = String(state.ui.fontSize);
            updateAll();
        });
        on("default-lines-input", "input", () => {
            state.ui.defaultLines = clamp(Number($("default-lines-input").value || 4), 1, 20);
            state.currentPage = 0;
            updateAll();
        });
        on("pos-slider", "input", () => {
            state.ui.posY = clamp(Number($("pos-slider").value || 45), 20, 70);
            if ($("pos-val")) $("pos-val").textContent = String(state.ui.posY);
            const song = currentSong();
            if (song) song.posY = state.ui.posY;
            updateAll();
        });
        on("font-family-selector", "change", () => {
            state.ui.fontFamily = $("font-family-selector").value;
            updateAll();
        });
        on("theme-selector", "change", () => {
            state.ui.theme = $("theme-selector").value;
            document.body.setAttribute("data-theme", state.ui.theme);
            saveSettings();
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
            state.ui.lyricsBgShareToCloud = false;
            updateUIFromState();
            updateAll();
            saveSettings();
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
                    showToast("未能读取图片", toastAnchor);
                    input.value = "";
                    return;
                }
                try {
                    addUploadedBackgroundAndApply(dataUrl);
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
        on("theme-bg-input", "change", (e) => {
            const input = e.target;
            const file = input.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            const toastAnchor = $("theme-bg-grid") || $("theme-bg-input");
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
        });
        on("theme-bg-opacity-slider", "input", () => {
            const v = clamp(parseFloat($("theme-bg-opacity-slider").value || "0.75"), 0.3, 1);
            localStorage.setItem(THEME_BG_OPACITY_STORAGE, String(v));
            document.documentElement.style.setProperty("--theme-bg-opacity", String(v));
            if ($("theme-bg-opacity-value")) $("theme-bg-opacity-value").textContent = `${Math.round(v * 100)}%`;
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
        on("open-leader-btn", "click", openLeaderWindow);
        on("leader-qr-btn", "click", openLeaderQrModal);

        ["size-s", "size-m", "size-l"].forEach((id) => {
            on(id, "click", () => {
                state.sizePreset = id.split("-")[1].toUpperCase();
                updateUIFromState();
                updateSpeakerCards();
                saveSettings();
            });
        });

        on("lyric-editor-large", "input", () => {
            syncEditorToSong();
            state.currentPage = 0;
            updateSpeakerCards();
            renderMiniPreview();
        });
        on("song-title-input", "input", () => {
            syncEditorToSong();
            renderSongList();
        });
        on("song-key", "input", syncEditorToSong);
        on("song-tempo", "input", syncEditorToSong);
        on("song-notes", "input", syncEditorToSong);
        on("song-tags", "input", () => {
            syncEditorToSong();
            renderTagFilter();
        });

        document.addEventListener("keydown", (e) => {
            if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
            if (e.code === "Space") {
                e.preventDefault();
                changePage(1);
            } else if (e.key === "ArrowRight") {
                changePage(1);
            } else if (e.key === "ArrowLeft") {
                changePage(-1);
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

        const canvas = document.createElement("canvas");
        canvas.id = "projection-bg";
        canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
        host.appendChild(canvas);
        projectionCanvas = canvas;
        projectionCtx = canvas.getContext("2d");

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

        const nav = document.createElement("div");
        nav.style.cssText = "position:absolute;left:0;right:0;bottom:24px;display:flex;justify-content:center;gap:12px;z-index:3;";
        nav.innerHTML = '<button id="projection-prev-btn" class="display-control-btn">上一页</button><button id="projection-next-btn" class="display-control-btn">下一页</button>';
        host.appendChild(nav);

        if (mode === "display") {
            const preview = document.createElement("div");
            preview.id = "display-card-preview";
            preview.style.cssText = "position:absolute;left:20px;right:20px;bottom:72px;display:flex;gap:8px;overflow:auto;justify-content:center;z-index:3;padding:4px;flex:1 1 auto;";
            host.appendChild(preview);
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

    function drawBg(ts) {
        if (!projectionCtx || !liveState) return;
        const bgState = liveState.background || {};
        const type = bgState.type || "solid-black";
        const gifLayer = $("projection-bg-image");

        if (CSS_DYNAMIC_BG_TYPES.has(type)) {
            ensureProjectionCssBg(type);
            if (gifLayer) gifLayer.style.display = "none";
            if (projectionCanvas) projectionCanvas.style.display = "none";
            projectionLastTs = ts;
            projectionRaf = 0;
            return;
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
            const isGif = /^data:image\/gif/i.test(bgState.imageData);
            if (isGif && gifLayer) {
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
        const gifAnimating = type === "image" && typeof bgState.imageData === "string" && /^data:image\/gif/i.test(bgState.imageData);
        const loop = type === "particles" || gifAnimating || (type === "image" && projectionBgImage && !projectionBgImage.complete);
        if (loop) projectionRaf = requestAnimationFrame(drawBg);
        else projectionRaf = 0;
    }

    function restartBg() {
        if (projectionRaf) cancelAnimationFrame(projectionRaf);
        projectionRaf = requestAnimationFrame(drawBg);
    }

    function renderDisplayLyric() {
        const layer = $("projection-lyric");
        if (!layer || !liveState) return;
        const pages = liveState.pages || [];
        const idx = clamp(liveState.pageIndex || 0, 0, Math.max(0, pages.length - 1));
        const lines = pages[idx] || [];
        const t = liveState.text || {};
        const fontColor = liveState.fontColor || t.color || "#ffffff";
        layer.style.textAlign = "center";
        layer.style.top = (t.topPct || 45) + "%";
        layer.style.fontFamily = t.fontFamily || state.ui.fontFamily;
        layer.style.fontSize = clamp(t.fontSize || 56, 24, 160) + "px";
        layer.style.color = fontColor;
        const applyFade = !!liveState.playlistFade;
        layer.style.transition = "opacity 300ms ease";
        if (applyFade) layer.style.opacity = "0";
        layer.innerHTML = lines.map((line) => `<div>${escapeHtml(line)}</div>`).join("");
        if (applyFade) requestAnimationFrame(() => { layer.style.opacity = "1"; });
        updateDisplayCardPreview();
    }

    function renderLeaderLyric() {
        const layer = $("projection-lyric");
        if (!layer || !liveState) return;
        const pages = liveState.pages || [];
        const idx = clamp(liveState.pageIndex || 0, 0, Math.max(0, pages.length - 1));
        const current = pages[idx] || [];
        const next = pages[idx + 1] || [];
        const t = liveState.text || {};
        const fontColor = liveState.fontColor || t.color || "#ffffff";
        layer.style.textAlign = "left";
        layer.style.fontFamily = t.fontFamily || state.ui.fontFamily;
        layer.style.color = fontColor;
        layer.style.fontSize = "44px";
        const applyFade = !!liveState.playlistFade;
        layer.style.transition = "opacity 300ms ease";
        if (applyFade) layer.style.opacity = "0";
        layer.innerHTML = [
            `<div style="position:absolute;top:-90px;right:0;font-size:16px;opacity:.9;">第 ${idx + 1}/${Math.max(1, pages.length)} 页</div>`,
            `<div style="line-height:1.35;margin-bottom:20px;">${current.map((x) => escapeHtml(x)).join("<br>") || "..."}</div>`,
            `<div style="font-size:22px;opacity:.75;">下页：${next.length ? next.map((x) => escapeHtml(x)).join(" / ") : "（无）"}</div>`
        ].join("");
        if (applyFade) requestAnimationFrame(() => { layer.style.opacity = "1"; });
    }

    function updateDisplayCardPreview() {
        const holder = $("display-card-preview");
        if (!holder || !liveState) return;
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
        if (payload === undefined && mode && typeof mode === "object") {
            payload = mode;
            mode = projectionMode || "display";
        }
        if (!payload || !payload.pages) return;
        liveState = payload;
        if ((mode || projectionMode) === "display") renderDisplayLyric();
        else renderLeaderLyric();
        restartBg();
    }

    function initDisplayMode() {
        projectionMode = "display";
        installProjectionUI("display");
        const initState = getStore(STORAGE.LIVE, null);
        if (initState) applyLive("display", initState);
        const onPrev = () => channel && channel.postMessage({ type: "flip", delta: -1 });
        const onNext = () => channel && channel.postMessage({ type: "flip", delta: 1 });
        $("projection-prev-btn")?.addEventListener("click", onPrev);
        $("projection-next-btn")?.addEventListener("click", onNext);
        document.addEventListener("keydown", (e) => {
            if (e.key === "ArrowLeft") onPrev();
            if (e.key === "ArrowRight") onNext();
        });

        if (channel) {
            channel.onmessage = (e) => {
                const d = e.data;
                if (d && d.type === "update" && d.payload && d.payload.pages) {
                    applyLive("display", d.payload);
                }
            };
            channel.postMessage({ type: "request_state" });
        }

        window.addEventListener("storage", (e) => {
            if (e.key === STORAGE.LIVE && e.newValue) applyLive("display", parseJSON(e.newValue, null));
        });
        window.addEventListener("resize", () => {
            restartBg();
            updateDisplayCardPreview();
        });
    }

    function initLeaderView() {
        {
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

            function render() {
                closeOverlay();
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

            const flip = (delta) => channel && channel.postMessage({ type: "flip", delta });

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

            if (channel) {
                channel.onmessage = (e) => {
                    if (e.data?.type === "update" && e.data.payload?.pages) {
                        liveState = e.data.payload;
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
            return;
        }
        projectionMode = "leader";
        document.title = "主领视角";
        installProjectionUI("leader");
        const NOTES_KEY = "leader_notes";
        const DISPLAY_MODE_KEY = "leader_display_mode";
        const BG_MODE_KEY = "leader_bg_mode";
        const host = $("projection-host");
        const layer = $("projection-lyric");
        const canvas = $("projection-bg");
        const bgImage = $("projection-bg-image");
        const nav = $("projection-prev-btn")?.parentElement;
        if (!host || !layer || !canvas) return;
        if (bgImage) bgImage.style.display = "none";
        if (nav) nav.style.display = "none";
        if (projectionRaf) { cancelAnimationFrame(projectionRaf); projectionRaf = 0; }
        host.classList.add("leader-host");
        layer.classList.add("leader-lyric-shell");
        layer.style.cssText = "";

        let displayMode = localStorage.getItem(DISPLAY_MODE_KEY) || "multi";
        if (!["single", "multi", "scroll"].includes(displayMode)) displayMode = "multi";
        let bgMode = localStorage.getItem(BG_MODE_KEY) || "particles";
        if (!["black", "particles"].includes(bgMode)) bgMode = "particles";
        let noteEditMode = false;
        let notesMap = getStore(NOTES_KEY, {});
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
            setStore(NOTES_KEY, notesMap);
        }
        function loadNote(lineIndex) { return String(notesMap[String(lineIndex)] || ""); }
        function closePopup() { if (popup?.parentNode) popup.parentNode.removeChild(popup); popup = null; }
        function getPagesAndIndex() {
            const pages = Array.isArray(liveState?.pages) ? liveState.pages : [];
            const idx = clamp(liveState?.pageIndex || 0, 0, Math.max(0, pages.length - 1));
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
                box.innerHTML = `<div class="leader-note-view">${escapeHtml(noteVal || "（无备注）")}</div>`;
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
            ensureProjectionCanvas();
            const ctx = projectionCtx;
            if (!ctx) return;
            const w = window.innerWidth;
            const h = window.innerHeight;
            const g = ctx.createRadialGradient(w * 0.5, h * 0.45, Math.min(w, h) * 0.1, w * 0.5, h * 0.55, Math.max(w, h) * 0.8);
            g.addColorStop(0, "#0f1f3f");
            g.addColorStop(1, "#000000");
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
            if (bgParticles.length !== PARTICLE_BG_COUNT) {
                bgParticles = createAmbientParticles(w, h, PARTICLE_BG_COUNT);
            }
            const dt = clamp((ts - (projectionLastTs || ts)) / 16.67, 0.5, 1.8);
            projectionLastTs = ts;
            bgParticles.forEach((p) => {
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
            bgRaf = requestAnimationFrame(drawLeaderBackground);
        }
        function applyBackgroundMode() {
            if (bgRaf) cancelAnimationFrame(bgRaf);
            bgRaf = 0;
            host.style.background = "#000";
            if (bgMode === "particles") {
                canvas.style.display = "block";
                bgParticles = [];
                projectionLastTs = 0;
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
            const color = liveState?.fontColor || liveState?.text?.color || "#ffffff";
            const curStart = pages.slice(0, idx).reduce((n, p) => n + (p || []).length, 0);
            const curEnd = curStart + lines.length - 1;
            let bodyHtml = "";
            if (displayMode === "single") {
                const gi = lineGlobalIndex(pages, idx, 0);
                const note = loadNote(gi);
                bodyHtml = `<div class="leader-current leader-single" style="color:${color};"><div class="leader-line">${escapeHtml(lines[0] || "...")}${note ? `<span class="leader-note-dot" data-line="${gi}"></span>` : ""}${noteEditMode ? `<span class="leader-plus-dot" data-line="${gi}">+</span>` : ""}</div></div>`;
            } else if (displayMode === "scroll") {
                const all = pages.flat();
                bodyHtml = `<div class="leader-current leader-scroll" style="color:${color};">${all.map((line, i) => {
                    const note = loadNote(i);
                    const cur = i >= curStart && i <= curEnd ? " current" : "";
                    return `<div class="leader-line${cur}">${escapeHtml(line)}${note ? `<span class="leader-note-dot" data-line="${i}"></span>` : ""}${noteEditMode ? `<span class="leader-plus-dot" data-line="${i}">+</span>` : ""}</div>`;
                }).join("")}</div>`;
            } else {
                bodyHtml = `<div class="leader-current leader-multi" style="color:${color};">${lines.map((line, i) => {
                    const gi = lineGlobalIndex(pages, idx, i);
                    const note = loadNote(gi);
                    return `<div class="leader-line">${escapeHtml(line)}${note ? `<span class="leader-note-dot" data-line="${gi}"></span>` : ""}${noteEditMode ? `<span class="leader-plus-dot" data-line="${gi}">+</span>` : ""}</div>`;
                }).join("") || "<div class='leader-line'>...</div>"}</div>`;
            }
            const nextHtml = displayMode === "scroll" ? "" : `<div class="leader-next">下句：${escapeHtml(nextLine)}</div>`;
            layer.innerHTML = `<div class="leader-page">${idx + 1}/${Math.max(1, pages.length)}</div><div class="leader-main">${bodyHtml}</div>${nextHtml}`;
            toolbar.querySelectorAll("[data-mode]").forEach((btn) => btn.classList.toggle("active", btn.getAttribute("data-mode") === displayMode));
            toolbar.querySelector('[data-action="note"]')?.classList.toggle("active", noteEditMode);
        }

        function flip(delta) { if (channel) channel.postMessage({ type: "flip", delta }); }

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
                applyBackgroundMode();
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

        if (channel) {
            channel.onmessage = (e) => {
                if (e.data?.type === "update" && e.data.payload?.pages) {
                    liveState = e.data.payload;
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
                    render();
                }
            }
        });
        window.addEventListener("resize", () => {
            applyBackgroundMode();
            render();
        });

        const initState = getStore(STORAGE.LIVE, null);
        if (initState?.pages) liveState = initState;
        applyBackgroundMode();
        render();
        showToolbar();
    }

    function changePage(delta) {
        const pages = splitPages(currentSong()?.lyrics || "", state.ui.defaultLines);
        const atLastPage = state.currentPage >= Math.max(0, pages.length - 1);
        if (delta > 0 && atLastPage && state.playlist.running && state.playlist.autoSwitch) {
            const nextIdx = state.playlist.activeIndex + 1;
            if (nextIdx < state.playlist.items.length) {
                switchToPlaylistSong(nextIdx, true);
                return;
            }
        }
        state.currentPage = clamp(state.currentPage + delta, 0, Math.max(0, pages.length - 1));
        updateSpeakerCards();
        renderMiniPreview();
        renderPlaylist();
        broadcastState();
    }

    function handleControlMessage(msg) {
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "flip") {
            changePage(Number(msg.delta) || 0);
        } else if (msg.type === "goto") {
            const pages = splitPages(currentSong()?.lyrics || "", state.ui.defaultLines);
            state.currentPage = clamp(Number(msg.page) || 0, 0, Math.max(0, pages.length - 1));
            updateAll();
        }
    }

    function initMain() {
        const boot = () => {
            loadState();
            loadThemeBgSlotsFromStorage();
            normalizeLegacyBgImageReference();
            applyThemeBackground();
            const left = $("song-library");
            const right = $("preview-panel");
            if (left && !left.style.width) left.style.width = "260px";
            if (right && !right.style.width) right.style.width = "300px";
            ensureFontColorControls();
            syncPosYFromCurrentSong();
            updateUIFromState();
            syncSongToEditor();
            renderSongList();
            renderTagFilter();
            updateSpeakerCards();
            renderMiniPreview();
            renderPlaylist();
            if ($("playlist-auto-switch")) $("playlist-auto-switch").checked = !!state.playlist.autoSwitch;
            bindEvents();
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
