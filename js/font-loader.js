/**
 * 歌词 Web 字体按需加载：首屏不拉 Google Fonts / CDN 字体包，用到时再加载（浏览器会缓存）。
 */
(function fontLoaderModule(global) {
    "use strict";

    const loaded = new Set();

    function loadStylesheet(id, href) {
        if (loaded.has(id) || document.getElementById(id)) {
            loaded.add(id);
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const link = document.createElement("link");
            link.id = id;
            link.rel = "stylesheet";
            link.href = href;
            link.crossOrigin = "anonymous";
            link.onload = () => {
                loaded.add(id);
                resolve();
            };
            link.onerror = () => reject(new Error("font css: " + id));
            document.head.appendChild(link);
        });
    }

    function ensureGooglePreconnect() {
        if (document.getElementById("wf-google-preconnect")) return;
        const a = document.createElement("link");
        a.id = "wf-google-preconnect";
        a.rel = "preconnect";
        a.href = "https://fonts.googleapis.com";
        document.head.appendChild(a);
        const b = document.createElement("link");
        b.rel = "preconnect";
        b.href = "https://fonts.gstatic.com";
        b.crossOrigin = "anonymous";
        document.head.appendChild(b);
    }

    function loadFontFace(id, family, src, weight) {
        if (loaded.has(id)) return Promise.resolve();
        if (typeof FontFace === "undefined") return Promise.resolve();
        return new Promise((resolve, reject) => {
            const face = new FontFace(family, `url("${src}") format("woff2")`, {
                weight: String(weight || 400),
                display: "swap"
            });
            face.load()
                .then((f) => {
                    document.fonts.add(f);
                    loaded.add(id);
                    resolve();
                })
                .catch(reject);
        });
    }

    /** @type {{ test: RegExp, load: (ff: string) => Promise<void> }[]} */
    const RULES = [
        {
            test: /Noto Sans SC|Source Han Sans/i,
            load: () => {
                ensureGooglePreconnect();
                return loadStylesheet(
                    "wf-noto-sans-sc",
                    "https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;700&display=swap"
                );
            }
        },
        {
            test: /Noto Serif SC|Source Han Serif/i,
            load: () => {
                ensureGooglePreconnect();
                return loadStylesheet(
                    "wf-noto-serif-sc",
                    "https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;700&display=swap"
                );
            }
        },
        {
            test: /Long Cang/i,
            load: () => {
                ensureGooglePreconnect();
                return loadStylesheet(
                    "wf-long-cang",
                    "https://fonts.googleapis.com/css2?family=Long+Cang&display=swap"
                );
            }
        },
        {
            test: /Ma Shan Zheng/i,
            load: () => {
                ensureGooglePreconnect();
                return loadStylesheet(
                    "wf-ma-shan-zheng",
                    "https://fonts.googleapis.com/css2?family=Ma+Shan+Zheng&display=swap"
                );
            }
        },
        {
            test: /Zhi Mang Xing/i,
            load: () => {
                ensureGooglePreconnect();
                return loadStylesheet(
                    "wf-zhi-mang-xing",
                    "https://fonts.googleapis.com/css2?family=Zhi+Mang+Xing&display=swap"
                );
            }
        },
        {
            test: /LXGW WenKai/i,
            load: () =>
                loadStylesheet(
                    "wf-lxgw-wenkai",
                    "https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/style.css"
                )
        },
        {
            test: /HarmonyOS Sans/i,
            load: () =>
                loadStylesheet(
                    "wf-harmonyos-sans",
                    "https://cdn.jsdelivr.net/npm/harmonyos-sans-sc-webfont-splitted@1.1.0/dist/index.min.css"
                )
        },
        {
            test: /Alibaba PuHuiTi/i,
            load: () =>
                loadFontFace(
                    "wf-alibaba-puhuiti",
                    "Alibaba PuHuiTi",
                    "https://cdn.jsdelivr.net/npm/alibabapuhuiti-3-55-regular@1.0.0/AlibabaPuHuiTi-3-55-Regular.woff2",
                    400
                )
        },
        {
            test: /Bakudai/i,
            load: () =>
                loadFontFace(
                    "wf-bakudai",
                    "Bakudai",
                    "https://cdn.jsdelivr.net/gh/max32002/bakudaifont@master/webfont/Bakudai-Regular.woff2",
                    400
                )
        },
        {
            test: /MasaFont/i,
            load: () =>
                loadFontFace(
                    "wf-masafont",
                    "MasaFont",
                    "https://cdn.jsdelivr.net/gh/max32002/masafont@master/webfont/MasaFont-Regular.woff2",
                    400
                )
        },
        {
            test: /YFFYT/i,
            load: () =>
                loadStylesheet("wf-yffyt", "https://fontsapi.zeoseven.com/446/main/result.css")
        }
    ];

    /**
     * @param {string} fontFamily CSS font-family 字串
     * @returns {Promise<void>}
     */
    function ensureFontsForFamily(fontFamily) {
        const ff = String(fontFamily || "").trim();
        if (!ff) return Promise.resolve();
        const jobs = [];
        RULES.forEach((rule) => {
            if (rule.test.test(ff)) jobs.push(rule.load(ff).catch(() => {}));
        });
        return Promise.all(jobs).then(() => {});
    }

    global.WorshipFontLoader = { ensureFontsForFamily };
})(typeof globalThis !== "undefined" ? globalThis : window);
