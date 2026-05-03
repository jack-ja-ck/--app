
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
    if (globalThis.projectionRaf) cancelAnimationFrame(globalThis.projectionRaf);
    globalThis.projectionRaf = requestAnimationFrame(globalThis.drawBg);

};
globalThis.applyLive = function (mode, payload) {
    if (payload === undefined && mode && typeof mode === "object") {
        payload = mode;
        mode = globalThis.projectionMode || "display";
    }
    if (!payload || !payload.pages) return;
    globalThis.liveState = payload;
    if ((mode || globalThis.projectionMode) === "display") globalThis.renderDisplayLyric();
    else globalThis.renderLeaderLyric();
    globalThis.restartBg();

};
globalThis.renderDisplayLyric = function () {
    const layer = document.getElementById("projection-lyric");
    if (!layer || !globalThis.liveState) return;
    const pages = globalThis.liveState.pages || [];
    const idx = globalThis.clamp(globalThis.liveState.pageIndex || 0, 0, Math.max(0, pages.length - 1));
    const lines = pages[idx] || [];
    const t = globalThis.liveState.text || {};
    const fontColor = globalThis.liveState.fontColor || t.color || "#ffffff";
    layer.style.textAlign = "center";
    layer.style.top = (t.topPct || 45) + "%";
    layer.style.fontFamily = t.fontFamily || globalThis.__projectionUi.fontFamily;
    layer.style.fontSize = globalThis.clamp(t.fontSize || 56, 24, 160) + "px";
    layer.style.color = fontColor;
    const applyFade = !!globalThis.liveState.playlistFade;
    layer.style.transition = "opacity 300ms ease";
    if (applyFade) layer.style.opacity = "0";
    layer.innerHTML = lines.map((line) => `<div>${globalThis.escapeHtml(line)}</div>`).join("");
    if (applyFade) requestAnimationFrame(() => { layer.style.opacity = "1"; });
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
    layer.style.color = fontColor;
    layer.style.fontSize = "44px";
    const applyFade = !!globalThis.liveState.playlistFade;
    layer.style.transition = "opacity 300ms ease";
    if (applyFade) layer.style.opacity = "0";
    layer.innerHTML = [
        `<div style="position:absolute;top:-90px;right:0;font-size:16px;opacity:.9;">第 ${idx + 1}/${Math.max(1, pages.length)} 页</div>`,
        `<div style="line-height:1.35;margin-bottom:20px;">${current.map((x) => globalThis.escapeHtml(x)).join("<br>") || "..."}</div>`,
        `<div style="font-size:22px;opacity:.75;">下页：${next.length ? next.map((x) => globalThis.escapeHtml(x)).join(" / ") : "（无）"}</div>`
    ].join("");
    if (applyFade) requestAnimationFrame(() => { layer.style.opacity = "1"; });

};
globalThis.updateDisplayCardPreview = function () {
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
        const l1 = lines?.[0] || "";
        const l2 = lines?.[1] || "";
        card.innerHTML = `<div style="font-weight:700;white-space:normal;">${globalThis.escapeHtml(l1)}</div><div style="opacity:.75;margin-top:4px;white-space:normal;">${globalThis.escapeHtml(l2)}</div>`;
        card.addEventListener("click", () => {
            if (globalThis.__projectionChannel) globalThis.__projectionChannel.postMessage({ type: "goto", page: i });
        });
        holder.appendChild(card);
    });

};
globalThis.installProjectionUI = function (mode) {
    const app = document.getElementById("app");
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

};
function initDisplayMode() {
    globalThis.projectionMode = "display";
    globalThis.installProjectionUI("display");
    const initState = globalThis.getStore("worship.live.v5", null);
    if (initState) globalThis.applyLive("display", initState);
    const onPrev = () => globalThis.__projectionChannel && globalThis.__projectionChannel.postMessage({ type: "flip", delta: -1 });
    const onNext = () => globalThis.__projectionChannel && globalThis.__projectionChannel.postMessage({ type: "flip", delta: 1 });
    document.getElementById("projection-prev-btn")?.addEventListener("click", onPrev);
    document.getElementById("projection-next-btn")?.addEventListener("click", onNext);
    document.addEventListener("keydown", (e) => {
        if (e.key === "ArrowLeft") onPrev();
        if (e.key === "ArrowRight") onNext();
    });

    if (globalThis.__projectionChannel) {
        globalThis.__projectionChannel.onmessage = (e) => {
            const d = e.data;
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

