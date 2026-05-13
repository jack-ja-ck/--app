// utils.js：负责歌词解析、分页计算、Toast 提示、文件导入导出

let _toastHideTimer = 0;

function showToast(text, triggerElement, opts) {
    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }
    const options = opts && typeof opts === "object" ? opts : {};
    const variant = options.variant === "success" ? "success" : "default";
    const durationMs =
        Number.isFinite(Number(options.durationMs)) && Number(options.durationMs) > 0
            ? Math.min(12000, Math.max(600, Number(options.durationMs)))
            : variant === "success"
              ? 2400
              : 2000;

    const t = document.getElementById("toast");
    if (!t) return;
    if (_toastHideTimer) {
        clearTimeout(_toastHideTimer);
        _toastHideTimer = 0;
    }

    t.textContent = String(text ?? "");
    t.classList.toggle("toast--success", variant === "success");

    t.style.position = "fixed";
    t.classList.remove("bounceIn");
    const anchor =
        triggerElement && typeof triggerElement.getBoundingClientRect === "function"
            ? triggerElement
            : null;

    if (anchor) {
        const rect = anchor.getBoundingClientRect();
        const pad = 10;
        const estW = Math.min(300, window.innerWidth - 16);
        const estH = 80;
        let left = rect.left + rect.width / 2 - estW / 2;
        left = clamp(left, 8, Math.max(8, window.innerWidth - estW - 8));
        let top = rect.bottom + pad;
        if (top + estH > window.innerHeight - 10) {
            top = rect.top - estH - pad;
        }
        if (top < 10) {
            let left2 = rect.right + pad;
            if (left2 + estW > window.innerWidth - 8) {
                left2 = rect.left - estW - pad;
            }
            left2 = clamp(left2, 8, Math.max(8, window.innerWidth - estW - 8));
            t.style.left = `${left2}px`;
            t.style.top = `${clamp(rect.top + rect.height / 2, 28, window.innerHeight - 28)}px`;
            t.style.bottom = "auto";
            t.style.right = "auto";
            t.style.maxWidth = `${estW}px`;
            t.style.transform = "translateY(-50%)";
        } else {
            t.style.left = `${left}px`;
            t.style.top = `${top}px`;
            t.style.bottom = "auto";
            t.style.right = "auto";
            t.style.maxWidth = `${estW}px`;
            t.style.transform = "none";
        }
        void t.offsetHeight;
        t.style.opacity = "1";
    } else {
        t.style.left = "50%";
        t.style.bottom = "30px";
        t.style.top = "auto";
        t.style.right = "auto";
        t.style.maxWidth = "min(300px,calc(100vw - 24px))";
        t.style.transform = "translateX(-50%)";
        t.classList.add("bounceIn");
        t.style.opacity = "1";
    }

    _toastHideTimer = setTimeout(() => {
        _toastHideTimer = 0;
        t.style.opacity = "0";
        t.classList.remove("bounceIn", "toast--success");
    }, durationMs);
}

try {
    globalThis.showToast = showToast;
} catch (_e) {
    /* ignore */
}

function parsePages(lyrics, linesPerPage) {
    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }
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

try {
    globalThis.parsePages = parsePages;
} catch (_e) {
    /* ignore */
}

function rebuildPages(song, currentPages) {
    const fromSong = Number(song?.linesPerPage);
    let linesPerPage = Number.isFinite(fromSong) && fromSong > 0 ? fromSong : 0;
    if (!linesPerPage && Array.isArray(currentPages)) {
        for (let i = 0; i < currentPages.length; i++) {
            const p = currentPages[i];
            if (Array.isArray(p)) linesPerPage = Math.max(linesPerPage, p.length);
        }
    }
    return parsePages(song?.lyrics || "", linesPerPage || 4);
}
