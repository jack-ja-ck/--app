(() => {
    "use strict";

    /** 右侧边窗竖条：后台视频优化进度（非模态，可取消） */
    const jobs = new Map();
    let rootEl = null;

    function ensureRoot() {
        if (rootEl && rootEl.isConnected) return rootEl;
        rootEl = document.getElementById("worship-video-bg-jobs");
        if (!rootEl) {
            rootEl = document.createElement("aside");
            rootEl.id = "worship-video-bg-jobs";
            rootEl.className = "worship-video-bg-jobs";
            rootEl.setAttribute("aria-live", "polite");
            rootEl.setAttribute("aria-label", "视频背景处理进度");
            document.body.appendChild(rootEl);
        }
        return rootEl;
    }

    function shortName(name) {
        const s = String(name || "视频").trim() || "视频";
        return s.length > 18 ? s.slice(0, 8) + "…" + s.slice(-7) : s;
    }

    function renderJobEl(job) {
        const wrap = document.createElement("div");
        wrap.className = "worship-video-bg-job";
        wrap.dataset.jobId = job.id;
        if (job.status === "done") wrap.classList.add("worship-video-bg-job--done");
        if (job.status === "error") wrap.classList.add("worship-video-bg-job--error");

        const track = document.createElement("div");
        track.className = "worship-video-bg-job__track";
        track.setAttribute("role", "progressbar");
        track.setAttribute("aria-valuemin", "0");
        track.setAttribute("aria-valuemax", "100");
        track.setAttribute("aria-valuenow", String(Math.round(job.percent || 0)));

        const fill = document.createElement("div");
        fill.className = "worship-video-bg-job__fill";
        fill.style.height = `${Math.max(0, Math.min(100, job.percent || 0))}%`;
        track.appendChild(fill);

        const meta = document.createElement("div");
        meta.className = "worship-video-bg-job__meta";

        const label = document.createElement("span");
        label.className = "worship-video-bg-job__label";
        label.textContent = job.label || "处理中";

        const name = document.createElement("span");
        name.className = "worship-video-bg-job__name";
        name.textContent = shortName(job.fileName);
        name.title = String(job.fileName || "");

        const pct = document.createElement("span");
        pct.className = "worship-video-bg-job__pct";
        pct.textContent = `${Math.round(job.percent || 0)}%`;

        meta.appendChild(label);
        meta.appendChild(name);
        meta.appendChild(pct);

        if (job.status === "running" && typeof job.onCancel === "function") {
            const cancel = document.createElement("button");
            cancel.type = "button";
            cancel.className = "worship-video-bg-job__cancel";
            cancel.setAttribute("aria-label", "取消处理");
            cancel.textContent = "×";
            cancel.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                job.onCancel();
            });
            meta.appendChild(cancel);
        }

        wrap.appendChild(track);
        wrap.appendChild(meta);
        return wrap;
    }

    function refreshDom() {
        const root = ensureRoot();
        root.replaceChildren();
        const list = Array.from(jobs.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        if (!list.length) {
            root.hidden = true;
            return;
        }
        root.hidden = false;
        list.forEach((job) => root.appendChild(renderJobEl(job)));
    }

    function createJob(id, fileName, onCancel) {
        const job = {
            id,
            fileName,
            label: "读取中",
            percent: 2,
            status: "running",
            createdAt: Date.now(),
            onCancel
        };
        jobs.set(id, job);
        refreshDom();
        return job;
    }

    function updateJob(id, patch) {
        const job = jobs.get(id);
        if (!job) return;
        Object.assign(job, patch || {});
        refreshDom();
    }

    function finishJob(id, status, label) {
        const job = jobs.get(id);
        if (!job) return;
        job.status = status;
        job.label = label || job.label;
        job.percent = status === "done" ? 100 : job.percent;
        job.onCancel = null;
        refreshDom();
        window.setTimeout(() => {
            jobs.delete(id);
            refreshDom();
        }, status === "done" ? 2200 : 4200);
    }

    function cancelJob(id) {
        jobs.delete(id);
        refreshDom();
    }

    globalThis.WorshipVideoBgProgress = {
        createJob,
        updateJob,
        finishJob,
        cancelJob
    };
})();
