const $ = (s) => document.querySelector(s);
const orb = $("#orb");
const statusEl = $("#status");
const log = $("#log");

let ws = null;
let micCtx, micStream, micNode;
let playCtx, playHead = 0;
let playing = new Set();
let muted = false;
let wakeLock = null;
let lastBubble = { role: null, el: null };

function setStatus(text, state) {
  statusEl.textContent = text;
  orb.dataset.state = state || "";
}

function bubble(role, text, append = true) {
  if (append && lastBubble.role === role && lastBubble.el) {
    lastBubble.el.textContent += text;
  } else {
    const el = document.createElement("div");
    el.className = "msg " + role;
    el.textContent = text;
    log.appendChild(el);
    lastBubble = { role, el };
  }
  log.scrollTop = log.scrollHeight;
}

function getKey() {
  let k = "";
  try { k = localStorage.getItem("passcode") || ""; } catch {}
  if (!k) {
    k = prompt("Passcode (APP_PASSCODE trong .env):") || "";
    try { localStorage.setItem("passcode", k); } catch {}
  }
  return k;
}

// ---------- Playback: PCM16 24kHz ----------
function playPcm(buf) {
  const pcm = new Int16Array(buf);
  const audio = playCtx.createBuffer(1, pcm.length, 24000);
  const ch = audio.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
  const src = playCtx.createBufferSource();
  src.buffer = audio;
  src.connect(playCtx.destination);
  playHead = Math.max(playHead, playCtx.currentTime + 0.05);
  src.start(playHead);
  playHead += audio.duration;
  playing.add(src);
  src.onended = () => {
    playing.delete(src);
    if (!playing.size && ws) setStatus("Đang nghe…", "listening");
  };
  setStatus("Đang nói…", "speaking");
}

function stopPlayback() {
  for (const s of playing) { try { s.stop(); } catch {} }
  playing.clear();
  playHead = 0;
}

// ---------- Session ----------
async function start() {
  const key = getKey();
  setStatus("Đang kết nối…", "connecting");

  // AudioContext phải tạo trong user gesture (iOS Safari)
  playCtx = new AudioContext({ sampleRate: 24000 });
  micCtx = new AudioContext();
  await micCtx.audioWorklet.addModule("/static/capture-worklet.js");
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const srcNode = micCtx.createMediaStreamSource(micStream);
  micNode = new AudioWorkletNode(micCtx, "capture-processor");
  micNode.port.onmessage = (e) => {
    if (!muted && ws && ws.readyState === WebSocket.OPEN) ws.send(e.data);
  };
  srcNode.connect(micNode);

  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?key=${encodeURIComponent(key)}`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) return playPcm(e.data);
    const m = JSON.parse(e.data);
    if (m.type === "status") setStatus(m.text === "connected" ? "Đang nghe…" : "Đang kết nối lại…",
      m.text === "connected" ? "listening" : "connecting");
    else if (m.type === "user_text") bubble("user", m.text);
    else if (m.type === "model_text") bubble("model", m.text);
    else if (m.type === "tool") bubble("tool", `🔧 ${m.name}(${JSON.stringify(m.args)})`, false);
    else if (m.type === "interrupted") stopPlayback();
    else if (m.type === "turn_complete") lastBubble = { role: null, el: null };
    else if (m.type === "error") bubble("tool", "⚠️ " + m.text, false);
  };
  ws.onclose = (e) => {
    if (!e.target._opened) {
      try { localStorage.removeItem("passcode"); } catch {}
      bubble("tool", "⚠️ Không kết nối được (sai passcode hoặc server tắt).", false);
    }
    stop();
  };
  ws.onopen = () => { ws._opened = true; };

  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}

function stop() {
  const w = ws;
  ws = null;
  if (w && w.readyState <= 1) w.close();
  stopPlayback();
  micStream?.getTracks().forEach((t) => t.stop());
  micCtx?.close();
  playCtx?.close();
  micCtx = playCtx = micStream = micNode = null;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  setStatus("Chạm để bắt đầu", "");
}

orb.onclick = () => (ws ? stop() : start().catch((err) => {
  bubble("tool", "⚠️ " + err.message, false);
  stop();
}));

$("#mute").onclick = (e) => {
  muted = !muted;
  e.target.textContent = muted ? "🔇 Mic tắt" : "🎙️ Mic bật";
};

$("#textForm").onsubmit = (e) => {
  e.preventDefault();
  const t = $("#text").value.trim();
  if (!t || !ws || ws.readyState !== WebSocket.OPEN) return;
  bubble("user", t, false);
  lastBubble = { role: null, el: null };
  ws.send(JSON.stringify({ type: "text", text: t }));
  $("#text").value = "";
};

// Màn hình tắt rồi bật lại thì wake lock bị nhả, xin lại
document.addEventListener("visibilitychange", async () => {
  if (ws && document.visibilityState === "visible") {
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  }
});

if (!window.isSecureContext) {
  bubble("tool", "⚠️ Trang không chạy HTTPS nên browser sẽ chặn mic. Xem README phần HTTPS.", false);
}
