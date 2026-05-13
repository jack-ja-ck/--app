// utils.js：负责歌词解析、分页计算、Toast 提示、文件导入导出

let _toastHideTimer = 0;

const TOAST_VARIANTS = new Set(["success", "warning", "error", "default"]);

function inferToastVariant(rawText) {
    const s = String(rawText ?? "").trim();
    if (/^(✅|✓)/u.test(s)) return "success";
    if (/^(❌|✕)/u.test(s)) return "error";
    if (/^⚠/u.test(s)) return "warning";
    if (/失败|无效|错误|无法读取|上传失败|复制失败|删除失败|格式不正确|空间不足|未初始化/u.test(s)) return "error";
    if (/请先|注意|提醒|尚未|占位|拦截/u.test(s)) return "warning";
    if (/已(删除|保存|导入|导出|复制|恢复|切换|加入|取消|上传|发布|应用|结束|清除)|成功|✅/u.test(s)) return "success";
    return "default";
}

function toastVariantIcon(variant) {
    switch (variant) {
        case "success":
            return "✓";
        case "warning":
            return "!";
        case "error":
            return "✕";
        default:
            return "i";
    }
}

function stripLeadingToastEmoji(msg, variant) {
    let s = String(msg ?? "").trim();
    if (variant === "success") s = s.replace(/^(✅|✓)\s*/u, "");
    if (variant === "error") s = s.replace(/^(❌|✕)\s*/u, "");
    if (variant === "warning") s = s.replace(/^⚠️?\s*/u, "");
    return s.trim() || String(msg ?? "").trim();
}

function showToast(text, triggerElement, opts) {
    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }
    const options = opts && typeof opts === "object" ? opts : {};
    const explicit = TOAST_VARIANTS.has(options.variant) ? options.variant : null;
    const variant = explicit != null ? explicit : inferToastVariant(text);
    const durationMs =
        Number.isFinite(Number(options.durationMs)) && Number(options.durationMs) > 0
            ? Math.min(12000, Math.max(600, Number(options.durationMs)))
            : variant === "success"
              ? 2600
              : variant === "error" || variant === "warning"
                ? 2800
                : 2200;

    const t = document.getElementById("toast");
    if (!t) return;
    if (_toastHideTimer) {
        clearTimeout(_toastHideTimer);
        _toastHideTimer = 0;
    }

    const displayMsg = stripLeadingToastEmoji(text, variant);
    t.className = `toast toast--${variant}`;
    t.replaceChildren();
    const icon = document.createElement("span");
    icon.className = "toast__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = toastVariantIcon(variant);
    const msg = document.createElement("span");
    msg.className = "toast__msg";
    msg.textContent = displayMsg;
    t.appendChild(icon);
    t.appendChild(msg);

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
        t.classList.remove(
            "bounceIn",
            "toast--success",
            "toast--warning",
            "toast--error",
            "toast--default"
        );
        t.replaceChildren();
        t.className = "toast";
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

/** 同一显示行内用「||」分隔多段，投屏/预览中横向排列（与换行分页无关） */
const LYRIC_DISPLAY_SEGMENT_SPLIT = /\s*\|\|\s*/;

function splitLyricRowIntoDisplaySegments(line) {
    const s = String(line ?? "");
    if (!s.includes("||")) return [s];
    const parts = s.split(LYRIC_DISPLAY_SEGMENT_SPLIT).map((x) => x.trim()).filter((p) => p.length > 0);
    return parts.length ? parts : [s.replace(/\|\|/g, " ").trim() || s];
}

/** 小卡片等纯文本预览：多段用全角空格隔开，不显示分隔符 */
function formatLyricLineForCompactPreview(line) {
    const parts = splitLyricRowIntoDisplaySegments(line);
    if (parts.length <= 1) return parts[0] != null ? String(parts[0]) : String(line ?? "");
    return parts.join("　");
}

/**
 * 投屏 DOM 一行 HTML（strokeOuterAttr 如 ` style="..."`；outerClass 如 monitor-lyric-line）
 */
function buildLyricRowHtmlForProjectionLine(line, strokeOuterAttr, outerClass) {
    const esc =
        typeof globalThis.escapeHtml === "function"
            ? globalThis.escapeHtml
            : function (t) {
                  return String(t ?? "")
                      .replace(/&/g, "&amp;")
                      .replace(/</g, "&lt;")
                      .replace(/>/g, "&gt;")
                      .replace(/"/g, "&quot;");
              };
    const attr = strokeOuterAttr || "";
    const segs = splitLyricRowIntoDisplaySegments(line);
    const oc = outerClass ? String(outerClass).trim() : "";
    let clsAttr = "";
    if (segs.length > 1) {
        clsAttr = oc ? ` class="${oc} lyric-row--hseg"` : ` class="lyric-row--hseg"`;
    } else if (oc) {
        clsAttr = ` class="${oc}"`;
    }
    if (segs.length <= 1) {
        return `<div${clsAttr}${attr}>${esc(segs[0] != null ? segs[0] : String(line ?? ""))}</div>`;
    }
    const inner = segs.map((seg) => `<span class="lyric-seg">${esc(seg)}</span>`).join("");
    return `<div${clsAttr}${attr}>${inner}</div>`;
}

try {
    globalThis.parsePages = parsePages;
    globalThis.splitLyricRowIntoDisplaySegments = splitLyricRowIntoDisplaySegments;
    globalThis.formatLyricLineForCompactPreview = formatLyricLineForCompactPreview;
    globalThis.buildLyricRowHtmlForProjectionLine = buildLyricRowHtmlForProjectionLine;
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
