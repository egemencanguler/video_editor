// ============================================================
// Video Editor — app.js
// ============================================================

// --- State ---
const state = {
    clips: [],
    audioTracks: [],
    selectedId: null,
    selectedType: null, // 'clip' | 'audio'
    resolution: { width: 1080, height: 1920 },
    fps: 30,
    isPlaying: false,
    playbackTime: 0,
    pixelsPerSecond: 80,
    overlay: {
        enabled: true,
        backgroundColor: '#000000',
        header: {
            gradientFrom: '#A00000',
            gradientTo: '#5C0A0A',
            heightPercent: 15,
        },
        title: {
            text: 'ANITKABİR DERNEĞİ',
            color: '#F5D98A',
            fontFamily: "'Georgia', 'Times New Roman', serif",
            sizePercent: 3,
            bold: true,
        },
        logo: {
            image: null,
            file: null,
        },
        footer: {
            text: 'https://www.anitkabir.com.tr/',
            color: '#F5D98A',
            fontFamily: "'Georgia', 'Times New Roman', serif",
            sizePercent: 2.5,
            gradientFrom: '#A00000',
            gradientTo: '#5C0A0A',
            heightPercent: 9,
        },
    },
};

// --- DOM refs ---
const $ = (sel) => document.querySelector(sel);
const previewCanvas = $('#preview-canvas');
const ctx = previewCanvas.getContext('2d');
const imageTrack = $('#image-track');
const audioTrack = $('#audio-track');
const playhead = $('#playhead');
const timelineScroll = $('#timeline-scroll');
const timelineContent = $('#timeline-content');
const timeRuler = $('#time-ruler');
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
    setupOverlayUI();
    updateOverlayToggleBtn();
    loadDefaultLogo();
    renderFrame();
}

function loadDefaultLogo() {
    const img = new Image();
    img.onload = () => {
        state.overlay.logo.image = img;
        renderFrame();
    };
    img.onerror = () => {
        console.warn('Default logo could not be loaded');
    };
    // Prefer embedded data URL (works on file:// without tainting the canvas).
    // Falls back to logo.png if the embedded version is not available.
    img.src = (typeof window !== 'undefined' && window.LOGO_DATA_URL) || 'logo.png';
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
        id: generateId(),
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
        id: generateId(),
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
    renderRuler();
    renderImageTrack();
    renderAudioTrackUI();
    updateTimelineTotalWidth();
    updatePlayhead(state.playbackTime);
}

function renderRuler() {
    timeRuler.innerHTML = '';
    const pps = state.pixelsPerSecond;
    const totalImageTime = getTotalDuration();
    const maxAudioEnd = state.audioTracks.reduce((max, t) => Math.max(max, t.startOffset + t.duration), 0);
    const totalTime = Math.max(totalImageTime, maxAudioEnd, 5);

    // Determine tick interval based on zoom level
    let majorInterval, minorInterval;
    if (pps >= 100) {
        majorInterval = 1; minorInterval = 0.5;
    } else if (pps >= 40) {
        majorInterval = 5; minorInterval = 1;
    } else {
        majorInterval = 10; minorInterval = 5;
    }

    for (let t = 0; t <= totalTime + majorInterval; t += minorInterval) {
        const x = t * pps;
        const isMajor = Math.abs(t % majorInterval) < 0.01 || Math.abs(t % majorInterval - majorInterval) < 0.01;

        const tick = document.createElement('div');
        tick.className = 'ruler-tick ' + (isMajor ? 'major' : 'minor');
        tick.style.left = x + 'px';
        timeRuler.appendChild(tick);

        if (isMajor) {
            const label = document.createElement('div');
            label.className = 'ruler-label';
            label.style.left = x + 'px';
            label.textContent = formatTime(t);
            timeRuler.appendChild(label);
        }
    }
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
    audioTrack.innerHTML = '';

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
    timelineContent.style.width = totalWidth + 'px';
}

// ============================================================
// Clip Drag (Reorder)
// ============================================================
let dragSourceIndex = -1;

function setupClipDrag(el, clip, index) {
    el.addEventListener('dragstart', (e) => {
        if (isResizing) { e.preventDefault(); return; }
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
let isResizing = false;

function setupResizeHandle(handle, clip) {
    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        isResizing = true;

        const startX = e.clientX;
        const startDuration = clip.duration;
        const clipEl = handle.parentElement;
        const durationLabel = clipEl.querySelector('.clip-duration');

        // Disable draggable on all clips during resize to prevent native drag interference
        const allClips = imageTrack.querySelectorAll('.clip');
        allClips.forEach(c => c.draggable = false);

        const onMove = (e) => {
            e.preventDefault();
            const dx = e.clientX - startX;
            const dt = dx / state.pixelsPerSecond;
            clip.duration = Math.max(0.1, startDuration + dt);

            // Update only this clip's width and label — don't rebuild the entire timeline
            clipEl.style.width = Math.max(clip.duration * state.pixelsPerSecond, 30) + 'px';
            if (durationLabel) durationLabel.textContent = clip.duration.toFixed(1) + 's';
            updateTimeDisplay();

            if (state.selectedType === 'clip' && state.selectedId === clip.id) {
                propDuration.value = clip.duration.toFixed(1);
            }
        };

        const onUp = () => {
            isResizing = false;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            // Full re-render now that resizing is done
            renderTimeline();
            renderFrame();
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

// ============================================================
// Timeline Seek
// ============================================================
function setupTimelineSeek() {
    // Helper: compute time from mouse event on timeline content
    function timeFromEvent(e) {
        const contentRect = timelineContent.getBoundingClientRect();
        const x = e.clientX - contentRect.left;
        const time = Math.max(0, x / state.pixelsPerSecond);
        return Math.min(time, getTotalDuration());
    }

    function seekTo(e) {
        state.playbackTime = timeFromEvent(e);
        updatePlayhead(state.playbackTime);
        updateTimeDisplay();
        renderFrame();
    }

    // Ruler: click + drag to scrub
    let isScrubbing = false;
    timeRuler.addEventListener('mousedown', (e) => {
        if (isResizing) return;
        e.preventDefault();
        isScrubbing = true;
        seekTo(e);
    });

    document.addEventListener('mousemove', (e) => {
        if (!isScrubbing) return;
        seekTo(e);
    });

    document.addEventListener('mouseup', () => {
        isScrubbing = false;
    });

    // Track area: click on empty space to seek (not on clips)
    timelineContent.addEventListener('mousedown', (e) => {
        if (isResizing) return;
        if (e.target === timeRuler) return; // handled above
        if (e.target.closest('.clip')) return; // clicking a clip — don't seek
        if (e.target.closest('.time-ruler')) return;
        seekTo(e);
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

function findActiveClipAtTime(time) {
    if (state.clips.length === 0) return null;
    let cumulative = 0;
    for (const clip of state.clips) {
        if (time < cumulative + clip.duration) return clip;
        cumulative += clip.duration;
    }
    return state.clips[state.clips.length - 1];
}

function renderFrameAtTime(context, time, width, height) {
    context.fillStyle = state.overlay.enabled ? state.overlay.backgroundColor : '#000';
    context.fillRect(0, 0, width, height);

    const activeClip = findActiveClipAtTime(time);
    if (activeClip) {
        drawImageToCanvas(context, activeClip, 0, 0, width, height);
    }

    if (state.overlay.enabled) {
        // Bars drawn on top of the image
        drawHeader(context, width, height);
        const logoRect = drawLogo(context, width, height);
        drawTitle(context, width, height, logoRect);
        drawFooter(context, width, height);
    }
}

function drawImageToCanvas(context, clip, areaX, areaY, areaW, areaH) {
    const img = clip.image;
    const mode = clip.scaleMode;
    let drawW, drawH, drawX, drawY;

    // Blur-fill: draw blurred & scaled background first, then sharp fit on top
    if (mode === 'blur-fill') {
        drawBlurFill(context, img, areaX, areaY, areaW, areaH);
        return;
    }

    // Fit modes
    if (mode === 'fit' || mode === 'fit-top' || mode === 'fit-bottom') {
        const scale = Math.min(areaW / img.naturalWidth, areaH / img.naturalHeight);
        drawW = img.naturalWidth * scale;
        drawH = img.naturalHeight * scale;
        drawX = areaX + (areaW - drawW) / 2;
        if (mode === 'fit-top') drawY = areaY;
        else if (mode === 'fit-bottom') drawY = areaY + areaH - drawH;
        else drawY = areaY + (areaH - drawH) / 2;
    }
    // Fill modes
    else if (mode === 'fill' || mode === 'fill-top' || mode === 'fill-bottom') {
        const scale = Math.max(areaW / img.naturalWidth, areaH / img.naturalHeight);
        drawW = img.naturalWidth * scale;
        drawH = img.naturalHeight * scale;
        drawX = areaX + (areaW - drawW) / 2;
        if (mode === 'fill-top') drawY = areaY;
        else if (mode === 'fill-bottom') drawY = areaY + areaH - drawH;
        else drawY = areaY + (areaH - drawH) / 2;
    }
    // Stretch
    else if (mode === 'stretch') {
        drawX = areaX; drawY = areaY; drawW = areaW; drawH = areaH;
    }
    // Custom
    else {
        const baseFit = Math.min(areaW / img.naturalWidth, areaH / img.naturalHeight);
        const scale = baseFit * clip.customScale;
        drawW = img.naturalWidth * scale;
        drawH = img.naturalHeight * scale;
        drawX = areaX + (areaW - drawW) / 2;
        drawY = areaY + (areaH - drawH) / 2;
    }

    // Clip to area so fill modes don't spill outside the window rect
    if (mode === 'fill' || mode === 'fill-top' || mode === 'fill-bottom') {
        context.save();
        context.beginPath();
        context.rect(areaX, areaY, areaW, areaH);
        context.clip();
        context.drawImage(img, drawX, drawY, drawW, drawH);
        context.restore();
    } else {
        context.drawImage(img, drawX, drawY, drawW, drawH);
    }
}

function drawBlurFill(context, img, areaX, areaY, areaW, areaH) {
    const bgScale = Math.max(areaW / img.naturalWidth, areaH / img.naturalHeight);
    const bgW = img.naturalWidth * bgScale;
    const bgH = img.naturalHeight * bgScale;
    const bgX = areaX + (areaW - bgW) / 2;
    const bgY = areaY + (areaH - bgH) / 2;

    // Clip to area so blur doesn't spill
    context.save();
    context.beginPath();
    context.rect(areaX, areaY, areaW, areaH);
    context.clip();

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
        const smallW = Math.max(1, Math.round(areaW / 16));
        const smallH = Math.max(1, Math.round(areaH / 16));
        tmpCanvas.width = smallW;
        tmpCanvas.height = smallH;
        const tmpCtx = tmpCanvas.getContext('2d');
        tmpCtx.drawImage(img, (bgX - areaX) / 16, (bgY - areaY) / 16, bgW / 16, bgH / 16);
        tmpCtx.fillStyle = 'rgba(0,0,0,0.5)';
        tmpCtx.fillRect(0, 0, smallW, smallH);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(tmpCanvas, areaX, areaY, areaW, areaH);
    }

    // Foreground: fit-center, sharp
    const fgScale = Math.min(areaW / img.naturalWidth, areaH / img.naturalHeight);
    const drawW = img.naturalWidth * fgScale;
    const drawH = img.naturalHeight * fgScale;
    const drawX = areaX + (areaW - drawW) / 2;
    const drawY = areaY + (areaH - drawH) / 2;
    context.drawImage(img, drawX, drawY, drawW, drawH);

    context.restore();
}

// ============================================================
// Overlay Rendering (viewport, logo, footer)
// ============================================================
function drawHeader(context, canvasW, canvasH) {
    const header = state.overlay.header;
    const hh = canvasH * (header.heightPercent / 100);
    const grad = context.createLinearGradient(0, 0, 0, hh);
    grad.addColorStop(0, header.gradientFrom);
    grad.addColorStop(1, header.gradientTo);
    context.fillStyle = grad;
    context.fillRect(0, 0, canvasW, hh);
}

function drawLogo(context, canvasW, canvasH) {
    const logo = state.overlay.logo;
    if (!logo.image) return null;
    const img = logo.image;
    const headerH = canvasH * (state.overlay.header.heightPercent / 100);

    // Logo always fills the full header height, aligned to top-left corner
    const targetH = headerH;
    const aspectRatio = img.naturalWidth / img.naturalHeight;
    const targetW = targetH * aspectRatio;

    context.drawImage(img, 0, 0, targetW, targetH);
    return { x: 0, y: 0, w: targetW, h: targetH };
}

function drawTitle(context, canvasW, canvasH, logoRect) {
    const title = state.overlay.title;
    if (!title.text) return;
    const headerH = canvasH * (state.overlay.header.heightPercent / 100);
    const fontSize = canvasH * (title.sizePercent / 100);
    // Small breathing room between logo and title, and at the right edge
    const gap = canvasW * 0.02;

    context.save();
    const weight = title.bold ? 'bold ' : '';
    context.font = `${weight}${fontSize}px ${title.fontFamily}`;
    context.fillStyle = title.color;
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    // Available region = right of logo to right edge of canvas
    const logoRight = logoRect ? logoRect.w : 0;
    const availableLeft = logoRight + gap;
    const availableRight = canvasW - gap;
    const centerX = (availableLeft + availableRight) / 2;
    const centerY = headerH / 2;

    context.fillText(title.text, centerX, centerY);
    context.restore();
}

function drawFooter(context, canvasW, canvasH) {
    const footer = state.overlay.footer;
    const fh = canvasH * (footer.heightPercent / 100);
    const fy = canvasH - fh;

    // Gradient bar
    const grad = context.createLinearGradient(0, fy, 0, canvasH);
    grad.addColorStop(0, footer.gradientFrom);
    grad.addColorStop(1, footer.gradientTo);
    context.fillStyle = grad;
    context.fillRect(0, fy, canvasW, fh);

    // Footer text centered in the bar
    if (footer.text) {
        const fontSize = canvasH * (footer.sizePercent / 100);
        context.save();
        context.font = `${fontSize}px ${footer.fontFamily}`;
        context.fillStyle = footer.color;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(footer.text, canvasW / 2, fy + fh / 2);
        context.restore();
    }
}

// ============================================================
// Overlay UI (modal controls)
// ============================================================
function setupOverlayUI() {
    const openBtn = $('#overlay-btn');
    const modal = $('#overlay-modal');
    const closeBtn = $('#overlay-close-btn');
    if (!openBtn || !modal) return;

    openBtn.addEventListener('click', () => {
        syncOverlayForm();
        modal.classList.remove('hidden');
    });
    closeBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
    });

    // Quick toolbar toggle
    const toggleBtn = $('#overlay-toggle-btn');
    toggleBtn.addEventListener('click', () => {
        state.overlay.enabled = !state.overlay.enabled;
        updateOverlayToggleBtn();
        renderFrame();
    });

    // Enabled toggle (inside modal)
    $('#overlay-enabled').addEventListener('change', (e) => {
        state.overlay.enabled = e.target.checked;
        updateOverlayToggleBtn();
        renderFrame();
    });

    // Header bar
    $('#overlay-header-grad-from').addEventListener('input', (e) => {
        state.overlay.header.gradientFrom = e.target.value;
        renderFrame();
    });
    $('#overlay-header-grad-to').addEventListener('input', (e) => {
        state.overlay.header.gradientTo = e.target.value;
        renderFrame();
    });
    $('#overlay-header-height').addEventListener('input', (e) => {
        state.overlay.header.heightPercent = parseFloat(e.target.value);
        $('#overlay-header-height-value').textContent = e.target.value + '%';
        renderFrame();
    });

    // Title
    $('#overlay-title-text').addEventListener('input', (e) => {
        state.overlay.title.text = e.target.value;
        renderFrame();
    });
    $('#overlay-title-color').addEventListener('input', (e) => {
        state.overlay.title.color = e.target.value;
        renderFrame();
    });
    $('#overlay-title-size').addEventListener('input', (e) => {
        state.overlay.title.sizePercent = parseFloat(e.target.value);
        $('#overlay-title-size-value').textContent = e.target.value + '%';
        renderFrame();
    });
    $('#overlay-title-font').addEventListener('change', (e) => {
        state.overlay.title.fontFamily = e.target.value;
        renderFrame();
    });
    $('#overlay-title-bold').addEventListener('change', (e) => {
        state.overlay.title.bold = e.target.checked;
        renderFrame();
    });

    // Logo
    $('#overlay-logo-file').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const img = new Image();
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = URL.createObjectURL(file);
        });
        state.overlay.logo.image = img;
        state.overlay.logo.file = file;
        renderFrame();
    });
    // Footer
    $('#overlay-footer-text').addEventListener('input', (e) => {
        state.overlay.footer.text = e.target.value;
        renderFrame();
    });
    $('#overlay-footer-color').addEventListener('input', (e) => {
        state.overlay.footer.color = e.target.value;
        renderFrame();
    });
    $('#overlay-footer-size').addEventListener('input', (e) => {
        state.overlay.footer.sizePercent = parseFloat(e.target.value);
        $('#overlay-footer-size-value').textContent = e.target.value + '%';
        renderFrame();
    });
    $('#overlay-footer-font').addEventListener('change', (e) => {
        state.overlay.footer.fontFamily = e.target.value;
        renderFrame();
    });
    $('#overlay-footer-grad-from').addEventListener('input', (e) => {
        state.overlay.footer.gradientFrom = e.target.value;
        renderFrame();
    });
    $('#overlay-footer-grad-to').addEventListener('input', (e) => {
        state.overlay.footer.gradientTo = e.target.value;
        renderFrame();
    });
    $('#overlay-footer-height').addEventListener('input', (e) => {
        state.overlay.footer.heightPercent = parseFloat(e.target.value);
        $('#overlay-footer-height-value').textContent = e.target.value + '%';
        renderFrame();
    });
}

function updateOverlayToggleBtn() {
    const btn = $('#overlay-toggle-btn');
    if (!btn) return;
    btn.classList.toggle('active', state.overlay.enabled);
    const label = btn.querySelector('.toggle-label');
    if (label) label.textContent = state.overlay.enabled ? 'Açık' : 'Kapalı';
}

function syncOverlayForm() {
    const o = state.overlay;
    $('#overlay-enabled').checked = o.enabled;

    $('#overlay-header-grad-from').value = o.header.gradientFrom;
    $('#overlay-header-grad-to').value = o.header.gradientTo;
    $('#overlay-header-height').value = o.header.heightPercent;
    $('#overlay-header-height-value').textContent = o.header.heightPercent + '%';

    $('#overlay-title-text').value = o.title.text;
    $('#overlay-title-color').value = o.title.color;
    $('#overlay-title-size').value = o.title.sizePercent;
    $('#overlay-title-size-value').textContent = o.title.sizePercent + '%';
    $('#overlay-title-font').value = o.title.fontFamily;
    $('#overlay-title-bold').checked = o.title.bold;

    $('#overlay-footer-text').value = o.footer.text;
    $('#overlay-footer-color').value = o.footer.color;
    $('#overlay-footer-size').value = o.footer.sizePercent;
    $('#overlay-footer-size-value').textContent = o.footer.sizePercent + '%';
    $('#overlay-footer-font').value = o.footer.fontFamily;
    $('#overlay-footer-grad-from').value = o.footer.gradientFrom;
    $('#overlay-footer-grad-to').value = o.footer.gradientTo;
    $('#overlay-footer-height').value = o.footer.heightPercent;
    $('#overlay-footer-height-value').textContent = o.footer.heightPercent + '%';
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
    const x = time * state.pixelsPerSecond;
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
    exportStatusText.textContent = 'Video kodlanıyor...';

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
                throw new Error('Bu tarayıcı H.264 kodlamayı desteklemiyor');
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
            exportStatusText.textContent = 'Ses kodlanıyor...';
            await encodeAudio(muxer, totalDuration, audioCodecString);
        }

        exportProgressBar.style.width = '100%';
        exportProgressText.textContent = '100%';
        exportStatusText.textContent = 'Tamamlanıyor...';
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

        exportStatusText.textContent = 'Tamamlandı! İndirme başladı.';
        setTimeout(() => exportModal.classList.add('hidden'), 2000);

    } catch (e) {
        console.error('Export failed:', e);
        exportStatusText.textContent = 'Dışa aktarma başarısız: ' + e.message;
        exportProgressBar.style.width = '0%';
        exportProgressText.textContent = 'Hata';
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
function generateId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

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
