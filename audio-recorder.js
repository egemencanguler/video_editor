// ============================================================
// Audio Recorder + Waveform Editor
// ============================================================
// Two modes:
//   1. RECORD mode: "Ses Kaydet" button → record → auto-add to timeline
//   2. EDIT mode: select audio on timeline → "Düzenle" → waveform editor

const recorderState = {
    // Recording
    isRecording: false,
    mediaStream: null,
    audioContext: null,
    scriptProcessor: null,
    chunks: [],
    recordingStartTime: 0,
    recordingCounter: 0,

    // Editor
    mode: null,              // 'record' | 'edit'
    editingTrackId: null,    // ID of the audio track being edited (edit mode only)
    editBuffer: null,
    undoStack: [],
    selection: null,
    peaksCache: null,

    // Playback (within editor)
    isPlaying: false,
    playbackSource: null,
    playbackCtx: null,
    playbackStartTime: 0,
    playbackStartOffset: 0,
    playbackAnimFrame: null,
};

const UNDO_MAX_BYTES = 100 * 1024 * 1024; // 100MB

// ============================================================
// Recording
// ============================================================

async function startRecording() {
    try {
        recorderState.mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                sampleRate: 48000,
            }
        });
    } catch (err) {
        alert('Mikrofon erişimi reddedildi. Lütfen tarayıcı ayarlarından izin verin.');
        return;
    }

    recorderState.audioContext = new AudioContext({ sampleRate: 48000 });
    const source = recorderState.audioContext.createMediaStreamSource(recorderState.mediaStream);

    const bufferSize = 4096;
    const numChannels = 1;
    recorderState.scriptProcessor = recorderState.audioContext.createScriptProcessor(bufferSize, numChannels, numChannels);

    recorderState.scriptProcessor.onaudioprocess = (e) => {
        if (!recorderState.isRecording) return;
        const channels = [];
        for (let ch = 0; ch < e.inputBuffer.numberOfChannels; ch++) {
            channels.push(new Float32Array(e.inputBuffer.getChannelData(ch)));
        }
        recorderState.chunks.push({ channels });
    };

    source.connect(recorderState.scriptProcessor);
    recorderState.scriptProcessor.connect(recorderState.audioContext.destination);

    recorderState.chunks = [];
    recorderState.isRecording = true;
    recorderState.recordingStartTime = performance.now();

    updateRecorderUI();
    _startRecordingTimer();
}

function stopRecording() {
    if (!recorderState.isRecording) return;
    recorderState.isRecording = false;

    if (recorderState.scriptProcessor) {
        recorderState.scriptProcessor.disconnect();
        recorderState.scriptProcessor.onaudioprocess = null;
        recorderState.scriptProcessor = null;
    }
    if (recorderState.mediaStream) {
        recorderState.mediaStream.getTracks().forEach(t => t.stop());
    }
    if (recorderState.audioContext) {
        recorderState.audioContext.close().catch(() => {});
    }

    const sampleRate = 48000;
    const numChannels = recorderState.chunks[0]?.channels.length || 1;
    const totalSamples = recorderState.chunks.reduce((sum, c) => sum + c.channels[0].length, 0);

    if (totalSamples === 0) {
        updateRecorderUI();
        return;
    }

    const audioBuffer = new AudioBuffer({
        length: totalSamples,
        sampleRate: sampleRate,
        numberOfChannels: numChannels,
    });

    for (let ch = 0; ch < numChannels; ch++) {
        const channelData = audioBuffer.getChannelData(ch);
        let offset = 0;
        for (const chunk of recorderState.chunks) {
            channelData.set(chunk.channels[Math.min(ch, chunk.channels.length - 1)], offset);
            offset += chunk.channels[0].length;
        }
    }

    recorderState.chunks = [];
    recorderState.recordingCounter++;

    // Auto-add to timeline and close modal
    state.audioTracks.push({
        id: generateId(),
        file: null,
        name: `Kayıt-${recorderState.recordingCounter}`,
        audioBuffer: audioBuffer,
        duration: audioBuffer.duration,
        startOffset: 0,
        volume: 1.0,
    });

    saveState();
    updateEmptyState();
    renderTimeline();
    renderFrame();
    _closeRecorderModal(true);
}

// ============================================================
// Recording Timer
// ============================================================

let _recTimerInterval = null;

function _startRecordingTimer() {
    const timerEl = document.getElementById('recorder-timer');
    clearInterval(_recTimerInterval);
    _recTimerInterval = setInterval(() => {
        if (!recorderState.isRecording) {
            clearInterval(_recTimerInterval);
            return;
        }
        const elapsed = (performance.now() - recorderState.recordingStartTime) / 1000;
        timerEl.textContent = _fmtRecTime(elapsed);
    }, 100);
}

// ============================================================
// Edit Mode — open editor for an existing audio track
// ============================================================

function openAudioEditor(trackId) {
    const track = state.audioTracks.find(t => t.id === trackId);
    if (!track || !track.audioBuffer) return;

    recorderState.mode = 'edit';
    recorderState.editingTrackId = trackId;
    recorderState.editBuffer = track.audioBuffer;
    recorderState.undoStack = [];
    recorderState.selection = null;
    recorderState.peaksCache = computePeaks(track.audioBuffer, 4000);

    const modal = document.getElementById('recorder-modal');
    modal.classList.remove('hidden');
    updateRecorderUI();

    requestAnimationFrame(() => {
        _sizeRecorderCanvas();
        drawWaveform();
    });
}

function saveEditsToTrack() {
    if (!recorderState.editBuffer || !recorderState.editingTrackId) return;

    const track = state.audioTracks.find(t => t.id === recorderState.editingTrackId);
    if (!track) return;

    track.audioBuffer = recorderState.editBuffer;
    track.duration = recorderState.editBuffer.duration;

    saveState();
    renderTimeline();
    updateTimeDisplay();

    _resetEditorState();
    _closeRecorderModal(true);
}

function _resetEditorState() {
    recorderState.editBuffer = null;
    recorderState.undoStack = [];
    recorderState.selection = null;
    recorderState.peaksCache = null;
    recorderState.editingTrackId = null;
    recorderState.mode = null;
}

// ============================================================
// Waveform Rendering
// ============================================================

function computePeaks(buffer, numPoints) {
    const data = buffer.getChannelData(0);
    const peaks = new Float32Array(numPoints * 2);
    const samplesPerPoint = Math.max(1, Math.floor(data.length / numPoints));

    for (let i = 0; i < numPoints; i++) {
        const start = i * samplesPerPoint;
        const end = Math.min(start + samplesPerPoint, data.length);
        let min = 0, max = 0;
        for (let j = start; j < end; j++) {
            if (data[j] < min) min = data[j];
            if (data[j] > max) max = data[j];
        }
        peaks[i * 2] = min;
        peaks[i * 2 + 1] = max;
    }
    return peaks;
}

function _sizeRecorderCanvas() {
    const canvas = document.getElementById('recorder-waveform');
    if (!canvas) return;
    const container = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = container.clientWidth * dpr;
    canvas.height = container.clientHeight * dpr;
}

function drawWaveform() {
    const canvas = document.getElementById('recorder-waveform');
    if (!canvas || !recorderState.editBuffer || !recorderState.peaksCache) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const peaks = recorderState.peaksCache;
    const numPoints = peaks.length / 2;
    const duration = recorderState.editBuffer.duration;

    // Background
    ctx.fillStyle = '#0d1b36';
    ctx.fillRect(0, 0, width, height);

    // Selection highlight
    if (recorderState.selection) {
        const x1 = (recorderState.selection.start / duration) * width;
        const x2 = (recorderState.selection.end / duration) * width;
        ctx.fillStyle = 'rgba(233, 69, 96, 0.2)';
        ctx.fillRect(x1, 0, x2 - x1, height);
        ctx.strokeStyle = '#e94560';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x1, 0); ctx.lineTo(x1, height);
        ctx.moveTo(x2, 0); ctx.lineTo(x2, height);
        ctx.stroke();
    }

    // Waveform
    const mid = height / 2;
    ctx.strokeStyle = '#6a3ea1';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < numPoints; i++) {
        const x = (i / numPoints) * width;
        const minVal = peaks[i * 2];
        const maxVal = peaks[i * 2 + 1];
        ctx.moveTo(x, mid + minVal * mid);
        ctx.lineTo(x, mid - maxVal * mid);
    }
    ctx.stroke();

    // Center line
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();

    // Playback position
    if (recorderState.isPlaying && recorderState.playbackCtx) {
        const elapsed = recorderState.playbackCtx.currentTime - recorderState.playbackStartTime;
        const pos = recorderState.playbackStartOffset + elapsed;
        const x = (pos / duration) * width;
        ctx.strokeStyle = '#e94560';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
    }

    // Time labels
    const dpr = window.devicePixelRatio || 1;
    ctx.fillStyle = '#888';
    ctx.font = `${11 * dpr}px -apple-system, sans-serif`;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText(_fmtRecTime(0), 4 * dpr, height - 4 * dpr);
    ctx.textAlign = 'right';
    ctx.fillText(_fmtRecTime(duration), width - 4 * dpr, height - 4 * dpr);
}

function _fmtRecTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 10);
    return `${m}:${String(s).padStart(2, '0')}.${ms}`;
}

// ============================================================
// Waveform Selection Interaction
// ============================================================

function _setupWaveformInteraction(canvas) {
    let isDragging = false;

    canvas.addEventListener('mousedown', (e) => {
        if (!recorderState.editBuffer) return;
        isDragging = true;
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const time = x * recorderState.editBuffer.duration;
        recorderState.selection = { start: time, end: time };
        drawWaveform();
        _updateEditButtons();
    });

    canvas.addEventListener('mousemove', (e) => {
        if (!isDragging || !recorderState.selection) return;
        const rect = canvas.getBoundingClientRect();
        const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const time = x * recorderState.editBuffer.duration;
        recorderState.selection.end = time;
        drawWaveform();
    });

    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        if (recorderState.selection) {
            const { start, end } = recorderState.selection;
            if (start > end) {
                recorderState.selection = { start: end, end: start };
            }
            if (Math.abs(recorderState.selection.end - recorderState.selection.start) < 0.05) {
                recorderState.selection = null;
            }
            drawWaveform();
            _updateEditButtons();
        }
    });
}

// ============================================================
// Editing Operations
// ============================================================

function _getBufferByteSize(buffer) {
    return buffer.length * buffer.numberOfChannels * 4;
}

function _pushUndo() {
    recorderState.undoStack.push(recorderState.editBuffer);
    let totalBytes = recorderState.undoStack.reduce((sum, b) => sum + _getBufferByteSize(b), 0);
    while (totalBytes > UNDO_MAX_BYTES && recorderState.undoStack.length > 1) {
        const removed = recorderState.undoStack.shift();
        totalBytes -= _getBufferByteSize(removed);
    }
}

function trimToSelection() {
    const sel = recorderState.selection;
    if (!sel || !recorderState.editBuffer) return;
    _pushUndo();

    const buffer = recorderState.editBuffer;
    const sr = buffer.sampleRate;
    const startSample = Math.floor(sel.start * sr);
    const endSample = Math.min(Math.floor(sel.end * sr), buffer.length);
    const length = endSample - startSample;
    if (length <= 0) return;

    const newBuf = new AudioBuffer({
        length,
        sampleRate: sr,
        numberOfChannels: buffer.numberOfChannels,
    });
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        newBuf.copyToChannel(
            buffer.getChannelData(ch).subarray(startSample, endSample), ch
        );
    }

    recorderState.editBuffer = newBuf;
    recorderState.selection = null;
    recorderState.peaksCache = computePeaks(newBuf, 4000);
    drawWaveform();
    _updateEditButtons();
}

function cutSelection() {
    const sel = recorderState.selection;
    if (!sel || !recorderState.editBuffer) return;
    _pushUndo();

    const buffer = recorderState.editBuffer;
    const sr = buffer.sampleRate;
    const s = Math.floor(sel.start * sr);
    const e = Math.min(Math.floor(sel.end * sr), buffer.length);
    const newLen = buffer.length - (e - s);
    if (newLen <= 0) return;

    const newBuf = new AudioBuffer({
        length: newLen,
        sampleRate: sr,
        numberOfChannels: buffer.numberOfChannels,
    });
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const data = buffer.getChannelData(ch);
        const out = newBuf.getChannelData(ch);
        out.set(data.subarray(0, s));
        out.set(data.subarray(e), s);
    }

    recorderState.editBuffer = newBuf;
    recorderState.selection = null;
    recorderState.peaksCache = computePeaks(newBuf, 4000);
    drawWaveform();
    _updateEditButtons();
}

function undoEdit() {
    if (recorderState.undoStack.length === 0) return;
    recorderState.editBuffer = recorderState.undoStack.pop();
    recorderState.selection = null;
    recorderState.peaksCache = computePeaks(recorderState.editBuffer, 4000);
    drawWaveform();
    _updateEditButtons();
}

// ============================================================
// Editor Playback
// ============================================================

function playEditorAudio(startSec, endSec) {
    stopEditorAudio();
    if (!recorderState.editBuffer) return;

    recorderState.playbackCtx = new AudioContext();
    recorderState.playbackSource = recorderState.playbackCtx.createBufferSource();
    recorderState.playbackSource.buffer = recorderState.editBuffer;
    recorderState.playbackSource.connect(recorderState.playbackCtx.destination);

    const duration = endSec !== undefined ? (endSec - startSec) : undefined;
    recorderState.playbackSource.start(0, startSec, duration);
    recorderState.playbackStartTime = recorderState.playbackCtx.currentTime;
    recorderState.playbackStartOffset = startSec;
    recorderState.isPlaying = true;

    recorderState.playbackSource.onended = () => {
        recorderState.isPlaying = false;
        drawWaveform();
    };

    function animatePlayhead() {
        if (!recorderState.isPlaying) return;
        drawWaveform();
        recorderState.playbackAnimFrame = requestAnimationFrame(animatePlayhead);
    }
    recorderState.playbackAnimFrame = requestAnimationFrame(animatePlayhead);
}

function stopEditorAudio() {
    if (recorderState.playbackSource) {
        try { recorderState.playbackSource.stop(); } catch (e) {}
    }
    if (recorderState.playbackCtx) {
        recorderState.playbackCtx.close().catch(() => {});
    }
    if (recorderState.playbackAnimFrame) {
        cancelAnimationFrame(recorderState.playbackAnimFrame);
    }
    recorderState.isPlaying = false;
    recorderState.playbackSource = null;
    recorderState.playbackCtx = null;
}

// ============================================================
// Modal Management
// ============================================================

function _openRecordModal() {
    _resetEditorState();
    recorderState.mode = 'record'; // must be set AFTER _resetEditorState which clears mode
    const modal = document.getElementById('recorder-modal');
    modal.classList.remove('hidden');
    updateRecorderUI();
}

function _closeRecorderModal(force) {
    if (!force && recorderState.mode === 'edit' && recorderState.editBuffer) {
        if (!confirm('Kaydedilmemiş değişiklikleriniz var. Kapatmak istediğinize emin misiniz?')) {
            return;
        }
    }
    if (recorderState.isRecording) {
        // Stop recording without saving if modal is force-closed
        recorderState.isRecording = false;
        if (recorderState.scriptProcessor) {
            recorderState.scriptProcessor.disconnect();
            recorderState.scriptProcessor.onaudioprocess = null;
            recorderState.scriptProcessor = null;
        }
        if (recorderState.mediaStream) {
            recorderState.mediaStream.getTracks().forEach(t => t.stop());
        }
        if (recorderState.audioContext) {
            recorderState.audioContext.close().catch(() => {});
        }
        recorderState.chunks = [];
    }
    stopEditorAudio();
    _resetEditorState();
    document.getElementById('recorder-modal').classList.add('hidden');
}

// ============================================================
// UI State Management
// ============================================================

function updateRecorderUI() {
    const stateA = document.getElementById('recorder-state-a');
    const stateB = document.getElementById('recorder-state-b');
    const stateC = document.getElementById('recorder-state-c');
    const saveBtn = document.getElementById('recorder-save-btn');
    const modalTitle = document.querySelector('#recorder-modal .modal-content > h3');

    const isEditing = recorderState.mode === 'edit' && recorderState.editBuffer !== null;
    const isRecordMode = recorderState.mode === 'record';

    // Show/hide states
    if (stateA) stateA.classList.toggle('hidden', recorderState.isRecording || isEditing || !isRecordMode);
    if (stateB) stateB.classList.toggle('hidden', !recorderState.isRecording);
    if (stateC) stateC.classList.toggle('hidden', !isEditing);
    if (saveBtn) saveBtn.disabled = !isEditing;

    // Update modal title
    if (modalTitle) {
        modalTitle.textContent = isEditing ? 'Ses Düzenleyici' : 'Ses Kaydedici';
    }

    _updateEditButtons();
}

function _updateEditButtons() {
    const hasSel = recorderState.selection !== null;
    const hasUndo = recorderState.undoStack.length > 0;

    const trimBtn = document.getElementById('recorder-trim-btn');
    const cutBtn = document.getElementById('recorder-cut-btn');
    const playSelBtn = document.getElementById('recorder-play-sel-btn');
    const undoBtn = document.getElementById('recorder-undo-btn');

    if (trimBtn) trimBtn.disabled = !hasSel;
    if (cutBtn) cutBtn.disabled = !hasSel;
    if (playSelBtn) playSelBtn.disabled = !hasSel;
    if (undoBtn) undoBtn.disabled = !hasUndo;
}

// ============================================================
// Setup (called from app.js init)
// ============================================================

function setupRecorderUI() {
    const openBtn = document.getElementById('record-btn');
    if (!openBtn) return;

    // Record button opens in record mode
    openBtn.addEventListener('click', _openRecordModal);

    // Modal controls
    document.getElementById('recorder-close-btn').addEventListener('click', () => _closeRecorderModal(false));
    document.getElementById('recorder-record-btn').addEventListener('click', startRecording);
    document.getElementById('recorder-stop-btn').addEventListener('click', stopRecording);

    // Editor controls
    document.getElementById('recorder-play-btn').addEventListener('click', () => playEditorAudio(0));
    document.getElementById('recorder-play-sel-btn').addEventListener('click', () => {
        if (recorderState.selection) {
            playEditorAudio(recorderState.selection.start, recorderState.selection.end);
        }
    });
    document.getElementById('recorder-stop-play-btn').addEventListener('click', stopEditorAudio);
    document.getElementById('recorder-trim-btn').addEventListener('click', trimToSelection);
    document.getElementById('recorder-cut-btn').addEventListener('click', cutSelection);
    document.getElementById('recorder-undo-btn').addEventListener('click', undoEdit);
    document.getElementById('recorder-save-btn').addEventListener('click', saveEditsToTrack);

    _setupWaveformInteraction(document.getElementById('recorder-waveform'));

    // Handle window resize
    window.addEventListener('resize', () => {
        if (!document.getElementById('recorder-modal').classList.contains('hidden')) {
            _sizeRecorderCanvas();
            if (recorderState.editBuffer) drawWaveform();
        }
    });
}
