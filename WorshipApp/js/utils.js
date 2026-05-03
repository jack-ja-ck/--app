// utils.js：负责歌词解析、分页计算、Toast 提示、文件导入导出

function showToast(text, triggerElement) {
    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }
    const t = document.getElementById("toast");
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
        const lines = block.split(/\n/).map((x) => x.trim()).filter(Boolean);
        for (let i = 0; i < lines.length; i += size) {
            pages.push(lines.slice(i, i + size));
        }
    }
    return pages.length ? pages : [["..."]];
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
