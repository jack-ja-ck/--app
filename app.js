(() => {
    "use strict";

    const STORAGE = {
        SONGS: "worship.songs.v5",
        SETTINGS: "worship.settings.v5",
        LIVE: "worship.live.v5",
        PLAYLIST: "playlist"
    };
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

    function $(id) {
        return document.getElementById(id);
    }

    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
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
        if (triggerElement && typeof triggerElement.getBoundingClientRect === "function") {
            const rect = triggerElement.getBoundingClientRect();
            t.style.left = `${Math.min(window.innerWidth - 220, rect.right + 8)}px`;
            t.style.top = `${Math.max(10, rect.top + (rect.height - 20) / 2)}px`;
            t.style.bottom = "auto";
            t.style.transform = "none";
        } else {
            t.style.left = "50%";
            t.style.bottom = "30px";
            t.style.top = "auto";
            t.style.transform = "translateX(-50%)";
        }
        t.style.opacity = "1";
        t.classList.add("bounceIn");
        setTimeout(() => {
            t.style.opacity = "0";
            t.classList.remove("bounceIn");
        }, 1500);
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

    function saveSongs() {
        setStore(STORAGE.SONGS, state.songs);
    }

    function saveSettings() {
        setStore(STORAGE.SETTINGS, {
            currentSongId: state.currentSongId,
            currentPage: state.currentPage,
            sizePreset: state.sizePreset,
            ui: state.ui
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
        card.style.background = "#000";
        card.style.backgroundImage = "none";
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
        mini.style.background = "var(--preview-bg)";
        mini.style.backgroundImage = "none";
        if (state.ui.bgType === "solid-white") mini.style.background = "#fff";
        else if (state.ui.bgType === "solid-gray") mini.style.background = "#444";
        else if (state.ui.bgType === "gradient") mini.style.background = "linear-gradient(140deg,#1b2f59,#0a0f1d)";
        else if (state.ui.bgType === "image" && state.ui.bgImage) {
            mini.style.backgroundImage = `url("${state.ui.bgImage}")`;
            mini.style.backgroundSize = "cover";
            mini.style.backgroundPosition = "center";
        }

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

    function renderOnlineSearchResult() {
        const input = $("online-search-input");
        const panel = $("online-results");
        if (!input || !panel) return;
        const q = input.value.trim().toLowerCase();
        panel.innerHTML = "";
        if (!q) return;
        const matches = state.songs.filter((s) => (s.title || "").toLowerCase().includes(q)).slice(0, 8);
        if (!matches.length) {
            panel.innerHTML = '<div class="hint-text">未找到本地匹配</div>';
            return;
        }
        matches.forEach((song) => {
            const btn = document.createElement("button");
            btn.className = "small-btn";
            btn.style.marginTop = "4px";
            btn.textContent = `加载：${song.title}`;
            btn.addEventListener("click", () => switchSong(song.id));
            panel.appendChild(btn);
        });
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
        const payload = liveState || getStore(STORAGE.LIVE, null);
        if (payload && channel) {
            channel.postMessage({ type: "update", payload });
        }
    }

    function broadcastState() {
        liveState = buildLiveState();
        setStore(STORAGE.LIVE, liveState);
        if (channel) channel.postMessage({ type: "update", payload: liveState });
        saveSongs();
        saveSettings();
    }

    function updateAll() {
        updateSpeakerCards();
        renderMiniPreview();
        renderPlaylist();
        broadcastState();
    }

    function setBackground(bgType) {
        state.ui.bgType = bgType || "solid-black";
        updateUIFromState();
        updateAll();
    }

    function switchSong(songId) {
        if (!state.songs.some((s) => s.id === songId)) return;
        state.currentSongId = songId;
        state.currentPage = 0;
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
        syncEditorToSong();
        const s = currentSong() || { title: "", lyrics: "", tags: "" };
        if (!String(s.lyrics || "").trim().length) {
            showToast("无歌词可发布", $("publish-song-btn"));
            return;
        }
        const url = "https://script.google.com/macros/s/AKfycbzUW1yB8gObRnSjUyWpRivWWI4KuD-ba9m5eYZU4TbdKUvuajcpaSaMxZ61JjBFyjkUXQ/exec";
        const btn = $("publish-song-btn");
        if (btn) btn.disabled = true;
        if (btn) btn.textContent = "发布中...";

        const payload = {
            title: s.title || "",
            lyrics: s.lyrics || "",
            tags: Array.isArray(s.tags) ? s.tags : String(s.tags || "").split(/[,\s]+/).filter(Boolean)
        };

        try {
            const response = await fetch(url, {
                method: "POST",
                mode: "no-cors",
                cache: "no-cache",
                headers: { "Content-Type": "application/json" },
                redirect: "follow",
                referrerPolicy: "no-referrer",
                body: JSON.stringify(payload)
            });

            if (response.ok || response.type === "opaque") {
                showToast("已发布到云端", btn);
            } else {
                const text = await response.text();
                if (btn) btn.textContent = "重新发布";
                showToast(`发布失败：${text.slice(0, 30)}`, btn);
                return;
            }
        } catch (e) {
            console.error("发布失败:", e);
            if (btn) {
                btn.disabled = false;
                btn.textContent = "发布到云端";
            }
            showToast("发布失败，请稍后再试", btn);
            return;
        }

        if (btn) {
            btn.disabled = false;
            btn.textContent = "发布到云端";
        }
        showToast("已发布到云端", btn);
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

    function openDisplayWindow() {
        broadcastState();
        const win = window.open("./index.html?display=1", "_blank");
        if (win) {
            win.addEventListener("load", () => {
                try { win.document.documentElement.requestFullscreen(); } catch (e) {}
            });
        }
    }

    function openLeaderWindow() {
        broadcastState();
        window.open("./index.html?leader=1", "worship_leader", "width=1000,height=760");
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
            handle.addEventListener("mousedown", (e) => {
                active = true;
                sx = e.clientX;
                sw = target.getBoundingClientRect().width;
                handle.classList.add("active");
                document.body.style.userSelect = "none";
                e.preventDefault();
            });
            window.addEventListener("mousemove", (e) => {
                if (!active) return;
                const dx = e.clientX - sx;
                const w = clamp(sw + (invert ? -dx : dx), min, max);
                target.style.width = w + "px";
            });
            window.addEventListener("mouseup", () => {
                if (!active) return;
                active = false;
                handle.classList.remove("active");
                document.body.style.userSelect = "";
            });
        };
        bind(r1, left, 180, 520, false);
        bind(r2, right, 80, 900, true);
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
        document.querySelectorAll(".bg-option").forEach((node) => {
            node.addEventListener("click", () => setBackground(node.getAttribute("data-bg") || "solid-black"));
        });
        on("upload-bg-trigger", "click", () => $("bg-image-input")?.click());
        on("upload-bg-btn", "click", () => $("bg-image-input")?.click());
        on("bg-image-input", "change", (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                state.ui.bgType = "image";
                state.ui.bgImage = String(reader.result || "");
                updateUIFromState();
                updateAll();
                showToast("背景已更新", $("upload-bg-btn"));
            };
            reader.readAsDataURL(file);
        });
        on("theme-bg-upload-btn", "click", () => $("theme-bg-input")?.click());
        on("theme-bg-input", "change", (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                document.documentElement.style.setProperty("--theme-bg-image", `url("${reader.result}")`);
                showToast("主题背景已设置", $("theme-bg-upload-btn"));
            };
            reader.readAsDataURL(file);
        });
        on("free-bg-link", "click", () => window.open("https://unsplash.com/s/photos/church-background", "_blank"));

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

    function drawParticles(w, h, dt) {
        const ctx = projectionCtx;
        if (!ctx) return;
        const count = 80;
        if (projectionParticles.length !== count) {
            projectionParticles = Array.from({ length: count }, () => {
                const a = Math.random() * Math.PI * 2;
                const speed = 0.45 + Math.random() * 0.55;
                return {
                    x: Math.random() * w,
                    y: Math.random() * h,
                    vx: Math.cos(a) * speed,
                    vy: Math.sin(a) * speed,
                    r: 1 + Math.random() * 3,
                    alpha: 0.2 + Math.random() * 0.6
                };
            });
        }
        projectionParticles.forEach((p) => {
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            if (p.x < 0 || p.x > w) p.vx *= -1;
            if (p.y < 0 || p.y > h) p.vy *= -1;
            p.x = clamp(p.x, 0, w);
            p.y = clamp(p.y, 0, h);
            ctx.beginPath();
            ctx.fillStyle = `rgba(255,255,255,${p.alpha.toFixed(3)})`;
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    function drawBg(ts) {
        if (!projectionCtx || !liveState) return;
        ensureProjectionCanvas();
        const ctx = projectionCtx;
        const w = window.innerWidth;
        const h = window.innerHeight;
        const bgState = liveState.background || {};
        const type = bgState.type || "solid-black";
        const gifLayer = $("projection-bg-image");
        if (gifLayer) gifLayer.style.display = "none";
        if (projectionCanvas) projectionCanvas.style.display = "block";

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

        const bc = new BroadcastChannel('worship_channel');
        bc.onmessage = (e) => {
            if (e.data.type === 'update') {
                applyLive(e.data.payload);
            }
        };
        bc.postMessage({ type: 'request_state' });

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
            let notesMap = getStore(NOTES_KEY, {});
            let overlay = null;
            let bgLoop = 0;
            let pts = [];
            let touchStartX = 0;
            let hideTimer = 0;
            let toolbarCollapsed = localStorage.getItem(TOOLBAR_COLLAPSED_KEY) === "1";

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
            toolbar.innerHTML = '<button class="leader-mini-btn" data-mode="single">🔍 单句模式</button><button class="leader-mini-btn" data-mode="multi">📋 多句模式</button><button class="leader-mini-btn" data-mode="scroll">📜 滚动模式</button><button class="leader-mini-btn" data-action="prev">◀ 上一页</button><button class="leader-mini-btn" data-action="next">▶ 下一页</button><button class="leader-mini-btn" data-action="note">✏️ 备注</button><button class="leader-mini-btn" data-bg="black">🌙 纯黑背景</button><button class="leader-mini-btn" data-bg="particles">✨ 粒子背景</button><button class="leader-mini-btn leader-collapse-btn" data-action="collapse">∧</button>';
            host.appendChild(toolbar);
            const toolbarRail = document.createElement("div");
            toolbarRail.className = "leader-toolbar-rail";
            toolbarRail.innerHTML = '<span class="leader-toolbar-rail-dot"></span>';
            host.appendChild(toolbarRail);

            const showToolbar = () => {
                if (toolbarCollapsed) return;
                toolbar.classList.remove("hidden");
                if (hideTimer) clearTimeout(hideTimer);
                hideTimer = setTimeout(() => toolbar.classList.add("hidden"), 3000);
            };
            const setToolbarCollapsed = (collapsed) => {
                toolbarCollapsed = !!collapsed;
                localStorage.setItem(TOOLBAR_COLLAPSED_KEY, toolbarCollapsed ? "1" : "0");
                toolbar.classList.toggle("collapsed", toolbarCollapsed);
                toolbarRail.classList.toggle("active", toolbarCollapsed);
                if (!toolbarCollapsed) showToolbar();
            };
            const saveNote = (lineIndex, note) => {
                notesMap[String(lineIndex)] = String(note || "").trim();
                if (!notesMap[String(lineIndex)]) delete notesMap[String(lineIndex)];
                setStore(NOTES_KEY, notesMap);
            };
            const loadNote = (lineIndex) => String(notesMap[String(lineIndex)] || "");
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

            function openNote(lineIndex, readOnly, anchorEl) {
                closeOverlay();
                const wrap = document.createElement("div");
                wrap.className = "leader-note-pop-wrap";
                const box = document.createElement("div");
                box.className = "leader-note-pop";
                box.style.width = "350px";
                const noteVal = loadNote(lineIndex);
                const closeBtn = document.createElement("button");
                closeBtn.type = "button";
                closeBtn.className = "leader-note-close";
                closeBtn.textContent = "✕";
                closeBtn.addEventListener("click", closeOverlay);
                box.appendChild(closeBtn);
                if (readOnly) {
                    const view = document.createElement("div");
                    view.className = "leader-note-view";
                    view.textContent = noteVal || "（无备注）";
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
                    if (e.target === wrap) closeOverlay();
                });
                document.body.appendChild(wrap);
                if (anchorEl) {
                    const rect = anchorEl.getBoundingClientRect();
                    const left = clamp(rect.left + rect.width / 2 - 175, 12, window.innerWidth - 362);
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
                if (pts.length !== 80) {
                    pts = Array.from({ length: 80 }, () => {
                        const a = Math.random() * Math.PI * 2;
                        const speed = 0.3 + Math.random() * 0.3;
                        return { x: Math.random() * w, y: Math.random() * h, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, r: 2 + Math.random() * 3, alpha: 0.18 + Math.random() * 0.25 };
                    });
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
                    ctx.beginPath();
                    ctx.fillStyle = `rgba(255,255,255,${p.alpha.toFixed(3)})`;
                    ctx.shadowBlur = 8;
                    ctx.shadowColor = "rgba(255,255,255,.35)";
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
                toolbar.querySelectorAll("[data-bg]").forEach((btn) => btn.classList.toggle("active", btn.getAttribute("data-bg") === bgMode));
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
                    content = `<div class="leader-current leader-single" style="color:${color};"><div class="leader-line">${escapeHtml(lines[0] || "...")}${loadNote(gi) ? `<span class="leader-note-dot" data-line="${gi}"></span>` : ""}${noteEditMode ? `<span class="leader-plus-dot" data-line="${gi}">+</span>` : ""}</div></div>`;
                } else if (displayMode === "scroll") {
                    const all = pages.flat();
                    content = `<div class="leader-current leader-scroll" style="color:${color};">${all.map((line, i) => `<div class="leader-line${i >= curStart && i <= curEnd ? " current" : ""}" style="text-align:center;">${escapeHtml(line)}${loadNote(i) ? `<span class="leader-note-dot" data-line="${i}"></span>` : ""}${noteEditMode ? `<span class="leader-plus-dot" data-line="${i}">+</span>` : ""}</div>`).join("")}</div>`;
                } else {
                    content = `<div class="leader-current leader-multi" style="color:${color};">${lines.map((line, i) => {
                        const gi = globalIndex(pages, idx, i);
                        return `<div class="leader-line">${escapeHtml(line)}${loadNote(gi) ? `<span class="leader-note-dot" data-line="${gi}"></span>` : ""}${noteEditMode ? `<span class="leader-plus-dot" data-line="${gi}">+</span>` : ""}</div>`;
                    }).join("") || "<div class='leader-line'>...</div>"}</div>`;
                }
                const nextHtml = displayMode === "scroll" ? "" : `<div class="leader-next">下句：${escapeHtml(nextLine)}</div>`;
                lyricLayer.innerHTML = `<div class="leader-page">${idx + 1}/${Math.max(1, pages.length)}</div><div class="leader-main">${content}</div>${nextHtml}`;
                toolbar.querySelectorAll("[data-mode]").forEach((btn) => btn.classList.toggle("active", btn.getAttribute("data-mode") === displayMode));
                toolbar.querySelector('[data-action="note"]')?.classList.toggle("active", noteEditMode);
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
                } else if (btn.dataset.action === "note") {
                    noteEditMode = !noteEditMode;
                    render();
                } else if (btn.dataset.action === "prev") flip(-1);
                else if (btn.dataset.action === "next") flip(1);
                else if (btn.dataset.action === "collapse") setToolbarCollapsed(true);
                showToolbar();
            });
            toolbarRail.addEventListener("click", () => setToolbarCollapsed(false));
            leftArrow.addEventListener("click", () => {
                flip(-1);
                showToolbar();
            });
            rightArrow.addEventListener("click", () => {
                flip(1);
                showToolbar();
            });
            host.addEventListener("touchstart", (e) => {
                touchStartX = e.changedTouches?.[0]?.clientX || 0;
                showToolbar();
            }, { passive: true });
            host.addEventListener("touchend", (e) => {
                const dx = (e.changedTouches?.[0]?.clientX || 0) - touchStartX;
                if (Math.abs(dx) > 50) flip(dx < 0 ? 1 : -1);
                showToolbar();
            }, { passive: true });
            document.addEventListener("keydown", (e) => {
                if (e.key === "ArrowLeft") flip(-1);
                if (e.key === "ArrowRight") flip(1);
                if (e.key === "Escape") closeOverlay();
                showToolbar();
            });
            document.addEventListener("mousemove", showToolbar);
            document.addEventListener("click", (e) => {
                if (overlay && e.target === overlay) closeOverlay();
                if (toolbarCollapsed) {
                    const inToolbar = e.target?.closest?.(".leader-toolbar");
                    const inRailDot = e.target?.closest?.(".leader-toolbar-rail-dot");
                    if (!inToolbar && !inRailDot) setToolbarCollapsed(false);
                }
                showToolbar();
            });

            const bc = new BroadcastChannel("worship_channel");
            bc.onmessage = (e) => {
                if (e.data?.type === "update" && e.data.payload?.pages) {
                    liveState = e.data.payload;
                    render();
                }
            };
            bc.postMessage({ type: "request_state" });
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
            });

            const initState = getStore(STORAGE.LIVE, null);
            if (initState?.pages) liveState = initState;
            applyBg();
            render();
            setToolbarCollapsed(toolbarCollapsed);
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
            if (bgParticles.length !== 80) {
                bgParticles = Array.from({ length: 80 }, () => {
                    const a = Math.random() * Math.PI * 2;
                    const speed = 0.3 + Math.random() * 0.3;
                    return { x: Math.random() * w, y: Math.random() * h, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, r: 2 + Math.random() * 3, alpha: 0.18 + Math.random() * 0.25 };
                });
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
                ctx.beginPath();
                ctx.fillStyle = `rgba(255,255,255,${p.alpha.toFixed(3)})`;
                ctx.shadowBlur = 8;
                ctx.shadowColor = "rgba(255,255,255,.35)";
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
            layer.innerHTML = `<div class="leader-page">${idx + 1}/${Math.max(1, pages.length)}</div><div class="leader-main">${bodyHtml}</div><div class="leader-next">下句：${escapeHtml(nextLine)}</div>`;
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

        const bc = new BroadcastChannel("worship_channel");
        bc.onmessage = (e) => {
            if (e.data?.type === "update" && e.data.payload?.pages) {
                liveState = e.data.payload;
                render();
            }
        };
        bc.postMessage({ type: "request_state" });
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
        loadState();
        const left = $("song-library");
        const right = $("preview-panel");
        if (left && !left.style.width) left.style.width = "260px";
        if (right && !right.style.width) right.style.width = "300px";
        ensureFontColorControls();
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

        if (channel) {
            const ch = channel;
            ch.onmessage = (e) => {
                if (e.data.type === 'request_state') {
                    respondCurrentState();
                } else if (e.data && e.data.type === "update" && e.data.payload) {
                    liveState = e.data.payload;
                    setStore(STORAGE.LIVE, liveState);
                } else {
                    handleControlMessage(e.data);
                }
            };
        }
        broadcastState();
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
