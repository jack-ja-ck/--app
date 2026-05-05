// actions.js：业务逻辑层，负责所有核心操作
const WorshipActions = {
    // 翻页
    changePage(delta) {
        const data = globalThis.WorshipData;
        if (!data) return;
        const song = data.getCurrentSong();
        if (!song) return;
        const pages = globalThis.parsePages(song.lyrics || "", data.ui.defaultLines);
        const maxIdx = Math.max(0, pages.length - 1);
        const cur = data.currentPage;
        const d = Number(delta);
        if (!Number.isFinite(d) || d === 0) return;
        if (d < 0 && cur <= 0) return;
        if (d > 0 && cur >= maxIdx) return;
        data.currentPage = Math.max(0, Math.min(cur + d, maxIdx));
        data.save();
    },

    // 保存歌词
    saveLyrics(title, lyrics) {
        const data = globalThis.WorshipData;
        if (!data) return false;
        let song = data.getCurrentSong();
        if (!song) {
            song = { id: "song_" + Date.now(), title: title || "未命名", lyrics: lyrics || "" };
            data.songs.unshift(song);
            data.currentSongId = song.id;
        } else {
            if (title !== undefined) song.title = title;
            if (lyrics !== undefined) song.lyrics = lyrics;
        }
        data.save();
        return true;
    },

    // 切换背景
    setBackground(type) {
        const data = globalThis.WorshipData;
        if (!data) return;
        data.ui.bgType = type || "solid-black";
        if (type !== "image") {
            data.ui.bgImage = "";
            data.ui.bgImageId = "";
        }
        data.save();
    },

    // 更新UI设置
    updateUISetting(key, value) {
        const data = globalThis.WorshipData;
        if (!data) return;
        if (key in data.ui) {
            data.ui[key] = value;
            data.save();
        }
    },

    // 广播状态到投屏窗口
    broadcastState() {
        const data = globalThis.WorshipData;
        if (!data) return;
        // 调用 router.js 中的 broadcastState
        if (typeof globalThis.broadcastState === "function") {
            globalThis.broadcastState();
        }
    }
};

// 导出到全局
if (typeof globalThis !== "undefined") globalThis.WorshipActions = WorshipActions;
if (typeof window !== "undefined") window.WorshipActions = WorshipActions;
