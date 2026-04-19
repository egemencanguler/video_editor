# Audio Recorder + Editor + State Persistence — Detailed Implementation Plan

## Overview

Add two major features to the video editor:
1. **In-app audio recorder with waveform editor** — record from microphone, trim/cut, then add to timeline
2. **State persistence** — save/restore all project state across browser sessions via IndexedDB + localStorage

Both features are additive. Existing drag-drop file import is untouched.

---

## Current Codebase State

| File | Lines | Purpose |
|------|-------|---------|
| `app.js` | 1523 | All app logic: state, timeline, playback, export, overlay |
| `styles.css` | 912 | Dark theme, layout, timeline, modals, overlay modal |
| `index.html` | 305 | HTML structure, modals, script tags |
| `logo.js` | 1 (large) | Base64-encoded logo data URL |
| `audio-recorder-worklet.js` | — | **TO CREATE** |
| `audio-recorder.js` | — | **TO CREATE** |
| `state-persistence.js` | — | **TO CREATE** |

### Existing Audio Data Model (app.js line 246-254)
```js
// Each audio track in state.audioTracks:
{
    id: string,              // from generateId()
    file: File | null,       // original File object (null for recordings)
    name: string,            // display name
    audioBuffer: AudioBuffer, // Web Audio API decoded buffer
    duration: number,         // seconds (from audioBuffer.duration)
    startOffset: number,      // where on timeline (seconds, default 0)
    volume: number,           // 0.0–1.0 (default 1.0)
}
```

### Existing Image Clip Data Model (app.js line 219-230)
```js
{
    id: string,
    file: File,
    name: string,
    image: HTMLImageElement,
    naturalWidth: number,
    naturalHeight: number,
    duration: number,          // seconds (default 3.0)
    scaleMode: string,         // 'fit' | 'fill' | 'stretch' | etc.
    customScale: number,       // 0.0–3.0
    thumbnailDataUrl: string,  // base64 thumbnail for timeline
}
```

### Key Global Functions Available (app.js)
- `generateId()` — returns unique ID string (line 1496)
- `renderTimeline()` — rebuilds timeline UI (line 268)
- `renderFrame()` — re-renders preview canvas (line 693)
- `updateEmptyState()` — shows/hides empty state overlay (line 257)
- `updateTimeDisplay()` — updates time counter (line 1183)
- `getTotalDuration()` — returns sum of all clip durations (line 1503)

### Existing State Object (app.js lines 6-48)
```js
const state = {
    clips: [],
    audioTracks: [],
    selectedId: null,
    selectedType: null,
    resolution: { width: 1080, height: 1920 },
    fps: 30,
    isPlaying: false,
    playbackTime: 0,
    pixelsPerSecond: 80,
    overlay: {
        enabled: true,
        backgroundColor: '#000000',
        header: { gradientFrom, gradientTo, heightPercent },
        title: { text, color, fontFamily, sizePercent, bold },
        logo: { image, file },
        footer: { text, color, fontFamily, sizePercent, gradientFrom, gradientTo, heightPercent },
    },
};
```

---

## Part 1: Audio Recorder + Editor

### 1.1 New File: `audio-recorder-worklet.js` (~20 lines)

This runs on the audio thread. Collects raw PCM samples and posts them to the main thread.

```js
class RecorderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._active = true;
        this.port.onmessage = (e) => {
            if (e.data === 'stop') this._active = false;
        };
    }

    process(inputs) {
        if (!this._active) return false;
        const input = inputs[0];
        if (input && input.length > 0) {
            // Copy each channel's Float32Array and send to main thread
            const channels = [];
            for (let ch = 0; ch < input.length; ch++) {
                channels.push(new Float32Array(input[ch]));
            }
            this.port.postMessage({ channels });
        }
        return true; // keep processor alive
    }
}

registerProcessor('recorder-processor', RecorderProcessor);
```

**Edge cases to handle**:
- The processor must return `true` to stay alive; returning `false` terminates it
- Each `input[ch]` is typically 128 samples at 48kHz (2.67ms per call)
- We must copy the Float32Array because the underlying buffer is reused by the audio thread

### 1.2 New File: `audio-recorder.js` (~500 lines)

#### 1.2.1 Recorder State

```js
const recorderState = {
    // Recording
    isRecording: false,
    mediaStream: null,        // from getUserMedia
    audioContext: null,        // AudioContext for recording
    workletNode: null,         // AudioWorkletNode
    chunks: [],               // Array of { channels: Float32Array[] }
    recordingStartTime: 0,    // performance.now() when recording started
    recordingCounter: 0,      // increments for naming: Kayıt-1, Kayıt-2, ...
                              // IMPORTANT: derive next index from existing track names on restore,
                              // not from a stored counter. Scan state.audioTracks for names matching
                              // /^Kayıt-(\d+)$/ and set counter = max(found) + 1. This avoids
                              // duplicate names after reload.

    // Editor
    rawBuffer: null,          // AudioBuffer — original recording
    editBuffer: null,         // AudioBuffer — current edited version
    undoStack: [],            // AudioBuffer[] — previous states (max 20)
    selection: null,          // { start: number, end: number } in seconds, or null
    peaksCache: null,         // Float32Array — pre-computed waveform peaks

    // Playback (within editor)
    isPlaying: false,
    playbackSource: null,     // AudioBufferSourceNode
    playbackCtx: null,        // AudioContext for editor playback
    playbackStartTime: 0,     // AudioContext.currentTime when started
    playbackStartOffset: 0,   // offset in buffer seconds
    playbackAnimFrame: null,  // requestAnimationFrame ID
};
```

#### 1.2.2 Recording Functions

```js
async function startRecording() {
    // 1. Request mic permission
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

    // 2. Create AudioContext and register worklet
    recorderState.audioContext = new AudioContext({ sampleRate: 48000 });
    await recorderState.audioContext.audioWorklet.addModule('audio-recorder-worklet.js');

    // 3. Connect: mic → worklet
    const source = recorderState.audioContext.createMediaStreamSource(recorderState.mediaStream);
    recorderState.workletNode = new AudioWorkletNode(recorderState.audioContext, 'recorder-processor');

    recorderState.workletNode.port.onmessage = (e) => {
        recorderState.chunks.push(e.data);
    };

    source.connect(recorderState.workletNode);
    // Don't connect to destination (no feedback loop)

    // 4. Reset state
    recorderState.chunks = [];
    recorderState.isRecording = true;
    recorderState.recordingStartTime = performance.now();

    // 5. Update UI → show recording indicator, start timer
    updateRecorderUI();
    startRecordingTimer();
}

function stopRecording() {
    if (!recorderState.isRecording) return;
    recorderState.isRecording = false;

    // 1. Tell worklet to stop
    recorderState.workletNode.port.postMessage('stop');

    // 2. Stop all mic tracks
    recorderState.mediaStream.getTracks().forEach(t => t.stop());

    // 3. Close audio context
    recorderState.audioContext.close();

    // 4. Assemble chunks into AudioBuffer
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

    // 5. Set as raw and edit buffer
    recorderState.rawBuffer = audioBuffer;
    recorderState.editBuffer = audioBuffer;
    recorderState.undoStack = [];
    recorderState.selection = null;
    recorderState.chunks = []; // free memory
    recorderState.recordingCounter++;

    // 6. Compute waveform peaks and render
    recorderState.peaksCache = computePeaks(audioBuffer, 4000);
    drawWaveform();
    updateRecorderUI();
}
```

**Edge cases**:
- User may deny mic permission → catch and show Turkish error message
- Recording of 0 samples (instant stop) → don't create buffer, stay in record-ready state
- User closes the modal during recording → must stop recording first (handled by close-confirmation dialog)
- Multiple channels → mic is usually mono, but handle stereo just in case

#### 1.2.3 Waveform Rendering

```js
function computePeaks(buffer, numPoints) {
    // Returns Float32Array of [min0, max0, min1, max1, ...] pairs
    const data = buffer.getChannelData(0); // use first channel
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

function drawWaveform() {
    const canvas = document.getElementById('recorder-waveform');
    if (!canvas || !recorderState.editBuffer) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const peaks = recorderState.peaksCache;
    const numPoints = peaks.length / 2;

    // Background
    ctx.fillStyle = '#0d1b36';
    ctx.fillRect(0, 0, width, height);

    // Selection highlight
    if (recorderState.selection) {
        const duration = recorderState.editBuffer.duration;
        const x1 = (recorderState.selection.start / duration) * width;
        const x2 = (recorderState.selection.end / duration) * width;
        ctx.fillStyle = 'rgba(233, 69, 96, 0.2)';
        ctx.fillRect(x1, 0, x2 - x1, height);
        // Selection edges
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
        const min = peaks[i * 2];
        const max = peaks[i * 2 + 1];
        ctx.moveTo(x, mid + min * mid);
        ctx.lineTo(x, mid - max * mid); // note: canvas Y is inverted
    }
    ctx.stroke();

    // Center line
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();

    // Playback position indicator
    if (recorderState.isPlaying) {
        const elapsed = recorderState.playbackCtx.currentTime - recorderState.playbackStartTime;
        const pos = recorderState.playbackStartOffset + elapsed;
        const duration = recorderState.editBuffer.duration;
        const x = (pos / duration) * width;
        ctx.strokeStyle = '#e94560';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
    }

    // Time labels
    const duration = recorderState.editBuffer.duration;
    ctx.fillStyle = '#888';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText(formatRecorderTime(0), 4, height - 4);
    ctx.textAlign = 'right';
    ctx.fillText(formatRecorderTime(duration), width - 4, height - 4);
}

function formatRecorderTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 10);
    return `${m}:${String(s).padStart(2, '0')}.${ms}`;
}
```

**Canvas sizing**: Set `canvas.width` and `canvas.height` from the CSS-rendered size on modal open to avoid blurriness. Use `canvas.width = canvas.clientWidth * devicePixelRatio`.

#### 1.2.4 Selection Interaction

```js
function setupWaveformInteraction(canvas) {
    let isDragging = false;

    canvas.addEventListener('mousedown', (e) => {
        if (!recorderState.editBuffer) return;
        isDragging = true;
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const time = x * recorderState.editBuffer.duration;
        recorderState.selection = { start: time, end: time };
        drawWaveform();
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
        // Normalize: ensure start < end
        if (recorderState.selection) {
            const { start, end } = recorderState.selection;
            if (start > end) {
                recorderState.selection = { start: end, end: start };
            }
            // If selection is tiny (< 0.05s), treat as deselect
            if (Math.abs(recorderState.selection.end - recorderState.selection.start) < 0.05) {
                recorderState.selection = null;
            }
            drawWaveform();
        }
    });
}
```

**Edge cases**:
- User drags left-to-right or right-to-left → normalize start/end on mouseup
- Tiny accidental click → treat as deselect (threshold: 0.05s)
- Mouse released outside the canvas → document-level mouseup handler catches it

#### 1.2.5 Editing Operations

```js
const UNDO_MAX_BYTES = 100 * 1024 * 1024; // 100MB cap for undo stack

function getBufferByteSize(buffer) {
    return buffer.length * buffer.numberOfChannels * 4; // Float32 = 4 bytes/sample
}

function pushUndo() {
    recorderState.undoStack.push(recorderState.editBuffer);
    // Cap by total memory, not count — prevents OOM on long recordings
    let totalBytes = recorderState.undoStack.reduce((sum, b) => sum + getBufferByteSize(b), 0);
    while (totalBytes > UNDO_MAX_BYTES && recorderState.undoStack.length > 1) {
        const removed = recorderState.undoStack.shift();
        totalBytes -= getBufferByteSize(removed);
    }
}

function trimToSelection() {
    const sel = recorderState.selection;
    if (!sel || !recorderState.editBuffer) return;
    pushUndo();

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
            buffer.getChannelData(ch).subarray(startSample, endSample),
            ch
        );
    }

    recorderState.editBuffer = newBuf;
    recorderState.selection = null;
    recorderState.peaksCache = computePeaks(newBuf, 4000);
    drawWaveform();
}

function cutSelection() {
    const sel = recorderState.selection;
    if (!sel || !recorderState.editBuffer) return;
    pushUndo();

    const buffer = recorderState.editBuffer;
    const sr = buffer.sampleRate;
    const s = Math.floor(sel.start * sr);
    const e = Math.min(Math.floor(sel.end * sr), buffer.length);
    const newLen = buffer.length - (e - s);

    if (newLen <= 0) return; // don't allow cutting everything

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
}

function undoEdit() {
    if (recorderState.undoStack.length === 0) return;
    recorderState.editBuffer = recorderState.undoStack.pop();
    recorderState.selection = null;
    recorderState.peaksCache = computePeaks(recorderState.editBuffer, 4000);
    drawWaveform();
}
```

**Edge cases**:
- Trim with no selection → no-op
- Cut that would result in 0-length buffer → no-op, prevent
- Undo stack capped at 20 (each AudioBuffer at 48kHz mono for 60s ≈ 11.5MB, so 20 × ~12MB = ~240MB max — acceptable)
- After any edit: clear selection, recompute peaks

#### 1.2.6 Editor Playback

```js
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

    // Animate playhead
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

// Button handlers:
// "Oynat" → playEditorAudio(0)
// "Seçimi Oynat" → playEditorAudio(selection.start, selection.end)
```

#### 1.2.7 Adding Recording to Timeline

```js
function addRecordingToTimeline() {
    if (!recorderState.editBuffer) return;

    state.audioTracks.push({
        id: generateId(),
        file: null,  // no File object for recordings
        name: `Kayıt-${recorderState.recordingCounter}`,
        audioBuffer: recorderState.editBuffer,
        duration: recorderState.editBuffer.duration,
        startOffset: 0,
        volume: 1.0,
    });

    // Trigger save (persistence)
    saveState();

    // Reset recorder state (but keep counter)
    recorderState.rawBuffer = null;
    recorderState.editBuffer = null;
    recorderState.undoStack = [];
    recorderState.selection = null;
    recorderState.peaksCache = null;

    // Update main app
    updateEmptyState();
    renderTimeline();
    renderFrame();

    // Close modal
    closeRecorderModal();
}
```

#### 1.2.8 Safety: Confirmation Dialogs

```js
function closeRecorderModal() {
    // Check if there's an unsaved recording
    if (recorderState.editBuffer && !recorderState.isRecording) {
        if (!confirm('Kaydedilmemiş ses kaydınız var. Kapatmak istediğinize emin misiniz?')) {
            return;
        }
    }
    // Stop any active recording
    if (recorderState.isRecording) {
        stopRecording();
    }
    stopEditorAudio();
    // Hide modal
    document.getElementById('recorder-modal').classList.add('hidden');
}

function reRecord() {
    if (recorderState.editBuffer) {
        if (!confirm('Mevcut kaydı silmek istediğinize emin misiniz?')) {
            return;
        }
    }
    stopEditorAudio();
    recorderState.rawBuffer = null;
    recorderState.editBuffer = null;
    recorderState.undoStack = [];
    recorderState.selection = null;
    recorderState.peaksCache = null;
    updateRecorderUI();
}
```

#### 1.2.9 UI State Management

```js
function updateRecorderUI() {
    const stateA = document.getElementById('recorder-state-a'); // initial: record button
    const stateB = document.getElementById('recorder-state-b'); // recording active
    const stateC = document.getElementById('recorder-state-c'); // editor

    stateA.classList.toggle('hidden', recorderState.isRecording || recorderState.editBuffer !== null);
    stateB.classList.toggle('hidden', !recorderState.isRecording);
    stateC.classList.toggle('hidden', recorderState.isRecording || recorderState.editBuffer === null);

    // Update undo button disabled state
    const undoBtn = document.getElementById('recorder-undo-btn');
    if (undoBtn) undoBtn.disabled = recorderState.undoStack.length === 0;

    // Update trim/cut button disabled states (need a selection)
    const hasSel = recorderState.selection !== null;
    const trimBtn = document.getElementById('recorder-trim-btn');
    const cutBtn = document.getElementById('recorder-cut-btn');
    const playSelBtn = document.getElementById('recorder-play-sel-btn');
    if (trimBtn) trimBtn.disabled = !hasSel;
    if (cutBtn) cutBtn.disabled = !hasSel;
    if (playSelBtn) playSelBtn.disabled = !hasSel;
}
```

#### 1.2.10 Recording Timer

```js
let recordingTimerInterval = null;

function startRecordingTimer() {
    const timerEl = document.getElementById('recorder-timer');
    recordingTimerInterval = setInterval(() => {
        if (!recorderState.isRecording) {
            clearInterval(recordingTimerInterval);
            return;
        }
        const elapsed = (performance.now() - recorderState.recordingStartTime) / 1000;
        timerEl.textContent = formatRecorderTime(elapsed);
    }, 100);
}
```

#### 1.2.11 Setup Function (called from app.js init)

```js
function setupRecorderUI() {
    const openBtn = document.getElementById('record-btn');
    if (!openBtn) return;

    openBtn.addEventListener('click', () => {
        document.getElementById('recorder-modal').classList.remove('hidden');
        // Size canvas to container
        const canvas = document.getElementById('recorder-waveform');
        const container = canvas.parentElement;
        canvas.width = container.clientWidth * (window.devicePixelRatio || 1);
        canvas.height = container.clientHeight * (window.devicePixelRatio || 1);
        updateRecorderUI();
        if (recorderState.editBuffer) drawWaveform();
    });

    document.getElementById('recorder-close-btn').addEventListener('click', closeRecorderModal);
    document.getElementById('recorder-record-btn').addEventListener('click', startRecording);
    document.getElementById('recorder-stop-btn').addEventListener('click', stopRecording);
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
    document.getElementById('recorder-rerecord-btn').addEventListener('click', reRecord);
    document.getElementById('recorder-add-btn').addEventListener('click', addRecordingToTimeline);

    setupWaveformInteraction(document.getElementById('recorder-waveform'));
}
```

### 1.3 HTML Changes (index.html)

#### Transport bar — add "Ses Kaydet" button (after line 81):
```html
<div class="transport-right">
    <button id="record-btn" class="btn-secondary btn-record">&#9679; Ses Kaydet</button>
    <button id="add-files-btn" class="btn-secondary">+ Dosya Ekle</button>
    <input type="file" id="file-input" multiple accept="..." hidden>
</div>
```

#### Recorder modal (add after the overlay modal, ~line 270):
```html
<div class="modal-overlay hidden" id="recorder-modal">
    <div class="modal-content modal-recorder">
        <h3>Ses Kaydedici</h3>

        <!-- State A: Ready to record -->
        <div id="recorder-state-a" class="recorder-state">
            <div class="recorder-big-btn-wrap">
                <button id="recorder-record-btn" class="recorder-big-btn">&#9679;</button>
                <p>Kaydetmek için tıklayın</p>
            </div>
        </div>

        <!-- State B: Recording active -->
        <div id="recorder-state-b" class="recorder-state hidden">
            <div class="recording-indicator">
                <span class="recording-dot"></span>
                <span>Kaydediliyor...</span>
                <span id="recorder-timer" class="recorder-timer">0:00.0</span>
            </div>
            <button id="recorder-stop-btn" class="btn-danger recorder-stop-btn">&#9632; Durdur</button>
        </div>

        <!-- State C: Editor -->
        <div id="recorder-state-c" class="recorder-state hidden">
            <div class="recorder-toolbar">
                <button id="recorder-play-btn" class="btn-secondary">&#9654; Oynat</button>
                <button id="recorder-play-sel-btn" class="btn-secondary" disabled>&#9654; Seçimi Oynat</button>
                <button id="recorder-stop-play-btn" class="btn-secondary">&#9632;</button>
                <span class="recorder-divider"></span>
                <button id="recorder-trim-btn" class="btn-secondary" disabled>Kırp</button>
                <button id="recorder-cut-btn" class="btn-secondary" disabled>Kes</button>
                <button id="recorder-undo-btn" class="btn-secondary" disabled>&#8617; Geri Al</button>
                <span class="recorder-divider"></span>
                <button id="recorder-rerecord-btn" class="btn-secondary btn-record-sm">&#9679; Yeniden Kaydet</button>
            </div>
            <div class="recorder-waveform-container">
                <canvas id="recorder-waveform"></canvas>
            </div>
        </div>

        <!-- Footer buttons -->
        <div class="recorder-footer">
            <button id="recorder-close-btn" class="btn-secondary">Kapat</button>
            <button id="recorder-add-btn" class="btn-primary" disabled>Zaman Çizelgesine Ekle</button>
        </div>
    </div>
</div>
```

#### Script tags (before `</body>`):
```html
<script src="logo.js"></script>
<script src="state-persistence.js"></script>
<script src="audio-recorder.js"></script>
<script src="app.js"></script>
```

**Note**: `state-persistence.js` must load BEFORE `app.js` because `init()` in app.js calls `restoreState()`. `audio-recorder.js` can load before or after app.js since both use global scope.

### 1.4 CSS Changes (styles.css)

```css
/* === Recorder === */
.btn-record {
    color: #e94560;
}

.btn-record-sm {
    color: #e94560;
    font-size: 12px;
}

.modal-recorder {
    max-width: 700px !important;
    width: 95% !important;
    text-align: center !important;
    max-height: 90vh;
    overflow-y: auto;
}

.recorder-state {
    padding: 20px 0;
}

/* Big record button (State A) */
.recorder-big-btn-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 40px 0;
}

.recorder-big-btn-wrap p {
    color: #888;
    font-size: 14px;
}

.recorder-big-btn {
    width: 80px;
    height: 80px;
    border-radius: 50%;
    background: #c0392b;
    border: 4px solid #e94560;
    color: #fff;
    font-size: 36px;
    cursor: pointer;
    transition: transform 0.2s, box-shadow 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
}

.recorder-big-btn:hover {
    transform: scale(1.1);
    box-shadow: 0 0 20px rgba(233, 69, 96, 0.5);
}

/* Recording indicator (State B) */
.recording-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 20px;
    font-size: 16px;
    color: #eee;
}

.recording-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #e94560;
    animation: pulse 1s ease-in-out infinite;
}

@keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.8); }
}

.recorder-timer {
    font-variant-numeric: tabular-nums;
    font-size: 24px;
    font-weight: 600;
    color: #e94560;
}

.recorder-stop-btn {
    padding: 12px 32px;
    font-size: 16px;
}

/* Editor toolbar (State C) */
.recorder-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 0;
    flex-wrap: wrap;
    justify-content: center;
}

.recorder-divider {
    width: 1px;
    height: 24px;
    background: #333;
    margin: 0 4px;
}

.recorder-toolbar button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

/* Waveform canvas */
.recorder-waveform-container {
    background: #0d1b36;
    border: 1px solid #533483;
    border-radius: 8px;
    overflow: hidden;
    margin: 12px 0;
    height: 180px;
    cursor: crosshair;
}

.recorder-waveform-container canvas {
    width: 100%;
    height: 100%;
    display: block;
}

/* Footer */
.recorder-footer {
    display: flex;
    justify-content: space-between;
    padding: 12px 0 0;
    border-top: 1px solid #0f3460;
    margin-top: 8px;
}
```

### 1.5 app.js Changes

One line added to `init()` (after `setupOverlayUI()`):
```js
setupRecorderUI();  // from audio-recorder.js
```

And one change: wire up the `beforeunload` handler (can go in app.js init or in state-persistence.js):
```js
window.addEventListener('beforeunload', (e) => {
    if (state.clips.length > 0 || state.audioTracks.length > 0) {
        e.preventDefault();
        e.returnValue = '';
    }
});
```

---

## Part 2: State Persistence

### 2.1 New File: `state-persistence.js` (~200 lines)

#### 2.1.1 IndexedDB Setup

```js
const DB_NAME = 'VideoEditorDB';
const DB_VERSION = 1;
const MEDIA_STORE = 'mediaFiles';

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
```

#### 2.1.2 Save State

```js
let saveDebounceTimer = null;

function saveState() {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(async () => {
        try {
            await saveStateNow();
        } catch (e) {
            console.error('Failed to save state:', e);
        }
    }, 500); // debounce 500ms
}

async function saveStateNow() {
    const db = await openDB();

    // 1. Save metadata to localStorage
    const metadata = {
        version: 1, // Schema version — bump on breaking changes, reject mismatches in restore
        pixelsPerSecond: state.pixelsPerSecond, // preserve timeline zoom level
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
            isRecording: t.file === null, // flag to distinguish recordings from files
        })),
        resolution: state.resolution,
        fps: state.fps,
        overlay: {
            enabled: state.overlay.enabled,
            backgroundColor: state.overlay.backgroundColor,
            header: { ...state.overlay.header },
            title: { ...state.overlay.title },
            footer: { ...state.overlay.footer },
            // logo.image is stored in IndexedDB, not here
        },
    };
    localStorage.setItem('videoEditorState', JSON.stringify(metadata));

    // 2. Save binary data to IndexedDB
    const tx = db.transaction(MEDIA_STORE, 'readwrite');
    const store = tx.objectStore(MEDIA_STORE);

    // Clear old entries then write new ones
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
            // File-based audio
            store.put({
                id: track.id,
                type: 'audio-file',
                blob: track.file,
            });
        } else if (track.audioBuffer) {
            // Recording — store raw PCM data
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
                // length is derived from channelData[0].length — no need to store it
            });
        }
    }

    // Save overlay logo if it exists
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
```

#### 2.1.3 Restore State

```js
async function restoreState() {
    const json = localStorage.getItem('videoEditorState');
    if (!json) return; // no saved state, fresh session

    let metadata;
    try {
        metadata = JSON.parse(json);
    } catch (e) {
        console.error('Invalid saved state, starting fresh');
        localStorage.removeItem('videoEditorState');
        return;
    }

    // Schema version check — reject incompatible versions
    const CURRENT_VERSION = 1;
    if (metadata.version !== CURRENT_VERSION) {
        console.warn(`Saved state version ${metadata.version} != ${CURRENT_VERSION}, starting fresh`);
        localStorage.removeItem('videoEditorState');
        return;
    }

    let db;
    try {
        db = await openDB();
    } catch (e) {
        console.error('Failed to open IndexedDB:', e);
        return;
    }

    const tx = db.transaction(MEDIA_STORE, 'readonly');
    const store = tx.objectStore(MEDIA_STORE);

    // Helper: get item by ID
    function getItem(id) {
        return new Promise((resolve, reject) => {
            const req = store.get(id);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
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
        // Merge overlay settings (keep logo.image as null, loaded separately)
        Object.assign(state.overlay, metadata.overlay);
        state.overlay.logo = state.overlay.logo || { image: null, file: null };
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

    // Restore clips
    for (const clipMeta of (metadata.clips || [])) {
        try {
            const stored = await getItem(clipMeta.id);
            if (!stored || !stored.blob) continue;

            const file = stored.blob instanceof File ? stored.blob :
                new File([stored.blob], clipMeta.name, { type: stored.blob.type });
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
            const stored = await getItem(trackMeta.id);
            if (!stored) continue;

            let audioBuffer;
            let file = null;

            if (stored.type === 'audio-file') {
                // Decode the stored file blob
                file = stored.blob instanceof File ? stored.blob :
                    new File([stored.blob], trackMeta.name, { type: stored.blob.type });
                const ctx = new AudioContext();
                const arrayBuf = await file.arrayBuffer();
                audioBuffer = await ctx.decodeAudioData(arrayBuf);
                ctx.close();
            } else if (stored.type === 'audio-recording') {
                // Reconstruct AudioBuffer from raw PCM
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

    // Restore custom overlay logo (if user uploaded one)
    try {
        const logoData = await getItem('overlay-logo');
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

    db.close();

    // Derive recording counter from existing track names to prevent duplicates
    // Scans for names like "Kayıt-1", "Kayıt-2", etc. and sets counter to max + 1
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
```

#### 2.1.4 Clear Saved State

```js
async function clearSavedState() {
    localStorage.removeItem('videoEditorState');
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
```

### 2.2 Where to Call `saveState()` in app.js

Add `saveState()` after every state-mutating operation. Key locations:

| Location | Function | Line (approx) |
|----------|----------|---------------|
| After adding clips | `handleFiles()` | After `await Promise.all(promises)` |
| After deleting clip/track | `propDeleteBtn.click` handler | After `deselectAll()` |
| After reordering clips | `setupClipDrag` drop handler | After `state.clips.splice(...)` |
| After changing clip duration | `propDuration` input handler | After `clip.duration = ...` |
| After changing clip duration via resize handle | `setupResizeHandle` onUp | After `renderTimeline()` |
| After changing scale mode | `propScaleMode` change handler | After `clip.scaleMode = ...` |
| After changing custom scale | `propCustomScale` input handler | After `clip.customScale = ...` |
| After changing audio volume | `propVolume` input handler | After `track.volume = ...` |
| After changing resolution | `setResolution()` | After `state.resolution = ...` |
| After changing FPS | `fps-select` change handler | After `state.fps = ...` |
| After any overlay setting change | All overlay modal handlers | After each `state.overlay.* = ...` |
| After uploading custom logo | `#overlay-logo-file` change handler | After `state.overlay.logo.file = file` |

**Implementation approach**: Rather than modifying every handler individually, wrap `saveState()` into a single function that's called after `renderTimeline()` or `renderFrame()` — since those are always called after state changes. But this would save too frequently (e.g., during playback). Instead, add `saveState()` calls explicitly in the ~15 handlers listed above. The 500ms debounce prevents excessive writes.

### 2.3 app.js init() Changes

```js
async function init() {
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
    setupRecorderUI();         // NEW: from audio-recorder.js
    updateOverlayToggleBtn();
    loadDefaultLogo();

    await restoreState();      // NEW: from state-persistence.js (async!)

    renderFrame();
}
```

**Important changes to `init()` and related functions**:

1. `init()` must become `async` because `restoreState()` is async. The bottom-of-file call changes from `init()` to `init().catch(e => console.error('Init failed:', e))` to handle IndexedDB failures gracefully.

2. **Fix logo race condition**: `loadDefaultLogo()` and `restoreState()` can both set `state.overlay.logo.image`. Fix: `loadDefaultLogo()` must check before overwriting:
```js
function loadDefaultLogo() {
    const img = new Image();
    img.onload = () => {
        // Don't overwrite if restoreState already loaded a custom logo
        if (state.overlay.logo.image) return;
        state.overlay.logo.image = img;
        renderFrame();
    };
    img.src = (typeof window !== 'undefined' && window.LOGO_DATA_URL) || 'logo.png';
}
```

3. **Add saveState() to overlay logo upload handler** (~line 980 in app.js):
```js
$('#overlay-logo-file').addEventListener('change', async (e) => {
    // ... existing code ...
    state.overlay.logo.image = img;
    state.overlay.logo.file = file;
    renderFrame();
    saveState(); // <-- MISSING: add this
});
```

4. **Add QuotaExceededError handling** in `saveStateNow()`:
```js
} catch (e) {
    if (e.name === 'QuotaExceededError') {
        console.error('Storage quota exceeded');
        // Show visible warning to user
        alert('Depolama alanı dolu. Bazı veriler kaydedilemeyebilir.');
    } else {
        console.error('Failed to save state:', e);
    }
}
```

---

## Edge Cases & Potential Bugs to Review

1. **IndexedDB on private/incognito**: IndexedDB may be unavailable or limited in private browsing. `restoreState()` and `saveState()` should catch and fail silently — persistence is best-effort.

2. **Large recordings consuming memory**: A 10-minute 48kHz mono recording = ~57MB as Float32Array. Undo stack is now capped by total bytes (100MB), not count. This prevents OOM on long recordings while still allowing many undo steps for short ones.

3. **Race condition: loadDefaultLogo vs restoreState**: Both may try to set `state.overlay.logo.image`. Fix applied: `loadDefaultLogo()`'s `onload` checks `if (state.overlay.logo.image) return;` — user's custom logo (from IndexedDB) takes precedence over the default.

4. **Canvas DPI scaling**: The waveform canvas must set `width`/`height` attributes based on `clientWidth * devicePixelRatio` to look sharp on Retina displays. This must be done on modal open (not before, since the modal is `display: none` and has no dimensions).

5. **Structured clone limitations**: `store.put()` with `Float32Array` in an object works in IndexedDB because it supports structured clone. However, `AudioBuffer` itself is NOT structured-cloneable. That's why we extract channel data as plain `Float32Array` arrays before storing.

6. **File vs Blob in IndexedDB**: When restoring, `stored.blob` may come back as a `Blob` (not a `File`). The code handles this by wrapping in `new File([blob], name, { type })`.

7. **Save/restore ordering**: Clips and audio tracks must be restored in the same order they were saved (matching `metadata.clips` order). `store.clear()` + `store.put()` in order ensures this.

8. **beforeunload event**: Some browsers (Chrome) don't allow custom messages in `beforeunload`. The standard `e.preventDefault(); e.returnValue = '';` pattern shows the browser's default warning. Gate this on "has unsaved changes since last successful save" — not "has any content" — since once persistence works, the data is already safe.

9. **Mic already in use**: If another app/tab is using the microphone, `getUserMedia` may still succeed (browser handles sharing) or may fail. Always handle the rejection.

10. **IndexedDB quota exceeded**: `saveStateNow()` catches `QuotaExceededError` and shows a visible Turkish-language alert to the user. Don't silently swallow it.

11. **Schema versioning**: Saved state includes `version: 1`. On `restoreState()`, if `metadata.version !== CURRENT_VERSION`, discard saved state and start fresh. This prevents silent corruption from future schema changes.

12. **Recording counter derivation**: `recordingCounter` is NOT persisted. Instead, on restore, scan existing track names for `/^Kayıt-(\d+)$/` and set `counter = max(found)`. Avoids duplicate names.

13. **"Yeni Proje" (New Project) button**: Expose `clearSavedState()` via a UI button in the toolbar or Kaplama modal. Without this, users with corrupted state have no recovery path short of DevTools. Button calls `clearSavedState()` then `location.reload()`.

---

## Files Summary

| File | Action | Lines (est.) |
|------|--------|-------------|
| `audio-recorder-worklet.js` | Create | ~20 |
| `audio-recorder.js` | Create | ~450-500 |
| `state-persistence.js` | Create | ~200 |
| `index.html` | Edit | +60 lines (button + modal) |
| `styles.css` | Edit | +120 lines (recorder styles) |
| `app.js` | Edit | +20 lines (init changes + saveState calls) |

**Total new code**: ~850-900 lines across 3 new files + minor edits to 3 existing files.

---

## Verification Checklist

### Recorder
- [ ] Click "Ses Kaydet" → modal opens with big record button
- [ ] Click record → browser asks mic permission → live timer + pulsing red dot
- [ ] Record for a few seconds → click stop → waveform appears
- [ ] Click+drag on waveform → selection region highlighted in red
- [ ] "Seçimi Oynat" plays just the selection → playhead animates
- [ ] "Oynat" plays the full recording
- [ ] "Kırp" → waveform shrinks to selected region only
- [ ] "Geri Al" → waveform restores to previous state
- [ ] Select a region → "Kes" → region removed from waveform
- [ ] "Yeniden Kaydet" → confirmation dialog → back to record-ready state
- [ ] Close modal with unsaved recording → confirmation dialog
- [ ] "Zaman Çizelgesine Ekle" → modal closes, "Kayıt-1" appears on audio timeline
- [ ] Play the video → recorded audio plays in sync
- [ ] Export MP4 → recorded audio baked into the exported video

### Persistence
- [ ] Add images and audio to timeline → close browser tab → reopen → everything restored
- [ ] Record audio, add to timeline → close tab → reopen → recording is there
- [ ] Change overlay settings → close tab → reopen → overlay settings preserved
- [ ] Change resolution → close tab → reopen → resolution preserved
- [ ] Close browser tab with clips → browser shows "are you sure?" warning
- [ ] Upload custom logo via overlay settings → close tab → reopen → custom logo restored (not default)

### Integration
- [ ] Drag-drop audio files still works alongside recorded audio
- [ ] Both file-based and recorded audio play during preview
- [ ] Both file-based and recorded audio export correctly to MP4
- [ ] Multiple recordings can be added to the timeline
- [ ] State saves after each meaningful change (debounced)

### Durability & Edge Cases
- [ ] Close tab mid-recording → reopen: no corrupted partial recording in state
- [ ] Reload during an in-flight save (500ms debounce window): state is either fully-old or fully-new, never torn
- [ ] Delete a recorded track from timeline → save → reload: blob is gone from IndexedDB
- [ ] Load many large images until quota is hit: user sees visible Turkish error, not silent failure
- [ ] "Yeni Proje" button → clears all saved state → page reloads fresh
- [ ] Timeline zoom level survives reload (pixelsPerSecond persisted)
- [ ] Record "Kayıt-1" → reload → record again → new track is "Kayıt-2" (not duplicate "Kayıt-1")
- [ ] Upload custom overlay logo → reload → custom logo is restored (not overwritten by default logo.png)
