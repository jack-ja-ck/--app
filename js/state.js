// state.js：负责所有数据的读写和持久化

const ALL_DATA_STORAGE_KEY = "worship.allData.v1";

const AppState = {
    songs: [],
    currentSongId: null,
    currentPages: [],
    currentPageIndex: 0,
    currentCardPage: 0,
    activeTagFilter: "",
    searchQuery: "",
    bgType: "particles",
    fontSize: 56,
    defaultLines: 4,
    posY: 45,
    autoplayActive: false,
    autoplayInterval: 5
};

/** 与 AppState.songs 同一数组引用，供持久化 API 使用 */
var songs = AppState.songs;

const STORAGE = {
    SONGS: "worship.songs.v5",
    SETTINGS: "worship.settings.v5",
    LIVE: "worship.live.v5",
    PLAYLIST: "playlist"
};

const DEFAULT_LYRICS =
    "奇异恩典\n何等甘甜\n我罪已得赦免\n\n前我失丧\n今被寻回\n瞎眼得看见";
const DEFAULT_SONG = {
    title: "奇异恩典",
    lyrics: DEFAULT_LYRICS,
    key: "C",
    tempo: "72",
    notes: "",
    tags: "敬拜"
};

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

function uid() {
    return "song_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
}

function clampPersist(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

var currentPage = 0;
var sizePreset = "M";
var ui = {
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
var playlist = {
    items: [],
    running: false,
    activeIndex: -1,
    fadeNext: false,
    autoSwitch: false
};
var defaultSongPosY = 45;

function saveSongs() {
    setStore(STORAGE.SONGS, songs);
}

function saveSettings() {
    const uiCopy = { ...ui };
    if (uiCopy.bgType === "image" && uiCopy.bgImageId) {
        uiCopy.bgImage = "";
    }
    setStore(STORAGE.SETTINGS, {
        currentSongId: AppState.currentSongId,
        currentPage: currentPage,
        sizePreset: sizePreset,
        ui: uiCopy
    });
}

function savePlaylist() {
    setStore(STORAGE.PLAYLIST, {
        items: playlist.items,
        running: playlist.running,
        activeIndex: playlist.activeIndex
    });
}

function loadState() {
    const loadedSongs = getStore(STORAGE.SONGS, []);
    const settings = getStore(STORAGE.SETTINGS, null);

    if (Array.isArray(loadedSongs) && loadedSongs.length) {
        songs.length = 0;
        for (let i = 0; i < loadedSongs.length; i++) songs.push(loadedSongs[i]);
    } else {
        songs.length = 0;
        songs.push({ id: uid(), ...DEFAULT_SONG });
    }

    if (settings) {
        AppState.currentSongId = settings.currentSongId || songs[0].id;
        currentPage = Number.isFinite(settings.currentPage) ? settings.currentPage : 0;
        sizePreset = settings.sizePreset || "M";
        if (settings.ui && typeof settings.ui === "object") {
            Object.assign(ui, settings.ui);
        }
        if (!ui.bgImageId) ui.bgImageId = "";
        if (ui.bgMediaType !== "video" && ui.bgMediaType !== "image") {
            ui.bgMediaType = "image";
        }
    } else {
        AppState.currentSongId = songs[0].id;
    }

    if (!songs.some((s) => s && s.id === AppState.currentSongId)) {
        AppState.currentSongId = songs[0].id;
    }
    const pl = getStore(STORAGE.PLAYLIST, null);
    if (pl && Array.isArray(pl.items)) {
        playlist.items = pl.items.filter((id) => songs.some((s) => s && s.id === id));
        playlist.running = !!pl.running && playlist.items.length > 0;
        playlist.activeIndex = clampPersist(Number(pl.activeIndex) || 0, 0, Math.max(0, playlist.items.length - 1));
    }
    playlist.autoSwitch = false;
    defaultSongPosY = clampPersist(Number(ui.posY) || 45, 20, 70);

    AppState.fontSize = clampPersist(Number(ui.fontSize) || 56, 24, 120);
    AppState.defaultLines = clampPersist(Number(ui.defaultLines) || 4, 1, 20);
    AppState.posY = clampPersist(Number(ui.posY) || 45, 20, 70);
    if (ui.bgType) AppState.bgType = String(ui.bgType);

    const cur = songs.find((s) => s && s.id === AppState.currentSongId);
    const pp = typeof globalThis.parsePages === "function" ? globalThis.parsePages : null;
    let maxPageIdx = 0;
    if (cur && pp) {
        const pages = pp(String(cur.lyrics || ""), AppState.defaultLines);
        maxPageIdx = Math.max(0, pages.length - 1);
    }
    AppState.currentPageIndex = clampPersist(Math.floor(Number(currentPage)) || 0, 0, maxPageIdx);
    AppState.currentCardPage = AppState.currentPageIndex;
}

function clampPageIndex(index, pageCount) {
    const n = Math.floor(Number(index)) || 0;
    if (!pageCount || pageCount < 1) return 0;
    return Math.max(0, Math.min(n, pageCount - 1));
}

function getSong(id) {
    if (id == null || id === "") return null;
    const sid = String(id);
    return AppState.songs.find((s) => s && String(s.id) === sid) || null;
}

function setCurrentSong(id) {
    const song = getSong(id);
    if (!song) return false;
    AppState.currentSongId = song.id;
    AppState.currentPageIndex = 0;
    AppState.currentCardPage = 0;
    return true;
}

function addSong(song) {
    if (!song || typeof song !== "object") return null;
    const next = { ...song };
    if (next.id == null || next.id === "") {
        next.id = `song_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }
    AppState.songs = AppState.songs.concat([next]);
    return next;
}

function deleteSong(id) {
    if (id == null || id === "") return false;
    const sid = String(id);
    const before = AppState.songs.length;
    AppState.songs = AppState.songs.filter((s) => !s || String(s.id) !== sid);
    if (AppState.songs.length === before) return false;
    if (AppState.currentSongId != null && String(AppState.currentSongId) === sid) {
        AppState.currentSongId = AppState.songs[0] ? AppState.songs[0].id : null;
        AppState.currentPageIndex = 0;
        AppState.currentCardPage = 0;
    }
    return true;
}

function setPage(index) {
    const len = AppState.currentPages.length;
    const i = clampPageIndex(index, len || 1);
    AppState.currentPageIndex = len ? i : 0;
    AppState.currentCardPage = AppState.currentPageIndex;
}

function nextPage() {
    const len = AppState.currentPages.length;
    if (len < 2) return;
    if (AppState.currentPageIndex < len - 1) {
        AppState.currentPageIndex += 1;
        AppState.currentCardPage = AppState.currentPageIndex;
    }
}

function prevPage() {
    const len = AppState.currentPages.length;
    if (len < 1) return;
    if (AppState.currentPageIndex > 0) {
        AppState.currentPageIndex -= 1;
        AppState.currentCardPage = AppState.currentPageIndex;
    }
}

function saveAllData() {
    try {
        const payload = { ...AppState };
        localStorage.setItem(ALL_DATA_STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
        /* ignore quota / serialization errors */
    }
}

function loadAllData() {
    try {
        const raw = localStorage.getItem(ALL_DATA_STORAGE_KEY);
        if (!raw) return;
        const o = JSON.parse(raw);
        if (!o || typeof o !== "object") return;
        const keys = Object.keys(AppState);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (Object.prototype.hasOwnProperty.call(o, k)) AppState[k] = o[k];
        }
    } catch (e) {
        /* ignore parse errors */
    }
}

const root = typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : self;
root.AppState = AppState;
root.songs = songs;
root.getStore = getStore;
root.setStore = setStore;
root.saveSongs = saveSongs;
root.saveSettings = saveSettings;
root.savePlaylist = savePlaylist;
root.loadState = loadState;
Object.defineProperty(root, "currentSongId", {
    get() {
        return AppState.currentSongId;
    },
    set(v) {
        AppState.currentSongId = v;
    },
    configurable: true
});
root.getSong = getSong;
root.setCurrentSong = setCurrentSong;
root.addSong = addSong;
root.deleteSong = deleteSong;
root.setPage = setPage;
root.nextPage = nextPage;
root.prevPage = prevPage;
root.saveAllData = saveAllData;
root.loadAllData = loadAllData;
