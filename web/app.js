// My Live: bản chạy hoàn toàn trên trình duyệt, nói chuyện trực tiếp với Gemini Live API.
// API key, hồ sơ và dữ liệu cá nhân chỉ lưu trong localStorage của máy này.

const $ = (s) => document.querySelector(s);
const orb = $("#orb");
const statusEl = $("#status");
const log = $("#log");

const LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_READ_CHARS = 20000;

// ---------- Storage ----------
function load(key, fallback) {
  try { const v = localStorage.getItem("mylive." + key); return v === null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem("mylive." + key, JSON.stringify(value)); return true; }
  catch { return false; }
}
let settings = load("settings", { apiKey: "", model: "", voice: "", profile: "", agentUrl: "" });
let notes = load("notes", {}); // { "ten-file.md": "nội dung" }

// ---------- UI helpers ----------
let lastBubble = { role: null, el: null };
function setStatus(text, state) { statusEl.textContent = text; orb.dataset.state = state || ""; }
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
const note = (t) => { bubble("tool", t, false); lastBubble = { role: null, el: null }; };

// ---------- Tools (chạy ngay trong trình duyệt) ----------
const TOOL_DECLARATIONS = [
  { name: "list_files", description: "Liệt kê các file dữ liệu cá nhân của người dùng." },
  {
    name: "search_notes",
    description: "Tìm theo từ khóa trong dữ liệu cá nhân của người dùng. Dùng khi người dùng hỏi về thông tin, lịch, ghi chú, công việc của họ.",
    parameters: { type: "OBJECT", properties: { query: { type: "STRING", description: "Từ khóa ngắn" } }, required: ["query"] },
  },
  {
    name: "read_file",
    description: "Đọc nội dung 1 file dữ liệu cá nhân (tên lấy từ list_files hoặc search_notes).",
    parameters: { type: "OBJECT", properties: { path: { type: "STRING" } }, required: ["path"] },
  },
];
const AGENT_TOOL = {
  name: "ask_agent",
  description: "Hỏi AI agent cá nhân của người dùng. Dùng cho việc cần agent xử lý (tra cứu sâu, thực thi tác vụ).",
  parameters: { type: "OBJECT", properties: { question: { type: "STRING" } }, required: ["question"] },
};

const tools = {
  list_files: () => ({ files: Object.keys(notes).map((n) => ({ path: n, chars: notes[n].length })) }),
  search_notes: ({ query }) => {
    const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const hits = [];
    for (const [path, text] of Object.entries(notes)) {
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (hits.length < 20 && terms.length && terms.every((t) => line.toLowerCase().includes(t))) {
          hits.push({ path, line: i + 1, context: lines.slice(Math.max(0, i - 2), i + 3).join("\n") });
        }
      });
    }
    return { hits };
  },
  read_file: ({ path }) => notes[path] !== undefined
    ? { path, content: notes[path].slice(0, MAX_READ_CHARS), truncated: notes[path].length > MAX_READ_CHARS }
    : { error: "không tìm thấy file: " + path },
  ask_agent: async ({ question }) => {
    const r = await fetch(settings.agentUrl, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }),
    });
    const body = await r.text();
    try { return { answer: JSON.parse(body) }; } catch { return { answer: body.slice(0, MAX_READ_CHARS) }; }
  },
};

async function runTool(name, args) {
  try {
    if (!tools[name]) return { error: "tool không tồn tại: " + name };
    const res = await tools[name](args || {});
    return res && typeof res === "object" ? res : { result: res };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

function systemPrompt() {
  let s = `Bạn là trợ lý giọng nói cá nhân của người dùng, trả lời bằng tiếng Việt, ngắn gọn, tự nhiên như nói chuyện.
Khi câu hỏi liên quan đến thông tin cá nhân, lịch, ghi chú, công việc của người dùng: LUÔN gọi search_notes / read_file trước khi trả lời, đừng đoán.
Nếu không tìm thấy thì nói thẳng là không có dữ liệu.`;
  if (settings.profile.trim()) s += "\n\n# Hồ sơ người dùng\n" + settings.profile.trim();
  return s;
}

// ---------- Audio ----------
let micCtx, micStream, playCtx, playHead = 0;
const playing = new Set();
let muted = false;

function b64FromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function bufferFromB64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

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
    if (!playing.size && active) setStatus("Đang nghe…", "listening");
  };
  setStatus("Đang nói…", "speaking");
}
function stopPlayback() {
  for (const s of playing) { try { s.stop(); } catch {} }
  playing.clear();
  playHead = 0;
}

// ---------- Live session ----------
const decoder = new TextDecoder();
let ws = null, active = false, ready = false, resumeHandle = null, retries = 0, wakeLock = null;

function sendJson(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

function connect() {
  ready = false;
  const decls = settings.agentUrl ? [...TOOL_DECLARATIONS, AGENT_TOOL] : TOOL_DECLARATIONS;
  const setup = {
    model: "models/" + settings.model,
    generationConfig: { responseModalities: ["AUDIO"] },
    systemInstruction: { parts: [{ text: systemPrompt() }] },
    tools: [{ functionDeclarations: decls }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Không có 2 dòng này, session audio bị cắt sau ~15 phút
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
  };
  if (settings.voice) {
    setup.generationConfig.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voice } } };
  }

  const sock = new WebSocket(`${LIVE_URL}?key=${encodeURIComponent(settings.apiKey)}`);
  ws = sock;
  sock.binaryType = "arraybuffer"; // decode đồng bộ để giữ đúng thứ tự message
  sock.onopen = () => sock.send(JSON.stringify({ setup }));
  sock.onmessage = (e) => {
    const raw = typeof e.data === "string" ? e.data : decoder.decode(e.data);
    handleServer(JSON.parse(raw));
  };
  sock.onclose = (e) => {
    if (ws !== sock || !active) return;
    // Gemini đóng session (hết hạn / go_away / rớt mạng): nối lại bằng resumption handle
    if (resumeHandle && retries < 3) {
      retries++;
      setStatus("Đang kết nối lại…", "connecting");
      setTimeout(connect, 500);
      return;
    }
    note(`⚠️ Kết nối đóng (${e.code}) ${e.reason || ""}`.trim());
    stop();
  };
}

async function handleServer(m) {
  if (m.setupComplete) {
    ready = true;
    retries = 0;
    setStatus("Đang nghe…", "listening");
  }
  if (m.sessionResumptionUpdate?.newHandle) resumeHandle = m.sessionResumptionUpdate.newHandle;
  if (m.goAway) { try { ws.close(); } catch {} return; }
  if (m.toolCall) {
    const functionResponses = [];
    for (const fc of m.toolCall.functionCalls || []) {
      note(`🔧 ${fc.name}(${JSON.stringify(fc.args || {})})`);
      functionResponses.push({ id: fc.id, name: fc.name, response: await runTool(fc.name, fc.args) });
    }
    sendJson({ toolResponse: { functionResponses } });
  }
  const sc = m.serverContent;
  if (!sc) return;
  if (sc.interrupted) stopPlayback();
  for (const part of sc.modelTurn?.parts || []) {
    if (part.inlineData?.data) playPcm(bufferFromB64(part.inlineData.data));
  }
  if (sc.inputTranscription?.text) bubble("user", sc.inputTranscription.text);
  if (sc.outputTranscription?.text) bubble("model", sc.outputTranscription.text);
  if (sc.turnComplete) lastBubble = { role: null, el: null };
}

async function start() {
  if (!settings.apiKey || !settings.model) { openSettings(); note("Nhập API key và chọn model trước."); return; }
  active = true;
  resumeHandle = null;
  retries = 0;
  setStatus("Đang kết nối…", "connecting");

  // AudioContext phải tạo trong user gesture
  playCtx = new AudioContext({ sampleRate: 24000 });
  micCtx = new AudioContext();
  await micCtx.audioWorklet.addModule("capture-worklet.js");
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const node = new AudioWorkletNode(micCtx, "capture-processor");
  node.port.onmessage = (e) => {
    if (ready && !muted) sendJson({ realtimeInput: { audio: { data: b64FromBuffer(e.data), mimeType: "audio/pcm;rate=16000" } } });
  };
  micCtx.createMediaStreamSource(micStream).connect(node);

  connect();
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}

function stop() {
  active = false;
  ready = false;
  const sock = ws;
  ws = null;
  if (sock && sock.readyState <= 1) sock.close();
  stopPlayback();
  micStream?.getTracks().forEach((t) => t.stop());
  micCtx?.close().catch(() => {});
  playCtx?.close().catch(() => {});
  micCtx = playCtx = micStream = null;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  setStatus("Chạm để bắt đầu", "");
}

orb.onclick = () => (active ? stop() : start().catch((err) => { note("⚠️ " + err.message); stop(); }));

$("#mute").onclick = (e) => {
  muted = !muted;
  e.target.textContent = muted ? "🔇 Mic tắt" : "🎙️ Mic bật";
};

$("#textForm").onsubmit = (e) => {
  e.preventDefault();
  const t = $("#text").value.trim();
  if (!t) return;
  if (!ready) { note("Chạm quả cầu để kết nối trước."); return; }
  bubble("user", t, false);
  lastBubble = { role: null, el: null };
  sendJson({ realtimeInput: { text: t } });
  $("#text").value = "";
};

document.addEventListener("visibilitychange", async () => {
  if (active && document.visibilityState === "visible") {
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  }
});

// ---------- Settings ----------
function renderNotes() {
  const ul = $("#notes");
  ul.innerHTML = "";
  for (const name of Object.keys(notes)) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = `${name} (${notes[name].length.toLocaleString()} ký tự)`;
    const del = document.createElement("button");
    del.textContent = "Xóa";
    del.onclick = () => { delete notes[name]; save("notes", notes); renderNotes(); };
    li.append(span, del);
    ul.appendChild(li);
  }
  if (!ul.children.length) ul.innerHTML = '<li><span style="color:var(--muted)">Chưa có file nào</span></li>';
}

function setModelOptions(list, selected) {
  const sel = $("#model");
  sel.innerHTML = "";
  for (const m of list) {
    const o = document.createElement("option");
    o.value = m; o.textContent = m;
    sel.appendChild(o);
  }
  if (selected) sel.value = selected;
}

async function loadModels() {
  const key = $("#apiKey").value.trim();
  if (!key) { alert("Nhập API key trước."); return; }
  $("#loadModels").textContent = "Đang tải…";
  try {
    const r = await fetch(`${MODELS_URL}?pageSize=1000&key=${encodeURIComponent(key)}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || r.status);
    const live = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("bidiGenerateContent"))
      .map((m) => m.name.replace(/^models\//, ""));
    if (!live.length) throw new Error("Key này không có model nào hỗ trợ Live API");
    const prev = $("#model").value;
    const pick = live.includes(prev) ? prev : (live.find((m) => /live|native-audio/.test(m)) || live[0]);
    setModelOptions(live, pick);
    save("models", live);
  } catch (e) {
    alert("Không tải được danh sách model: " + e.message);
  } finally {
    $("#loadModels").textContent = "Tải danh sách";
  }
}

function openSettings() {
  $("#apiKey").value = settings.apiKey;
  setModelOptions(load("models", settings.model ? [settings.model] : []), settings.model);
  $("#voice").value = settings.voice;
  $("#profile").value = settings.profile;
  $("#agentUrl").value = settings.agentUrl;
  renderNotes();
  $("#settings").classList.add("open");
}

$("#openSettings").onclick = openSettings;
$("#closeSettings").onclick = () => $("#settings").classList.remove("open");
$("#loadModels").onclick = loadModels;
$("#apiKey").onchange = () => { if (!$("#model").value) loadModels(); };
$("#saveSettings").onclick = () => {
  settings = {
    apiKey: $("#apiKey").value.trim(),
    model: $("#model").value,
    voice: $("#voice").value,
    profile: $("#profile").value,
    agentUrl: $("#agentUrl").value.trim(),
  };
  if (!save("settings", settings)) alert("Không lưu được (trình duyệt chặn bộ nhớ?)");
  $("#settings").classList.remove("open");
  if (active) { note("Đã lưu. Dừng rồi bắt đầu lại để áp dụng."); }
};
$("#noteFiles").onchange = async (e) => {
  for (const f of e.target.files) notes[f.name] = await f.text();
  if (!save("notes", notes)) alert("Dữ liệu quá lớn so với bộ nhớ trình duyệt (~5MB).");
  e.target.value = "";
  renderNotes();
};

if (!settings.apiKey) openSettings();
