"""Tools mà Gemini Live được phép gọi để đọc dữ liệu cá nhân trên máy local.

Thêm tool mới: viết 1 hàm Python trả về dict/str, khai báo trong TOOL_DECLARATIONS
và đăng ký trong TOOL_HANDLERS. Model sẽ tự quyết định khi nào gọi.
"""

import json
import os
import urllib.request
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).parent / "data")).resolve()
AGENT_URL = os.environ.get("AGENT_URL", "").strip()
TEXT_EXTS = {".md", ".txt", ".json", ".csv", ".yaml", ".yml", ".log", ".org", ".html"}
MAX_READ_CHARS = 20_000
MAX_HITS = 20


def _safe_path(rel: str) -> Path:
    p = (DATA_DIR / rel).resolve()
    if p != DATA_DIR and DATA_DIR not in p.parents:
        raise ValueError("path nằm ngoài DATA_DIR")
    return p


def _text_files():
    for p in sorted(DATA_DIR.rglob("*")):
        if p.is_file() and p.suffix.lower() in TEXT_EXTS:
            yield p


def list_files() -> dict:
    files = [
        {"path": str(p.relative_to(DATA_DIR)), "bytes": p.stat().st_size}
        for p in _text_files()
    ]
    return {"files": files[:500], "total": len(files)}


def search_notes(query: str) -> dict:
    terms = [t.lower() for t in query.split() if t.strip()]
    if not terms:
        return {"hits": []}
    hits = []
    for p in _text_files():
        try:
            lines = p.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            continue
        for i, line in enumerate(lines):
            low = line.lower()
            if all(t in low for t in terms):
                ctx = "\n".join(lines[max(0, i - 2): i + 3])
                hits.append({"path": str(p.relative_to(DATA_DIR)), "line": i + 1, "context": ctx})
                if len(hits) >= MAX_HITS:
                    return {"hits": hits, "truncated": True}
    return {"hits": hits}


def read_file(path: str) -> dict:
    p = _safe_path(path)
    if not p.is_file():
        return {"error": f"không tìm thấy file: {path}"}
    text = p.read_text(encoding="utf-8", errors="ignore")
    return {"path": path, "content": text[:MAX_READ_CHARS], "truncated": len(text) > MAX_READ_CHARS}


def ask_agent(question: str) -> dict:
    """Chuyển câu hỏi sang AI agent cá nhân đang chạy local (nếu có AGENT_URL)."""
    if not AGENT_URL:
        return {"error": "chưa cấu hình AGENT_URL"}
    req = urllib.request.Request(
        AGENT_URL,
        data=json.dumps({"question": question}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read().decode("utf-8", errors="ignore")
    try:
        return {"answer": json.loads(body)}
    except json.JSONDecodeError:
        return {"answer": body[:MAX_READ_CHARS]}


TOOL_DECLARATIONS = [
    {
        "name": "list_files",
        "description": "Liệt kê các file ghi chú/dữ liệu cá nhân của người dùng.",
    },
    {
        "name": "search_notes",
        "description": "Tìm theo từ khóa trong dữ liệu cá nhân của người dùng. "
        "Dùng khi người dùng hỏi về thông tin, lịch, ghi chú, công việc của họ.",
        "parameters": {
            "type": "OBJECT",
            "properties": {"query": {"type": "STRING", "description": "Từ khóa ngắn, ví dụ 'họp thứ 3'"}},
            "required": ["query"],
        },
    },
    {
        "name": "read_file",
        "description": "Đọc toàn bộ nội dung 1 file dữ liệu cá nhân (path lấy từ list_files hoặc search_notes).",
        "parameters": {
            "type": "OBJECT",
            "properties": {"path": {"type": "STRING"}},
            "required": ["path"],
        },
    },
]
if AGENT_URL:
    TOOL_DECLARATIONS.append(
        {
            "name": "ask_agent",
            "description": "Hỏi AI agent cá nhân của người dùng chạy trên máy local. "
            "Dùng cho việc cần agent xử lý (tra cứu sâu, thực thi tác vụ).",
            "parameters": {
                "type": "OBJECT",
                "properties": {"question": {"type": "STRING"}},
                "required": ["question"],
            },
        }
    )

TOOL_HANDLERS = {
    "list_files": list_files,
    "search_notes": search_notes,
    "read_file": read_file,
    "ask_agent": ask_agent,
}


def run_tool(name: str, args: dict) -> dict:
    fn = TOOL_HANDLERS.get(name)
    if fn is None:
        return {"error": f"tool không tồn tại: {name}"}
    try:
        result = fn(**(args or {}))
    except Exception as e:  # trả lỗi về cho model thay vì làm sập session
        return {"error": f"{type(e).__name__}: {e}"}
    return result if isinstance(result, dict) else {"result": result}


def load_profile() -> str:
    """profile.md được nhét thẳng vào system instruction (giữ ngắn, < vài KB)."""
    p = DATA_DIR / "profile.md"
    return p.read_text(encoding="utf-8", errors="ignore")[:8000] if p.is_file() else ""
