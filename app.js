// ============================================================
// Video Editor — app.js
// ============================================================

// --- State ---
const state = {
    clips: [],
    audioTracks: [],
    selectedId: null,
    selectedType: null, // 'clip' | 'audio'
    resolution: { width: 1920, height: 1080 },
    fps: 30,
    isPlaying: false,
    playbackTime: 0,
    pixelsPerSecond: 80,
};

// --- DOM refs ---
const $ = (sel) => document.querySelector(sel);
const previewCanvas = $('#preview-canvas');
const ctx = previewCanvas.getContext('2d');
const imageTrack = $('#image-track');
const audioTrack = $('#audio-track');
const playhead = $('#playhead');
const timelineScroll = $('#timeline-scroll');
const timelineTracks = $('#timeline-tracks');
const emptyState = $('#empty-state');
const dropOverlay = $('#drop-overlay');
const exportModal = $('#export-modal');
const exportProgressBar = $('#export-progress-bar');
const exportProgressText = $('#export-progress-text');
const exportStatusText = $('#export-status-text');
const browserWarning = $('#browser-warning');

// Properties panel refs
const propsPanel = $('#properties-panel');
const propsEmpty = $('#properties-empty');
const propsContent = $('#properties-content');
const propClipName = $('#prop-clip-name');
const propDuration = $('#prop-duration');
const propScaleMode = $('#prop-scale-mode');
const propCustomScaleGroup = $('#custom-scale-group');
const propCustomScale = $('#prop-custom-scale');
const propCustomScaleValue = $('#prop-custom-scale-value');
const propImageGroup = $('#prop-image-group');
const propAudioGroup = $('#prop-audio-group');
const propVolume = $('#prop-volume');
const propVolumeValue = $('#prop-volume-value');
const propDeleteBtn = $('#prop-delete-btn');

// Track whether a drag originated from inside the timeline (clip reorder)
let internalDragActive = false;

// Playback state
let playbackStartWall = 0;
let playbackStartOffset = 0;
let playbackAnimFrame = null;
let playbackAudioCtx = null;
let playbackSourceNodes = [];

// ============================================================
// Initialization
// ============================================================
function init() {
    checkBrowserSupport();
    setupDragDrop();
    setupFileInput();
    setupTransportControls();
    setupResolutionControls();
    setupTimelineZoom();
    setupPropertiesPanel();
    setupKeyboard();
    setupTimelineSeek();
    renderFrame();
}

function checkBrowserSupport() {
    if (typeof VideoEncoder === 'undefined') {
        browserWarning.classList.remove('hidden');
        $('#dismiss-warning').addEventListener('click', () => {
            browserWarning.classList.add('hidden');
        });
    }
}

// ============================================================
// File Import — Drag & Drop + File Input
// ============================================================
let dragCounter = 0;

function setupDragDrop() {
    window.addEventListener('dragenter', (e) => {
        e.preventDefault();
        if (internalDragActive) return;
        dragCounter++;
        dropOverlay.classList.remove('hidden');
    });

    window.addEventListener('dragleave', (e) => {
        e.preventDefault();
        if (internalDragActive) return;
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            dropOverlay.classList.add('hidden');
        }
    });

    window.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    window.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        dropOverlay.classList.add('hidden');
        if (internalDragActive) return;
        handleFiles(e.dataTransfer.files);
    });
}

function setupFileInput() {
    const fileInput = $('#file-input');
    $('#add-files-btn').addEventListener('click', () => fileInput.click());
    $('#add-files-btn-empty').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
        handleFiles(e.target.files);
        e.target.value = '';
    });
}

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg', 'avif'];
const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a'];

async function handleFiles(fileList) {
    const promises = [];
    for (const file of fileList) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (IMAGE_EXTS.includes(ext)) {
            promises.push(addImageClip(file));
        } else if (AUDIO_EXTS.includes(ext)) {
            promises.push(addAudioTrack(file));
        }
    }
    await Promise.all(promises);
    updateEmptyState();
    renderTimeline();
    renderFrame();
}

async function addImageClip(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
    });

    // Generate thumbnail
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 80;
    thumbCanvas.height = 50;
    const tctx = thumbCanvas.getContext('2d');
    const scale = Math.min(80 / img.naturalWidth, 50 / img.naturalHeight);
    const tw = img.naturalWidth * scale;
    const th = img.naturalHeight * scale;
    tctx.fillStyle = '#000';
    tctx.fillRect(0, 0, 80, 50);
    tctx.drawImage(img, (80 - tw) / 2, (50 - th) / 2, tw, th);

    state.clips.push({
        id: crypto.randomUUID(),
        file,
        name: file.name,
        image: img,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        duration: 3.0,
        scaleMode: 'fit',
        customScale: 1.0,
        thumbnailDataUrl: thumbCanvas.toDataURL('image/jpeg', 0.7),
    });
}

async function addAudioTrack(file) {
    const audioCtx = new AudioContext();
    const arrayBuffer = await file.arrayBuffer();
    let audioBuffer;
    try {
        audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    } catch (e) {
        console.error('Failed to decode audio:', file.name, e);
        audioCtx.close();
        return;
    }
    audioCtx.close();

    state.audioTracks.push({
        id: crypto.randomUUID(),
        file,
        name: file.name,
        audioBuffer,
        duration: audioBuffer.duration,
        startOffset: 0,
        volume: 1.0,
    });
}

function updateEmptyState() {
    if (state.clips.length > 0 || state.audioTracks.length > 0) {
        emptyState.classList.add('hidden');
    } else {
        emptyState.classList.remove('hidden');
    }
}

// ============================================================
// Timeline Rendering
// ============================================================
function renderTimeline() {
    renderImageTrack();
    renderAudioTrackUI();
    updateTimelineTotalWidth();
    updatePlayhead(state.playbackTime);
}

function renderImageTrack() {
    imageTrack.innerHTML = '';
    const pps = state.pixelsPerSecond;

    state.clips.forEach((clip, index) => {
        const el = document.createElement('div');
        el.className = 'clip image-clip' + (state.selectedType === 'clip' && state.selectedId === clip.id ? ' selected' : '');
        el.style.width = Math.max(clip.duration * pps, 30) + 'px';
        el.draggable = true;
        el.dataset.clipId = clip.id;
        el.dataset.index = index;

        const thumb = document.createElement('img');
        thumb.className = 'clip-thumb';
        thumb.src = clip.thumbnailDataUrl;
        el.appendChild(thumb);

        const info = document.createElement('div');
        info.className = 'clip-info';
        info.innerHTML = `<div class="clip-name">${escapeHtml(clip.name)}</div><div class="clip-duration">${clip.duration.toFixed(1)}s</div>`;
        el.appendChild(info);

        // Resize handle
        const handle = document.createElement('div');
        handle.className = 'clip-resize-handle';
        el.appendChild(handle);

        // Click to select
        el.addEventListener('click', (e) => {
            if (e.target === handle) return;
            selectItem('clip', clip.id);
        });

        // Resize
        setupResizeHandle(handle, clip);

        // Drag (reorder)
        setupClipDrag(el, clip, index);

        imageTrack.appendChild(el);
    });
}

function renderAudioTrackUI() {
    // Clear all except the label
    const label = audioTrack.querySelector('.track-label-inline');
    audioTrack.innerHTML = '';
    audioTrack.appendChild(label);

    const pps = state.pixelsPerSecond;

    state.audioTracks.forEach((track) => {
        const el = document.createElement('div');
        el.className = 'clip audio-clip' + (state.selectedType === 'audio' && state.selectedId === track.id ? ' selected' : '');
        el.style.width = Math.max(track.duration * pps, 30) + 'px';
        el.style.marginLeft = (track.startOffset * pps) + 'px';
        el.dataset.trackId = track.id;

        const info = document.createElement('div');
        info.className = 'clip-info';
        info.innerHTML = `<div class="clip-name">${escapeHtml(track.name)}</div><div class="clip-duration">${formatTime(track.duration)}</div>`;
        el.appendChild(info);

        el.addEventListener('click', () => {
            selectItem('audio', track.id);
        });

        audioTrack.appendChild(el);
    });
}

function updateTimelineTotalWidth() {
    const totalImageTime = getTotalDuration();
    const maxAudioEnd = state.audioTracks.reduce((max, t) => Math.max(max, t.startOffset + t.duration), 0);
    const totalTime = Math.max(totalImageTime, maxAudioEnd, 5);
    const totalWidth = totalTime * state.pixelsPerSecond + 100;
    timelineTracks.style.width = totalWidth + 'px';
}

// ============================================================
// Clip Drag (Reorder)
// ============================================================
let dragSourceIndex = -1;

function setupClipDrag(el, clip, index) {
    el.addEventListener('dragstart', (e) => {
        internalDragActive = true;
        dragSourceIndex = index;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', clip.id);
        el.style.opacity = '0.5';
    });

    el.addEventListener('dragend', () => {
        internalDragActive = false;
        el.style.opacity = '1';
        clearDragIndicators();
    });

    el.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearDragIndicators();
        const rect = el.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        if (e.clientX < midX) {
            el.classList.add('drag-over-left');
        } else {
            el.classList.add('drag-over-right');
        }
    });

    el.addEventListener('dragleave', () => {
        el.classList.remove('drag-over-left', 'drag-over-right');
    });

    el.addEventListener('drop', (e) => {
        e.preventDefault();
        clearDragIndicators();
        const draggedId = e.dataTransfer.getData('text/plain');
        const fromIdx = state.clips.findIndex(c => c.id === draggedId);
        if (fromIdx === -1) return;

        const rect = el.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        let toIdx = index;
        if (e.clientX >= midX) toIdx++;
        if (fromIdx < toIdx) toIdx--;

        const [moved] = state.clips.splice(fromIdx, 1);
        state.clips.splice(toIdx, 0, moved);
        renderTimeline();
        renderFrame();
    });
}

function clearDragIndicators() {
    document.querySelectorAll('.drag-over-left, .drag-over-right').forEach(el => {
        el.classList.remove('drag-over-left', 'drag-over-right');
    });
}

// ============================================================
// Clip Resize Handle
// ============================================================
function setupResizeHandle(handle, clip) {
    let startX, startDuration;

    const onMove = (e) => {
        const dx = e.clientX - startX;
        const dt = dx / state.pixelsPerSecond;
        clip.duration = Math.max(0.1, startDuration + dt);
        renderTimeline();
        updateTimeDisplay();
        if (state.selectedType === 'clip' && state.selectedId === clip.id) {
            propDuration.value = clip.duration.toFixed(1);
        }
    };

    const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        renderFrame();
    };

    handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        startX = e.clientX;
        startDuration = clip.duration;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

// ============================================================
// Timeline Seek
// ============================================================
function setupTimelineSeek() {
    timelineTracks.addEventListener('mousedown', (e) => {
        // Only seek if clicking on the track background, not on clips
        if (e.target !== imageTrack && e.target !== audioTrack && e.target !== timelineTracks) return;
        const rect = timelineTracks.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const time = Math.max(0, (x - 16) / state.pixelsPerSecond);
        state.playbackTime = Math.min(time, getTotalDuration());
        updatePlayhead(state.playbackTime);
        updateTimeDisplay();
        renderFrame();
    });
}

// ============================================================
// Selection & Properties Panel
// ============================================================
function selectItem(type, id) {
    state.selectedType = type;
    state.selectedId = id;
    renderTimeline();
    showProperties();
}

function deselectAll() {
    state.selectedType = null;
    state.selectedId = null;
    renderTimeline();
    hideProperties();
}

function showProperties() {
    propsEmpty.classList.add('hidden');
    propsContent.classList.remove('hidden');

    if (state.selectedType === 'clip') {
        const clip = state.clips.find(c => c.id === state.selectedId);
        if (!clip) return hideProperties();
        propClipName.textContent = clip.name;
        propDuration.value = clip.duration.toFixed(1);
        propScaleMode.value = clip.scaleMode;
        propCustomScale.value = Math.round(clip.customScale * 100);
        propCustomScaleValue.textContent = Math.round(clip.customScale * 100) + '%';
        propCustomScaleGroup.classList.toggle('hidden', clip.scaleMode !== 'custom');
        propImageGroup.classList.remove('hidden');
        propAudioGroup.classList.add('hidden');
    } else if (state.selectedType === 'audio') {
        const track = state.audioTracks.find(t => t.id === state.selectedId);
        if (!track) return hideProperties();
        propClipName.textContent = track.name;
        propImageGroup.classList.add('hidden');
        propAudioGroup.classList.remove('hidden');
        propVolume.value = Math.round(track.volume * 100);
        propVolumeValue.textContent = Math.round(track.volume * 100) + '%';
    }
}

function hideProperties() {
    propsEmpty.classList.remove('hidden');
    propsContent.classList.add('hidden');
}

function setupPropertiesPanel() {
    propDuration.addEventListener('input', () => {
        const clip = state.clips.find(c => c.id === state.selectedId);
        if (!clip) return;
        clip.duration = Math.max(0.1, parseFloat(propDuration.value) || 0.1);
        renderTimeline();
        updateTimeDisplay();
    });

    propScaleMode.addEventListener('change', () => {
        const clip = state.clips.find(c => c.id === state.selectedId);
        if (!clip) return;
        clip.scaleMode = propScaleMode.value;
        propCustomScaleGroup.classList.toggle('hidden', clip.scaleMode !== 'custom');
        renderFrame();
    });

    propCustomScale.addEventListener('input', () => {
        const clip = state.clips.find(c => c.id === state.selectedId);
        if (!clip) return;
        clip.customScale = parseInt(propCustomScale.value) / 100;
        propCustomScaleValue.textContent = propCustomScale.value + '%';
        renderFrame();
    });

    propVolume.addEventListener('input', () => {
        const track = state.audioTracks.find(t => t.id === state.selectedId);
        if (!track) return;
        track.volume = parseInt(propVolume.value) / 100;
        propVolumeValue.textContent = propVolume.value + '%';
    });

    propDeleteBtn.addEventListener('click', () => {
        if (state.selectedType === 'clip') {
            state.clips = state.clips.filter(c => c.id !== state.selectedId);
        } else if (state.selectedType === 'audio') {
            state.audioTracks = state.audioTracks.filter(t => t.id !== state.selectedId);
        }
        deselectAll();
        updateEmptyState();
        renderTimeline();
        renderFrame();
    });
}

// ============================================================
// Resolution & FPS Controls
// ============================================================
function setupResolutionControls() {
    const resSel = $('#resolution-select');
    const customDiv = $('#custom-resolution');

    resSel.addEventListener('change', () => {
        if (resSel.value === 'custom') {
            customDiv.classList.remove('hidden');
        } else {
            customDiv.classList.add('hidden');
            const [w, h] = resSel.value.split('x').map(Number);
            setResolution(w, h);
        }
    });

    $('#apply-custom-res').addEventListener('click', () => {
        const w = parseInt($('#custom-width').value) || 1920;
        const h = parseInt($('#custom-height').value) || 1080;
        setResolution(Math.max(100, Math.min(7680, w)), Math.max(100, Math.min(4320, h)));
    });

    $('#fps-select').addEventListener('change', (e) => {
        state.fps = parseInt(e.target.value);
    });
}

function setResolution(w, h) {
    state.resolution = { width: w, height: h };
    previewCanvas.width = w;
    previewCanvas.height = h;
    $('#resolution-badge').textContent = `${w} x ${h}`;
    renderFrame();
}

// ============================================================
// Timeline Zoom
// ============================================================
function setupTimelineZoom() {
    const slider = $('#zoom-slider');
    slider.addEventListener('input', () => {
        state.pixelsPerSecond = parseInt(slider.value);
        renderTimeline();
    });
}

// ============================================================
// Canvas Rendering
// ============================================================
function renderFrame() {
    renderFrameAtTime(ctx, state.playbackTime, state.resolution.width, state.resolution.height);
}

function renderFrameAtTime(context, time, width, height) {
    context.fillStyle = '#000';
    context.fillRect(0, 0, width, height);

    if (state.clips.length === 0) return;

    let cumulative = 0;
    for (const clip of state.clips) {
        if (time < cumulative + clip.duration) {
            drawImageToCanvas(context, clip, width, height);
            return;
        }
        cumulative += clip.duration;
    }
    // Past end — draw last frame
    if (state.clips.length > 0) {
        drawImageToCanvas(context, state.clips[state.clips.length - 1], width, height);
    }
}

function drawImageToCanvas(context, clip, canvasW, canvasH) {
    const img = clip.image;
    const mode = clip.scaleMode;
    let drawW, drawH, drawX, drawY;

    // Blur-fill: draw blurred & scaled background first, then sharp fit on top
    if (mode === 'blur-fill') {
        drawBlurFill(context, img, canvasW, canvasH);
        return;
    }

    // Fit modes
    if (mode === 'fit' || mode === 'fit-top' || mode === 'fit-bottom') {
        const scale = Math.min(canvasW / img.naturalWidth, canvasH / img.naturalHeight);
        drawW = img.naturalWidth * scale;
        drawH = img.naturalHeight * scale;
        drawX = (canvasW - drawW) / 2;
        if (mode === 'fit-top') drawY = 0;
        else if (mode === 'fit-bottom') drawY = canvasH - drawH;
        else drawY = (canvasH - drawH) / 2;
    }
    // Fill modes
    else if (mode === 'fill' || mode === 'fill-top' || mode === 'fill-bottom') {
        const scale = Math.max(canvasW / img.naturalWidth, canvasH / img.naturalHeight);
        drawW = img.naturalWidth * scale;
        drawH = img.naturalHeight * scale;
        drawX = (canvasW - drawW) / 2;
        if (mode === 'fill-top') drawY = 0;
        else if (mode === 'fill-bottom') drawY = canvasH - drawH;
        else drawY = (canvasH - drawH) / 2;
    }
    // Stretch
    else if (mode === 'stretch') {
        drawX = 0; drawY = 0; drawW = canvasW; drawH = canvasH;
    }
    // Custom
    else {
        const baseFit = Math.min(canvasW / img.naturalWidth, canvasH / img.naturalHeight);
        const scale = baseFit * clip.customScale;
        drawW = img.naturalWidth * scale;
        drawH = img.naturalHeight * scale;
        drawX = (canvasW - drawW) / 2;
        drawY = (canvasH - drawH) / 2;
    }

    context.drawImage(img, drawX, drawY, drawW, drawH);
}

function drawBlurFill(context, img, canvasW, canvasH) {
    const bgScale = Math.max(canvasW / img.naturalWidth, canvasH / img.naturalHeight);
    const bgW = img.naturalWidth * bgScale;
    const bgH = img.naturalHeight * bgScale;
    const bgX = (canvasW - bgW) / 2;
    const bgY = (canvasH - bgH) / 2;

    // Try CSS filter blur (works on regular canvas, may not on OffscreenCanvas)
    const supportsFilter = typeof context.filter !== 'undefined';
    if (supportsFilter) {
        context.save();
        context.filter = 'blur(30px) brightness(0.5)';
        context.drawImage(img, bgX - 40, bgY - 40, bgW + 80, bgH + 80);
        context.restore();
    } else {
        // Fallback: downscale repeatedly for a blur approximation
        const tmpCanvas = document.createElement('canvas');
        const smallW = Math.max(1, Math.round(canvasW / 16));
        const smallH = Math.max(1, Math.round(canvasH / 16));
        tmpCanvas.width = smallW;
        tmpCanvas.height = smallH;
        const tmpCtx = tmpCanvas.getContext('2d');
        // Draw image tiny (effectively blurs when scaled back up)
        tmpCtx.drawImage(img, bgX / 16, bgY / 16, bgW / 16, bgH / 16);
        // Draw darkened
        tmpCtx.fillStyle = 'rgba(0,0,0,0.5)';
        tmpCtx.fillRect(0, 0, smallW, smallH);
        // Scale back up with smoothing
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(tmpCanvas, 0, 0, canvasW, canvasH);
    }

    // Foreground: fit-center, sharp
    const fgScale = Math.min(canvasW / img.naturalWidth, canvasH / img.naturalHeight);
    const drawW = img.naturalWidth * fgScale;
    const drawH = img.naturalHeight * fgScale;
    const drawX = (canvasW - drawW) / 2;
    const drawY = (canvasH - drawH) / 2;
    context.drawImage(img, drawX, drawY, drawW, drawH);
}

// ============================================================
// Playback
// ============================================================
function setupTransportControls() {
    $('#play-btn').addEventListener('click', togglePlayback);
    $('#stop-btn').addEventListener('click', stopPlayback);
    $('#export-btn').addEventListener('click', exportVideo);
}

function togglePlayback() {
    if (state.isPlaying) {
        pausePlayback();
    } else {
        startPlayback();
    }
}

function startPlayback() {
    if (state.clips.length === 0) return;
    const total = getTotalDuration();
    if (total <= 0) return;

    // If at the end, restart from beginning
    if (state.playbackTime >= total - 0.01) {
        state.playbackTime = 0;
    }

    state.isPlaying = true;
    $('#play-btn').classList.add('active');
    $('#play-btn').innerHTML = '&#10074;&#10074;';

    // Start audio playback
    playbackAudioCtx = new AudioContext();
    playbackSourceNodes = [];

    for (const track of state.audioTracks) {
        const source = playbackAudioCtx.createBufferSource();
        source.buffer = track.audioBuffer;
        const gainNode = playbackAudioCtx.createGain();
        gainNode.gain.value = track.volume;
        source.connect(gainNode).connect(playbackAudioCtx.destination);

        const audioStart = Math.max(0, state.playbackTime - track.startOffset);
        const audioDelay = Math.max(0, track.startOffset - state.playbackTime);
        const remaining = track.duration - audioStart;
        if (remaining > 0) {
            source.start(playbackAudioCtx.currentTime + audioDelay, audioStart, remaining);
        }
        playbackSourceNodes.push(source);
    }

    playbackStartWall = performance.now();
    playbackStartOffset = state.playbackTime;
    playbackAnimFrame = requestAnimationFrame(playbackTick);
}

function playbackTick(timestamp) {
    if (!state.isPlaying) return;

    const elapsed = (timestamp - playbackStartWall) / 1000;
    state.playbackTime = playbackStartOffset + elapsed;
    const total = getTotalDuration();

    if (state.playbackTime >= total) {
        state.playbackTime = total;
        stopPlayback();
        return;
    }

    renderFrameAtTime(ctx, state.playbackTime, state.resolution.width, state.resolution.height);
    updatePlayhead(state.playbackTime);
    updateTimeDisplay();
    playbackAnimFrame = requestAnimationFrame(playbackTick);
}

function pausePlayback() {
    state.isPlaying = false;
    $('#play-btn').classList.remove('active');
    $('#play-btn').innerHTML = '&#9654;';
    if (playbackAnimFrame) cancelAnimationFrame(playbackAnimFrame);
    stopAudioPlayback();
}

function stopPlayback() {
    state.isPlaying = false;
    $('#play-btn').classList.remove('active');
    $('#play-btn').innerHTML = '&#9654;';
    if (playbackAnimFrame) cancelAnimationFrame(playbackAnimFrame);
    stopAudioPlayback();
    state.playbackTime = 0;
    updatePlayhead(0);
    updateTimeDisplay();
    renderFrame();
}

function stopAudioPlayback() {
    playbackSourceNodes.forEach(s => {
        try { s.stop(); } catch (e) {}
    });
    playbackSourceNodes = [];
    if (playbackAudioCtx) {
        playbackAudioCtx.close().catch(() => {});
        playbackAudioCtx = null;
    }
}

// ============================================================
// Playhead & Time Display
// ============================================================
function updatePlayhead(time) {
    const x = 16 + time * state.pixelsPerSecond;
    playhead.style.left = x + 'px';

    // Auto-scroll to keep playhead visible
    const scrollEl = timelineScroll;
    const visibleLeft = scrollEl.scrollLeft;
    const visibleRight = visibleLeft + scrollEl.clientWidth;
    if (x < visibleLeft + 50 || x > visibleRight - 50) {
        scrollEl.scrollLeft = x - scrollEl.clientWidth / 2;
    }
}

function updateTimeDisplay() {
    const current = state.playbackTime;
    const total = getTotalDuration();
    $('#time-display').textContent = `${formatTime(current)} / ${formatTime(total)}`;
}

// ============================================================
// Export Pipeline
// ============================================================
async function exportVideo() {
    if (state.clips.length === 0) return;
    if (typeof VideoEncoder === 'undefined') {
        browserWarning.classList.remove('hidden');
        return;
    }

    // Pause playback if active
    if (state.isPlaying) pausePlayback();

    const { width, height } = state.resolution;
    const fps = state.fps;
    const totalDuration = getTotalDuration();
    const totalFrames = Math.ceil(totalDuration * fps);

    if (totalFrames === 0) return;

    // Show modal
    exportModal.classList.remove('hidden');
    exportProgressBar.style.width = '0%';
    exportProgressText.textContent = '0%';
    exportStatusText.textContent = 'Encoding video...';

    try {
        // Check codec support
        const videoSupport = await VideoEncoder.isConfigSupported({
            codec: 'avc1.640028',
            width,
            height,
            bitrate: 8_000_000,
            framerate: fps,
        });

        let videoCodecString = 'avc1.640028';
        let muxerVideoCodec = 'avc';
        if (!videoSupport.supported) {
            // Try baseline profile
            const baselineSupport = await VideoEncoder.isConfigSupported({
                codec: 'avc1.42001f',
                width, height,
                bitrate: 8_000_000,
                framerate: fps,
            });
            if (baselineSupport.supported) {
                videoCodecString = 'avc1.42001f';
            } else {
                throw new Error('H.264 encoding not supported by this browser');
            }
        }

        // Determine if audio encoding is available
        let hasAudio = state.audioTracks.length > 0;
        let audioCodecString = 'mp4a.40.2';
        let muxerAudioCodec = 'aac';

        if (hasAudio) {
            try {
                const audioSupport = await AudioEncoder.isConfigSupported({
                    codec: 'mp4a.40.2',
                    sampleRate: 48000,
                    numberOfChannels: 2,
                    bitrate: 128_000,
                });
                if (!audioSupport.supported) {
                    // Try opus as fallback — won't work in MP4 on all players
                    hasAudio = false;
                    console.warn('AAC encoding not supported, exporting without audio');
                }
            } catch {
                hasAudio = false;
                console.warn('AudioEncoder not available, exporting without audio');
            }
        }

        // Setup muxer
        const muxerConfig = {
            target: new Mp4Muxer.ArrayBufferTarget(),
            video: {
                codec: muxerVideoCodec,
                width,
                height,
            },
            fastStart: 'in-memory',
            firstTimestampBehavior: 'offset',
        };

        if (hasAudio) {
            muxerConfig.audio = {
                codec: muxerAudioCodec,
                numberOfChannels: 2,
                sampleRate: 48000,
            };
        }

        const muxer = new Mp4Muxer.Muxer(muxerConfig);

        // Video encoder
        let videoError = null;
        const videoEncoder = new VideoEncoder({
            output(chunk, metadata) {
                muxer.addVideoChunk(chunk, metadata);
            },
            error(e) { videoError = e; },
        });

        videoEncoder.configure({
            codec: videoCodecString,
            width,
            height,
            bitrate: 8_000_000,
            framerate: fps,
        });

        // Use OffscreenCanvas if available, otherwise regular canvas
        let offCanvas, offCtx;
        if (typeof OffscreenCanvas !== 'undefined') {
            offCanvas = new OffscreenCanvas(width, height);
            offCtx = offCanvas.getContext('2d');
        } else {
            offCanvas = document.createElement('canvas');
            offCanvas.width = width;
            offCanvas.height = height;
            offCtx = offCanvas.getContext('2d');
        }

        // Encode video frames
        for (let i = 0; i < totalFrames; i++) {
            if (videoError) throw videoError;

            const time = i / fps;
            renderFrameAtTime(offCtx, time, width, height);

            const frame = new VideoFrame(offCanvas, {
                timestamp: Math.round(time * 1_000_000),
                duration: Math.round(1_000_000 / fps),
            });

            const keyFrame = i % (fps * 2) === 0;
            videoEncoder.encode(frame, { keyFrame });
            frame.close();

            // Backpressure
            while (videoEncoder.encodeQueueSize > 10) {
                await new Promise(r => setTimeout(r, 1));
            }

            // Progress
            const pct = Math.round((i / totalFrames) * (hasAudio ? 80 : 100));
            exportProgressBar.style.width = pct + '%';
            exportProgressText.textContent = pct + '%';
        }

        await videoEncoder.flush();
        videoEncoder.close();

        // Encode audio
        if (hasAudio) {
            exportStatusText.textContent = 'Encoding audio...';
            await encodeAudio(muxer, totalDuration, audioCodecString);
        }

        exportProgressBar.style.width = '100%';
        exportProgressText.textContent = '100%';
        exportStatusText.textContent = 'Finalizing...';
        await new Promise(r => setTimeout(r, 50));

        muxer.finalize();

        // Download
        const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'video.mp4';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);

        exportStatusText.textContent = 'Done! Download started.';
        setTimeout(() => exportModal.classList.add('hidden'), 2000);

    } catch (e) {
        console.error('Export failed:', e);
        exportStatusText.textContent = 'Export failed: ' + e.message;
        exportProgressBar.style.width = '0%';
        exportProgressText.textContent = 'Error';
        setTimeout(() => exportModal.classList.add('hidden'), 4000);
    }
}

async function encodeAudio(muxer, videoDuration, codecString) {
    const sampleRate = 48000;
    const numberOfChannels = 2;
    const totalSamples = Math.ceil(videoDuration * sampleRate);

    // Mix all audio tracks using OfflineAudioContext
    const offlineCtx = new OfflineAudioContext(numberOfChannels, totalSamples, sampleRate);

    for (const track of state.audioTracks) {
        const source = offlineCtx.createBufferSource();
        source.buffer = track.audioBuffer;
        const gain = offlineCtx.createGain();
        gain.gain.value = track.volume;
        source.connect(gain).connect(offlineCtx.destination);
        source.start(track.startOffset);
    }

    const mixedBuffer = await offlineCtx.startRendering();

    // Audio encoder
    let audioError = null;
    const audioEncoder = new AudioEncoder({
        output(chunk, metadata) {
            muxer.addAudioChunk(chunk, metadata);
        },
        error(e) { audioError = e; },
    });

    audioEncoder.configure({
        codec: codecString,
        sampleRate,
        numberOfChannels,
        bitrate: 128_000,
    });

    // Encode in chunks
    const samplesPerChunk = 1024;
    const totalChunks = Math.ceil(totalSamples / samplesPerChunk);

    for (let i = 0; i < totalChunks; i++) {
        if (audioError) throw audioError;

        const offset = i * samplesPerChunk;
        const chunkLength = Math.min(samplesPerChunk, totalSamples - offset);

        // Build planar data: ch0 samples then ch1 samples
        const planarData = new Float32Array(chunkLength * numberOfChannels);
        for (let ch = 0; ch < numberOfChannels; ch++) {
            const channelData = mixedBuffer.getChannelData(Math.min(ch, mixedBuffer.numberOfChannels - 1));
            planarData.set(channelData.subarray(offset, offset + chunkLength), ch * chunkLength);
        }

        const audioData = new AudioData({
            format: 'f32-planar',
            sampleRate,
            numberOfFrames: chunkLength,
            numberOfChannels,
            timestamp: Math.round((offset / sampleRate) * 1_000_000),
            data: planarData,
        });

        audioEncoder.encode(audioData);
        audioData.close();

        while (audioEncoder.encodeQueueSize > 10) {
            await new Promise(r => setTimeout(r, 1));
        }

        // Progress: audio is 80-100% range
        const pct = 80 + Math.round((i / totalChunks) * 20);
        exportProgressBar.style.width = pct + '%';
        exportProgressText.textContent = pct + '%';
    }

    await audioEncoder.flush();
    audioEncoder.close();
}

// ============================================================
// Keyboard Shortcuts
// ============================================================
function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
        // Don't capture when typing in inputs
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

        switch (e.code) {
            case 'Space':
                e.preventDefault();
                togglePlayback();
                break;
            case 'Delete':
            case 'Backspace':
                if (state.selectedId) {
                    propDeleteBtn.click();
                }
                break;
            case 'KeyE':
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    exportVideo();
                }
                break;
            case 'Escape':
                deselectAll();
                break;
        }
    });
}

// ============================================================
// Utilities
// ============================================================
function getTotalDuration() {
    return state.clips.reduce((sum, c) => sum + c.duration, 0);
}

function formatTime(seconds) {
    const s = Math.max(0, seconds);
    const min = Math.floor(s / 60);
    const sec = s % 60;
    return `${min}:${sec.toFixed(1).padStart(4, '0')}`;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ============================================================
// Start
// ============================================================
init();
