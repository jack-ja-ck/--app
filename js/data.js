// data.js：数据层，负责所有数据的读写和持久化
const WorshipData = {
    // 存储所有诗歌
    songs: [],
    // 当前选中的诗歌ID
    currentSongId: null,
    // 当前页码
    currentPage: 0,
    // UI设置
    ui: {
        theme: "dark",
        fontFamily: "'Microsoft YaHei','PingFang SC',sans-serif",
        fontSize: 56,
        defaultLines: 4,
        posY: 45,
        bgType: "solid-black",
        bgImage: "",
        bgImageId: "",
        bgMediaType: "image",
        fontColor: "#ffffff",
        fontWeight: "700",
        overlayOpacityPct: 30,
        fontOpacityPct: 100,
        textStrokePx: 0,
        vignetteShape: "circle",
        vignetteCenterBrightness: 0,
        vignetteEdgeDarkness: 0,
        pageTransition: "none",
        pageTransitionSpeed: 0.6
    },
    // 播放列表
    playlist: {
        items: [],
        running: false,
        activeIndex: -1,
        autoSwitch: false
    },

    // 读取数据
    load() {
        try {
            const songsRaw = localStorage.getItem("worship.songs.v5");
            if (songsRaw) this.songs = JSON.parse(songsRaw);
            const settingsRaw = localStorage.getItem("worship.settings.v5");
            if (settingsRaw) {
                const settings = JSON.parse(settingsRaw);
                this.currentSongId = settings.currentSongId || (this.songs[0]?.id || null);
                this.currentPage = settings.currentPage || 0;
                if (settings.ui) Object.assign(this.ui, settings.ui);
            }
        } catch(e) { /* ignore */ }
    },

    // 保存数据
    save() {
        try {
            localStorage.setItem("worship.songs.v5", JSON.stringify(this.songs));
            localStorage.setItem("worship.settings.v5", JSON.stringify({
                currentSongId: this.currentSongId,
                currentPage: this.currentPage,
                ui: this.ui
            }));
        } catch(e) { /* ignore */ }
    },

    // 获取当前诗歌
    getCurrentSong() {
        return this.songs.find(s => s.id === this.currentSongId) || this.songs[0] || null;
    }
};

// 导出到全局
if (typeof globalThis !== "undefined") globalThis.WorshipData = WorshipData;
if (typeof window !== "undefined") window.WorshipData = WorshipData;
