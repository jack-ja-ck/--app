// router.js：负责 BroadcastChannel 收发消息、跨窗口状态同步

const WORSHIP_CHANNEL_NAME = "worship_channel";

const AppRouter = {
    channel: null,
    _handlers: [],

    init() {
        if (typeof BroadcastChannel === "undefined") return;
        if (this.channel) {
            try {
                this.channel.close();
            } catch (e) {
                /* ignore */
            }
            this.channel = null;
        }
        this.channel = new BroadcastChannel(WORSHIP_CHANNEL_NAME);
        this.channel.addEventListener("message", (ev) => {
            const data = ev && ev.data;
            const list = this._handlers;
            for (let i = 0; i < list.length; i++) {
                try {
                    if (typeof list[i] === "function") list[i](data);
                } catch (e) {
                    /* ignore handler errors */
                }
            }
        });
    },

    send(type, payload) {
        if (!this.channel || type == null || type === "") return;
        this.channel.postMessage({
            type,
            payload: payload === undefined ? null : payload
        });
    },

    onMessage(handler) {
        if (typeof handler !== "function") return;
        this._handlers.push(handler);
        const self = this;
        return function unsubscribe() {
            const idx = self._handlers.indexOf(handler);
            if (idx >= 0) self._handlers.splice(idx, 1);
        };
    },

    broadcastState() {
        const routerGlobal =
            typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : self;
        const as = routerGlobal.AppState;
        let snapshot = null;
        if (as && typeof as === "object") {
            try {
                snapshot = JSON.parse(JSON.stringify(as));
            } catch (e) {
                snapshot = null;
            }
        }
        this.send("state", snapshot);
    },

    requestState() {
        this.send("request_state", null);
    },

    sendFlip(delta) {
        const d = Number(delta);
        const v = d === -1 || d === 1 ? d : 0;
        this.send("flip", { delta: v });
    },

    sendGoto(page) {
        const p = Math.floor(Number(page));
        this.send("goto", { page: Number.isFinite(p) ? p : 0 });
    },

    isMain() {
        return !this.isDisplay() && !this.isLeader();
    },

    isDisplay() {
        const loc = typeof location !== "undefined" ? location : null;
        if (!loc || typeof loc.search !== "string") return false;
        try {
            return new URLSearchParams(loc.search).get("display") === "1";
        } catch (e) {
            return false;
        }
    },

    isLeader() {
        const loc = typeof location !== "undefined" ? location : null;
        if (!loc || typeof loc.search !== "string") return false;
        try {
            return new URLSearchParams(loc.search).get("leader") === "1";
        } catch (e) {
            return false;
        }
    }
};

/** 与 app.js 中 STORAGE.LIVE 一致 */
const STORAGE_LIVE = "worship.live.v5";

/**
 * 旧版占位：在完整 app.js 加载前可能被调用。若已由 app 注册 __worshipAppBroadcastState，则一律走主程序（含正确歌词字体等）。
 */
function broadcastState() {
    const root = typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : self;
    if (typeof root.__worshipAppBroadcastState === "function") {
        return root.__worshipAppBroadcastState();
    }
    const routerGlobal = root;

    const songList = Array.isArray(routerGlobal.songs) ? routerGlobal.songs : [];
    const sid = routerGlobal.currentSongId;
    const song =
        songList.find((s) => s && String(s.id) === String(sid)) || songList[0] || null;

    let pages = Array.isArray(routerGlobal.currentPages) ? routerGlobal.currentPages : [];
    if ((!pages || pages.length === 0) && song && typeof routerGlobal.parsePages === "function") {
        pages = routerGlobal.parsePages(String(song.lyrics || ""), 4);
    }

    let pageIndex = Math.floor(Number(routerGlobal.currentPageIndex));
    if (!Number.isFinite(pageIndex)) pageIndex = 0;
    const maxIdx = Math.max(0, pages.length - 1);
    pageIndex = Math.max(0, Math.min(pageIndex, maxIdx));

    const fontColor = "#ffffff";
    const fontFamily = "'Microsoft YaHei','PingFang SC',sans-serif";
    const fontSize = 56;
    const topPct = 45;
    const bgType = "solid-black";
    const textColor = fontColor;

    const liveState = {
        version: 1,
        updatedAt: Date.now(),
        title: song ? String(song.title || "") : "",
        fontColor: fontColor,
        playlistFade: false,
        pages: pages,
        pageIndex: pageIndex,
        text: {
            fontFamily: fontFamily,
            fontSize: fontSize,
            topPct: topPct,
            color: textColor
        },
        background: {
            type: bgType,
            imageData: ""
        }
    };

    if (typeof routerGlobal.setStore === "function") {
        routerGlobal.setStore(STORAGE_LIVE, liveState);
    }

    if (!AppRouter.channel && typeof AppRouter.init === "function") {
        AppRouter.init();
    }
    const ch = AppRouter.channel;
    if (ch) {
        const msg = { type: "update", payload: liveState, source: "main" };
        ch.postMessage(msg);
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => {
                ch.postMessage(msg);
            });
        }
    }

    if (typeof routerGlobal.saveSongs === "function") {
        const songList = Array.isArray(routerGlobal.songs) ? routerGlobal.songs : [];
        const appSongs =
            routerGlobal.AppState && Array.isArray(routerGlobal.AppState.songs) ? routerGlobal.AppState.songs : [];
        if (songList.length || appSongs.length) routerGlobal.saveSongs();
    }
    if (typeof routerGlobal.saveSettings === "function") routerGlobal.saveSettings();
}

const routerRoot =
    typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : self;
routerRoot.AppRouter = AppRouter;
routerRoot.broadcastState = broadcastState;
