/**
 * 高级编辑「歌词字体」数据源：分组、展示名、CSS font-family 取值与下拉预览用字体栈。
 * 所列字体均为开源或官方免费商用授权；具体协议见各字体官方说明。
 */
(function fontDataModule(global) {
    "use strict";

    /** 下拉框中风格预设的 option value 前缀（同时应用字体、颜色、字重） */
    const PRESET_SELECT_PREFIX = "__worship_preset__";

    /**
     * 原「字体风格」四项，并入「字体选择」首组。
     * @type {{ id: string, label: string, fontFamily: string, fontColor: string, fontWeight: string }[]}
     */
    const FONT_STYLE_PRESETS = [
        {
            id: "solemn-song",
            label: "庄重宋体",
            fontFamily: "'Source Han Serif SC','Noto Serif SC','SimSun','Songti SC',serif",
            fontColor: "#d4af37",
            fontWeight: "700"
        },
        {
            id: "modern-sans",
            label: "现代黑体",
            fontFamily: "'Microsoft YaHei','PingFang SC',sans-serif",
            fontColor: "#ffffff",
            fontWeight: "400"
        },
        {
            id: "handwritten",
            label: "手写体",
            fontFamily: "'KaiTi','Kaiti SC','STKaiti',serif",
            fontColor: "#ffe4a8",
            fontWeight: "400"
        },
        {
            id: "classical-serif",
            label: "古典衬线",
            fontFamily: "'SimSun','Songti SC','NSimSun',serif",
            fontColor: "#e8dcc4",
            fontWeight: "700"
        }
    ];
    const FONT_STYLE_PRESET_BY_ID = Object.fromEntries(FONT_STYLE_PRESETS.map((p) => [p.id, p]));

    function normHexColorForPreset(c) {
        const s = String(c || "").trim().toLowerCase();
        if (!s.startsWith("#")) return s;
        if (s.length === 4) {
            return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
        }
        return s;
    }

    function normFontWeightForPreset(w) {
        const s = String(w == null ? "700" : w).trim();
        if (/^normal$/i.test(s) || s === "400") return "400";
        if (/^bold$/i.test(s) || s === "700") return "700";
        return s;
    }

    function findMatchingStylePreset(ui) {
        if (!ui || typeof ui !== "object") return null;
        const ff = String(ui.fontFamily || "").trim();
        const fc = normHexColorForPreset(ui.fontColor);
        const fw = normFontWeightForPreset(ui.fontWeight);
        for (const p of FONT_STYLE_PRESETS) {
            if (
                ff === String(p.fontFamily).trim() &&
                normHexColorForPreset(p.fontColor) === fc &&
                normFontWeightForPreset(p.fontWeight) === fw
            ) {
                return p;
            }
        }
        return null;
    }

    /** @type {{ id: string, label: string, fonts: { label: string, value: string, previewFamily: string }[] }[]} */
    const FONT_FAMILY_GROUPS = [
        {
            id: "system",
            label: "系统字体",
            fonts: [
                {
                    label: "微软雅黑",
                    value: "'Microsoft YaHei','PingFang SC',sans-serif",
                    previewFamily: "'Microsoft YaHei','PingFang SC',sans-serif"
                },
                {
                    label: "宋体",
                    value: "'SimSun','Songti SC','NSimSun',serif",
                    previewFamily: "'SimSun','Songti SC','NSimSun',serif"
                },
                {
                    label: "楷体",
                    value: "'KaiTi','Kaiti SC','STKaiti',serif",
                    previewFamily: "'KaiTi','Kaiti SC','STKaiti',serif"
                },
                {
                    label: "黑体",
                    value: "'SimHei','Heiti SC',sans-serif",
                    previewFamily: "'SimHei','Heiti SC',sans-serif"
                },
                {
                    label: "仿宋",
                    value: "'FangSong','STFangsong',serif",
                    previewFamily: "'FangSong','STFangsong',serif"
                }
            ]
        },
        {
            id: "opensource",
            label: "开源 / 网络字体",
            fonts: [
                {
                    label: "思源黑体（Source Han Sans）",
                    value: "'Noto Sans SC','Source Han Sans SC',sans-serif",
                    previewFamily: "'Noto Sans SC','Source Han Sans SC',sans-serif"
                },
                {
                    label: "思源宋体（Source Han Serif）",
                    value: "'Noto Serif SC','Source Han Serif SC',serif",
                    previewFamily: "'Noto Serif SC','Source Han Serif SC',serif"
                },
                {
                    label: "阿里巴巴普惠体（Alibaba PuHuiTi）",
                    value: "'Alibaba PuHuiTi','Alibaba PuHuiTi 3.0',sans-serif",
                    previewFamily: "'Alibaba PuHuiTi','Alibaba PuHuiTi 3.0',sans-serif"
                },
                {
                    label: "霞鹜文楷（LXGW WenKai）",
                    value: "'LXGW WenKai',serif",
                    previewFamily: "'LXGW WenKai',serif"
                },
                {
                    label: "鸿蒙字体（HarmonyOS Sans）",
                    value: "'HarmonyOS Sans SC','HarmonyOS Sans',sans-serif",
                    previewFamily: "'HarmonyOS Sans SC','HarmonyOS Sans',sans-serif"
                }
            ]
        },
        {
            id: "brush",
            label: "毛笔书法",
            fonts: [
                {
                    label: "莫大毛笔字体",
                    value: "'Bakudai','Bakudai-Regular',cursive",
                    previewFamily: "'Bakudai','Bakudai-Regular',cursive"
                },
                {
                    label: "正风毛笔字体",
                    value: "'MasaFont','MasaFont-Regular',cursive",
                    previewFamily: "'MasaFont','MasaFont-Regular',cursive"
                },
                {
                    label: "钟齐翰墨毛笔",
                    value: "'Long Cang',cursive",
                    previewFamily: "'Long Cang',cursive"
                },
                {
                    label: "马善政毛笔楷书",
                    value: "'Ma Shan Zheng',cursive",
                    previewFamily: "'Ma Shan Zheng',cursive"
                },
                {
                    label: "云峰飞云体",
                    value: "'YFFYT',cursive",
                    previewFamily: "'YFFYT',cursive"
                },
                {
                    label: "钟齐志莽行书",
                    value: "'Zhi Mang Xing',cursive",
                    previewFamily: "'Zhi Mang Xing',cursive"
                }
            ]
        }
    ];

    const DEFAULT_FONT_VALUE = "'Microsoft YaHei','PingFang SC',sans-serif";

    function collectKnownValues() {
        const s = new Set();
        FONT_FAMILY_GROUPS.forEach((g) => {
            g.fonts.forEach((f) => s.add(f.value));
        });
        FONT_STYLE_PRESETS.forEach((p) => s.add(p.fontFamily));
        return s;
    }

    /**
     * @param {HTMLSelectElement} selectEl
     * @param {{ currentValue?: string, uiForPresetMatch?: { fontFamily?: string, fontColor?: string, fontWeight?: string }, onMissing?: (resolved: string) => void }} [opts]
     */
    function populateFontFamilySelect(selectEl, opts) {
        if (!selectEl || selectEl.tagName !== "SELECT") return;
        const known = collectKnownValues();
        const uiSnap = opts && opts.uiForPresetMatch;
        const presetHit = uiSnap ? findMatchingStylePreset(uiSnap) : null;
        let v = String(opts && opts.currentValue != null ? opts.currentValue : "").trim();
        if (!presetHit && !known.has(v)) {
            v = DEFAULT_FONT_VALUE;
            if (opts && typeof opts.onMissing === "function") opts.onMissing(v);
        }
        selectEl.textContent = "";
        const presetOg = document.createElement("optgroup");
        presetOg.label = "版式风格（含配色）";
        FONT_STYLE_PRESETS.forEach((p) => {
            const o = document.createElement("option");
            o.value = PRESET_SELECT_PREFIX + p.id;
            o.textContent = p.label;
            o.className = "adv-font-option";
            o.style.fontFamily = p.fontFamily;
            presetOg.appendChild(o);
        });
        selectEl.appendChild(presetOg);
        FONT_FAMILY_GROUPS.forEach((group) => {
            const og = document.createElement("optgroup");
            og.label = group.label;
            group.fonts.forEach((f) => {
                const o = document.createElement("option");
                o.value = f.value;
                o.textContent = f.label;
                o.className = "adv-font-option";
                o.style.fontFamily = f.previewFamily;
                og.appendChild(o);
            });
            selectEl.appendChild(og);
        });
        if (presetHit) {
            selectEl.value = PRESET_SELECT_PREFIX + presetHit.id;
            return;
        }
        let matched = false;
        for (let i = 0; i < selectEl.options.length; i++) {
            const val = selectEl.options[i].value;
            if (val.startsWith(PRESET_SELECT_PREFIX)) continue;
            if (val === v) {
                selectEl.selectedIndex = i;
                matched = true;
                break;
            }
        }
        if (!matched) {
            selectEl.value = DEFAULT_FONT_VALUE;
            if (opts && typeof opts.onMissing === "function") opts.onMissing(DEFAULT_FONT_VALUE);
        }
    }

    /**
     * @param {HTMLSelectElement} selectEl
     * @param {{ fontFamily?: string, fontColor?: string, fontWeight?: string }} ui
     */
    function syncFontFamilySelectToState(selectEl, ui) {
        if (!selectEl || selectEl.tagName !== "SELECT" || !ui) return;
        const presetHit = findMatchingStylePreset(ui);
        if (presetHit) {
            selectEl.value = PRESET_SELECT_PREFIX + presetHit.id;
            return;
        }
        const ff = String(ui.fontFamily || "").trim();
        for (let i = 0; i < selectEl.options.length; i++) {
            const val = selectEl.options[i].value;
            if (val.startsWith(PRESET_SELECT_PREFIX)) continue;
            if (val === ff) {
                selectEl.selectedIndex = i;
                return;
            }
        }
        selectEl.value = ff;
    }

    function isPresetSelectValue(v) {
        return String(v || "").startsWith(PRESET_SELECT_PREFIX);
    }

    function getPresetFromSelectValue(v) {
        if (!isPresetSelectValue(v)) return null;
        const id = String(v).slice(PRESET_SELECT_PREFIX.length);
        return FONT_STYLE_PRESET_BY_ID[id] || null;
    }

    const api = {
        FONT_FAMILY_GROUPS,
        FONT_STYLE_PRESETS,
        FONT_STYLE_PRESET_BY_ID,
        DEFAULT_FONT_VALUE,
        collectKnownValues,
        populateFontFamilySelect,
        syncFontFamilySelectToState,
        isPresetSelectValue,
        getPresetFromSelectValue,
        findMatchingStylePreset
    };
    global.WorshipFontData = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
