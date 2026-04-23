(function () {
    "use strict";

    // ========== 全局状态 ==========
    let songs = [];
    let currentSongId = null;
    let currentLineIndex = 0;
    const CHORD_REGEX = /\[([^\]]+)\]/g;
    const channel = new BroadcastChannel('worship_channel');

    let autoplayTimer = null;
    let autoplayActive = false;
    let autoplayInterval = 5;
    let previewHeight = null;

    const dom = {};

    let activeTagFilter = '';
    let searchQuery = '';

    let cardContainer, pageIndicator;
    let currentCardPage = 0;
    let totalPages = 1;
    let cardWidth = 320; // 卡片宽度 S/M/L (240/320/400)

    function showToast(msg, dur = 2000) {
        dom.toast.textContent = msg;
        dom.toast.style.opacity = '1';
        clearTimeout(window._t);
        window._t = setTimeout(() => dom.toast.style.opacity = '0', dur);
    }

    function getCurrentSong() {
        return songs.find(s => s.id === currentSongId) || songs[0];
    }

    // ========== 数据持久化 ==========
    function saveAllData() {
        localStorage.setItem('worship_songs', JSON.stringify(songs));
        localStorage.setItem('worship_current_id', currentSongId);
        if (previewHeight) localStorage.setItem('preview_height', previewHeight);
        if (dom.songLibrary) localStorage.setItem('panel_left_width', dom.songLibrary.style.width);
        if (dom.previewPanel) localStorage.setItem('panel_right_width', dom.previewPanel.style.width);
        localStorage.setItem('card_width', cardWidth);
    }

    function loadAllData() {
        const saved = localStorage.getItem('worship_songs');
        if (saved) { try { songs = JSON.parse(saved); } catch(e) { songs = []; } }
        const savedId = localStorage.getItem('worship_current_id');
        currentSongId = savedId || (songs.length ? songs[0].id : null);
        if (!songs.length) {
            songs.push({
                id: '1', title: '奇异恩典',
                lyrics: ['[G]奇异恩典 何等甘甜','[C]我罪已得赦免','[G]前我失丧 今被寻回','[Em]瞎眼今得看见'],
                bgType: 'particles', fontSize: 56, displayLines: 4, previewLines: 4, posY: 45,
                key: 'C', tempo: '72', notes: '', tags: ['敬拜','经典'], history: []
            });
            currentSongId = '1';
        }
        const savedH = localStorage.getItem('preview_height');
        if (savedH) previewHeight = savedH;
        const savedCW = localStorage.getItem('card_width');
        if (savedCW) cardWidth = parseInt(savedCW) || 320;
    }

    // ========== 快速预览区 ==========
    const MAX_PREVIEW_LINES = 20;
    const previewLineElements = [];
    function initPreviewLines() {
        dom.miniPreview.innerHTML = '';
        for (let i = 0; i < MAX_PREVIEW_LINES; i++) {
            const d = document.createElement('div');
            d.className = 'preview-line';
            d.style.display = 'none';
            dom.miniPreview.appendChild(d);
            previewLineElements.push(d);
        }
        if (previewHeight) dom.miniPreview.style.height = previewHeight;
    }

    function applyPreviewBackground(song) {
        const p = dom.miniPreview;
        p.style.background = ''; p.style.backgroundColor = '';
        if (song.bgType === 'solid') p.style.backgroundColor = '#000';
        else if (song.bgType === 'gradient') p.style.background = 'radial-gradient(circle at 30% 30%, #1a2a4a, #000)';
        else if (song.bgType === 'image' && song.bgImage) {
            p.style.backgroundImage = `url(${song.bgImage})`; p.style.backgroundSize = 'cover'; p.style.backgroundPosition = 'center';
        } else p.style.backgroundColor = '#000';
    }

    function updateMiniPreview() {
        const song = getCurrentSong();
        if (!song) return;
        applyPreviewBackground(song);
        const rawLines = song.lyrics;
        const start = currentLineIndex;
        const count = Math.min(song.previewLines || song.displayLines || 4, MAX_PREVIEW_LINES);
        previewLineElements.forEach((el, i) => {
            if (i < count) {
                const idx = (start + i) % rawLines.length;
                const line = rawLines[idx];
                const chords = [];
                const clean = line.replace(CHORD_REGEX, (m, c) => { chords.push(c); return ''; }).trim();
                const isCur = (i === 0);
                const fs = isCur ? song.fontSize : Math.max(16, song.fontSize * 0.65);
                const op = isCur ? 1 : 0.45;
                const chordsStr = chords.length ? `<span style="font-size:${fs*0.5}px; background:#2a4a6a; padding:2px 6px; border-radius:10px; margin-left:8px;">${chords.join(' ')}</span>` : '';
                el.style.display = 'block'; el.style.fontSize = fs + 'px'; el.style.opacity = op;
                el.innerHTML = clean + chordsStr;
            } else el.style.display = 'none';
        });
        if (dom.previewLineCounter) dom.previewLineCounter.textContent = `${currentLineIndex+1}/${song.lyrics.length}`;
    }

    // ========== 广播 ==========
    function broadcastState() {
        const song = getCurrentSong();
        const clean = song.lyrics.map(l => l.replace(CHORD_REGEX, '').trim());
        channel.postMessage({ type: 'update', song: { ...song, lyrics: clean }, currentLine: currentLineIndex });
        if (!song.history) song.history = [];
        song.history.push(Date.now());
        saveAllData();
    }

    // ========== 翻页 ==========
    function nextLine() {
        const s = getCurrentSong();
        if (!s.lyrics.length) return;
        currentLineIndex = (currentLineIndex + 1) % s.lyrics.length;
        updateMiniPreview(); updateSpeakerCards(); broadcastState(); resetAutoplayProgress();
    }
    function prevLine() {
        const s = getCurrentSong();
        if (!s.lyrics.length) return;
        currentLineIndex = (currentLineIndex - 1 + s.lyrics.length) % s.lyrics.length;
        updateMiniPreview(); updateSpeakerCards(); broadcastState(); resetAutoplayProgress();
    }

    // ========== 自动播放 ==========
    function startAutoplay() {
        if (autoplayTimer) clearInterval(autoplayTimer);
        autoplayActive = true; dom.autoplayToggle.textContent = '⏸️ 暂停';
        let remaining = autoplayInterval; dom.autoplayProgress.style.width = '0%';
        const step = 100 / (autoplayInterval * 10);
        autoplayTimer = setInterval(() => {
            if (remaining <= 0) { nextLine(); remaining = autoplayInterval; dom.autoplayProgress.style.width = '0%'; }
            else { remaining -= 0.1; dom.autoplayProgress.style.width = ((autoplayInterval - remaining) / autoplayInterval * 100) + '%'; }
        }, 100);
    }
    function pauseAutoplay() { if (autoplayTimer) clearInterval(autoplayTimer); autoplayActive = false; dom.autoplayToggle.textContent = '▶ 开始'; }
    function stopAutoplay() { pauseAutoplay(); dom.autoplayProgress.style.width = '0%'; }
    function resetAutoplayProgress() { if (autoplayActive) dom.autoplayProgress.style.width = '0%'; }

    // ========== 诗歌列表与筛选 ==========
    function getFilteredSongs() {
        return songs.filter(s => {
            const matchSearch = !searchQuery || s.title.toLowerCase().includes(searchQuery.toLowerCase());
            const matchTag = !activeTagFilter || (s.tags && s.tags.includes(activeTagFilter));
            return matchSearch && matchTag;
        });
    }
    function renderSongList() {
        dom.songList.innerHTML = '';
        getFilteredSongs().forEach(song => {
            const li = document.createElement('li');
            li.className = 'song-item' + (song.id === currentSongId ? ' active' : '');
            const count = song.history ? song.history.length : 0;
            li.innerHTML = `<span style="flex:1;">${song.title}</span><span class="song-meta">${count?'🎤'+count:''}</span><span class="song-actions"><button data-id="${song.id}" class="delete-song" style="color:#f77;">✕</button></span>`;
            li.addEventListener('click', (e) => { if (!e.target.classList.contains('delete-song')) switchSong(song.id); });
            dom.songList.appendChild(li);
        });
        document.querySelectorAll('.delete-song').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); deleteSong(b.dataset.id); }));
    }
    function renderTagFilters() {
        const tags = new Set(); songs.forEach(s => { if (s.tags) s.tags.forEach(t => tags.add(t)); });
        dom.tagFilter.innerHTML = '';
        const allBtn = document.createElement('button'); allBtn.textContent = '全部'; allBtn.className = 'small-btn';
        if (!activeTagFilter) allBtn.style.background = 'var(--accent)';
        allBtn.addEventListener('click', () => { activeTagFilter = ''; renderTagFilters(); renderSongList(); });
        dom.tagFilter.appendChild(allBtn);
        tags.forEach(tag => {
            const btn = document.createElement('button'); btn.textContent = tag; btn.className = 'small-btn';
            if (activeTagFilter === tag) btn.style.background = 'var(--accent)';
            btn.addEventListener('click', () => { activeTagFilter = tag; renderTagFilters(); renderSongList(); });
            dom.tagFilter.appendChild(btn);
        });
    }

    function switchSong(id) {
        currentSongId = id; const s = getCurrentSong();
        dom.songTitleInput.value = s.title; dom.lyricEditor.value = s.lyrics.join('\n');
        dom.fontSlider.value = s.fontSize; dom.fontVal.textContent = s.fontSize;
        dom.displayLinesInput.value = s.displayLines || 4; dom.previewLinesInput.value = s.previewLines || 4;
        dom.posSlider.value = s.posY; dom.posVal.textContent = s.posY + '%';
        dom.songKey.value = s.key || ''; dom.songTempo.value = s.tempo || ''; dom.songNotes.value = s.notes || '';
        dom.songTags.value = s.tags ? s.tags.join(',') : '';
        document.querySelectorAll('.bg-option').forEach(o => o.classList.toggle('active', o.dataset.bg === s.bgType));
        currentLineIndex = 0; updateMiniPreview(); updateSpeakerCards(); renderSongList(); broadcastState(); stopAutoplay(); saveAllData();
    }
    function deleteSong(id) {
        if (songs.length <= 1) { showToast('至少保留一首'); return; }
        songs = songs.filter(s => s.id !== id); if (currentSongId === id) currentSongId = songs[0].id;
        renderSongList(); renderTagFilters(); switchSong(currentSongId);
    }
    function createNewSong() {
        const id = Date.now().toString();
        songs.push({ id, title: '新诗歌', lyrics: ['新歌词'], bgType: 'particles', fontSize: 56, displayLines: 4, previewLines: 4, posY: 45, key: '', tempo: '', notes: '', tags: [], history: [] });
        renderSongList(); renderTagFilters(); switchSong(id);
    }
    function saveCurrentLyrics() {
        const s = getCurrentSong();
        const newLyrics = dom.lyricEditor.value.split('\n').map(l => l.trim()).filter(l => l);
        if (!newLyrics.length) { showToast('歌词不能为空'); return; }
        s.lyrics = newLyrics; s.title = dom.songTitleInput.value.trim() || '未命名';
        s.key = dom.songKey.value.trim(); s.tempo = dom.songTempo.value.trim(); s.notes = dom.songNotes.value.trim();
        s.tags = dom.songTags.value.split(',').map(t => t.trim()).filter(t => t);
        if (currentLineIndex >= newLyrics.length) currentLineIndex = 0;
        renderSongList(); renderTagFilters(); updateMiniPreview(); updateSpeakerCards(); broadcastState(); saveAllData();
        showToast('已保存');
    }

    // ========== 背景 ==========
    function setBackground(type, imgData = null) {
        const s = getCurrentSong(); s.bgType = type; if (type === 'image' && imgData) s.bgImage = imgData;
        document.querySelectorAll('.bg-option').forEach(o => o.classList.toggle('active', o.dataset.bg === type));
        updateMiniPreview(); updateSpeakerCards(); broadcastState(); saveAllData();
    }
    function handleBgImageUpload(file) {
        const reader = new FileReader();
        reader.onload = (e) => { setBackground('image', e.target.result); showToast('背景图片已上传'); };
        reader.readAsDataURL(file);
    }

    // ========== OCR ==========
    function initOCR() {
        dom.ocrBtn.addEventListener('click', () => dom.ocrFileInput.click());
        dom.ocrFileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0]; if (!file) return;
            showToast('识别中…', 8000); dom.ocrBtn.disabled = true;
            try {
                const { data: { text } } = await Tesseract.recognize(file, 'chi_sim+eng');
                const lines = text.split('\n').map(l => l.trim()).filter(l => l);
                dom.lyricEditor.value = lines.join('\n'); showToast(`完成，${lines.length}行`, 2000);
            } catch (err) { showToast('识别失败'); } finally { dom.ocrBtn.disabled = false; dom.ocrFileInput.value = ''; }
        });
    }

    // ========== 批量导入 ==========
    function showBatchImportDialog() {
        const text = prompt('📋 批量导入歌词\n\n每首诗歌空行隔开，第一行为标题。');
        if (!text || !text.trim()) return;
        const blocks = text.split(/\n\s*\n/); let count = 0;
        blocks.forEach(block => {
            const lines = block.split('\n').map(l => l.trim()).filter(l => l);
            if (lines.length < 2) return;
            songs.push({ id: Date.now().toString()+Math.random(), title: lines[0], lyrics: lines.slice(1), bgType:'particles', fontSize:56, displayLines:4, previewLines:4, posY:45, key:'', tempo:'', notes:'', tags:[], history:[] });
            count++;
        });
        if (count) { saveAllData(); renderSongList(); renderTagFilters(); switchSong(songs[songs.length-1].id); showToast(`导入 ${count} 首`); }
        else showToast('未识别到有效诗歌');
    }

    // ========== 主题 ==========
    function initTheme() {
        const saved = localStorage.getItem('worship_theme') || 'dark';
        document.body.setAttribute('data-theme', saved); dom.themeSelector.value = saved;
        dom.themeSelector.addEventListener('change', (e) => { document.body.setAttribute('data-theme', e.target.value); localStorage.setItem('worship_theme', e.target.value); });
    }

    // ========== 拖拽分隔条 ==========
    function initResizable() {
        const lp = dom.songLibrary, rp = dom.previewPanel, h1 = dom.resize1, h2 = dom.resize2;
        const savedLeft = localStorage.getItem('panel_left_width'), savedRight = localStorage.getItem('panel_right_width');
        if (savedLeft) lp.style.width = savedLeft; if (savedRight) rp.style.width = savedRight;
        let resizing = false, cur = null, sx, sw;
        const down = (e) => { resizing = true; cur = e.target; sx = e.clientX; sw = cur === h1 ? lp.offsetWidth : rp.offsetWidth; cur.classList.add('active'); document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; };
        const move = (e) => { if (!resizing) return; const dx = e.clientX - sx; if (cur === h1) lp.style.width = Math.max(120, Math.min(900, sw + dx)) + 'px'; else rp.style.width = Math.max(180, Math.min(900, sw - dx)) + 'px'; };
        const up = () => { if (resizing) { resizing = false; cur.classList.remove('active'); document.body.style.cursor = ''; document.body.style.userSelect = ''; saveAllData(); } };
        h1.addEventListener('mousedown', down); h2.addEventListener('mousedown', down);
        window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    }

    // ========== 预览框高度拖拽 ==========
    function initPreviewResize() {
        const handle = document.getElementById('preview-resize-handle'), preview = dom.miniPreview;
        let y, h;
        handle.addEventListener('mousedown', e => {
            e.preventDefault(); y = e.clientY; h = preview.offsetHeight; document.body.style.cursor = 'ns-resize';
            const onMove = (ev) => { const nh = Math.max(80, Math.min(500, h + (ev.clientY - y))) + 'px'; preview.style.height = nh; previewHeight = nh; };
            const onUp = () => { document.body.style.cursor = ''; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); saveAllData(); };
            window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
        });
    }

    // ========== 智能滚轮 ==========
    function initScroll() {
        dom.previewPanel.addEventListener('wheel', e => {
            if (e.target.closest('#mini-preview')) { e.preventDefault(); e.deltaY > 0 ? nextLine() : prevLine(); }
        }, { passive: false });
    }
    // ========== 演讲者视图 ==========
    function initSpeakerView() {
        cardContainer = document.getElementById('card-container');
        pageIndicator = document.getElementById('page-indicator');
        cardContainer.addEventListener('scroll', () => updateCurrentCardFromScroll());

        // 卡片尺寸切换按钮
        const sizeS = document.getElementById('size-s');
        const sizeM = document.getElementById('size-m');
        const sizeL = document.getElementById('size-l');
        const setActiveSize = (active, others) => {
            active.classList.add('active');
            others.forEach(b => b.classList.remove('active'));
        };
        sizeS.addEventListener('click', () => { cardWidth = 240; setActiveSize(sizeS, [sizeM, sizeL]); saveAllData(); updateSpeakerCards(); });
        sizeM.addEventListener('click', () => { cardWidth = 320; setActiveSize(sizeM, [sizeS, sizeL]); saveAllData(); updateSpeakerCards(); });
        sizeL.addEventListener('click', () => { cardWidth = 400; setActiveSize(sizeL, [sizeS, sizeM]); saveAllData(); updateSpeakerCards(); });
        // 恢复上次激活状态
        if (cardWidth === 240) setActiveSize(sizeS, [sizeM, sizeL]);
        else if (cardWidth === 400) setActiveSize(sizeL, [sizeS, sizeM]);
        else setActiveSize(sizeM, [sizeS, sizeL]);

        // 演讲者区域高度拖拽
        const speakerView = document.getElementById('speaker-view');
        const speakerHandle = document.getElementById('speaker-resize-handle');
        let sy, sh;
        speakerHandle.addEventListener('mousedown', e => {
            e.preventDefault(); sy = e.clientY; sh = speakerView.offsetHeight;
            document.body.style.cursor = 'ns-resize';
            const onMove = (ev) => {
                const newH = Math.max(180, Math.min(600, sh + (ev.clientY - sy))) + 'px';
                speakerView.style.height = newH;
                localStorage.setItem('speaker_height', newH);
            };
            const onUp = () => {
                document.body.style.cursor = '';
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });
        const savedSH = localStorage.getItem('speaker_height');
        if (savedSH) speakerView.style.height = savedSH;
    }

    function createParticleBackground(card) {
        const bgDiv = document.createElement('div');
        bgDiv.className = 'particle-bg';
        for (let i = 0; i < 12; i++) {
            const dot = document.createElement('div');
            dot.className = 'particle-dot';
            const size = Math.random() * 4 + 2;
            dot.style.width = size + 'px';
            dot.style.height = size + 'px';
            dot.style.left = Math.random() * 100 + '%';
            dot.style.top = Math.random() * 100 + '%';
            dot.style.animationDuration = (Math.random() * 6 + 4) + 's';
            dot.style.animationDelay = (Math.random() * 4) + 's';
            bgDiv.appendChild(dot);
        }
        card.appendChild(bgDiv);
    }

    function applyCardBackground(card, song) {
        const oldParticle = card.querySelector('.particle-bg');
        if (oldParticle) oldParticle.remove();
        card.style.background = '';
        card.style.backgroundImage = '';
        if (song.bgType === 'solid') {
            card.style.backgroundColor = '#000';
        } else if (song.bgType === 'gradient') {
            card.style.background = 'radial-gradient(circle at 30% 30%, #1a2a4a, #000)';
        } else if (song.bgType === 'image' && song.bgImage) {
            card.style.backgroundImage = `url(${song.bgImage})`;
            card.style.backgroundSize = 'cover';
            card.style.backgroundPosition = 'center';
        } else {
            card.style.backgroundColor = '#000';
            createParticleBackground(card);
        }
    }

    function updateSpeakerCards() {
        const song = getCurrentSong();
        if (!song || !cardContainer) return;
        const lines = song.lyrics, displayCount = song.displayLines || 4;
        totalPages = Math.ceil(lines.length / displayCount) || 1;
        currentCardPage = Math.floor(currentLineIndex / displayCount);

        cardContainer.innerHTML = '';
        for (let p = 0; p < totalPages; p++) {
            const start = p * displayCount;
            const card = document.createElement('div');
            card.className = 'card';
            card.style.width = cardWidth + 'px';
            if (p === currentCardPage) card.classList.add('active');

            applyCardBackground(card, song);

            for (let i = 0; i < displayCount; i++) {
                const idx = start + i;
                if (idx < lines.length) {
                    const clean = lines[idx].replace(CHORD_REGEX, '').trim();
                    const isCur = (p === currentCardPage && i === 0);
                    const baseFontSize = Math.min(song.fontSize, cardWidth * 0.12);
                    const fontSize = isCur ? baseFontSize : Math.max(16, baseFontSize * 0.65);
                    const lineDiv = document.createElement('div');
                    lineDiv.className = 'card-line';
                    lineDiv.style.fontSize = fontSize + 'px';
                    lineDiv.style.opacity = isCur ? 1 : 0.6;
                    lineDiv.textContent = clean;
                    card.appendChild(lineDiv);
                }
            }
            if (start >= lines.length) { card.classList.add('empty'); card.textContent = '…'; }
            card.addEventListener('click', () => jumpToPage(p));
            cardContainer.appendChild(card);
        }
        pageIndicator.textContent = `${currentCardPage+1}/${totalPages}`;
        const cards = cardContainer.children;
        if (cards[currentCardPage]) cards[currentCardPage].scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }

    function jumpToPage(pageIndex) {
        const song = getCurrentSong(), displayCount = song.displayLines || 4;
        const newLine = pageIndex * displayCount;
        if (newLine < song.lyrics.length) { currentLineIndex = newLine; updateMiniPreview(); updateSpeakerCards(); broadcastState(); }
    }

    function updateCurrentCardFromScroll() {
        const cards = cardContainer.children; if (!cards.length) return;
        const containerRect = cardContainer.getBoundingClientRect(), centerX = containerRect.left + containerRect.width / 2;
        let closestIdx = 0, minDist = Infinity;
        for (let i = 0; i < cards.length; i++) {
            const rect = cards[i].getBoundingClientRect(), cardCenter = rect.left + rect.width / 2;
            const dist = Math.abs(centerX - cardCenter);
            if (dist < minDist) { minDist = dist; closestIdx = i; }
        }
        if (closestIdx !== currentCardPage) {
            currentCardPage = closestIdx; pageIndicator.textContent = `${currentCardPage+1}/${totalPages}`;
            for (let i = 0; i < cards.length; i++) cards[i].classList.toggle('active', i === currentCardPage);
        }
    }

    // ========== 演示窗口 ==========
    function initDisplayMode() {
        document.body.innerHTML = `
            <canvas id="display-canvas" style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:1;"></canvas>
            <div id="display-lyrics" style="position:fixed;top:45%;left:50%;transform:translate(-50%,-50%);z-index:10;text-align:center;pointer-events:none;"></div>
            <div id="blackout-overlay" style="position:fixed;top:0;left:0;width:100%;height:100%;background:#000;z-index:100;display:none;"></div>
            <div id="whiteout-overlay" style="position:fixed;top:0;left:0;width:100%;height:100%;background:#fff;z-index:100;display:none;"></div>
            <div id="ended-overlay" style="position:fixed;top:0;left:0;width:100%;height:100%;background:#000;z-index:90;display:none; flex-direction:column; align-items:center; justify-content:center; color:white; font-size:3rem; font-weight:bold; text-shadow:2px 2px 8px black; text-align:center;">
                <span>投屏已结束 ✝️</span>
                <span style="font-size:1.5rem; margin-top:20px;">按上键返回</span>
            </div>
        `;
        const canvas = document.getElementById('display-canvas'), ctx = canvas.getContext('2d'), lyricsDiv = document.getElementById('display-lyrics'),
              blackout = document.getElementById('blackout-overlay'), whiteout = document.getElementById('whiteout-overlay'),
              endedOverlay = document.getElementById('ended-overlay');
        let w, h, particles = [], currentState = null, ended = false;
        function resize() { w = window.innerWidth; h = window.innerHeight; canvas.width = w; canvas.height = h; }
        window.addEventListener('resize', resize); resize();
        class Particle {
            constructor() { this.x = Math.random()*w; this.y = Math.random()*h; this.vx = (Math.random()-0.5)*0.7; this.vy = (Math.random()-0.5)*0.5; this.size = Math.random()*5+2; this.color = `rgba(255,255,255,${0.7+Math.random()*0.3})`; }
            update() { this.x+=this.vx; this.y+=this.vy; if(this.x<0||this.x>w)this.vx*=-1; if(this.y<0||this.y>h)this.vy*=-1; }
            draw() { ctx.beginPath(); ctx.arc(this.x,this.y,this.size,0,Math.PI*2); ctx.fillStyle=this.color; ctx.shadowColor='white'; ctx.shadowBlur=10; ctx.fill(); }
        }
        for(let i=0;i<70;i++) particles.push(new Particle());
        function drawBg(bg, img) { if(bg==='solid'){ctx.fillStyle='#000';ctx.fillRect(0,0,w,h);} else if(bg==='gradient'){const g=ctx.createRadialGradient(w*.3,h*.3,50,w*.5,h*.5,w);g.addColorStop(0,'#1a2a4a');g.addColorStop(1,'#000');ctx.fillStyle=g;ctx.fillRect(0,0,w,h);} else if(bg==='image'&&img){const i=new Image();i.onload=()=>ctx.drawImage(i,0,0,w,h);i.src=img;} else{ctx.fillStyle='rgba(0,0,0,0.15)';ctx.fillRect(0,0,w,h);particles.forEach(p=>{p.update();p.draw();});} }
        function render(state) {
            if (!state || ended) return;
            const {song, currentLine} = state, lines = song.lyrics;
            let html = '';
            for (let i=0;i<song.displayLines;i++) {
                const idx = (currentLine + i) % lines.length;
                const fs = i===0 ? song.fontSize : Math.max(16, song.fontSize*0.65), op = i===0 ? 1 : 0.5;
                html += `<div style="color:white;font-weight:bold;text-shadow:3px 3px 8px black;font-size:${fs}px;opacity:${op};line-height:1.5;white-space:nowrap;">${lines[idx]}</div>`;
            }
            lyricsDiv.innerHTML = html; lyricsDiv.style.top = song.posY + '%';
            const remaining = lines.length - currentLine;
            if (remaining <= song.displayLines) {
                ended = true;
                setTimeout(() => { endedOverlay.style.display = 'flex'; }, 600);
            }
        }
        function animate() { drawBg(currentState?.song.bgType, currentState?.song.bgImage); requestAnimationFrame(animate); }
        animate();
        const dc = new BroadcastChannel('worship_channel');
        dc.addEventListener('message', e => {
            if (e.data.type === 'update') {
                currentState = e.data;
                ended = false;
                endedOverlay.style.display = 'none';
                lyricsDiv.style.display = 'block';
                render(currentState);
            }
        });
        dc.postMessage({ type: 'request_state' });
        window.addEventListener('keydown', e => {
            if (e.key === 'b' || e.key === 'B') { e.preventDefault(); blackout.style.display = blackout.style.display === 'none' ? 'block' : 'none'; }
            else if (e.key === 'w' || e.key === 'W') { e.preventDefault(); whiteout.style.display = whiteout.style.display === 'none' ? 'block' : 'none'; }
            else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); document.documentElement.requestFullscreen(); }
            else if (e.key === 'Escape') { blackout.style.display = 'none'; whiteout.style.display = 'none'; }
            else if (e.key === 'ArrowUp' && ended) { ended = false; endedOverlay.style.display = 'none'; lyricsDiv.style.display = 'block'; dc.postMessage({ type: 'prev' }); }
        });
    }

    // ========== 控制台监听演示窗请求 ==========
    function initControlChannel() {
        channel.addEventListener('message', e => {
            if (e.data.type === 'request_state') {
                broadcastState();
            }
        });
    }

    // ========== 事件绑定 ==========
    function bindEvents() {
        dom.newSongBtn.addEventListener('click', createNewSong);
        dom.addSongBtn.addEventListener('click', createNewSong);
        dom.saveSongBtn.addEventListener('click', saveCurrentLyrics);
        dom.applyToDisplay.addEventListener('click', () => { saveCurrentLyrics(); showToast('已应用'); });
        dom.resetCurrentSong.addEventListener('click', () => { const s = getCurrentSong(); s.lyrics = ['[G]奇异恩典 何等甘甜','[C]我罪已得赦免','[G]前我失丧 今被寻回','[Em]瞎眼今得看见']; dom.lyricEditor.value = s.lyrics.join('\n'); saveCurrentLyrics(); });
        dom.fontSlider.addEventListener('input', () => { const s = getCurrentSong(); s.fontSize = parseInt(dom.fontSlider.value); dom.fontVal.textContent = s.fontSize; updateMiniPreview(); updateSpeakerCards(); broadcastState(); saveAllData(); });
        dom.displayLinesInput.addEventListener('input', () => { const s = getCurrentSong(); s.displayLines = parseInt(dom.displayLinesInput.value) || 4; updateMiniPreview(); updateSpeakerCards(); broadcastState(); saveAllData(); });
        dom.previewLinesInput.addEventListener('input', () => { const s = getCurrentSong(); s.previewLines = parseInt(dom.previewLinesInput.value) || 4; updateMiniPreview(); saveAllData(); });
        dom.posSlider.addEventListener('input', () => { const s = getCurrentSong(); s.posY = parseInt(dom.posSlider.value); dom.posVal.textContent = s.posY+'%'; updateMiniPreview(); broadcastState(); saveAllData(); });
        document.querySelectorAll('.bg-option').forEach(o => { if (o.id === 'upload-bg-trigger') o.addEventListener('click', () => dom.bgImageInput.click()); else o.addEventListener('click', () => setBackground(o.dataset.bg)); });
        document.getElementById('upload-bg-btn').addEventListener('click', () => dom.bgImageInput.click());
        dom.bgImageInput.addEventListener('change', e => { if (e.target.files[0]) handleBgImageUpload(e.target.files[0]); });
        dom.autoplayToggle.addEventListener('click', () => { autoplayInterval = parseFloat(dom.autoplayInterval.value) || 5; autoplayActive ? pauseAutoplay() : startAutoplay(); });
        dom.autoplayStop.addEventListener('click', stopAutoplay);
        dom.openDisplayBtn.addEventListener('click', () => { const url = window.location.href.split('?')[0] + '?display'; const win = window.open(url, '_blank', 'width=1280,height=720'); if (win) showToast('演示窗口已打开'); else showToast('弹窗被阻止，请允许弹出窗口'); });
        dom.exportDataBtn.addEventListener('click', () => { const d = JSON.stringify({ songs, currentSongId }); const b = new Blob([d], { type: 'application/json' }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = `worship_backup_${new Date().toISOString().slice(0,10)}.worship`; a.click(); URL.revokeObjectURL(u); showToast('已导出'); });
        dom.importDataBtn.addEventListener('click', () => dom.importFileInput.click());
        dom.importFileInput.addEventListener('change', e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = ev => { try { const data = JSON.parse(ev.target.result); if (data.songs) { songs = data.songs; currentSongId = data.currentSongId || songs[0].id; saveAllData(); renderSongList(); renderTagFilters(); switchSong(currentSongId); showToast('导入成功'); } } catch { showToast('文件无效'); } }; r.readAsText(f); });
        dom.batchImportBtn.addEventListener('click', showBatchImportDialog);
        dom.searchInput.addEventListener('input', e => { searchQuery = e.target.value.trim(); renderSongList(); });
        dom.miniPreview.addEventListener('dblclick', () => { const total = getCurrentSong().lyrics.length; const line = prompt(`跳转到行号 (1-${total}):`); if (line) { const idx = parseInt(line) - 1; if (!isNaN(idx) && idx >= 0 && idx < total) { currentLineIndex = idx; updateMiniPreview(); updateSpeakerCards(); broadcastState(); } } });
        window.addEventListener('keydown', e => { if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return; if (e.key === ' ' || e.key === 'Space') { e.preventDefault(); nextLine(); } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); nextLine(); } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); prevLine(); } });
        initScroll(); initPreviewResize(); initSpeakerView();
    }

    // ========== 初始化入口 ==========
    function init() {
        if (window.location.search.includes('display')) { initDisplayMode(); return; }
        dom.songList = document.getElementById('song-list'); dom.songTitleInput = document.getElementById('song-title-input');
        dom.lyricEditor = document.getElementById('lyric-editor-large'); dom.miniPreview = document.getElementById('mini-preview');
        dom.fontSlider = document.getElementById('font-slider'); dom.fontVal = document.getElementById('font-val');
        dom.displayLinesInput = document.getElementById('display-lines-input'); dom.previewLinesInput = document.getElementById('preview-lines-input');
        dom.posSlider = document.getElementById('pos-slider'); dom.posVal = document.getElementById('pos-val');
        dom.toast = document.getElementById('toast'); dom.newSongBtn = document.getElementById('new-song-btn');
        dom.addSongBtn = document.getElementById('add-song-btn'); dom.saveSongBtn = document.getElementById('save-song-btn');
        dom.applyToDisplay = document.getElementById('apply-to-display'); dom.resetCurrentSong = document.getElementById('reset-current-song');
        dom.ocrBtn = document.getElementById('ocr-btn'); dom.ocrFileInput = document.getElementById('ocr-file-input');
        dom.autoplayToggle = document.getElementById('autoplay-toggle'); dom.autoplayStop = document.getElementById('autoplay-stop');
        dom.autoplayInterval = document.getElementById('autoplay-interval'); dom.autoplayProgress = document.getElementById('autoplay-progress');
        dom.openDisplayBtn = document.getElementById('open-display-btn'); dom.exportDataBtn = document.getElementById('export-data-btn');
        dom.importDataBtn = document.getElementById('import-data-btn'); dom.importFileInput = document.getElementById('import-file-input');
        dom.batchImportBtn = document.getElementById('batch-import-btn'); dom.bgImageInput = document.getElementById('bg-image-input');
        dom.songKey = document.getElementById('song-key'); dom.songTempo = document.getElementById('song-tempo');
        dom.songNotes = document.getElementById('song-notes'); dom.songTags = document.getElementById('song-tags');
        dom.themeSelector = document.getElementById('theme-selector'); dom.resize1 = document.getElementById('resize1');
        dom.resize2 = document.getElementById('resize2'); dom.songLibrary = document.getElementById('song-library');
        dom.previewPanel = document.getElementById('preview-panel'); dom.searchInput = document.getElementById('search-input');
        dom.tagFilter = document.getElementById('tag-filter'); dom.previewLineCounter = document.getElementById('preview-line-counter');

        loadAllData(); initPreviewLines(); renderSongList(); renderTagFilters(); switchSong(currentSongId);
        initOCR(); initResizable(); initTheme(); initControlChannel(); bindEvents();
        showToast('✨ 所有功能已恢复，拖动试试看', 3000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();