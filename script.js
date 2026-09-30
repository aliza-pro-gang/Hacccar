const recordBtn = document.getElementById("recordBtn");
const stopBtn = document.getElementById("stopBtn");
const applyBtn = document.getElementById("applyBtn");
const downloadBtn = document.getElementById("downloadBtn");
const audioPlayer = document.getElementById("audioPlayer");
const statusEl = document.getElementById("status");
const outputHint = document.getElementById("outputHint");
const timerEl = document.getElementById("timer");
const micOrb = document.getElementById("micOrb");

const pitch = document.getElementById("pitch");
const brightness = document.getElementById("brightness");
const speed = document.getElementById("speed");
const pitchValue = document.getElementById("pitchValue");
const brightnessValue = document.getElementById("brightnessValue");
const speedValue = document.getElementById("speedValue");

let mediaRecorder = null;
let chunks = [];
let rawBlob = null;
let timerInterval = null;
let startTime = 0;
let outputUrl = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function updateLabels() {
  pitchValue.textContent = `+${pitch.value} semitones`;
  brightnessValue.textContent = `${brightness.value}%`;
  speedValue.textContent = `${Number(speed.value).toFixed(2)}×`;
}
[pitch, brightness, speed].forEach(el => el.addEventListener("input", updateLabels));
updateLabels();

function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

recordBtn.addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = e => {
      if (e.data.size) chunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      rawBlob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
      stream.getTracks().forEach(track => track.stop());

      applyBtn.disabled = false;
      outputHint.textContent = "Recording ready. Choose a preset or adjust the controls, then apply the effect.";
      setStatus("Recording ready");
    };

    mediaRecorder.start();
    startTime = Date.now();
    timerInterval = setInterval(() => {
      timerEl.textContent = formatTime((Date.now() - startTime) / 1000);
    }, 250);

    recordBtn.disabled = true;
    stopBtn.disabled = false;
    micOrb.classList.add("recording");
    setStatus("Recording...");
  } catch (err) {
    console.error(err);
    setStatus("Microphone blocked");
    outputHint.textContent = "Microphone permission is required. Check your browser permissions and try again.";
  }
});

stopBtn.addEventListener("click", () => {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;
  mediaRecorder.stop();
  clearInterval(timerInterval);
  recordBtn.disabled = false;
  stopBtn.disabled = true;
  micOrb.classList.remove("recording");
});

document.querySelectorAll(".preset").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".preset").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    pitch.value = btn.dataset.pitch;
    brightness.value = btn.dataset.brightness;
    updateLabels();
  });
});

async function decodeAudio(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    return await ctx.decodeAudioData(arrayBuffer);
  } finally {
    // The decoded AudioBuffer is independent of the context.
    await ctx.close();
  }
}

function renderWav(buffer) {
  const channels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = length * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < channels; ch++) {
      let sample = buffer.getChannelData(ch)[i];
      sample = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([out], { type: "audio/wav" });
}

async function applyEffect(buffer) {
  // Pitching is performed by changing playback detune in an OfflineAudioContext.
  // A gentle EQ curve adds brightness. This is a browser-only demo effect.
  const semitones = Number(pitch.value);
  const bright = Number(brightness.value) / 100;
  const rate = Number(speed.value);

  const sourceDuration = buffer.duration / rate;
  const offline = new OfflineAudioContext(
    buffer.numberOfChannels,
    Math.ceil(buffer.sampleRate * sourceDuration),
    buffer.sampleRate
  );

  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.detune.value = semitones * 100;
  source.playbackRate.value = rate;

  const highpass = offline.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 120 + bright * 120;

  const presence = offline.createBiquadFilter();
  presence.type = "peaking";
  presence.frequency.value = 2800;
  presence.Q.value = 0.8;
  presence.gain.value = 1 + bright * 5;

  const air = offline.createBiquadFilter();
  air.type = "highshelf";
  air.frequency.value = 5000;
  air.gain.value = bright * 5;

  source.connect(highpass);
  highpass.connect(presence);
  presence.connect(air);
  air.connect(offline.destination);

  source.start(0);
  return await offline.startRendering();
}

applyBtn.addEventListener("click", async () => {
  if (!rawBlob) return;

  applyBtn.disabled = true;
  setStatus("Processing...");
  outputHint.textContent = "Applying the voice effect in your browser...";

  try {
    const decoded = await decodeAudio(rawBlob);
    const processed = await applyEffect(decoded);
    const wav = renderWav(processed);

    if (outputUrl) URL.revokeObjectURL(outputUrl);
    outputUrl = URL.createObjectURL(wav);

    audioPlayer.src = outputUrl;
    downloadBtn.href = outputUrl;
    downloadBtn.download = "girl-voice.wav";
    downloadBtn.classList.remove("disabled");

    setStatus("Done");
    outputHint.textContent = "Your processed voice is ready.";
  } catch (err) {
    console.error(err);
    setStatus("Processing failed");
    outputHint.textContent = "This browser could not process the recording. Try Chrome or Edge.";
  } finally {
    applyBtn.disabled = false;
  }
});
