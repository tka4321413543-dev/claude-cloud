# claude-cloud

- `web/`: **My Live**, trợ lý giọng nói kiểu Gemini Live, chạy hoàn toàn trên trình duyệt điện thoại. Không cần server. Được deploy lên GitHub Pages bằng `.github/workflows/pages.yml`.
- `gemini-live-agent/`: bản có server Python chạy trên máy local. Dùng khi cần đọc trực tiếp file hoặc agent trên máy tính.

## Dùng bản web

1. Mở URL GitHub Pages trên điện thoại (Chrome).
2. Vào ⚙️ Cài đặt, dán Gemini API key rồi bấm "Tải danh sách" để chọn model Live.
3. Điền hồ sơ cá nhân và upload file ghi chú (.md/.txt/.json/.csv), rồi bấm Lưu.
4. Chạm vào quả cầu, cho phép mic, rồi nói.

API key và dữ liệu chỉ lưu trong localStorage của trình duyệt trên máy đó. Không có gì được commit lên repo.
