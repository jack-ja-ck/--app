(() => {
    "use strict";

    const C = () => globalThis.WorshipConstants || {};
    const Progress = () => globalThis.WorshipVideoBgProgress;

    const FFMPEG_CORE_VER = "0.12.10";
    const FFMPEG_PKG_VER = "0.12.15";
    const FFMPEG_UTIL_VER = "0.12.2";

    let ffmpegInstance = null;
    let ffmpegLoadPromise = null;
    let jobQueue = Promise.resolve();
    const abortByJobId = new Map();

    function isVideoFile(file) {
        if (!file) return false;
        const name = String(file.name || "").toLowerCase();
        const mime = String(file.type || "").toLowerCase();
        if (mime.startsWith("video/")) return true;
        return /\.(mp4|webm|mov|m4v|ogv|ogg|mkv|avi)$/i.test(name);
    }

    function probeVideoFile(file) {
        return new Promise((resolve, reject) => {
            if (!file) {
                reject(new Error("no file"));
                return;
            }
            const url = URL.createObjectURL(file);
            const video = document.createElement("video");
            video.preload = "metadata";
            video.muted = true;
            video.playsInline = true;
            const cleanup = () => {
                try {
                    video.removeAttribute("src");
                    video.load();
                } catch (_e) {
                    /* ignore */
                }
                try {
                    video.remove();
                } catch (_e2) {
                    /* ignore */
                }
                URL.revokeObjectURL(url);
            };
            video.onloadedmetadata = () => {
                resolve({
                    width: video.videoWidth || 0,
                    height: video.videoHeight || 0,
                    duration: Number(video.duration) || 0
                });
                cleanup();
            };
            video.onerror = () => {
                cleanup();
                reject(new Error("probe failed"));
            };
            video.src = url;
        });
    }

    function shouldOptimizeVideo(file, probe) {
        const cfg = C();
        const maxBytes = cfg.VIDEO_BG_SKIP_OPTIMIZE_MAX_BYTES || 40 * 1024 * 1024;
        const maxW = cfg.VIDEO_BG_MAX_WIDTH || 1920;
        const maxH = cfg.VIDEO_BG_MAX_HEIGHT || 1080;
        const name = String(file.name || "").toLowerCase();
        const mime = String(file.type || "").toLowerCase();
        const w = Number(probe?.width) || 0;
        const h = Number(probe?.height) || 0;

        if ((Number(file.size) || 0) > maxBytes) return true;
        if (w > maxW || h > maxH) return true;
        if (!/\.mp4$/i.test(name) && mime !== "video/mp4") return true;
        if (/\.(mkv|avi|ogv|ogg|m4v|webm|mov)$/i.test(name)) return true;
        if (mime && !/^video\/(mp4|quicktime|webm)$/.test(mime)) return true;
        return false;
    }

    async function loadFfmpeg(onInitProgress) {
        if (ffmpegInstance) return ffmpegInstance;
        if (ffmpegLoadPromise) return ffmpegLoadPromise;

        ffmpegLoadPromise = (async () => {
            if (typeof onInitProgress === "function") onInitProgress(0, "准备优化引擎…");
            const { FFmpeg } = await import(
                `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_PKG_VER}/dist/esm/index.js`
            );
            const { toBlobURL, fetchFile } = await import(
                `https://cdn.jsdelivr.net/npm/@ffmpeg/util@${FFMPEG_UTIL_VER}/dist/esm/index.js`
            );
            const base = `https://cdn.jsdelivr.net/npm/@ffmpeg/core-st@${FFMPEG_CORE_VER}/dist/umd`;
            const ffmpeg = new FFmpeg();
            ffmpeg.on("log", () => {});
            if (typeof onInitProgress === "function") onInitProgress(8, "加载优化组件…");
            await ffmpeg.load({
                coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
                wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm")
            });
            ffmpeg._worshipFetchFile = fetchFile;
            ffmpegInstance = ffmpeg;
            if (typeof onInitProgress === "function") onInitProgress(12, "优化引擎就绪");
            return ffmpeg;
        })().catch((err) => {
            ffmpegLoadPromise = null;
            throw err;
        });

        return ffmpegLoadPromise;
    }

    function buildFfmpegArgs(inputName, outputName, quality) {
        const cfg = C();
        const maxW = cfg.VIDEO_BG_MAX_WIDTH || 1920;
        const maxH = cfg.VIDEO_BG_MAX_HEIGHT || 1080;
        const crf = quality === "hd" ? cfg.VIDEO_BG_HD_CRF || 20 : cfg.VIDEO_BG_STD_CRF || 23;
        const vf = `scale=w=${maxW}:h=${maxH}:force_original_aspect_ratio=decrease,pad=${maxW}:${maxH}:(ow-iw)/2:(oh-ih)/2:black`;
        return [
            "-i",
            inputName,
            "-vf",
            vf,
            "-c:v",
            "libx264",
            "-crf",
            String(crf),
            "-preset",
            "medium",
            "-profile:v",
            "high",
            "-pix_fmt",
            "yuv420p",
            "-an",
            "-movflags",
            "+faststart",
            outputName
        ];
    }

    async function optimizeVideoBlob(file, opts) {
        const quality = opts?.quality === "hd" ? "hd" : "standard";
        const jobId = opts?.jobId || "";
        const onProgress = typeof opts?.onProgress === "function" ? opts.onProgress : null;
        const signal = opts?.signal;

        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const ffmpeg = await loadFfmpeg((pct, label) => {
            if (onProgress) onProgress(Math.min(18, pct), label);
        });

        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const fetchFile = ffmpeg._worshipFetchFile;
        const inputName = "worship_bg_in";
        const outputName = "worship_bg_out.mp4";

        const progressHandler = ({ progress }) => {
            if (!onProgress || signal?.aborted) return;
            const p = Number(progress);
            if (!Number.isFinite(p)) return;
            const pct = 12 + Math.round(Math.max(0, Math.min(1, p)) * 78);
            onProgress(Math.min(92, pct), "正在优化…");
        };

        ffmpeg.on("progress", progressHandler);
        try {
            if (onProgress) onProgress(14, "读取视频…");
            await ffmpeg.writeFile(inputName, await fetchFile(file));
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            if (onProgress) onProgress(18, "正在优化…");
            await ffmpeg.exec(buildFfmpegArgs(inputName, outputName, quality));
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            if (onProgress) onProgress(94, "生成文件…");
            const data = await ffmpeg.readFile(outputName);
            try {
                await ffmpeg.deleteFile(inputName);
            } catch (_e) {
                /* ignore */
            }
            try {
                await ffmpeg.deleteFile(outputName);
            } catch (_e2) {
                /* ignore */
            }
            const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
            return new Blob([buf], { type: "video/mp4" });
        } finally {
            ffmpeg.off("progress", progressHandler);
        }
    }

    async function prepareVideoForBackground(file, opts) {
        const jobId = opts?.jobId || `vjob_${Date.now()}`;
        const onProgress = opts?.onProgress;
        const signal = opts?.signal;
        const quality = opts?.quality === "hd" ? "hd" : "standard";

        if (onProgress) onProgress(1, "分析视频…");
        const probe = await probeVideoFile(file);
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        if (!shouldOptimizeVideo(file, probe)) {
            if (onProgress) onProgress(100, "已就绪");
            return {
                blob: file,
                optimized: false,
                probe,
                meta: { optimized: false, quality: "source" }
            };
        }

        const outBlob = await optimizeVideoBlob(file, { jobId, onProgress, signal, quality });
        return {
            blob: outBlob,
            optimized: true,
            probe,
            meta: {
                optimized: true,
                quality,
                sourceWidth: probe.width,
                sourceHeight: probe.height,
                sourceBytes: file.size,
                outputBytes: outBlob.size
            }
        };
    }

    function enqueueVideoBackgroundJob(spec) {
        const P = Progress();
        const jobId = spec?.jobId || `vjob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const file = spec?.file;
        const fileName = file?.name || "视频";
        const toastAnchor = spec?.toastAnchor || null;
        const showToast = typeof spec?.showToast === "function" ? spec.showToast : globalThis.showToast;
        const quality = spec?.quality === "hd" ? "hd" : "standard";

        const controller = new AbortController();
        abortByJobId.set(jobId, controller);

        let jobRef = null;
        if (P) {
            jobRef = P.createJob(jobId, fileName, () => {
                controller.abort();
                P.cancelJob(jobId);
                abortByJobId.delete(jobId);
            });
        }

        const run = async () => {
            try {
                const result = await prepareVideoForBackground(file, {
                    jobId,
                    quality,
                    signal: controller.signal,
                    onProgress: (percent, label) => {
                        if (P) P.updateJob(jobId, { percent, label, status: "running" });
                    }
                });
                abortByJobId.delete(jobId);
                if (P) P.finishJob(jobId, "done", "完成");
                if (typeof spec?.onSuccess === "function") {
                    await spec.onSuccess(result);
                }
                if (typeof showToast === "function") {
                    const msg = result.optimized
                        ? `背景视频已优化完成（${Math.max(1, Math.round((result.blob.size || 0) / (1024 * 1024)))}MB）`
                        : "背景视频已添加";
                    showToast(msg, toastAnchor, { variant: "success" });
                }
                return result;
            } catch (err) {
                abortByJobId.delete(jobId);
                const aborted = err?.name === "AbortError" || controller.signal.aborted;
                if (P) P.finishJob(jobId, "error", aborted ? "已取消" : "失败");
                if (!aborted && typeof showToast === "function") {
                    showToast("视频优化失败，请换 MP4 再试或缩小文件", toastAnchor);
                }
                if (typeof spec?.onError === "function") spec.onError(err);
                throw err;
            }
        };

        jobQueue = jobQueue.then(run, run);
        return { jobId, promise: jobQueue };
    }

    globalThis.WorshipVideoBgOptimize = {
        isVideoFile,
        probeVideoFile,
        shouldOptimizeVideo,
        prepareVideoForBackground,
        enqueueVideoBackgroundJob
    };
})();
