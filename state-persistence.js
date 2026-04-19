// ============================================================
// State Persistence — IndexedDB + localStorage
// ============================================================

const DB_NAME = 'VideoEditorDB';
const DB_VERSION = 1;
const MEDIA_STORE = 'mediaFiles';
const STATE_KEY = 'videoEditorState';
const SCHEMA_VERSION = 1;

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(MEDIA_STORE)) {
                db.createObjectStore(MEDIA_STORE, { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// --- Save ---

let _saveDebounceTimer = null;
let _lastSaveSucceeded = true;

function saveState() {
    clearTimeout(_saveDebounceTimer);
    _saveDebounceTimer = setTimeout(async () => {
        try {
            await _saveStateNow();
            _lastSaveSucceeded = true;
        } catch (e) {
            _lastSaveSucceeded = false;
            if (e.name === 'QuotaExceededError') {
                console.error('Storage quota exceeded');
                alert('Depolama alanı dolu. Bazı veriler kaydedilemeyebilir.');
            } else {
                console.error('Failed to save state:', e);
            }
        }
    }, 500);
}

async function _saveStateNow() {
    const db = await openDB();

    // 1. Metadata → localStorage
    const metadata = {
        version: SCHEMA_VERSION,
        pixelsPerSecond: state.pixelsPerSecond,
        clips: state.clips.map(c => ({
            id: c.id,
            name: c.name,
            duration: c.duration,
            scaleMode: c.scaleMode,
            customScale: c.customScale,
            naturalWidth: c.naturalWidth,
            naturalHeight: c.naturalHeight,
        })),
        audioTracks: state.audioTracks.map(t => ({
            id: t.id,
            name: t.name,
            duration: t.duration,
            startOffset: t.startOffset,
            volume: t.volume,
            isRecording: t.file === null,
        })),
        resolution: state.resolution,
        fps: state.fps,
        overlay: {
            enabled: state.overlay.enabled,
            backgroundColor: state.overlay.backgroundColor,
            header: { ...state.overlay.header },
            title: { ...state.overlay.title },
            footer: { ...state.overlay.footer },
        },
    };
    localStorage.setItem(STATE_KEY, JSON.stringify(metadata));

    // 2. Binary data → IndexedDB
    const tx = db.transaction(MEDIA_STORE, 'readwrite');
    const store = tx.objectStore(MEDIA_STORE);
    store.clear();

    for (const clip of state.clips) {
        if (clip.file) {
            store.put({
                id: clip.id,
                type: 'image',
                blob: clip.file,
                thumbnailDataUrl: clip.thumbnailDataUrl,
            });
        }
    }

    for (const track of state.audioTracks) {
        if (track.file) {
            store.put({
                id: track.id,
                type: 'audio-file',
                blob: track.file,
            });
        } else if (track.audioBuffer) {
            const channelData = [];
            for (let ch = 0; ch < track.audioBuffer.numberOfChannels; ch++) {
                channelData.push(new Float32Array(track.audioBuffer.getChannelData(ch)));
            }
            store.put({
                id: track.id,
                type: 'audio-recording',
                channelData,
                sampleRate: track.audioBuffer.sampleRate,
                numberOfChannels: track.audioBuffer.numberOfChannels,
            });
        }
    }

    // Overlay logo (if user uploaded a custom one)
    if (state.overlay.logo.file) {
        store.put({
            id: 'overlay-logo',
            type: 'logo',
            blob: state.overlay.logo.file,
        });
    }

    await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });

    db.close();
}

// --- Restore ---

async function restoreState() {
    const json = localStorage.getItem(STATE_KEY);
    if (!json) return;

    let metadata;
    try {
        metadata = JSON.parse(json);
    } catch (e) {
        console.error('Invalid saved state, starting fresh');
        localStorage.removeItem(STATE_KEY);
        return;
    }

    if (metadata.version !== SCHEMA_VERSION) {
        console.warn(`Saved state version ${metadata.version} != ${SCHEMA_VERSION}, starting fresh`);
        localStorage.removeItem(STATE_KEY);
        return;
    }

    let db;
    try {
        db = await openDB();
    } catch (e) {
        console.error('Failed to open IndexedDB:', e);
        return;
    }

    // Fetch ALL items from IndexedDB in one synchronous transaction pass.
    // We must NOT await between IDB calls — the transaction auto-closes otherwise.
    const allItems = await new Promise((resolve, reject) => {
        const tx = db.transaction(MEDIA_STORE, 'readonly');
        const store = tx.objectStore(MEDIA_STORE);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
    db.close();

    // Build a lookup map by ID for fast access
    const itemMap = {};
    for (const item of allItems) {
        itemMap[item.id] = item;
    }

    // Restore settings
    if (metadata.resolution) state.resolution = metadata.resolution;
    if (metadata.fps) state.fps = metadata.fps;
    if (metadata.pixelsPerSecond) {
        state.pixelsPerSecond = metadata.pixelsPerSecond;
        const zoomSlider = document.getElementById('zoom-slider');
        if (zoomSlider) zoomSlider.value = state.pixelsPerSecond;
    }
    if (metadata.overlay) {
        // Merge overlay settings (keep logo.image as null — loaded separately)
        const savedLogo = state.overlay.logo;
        Object.assign(state.overlay, metadata.overlay);
        state.overlay.logo = savedLogo;
    }

    // Update resolution UI
    const resSel = document.getElementById('resolution-select');
    const resKey = `${state.resolution.width}x${state.resolution.height}`;
    const matchingOption = resSel.querySelector(`option[value="${resKey}"]`);
    if (matchingOption) resSel.value = resKey;
    const canvas = document.getElementById('preview-canvas');
    canvas.width = state.resolution.width;
    canvas.height = state.resolution.height;
    document.getElementById('resolution-badge').textContent =
        `${state.resolution.width} x ${state.resolution.height}`;

    // Update FPS UI
    const fpsSel = document.getElementById('fps-select');
    if (fpsSel) fpsSel.value = state.fps;

    // Restore clips
    for (const clipMeta of (metadata.clips || [])) {
        try {
            const stored = itemMap[clipMeta.id];
            if (!stored || !stored.blob) continue;

            const file = stored.blob instanceof File ? stored.blob :
                new File([stored.blob], clipMeta.name, { type: stored.blob.type || 'image/png' });
            const url = URL.createObjectURL(file);
            const img = new Image();
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                img.src = url;
            });

            state.clips.push({
                id: clipMeta.id,
                file,
                name: clipMeta.name,
                image: img,
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                duration: clipMeta.duration,
                scaleMode: clipMeta.scaleMode || 'fit',
                customScale: clipMeta.customScale || 1.0,
                thumbnailDataUrl: stored.thumbnailDataUrl || '',
            });
        } catch (e) {
            console.warn('Failed to restore clip:', clipMeta.name, e);
        }
    }

    // Restore audio tracks
    for (const trackMeta of (metadata.audioTracks || [])) {
        try {
            const stored = itemMap[trackMeta.id];
            if (!stored) continue;

            let audioBuffer;
            let file = null;

            if (stored.type === 'audio-file') {
                file = stored.blob instanceof File ? stored.blob :
                    new File([stored.blob], trackMeta.name, { type: stored.blob.type || 'audio/mpeg' });
                const ctx = new AudioContext();
                const arrayBuf = await file.arrayBuffer();
                audioBuffer = await ctx.decodeAudioData(arrayBuf);
                ctx.close();
            } else if (stored.type === 'audio-recording') {
                const length = stored.channelData[0].length;
                audioBuffer = new AudioBuffer({
                    length,
                    sampleRate: stored.sampleRate,
                    numberOfChannels: stored.numberOfChannels,
                });
                for (let ch = 0; ch < stored.numberOfChannels; ch++) {
                    audioBuffer.copyToChannel(stored.channelData[ch], ch);
                }
            }

            if (audioBuffer) {
                state.audioTracks.push({
                    id: trackMeta.id,
                    file,
                    name: trackMeta.name,
                    audioBuffer,
                    duration: audioBuffer.duration,
                    startOffset: trackMeta.startOffset || 0,
                    volume: trackMeta.volume ?? 1.0,
                });
            }
        } catch (e) {
            console.warn('Failed to restore audio track:', trackMeta.name, e);
        }
    }

    // Restore custom overlay logo
    try {
        const logoData = itemMap['overlay-logo'];
        if (logoData && logoData.blob) {
            const url = URL.createObjectURL(logoData.blob);
            const img = new Image();
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                img.src = url;
            });
            state.overlay.logo.image = img;
            state.overlay.logo.file = logoData.blob;
        }
    } catch (e) {
        console.warn('Failed to restore overlay logo:', e);
    }

    // Derive recording counter from existing track names
    if (typeof recorderState !== 'undefined') {
        let maxIdx = 0;
        for (const track of state.audioTracks) {
            const match = track.name.match(/^Kayıt-(\d+)$/);
            if (match) maxIdx = Math.max(maxIdx, parseInt(match[1]));
        }
        recorderState.recordingCounter = maxIdx;
    }

    // Refresh UI
    updateEmptyState();
    renderTimeline();
    renderFrame();
    updateOverlayToggleBtn();
}

// --- Clear ---

async function clearSavedState() {
    localStorage.removeItem(STATE_KEY);
    try {
        const db = await openDB();
        const tx = db.transaction(MEDIA_STORE, 'readwrite');
        tx.objectStore(MEDIA_STORE).clear();
        await new Promise(r => { tx.oncomplete = r; });
        db.close();
    } catch (e) {
        console.error('Failed to clear IndexedDB:', e);
    }
}

function hasSavedState() {
    return localStorage.getItem(STATE_KEY) !== null;
}
