# My Live: trợ lý giọng nói kiểu Gemini Live, đọc được dữ liệu cá nhân

Đây là bản MVP. Server Python chạy trên máy của bạn và giữ API key. Điện thoại mở một trang web, nói chuyện handsfree. Khi bạn hỏi về thông tin cá nhân, Gemini tự gọi tool (function calling) để đọc file trong `data/` hoặc gọi AI agent local của bạn.

```
Điện thoại (browser) ⇄ WebSocket ⇄ server.py (máy bạn) ⇄ Gemini Live API
                                        └─ tools.py: search_notes / read_file / ask_agent
```

## Chạy

```bash
cd gemini-live-agent
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env    # điền GEMINI_API_KEY và APP_PASSCODE
python server.py
```

Khi khởi động, log in ra danh sách model hỗ trợ Live API mà key của bạn dùng được. Muốn chọn đúng model (ví dụ Gemini 3.8 Live) thì copy tên model đó vào `GEMINI_LIVE_MODEL`.

Test trên máy tính: mở `http://localhost:8000`, bấm vào quả cầu, nhập passcode rồi nói.

## Mở trên điện thoại (cần HTTPS)

Browser chỉ cho dùng mic trên `https://` hoặc `localhost`, nên mở `http://192.168.x.x:8000` từ điện thoại sẽ bị chặn mic. Có 2 cách dễ:

- **Tailscale** (khuyên dùng, vì chỉ thiết bị của bạn vào được): cài Tailscale trên máy tính và điện thoại, rồi chạy `tailscale serve 8000`. Mở URL `https://<tên-máy>.<tailnet>.ts.net` trên điện thoại.
- **Cloudflare quick tunnel**: chạy `cloudflared tunnel --url http://localhost:8000` rồi mở URL `https://...trycloudflare.com`. URL này public, nên bắt buộc đặt `APP_PASSCODE` mạnh.

Mẹo: trong Chrome Android, chọn "Add to Home screen" để mở trang như một app.

## Đưa dữ liệu cá nhân vào

- `data/profile.md`: thông tin ngắn, luôn được nhét vào system prompt.
- Các file `.md/.txt/.json/.csv/...` khác trong `DATA_DIR`: model tìm bằng `search_notes` và đọc bằng `read_file` khi cần. Bạn có thể trỏ `DATA_DIR` tới thư mục Obsidian/notes sẵn có.
- **AI agent local**: đặt `AGENT_URL=http://localhost:xxxx/ask`. Server sẽ POST `{"question": "..."}` tới đó, và agent trả về JSON hoặc text. Khi biến này có giá trị, tool `ask_agent` mới được bật.
- **Thêm tool mới**: viết hàm trong `tools.py`, rồi thêm vào `TOOL_DECLARATIONS` và `TOOL_HANDLERS`.

## Giới hạn của MVP

- Màn hình phải bật, vì trang đã xin Wake Lock. Khi khóa máy, browser cắt mic. Muốn chạy nền thật sự thì cần app native.
- `search_notes` chỉ là keyword match, chưa phải semantic search. Với dữ liệu lớn, nên cho `ask_agent` gọi agent/RAG của bạn.
- Mỗi Live session có giới hạn thời gian. Server đã bật context window compression và session resumption để tự reconnect mà vẫn giữ ngữ cảnh.
