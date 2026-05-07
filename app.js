(() => {
  "use strict";

  /*
    Voice Doodle is intentionally vanilla JS:
    - Web Audio gives direct microphone analysis and synth playback with low overhead.
    - DeviceOrientation is read directly so iOS permission can be requested from a tap.
    - Pitch detection uses a small autocorrelation implementation inspired by pitchy-style
      time-domain detection. A bundled algorithm keeps the MVP working without CDN/network
      dependency; swapping to pitchy later only needs replacing detectPitch().
  */

  const STORAGE_KEY = "voice-doodle.soundprints.v1";
  const MAX_SAVES = 10;
  const FFT_SIZE = 2048;
  const MIN_PITCH = 70;
  const MAX_PITCH = 1200;

  const canvas = document.querySelector("#doodleCanvas");
  const ctx = canvas.getContext("2d", { alpha: true });
  const recordButton = document.querySelector("#recordButton");
  const playButton = document.querySelector("#playButton");
  const clearButton = document.querySelector("#clearButton");
  const saveButton = document.querySelector("#saveButton");
  const galleryButton = document.querySelector("#galleryButton");
  const gyroButton = document.querySelector("#gyroButton");
  const modeLabel = document.querySelector("#modeLabel");
  const statusText = document.querySelector("#statusText");
  const toast = document.querySelector("#toast");
  const modeButtons = [...document.querySelectorAll(".mode-button")];
  const galleryOverlay = document.querySelector("#galleryOverlay");
  const galleryGrid = document.querySelector("#galleryGrid");
  const closeGalleryButton = document.querySelector("#closeGalleryButton");

  const modes = {
    linear: "Linear",
    vinyl: "Vinyl",
    free: "Free"
  };

  const state = {
    mode: "linear",
    audioContext: null,
    analyser: null,
    micSource: null,
    micStream: null,
    sampleBuffer: new Float32Array(FFT_SIZE),
    isRecording: false,
    isPlaying: false,
    recordingStartedAt: 0,
    animationStartedAt: 0,
    records: [],
    playbackFrame: 0,
    livePoint: null,
    lastPitch: 0,
    lastVolume: 0,
    gyro: { alpha: 0, beta: 0, gamma: 0, supported: false, allowed: false },
    saved: []
  };

  function resizeCanvas() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.floor(window.innerWidth * ratio);
    const height = Math.floor(window.innerHeight * ratio);
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawScene(performance.now());
  }

  function setStatus(message) {
    statusText.textContent = message;
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("is-visible");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 1700);
  }

  function loadSaved() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      state.saved = Array.isArray(parsed) ? parsed.slice(-MAX_SAVES) : [];
    } catch {
      state.saved = [];
    }
  }

  function persistSaved() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.saved.slice(-MAX_SAVES)));
  }

  async function ensureAudio() {
    if (state.audioContext && state.micStream) return;

    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Web Audio or microphone support is missing.");
    }

    state.audioContext = state.audioContext || new AudioCtor({ latencyHint: "interactive" });
    if (state.audioContext.state === "suspended") {
      await state.audioContext.resume();
    }

    state.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = FFT_SIZE;
    state.analyser.smoothingTimeConstant = 0.08;
    state.micSource = state.audioContext.createMediaStreamSource(state.micStream);
    state.micSource.connect(state.analyser);
  }

  async function requestGyro() {
    /*
      iOS 13+ exposes DeviceOrientationEvent.requestPermission() and only allows
      it inside a user gesture. Android Chrome usually skips that method and starts
      sending events after the listener is attached on HTTPS. The app therefore:
      1. Attaches the listener.
      2. Calls requestPermission only when the method exists.
      3. Treats missing live events as "available but not yet moving" rather than fatal.
    */
    if (!("DeviceOrientationEvent" in window)) {
      setStatus("Motion sensor missing");
      showToast("No gyro found");
      return;
    }

    window.addEventListener("deviceorientation", handleOrientation, true);
    state.gyro.supported = true;

    const needsIosPermission = typeof DeviceOrientationEvent.requestPermission === "function";
    if (needsIosPermission) {
      try {
        const result = await DeviceOrientationEvent.requestPermission();
        state.gyro.allowed = result === "granted";
        setStatus(state.gyro.allowed ? "Motion active" : "Motion denied");
      } catch {
        setStatus("Could not enable motion");
      }
      return;
    }

    state.gyro.allowed = true;
    setStatus("Motion active");
    showToast("Gyro active");
  }

  function handleOrientation(event) {
    state.gyro.alpha = Number.isFinite(event.alpha) ? event.alpha : state.gyro.alpha;
    state.gyro.beta = Number.isFinite(event.beta) ? event.beta : state.gyro.beta;
    state.gyro.gamma = Number.isFinite(event.gamma) ? event.gamma : state.gyro.gamma;
    state.gyro.allowed = true;
  }

  function readMicPoint(now) {
    if (!state.analyser) return null;

    state.analyser.getFloatTimeDomainData(state.sampleBuffer);
    const volume = getRms(state.sampleBuffer);
    const pitch = volume > 0.012 ? detectPitch(state.sampleBuffer, state.audioContext.sampleRate) : 0;
    const cleanPitch = pitch >= MIN_PITCH && pitch <= MAX_PITCH ? smoothPitch(pitch) : 0;

    state.lastPitch = cleanPitch || state.lastPitch * 0.92;
    state.lastVolume = volume;

    return {
      time: now - state.recordingStartedAt,
      pitch: cleanPitch,
      volume,
      gyro: { ...state.gyro }
    };
  }

  function getRms(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      sum += buffer[i] * buffer[i];
    }
    return Math.sqrt(sum / buffer.length);
  }

  function smoothPitch(pitch) {
    if (!state.lastPitch) return pitch;
    const jump = Math.abs(pitch - state.lastPitch);
    const blend = jump > 160 ? 0.28 : 0.58;
    return state.lastPitch * (1 - blend) + pitch * blend;
  }

  function detectPitch(buffer, sampleRate) {
    const size = buffer.length;
    const minLag = Math.floor(sampleRate / MAX_PITCH);
    const maxLag = Math.floor(sampleRate / MIN_PITCH);
    let bestLag = -1;
    let bestCorrelation = 0;

    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let correlation = 0;
      for (let i = 0; i < size - lag; i += 1) {
        correlation += buffer[i] * buffer[i + lag];
      }
      correlation /= size - lag;
      if (correlation > bestCorrelation) {
        bestCorrelation = correlation;
        bestLag = lag;
      }
    }

    if (bestLag < 0 || bestCorrelation < 0.004) return 0;

    const before = lagCorrelation(buffer, bestLag - 1);
    const center = lagCorrelation(buffer, bestLag);
    const after = lagCorrelation(buffer, bestLag + 1);
    const shift = (after - before) / (2 * (2 * center - before - after));
    return sampleRate / (bestLag + (Number.isFinite(shift) ? shift : 0));
  }

  function lagCorrelation(buffer, lag) {
    if (lag <= 0) return 0;
    let sum = 0;
    for (let i = 0; i < buffer.length - lag; i += 1) {
      sum += buffer[i] * buffer[i + lag];
    }
    return sum / (buffer.length - lag);
  }

  function captureLoop(now) {
    if (state.isRecording) {
      const point = readMicPoint(now);
      if (point) {
        state.livePoint = point;
        state.records.push(point);
      }
    } else if (state.analyser) {
      state.livePoint = readMicPoint(now);
    }

    drawScene(now);
    requestAnimationFrame(captureLoop);
  }

  async function toggleRecording() {
    if (state.isRecording) {
      state.isRecording = false;
      document.body.classList.remove("is-recording");
      setStatus(`${state.records.length} points recorded`);
      return;
    }

    try {
      await ensureAudio();
      state.records = [];
      state.recordingStartedAt = performance.now();
      state.animationStartedAt = state.recordingStartedAt;
      state.isRecording = true;
      state.isPlaying = false;
      stopPlayback();
      document.body.classList.add("is-recording");
      setStatus("Recording");
    } catch (error) {
      setStatus("Microphone denied");
      showToast(error.message);
    }
  }

  async function playSoundprint() {
    if (!state.records.length || state.isPlaying) return;
    await ensureAudioForPlayback();
    state.isRecording = false;
    document.body.classList.remove("is-recording");
    state.isPlaying = true;
    state.playbackAudioStartedAt = scheduleSynth(state.records);
    state.playbackFrame = requestAnimationFrame(drawPlayback);
    setStatus("Playing");
  }

  async function ensureAudioForPlayback() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    state.audioContext = state.audioContext || new AudioCtor({ latencyHint: "interactive" });
    if (state.audioContext.state === "suspended") {
      await state.audioContext.resume();
    }
  }

  function scheduleSynth(points) {
    /*
      Playback uses generated sound, not recorded audio. Each pitch point drives a
      triangle oscillator through a soft gain envelope. AudioContext.currentTime is
      the master clock; the canvas reads the same elapsed time, so visual playback
      stays locked to the synth sequence instead of drifting with setTimeout.
    */
    stopPlayback.nodes = [];
    const now = state.audioContext.currentTime + 0.035;
    const usable = points.filter((point) => point.pitch > 0);

    usable.forEach((point, index) => {
      const next = usable[index + 1];
      const start = now + point.time / 1000;
      const duration = Math.max(0.035, Math.min(0.14, ((next?.time ?? point.time + 80) - point.time) / 1000));
      const osc = state.audioContext.createOscillator();
      const gain = state.audioContext.createGain();
      const filter = state.audioContext.createBiquadFilter();

      osc.type = "triangle";
      osc.frequency.setValueAtTime(clamp(point.pitch, MIN_PITCH, MAX_PITCH), start);
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(1600 + clamp(point.volume * 9000, 0, 5200), start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(clamp(point.volume * 1.8, 0.015, 0.18), start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(state.audioContext.destination);
      osc.start(start);
      osc.stop(start + duration + 0.03);
      stopPlayback.nodes.push(osc, gain, filter);
    });

    return now;
  }

  function stopPlayback() {
    if (state.playbackFrame) cancelAnimationFrame(state.playbackFrame);
    state.playbackFrame = 0;
    state.isPlaying = false;
    (stopPlayback.nodes || []).forEach((node) => {
      try {
        if (typeof node.stop === "function") node.stop();
        if (typeof node.disconnect === "function") node.disconnect();
      } catch {
        // Nodes may already be stopped; disconnecting best-effort is enough.
      }
    });
    stopPlayback.nodes = [];
  }

  function drawPlayback(now) {
    if (!state.isPlaying) return;
    const elapsed = (state.audioContext.currentTime - state.playbackAudioStartedAt) * 1000;
    const endTime = state.records.at(-1)?.time ?? 0;
    drawScene(now, Math.max(0, elapsed));
    if (elapsed <= endTime + 180) {
      state.playbackFrame = requestAnimationFrame(drawPlayback);
    } else {
      stopPlayback();
      setStatus("Playback complete");
      drawScene(performance.now());
    }
  }

  function drawScene(now, playbackTime = null) {
    const width = window.innerWidth;
    const height = window.innerHeight;
    ctx.clearRect(0, 0, width, height);
    drawBackdrop(width, height);

    const points = playbackTime === null
      ? state.records
      : state.records.filter((point) => point.time <= playbackTime);

    if (points.length > 1) {
      if (state.mode === "linear") drawLinear(points, width, height);
      if (state.mode === "vinyl") drawVinyl(points, width, height, now);
      if (state.mode === "free") drawFree(points, width, height);
    }

    if (!state.records.length && state.livePoint) {
      drawLiveProbe(state.livePoint, width, height, now);
    }
  }

  function drawBackdrop(width, height) {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#050817");
    gradient.addColorStop(0.5, "#11194a");
    gradient.addColorStop(1, "#2a144d");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    for (let y = height * 0.18; y < height; y += 46) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y + Math.sin(y * 0.02) * 18);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawLinear(points, width, height) {
    const latest = points.at(-1).time;
    const windowMs = 9000;
    const start = Math.max(0, latest - windowMs);
    const visible = points.filter((point) => point.time >= start && point.pitch > 0);
    drawSmoothPath(visible, (point) => {
      const x = map(point.time, start, start + windowMs, width * 0.06, width * 0.94);
      const y = pitchToY(point.pitch, height);
      return { x, y, size: volumeToLine(point.volume), color: pointColor(point) };
    });
  }

  function drawVinyl(points, width, height, now) {
    const cx = width / 2;
    const cy = height / 2;
    const maxRadius = Math.min(width, height) * 0.42;
    const spin = now * 0.00022;
    const duration = Math.max(1000, points.at(-1).time);

    ctx.globalAlpha = 0.24;
    ctx.strokeStyle = "#ffffff";
    for (let r = maxRadius * 0.24; r <= maxRadius; r += maxRadius * 0.18) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    drawSmoothPath(points.filter((point) => point.pitch > 0), (point) => {
      const radius = mapPitch(point.pitch, maxRadius * 0.16, maxRadius);
      const angle = map(point.time, 0, duration, -Math.PI / 2, Math.PI * 5.5) + spin;
      return {
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
        size: volumeToLine(point.volume),
        color: pointColor(point)
      };
    });
  }

  function drawFree(points, width, height) {
    drawSmoothPath(points.filter((point) => point.pitch > 0), (point) => {
      const x = map(clamp(point.gyro.gamma, -45, 45), -45, 45, width * 0.08, width * 0.92);
      const y = pitchToY(point.pitch, height);
      return { x, y, size: volumeToLine(point.volume), color: pointColor(point) };
    });
  }

  function drawSmoothPath(points, project) {
    if (points.length < 2) return;

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (let i = 1; i < points.length; i += 1) {
      const prev = project(points[i - 1]);
      const current = project(points[i]);
      const midX = (prev.x + current.x) / 2;
      const midY = (prev.y + current.y) / 2;
      const gradient = ctx.createLinearGradient(prev.x, prev.y, current.x, current.y);
      gradient.addColorStop(0, prev.color);
      gradient.addColorStop(1, current.color);

      ctx.strokeStyle = gradient;
      ctx.lineWidth = current.size;
      ctx.globalAlpha = 0.86;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.quadraticCurveTo(prev.x, prev.y, midX, midY);
      ctx.stroke();
    }

    const last = project(points.at(-1));
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = last.color;
    ctx.beginPath();
    ctx.arc(last.x, last.y, Math.max(5, last.size * 1.15), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawLiveProbe(point, width, height, now) {
    const pulse = 10 + Math.sin(now * 0.008) * 4 + point.volume * 180;
    const x = state.mode === "free"
      ? map(clamp(point.gyro.gamma, -45, 45), -45, 45, width * 0.08, width * 0.92)
      : width / 2;
    const y = point.pitch ? pitchToY(point.pitch, height) : height / 2;
    ctx.fillStyle = pointColor(point);
    ctx.globalAlpha = 0.72;
    ctx.beginPath();
    ctx.arc(x, y, pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function pointColor(point) {
    const tiltHue = state.mode === "free"
      ? map(normalizeAngle(point.gyro.alpha), 0, 360, 285, 55)
      : map(clamp(point.gyro.gamma + point.gyro.beta * 0.28, -70, 70), -70, 70, 220, 330);
    const loud = clamp(point.volume * 18, 0, 1);
    const hue = mix(tiltHue, 48, loud * 0.42);
    const saturation = 78 + loud * 20;
    const lightness = 54 + loud * 14;
    return `hsl(${hue} ${saturation}% ${lightness}%)`;
  }

  function volumeToLine(volume) {
    return clamp(1.4 + volume * 130, 1.4, 18);
  }

  function pitchToY(pitch, height) {
    return mapPitch(pitch, height * 0.82, height * 0.18);
  }

  function mapPitch(pitch, outMin, outMax) {
    const logMin = Math.log2(MIN_PITCH);
    const logMax = Math.log2(MAX_PITCH);
    return map(clamp(Math.log2(pitch || MIN_PITCH), logMin, logMax), logMin, logMax, outMin, outMax);
  }

  function map(value, inMin, inMax, outMin, outMax) {
    const t = (value - inMin) / (inMax - inMin || 1);
    return outMin + clamp(t, 0, 1) * (outMax - outMin);
  }

  function mix(a, b, t) {
    return a + (b - a) * clamp(t, 0, 1);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeAngle(value) {
    return ((value % 360) + 360) % 360;
  }

  function clearSoundprint() {
    stopPlayback();
    state.records = [];
    state.livePoint = null;
    setStatus("Cleared");
    drawScene(performance.now());
  }

  function switchMode(mode) {
    state.mode = mode;
    modeLabel.textContent = modes[mode];
    modeButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.mode === mode));
    drawScene(performance.now());
  }

  function saveCurrent() {
    if (!state.records.length) {
      showToast("Nothing to save yet");
      return;
    }

    const item = {
      id: crypto.randomUUID?.() || String(Date.now()),
      mode: state.mode,
      points: state.records.map((point) => ({
        time: Math.round(point.time),
        pitch: Math.round(point.pitch * 10) / 10,
        volume: Math.round(point.volume * 10000) / 10000,
        gyro: {
          alpha: Math.round(point.gyro.alpha * 10) / 10,
          beta: Math.round(point.gyro.beta * 10) / 10,
          gamma: Math.round(point.gyro.gamma * 10) / 10
        }
      })),
      timestamp: Date.now(),
      thumbnail: makeThumbnail()
    };

    state.saved.push(item);
    state.saved = state.saved.slice(-MAX_SAVES);
    persistSaved();
    showToast("Soundprint saved");
    renderGallery();
  }

  function makeThumbnail() {
    const thumb = document.createElement("canvas");
    thumb.width = 320;
    thumb.height = 320;
    const tctx = thumb.getContext("2d");
    tctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);
    return thumb.toDataURL("image/webp", 0.72);
  }

  function openGallery() {
    renderGallery();
    galleryOverlay.classList.add("is-open");
    galleryOverlay.setAttribute("aria-hidden", "false");
  }

  function closeGallery() {
    galleryOverlay.classList.remove("is-open");
    galleryOverlay.setAttribute("aria-hidden", "true");
  }

  function renderGallery() {
    galleryGrid.textContent = "";
    if (!state.saved.length) {
      const empty = document.createElement("p");
      empty.className = "empty-gallery";
      empty.textContent = "No saved soundprints";
      galleryGrid.append(empty);
      return;
    }

    [...state.saved].reverse().forEach((item) => {
      const card = document.createElement("article");
      card.className = "gallery-card";

      const loadButton = document.createElement("button");
      loadButton.type = "button";
      loadButton.className = "load-card";
      loadButton.ariaLabel = `Load ${modes[item.mode] || item.mode}`;
      const image = document.createElement("img");
      image.alt = "";
      image.src = item.thumbnail;
      loadButton.append(image);
      loadButton.addEventListener("click", async () => {
        loadSoundprint(item);
        closeGallery();
        await playSoundprint();
      });

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "delete-card";
      deleteButton.ariaLabel = "Delete soundprint";
      deleteButton.textContent = "x";
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        state.saved = state.saved.filter((saved) => saved.id !== item.id);
        persistSaved();
        renderGallery();
      });

      card.append(loadButton, deleteButton);
      galleryGrid.append(card);
    });
  }

  function loadSoundprint(item) {
    stopPlayback();
    state.records = item.points.map((point) => ({
      ...point,
      gyro: point.gyro || { alpha: 0, beta: 0, gamma: 0 }
    }));
    switchMode(item.mode in modes ? item.mode : "linear");
    setStatus("Soundprint loaded");
    drawScene(performance.now());
  }

  function updateButtonStates() {
    playButton.disabled = !state.records.length || state.isPlaying;
    saveButton.disabled = !state.records.length;
    requestAnimationFrame(updateButtonStates);
  }

  function warnIfInsecure() {
    if (!window.isSecureContext && location.hostname !== "localhost") {
      setStatus("HTTPS required for mobile mic/gyro");
      showToast("Open with HTTPS on phone");
    }
  }

  recordButton.addEventListener("click", toggleRecording);
  playButton.addEventListener("click", playSoundprint);
  clearButton.addEventListener("click", clearSoundprint);
  saveButton.addEventListener("click", saveCurrent);
  galleryButton.addEventListener("click", openGallery);
  closeGalleryButton.addEventListener("click", closeGallery);
  gyroButton.addEventListener("click", requestGyro);
  galleryOverlay.addEventListener("click", (event) => {
    if (event.target === galleryOverlay) closeGallery();
  });
  modeButtons.forEach((button) => {
    button.addEventListener("click", () => switchMode(button.dataset.mode));
  });
  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("orientationchange", resizeCanvas);

  loadSaved();
  resizeCanvas();
  warnIfInsecure();
  requestAnimationFrame(captureLoop);
  requestAnimationFrame(updateButtonStates);
})();
