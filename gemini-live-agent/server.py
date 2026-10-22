"""MVP voice assistant kiểu Gemini Live, chạy trên máy local, truy cập dữ liệu cá nhân.

Điện thoại (browser) <-WebSocket-> server.py <-Live API-> Gemini
                                     |
                                     +-> tools.py (đọc DATA_DIR, gọi AGENT_URL)

API key chỉ nằm trên server, không bao giờ gửi xuống điện thoại.
"""

import asyncio
import hmac
import json
import logging
import os
import ssl
from pathlib import Path

from aiohttp import WSMsgType, web
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

from google import genai  # noqa: E402
import google.genai.errors  # noqa: E402,F401
from google.genai import types  # noqa: E402

import tools  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("live")

API_KEY = os.environ.get("GEMINI_API_KEY", "")
MODEL = os.environ.get("GEMINI_LIVE_MODEL", "").strip()
VOICE = os.environ.get("GEMINI_VOICE", "").strip()
PASSCODE = os.environ.get("APP_PASSCODE", "")
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))
STATIC = Path(__file__).parent / "static"

client = genai.Client(api_key=API_KEY)

BASE_PROMPT = """Bạn là trợ lý giọng nói cá nhân của người dùng, trả lời bằng tiếng Việt,
ngắn gọn, tự nhiên như nói chuyện. Khi câu hỏi liên quan đến thông tin cá nhân,
lịch, ghi chú, công việc của người dùng: LUÔN gọi tool search_notes / read_file
trước khi trả lời, đừng đoán. Nếu không tìm thấy thì nói thẳng là không có dữ liệu."""


def build_config(resume_handle: str | None) -> types.LiveConnectConfig:
    system = BASE_PROMPT
    profile = tools.load_profile()
    if profile:
        system += "\n\n# Hồ sơ người dùng\n" + profile
    cfg = dict(
        response_modalities=["AUDIO"],
        system_instruction=system,
        tools=[{"function_declarations": tools.TOOL_DECLARATIONS}],
        input_audio_transcription={},
        output_audio_transcription={},
        # Không có 2 dòng này, session audio bị cắt sau ~15 phút.
        context_window_compression={"sliding_window": {}},
        session_resumption={"handle": resume_handle},
    )
    if VOICE:
        cfg["speech_config"] = {"voice_config": {"prebuilt_voice_config": {"voice_name": VOICE}}}
    return types.LiveConnectConfig(**cfg)


async def pick_model() -> str:
    """Nếu chưa set GEMINI_LIVE_MODEL, lấy model đầu tiên hỗ trợ Live API."""
    live = []
    async for m in await client.aio.models.list():
        if "bidiGenerateContent" in (m.supported_actions or []):
            live.append(m.name.removeprefix("models/"))
    if not live:
        raise SystemExit("Không tìm thấy model nào hỗ trợ Live API với API key này.")
    log.info("Model hỗ trợ Live API: %s", ", ".join(live))
    native = [m for m in live if "native-audio" in m or "live" in m]
    return (native or live)[0]


async def handle_tool_call(session, tool_call, ws):
    responses = []
    for fc in tool_call.function_calls:
        await ws.send_json({"type": "tool", "name": fc.name, "args": fc.args or {}})
        result = await asyncio.to_thread(tools.run_tool, fc.name, fc.args or {})
        log.info("tool %s(%s) -> %s", fc.name, fc.args, str(result)[:200])
        responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response=result))
    await session.send_tool_response(function_responses=responses)


async def gemini_to_browser(session, ws, state):
    """Đọc message từ Gemini, đẩy audio/transcript xuống browser. Trả về khi session kết thúc."""
    while True:
        async for msg in session.receive():
            if msg.session_resumption_update and msg.session_resumption_update.new_handle:
                state["handle"] = msg.session_resumption_update.new_handle
            if msg.go_away:
                log.info("go_away, còn %s -> reconnect", msg.go_away.time_left)
                return
            if msg.tool_call:
                await handle_tool_call(session, msg.tool_call, ws)
            sc = msg.server_content
            if not sc:
                continue
            if sc.interrupted:
                await ws.send_json({"type": "interrupted"})
            if sc.model_turn:
                for part in sc.model_turn.parts or []:
                    if part.inline_data and part.inline_data.data:
                        await ws.send_bytes(part.inline_data.data)
            if sc.input_transcription and sc.input_transcription.text:
                await ws.send_json({"type": "user_text", "text": sc.input_transcription.text})
            if sc.output_transcription and sc.output_transcription.text:
                await ws.send_json({"type": "model_text", "text": sc.output_transcription.text})
            if sc.turn_complete:
                await ws.send_json({"type": "turn_complete"})


async def browser_to_gemini(session, ws):
    """Đọc audio PCM16 16kHz (binary) hoặc text (JSON) từ browser, gửi lên Gemini."""
    async for m in ws:
        if m.type == WSMsgType.BINARY:
            await session.send_realtime_input(
                audio=types.Blob(data=m.data, mime_type="audio/pcm;rate=16000")
            )
        elif m.type == WSMsgType.TEXT:
            data = json.loads(m.data)
            if data.get("type") == "text" and data.get("text"):
                await session.send_realtime_input(text=data["text"])
            elif data.get("type") == "audio_end":
                await session.send_realtime_input(audio_stream_end=True)
        elif m.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
            break


async def ws_handler(request: web.Request):
    if PASSCODE and not hmac.compare_digest(request.query.get("key", ""), PASSCODE):
        raise web.HTTPUnauthorized(text="sai passcode")
    ws = web.WebSocketResponse(max_msg_size=4 * 1024 * 1024, heartbeat=20)
    await ws.prepare(request)
    state = {"handle": None}
    model = request.app["model"]
    log.info("client kết nối, model=%s", model)
    failures = 0
    try:
        # Mỗi vòng lặp = 1 Live session. Khi Gemini đóng session (go_away / hết hạn / rớt mạng),
        # reconnect bằng resumption handle để giữ ngữ cảnh hội thoại.
        while not ws.closed:
            try:
                async with client.aio.live.connect(model=model, config=build_config(state["handle"])) as session:
                    await ws.send_json({"type": "status", "text": "connected"})
                    up = asyncio.create_task(browser_to_gemini(session, ws))
                    down = asyncio.create_task(gemini_to_browser(session, ws, state))
                    done, pending = await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
                    for t in pending:
                        t.cancel()
                    for t in done:
                        if t.exception():
                            raise t.exception()
                    if up in done:  # browser đóng kết nối
                        break
                    failures = 0
            except genai.errors.APIError as e:
                failures += 1
                if not state["handle"] or failures > 3:
                    raise
                log.warning("Live session đóng (%s), reconnect lần %d", e, failures)
            if not ws.closed:
                await ws.send_json({"type": "status", "text": "reconnecting"})
    except Exception as e:
        log.exception("session lỗi")
        if not ws.closed:
            await ws.send_json({"type": "error", "text": f"{type(e).__name__}: {e}"})
    finally:
        await ws.close()
        log.info("client ngắt kết nối")
    return ws


async def index(_):
    return web.FileResponse(STATIC / "index.html")


async def on_startup(app):
    app["model"] = MODEL or await pick_model()
    log.info("Dùng model: %s | DATA_DIR=%s | tools=%s", app["model"], tools.DATA_DIR,
             [t["name"] for t in tools.TOOL_DECLARATIONS])


def make_app() -> web.Application:
    app = web.Application()
    app.on_startup.append(on_startup)
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_static("/static", STATIC)
    return app


def main():
    if not API_KEY:
        raise SystemExit("Thiếu GEMINI_API_KEY trong .env")
    if not PASSCODE:
        log.warning("APP_PASSCODE trống: ai vào được URL cũng hỏi được dữ liệu của bạn!")
    app = make_app()

    ssl_ctx = None
    cert, key = os.environ.get("SSL_CERT"), os.environ.get("SSL_KEY")
    if cert and key:
        ssl_ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ssl_ctx.load_cert_chain(cert, key)
    web.run_app(app, host=HOST, port=PORT, ssl_context=ssl_ctx)


if __name__ == "__main__":
    main()
