(function (global) {
    "use strict";

    var FILL_TO_TEXT = 74;
    var TEXT_BRIGHT_START = 70;
    var CHAR_COUNT = 4;
    var CHAR_GAP = 0.05;
    var MIN_SHOW = 4500;
    var HOLD = 350;
    var CURTAIN_DURATION = 2000;
    var CURTAIN_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
    var MAX_BOOT_WAIT = 20000;
    var LERP = 0.11;
    var TEXT = "欢迎使用";
    var TEXT2 = "敬拜投屏";

    function shouldSkipIntro() {
        var q = new URLSearchParams(global.location.search);
        if (q.get("display") === "1" || q.get("leader") === "1") return true;
        return false;
    }

    if (shouldSkipIntro()) {
        global.WorshipIntro = {
            signalAppReady: function () {},
            setProgress: function () {},
            whenDone: function (fn) {
                if (typeof fn === "function") fn();
            },
        };
        var skipIntro = document.getElementById("intro");
        var skipHint = document.getElementById("intro-click-hint");
        if (skipIntro) skipIntro.hidden = true;
        if (skipHint) skipHint.hidden = true;
        return;
    }

    var intro = null;
    var curtainL = null;
    var curtainR = null;
    var curtainSeam = null;
    var anchorL = null;
    var anchorR = null;
    var clickHint = null;
    var vfills = null;

    var running = false;
    var aborted = false;
    var appReady = false;
    var bootProgress = 0;
    var displayProgress = 0;
    var introFinished = false;
    var timers = [];
    var rafId = 0;
    var curtainRaf = 0;
    var curtainAnims = [];
    var doneCallbacks = [];

    function buildWordHtml(text, side) {
        var chars = text.split("");
        var dim = "";
        var lit = "";
        for (var i = 0; i < chars.length; i++) {
            var order = side === "left" ? chars.length - 1 - i : i;
            dim += '<span class="ch-slot">' + chars[i] + "</span>";
            lit +=
                '<span class="ch-slot" data-order="' +
                order +
                '"><span class="ch-glyph">' +
                chars[i] +
                "</span></span>";
        }
        return (
            '<div class="word word-' +
            side +
            '"><div class="word-dim">' +
            dim +
            '</div><div class="word-lit">' +
            lit +
            "</div></div>"
        );
    }

    function buildCrossHtml() {
        return (
            '<div class="cross-unit">' +
            '<div class="vstem"><div class="vfill" data-vfill></div></div>' +
            '<div class="cross-row">' +
            buildWordHtml(TEXT, "left") +
            '<div class="stem-slot"></div>' +
            buildWordHtml(TEXT2, "right") +
            "</div></div>"
        );
    }

    function buildCrossMarkup() {
        if (!anchorL || !anchorR) return;
        var html = buildCrossHtml();
        anchorL.innerHTML = html;
        anchorR.innerHTML = html;
        vfills = document.querySelectorAll("#intro [data-vfill]");
    }

    function clearTimers() {
        timers.forEach(clearTimeout);
        timers = [];
        if (rafId) cancelAnimationFrame(rafId);
        if (curtainRaf) cancelAnimationFrame(curtainRaf);
        curtainAnims.forEach(function (a) {
            try {
                a.cancel();
            } catch (_e) {
                /* ignore */
            }
        });
        curtainAnims = [];
        rafId = 0;
        curtainRaf = 0;
    }

    function wait(ms) {
        if (aborted) return Promise.resolve();
        return new Promise(function (r) {
            timers.push(setTimeout(r, ms));
        });
    }

    function easeLiquid(t) {
        return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    }

    function stemFromProgress(p) {
        if (p <= 0.3) return (p / 0.3) * FILL_TO_TEXT;
        return FILL_TO_TEXT + ((p - 0.3) / 0.7) * (100 - FILL_TO_TEXT);
    }

    function setStemHeight(pct) {
        if (!vfills) return;
        vfills.forEach(function (el) {
            el.style.height = pct + "%";
        });
    }

    function easeFill(t) {
        return t * t * (3 - 2 * t);
    }

    function charFillSequential(order, t, total) {
        var slot = (1 - CHAR_GAP * (total - 1)) / total;
        var start = order * (slot + CHAR_GAP);
        var end = start + slot;
        if (t <= start) return 0;
        if (t >= end) return 1;
        return easeFill((t - start) / slot);
    }

    function setWordSpread(stemPct) {
        var t = 0;
        if (stemPct >= TEXT_BRIGHT_START) {
            t = Math.min(1, (stemPct - TEXT_BRIGHT_START) / (100 - TEXT_BRIGHT_START));
        }
        document.querySelectorAll("#intro .word-lit .ch-slot[data-order]").forEach(function (slot) {
            var order = parseInt(slot.getAttribute("data-order"), 10) || 0;
            var p = charFillSequential(order, t, CHAR_COUNT);
            slot.style.setProperty("--fill", p.toFixed(3));
            slot.classList.toggle("is-empty", p <= 0.001);
            slot.classList.toggle("is-done", p >= 0.999);
        });
    }

    function applyLoadProgress(p) {
        var stem = stemFromProgress(p);
        setStemHeight(stem);
        setWordSpread(stem);
    }

    function resetCurtainStyles() {
        if (curtainL) {
            curtainL.style.transform = "";
            curtainL.style.transition = "";
            curtainL.style.willChange = "";
        }
        if (curtainR) {
            curtainR.style.transform = "";
            curtainR.style.transition = "";
            curtainR.style.willChange = "";
        }
        if (curtainSeam) {
            curtainSeam.style.opacity = "";
            curtainSeam.style.transition = "";
        }
    }

    function lockCurtainOpen() {
        if (curtainL) {
            curtainL.style.transition = "none";
            curtainL.style.transform = "translate3d(-100%, 0, 0)";
        }
        if (curtainR) {
            curtainR.style.transition = "none";
            curtainR.style.transform = "translate3d(100%, 0, 0)";
        }
        if (curtainSeam) {
            curtainSeam.style.transition = "none";
            curtainSeam.style.opacity = "0";
        }
    }

    function clearCurtainReveal(keepOpen) {
        document.body.classList.remove("intro-reveal", "intro-reveal-app", "intro-curtain-animating");
        if (intro) {
            intro.classList.remove("intro-reveal", "is-curtain-animating", "is-content-fading");
        }
        if (!keepOpen) resetCurtainStyles();
    }

    function waitFrames(n) {
        return new Promise(function (resolve) {
            function step() {
                if (aborted) {
                    resolve();
                    return;
                }
                if (--n <= 0) resolve();
                else rafId = requestAnimationFrame(step);
            }
            rafId = requestAnimationFrame(step);
        });
    }

    function prepareCurtainReveal() {
        return waitFrames(0).then(function () {
            if (aborted) return;
            document.body.classList.add("intro-reveal-app");
            var app = document.getElementById("app");
            if (app) void app.offsetHeight;
            return waitFrames(2);
        }).then(function () {
            if (aborted) return;
            document.body.classList.add("intro-reveal", "intro-curtain-animating");
            if (intro) {
                intro.classList.add("intro-reveal", "is-curtain-animating");
                intro.classList.remove("is-content-fading");
            }
            resetCurtainStyles();
            if (curtainL) curtainL.style.transform = "translate3d(0, 0, 0)";
            if (curtainR) curtainR.style.transform = "translate3d(0, 0, 0)";
            if (curtainSeam) curtainSeam.style.opacity = "1";
            if (curtainL) void curtainL.offsetHeight;
            return waitFrames(1);
        });
    }

    function resetVisuals() {
        clearCurtainReveal(false);
        applyLoadProgress(0);
    }

    function setBootProgress(p) {
        bootProgress = Math.max(bootProgress, Math.min(1, Number(p) || 0));
        if (bootProgress >= 0.999) appReady = true;
    }

    function animateLoadUntilReady() {
        return new Promise(function (resolve) {
            if (aborted) {
                resolve();
                return;
            }
            var start = performance.now();

            function tick(now) {
                if (aborted) {
                    resolve();
                    return;
                }
                var elapsed = now - start;
                var timeCap = Math.min(1, elapsed / MIN_SHOW);
                var target = elapsed < MIN_SHOW ? Math.min(bootProgress, timeCap) : bootProgress;

                displayProgress += (target - displayProgress) * LERP;
                if (Math.abs(target - displayProgress) < 0.002) {
                    displayProgress = target;
                }

                applyLoadProgress(easeLiquid(displayProgress));

                if (
                    appReady &&
                    bootProgress >= 0.999 &&
                    elapsed >= MIN_SHOW &&
                    displayProgress >= 0.995
                ) {
                    applyLoadProgress(1);
                    resolve();
                    return;
                }
                if (!appReady && elapsed >= MAX_BOOT_WAIT) {
                    setBootProgress(1);
                }
                rafId = requestAnimationFrame(tick);
            }
            rafId = requestAnimationFrame(tick);
        });
    }

    function animateCurtain(durationMs) {
        return new Promise(function (resolve) {
            if (aborted) {
                resolve();
                return;
            }
            var dur = durationMs || CURTAIN_DURATION;
            var settled = false;

            function settle() {
                if (settled || aborted) return;
                settled = true;
                curtainAnims.forEach(function (anim) {
                    try {
                        if (typeof anim.commitStyles === "function") anim.commitStyles();
                        anim.cancel();
                    } catch (_e) {
                        /* ignore */
                    }
                });
                curtainAnims = [];
                lockCurtainOpen();
                document.body.classList.remove("intro-curtain-animating");
                if (intro) intro.classList.remove("is-curtain-animating");
                resolve();
            }

            if (intro) intro.classList.add("is-content-fading");

            var animOpts = {
                duration: dur,
                easing: CURTAIN_EASE,
                fill: "forwards",
            };

            if (curtainL && curtainL.animate) {
                curtainAnims.push(
                    curtainL.animate(
                        [
                            { transform: "translate3d(0, 0, 0)" },
                            { transform: "translate3d(-100%, 0, 0)" },
                        ],
                        animOpts
                    )
                );
            }
            if (curtainR && curtainR.animate) {
                curtainAnims.push(
                    curtainR.animate(
                        [
                            { transform: "translate3d(0, 0, 0)" },
                            { transform: "translate3d(100%, 0, 0)" },
                        ],
                        animOpts
                    )
                );
            }
            if (curtainSeam && curtainSeam.animate) {
                curtainAnims.push(
                    curtainSeam.animate(
                        [{ opacity: 1 }, { opacity: 0 }],
                        {
                            duration: Math.round(dur * 0.7),
                            easing: "ease-out",
                            fill: "forwards",
                        }
                    )
                );
            }

            if (!curtainAnims.length) {
                settle();
                return;
            }

            Promise.all(
                curtainAnims.map(function (anim) {
                    return anim.finished.catch(function () {});
                })
            ).then(settle);

            timers.push(setTimeout(settle, dur + 120));
        });
    }

    function fireDone() {
        if (introFinished) return;
        introFinished = true;
        clearCurtainReveal(true);
        document.body.classList.remove("intro-active");
        doneCallbacks.forEach(function (fn) {
            try {
                fn();
            } catch (_e) {
                /* ignore */
            }
        });
        doneCallbacks = [];
    }

    function finishIntro(skipped) {
        clearTimers();
        if (intro) {
            intro.classList.add("is-done");
            intro.setAttribute("aria-hidden", "true");
        }
        if (clickHint) {
            clickHint.hidden = true;
        }
        running = false;
        aborted = false;
        fireDone();
        if (skipped && intro) {
            global.setTimeout(function () {
                if (intro && intro.parentNode) intro.parentNode.removeChild(intro);
            }, 320);
        } else if (intro) {
            global.setTimeout(function () {
                if (intro && intro.parentNode) intro.parentNode.removeChild(intro);
            }, 480);
        }
    }

    function enterNow() {
        if (!running) return;
        aborted = true;
        clearTimers();
        finishIntro(true);
    }

    async function play() {
        if (running || !intro) return;
        running = true;
        aborted = false;
        appReady = false;
        bootProgress = 0;
        displayProgress = 0;
        intro.classList.remove("is-done");
        intro.removeAttribute("aria-hidden");
        intro.style.opacity = "";
        document.body.classList.add("intro-active");
        resetVisuals();

        if (global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            applyLoadProgress(1);
            await wait(320);
            if (!aborted) finishIntro(false);
            return;
        }

        await animateLoadUntilReady();
        if (aborted) return;
        await wait(HOLD);
        if (aborted) return;
        await prepareCurtainReveal();
        if (aborted) return;
        await animateCurtain(CURTAIN_DURATION);
        if (!aborted) finishIntro(false);
    }

    function bindDom() {
        intro = document.getElementById("intro");
        curtainL = document.getElementById("curtainL");
        curtainR = document.getElementById("curtainR");
        curtainSeam = document.getElementById("curtainSeam");
        anchorL = document.getElementById("anchorL");
        anchorR = document.getElementById("anchorR");
        clickHint = document.getElementById("intro-click-hint");
        if (!intro || !curtainL || !curtainR || !anchorL || !anchorR) return false;
        buildCrossMarkup();
        intro.addEventListener("click", function () {
            if (running) enterNow();
        });
        return true;
    }

    function onDomReady() {
        if (!bindDom()) return;
        play();
    }

    global.WorshipIntro = {
        setProgress: setBootProgress,
        signalAppReady: function () {
            setBootProgress(1);
        },
        whenDone: function (fn) {
            if (typeof fn !== "function") return;
            if (introFinished) fn();
            else doneCallbacks.push(fn);
        },
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", onDomReady);
    } else {
        onDomReady();
    }
})(window);
