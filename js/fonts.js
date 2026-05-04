/**
 * 高级编辑「歌词字体」数据源：分组、展示名、CSS font-family 取值与下拉预览用字体栈。
 * 所列字体均为开源或官方免费商用授权；具体协议见各字体官方说明。
 */
(function fontDataModule(global) {
    "use strict";

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
        return s;
    }

    /**
     * @param {HTMLSelectElement} selectEl
     * @param {{ currentValue?: string, onMissing?: (resolved: string) => void }} [opts]
     */
    function populateFontFamilySelect(selectEl, opts) {
        if (!selectEl || selectEl.tagName !== "SELECT") return;
        const known = collectKnownValues();
        let v = String(opts && opts.currentValue != null ? opts.currentValue : "").trim();
        if (!known.has(v)) {
            v = DEFAULT_FONT_VALUE;
            if (opts && typeof opts.onMissing === "function") opts.onMissing(v);
        }
        selectEl.textContent = "";
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
        let matched = false;
        for (let i = 0; i < selectEl.options.length; i++) {
            if (selectEl.options[i].value === v) {
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

    const api = {
        FONT_FAMILY_GROUPS,
        DEFAULT_FONT_VALUE,
        collectKnownValues,
        populateFontFamilySelect
    };
    global.WorshipFontData = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
