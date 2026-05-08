(() => {
  "use strict";

  /*
    Voice Doodle is a material instrument rather than a literal oscilloscope.
    Audio analysis produces a small set of expressive controls:
    - pitch: melodic contour, mapped logarithmically so low/high voices both work.
    - volume: paint pressure, opacity, groove depth and synth gain.
    - clarity: how stable the detected pitch is; clear whistling makes cleaner marks.
    - brightness: a time-domain zero-crossing proxy for airy/noisy vocal texture.
    - pitchDelta: contour motion, used for wobble and oily edge behavior.

    The DeviceOrientation API is still requested from a tap because iOS Safari only
    allows DeviceOrientationEvent.requestPermission() inside a user gesture. Android
    Chrome normally starts sending events after the listener is attached on HTTPS.
  */

  const STORAGE_KEY = "voice-doodle.soundprints.v2";
  const LEGACY_STORAGE_KEY = "voice-doodle.soundprints.v1";
  const MAX_SAVES = 10;
  const FFT_SIZE = 2048;
  const MIN_PITCH = 70;
  const MAX_PITCH = 1200;
  const SILENCE_RMS = 0.01;

  const canvas = document.querySelector("#doodleCanvas");
  const ctx = canvas.getContext("2d", { alpha: true });
  const recordButton = document.querySelector("#recordButton");
  const playButton = document.querySelector("#playButton");
  const newBrushButton = document.querySelector("#newBrushButton");
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
  const volumeSlider = document.querySelector("#volumeSlider");

  const modes = {
    linear: "Score",
    vinyl: "Vinyl",
    free: "Paint"
  };

  const state = {
    mode: "linear",
    audioContext: null,
    analyser: null,
    micSource: null,
    micStream: null,
    sampleBuffer: new Float32Array(FFT_SIZE),
    isRecording: false,
    recordingKind: "record",
    isPlaying: false,
    recordingStartedAt: 0,
    layers: [[]],
    activeLayer: 0,
    playbackFrame: 0,
    playbackNodes: [],
    livePoint: null,
    lastPitch: 0,
    lastStablePitch: 220,
    lastPaint: { x: 0.5, y: 0.5 },
    playbackVolume: 1.35,
    gyro: { alpha: 0, beta: 0, gamma: 0, supported: false, allowed: false },
    saved: []
  };

  function resizeCanvas() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * ratio);
    canvas.height = Math.floor(window.innerHeight * ratio);
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
      const current = localStorage.getItem(STORAGE_KEY);
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      const parsed = JSON.parse(current || legacy || "[]");
      state.saved = Array.isArray(parsed) ? parsed.slice(-MAX_SAVES) : [];
    } catch {
      state.saved = [];
    }
  }

  function persistSaved() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.saved.slice(-MAX_SAVES)));
  }

  function currentLayer() {
    state.layers[state.activeLayer] = state.layers[state.activeLayer] || [];
    return state.layers[state.activeLayer];
  }

  function allPoints() {
    return state.layers.flat();
  }

  function latestTime(layers = state.layers) {
    return layers.reduce((latest, layer) => Math.max(latest, last(layer)?.time || 0), 0);
  }

  function hasSoundprint() {
    return state.layers.some((layer) => layer.length > 0);
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
    state.analyser.smoothingTimeConstant = 0.04;
    state.micSource = state.audioContext.createMediaStreamSource(state.micStream);
    state.micSource.connect(state.analyser);
  }

  async function ensureAudioForPlayback() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    state.audioContext = state.audioContext || new AudioCtor({ latencyHint: "interactive" });
    if (state.audioContext.state === "suspended") {
      await state.audioContext.resume();
    }
  }

  async function requestGyro() {
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
    const frame = analyzeAudioFrame(state.sampleBuffer, state.audioContext.sampleRate);
    const time = now - state.recordingStartedAt;
    const point = buildPoint(time, frame);

    state.livePoint = point;
    if (point.pitch > 0) {
      state.lastStablePitch = point.pitch;
    }
    return point;
  }

  function analyzeAudioFrame(buffer, sampleRate) {
    const volume = getRms(buffer);
    const brightness = getZeroCrossingRate(buffer);
    const detection = volume > SILENCE_RMS ? detectPitch(buffer, sampleRate) : { pitch: 0, clarity: 0 };
    const pitch = detection.pitch >= MIN_PITCH && detection.pitch <= MAX_PITCH && detection.clarity > 0.18
      ? smoothPitch(detection.pitch, detection.clarity)
      : 0;
    const pitchDelta = pitch && state.lastPitch ? clamp((pitch - state.lastPitch) / 180, -1, 1) : 0;

    state.lastPitch = pitch || state.lastPitch * 0.94;

    return {
      pitch,
      volume,
      clarity: detection.clarity,
      brightness,
      pitchDelta
    };
  }

  function buildPoint(time, frame) {
    const pitchForMapping = frame.pitch || state.lastStablePitch;
    const targetPaint = {
      x: map(clamp(state.gyro.gamma, -42, 42), -42, 42, 0.08, 0.92),
      y: map(clamp(state.gyro.beta, -28, 58), -28, 58, 0.12, 0.88)
    };

    // Gyro is the hand in Paint mode, but smoothing makes it feel like a heavy brush.
    state.lastPaint.x = mix(state.lastPaint.x || targetPaint.x, targetPaint.x, 0.24);
    state.lastPaint.y = mix(state.lastPaint.y || targetPaint.y, targetPaint.y, 0.24);

    return {
      time,
      pitch: frame.pitch,
      volume: frame.volume,
      active: frame.volume > SILENCE_RMS * 1.15 && frame.pitch > 0,
      clarity: frame.clarity,
      brightness: frame.brightness,
      pitchDelta: frame.pitchDelta,
      gyro: { ...state.gyro },
      paint: { ...state.lastPaint },
      pitchNorm: pitchToNorm(pitchForMapping)
    };
  }

  function getRms(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      sum += buffer[i] * buffer[i];
    }
    return Math.sqrt(sum / buffer.length);
  }

  function getZeroCrossingRate(buffer) {
    let crossings = 0;
    for (let i = 1; i < buffer.length; i += 1) {
      if ((buffer[i - 1] < 0 && buffer[i] >= 0) || (buffer[i - 1] >= 0 && buffer[i] < 0)) {
        crossings += 1;
      }
    }
    return clamp(crossings / buffer.length * 18, 0, 1);
  }

  function smoothPitch(pitch, clarity) {
    if (!state.lastPitch) return pitch;
    const jump = Math.abs(pitch - state.lastPitch);
    const trust = clamp(clarity, 0.18, 0.82);
    const blend = jump > 170 ? 0.1 : map(trust, 0.18, 0.82, 0.18, 0.44);
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
      let energyA = 0;
      let energyB = 0;
      for (let i = 0; i < size - lag; i += 1) {
        const a = buffer[i];
        const b = buffer[i + lag];
        correlation += a * b;
        energyA += a * a;
        energyB += b * b;
      }
      const normalized = correlation / Math.sqrt((energyA || 1) * (energyB || 1));
      if (normalized > bestCorrelation) {
        bestCorrelation = normalized;
        bestLag = lag;
      }
    }

    if (bestLag < 0 || bestCorrelation < 0.16) return { pitch: 0, clarity: bestCorrelation };

    const before = lagCorrelation(buffer, bestLag - 1);
    const center = lagCorrelation(buffer, bestLag);
    const after = lagCorrelation(buffer, bestLag + 1);
    const shift = (after - before) / (2 * (2 * center - before - after));
    const pitch = sampleRate / (bestLag + (Number.isFinite(shift) ? shift : 0));
    return { pitch, clarity: clamp(bestCorrelation, 0, 1) };
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
        currentLayer().push(point);
      }
    } else if (state.analyser) {
      readMicPoint(now);
    }

    if (!state.isPlaying) {
      drawScene(now);
    }
    requestAnimationFrame(captureLoop);
  }

  async function toggleRecording(kind = "record") {
    if (state.isRecording) {
      stopRecording();
      return;
    }

    try {
      await ensureAudio();
      stopPlayback();
      if (kind === "brush") {
        state.layers.push([]);
        state.activeLayer = state.layers.length - 1;
      }
      state.recordingStartedAt = performance.now();
      state.lastPitch = 0;
      state.isRecording = true;
      state.recordingKind = kind;
      document.body.classList.add("is-recording");
      document.body.classList.toggle("is-brush-recording", kind === "brush");
      setStatus(kind === "brush" ? `Recording brush ${state.activeLayer + 1}` : "Recording");
    } catch (error) {
      setStatus("Microphone denied");
      showToast(error.message);
    }
  }

  function stopRecording() {
    state.isRecording = false;
    document.body.classList.remove("is-recording", "is-brush-recording");
    setStatus(`${currentLayer().length} points recorded`);
  }

  async function playSoundprint() {
    if (state.isPlaying) {
      stopPlayback();
      setStatus("Playback stopped");
      drawScene(performance.now());
      return;
    }
    if (!hasSoundprint()) return;
    await ensureAudioForPlayback();
    if (state.isRecording) stopRecording();
    state.isPlaying = true;
    state.playbackAudioStartedAt = scheduleContinuousSynth(state.layers);
    document.body.classList.add("is-playing");
    state.playbackFrame = requestAnimationFrame(drawPlayback);
    setStatus("Playing");
  }

  function newRecording() {
    stopPlayback();
    state.isRecording = false;
    document.body.classList.remove("is-recording", "is-brush-recording");
    state.layers = [[]];
    state.activeLayer = 0;
    state.livePoint = null;
    state.lastPitch = 0;
    state.lastStablePitch = 220;
    state.lastPaint = { x: 0.5, y: 0.5 };
    setStatus("New recording");
    drawScene(performance.now());
  }

  function newBrush() {
    toggleRecording("brush");
  }

  function scheduleContinuousSynth(layers) {
    /*
      Playback is now one continuous synth voice. Frequency, gain and filter values
      ramp through the recorded data, which avoids the choppy stack of many short
      oscillators and keeps the generated sound synced to the visual replay.
    */
    stopPlayback();
    state.isPlaying = true;

    const audio = state.audioContext;
    const start = audio.currentTime + 0.04;
    const endMs = latestTime(layers);
    const master = audio.createGain();
    const delay = audio.createDelay(0.24);
    const delayGain = audio.createGain();

    master.gain.setValueAtTime(state.playbackVolume, start);
    delay.delayTime.setValueAtTime(0.075, start);
    delayGain.gain.setValueAtTime(0.055, start);
    master.connect(audio.destination);
    master.connect(delay);
    delay.connect(delayGain);
    delayGain.connect(audio.destination);
    state.playbackNodes = [master, delay, delayGain];

    const activeLayers = layers
      .map((layer) => layer.filter((point) => point.pitch > 0 || point.active === false))
      .filter((layer) => layer.length > 0);
    if (!activeLayers.length) return start;

    activeLayers.forEach((usable, layerIndex) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      const filter = audio.createBiquadFilter();
      let synthPitch = clamp(usable.find((point) => point.active !== false)?.pitch || usable[0].pitch, MIN_PITCH, MAX_PITCH);
      osc.type = layerIndex % 2 ? "triangle" : "sine";
      filter.type = "lowpass";
      gain.gain.setValueAtTime(0.0001, start);
      filter.frequency.setValueAtTime(2200, start);
      osc.frequency.setValueAtTime(synthPitch, start);

      usable.forEach((point, index) => {
        if (index % 2 !== 0 && usable.length > 120) return;
        const when = start + point.time / 1000;
        const isActive = point.active !== false && point.pitch > 0 && point.volume > SILENCE_RMS;
        const rawPitch = clamp(point.pitch || synthPitch, MIN_PITCH, MAX_PITCH);
        const glide = Math.abs(rawPitch - synthPitch) > 140 ? 0.12 : 0.24;
        synthPitch = synthPitch * (1 - glide) + rawPitch * glide;
        const amp = isActive ? clamp(point.volume * 4.7, 0.0001, 0.48) / Math.sqrt(activeLayers.length) : 0.0001;
        const cutoff = 1200 + point.brightness * 3600 + point.clarity * 1800;
        if (isActive) {
          osc.frequency.linearRampToValueAtTime(synthPitch, when);
        }
        gain.gain.setTargetAtTime(amp, when, isActive ? 0.028 : 0.018);
        filter.frequency.linearRampToValueAtTime(cutoff, when);
      });

      gain.gain.linearRampToValueAtTime(0.0001, start + endMs / 1000 + 0.22);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      osc.start(start);
      osc.stop(start + endMs / 1000 + 0.34);
      state.playbackNodes.push(osc, gain, filter);
    });

    return start;
  }

  function stopPlayback() {
    if (state.playbackFrame) cancelAnimationFrame(state.playbackFrame);
    state.playbackFrame = 0;
    state.isPlaying = false;
    state.playbackNodes.forEach((node) => {
      try {
        if (typeof node.stop === "function") node.stop();
        if (typeof node.disconnect === "function") node.disconnect();
      } catch {
        // Audio nodes can already be stopped by their scheduled end time.
      }
    });
    state.playbackNodes = [];
    document.body.classList.remove("is-playing");
  }

  function drawPlayback(now) {
    if (!state.isPlaying) return;
    const elapsed = (state.audioContext.currentTime - state.playbackAudioStartedAt) * 1000;
    const endTime = latestTime();
    drawScene(now, Math.max(0, elapsed));
    if (elapsed <= endTime + 220) {
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
    drawMaterialBackground(width, height, now);

    const visibleLayers = playbackTime === null
      ? state.layers
      : state.layers.map((layer) => layer.filter((point) => point.time <= playbackTime));
    const renderTime = playbackTime === null ? latestTime(visibleLayers) : playbackTime;

    if (visibleLayers.some((layer) => layer.length > 1)) {
      visibleLayers.forEach((layer, layerIndex) => {
        if (state.mode === "linear") renderScore(layer, width, height, renderTime, layerIndex);
        if (state.mode === "vinyl") renderVinyl(layer, width, height, now, playbackTime, layerIndex);
        if (state.mode === "free") renderPaint(layer, width, height, layerIndex);
      });
    } else if (!hasSoundprint() && state.livePoint && state.mode !== "free") {
      drawLiveProbe(state.livePoint, width, height, now);
    }

    if (state.mode === "free" && state.livePoint && !state.isPlaying) {
      drawLiveProbe(state.livePoint, width, height, now);
    }

    drawMaterialOverlay(width, height);
  }

  function drawMaterialBackground(width, height, now) {
    if (state.mode === "free") {
      drawLinen(width, height);
    } else if (state.mode === "linear") {
      drawPaper(width, height);
    } else {
      drawVinylSurface(width, height, now);
    }
  }

  function drawLinen(width, height) {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#f1efe3");
    gradient.addColorStop(0.5, "#e6e0cf");
    gradient.addColorStop(1, "#d8cfba");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.globalAlpha = 0.24;
    ctx.lineWidth = 0.75;
    for (let x = 0; x < width; x += 3) {
      ctx.strokeStyle = x % 9 === 0 ? "#fbf9ec" : "#b9b19c";
      ctx.beginPath();
      ctx.moveTo(x + Math.sin(x * 0.13) * 0.9, 0);
      ctx.lineTo(x + Math.sin(x * 0.21) * 1.2, height);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.2;
    for (let y = 0; y < height; y += 4) {
      ctx.strokeStyle = y % 12 === 0 ? "#fffdf0" : "#ada58f";
      ctx.beginPath();
      ctx.moveTo(0, y + Math.cos(y * 0.15) * 0.9);
      ctx.lineTo(width, y + Math.cos(y * 0.19) * 1.1);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.12;
    ctx.lineWidth = 0.5;
    for (let i = 0; i < 180; i += 1) {
      const x = seededNoise(i * 21.11) * width;
      const y = seededNoise(i * 43.37) * height;
      const len = 3 + seededNoise(i * 5.91) * 13;
      ctx.strokeStyle = i % 3 === 0 ? "#8f896f" : "#fffdf2";
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + len, y + Math.sin(i) * 1.4);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.055;
    for (let i = 0; i < 42; i += 1) {
      const x = seededNoise(i * 31.73) * width;
      const y = seededNoise(i * 17.19) * height;
      const r = 28 + seededNoise(i * 8.37) * 74;
      const bump = ctx.createRadialGradient(x, y, 0, x, y, r);
      bump.addColorStop(0, i % 2 ? "#fffef5" : "#8d866d");
      bump.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = bump;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawPaper(width, height) {
    ctx.fillStyle = "#f2ead7";
    ctx.fillRect(0, 0, width, height);

    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = "#b9c9cc";
    ctx.lineWidth = 1;
    for (let y = height * 0.18; y < height * 0.86; y += height * 0.105) {
      ctx.beginPath();
      ctx.moveTo(width * 0.06, y);
      ctx.bezierCurveTo(width * 0.32, y - 3, width * 0.66, y + 3, width * 0.94, y);
      ctx.stroke();
    }

    ctx.globalAlpha = 0.08;
    for (let i = 0; i < 90; i += 1) {
      const x = seededNoise(i * 12.989) * width;
      const y = seededNoise(i * 78.233) * height;
      ctx.fillStyle = i % 2 ? "#384b55" : "#ffffff";
      ctx.fillRect(x, y, 1.2, 1.2);
    }
    ctx.globalAlpha = 1;
  }

  function drawVinylSurface(width, height, now) {
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) * 0.49;
    const gradient = ctx.createRadialGradient(cx - radius * 0.2, cy - radius * 0.24, radius * 0.04, cx, cy, radius);
    gradient.addColorStop(0, "#3d3d3a");
    gradient.addColorStop(0.34, "#171716");
    gradient.addColorStop(0.72, "#070707");
    gradient.addColorStop(1, "#000000");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(now * 0.00008);
    ctx.globalAlpha = 0.32;
    for (let r = radius * 0.2; r < radius * 0.96; r += 7) {
      ctx.strokeStyle = r % 21 < 7 ? "#262626" : "#111";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    ctx.globalAlpha = 0.42;
    ctx.strokeStyle = "#d0b46b";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawMaterialOverlay(width, height) {
    if (state.mode !== "vinyl") {
      ctx.globalAlpha = state.mode === "free" ? 0.08 : 0.06;
      ctx.fillStyle = "#2f2519";
      for (let i = 0; i < 70; i += 1) {
        const x = seededNoise(i * 9.17) * width;
        const y = seededNoise(i * 4.67) * height;
        ctx.fillRect(x, y, 1, state.mode === "free" ? 5 : 2);
      }
      ctx.globalAlpha = 1;
    }
  }

  function renderPaint(points, width, height, layerIndex) {
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    splitActiveSegments(points).forEach((segment) => drawOilyStroke(segment, width, height, layerIndex));
    ctx.restore();
  }

  function drawOilyStroke(points, width, height, layerIndex) {
    if (points.length < 2) return;
    for (let layer = 0; layer < 4; layer += 1) {
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = [0.24, 0.38, 0.64, 0.26][layer];

      for (let i = 1; i < points.length; i += 1) {
        const a = paintProject(points[i - 1], width, height, layer);
        const b = paintProject(points[i], width, height, layer);
        const wobble = (points[i].brightness + Math.abs(points[i].pitchDelta)) * (layer + 1) * 2.4;
        const cx = (a.x + b.x) / 2 + Math.sin(i * 1.7 + layer) * wobble;
        const cy = (a.y + b.y) / 2 + Math.cos(i * 1.3 + layer) * wobble;
        const gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        gradient.addColorStop(0, paintColor(points[i - 1], layer, layerIndex));
        gradient.addColorStop(1, paintColor(points[i], layer, layerIndex));
        ctx.strokeStyle = gradient;
        ctx.lineWidth = Math.max(1, paintSize(points[i]) * [1.55, 1.1, 0.7, 0.22][layer]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(cx, cy, b.x, b.y);
        ctx.stroke();
      }
    }

    ctx.globalAlpha = 0.33;
    ctx.strokeStyle = "#fff3d2";
    ctx.lineWidth = 1.2;
    for (let i = 4; i < points.length; i += 7) {
      const p = paintProject(points[i], width, height, 0);
      const angle = normalizeAngle(points[i].gyro.alpha) * Math.PI / 180;
      const len = 5 + points[i].volume * 70;
      ctx.beginPath();
      ctx.moveTo(p.x - Math.cos(angle) * len * 0.5, p.y - Math.sin(angle) * len * 0.5);
      ctx.lineTo(p.x + Math.cos(angle) * len * 0.5, p.y + Math.sin(angle) * len * 0.5);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function renderScore(points, width, height, renderTime, layerIndex) {
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    splitActiveSegments(points).forEach((segment) => {
      if (segment.length < 2) return;
      for (let pass = 0; pass < 4; pass += 1) {
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.globalAlpha = [0.1, 0.16, 0.26, 0.12][pass];
        for (let i = 1; i < segment.length; i += 1) {
          const a = scoreProject(segment[i - 1], width, height, pass, renderTime);
          const b = scoreProject(segment[i], width, height, pass, renderTime);
          const midY = (a.y + b.y) / 2 + Math.sin(i * 0.8 + pass + layerIndex) * (2 + segment[i].brightness * 8);
          ctx.strokeStyle = scoreColor(segment[i], pass, layerIndex);
          ctx.lineWidth = scoreSize(segment[i]) * [2.6, 1.45, 0.72, 3.4][pass];
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.quadraticCurveTo((a.x + b.x) / 2, midY, b.x, b.y);
          ctx.stroke();
        }
      }
    });
    ctx.restore();
  }

  function renderVinyl(points, width, height, now, playbackTime, layerIndex) {
    const segments = splitActiveSegments(points);
    if (!segments.length) return;
    const cx = width / 2;
    const cy = height / 2;
    const maxRadius = Math.min(width, height) * 0.43;
    const duration = Math.max(1000, latestTime());
    const spin = now * 0.00016 + layerIndex * 0.018;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(spin);
    ctx.translate(-cx, -cy);

    segments.forEach((active) => {
      for (let i = 1; i < active.length; i += 1) {
        const a = vinylProject(active[i - 1], cx, cy, maxRadius, duration);
        const b = vinylProject(active[i], cx, cy, maxRadius, duration);
        const depth = vinylSize(active[i]);

        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = "#020202";
        ctx.lineWidth = depth + 3;
        ctx.beginPath();
        ctx.moveTo(a.x + 1.5, a.y + 1.5);
        ctx.lineTo(b.x + 1.5, b.y + 1.5);
        ctx.stroke();

        ctx.globalAlpha = 0.75;
        ctx.strokeStyle = vinylColor(active[i], layerIndex);
        ctx.lineWidth = Math.max(1, depth * 0.58);
        ctx.beginPath();
        ctx.moveTo(a.x - 1, a.y - 1);
        ctx.lineTo(b.x - 1, b.y - 1);
        ctx.stroke();
      }
    });
    ctx.restore();

    if (state.isPlaying && playbackTime !== null) {
      drawVinylNeedle(width, height, now);
    }
  }

  function paintProject(point, width, height, layer) {
    const canvasPull = Math.sin(point.paint.x * 18.2) * Math.cos(point.paint.y * 15.4) * 5.5;
    const jitter = (point.brightness + Math.abs(point.pitchDelta)) * (layer + 1) * 3.6 + canvasPull;
    return {
      x: point.paint.x * width + Math.sin(point.time * 0.015 + layer) * jitter,
      y: point.paint.y * height + Math.cos(point.time * 0.012 + layer) * jitter
    };
  }

  function scoreProject(point, width, height, pass, renderTime) {
    const start = Math.max(0, renderTime - 9500);
    const x = map(point.time, start, start + 9500, width * 0.06, width * 0.94);
    const drift = map(clamp(point.gyro.gamma, -45, 45), -45, 45, -14, 14);
    const bleed = Math.sin(point.time * 0.006 + pass * 1.9) * (pass + 1) * (1 + point.brightness * 5);
    return {
      x,
      y: map(point.pitchNorm, 0, 1, height * 0.82, height * 0.18) + drift * 0.2 + bleed
    };
  }

  function vinylProject(point, cx, cy, maxRadius, duration) {
    const radius = map(point.pitchNorm, 0, 1, maxRadius * 0.18, maxRadius);
    const angle = map(point.time, 0, duration, -Math.PI / 2, Math.PI * 5.75);
    const modulation = Math.sin(point.time * 0.028) * point.brightness * 5;
    return {
      x: cx + Math.cos(angle) * (radius + modulation),
      y: cy + Math.sin(angle) * (radius + modulation)
    };
  }

  function drawVinylNeedle(width, height, now) {
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) * 0.36;
    const angle = -Math.PI / 5 + Math.sin(now * 0.001) * 0.02;
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = "#b8b0a2";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(width * 0.82, height * 0.18);
    ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
    ctx.stroke();
    ctx.fillStyle = "#d6bd77";
    ctx.beginPath();
    ctx.arc(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawLiveProbe(point, width, height, now) {
    const size = 10 + point.volume * 170;
    let x = width / 2;
    let y = height / 2;
    if (state.mode === "free") {
      x = point.paint.x * width;
      y = point.paint.y * height;
    } else if (state.mode === "linear" && point.pitch > 0) {
      y = map(point.pitchNorm, 0, 1, height * 0.82, height * 0.18);
    }

    ctx.fillStyle = state.mode === "vinyl" ? "#d6bd77" : materialColor(point, 0);
    ctx.globalAlpha = 0.46 + point.volume * 2;
    ctx.beginPath();
    ctx.arc(x, y, size + Math.sin(now * 0.008) * 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function paintSize(point) {
    return clamp(8 + point.volume * 180 + point.clarity * 7, 5, 34);
  }

  function scoreSize(point) {
    return clamp(1.2 + point.volume * 84, 1.2, 13);
  }

  function vinylSize(point) {
    return clamp(1.4 + point.volume * 92 + point.clarity * 2, 1.4, 13);
  }

  function paintColor(point, layer, layerIndex = 0) {
    const hue = voiceHue(point) + layerIndex * 28;
    const oilShift = map(clamp(point.gyro.alpha, 0, 360), 0, 360, -16, 16);
    const sat = 74 + point.clarity * 22 - layer * 3;
    const light = 31 + point.volume * 34 + layer * 4;
    return `hsl(${hue + oilShift} ${sat}% ${light}%)`;
  }

  function scoreColor(point, pass, layerIndex = 0) {
    const hue = voiceHue(point) + layerIndex * 18;
    const warm = point.volume * 16;
    return `hsl(${hue + warm} ${44 + point.clarity * 18}% ${68 + pass * 4}%)`;
  }

  function vinylColor(point, layerIndex = 0) {
    const hue = voiceHue(point) * 0.22 + 188 + layerIndex * 10;
    const light = 46 + point.volume * 36 + point.clarity * 10;
    return `hsl(${hue} 28% ${light}%)`;
  }

  function materialColor(point, layer) {
    if (state.mode === "free") return paintColor(point, layer);
    if (state.mode === "vinyl") return vinylColor(point);
    return scoreColor(point, layer);
  }

  function pitchToNorm(pitch) {
    const logMin = Math.log2(95);
    const logMax = Math.log2(620);
    return clamp((Math.log2(pitch || MIN_PITCH) - logMin) / (logMax - logMin), 0, 1);
  }

  function voiceHue(point) {
    return (300 - point.pitchNorm * 300 + 360) % 360;
  }

  function splitActiveSegments(points) {
    const segments = [];
    let segment = [];
    points.forEach((point) => {
      const active = point.active !== false && point.pitch > 0 && point.volume > SILENCE_RMS;
      if (active) {
        segment.push(point);
      } else if (segment.length) {
        segments.push(segment);
        segment = [];
      }
    });
    if (segment.length) segments.push(segment);
    return segments;
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

  function last(items) {
    return items[items.length - 1];
  }

  function seededNoise(seed) {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  }

  function clearSoundprint() {
    stopPlayback();
    state.isRecording = false;
    document.body.classList.remove("is-recording", "is-brush-recording");
    state.layers = [[]];
    state.activeLayer = 0;
    state.livePoint = null;
    setStatus("Cleared");
    drawScene(performance.now());
  }

  function switchMode(mode) {
    if (state.isRecording) stopRecording();
    if (state.isPlaying) stopPlayback();
    state.mode = mode;
    document.body.dataset.mode = mode;
    modeLabel.textContent = modes[mode];
    modeButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.mode === mode));
    drawScene(performance.now());
  }

  function saveCurrent() {
    if (!hasSoundprint()) {
      showToast("Nothing to save yet");
      return;
    }

    const item = {
      id: crypto.randomUUID?.() || String(Date.now()),
      mode: state.mode,
      layers: state.layers.filter((layer) => layer.length).map((layer) => layer.map(serializePoint)),
      timestamp: Date.now(),
      thumbnail: makeThumbnail()
    };

    state.saved.push(item);
    state.saved = state.saved.slice(-MAX_SAVES);
    persistSaved();
    showToast("Soundprint saved");
    renderGallery();
  }

  function serializePoint(point) {
    return {
      time: Math.round(point.time),
      pitch: round(point.pitch, 10),
      volume: round(point.volume, 10000),
      active: Boolean(point.active),
      clarity: round(point.clarity ?? 0, 1000),
      brightness: round(point.brightness ?? 0, 1000),
      pitchDelta: round(point.pitchDelta ?? 0, 1000),
      pitchNorm: round(point.pitchNorm ?? pitchToNorm(point.pitch), 1000),
      gyro: {
        alpha: round(point.gyro?.alpha ?? 0, 10),
        beta: round(point.gyro?.beta ?? 0, 10),
        gamma: round(point.gyro?.gamma ?? 0, 10)
      },
      paint: {
        x: round(point.paint?.x ?? 0.5, 1000),
        y: round(point.paint?.y ?? 0.5, 1000)
      }
    };
  }

  function round(value, factor) {
    return Math.round(value * factor) / factor;
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
    const layers = Array.isArray(item.layers) ? item.layers : [item.points || []];
    state.layers = layers.map((layer) => layer.map(normalizeLoadedPoint)).filter((layer) => layer.length);
    if (!state.layers.length) state.layers = [[]];
    state.activeLayer = state.layers.length - 1;
    switchMode(item.mode in modes ? item.mode : "linear");
    setStatus("Soundprint loaded");
    drawScene(performance.now());
  }

  function normalizeLoadedPoint(point) {
    const pitchNorm = point.pitchNorm ?? pitchToNorm(point.pitch || state.lastStablePitch);
    return {
      time: point.time ?? 0,
      pitch: point.pitch ?? 0,
      volume: point.volume ?? 0,
      active: point.active ?? ((point.pitch ?? 0) > 0 && (point.volume ?? 0) > SILENCE_RMS),
      clarity: point.clarity ?? 0.5,
      brightness: point.brightness ?? 0.2,
      pitchDelta: point.pitchDelta ?? 0,
      gyro: point.gyro || { alpha: 0, beta: 0, gamma: 0 },
      paint: point.paint || { x: 0.5, y: map(pitchNorm, 0, 1, 0.82, 0.18) },
      pitchNorm
    };
  }

  function updateButtonStates() {
    playButton.disabled = !hasSoundprint() || state.isPlaying;
    saveButton.disabled = !hasSoundprint();
    newBrushButton.disabled = state.isPlaying;
    requestAnimationFrame(updateButtonStates);
  }

  function warnIfInsecure() {
    if (!window.isSecureContext && location.hostname !== "localhost") {
      setStatus("HTTPS required for mobile mic/gyro");
      showToast("Open with HTTPS on phone");
    }
  }

  recordButton.addEventListener("click", () => toggleRecording("record"));
  playButton.addEventListener("click", playSoundprint);
  newBrushButton.addEventListener("click", newBrush);
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
  volumeSlider.addEventListener("input", () => {
    state.playbackVolume = Number(volumeSlider.value);
    const master = state.playbackNodes[0];
    if (master?.gain && state.audioContext) {
      master.gain.setTargetAtTime(state.playbackVolume, state.audioContext.currentTime, 0.02);
    }
  });
  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("orientationchange", resizeCanvas);

  loadSaved();
  switchMode("linear");
  resizeCanvas();
  warnIfInsecure();
  requestAnimationFrame(captureLoop);
  requestAnimationFrame(updateButtonStates);
})();
