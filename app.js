(function () {
    "use strict";

    let songs = [];
    let currentSongId = null;
    let currentPageIndex = 0;
    let currentPages = [];
    const CHORD_REGEX = /\[([^\]]+)\]/g;
    const channel = new BroadcastChannel('worship_channel');
    const HYMNS_DATA = [
        { title: "奇异恩典", lyrics: ["奇异恩典，何等甘甜，", "我罪已得赦免；", "前我失丧，今被寻回，", "瞎眼今得看见。"], tags: ["敬拜", "经典"] },
        { title: "新的诗歌", lyrics: ["祂使我口唱新歌，", "就是赞美我们神的话。"], tags: ["赞美"] },
        { title: "荣耀歌", lyrics: ["荣耀归于至高神，", "地上平安归与祂所喜悦的人。"], tags: ["赞美"] },
        { title: "普世欢腾", lyrics: ["普世欢腾，救主下降，", "大地接祂君王。"], tags: ["圣诞", "经典"] },
        { title: "平安夜", lyrics: ["平安夜，圣善夜，", "万暗中，光华射。"], tags: ["圣诞"] },
        { title: "圣哉三一", lyrics: ["圣哉，圣哉，圣哉，全能大主宰！", "清晨我众歌声，穿云上达至尊。"], tags: ["敬拜", "经典"] },
        { title: "荣耀大君王", lyrics: ["齐来崇拜荣耀大君王，", "主权能力慈爱高扬。"], tags: ["赞美"] },
        { title: "万福源头", lyrics: ["万福源头，众生都当颂扬，", "天使天军歌唱，赞美主名。"], tags: ["赞美", "经典"] },
        { title: "耶稣爱我", lyrics: ["耶稣爱我我知道，", "因有圣经告诉我。"], tags: ["安慰"] },
        { title: "耶稣领我", lyrics: ["耶稣领我，我真欢喜，", "蒙主引导无忧无惧。"], tags: ["信靠"] },
        { title: "亲爱主牵我手", lyrics: ["亲爱主，牵我手，", "引导我，走前路。"], tags: ["祷告"] },
        { title: "每一天", lyrics: ["每一天，主赐恩典何等甘甜，", "我一切需要，主都预备完全。"], tags: ["感恩"] },
        { title: "沙漠中的赞美", lyrics: ["在沙漠中我仍要赞美，", "因祢是我力量。"], tags: ["赞美"] },
        { title: "恩典之路", lyrics: ["你是我的主，牵我走恩典道路，", "十架宝血遮盖我。"], tags: ["恩典"] },
        { title: "工人的祷告", lyrics: ["主啊，差遣我，", "进入禾场收割庄稼。"], tags: ["差传"] },
        { title: "耶和华祝福满满", lyrics: ["耶和华祝福满满，", "就像海边的沙那么多。"], tags: ["祝福"] },
        { title: "耶稣给你平安", lyrics: ["耶稣给你平安，", "让你心里不再忧伤。"], tags: ["安慰"] },
        { title: "赐福与你", lyrics: ["愿耶和华赐福给你，保护你，", "使祂脸光照你。"], tags: ["祝福"] },
        { title: "我们成为一家人", lyrics: ["我们成为一家人，", "因着耶稣，因着耶稣。"], tags: ["团契"] },
        { title: "爱使我们相聚一起", lyrics: ["爱使我们相聚一起，", "主爱使我们不分离。"], tags: ["团契"] },
        { title: "基督精兵", lyrics: ["基督精兵前进，", "高举十架向前行。"], tags: ["争战"] },
        { title: "靠主刚强", lyrics: ["你们要靠着主，倚赖祂的大能大力，", "作刚强的人。"], tags: ["争战"] },
        { title: "主是我力量", lyrics: ["主是我力量，主是我诗歌，", "祂也成了我的拯救。"], tags: ["信心"] },
        { title: "耶稣你是宝贵", lyrics: ["耶稣你是宝贵，", "你比万有更美。"], tags: ["敬拜"] },
        { title: "唯有耶稣", lyrics: ["唯有耶稣是我盼望，", "唯有耶稣是我力量。"], tags: ["敬拜"] },
        { title: "这里有神的同在", lyrics: ["这里有神的同在，", "噢这里有神的言语。"], tags: ["敬拜"] },
        { title: "主我高举你名", lyrics: ["主我高举你名，", "主我深深爱你。"], tags: ["赞美"] },
        { title: "坐在宝座上圣洁羔羊", lyrics: ["坐在宝座上圣洁羔羊，", "我们俯伏敬拜你。"], tags: ["敬拜"] },
        { title: "主祷文", lyrics: ["我们在天上的父，愿人都尊你的名为圣。", "愿你的国降临。"], tags: ["祷告"] },
        { title: "主你是我最知心的朋友", lyrics: ["主你是我最知心的朋友，", "主你是我最亲爱的伴侣。"], tags: ["亲近神"] },
        { title: "开我的眼睛", lyrics: ["开我的眼睛使我看见，", "你律法中的奇妙。"], tags: ["祷告"] },
        { title: "安静", lyrics: ["安静，安静，", "当在主前安静。"], tags: ["默想"] },
        { title: "如鹿切慕溪水", lyrics: ["如鹿切慕溪水，", "我的心也切慕你。"], tags: ["敬拜"] },
        { title: "你真伟大", lyrics: ["主啊我神，我每逢举目观看，", "你手所造一切奇妙大工。"], tags: ["经典"] },
        { title: "我知谁掌管明天", lyrics: ["我不知明天将如何，", "每一步道路似乎孤独。"], tags: ["安慰"] },
        { title: "有福的确据", lyrics: ["有福的确据，耶稣属我，", "我今得先尝，主荣耀喜乐。"], tags: ["经典"] },
        { title: "因他活着", lyrics: ["神差爱子，人称祂耶稣，", "祂赐下爱，医治宽恕。"], tags: ["复活"] },
        { title: "献上感恩", lyrics: ["献上感恩的心，", "归给至圣全能神。"], tags: ["感恩"] },
        { title: "在主爱里", lyrics: ["在主爱里我们合一，", "在主爱里彼此相顾。"], tags: ["团契"] },
        { title: "充满我", lyrics: ["圣灵请你来充满我，", "点燃我心中爱火。"], tags: ["圣灵"] },
        { title: "十字架", lyrics: ["我每逢思念那十字架，", "并主如何在上受苦。"], tags: ["受难"] },
        { title: "这一生最美的祝福", lyrics: ["在无数的夜晚里，", "我用心寻找你。"], tags: ["见证"] },
        { title: "祢真配得", lyrics: ["祢真配得，祢真配得，", "配得一切尊贵荣耀。"], tags: ["敬拜"] },
        { title: "何等恩典", lyrics: ["何等恩典，祢竟然拣选我，", "在生命中让我与你同工。"], tags: ["恩典"] },
        { title: "宝贵十架", lyrics: ["主耶稣我感谢你，", "你的身体为我而舍。"], tags: ["十架"] },
        { title: "主的喜乐是我力量", lyrics: ["主的喜乐是我力量，", "你的救恩是我盼望。"], tags: ["喜乐"] },
        { title: "主恩典够我用", lyrics: ["主恩典够我用，", "胜过一切试炼。"], tags: ["恩典"] },
        { title: "我愿触动你心弦", lyrics: ["我愿触动你心弦，", "全心献上赞美。"], tags: ["敬拜"] },
        { title: "一生爱你", lyrics: ["亲爱的主耶稣，", "我愿一生爱你。"], tags: ["献上"] },
        { title: "渴慕你", lyrics: ["我的心切切渴慕你，", "如鹿切慕溪水。"], tags: ["渴慕"] },
        { title: "让赞美飞扬", lyrics: ["让赞美飞扬，这地要看见荣耀，", "让万民都来敬拜。"], tags: ["赞美"] },
        { title: "耶和华是爱", lyrics: ["耶和华是爱，", "让我安歇青草地。"], tags: ["安慰"] }
    ];

    let autoplayTimer = null, autoplayActive = false, autoplayInterval = 5;
    let previewHeight = null, cardWidth = 280;
    const DEFAULT_FONT_FAMILY = "'Microsoft YaHei','PingFang SC',sans-serif";
    const dom = {};
    let activeTagFilter = '', searchQuery = '';

    let cardContainer, pageIndicator, currentCardPage = 0, totalCardPages = 1;

    let sharedBackgrounds = [];
    let uploadedBackgrounds = [];

    function showToast(msg, dur=2000) { dom.toast.textContent = msg; dom.toast.style.opacity='1'; dom.toast.classList.remove('bounceIn'); void dom.toast.offsetWidth; dom.toast.classList.add('bounceIn'); clearTimeout(window._t); window._t = setTimeout(() => dom.toast.style.opacity='0', dur); }
    function getCurrentSong() { return songs.find(s => s.id === currentSongId) || songs[0]; }

    function parsePages(rawLines) {
        if (!rawLines || !rawLines.length) return [{ lines: [], isTitle: false }];
        let segments = [];
        let currentSegment = [];
        for (let line of rawLines) {
            if (line.trim().toLowerCase() === '[page]') {
                if (currentSegment.length > 0) { segments.push(currentSegment); currentSegment = []; }
            } else { currentSegment.push(line); }
        }
        if (currentSegment.length > 0) segments.push(currentSegment);

        let pageArray = [];
        for (let seg of segments) {
            let subSegments = [];
            let subCurrent = [];
            for (let line of seg) {
                if (line.trim() === '') {
                    if (subCurrent.length > 0) { subSegments.push(subCurrent); subCurrent = []; }
                } else { subCurrent.push(line); }
            }
            if (subCurrent.length > 0) subSegments.push(subCurrent);
            pageArray.push(...subSegments);
        }

        if (pageArray.length === 1 && !rawLines.some(l => l.trim().toLowerCase() === '[page]') && !rawLines.some(l => l.trim() === '')) {
            return [{ lines: rawLines, isTitle: false }];
        }
        let pages = pageArray.map(lines => ({ lines, isTitle: false }));
        if (pages.length > 1 && pages[0].lines.length === 1 && pages[0].lines[0].replace(CHORD_REGEX, '').trim() !== '') {
            pages[0].isTitle = true;
        }
        return pages;
    }

    function rebuildPages(song) {
        const rawLines = song.lyrics;
        const pages = parsePages(rawLines);
        if (pages.length === 1 && !pages[0].isTitle) {
            const defaultLines = song.defaultLines || 4;
            const allLines = pages[0].lines;
            let newPages = [];
            for (let i = 0; i < allLines.length; i += defaultLines) newPages.push({ lines: allLines.slice(i, i + defaultLines), isTitle: false });
            currentPages = newPages;
        } else currentPages = pages;
        if (!currentPages.length) currentPages = [{ lines: [], isTitle: false }];
    }

    function saveAllData() {
        const payload = {
            songs,
            currentSongId,
            currentPageIndex,
            previewHeight,
            cardWidth,
            panelLeftWidth: dom.songLibrary ? dom.songLibrary.style.width : '',
            panelRightWidth: dom.previewPanel ? dom.previewPanel.style.width : ''
        };
        localStorage.setItem('worship_data', JSON.stringify(payload));
        if (dom.songLibrary && dom.songLibrary.style.width) {
            localStorage.setItem('panel_left_width', dom.songLibrary.style.width);
        }
        if (dom.previewPanel && dom.previewPanel.style.width) {
            localStorage.setItem('panel_right_width', dom.previewPanel.style.width);
        }
        if (previewHeight) {
            localStorage.setItem('preview_height', previewHeight);
        }
        localStorage.setItem('speaker_card_width', '280');
    }
    function loadAllData() {
        const fallbackSong = {
            id: 'default-song',
            title: '奇异恩典',
            lyrics: [
                '奇异恩典',
                '',
                '奇异恩典，何等甘甜，',
                '我罪已得赦免；',
                '前我失丧，今被寻回，',
                '瞎眼今得看见。'
            ],
            bgType: 'solid-black',
            bgImage: '',
            fontSize: 56,
            fontFamily: DEFAULT_FONT_FAMILY,
            defaultLines: 4,
            posY: 45,
            key: '',
            tempo: '',
            notes: '',
            tags: ['敬拜'],
            history: []
        };
        try {
            const raw = localStorage.getItem('worship_data');
            if (raw) {
                const data = JSON.parse(raw);
                songs = Array.isArray(data.songs) ? data.songs : [fallbackSong];
                songs = songs.map(song => ({ ...song, fontFamily: song.fontFamily || DEFAULT_FONT_FAMILY }));
                currentSongId = data.currentSongId || (songs[0] && songs[0].id);
                currentPageIndex = Number.isInteger(data.currentPageIndex) ? data.currentPageIndex : 0;
                previewHeight = data.previewHeight || localStorage.getItem('preview_height');
                cardWidth = 280;
            } else {
                songs = [fallbackSong];
                currentSongId = fallbackSong.id;
                currentPageIndex = 0;
            }
        } catch (e) {
            songs = [fallbackSong];
            currentSongId = fallbackSong.id;
            currentPageIndex = 0;
        }
        if (!songs.length) {
            songs = [fallbackSong];
            currentSongId = fallbackSong.id;
            currentPageIndex = 0;
        }
    }

    const MAX_PREVIEW_LINES = 20;
    const previewLineElements = [];
    function initPreviewLines() {
        previewLineElements.length = 0;
        dom.miniPreview.innerHTML = '';
        for (let i = 0; i < MAX_PREVIEW_LINES; i++) {
            const line = document.createElement('div');
            line.className = 'preview-line';
            line.style.opacity = '0';
            dom.miniPreview.appendChild(line);
            previewLineElements.push(line);
        }
        const savedHeight = previewHeight || localStorage.getItem('preview_height');
        if (savedHeight) {
            dom.miniPreview.style.height = savedHeight;
            previewHeight = savedHeight;
        }
    }
    function applyPreviewBackground(song) {
        const bg = song.bgType || 'solid-black';
        dom.miniPreview.classList.remove('bg-solid-black', 'bg-solid-white', 'bg-solid-gray', 'bg-particles', 'bg-gradient', 'bg-image');
        dom.miniPreview.classList.add(`bg-${bg}`);
        if (bg === 'image' && song.bgImage) {
            dom.miniPreview.style.backgroundImage = `url(${song.bgImage})`;
            dom.miniPreview.style.backgroundSize = 'cover';
            dom.miniPreview.style.backgroundPosition = 'center';
        } else {
            dom.miniPreview.style.backgroundImage = '';
        }
    }
    function updateMiniPreview() {
        const song = getCurrentSong();
        if (!song || !dom.miniPreview) return;
        applyPreviewBackground(song);
        const page = currentPages[currentPageIndex] || { lines: [] };
        const lines = page.lines || [];
        const cleanLines = lines.map(line => line.replace(CHORD_REGEX, '').trim()).filter(Boolean);
        const lineCount = cleanLines.length || 1;
        const baseSize = Math.max(20, Math.min(song.fontSize, 220 / lineCount));
        for (let i = 0; i < MAX_PREVIEW_LINES; i++) {
            const node = previewLineElements[i];
            if (!node) continue;
            if (i < cleanLines.length) {
                node.textContent = cleanLines[i];
                node.style.fontSize = `${baseSize}px`;
                node.style.fontFamily = song.fontFamily || DEFAULT_FONT_FAMILY;
                node.style.opacity = '1';
                node.style.lineHeight = '1.8';
                node.style.whiteSpace = 'normal';
                node.style.wordBreak = 'break-word';
            } else {
                node.textContent = '';
                node.style.opacity = '0';
            }
        }
        dom.miniPreview.style.justifyContent = 'center';
        dom.miniPreview.style.alignItems = 'center';
        dom.miniPreview.style.paddingTop = '0';
        dom.miniPreview.style.transform = `translateY(${(song.posY - 45) * 0.5}px)`;
        dom.previewLineCounter.textContent = `${currentPageIndex + 1}/${Math.max(1, currentPages.length)}`;
        dom.fontVal.textContent = song.fontSize;
        dom.posVal.textContent = `${song.posY}%`;
        dom.defaultLinesInput.value = song.defaultLines || 4;
        dom.fontSlider.value = song.fontSize || 56;
        dom.posSlider.value = song.posY || 45;
    }

    function broadcastState() {
        const song = getCurrentSong();
        if (!song) return;
        const page = currentPages[currentPageIndex] || { lines: [], isTitle: false };
        channel.postMessage({
            type: 'update',
            song: {
                ...song,
                lyrics: page.lines
            },
            pages: currentPages.map(p => ({ lines: p.lines, isTitle: p.isTitle })),
            currentPageIndex,
            totalPages: currentPages.length || 1,
            isTitlePage: !!page.isTitle
        });
    }
    function nextPage() {
        if (!currentPages.length) return;
        currentPageIndex = Math.min(currentPageIndex + 1, currentPages.length - 1);
        currentCardPage = currentPageIndex;
        updateAll();
    }
    function prevPage() {
        if (!currentPages.length) return;
        currentPageIndex = Math.max(currentPageIndex - 1, 0);
        currentCardPage = currentPageIndex;
        updateAll();
    }
    function updateAll() { updateMiniPreview(); updateSpeakerCards(); broadcastState(); resetAutoplayProgress(); saveAllData(); }

    function jumpToPage(index) {
        if (!currentPages.length) return;
        const safeIndex = Math.max(0, Math.min(index, currentPages.length - 1));
        currentPageIndex = safeIndex;
        currentCardPage = safeIndex;
        updateAll();
    }

    function createNewSong() {
        const id = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        const song = {
            id,
            title: `新诗歌 ${songs.length + 1}`,
            lyrics: ['输入第一行歌词', '输入第二行歌词'],
            bgType: 'solid-black',
            bgImage: '',
            fontSize: 56,
            fontFamily: DEFAULT_FONT_FAMILY,
            defaultLines: 4,
            posY: 45,
            key: '',
            tempo: '',
            notes: '',
            tags: [],
            history: []
        };
        songs.unshift(song);
        currentSongId = id;
        currentPageIndex = 0;
        renderSongList();
        renderTagFilters();
        switchSong(id);
        showToast('已新建诗歌');
    }

    function saveCurrentLyrics() {
        const song = getCurrentSong();
        if (!song) return;
        const rawLines = (dom.lyricEditor.value || '').split('\n');
        const cleanedLyrics = [];
        rawLines.forEach((line) => {
            const stripped = line.replace(/^\s*\d+\s*[.、）)]\s*/, '').trim();
            if (!stripped) {
                if (cleanedLyrics.length && cleanedLyrics[cleanedLyrics.length - 1] !== '') cleanedLyrics.push('');
                return;
            }
            cleanedLyrics.push(stripped);
        });
        while (cleanedLyrics.length && cleanedLyrics[cleanedLyrics.length - 1] === '') cleanedLyrics.pop();
        song.title = (dom.songTitleInput.value || '').trim() || '未命名诗歌';
        song.lyrics = cleanedLyrics.length ? cleanedLyrics : [''];
        song.defaultLines = parseInt(dom.defaultLinesInput.value, 10) || 4;
        song.fontSize = parseInt(dom.fontSlider.value, 10) || 56;
        song.fontFamily = dom.fontFamilySelector.value || DEFAULT_FONT_FAMILY;
        song.posY = parseInt(dom.posSlider.value, 10) || 45;
        song.key = dom.songKey.value || '';
        song.tempo = dom.songTempo.value || '';
        song.notes = dom.songNotes.value || '';
        song.tags = (dom.songTags.value || '').split(',').map(t => t.trim()).filter(Boolean);
        dom.lyricEditor.value = song.lyrics.join('\n');
        rebuildPages(song);
        if (currentPageIndex >= currentPages.length) currentPageIndex = Math.max(0, currentPages.length - 1);
        renderSongList();
        renderTagFilters();
        updateAll();
        showToast('已保存');
    }

    function deleteSong(id) {
        if (songs.length <= 1) {
            showToast('至少保留一首诗歌');
            return;
        }
        songs = songs.filter(s => s.id !== id);
        if (currentSongId === id) {
            currentSongId = songs[0].id;
            currentPageIndex = 0;
        }
        saveAllData();
        renderSongList();
        renderTagFilters();
        switchSong(currentSongId);
        showToast('已删除');
    }

    function switchSong(id) {
        const song = songs.find(s => s.id === id);
        if (!song) return;
        currentSongId = id;
        currentPageIndex = 0;
        currentCardPage = 0;
        dom.songTitleInput.value = song.title || '';
        dom.lyricEditor.value = Array.isArray(song.lyrics) ? song.lyrics.join('\n') : '';
        dom.fontSlider.value = song.fontSize || 56;
        dom.fontFamilySelector.value = song.fontFamily || DEFAULT_FONT_FAMILY;
        dom.defaultLinesInput.value = song.defaultLines || 4;
        dom.posSlider.value = song.posY || 45;
        dom.fontVal.textContent = song.fontSize || 56;
        dom.posVal.textContent = `${song.posY || 45}%`;
        dom.songKey.value = song.key || '';
        dom.songTempo.value = song.tempo || '';
        dom.songNotes.value = song.notes || '';
        dom.songTags.value = (song.tags || []).join(', ');
        rebuildPages(song);
        renderSongList();
        document.querySelectorAll('.bg-option').forEach(o => o.classList.toggle('active', o.dataset.bg === song.bgType));
        updateAll();
    }

    function getFilteredSongs() {
        const query = (searchQuery || '').toLowerCase();
        return songs.filter(song => {
            const title = (song.title || '').toLowerCase();
            const tags = (song.tags || []).join(',').toLowerCase();
            const queryMatched = !query || title.includes(query) || tags.includes(query);
            const tagMatched = !activeTagFilter || (song.tags || []).includes(activeTagFilter);
            return queryMatched && tagMatched;
        });
    }

    function renderSongList() {
        if (!dom.songList) return;
        const filtered = getFilteredSongs();
        dom.songList.innerHTML = '';
        if (!filtered.length) {
            const empty = document.createElement('li');
            empty.textContent = '没有匹配的诗歌';
            empty.style.opacity = '0.7';
            dom.songList.appendChild(empty);
            return;
        }
        filtered.forEach(song => {
            const li = document.createElement('li');
            li.className = 'song-item';
            if (song.id === currentSongId) li.classList.add('active');
            li.innerHTML = `
                <div class="song-item-main">
                    <div class="song-title">${song.title || '未命名诗歌'}</div>
                    <div class="song-tags">${(song.tags || []).join(' · ')}</div>
                </div>
                <button class="song-delete-btn" title="删除">×</button>
            `;
            li.addEventListener('click', (e) => {
                if (e.target.closest('.song-delete-btn')) return;
                switchSong(song.id);
            });
            const delBtn = li.querySelector('.song-delete-btn');
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm(`确认删除《${song.title}》？`)) deleteSong(song.id);
            });
            dom.songList.appendChild(li);
        });
    }

    function renderTagFilters() {
        if (!dom.tagFilter) return;
        const tags = new Set();
        songs.forEach(song => (song.tags || []).forEach(tag => tags.add(tag)));
        dom.tagFilter.innerHTML = '';
        const allBtn = document.createElement('button');
        allBtn.className = `tag-btn ${activeTagFilter ? '' : 'active'}`;
        allBtn.textContent = '全部';
        allBtn.addEventListener('click', () => {
            activeTagFilter = '';
            renderTagFilters();
            renderSongList();
        });
        dom.tagFilter.appendChild(allBtn);
        Array.from(tags).sort().forEach(tag => {
            const btn = document.createElement('button');
            btn.className = `tag-btn ${activeTagFilter === tag ? 'active' : ''}`;
            btn.textContent = tag;
            btn.addEventListener('click', () => {
                activeTagFilter = activeTagFilter === tag ? '' : tag;
                renderTagFilters();
                renderSongList();
            });
            dom.tagFilter.appendChild(btn);
        });
    }

    function startAutoplay() {
        if (autoplayActive) return;
        autoplayInterval = parseFloat(dom.autoplayInterval.value) || 5;
        autoplayActive = true;
        dom.autoplayToggle.textContent = '⏸ 暂停';
        let remaining = autoplayInterval * 1000;
        resetAutoplayProgress();
        autoplayTimer = setInterval(() => {
            remaining -= 100;
            const progress = Math.max(0, Math.min(100, ((autoplayInterval * 1000 - remaining) / (autoplayInterval * 1000)) * 100));
            dom.autoplayProgress.style.width = `${progress}%`;
            if (remaining <= 0) {
                if (currentPageIndex < currentPages.length - 1) {
                    nextPage();
                    remaining = autoplayInterval * 1000;
                } else {
                    stopAutoplay();
                }
            }
        }, 100);
    }

    function pauseAutoplay() {
        if (!autoplayActive) return;
        autoplayActive = false;
        dom.autoplayToggle.textContent = '▶ 开始';
        clearInterval(autoplayTimer);
        autoplayTimer = null;
    }

    function stopAutoplay() {
        autoplayActive = false;
        clearInterval(autoplayTimer);
        autoplayTimer = null;
        dom.autoplayToggle.textContent = '▶ 开始';
        resetAutoplayProgress();
    }

    function resetAutoplayProgress() {
        if (dom.autoplayProgress) dom.autoplayProgress.style.width = '0%';
    }

    // 投屏预览
    function initSpeakerView() {
        cardContainer = document.getElementById('card-container');
        pageIndicator = document.getElementById('page-indicator');
        const sizeS = document.getElementById('size-s');
        const sizeM = document.getElementById('size-m');
        const sizeL = document.getElementById('size-l');
        const applySize = (w, btn) => {
            cardWidth = w;
            [sizeS, sizeM, sizeL].forEach(b => b && b.classList.remove('active'));
            if (btn) btn.classList.add('active');
            updateSpeakerCards();
            saveAllData();
        };
        if (sizeS) sizeS.addEventListener('click', () => applySize(260, sizeS));
        if (sizeM) sizeM.addEventListener('click', () => applySize(320, sizeM));
        if (sizeL) sizeL.addEventListener('click', () => applySize(420, sizeL));
        if (cardContainer) {
            cardContainer.addEventListener('wheel', (e) => {
                if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                    e.preventDefault();
                    cardContainer.scrollLeft += e.deltaY;
                }
            }, { passive: false });
        }
        updateSpeakerCards();
    }

    function applyCardBackground(card, song) {
        const bg = song.bgType || 'solid-black';
        card.style.backgroundImage = '';
        card.style.backgroundSize = '';
        card.style.backgroundPosition = '';
        if (bg === 'solid-black') card.style.background = '#000';
        else if (bg === 'solid-white') card.style.background = '#fff';
        else if (bg === 'solid-gray') card.style.background = '#555';
        else if (bg === 'gradient') card.style.background = 'radial-gradient(circle at 30% 30%, #1a2a4a, #000)';
        else if (bg === 'image' && song.bgImage) {
            card.style.background = '#000';
            card.style.backgroundImage = `url(${song.bgImage})`;
            card.style.backgroundSize = 'cover';
            card.style.backgroundPosition = 'center';
        } else card.style.background = '#111';
    }
    function updateSpeakerCards() {
        const song = getCurrentSong();
        if (!song || !cardContainer) return;
        totalCardPages = currentPages.length;
        if (totalCardPages === 0) return;
        currentCardPage = Math.max(0, Math.min(currentCardPage, totalCardPages - 1));

        cardContainer.innerHTML = '';
        for (let p = 0; p < totalCardPages; p++) {
            const page = currentPages[p];
            const card = document.createElement('div');
            card.className = 'card';
            card.style.width = '280px';
            card.style.height = '200px';
            if (p === currentCardPage) card.classList.add('active');
            applyCardBackground(card, song);

            const lines = page.lines;
            if (lines.length > 0) {
                const lineCount = lines.length;
                const fontSize = Math.max(12, Math.min(24, 200 / (lineCount * 1.8)));
                lines.forEach((rawLine) => {
                    const clean = rawLine.replace(CHORD_REGEX, '').trim();
                    const lineDiv = document.createElement('div');
                    lineDiv.className = 'card-line';
                    lineDiv.style.fontSize = fontSize + 'px';
                    lineDiv.style.fontFamily = song.fontFamily || DEFAULT_FONT_FAMILY;
                    lineDiv.style.opacity = 1;
                    lineDiv.textContent = clean;
                    card.appendChild(lineDiv);
                });
            } else {
                card.classList.add('empty');
                card.textContent = '…';
            }

            card.addEventListener('click', () => jumpToPage(p));
            cardContainer.appendChild(card);
        }

        pageIndicator.textContent = `${currentCardPage + 1}/${totalCardPages}`;
        const cards = cardContainer.children;
        if (cards[currentCardPage]) {
            requestAnimationFrame(() => {
                cards[currentCardPage].scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
            });
        }
    }

    // ========== 演示窗口（含完整底部卡片预览） ==========
    function initDisplayMode() {
        document.body.innerHTML = `
            <canvas id="display-canvas" style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:1;"></canvas>
            <div id="display-lyrics" style="position:fixed;top:45%;left:50%;transform:translate(-50%,-50%);z-index:10;text-align:center;pointer-events:none;width:90%;"></div>
            <div id="blackout-overlay" style="position:fixed;top:0;left:0;width:100%;height:100%;background:#000;z-index:100;display:none;"></div>
            <div id="whiteout-overlay" style="position:fixed;top:0;left:0;width:100%;height:100%;background:#fff;z-index:100;display:none;"></div>
            <div id="ended-overlay" style="position:fixed;top:0;left:0;width:100%;height:100%;background:#000;z-index:90;display:none; flex-direction:column; align-items:center; justify-content:center; color:white; font-size:3rem; font-weight:bold; text-shadow:2px 2px 8px black; text-align:center;">
                <span>投屏已结束 ✝️</span>
                <span style="font-size:1.5rem; margin-top:20px;">按上键返回</span>
            </div>
            <!-- 底部控制区 -->
            <div id="display-controls" style="position:fixed; bottom:0; left:0; width:100%; z-index:80; display:flex; flex-direction:column; background:rgba(0,0,0,0.7); backdrop-filter:blur(8px); border-top:1px solid rgba(255,255,255,0.15); padding:6px 10px; transition: transform 0.3s ease;">
                <!-- 卡片预览条 -->
                <div id="display-card-preview" style="display:flex; flex-wrap:wrap; gap:6px; overflow-y:auto; padding:2px 0 4px 0; margin-bottom:4px; max-height:120px; align-items:center;"></div>
                <!-- 按钮栏 -->
                <div style="position:relative; display:flex; justify-content:center; align-items:center; min-height:40px;">
                    <div style="display:flex; justify-content:center; align-items:center; gap:16px;">
                        <button id="dc-prev-btn" class="display-control-btn">◀ 上一页</button>
                        <span id="dc-page-indicator" style="color:#ccc; font-size:1rem;">1/1</span>
                        <button id="dc-next-btn" class="display-control-btn">下一页 ▶</button>
                    </div>
                    <button id="dc-toggle-btn" style="position:absolute; right:6px; background:none; border:none; color:#aaa; font-size:1.2rem; cursor:pointer;">▲ 隐藏</button>
                </div>
            </div>
            <!-- 恢复按钮（隐藏时显示） -->
            <div id="dc-restore-dot" style="position:fixed; bottom:10px; right:10px; width:36px; height:36px; background:rgba(255,255,255,0.15); backdrop-filter:blur(5px); border-radius:50%; cursor:pointer; z-index:90; display:none; align-items:center; justify-content:center; border:1px solid rgba(255,255,255,0.25); transition: all 0.2s ease;" onmouseover="this.style.background='rgba(255,255,255,0.3)'" onmouseout="this.style.background='rgba(255,255,255,0.15)'">
                <span style="color:#aaa; font-size:0.8rem;">⋮</span>
            </div>
        `;

        const canvas = document.getElementById('display-canvas'), ctx = canvas.getContext('2d'),
              lyricsDiv = document.getElementById('display-lyrics'),
              blackout = document.getElementById('blackout-overlay'),
              whiteout = document.getElementById('whiteout-overlay'),
              endedOverlay = document.getElementById('ended-overlay'),
              dcPrev = document.getElementById('dc-prev-btn'),
              dcNext = document.getElementById('dc-next-btn'),
              dcPageIndicator = document.getElementById('dc-page-indicator'),
              dcToggle = document.getElementById('dc-toggle-btn'),
              dcControls = document.getElementById('display-controls'),
              dcCardPreview = document.getElementById('display-card-preview'),
              dcRestoreDot = document.getElementById('dc-restore-dot');

        let w, h, particles = [], currentState = null, ended = false, controlsVisible = true;
        const cachedBgImage = new Image();
        let cachedBgSrc = '';

        function resize() { w = window.innerWidth; h = window.innerHeight; canvas.width = w; canvas.height = h; }
        window.addEventListener('resize', resize); resize();

        class Particle {
            constructor() { this.x = Math.random()*w; this.y = Math.random()*h; this.vx = (Math.random()-0.5)*0.7; this.vy = (Math.random()-0.5)*0.5; this.size = Math.random()*5+2; this.color = `rgba(255,255,255,${0.7+Math.random()*0.3})`; }
            update() { this.x+=this.vx; this.y+=this.vy; if(this.x<0||this.x>w)this.vx*=-1; if(this.y<0||this.y>h)this.vy*=-1; }
            draw() { ctx.beginPath(); ctx.arc(this.x,this.y,this.size,0,Math.PI*2); ctx.fillStyle=this.color; ctx.shadowColor='white'; ctx.shadowBlur=10; ctx.fill(); }
        }
        for(let i=0;i<70;i++) particles.push(new Particle());

        function drawBg(bg, img) {
            if(bg==='solid-black'){ctx.fillStyle='#000';ctx.fillRect(0,0,w,h);}
            else if(bg==='solid-white'){ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);}
            else if(bg==='solid-gray'){ctx.fillStyle='#555';ctx.fillRect(0,0,w,h);}
            else if(bg==='gradient'){const g=ctx.createRadialGradient(w*.3,h*.3,50,w*.5,h*.5,w);g.addColorStop(0,'#1a2a4a');g.addColorStop(1,'#000');ctx.fillStyle=g;ctx.fillRect(0,0,w,h);}
            else if (bg === 'image' && img) {
                if (cachedBgSrc !== img) {
                    cachedBgSrc = img;
                    cachedBgImage.src = img;
                }
                if (cachedBgImage.complete && cachedBgImage.naturalWidth > 0) {
                    ctx.drawImage(cachedBgImage, 0, 0, w, h);
                } else {
                    ctx.fillStyle = '#000';
                    ctx.fillRect(0, 0, w, h);
                }
            }
            else if(bg==='particles'){ctx.fillStyle='#000';ctx.fillRect(0,0,w,h);particles.forEach(p=>{p.update();p.draw();});}
            else{ctx.fillStyle='rgba(0,0,0,0.2)';ctx.fillRect(0,0,w,h);}
        }

        function render(state) {
            if (!state || ended) return;
            const {song, currentPageIndex, totalPages, isTitlePage} = state;
            const lyrics = song.lyrics;
            let html = '';
            if (isTitlePage && lyrics.length > 0) {
                html = `<div style="color:white; font-weight:bold; text-shadow:3px 3px 8px black; font-size:${song.fontSize*1.8}px; line-height:1.8; white-space:normal; word-break:break-word; font-family:${song.fontFamily || DEFAULT_FONT_FAMILY};">${lyrics[0]}</div>`;
            } else {
                lyrics.forEach(line => {
                    html += `<div style="color:white; font-weight:bold; text-shadow:3px 3px 8px black; font-size:${song.fontSize}px; opacity:1; line-height:1.8; white-space:normal; word-break:break-word; font-family:${song.fontFamily || DEFAULT_FONT_FAMILY};">${line}</div>`;
                });
            }
            lyricsDiv.innerHTML = html;
            lyricsDiv.style.top = song.posY + '%';
            dcPageIndicator.textContent = `${currentPageIndex+1}/${totalPages}`;

            // 更新底部卡片预览 - 显示所有页面，自动换行，显示完整歌词
            dcCardPreview.innerHTML = '';
            const pages = Array.isArray(state.pages) ? state.pages : [];
            
            for (let i = 0; i < totalPages; i++) {
                const mini = document.createElement('div');
                mini.className = 'display-mini-card';
                if (i === currentPageIndex) mini.classList.add('active');
                
                const pageLines = (i < pages.length && Array.isArray(pages[i].lines)) ? pages[i].lines : [];
                const cleanLines = pageLines.map(line => line.replace(/\[([^\]]+)\]/g, '').trim()).filter(Boolean);
                
                // 根据行数自动调整卡片高度
                const lineCount = cleanLines.length || 1;
                const baseHeight = 35;
                const lineHeight = 18;
                const cardHeight = Math.max(baseHeight, Math.min(100, baseHeight + (lineCount - 1) * lineHeight));
                
                mini.style.height = cardHeight + 'px';
                mini.style.minWidth = '70px';
                mini.style.maxWidth = '120px';
                mini.style.padding = '6px 8px';
                mini.style.display = 'flex';
                mini.style.flexDirection = 'column';
                mini.style.justifyContent = 'center';
                mini.style.alignItems = 'center';
                
                // 显示完整歌词（限制最多4行）
                const displayLines = cleanLines.slice(0, 4);
                mini.innerHTML = displayLines.map(line => 
                    `<div style="font-size:0.6rem;line-height:1.4;color:${i === currentPageIndex ? '#fff' : '#aaa'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;">${line}</div>`
                ).join('');
                
                if (cleanLines.length > 4) {
                    mini.innerHTML += '<div style="font-size:0.55rem;color:#666;margin-top:2px;">...</div>';
                }
                
                mini.title = cleanLines.join('\n');
                
                mini.addEventListener('click', () => {
                    dc.postMessage({ type: 'jump', pageIndex: i });
                });
                dcCardPreview.appendChild(mini);
            }

            if (currentPageIndex >= totalPages - 1 && !isTitlePage) {
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
            } else if (e.data.type === 'jump') {
                // 跳转到指定页面
                dc.postMessage({ type: 'jump', pageIndex: e.data.pageIndex });
            }
        });
        dc.postMessage({ type: 'request_state' });

        dcPrev.addEventListener('click', () => dc.postMessage({ type: 'prev' }));
        dcNext.addEventListener('click', () => dc.postMessage({ type: 'next' }));
        dcToggle.addEventListener('click', () => {
            controlsVisible = !controlsVisible;
            dcControls.style.transform = controlsVisible ? 'translateY(0)' : 'translateY(100%)';
            dcRestoreDot.style.display = controlsVisible ? 'none' : 'flex';
        });
        dcRestoreDot.addEventListener('click', () => {
            controlsVisible = true;
            dcControls.style.transform = 'translateY(0)';
            dcRestoreDot.style.display = 'none';
        });

        window.addEventListener('keydown', e => {
            if (e.key === 'b' || e.key === 'B') { e.preventDefault(); blackout.style.display = blackout.style.display === 'none' ? 'block' : 'none'; }
            else if (e.key === 'w' || e.key === 'W') { e.preventDefault(); whiteout.style.display = whiteout.style.display === 'none' ? 'block' : 'none'; }
            else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); document.documentElement.requestFullscreen(); }
            else if (e.key === 'Escape') { blackout.style.display = 'none'; whiteout.style.display = 'none'; }
            else if (e.key === 'ArrowUp' && ended) { ended = false; endedOverlay.style.display = 'none'; lyricsDiv.style.display = 'block'; dc.postMessage({ type: 'prev' }); }
        });
    }

    // ========== 主领提词视图 ==========
    function initLeaderView() {
        document.body.innerHTML = `
            <div id="leader-view" style="position:fixed;top:0;left:0;width:100%;height:100%;background:linear-gradient(135deg,#0a0e27 0%,#1a1a2e 50%,#000 100%);overflow:hidden;z-index:1;">
                <!-- 微光粒子画布 -->
                <canvas id="leader-particles" style="position:absolute;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none;"></canvas>
                
                <!-- 顶部控制栏 -->
                <div style="position:fixed;top:0;left:0;width:100%;z-index:10;display:flex;justify-content:space-between;align-items:center;padding:15px 20px;background:rgba(0,0,0,0.3);backdrop-filter:blur(10px);">
                    <div style="display:flex;gap:10px;align-items:center;">
                        <button id="leader-mode-scroll" style="padding:8px 16px;border-radius:20px;border:1px solid rgba(255,255,255,0.3);background:transparent;color:#aaa;cursor:pointer;font-size:0.9rem;transition:all 0.2s;">📜 滚动模式</button>
                        <button id="leader-mode-page" style="padding:8px 16px;border-radius:20px;border:1px solid rgba(255,255,255,0.3);background:rgba(212,175,55,0.3);color:#fff;cursor:pointer;font-size:0.9rem;transition:all 0.2s;">🖥️ 分页模式</button>
                    </div>
                    <div style="display:flex;gap:15px;align-items:center;">
                        <span id="leader-song-title" style="color:#ddd;font-size:1rem;font-weight:bold;"></span>
                        <span id="leader-page-num" style="color:#888;font-size:0.9rem;"></span>
                    </div>
                </div>
                
                <!-- 核心内容区 -->
                <div id="leader-content" style="position:absolute;top:70px;left:0;width:100%;height:calc(100% - 70px);overflow-y:auto;padding:20px;z-index:5;">
                    <!-- 分页模式内容 -->
                    <div id="leader-page-mode" style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100%;">
                        <div id="leader-lyrics" style="text-align:center;color:white;font-weight:bold;width:90%;max-width:1200px;"></div>
                        <div id="leader-next-preview" style="margin-top:40px;color:rgba(255,255,255,0.4);font-size:1.3rem;text-align:center;width:80%;max-width:800px;min-height:40px;"></div>
                    </div>
                    
                    <!-- 滚动模式内容 -->
                    <div id="leader-scroll-mode" style="display:none;max-width:900px;margin:0 auto;padding:20px 0 100px 0;">
                        <div id="leader-all-lyrics"></div>
                    </div>
                </div>
                
                <!-- 底部信息栏 -->
                <div style="position:fixed;bottom:0;left:0;width:100%;z-index:10;background:rgba(0,0,0,0.4);backdrop-filter:blur(10px);padding:10px 20px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <div style="display:flex;gap:20px;align-items:center;">
                            <span id="leader-meta" style="color:rgba(255,255,255,0.5);font-size:0.85rem;"></span>
                            <button id="leader-notes-toggle" style="padding:5px 12px;border-radius:15px;border:1px solid rgba(255,255,255,0.2);background:transparent;color:#aaa;cursor:pointer;font-size:0.8rem;">📝 备注</button>
                        </div>
                        <div style="color:rgba(255,255,255,0.3);font-size:0.75rem;">敬拜主领视图</div>
                    </div>
                </div>
                
                <!-- 备注面板（可折叠） -->
                <div id="leader-notes-panel" style="position:fixed;bottom:50px;left:50%;transform:translateX(-50%);width:90%;max-width:700px;max-height:60vh;background:rgba(15,15,30,0.95);backdrop-filter:blur(15px);border-radius:20px;border:1px solid rgba(255,255,255,0.1);z-index:20;display:none;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,0.5);">
                    <div style="padding:15px 20px;border-bottom:1px solid rgba(255,255,255,0.1);display:flex;justify-content:space-between;align-items:center;">
                        <span style="color:#d4af37;font-weight:bold;font-size:1rem;">📝 主领备注 / 祷告词</span>
                        <div style="display:flex;gap:8px;">
                            <button id="leader-notes-refresh" style="padding:5px 12px;border-radius:12px;border:1px solid rgba(212,175,55,0.5);background:rgba(212,175,55,0.1);color:#d4af37;cursor:pointer;font-size:0.8rem;">🔄 刷新备注</button>
                            <button id="leader-notes-close" style="padding:5px 12px;border-radius:12px;border:1px solid rgba(255,255,255,0.2);background:transparent;color:#aaa;cursor:pointer;font-size:0.8rem;">✕</button>
                        </div>
                    </div>
                    <textarea id="leader-notes-textarea" placeholder="在此输入当前歌曲的备注、祷告词或提示..." style="flex:1;padding:15px 20px;background:transparent;border:none;color:#ddd;font-size:0.95rem;line-height:1.8;resize:none;outline:none;font-family:'Microsoft YaHei',sans-serif;"></textarea>
                    <div style="padding:10px 20px;border-top:1px solid rgba(255,255,255,0.1);display:flex;justify-content:flex-end;">
                        <button id="leader-notes-save" style="padding:8px 20px;border-radius:15px;border:none;background:linear-gradient(135deg,#d4af37,#b8960c);color:#000;font-weight:bold;cursor:pointer;font-size:0.9rem;">💾 保存备注</button>
                    </div>
                </div>
            </div>
        `;

        const leaderLyrics = document.getElementById('leader-lyrics');
        const leaderNextPreview = document.getElementById('leader-next-preview');
        const leaderPageNum = document.getElementById('leader-page-num');
        const leaderMeta = document.getElementById('leader-meta');
        const leaderSongTitle = document.getElementById('leader-song-title');
        const leaderAllLyrics = document.getElementById('leader-all-lyrics');
        const leaderScrollMode = document.getElementById('leader-scroll-mode');
        const leaderPageMode = document.getElementById('leader-page-mode');
        const leaderNotesPanel = document.getElementById('leader-notes-panel');
        const leaderNotesTextarea = document.getElementById('leader-notes-textarea');
        const leaderNotesToggle = document.getElementById('leader-notes-toggle');
        const leaderNotesClose = document.getElementById('leader-notes-close');
        const leaderNotesSave = document.getElementById('leader-notes-save');
        const leaderNotesRefresh = document.getElementById('leader-notes-refresh');
        const modeScrollBtn = document.getElementById('leader-mode-scroll');
        const modePageBtn = document.getElementById('leader-mode-page');

        let currentState = null;
        let currentMode = 'page'; // 'page' or 'scroll'
        let currentSongId = '';
        let particles = [];
        let particleCtx = null;

        // 初始化粒子背景
        function initParticles() {
            const canvas = document.getElementById('leader-particles');
            if (!canvas) return;
            particleCtx = canvas.getContext('2d');
            
            function resize() {
                canvas.width = window.innerWidth;
                canvas.height = window.innerHeight;
            }
            resize();
            window.addEventListener('resize', resize);

            class Particle {
                constructor() {
                    this.reset();
                }
                reset() {
                    this.x = Math.random() * canvas.width;
                    this.y = Math.random() * canvas.height;
                    this.size = Math.random() * 2 + 0.5;
                    this.speedX = (Math.random() - 0.5) * 0.3;
                    this.speedY = (Math.random() - 0.5) * 0.3;
                    this.opacity = Math.random() * 0.3 + 0.05;
                }
                update() {
                    this.x += this.speedX;
                    this.y += this.speedY;
                    if (this.x < 0 || this.x > canvas.width || this.y < 0 || this.y > canvas.height) {
                        this.reset();
                    }
                }
                draw() {
                    particleCtx.beginPath();
                    particleCtx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
                    particleCtx.fillStyle = `rgba(212,175,55,${this.opacity})`;
                    particleCtx.fill();
                }
            }

            for (let i = 0; i < 50; i++) {
                particles.push(new Particle());
            }

            function animate() {
                particleCtx.clearRect(0, 0, canvas.width, canvas.height);
                particles.forEach(p => {
                    p.update();
                    p.draw();
                });
                requestAnimationFrame(animate);
            }
            animate();
        }

        // 切换模式
        function switchMode(mode) {
            currentMode = mode;
            if (mode === 'scroll') {
                modeScrollBtn.style.background = 'rgba(212,175,55,0.3)';
                modeScrollBtn.style.color = '#fff';
                modePageBtn.style.background = 'transparent';
                modePageBtn.style.color = '#aaa';
                leaderScrollMode.style.display = 'block';
                leaderPageMode.style.display = 'none';
                renderScrollMode();
            } else {
                modePageBtn.style.background = 'rgba(212,175,55,0.3)';
                modePageBtn.style.color = '#fff';
                modeScrollBtn.style.background = 'transparent';
                modeScrollBtn.style.color = '#aaa';
                leaderScrollMode.style.display = 'none';
                leaderPageMode.style.display = 'flex';
            }
        }

        // 渲染分页模式
        function renderPageMode(state) {
            const { song, currentPageIndex, totalPages, pages } = state;
            const lyrics = song.lyrics || [];
            const fontSize = (song.fontSize || 56) * 1.3;
            
            let html = '';
            lyrics.forEach(line => {
                html += `<div style="font-size:${fontSize}px;line-height:1.8;white-space:normal;word-break:break-word;font-family:${song.fontFamily || DEFAULT_FONT_FAMILY};margin-bottom:10px;">${line}</div>`;
            });
            leaderLyrics.innerHTML = html;

            // 下一句预览
            if (pages && currentPageIndex < pages.length - 1) {
                const nextPage = pages[currentPageIndex + 1];
                const nextLines = (nextPage.lines || []).slice(0, 2).join(' ');
                leaderNextPreview.textContent = nextLines || '';
            } else {
                leaderNextPreview.textContent = '';
            }

            leaderPageNum.textContent = `${currentPageIndex + 1}/${totalPages}`;
        }

        // 渲染滚动模式
        function renderScrollMode() {
            if (!currentState) return;
            const { pages, currentPageIndex } = currentState;
            if (!pages || !pages.length) return;

            const fontSize = (currentState.song.fontSize || 56) * 1.1;
            let html = '';
            
            pages.forEach((page, idx) => {
                const isCurrentPage = idx === currentPageIndex;
                const pageLines = page.lines || [];
                
                html += `<div style="margin-bottom:30px;padding:20px;border-radius:15px;${isCurrentPage ? 'background:rgba(212,175,55,0.15);border:1px solid rgba(212,175,55,0.3);' : 'background:transparent;border:1px solid rgba(255,255,255,0.05);'}">`;
                
                if (page.isTitle && pageLines.length > 0) {
                    html += `<div style="font-size:${fontSize * 1.3}px;color:#d4af37;font-weight:bold;text-align:center;margin-bottom:15px;font-family:${currentState.song.fontFamily || DEFAULT_FONT_FAMILY};">${pageLines[0]}</div>`;
                }
                
                pageLines.forEach((line, lineIdx) => {
                    if (page.isTitle && lineIdx === 0) return;
                    const cleanLine = line.replace(/\[([^\]]+)\]/g, '').trim();
                    if (!cleanLine) return;
                    html += `<div style="font-size:${fontSize}px;line-height:2;color:${isCurrentPage ? '#fff' : 'rgba(255,255,255,0.6)'};font-weight:${isCurrentPage ? 'bold' : 'normal'};font-family:${currentState.song.fontFamily || DEFAULT_FONT_FAMILY};padding:5px 10px;${isCurrentPage ? 'background:rgba(212,175,55,0.1);border-radius:8px;' : ''}">${cleanLine}</div>`;
                });
                
                html += `</div>`;
            });
            
            leaderAllLyrics.innerHTML = html;
            
            // 自动滚动到当前页
            if (currentPageIndex >= 0) {
                const currentEl = leaderAllLyrics.children[currentPageIndex];
                if (currentEl) {
                    currentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
        }

        // 加载备注
        function loadNotes(songId) {
            const saved = localStorage.getItem(`leader_notes_${songId}`);
            leaderNotesTextarea.value = saved || '';
        }

        // 保存备注
        function saveNotes() {
            if (!currentSongId) return;
            const content = leaderNotesTextarea.value;
            localStorage.setItem(`leader_notes_${currentSongId}`, content);
            // 同时保存到云端
            saveLeaderNote(currentSongId, content);
            showToast('备注已保存');
        }

        // 从 Google Sheets 刷新备注
        async function refreshNotesFromSheet() {
            if (!currentState || !currentSongId) return;
            const note = await loadLeaderNote(currentSongId);
            if (note !== null) {
                leaderNotesTextarea.value = note;
                saveNotes();
                showToast('✝️ 备注已从云端刷新');
            } else {
                showToast('云端暂无备注');
            }
        }

        // 渲染主函数
        function render(state) {
            if (!state) return;
            currentState = state;
            const { song } = state;
            
            // 更新歌曲标题
            leaderSongTitle.textContent = song.title || '未命名诗歌';
            
            // 更新元信息
            const metaParts = [];
            if (song.key) metaParts.push(`${song.key}大调`);
            if (song.tempo) metaParts.push(`${song.tempo} BPM`);
            leaderMeta.textContent = metaParts.join(' · ');
            
            // 更新当前歌曲ID并加载备注
            if (song.id !== currentSongId) {
                currentSongId = song.id;
                loadNotes(currentSongId);
            }
            
            // 根据模式渲染
            if (currentMode === 'page') {
                renderPageMode(state);
            } else {
                renderScrollMode();
            }
        }

        // 事件绑定
        modeScrollBtn.addEventListener('click', () => switchMode('scroll'));
        modePageBtn.addEventListener('click', () => switchMode('page'));
        
        leaderNotesToggle.addEventListener('click', () => {
            leaderNotesPanel.style.display = leaderNotesPanel.style.display === 'flex' ? 'none' : 'flex';
        });
        
        leaderNotesClose.addEventListener('click', () => {
            leaderNotesPanel.style.display = 'none';
        });
        
        leaderNotesSave.addEventListener('click', saveNotes);
        leaderNotesRefresh.addEventListener('click', refreshNotesFromSheet);

        // 监听 BroadcastChannel
        const dc = new BroadcastChannel('worship_channel');
        dc.addEventListener('message', e => {
            if (e.data.type === 'update') {
                render(e.data);
            }
        });
        dc.postMessage({ type: 'request_state' });

        // 初始化粒子
        initParticles();
        
        // 默认分页模式
        switchMode('page');
    }

    // ========== Google Sheets 云端集成 ==========
    async function initSupabase() { console.log('云端存储已切换到 Google Sheets'); }

    async function loadSharedBackgrounds() {
        // 从本地加载已上传的背景
        try {
            const saved = localStorage.getItem('uploaded_backgrounds');
            if (saved) uploadedBackgrounds = JSON.parse(saved);
        } catch(e) { uploadedBackgrounds = []; }
    }

    const ENCOURAGEMENTS = [
        '感谢你的分享，愿这首诗歌祝福更多人！',
        '已发布到云端，弟兄姐妹都能看到了！',
        '赞美主！诗歌已成功保存！',
        '做得好！这首歌会成为很多人的祝福！',
        '发布成功！愿神使用这首诗歌！'
    ];

    async function publishSong() {
        const s = getCurrentSong();
        if (!s.lyrics.length) { showToast('无歌词可发布'); return; }
        
        // 防重复提交：禁用按钮
        const btn = dom.publishSongBtn;
        if (btn) {
            btn.disabled = true;
            btn.textContent = '⏳ 上传中...';
        }
        
        try {
            const response = await fetch('https://script.google.com/macros/s/AKfycbzUW1yB8gObRnSjUyWpRivWWI4KuD-ba9m5eYZU4TbdKUvuajcpaSaMxZ61JjBFyjkUXQ/exec', {
                method: 'POST',
                body: JSON.stringify({ title: s.title, lyrics: s.lyrics, tags: s.tags || [] })
            });
            if (response.ok) {
                const msg = ENCOURAGEMENTS[Math.floor(Math.random() * ENCOURAGEMENTS.length)];
                // 在按钮旁显示反馈气泡
                showPublishFeedback(btn, msg);
            } else { throw new Error('服务器响应错误'); }
        } catch(e) { 
            console.error('发布失败:', e); 
            showPublishFeedback(btn, '✝️ 发布失败，请重试', true);
        } finally {
            // 恢复按钮状态
            if (btn) {
                setTimeout(() => {
                    btn.disabled = false;
                    btn.textContent = '☁️ 发布到云端';
                }, 2000);
            }
        }
    }

    // 在按钮旁显示发布反馈
    function showPublishFeedback(button, message, isError = false) {
        if (!button) return;
        
        // 移除旧的反馈
        const oldFeedback = document.getElementById('publish-feedback');
        if (oldFeedback) oldFeedback.remove();
        
        // 创建反馈气泡
        const feedback = document.createElement('span');
        feedback.id = 'publish-feedback';
        feedback.innerHTML = `✝️ ${message}`;
        feedback.style.cssText = `
            display:inline-block;
            margin-left:10px;
            padding:6px 14px;
            background:${isError ? 'rgba(255,80,80,0.2)' : 'rgba(212,175,55,0.2)'};
            border:1px solid ${isError ? 'rgba(255,80,80,0.5)' : 'rgba(212,175,55,0.5)'};
            border-radius:20px;
            color:${isError ? '#ff6b6b' : '#d4af37'};
            font-size:0.85rem;
            animation:bounceIn 0.4s ease;
            opacity:1;
            transition:opacity 0.3s ease;
            white-space:nowrap;
        `;
        
        // 插入到按钮后面
        button.parentNode.insertBefore(feedback, button.nextSibling);
        
        // 2秒后渐隐消失
        setTimeout(() => {
            feedback.style.opacity = '0';
            setTimeout(() => feedback.remove(), 300);
        }, 2000);
    }

    // ========== 主领备注云端同步 ==========
    const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzUW1yB8gObRnSjUyWpRivWWI4KuD-ba9m5eYZU4TbdKUvuajcpaSaMxZ61JjBFyjkUXQ/exec';

    // 保存主领备注到 Google Sheets
    async function saveLeaderNote(songId, noteText) {
        if (!songId || !noteText) return false;
        try {
            const response = await fetch(GOOGLE_SCRIPT_URL, {
                method: 'POST',
                body: JSON.stringify({
                    action: 'saveNote',
                    songId: songId,
                    note: noteText
                })
            });
            if (response.ok) {
                showToast('✝️ 备注已同步到云端');
                return true;
            } else {
                throw new Error('服务器响应错误');
            }
        } catch(e) {
            console.error('保存备注失败:', e);
            showToast('⚠️ 云端同步失败，已保存到本地');
            return false;
        }
    }

    // 从 Google Sheets 加载主领备注
    async function loadLeaderNote(songId) {
        if (!songId) return null;
        try {
            const response = await fetch(`${GOOGLE_SCRIPT_URL}?action=getNote&songId=${encodeURIComponent(songId)}`);
            if (response.ok) {
                const data = await response.json();
                return data.note || null;
            } else {
                throw new Error('服务器响应错误');
            }
        } catch(e) {
            console.error('加载备注失败:', e);
            return null;
        }
    }

    // ========== 在线诗歌搜索 ==========
    let onlineHymns = [];
    async function loadOnlineHymns() {
        onlineHymns = HYMNS_DATA.map(item => ({ ...item, lyrics: Array.isArray(item.lyrics) ? item.lyrics : [] }));
    }

    function searchOnlineHymns(query) {
        const q = query.trim();
        if (!q) return [];
        const normalized = q.toLowerCase();
        return onlineHymns.filter(h => {
            const title = h.title || '';
            const tags = Array.isArray(h.tags) ? h.tags.join(' ') : '';
            const lyrics = Array.isArray(h.lyrics) ? h.lyrics.join(' ') : '';
            const haystack = `${title} ${tags} ${lyrics}`;
            return haystack.includes(q) || haystack.toLowerCase().includes(normalized);
        }).slice(0, 8);
    }

    function renderOnlineResults(results) {
        dom.onlineResults.innerHTML = '';
        if (!results.length) {
            dom.onlineResults.innerHTML = '<div style="color:var(--text-secondary); padding:6px;">未找到</div>';
            return;
        }
        results.forEach(hymn => {
            const div = document.createElement('div');
            div.className = 'online-result-item';
            div.innerHTML = `<span>${hymn.title}</span><button class="online-import-btn">导入</button>`;
            div.querySelector('.online-import-btn').addEventListener('click', e => { e.stopPropagation(); importOnlineHymn(hymn); });
            dom.onlineResults.appendChild(div);
        });
    }

    function importOnlineHymn(hymn) {
        const newSong = {
            id: Date.now().toString(), title: hymn.title, lyrics: hymn.lyrics,
            bgType: 'particles', fontSize: 56, defaultLines: 4, posY: 45,
            key: '', tempo: '', notes: '', tags: hymn.tags || [], history: [], fontFamily: DEFAULT_FONT_FAMILY
        };
        songs.push(newSong); saveAllData(); renderSongList(); renderTagFilters(); switchSong(newSong.id);
        showToast(`已导入《${hymn.title}》`);
    }

    // ========== 背景设置 ==========
    function setBackground(type, imgData = null) {
        const s = getCurrentSong();
        s.bgType = type;
        if (type === 'image' && imgData) {
            s.bgImage = imgData;
            if (!uploadedBackgrounds.includes(imgData)) uploadedBackgrounds.push(imgData);
            localStorage.setItem('uploaded_backgrounds', JSON.stringify(uploadedBackgrounds));
            renderMyBackgrounds();
        }
        const imgOpt = document.querySelector('.bg-option[data-bg="image"]');
        if (imgOpt) {
            if (s.bgImage) {
                imgOpt.style.backgroundImage = `url(${s.bgImage})`;
                imgOpt.style.backgroundSize = 'cover';
                imgOpt.style.borderStyle = 'solid';
            } else {
                imgOpt.style.backgroundImage = '';
                imgOpt.style.borderStyle = 'dashed';
            }
        }
        document.querySelectorAll('.bg-option').forEach(o => o.classList.toggle('active', o.dataset.bg === type));
        updateAll();
    }

    function renderMyBackgrounds() {
        const container = document.getElementById('my-backgrounds-container');
        if (!container) return;
        container.innerHTML = '';
        uploadedBackgrounds.forEach((bg, idx) => {
            const thumb = document.createElement('div');
            thumb.className = 'my-bg-thumb';
            thumb.style.backgroundImage = `url(${bg})`;
            const s = getCurrentSong();
            if (s.bgImage === bg) thumb.classList.add('active');
            thumb.addEventListener('click', () => setBackground('image', bg));
            container.appendChild(thumb);
        });
    }

    function handleBgImageUpload(file) {
        const reader = new FileReader();
        reader.onload = (e) => { setBackground('image', e.target.result); showToast('背景已上传'); };
        reader.readAsDataURL(file);
    }

    // ========== OCR 等辅助功能 ==========
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

    function showBatchImportDialog() {
        const text = prompt('📋 批量导入歌词\n\n每首诗歌空行隔开，第一行为标题。');
        if (!text || !text.trim()) return;
        const blocks = text.split(/\n\s*\n/); let count = 0;
        blocks.forEach(block => {
            const lines = block.split('\n').map(l => l.trim()).filter(l => l);
            if (lines.length < 2) return;
            songs.push({
                id: Date.now().toString(), title: lines[0], lyrics: lines.slice(1),
                bgType:'particles', fontSize:56, defaultLines:4, posY:45, key:'', tempo:'', notes:'', tags:[], history:[],
                fontFamily: DEFAULT_FONT_FAMILY
            });
            count++;
        });
        if (count) { saveAllData(); renderSongList(); renderTagFilters(); switchSong(songs[songs.length-1].id); showToast(`导入 ${count} 首`); }
        else showToast('未识别到有效诗歌');
    }

    function initTheme() {
        const saved = localStorage.getItem('worship_theme') || 'dark';
        document.body.setAttribute('data-theme', saved); dom.themeSelector.value = saved;
        dom.themeSelector.addEventListener('change', (e) => {
            document.body.setAttribute('data-theme', e.target.value);
            localStorage.setItem('worship_theme', e.target.value);
        });
        // 加载保存的主题背景
        const savedBg = localStorage.getItem('theme_bg_image');
        if (savedBg) applyThemeBackground(savedBg);
    }

    function applyThemeBackground(imageData) {
        document.documentElement.style.setProperty('--theme-bg-image', `url(${imageData})`);
        localStorage.setItem('theme_bg_image', imageData);
    }

    function handleThemeBgUpload(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            applyThemeBackground(e.target.result);
            showToast('主题背景已应用');
        };
        reader.readAsDataURL(file);
    }

    function initResizable() {
        const lp = dom.songLibrary, rp = dom.previewPanel, h1 = dom.resize1, h2 = dom.resize2;
        const savedLeft = localStorage.getItem('panel_left_width');
        const savedRight = localStorage.getItem('panel_right_width');
        lp.style.width = savedLeft || '260px';
        rp.style.width = savedRight || '280px';

        let resizing = false, cur = null, sx, sw;
        const down = (e) => {
            resizing = true; cur = e.target; sx = e.clientX;
            sw = cur === h1 ? lp.offsetWidth : rp.offsetWidth;
            cur.classList.add('active');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        };
        const move = (e) => {
            if (!resizing) return;
            const dx = e.clientX - sx;
            if (cur === h1) lp.style.width = Math.max(120, Math.min(900, sw + dx)) + 'px';
            else rp.style.width = Math.max(180, Math.min(900, sw - dx)) + 'px';
        };
        const up = () => {
            if (resizing) {
                resizing = false; cur.classList.remove('active');
                document.body.style.cursor = ''; document.body.style.userSelect = '';
                saveAllData();
            }
        };
        h1.addEventListener('mousedown', down); h2.addEventListener('mousedown', down);
        window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    }

    function initPreviewResize() {
        const handle = document.getElementById('preview-resize-handle'), preview = dom.miniPreview;
        let y, h;
        handle.addEventListener('mousedown', e => {
            e.preventDefault(); y = e.clientY; h = preview.offsetHeight;
            document.body.style.cursor = 'ns-resize';
            const onMove = (ev) => {
                const nh = Math.max(80, Math.min(500, h + (ev.clientY - y))) + 'px';
                preview.style.height = nh; previewHeight = nh;
            };
            const onUp = () => {
                document.body.style.cursor = '';
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                saveAllData();
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });
    }

    // 全局滚轮：跳过输入区域
    function initScroll() {
        window.addEventListener('wheel', (e) => {
            if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.isContentEditable) return;
            if (e.target.closest('#preview-panel') && !e.target.closest('#mini-preview')) return;
            e.preventDefault();
            e.deltaY > 0 ? nextPage() : prevPage();
        }, { passive: false });
    }

    // ========== 事件绑定 ==========
    function bindEvents() {
        const safeOn = (el, event, handler) => {
            if (!el) return;
            if (typeof handler !== 'function') {
                console.error(`[bindEvents] handler missing for ${event}`);
                return;
            }
            el.addEventListener(event, handler);
        };

        safeOn(dom.newSongBtn, 'click', createNewSong);
        safeOn(dom.addSongBtn, 'click', createNewSong);
        safeOn(dom.saveSongBtn, 'click', saveCurrentLyrics);
        safeOn(dom.publishSongBtn, 'click', publishSong);
        safeOn(dom.applyToDisplay, 'click', () => {
            saveCurrentLyrics();
            updateAll();
            broadcastState();
            showToast('已应用到演示屏');
        });
        safeOn(dom.resetCurrentSong, 'click', () => {
            const s = getCurrentSong();
            s.lyrics = [
                '奇异恩典',
                '',
                '奇异恩典，何等甘甜，',
                '我罪已得赦免；',
                '前我失丧，今被寻回，',
                '瞎眼今得看见。',
                '',
                '如此恩典，使我敬畏，',
                '使我心得安慰；',
                '初信之时，即蒙恩惠，',
                '真是何等宝贵。'
            ];
            dom.lyricEditor.value = s.lyrics.join('\n');
            saveCurrentLyrics();
        });
        safeOn(dom.fontSlider, 'input', () => {
            const s = getCurrentSong();
            s.fontSize = parseInt(dom.fontSlider.value);
            dom.fontVal.textContent = s.fontSize;
            updateAll();
        });
        safeOn(dom.defaultLinesInput, 'input', () => {
            const s = getCurrentSong();
            s.defaultLines = parseInt(dom.defaultLinesInput.value) || 4;
            rebuildPages(s);
            if (currentPageIndex >= currentPages.length) currentPageIndex = Math.max(0, currentPages.length - 1);
            updateAll();
        });
        safeOn(dom.posSlider, 'input', () => {
            const s = getCurrentSong();
            s.posY = parseInt(dom.posSlider.value);
            dom.posVal.textContent = s.posY + '%';
            updateAll();
        });
        safeOn(dom.fontFamilySelector, 'change', () => {
            const s = getCurrentSong();
            if (!s) return;
            s.fontFamily = dom.fontFamilySelector.value || DEFAULT_FONT_FAMILY;
            updateAll();
        });
        safeOn(dom.songTitleInput, 'input', renderSongList);
        safeOn(dom.lyricEditor, 'input', () => {
            const s = getCurrentSong();
            if (!s) return;
            s.lyrics = dom.lyricEditor.value.split('\n');
            rebuildPages(s);
            updateAll();
        });
        document.querySelectorAll('.bg-option').forEach(o => {
            if (o.id === 'upload-bg-trigger') safeOn(o, 'click', () => dom.bgImageInput.click());
            else safeOn(o, 'click', () => setBackground(o.dataset.bg));
        });
        safeOn(document.getElementById('upload-bg-btn'), 'click', () => dom.bgImageInput.click());
        safeOn(document.getElementById('free-bg-link'), 'click', () => {
            window.open('https://www.pexels.com/zh-cn/search/video/worship%20background/', '_blank');
        });
        safeOn(dom.bgImageInput, 'change', e => { if (e.target.files[0]) handleBgImageUpload(e.target.files[0]); });
        safeOn(dom.themeBgUploadBtn, 'click', () => dom.themeBgInput.click());
        safeOn(dom.themeBgInput, 'change', e => { if (e.target.files[0]) handleThemeBgUpload(e.target.files[0]); });
        safeOn(dom.autoplayToggle, 'click', () => {
            autoplayInterval = parseFloat(dom.autoplayInterval.value) || 5;
            autoplayActive ? pauseAutoplay() : startAutoplay();
        });
        safeOn(dom.autoplayStop, 'click', stopAutoplay);
        safeOn(dom.openDisplayBtn, 'click', () => {
            const url = window.location.href.split('?')[0] + '?display';
            const win = window.open(url, '_blank', 'width=1280,height=720');
            win ? showToast('演示窗口已打开') : showToast('弹窗被阻止，请允许弹出窗口');
        });
        safeOn(dom.openLeaderBtn, 'click', () => {
            const url = window.location.href.split('?')[0] + '?leader';
            const win = window.open(url, '_blank', 'width=1280,height=720');
            win ? showToast('主领视图已打开') : showToast('弹窗被阻止，请允许弹出窗口');
        });
        safeOn(dom.exportDataBtn, 'click', () => {
            const d = JSON.stringify({ songs, currentSongId });
            const b = new Blob([d], { type: 'application/json' });
            const u = URL.createObjectURL(b);
            const a = document.createElement('a'); a.href = u;
            a.download = `worship_backup_${new Date().toISOString().slice(0,10)}.worship`;
            a.click(); URL.revokeObjectURL(u); showToast('已导出');
        });
        safeOn(dom.importDataBtn, 'click', () => dom.importFileInput.click());
        safeOn(dom.importFileInput, 'change', e => {
            const f = e.target.files[0]; if (!f) return;
            const r = new FileReader();
            r.onload = ev => {
                try {
                    const data = JSON.parse(ev.target.result);
                    if (data.songs) {
                        songs = data.songs; currentSongId = data.currentSongId || songs[0].id;
                        saveAllData(); renderSongList(); renderTagFilters(); switchSong(currentSongId);
                        showToast('导入成功');
                    }
                } catch { showToast('文件无效'); }
            };
            r.readAsText(f);
        });
        safeOn(dom.batchImportBtn, 'click', showBatchImportDialog);
        safeOn(dom.searchInput, 'input', e => { searchQuery = e.target.value.trim(); renderSongList(); });
        safeOn(dom.onlineSearchInput, 'input', e => {
            const results = searchOnlineHymns(e.target.value);
            renderOnlineResults(results);
        });
        safeOn(dom.miniPreview, 'dblclick', () => {
            const total = currentPages.length;
            const page = prompt(`跳转到页码 (1-${total}):`);
            if (page) {
                const idx = parseInt(page) - 1;
                if (!isNaN(idx) && idx >= 0 && idx < total) {
                    currentPageIndex = idx;
                    updateAll();
                }
            }
        });
        window.addEventListener('keydown', e => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (e.key === ' ' || e.key === 'Space') { e.preventDefault(); nextPage(); }
            else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); nextPage(); }
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); prevPage(); }
        });
        channel.addEventListener('message', e => {
            if (e.data.type === 'prev') prevPage();
            else if (e.data.type === 'next') nextPage();
            else if (e.data.type === 'jump') jumpToPage(e.data.pageIndex);
            else if (e.data.type === 'request_state') broadcastState();
        });
        initScroll();
        initPreviewResize();
        initSpeakerView();
    }

    // ========== 初始化入口 ==========
    function init() {
        if (window.location.search.includes('display')) { initDisplayMode(); return; }
        if (window.location.search.includes('leader')) { initLeaderView(); return; }

        dom.songList = document.getElementById('song-list');
        dom.songTitleInput = document.getElementById('song-title-input');
        dom.lyricEditor = document.getElementById('lyric-editor-large');
        dom.miniPreview = document.getElementById('mini-preview');
        dom.fontSlider = document.getElementById('font-slider');
        dom.fontFamilySelector = document.getElementById('font-family-selector');
        dom.fontVal = document.getElementById('font-val');
        dom.defaultLinesInput = document.getElementById('default-lines-input');
        dom.posSlider = document.getElementById('pos-slider');
        dom.posVal = document.getElementById('pos-val');
        dom.toast = document.getElementById('toast');
        dom.newSongBtn = document.getElementById('new-song-btn');
        dom.addSongBtn = document.getElementById('add-song-btn');
        dom.saveSongBtn = document.getElementById('save-song-btn');
        dom.publishSongBtn = document.getElementById('publish-song-btn');
        dom.applyToDisplay = document.getElementById('apply-to-display');
        dom.resetCurrentSong = document.getElementById('reset-current-song');
        dom.ocrBtn = document.getElementById('ocr-btn');
        dom.ocrFileInput = document.getElementById('ocr-file-input');
        dom.autoplayToggle = document.getElementById('autoplay-toggle');
        dom.autoplayStop = document.getElementById('autoplay-stop');
        dom.autoplayInterval = document.getElementById('autoplay-interval');
        dom.autoplayProgress = document.getElementById('autoplay-progress');
        dom.openDisplayBtn = document.getElementById('open-display-btn');
        dom.openLeaderBtn = document.getElementById('open-leader-btn');
        dom.exportDataBtn = document.getElementById('export-data-btn');
        dom.importDataBtn = document.getElementById('import-data-btn');
        dom.importFileInput = document.getElementById('import-file-input');
        dom.batchImportBtn = document.getElementById('batch-import-btn');
        dom.bgImageInput = document.getElementById('bg-image-input');
        dom.songKey = document.getElementById('song-key');
        dom.songTempo = document.getElementById('song-tempo');
        dom.songNotes = document.getElementById('song-notes');
        dom.songTags = document.getElementById('song-tags');
        dom.themeSelector = document.getElementById('theme-selector');
        dom.themeBgUploadBtn = document.getElementById('theme-bg-upload-btn');
        dom.themeBgInput = document.getElementById('theme-bg-input');
        dom.resize1 = document.getElementById('resize1');
        dom.resize2 = document.getElementById('resize2');
        dom.songLibrary = document.getElementById('song-library');
        dom.previewPanel = document.getElementById('preview-panel');
        dom.searchInput = document.getElementById('search-input');
        dom.onlineSearchInput = document.getElementById('online-search-input');
        dom.onlineResults = document.getElementById('online-results');
        dom.tagFilter = document.getElementById('tag-filter');
        dom.previewLineCounter = document.getElementById('preview-line-counter');

        loadAllData();
        initPreviewLines();
        renderSongList();
        renderTagFilters();
        switchSong(currentSongId);
        initOCR();
        initResizable();
        initTheme();
        initSupabase().then(async () => {
            await loadOnlineHymns();
            await loadSharedBackgrounds();
            renderMyBackgrounds();
        });
        bindEvents();
        showToast('✨ 工具已就绪', 3000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
