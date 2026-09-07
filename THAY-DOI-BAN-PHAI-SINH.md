# Thay đổi của bản phái sinh — Sata Robo

Tài liệu này ghi **những gì bản phái sinh sửa khác bản gốc**, theo yêu cầu nêu rõ thay đổi
của giấy phép AGPL-3.0 (§5a: bản sửa đổi phải mang thông báo nổi bật cho biết đã sửa và sửa ngày nào).

- **Bản gốc:** ZaloCRM của Nguyễn Tiến Lộc — <https://github.com/locphamnguyen/ZaloCRM>
- **Điểm rẽ nhánh:** tag `v3.4.0`, commit `8664567`
- **Nhánh phái sinh:** `feat/sata-sso`
- **Ngày sửa đầu tiên:** 07/09/2026

---

## 🔴 Nghĩa vụ CHƯA hoàn thành — đọc trước khi cho nhân viên dùng

Sửa mã xong là AGPL **§13** kích hoạt: hễ có người tương tác với bản này **qua mạng**, họ phải
được cấp mã nguồn của **chính bản đang chạy**. Chừng nào còn chạy trên máy dev, chưa ai ngoài
người vận hành tương tác qua mạng, thì chưa tới hạn. Nhưng **trước ngày Sale đầu tiên dùng thật**,
bốn việc dưới đây phải xong:

| # | Việc | Trạng thái |
|---|---|---|
| L1 | Đưa toàn bộ mã bản phái sinh lên một repo **công khai**, và đường dẫn đó phải tới được từ chính ứng dụng | ❌ chưa |
| L2 | Khôi phục link “Mã nguồn” ở màn đăng nhập, trỏ về repo công khai của bản phái sinh (bản gốc đã comment khối này lại) | ❌ chưa |
| L3 | **Giữ nguyên** banner ghi công tác giả và module `use-attribution.ts` — muốn gỡ thì phải mua giấy phép thương mại | ✅ chưa đụng tới |
| L4 | Đổi tên và logo sản phẩm (NOTICE §7(e): tên “ZaloCRM” và logo không dùng cho bản phái sinh) | ❌ chưa — **đang chờ chủ dự án chốt tên** |

L4 chặn L1: chưa có tên thì chưa đặt được tên repo công khai.

---

## Đã sửa gì

### F3 — cho phép nhúng trong iframe của site quản trị

| Tệp | Sửa |
|---|---|
| `backend/src/config/index.ts` | thêm `frameAncestors` đọc từ env `FRAME_ANCESTORS` (danh sách origin, ngăn bằng dấu phẩy) |
| `backend/src/shared/security/security-headers.ts` | `frame-ancestors` của CSP lấy theo danh sách đó; và **bỏ** `X-Frame-Options: DENY` khi danh sách khác rỗng |

Vì sao phải bỏ `X-Frame-Options`: header đó chỉ diễn đạt được `DENY`/`SAMEORIGIN`
(`ALLOW-FROM` đã chết ở mọi trình duyệt hiện đại), nên không nói nổi “cho phép đúng mấy origin này”.
Giữ cả hai thì `X-Frame-Options` thắng ở một số trình duyệt và khung vẫn trắng.

**Không khai `FRAME_ANCESTORS` ⇒ hành vi y hệt bản gốc** (`'none'` + `DENY`). Đây là cổng
mở-có-chủ-đích, không phải nới mặc định.

### F1 — đăng nhập một lần từ site quản trị Sata

| Tệp | Sửa |
|---|---|
| `backend/prisma/schema.prisma` | `Organization.code` (unique, nullable) · `User.externalId` + `@@unique([orgId, externalId])` |
| `backend/prisma/migrations/20260907133332_sata_sso_org_code_user_external_id/` | migration thuần thêm cho hai cột trên |
| `backend/src/config/index.ts` | thêm `sataSsoSecret` đọc từ env `SATA_SSO_SECRET` |
| `backend/src/modules/auth/sata-sso-service.ts` | **mới** — kiểm vé + tạo/cập nhật người dùng |
| `backend/src/modules/auth/auth-routes.ts` | thêm `POST /api/v1/auth/sso` |
| `frontend/src/stores/auth.ts` | thêm `ssoLogin(ticket)` (dùng lại khuôn `login()`) |
| `frontend/src/views/SsoView.vue` | **mới** — trang trung chuyển, đọc vé từ `#fragment` |
| `frontend/src/router/index.ts` | thêm route `/sso` (`public: true`) |

**Không khai `SATA_SSO_SECRET` ⇒ endpoint trả 404**, tức tính năng coi như không tồn tại.

Bốn lớp kiểm của vé, mỗi lớp chặn một kiểu tấn công:

1. chữ ký HS256 bằng bí mật chung, **ghim `algorithms: ['HS256']`** — chặn vé bịa và
   chặn lỗ kinh điển “đổi thuật toán”;
2. tuổi vé ≤ 60 giây, do **bên nhận ép** chứ không tin `exp` bên ký đặt;
3. `jti` dùng đúng một lần (Redis, `SET NX EX`) — chặn phát lại. **Redis chết thì TỪ CHỐI**,
   không âm thầm bỏ qua;
4. `orgCode` phải khớp một tổ chức có thật.

Ba chỗ cố ý fail-closed: vai lạ **không** rơi về `member` · tài khoản đã khoá **không** được vé
SSO mở lại · tài khoản sinh từ SSO mang `passwordHash` không phải bcrypt hợp lệ nên **không**
đăng nhập được bằng mật khẩu.

---

### F2 — webhook giàu ngữ cảnh + hàng đợi gửi lại

| Tệp | Sửa |
|---|---|
| `backend/prisma/schema.prisma` | bảng mới `WebhookOutbox` |
| `backend/prisma/migrations/20260907162806_sata_webhook_outbox/` | migration thuần thêm |
| `backend/src/modules/api/webhook-outbox.ts` | **mới** — xếp hàng, ký lúc giao, thử lại 1s/30s/5 phút |
| `backend/src/modules/api/sata-message-event.ts` | **mới** — dựng payload giàu ngữ cảnh |
| `backend/src/modules/api/webhook-service.ts` | `emitWebhook` xếp hàng thay vì “bắn rồi quên”; thêm lối thoát SSRF `WEBHOOK_ALLOW_LOOPBACK` **chỉ cho máy lẻ** |
| `backend/src/modules/chat/message-handler.ts` | payload giàu ngữ cảnh; **và bắn `message.sent` cho tin gõ trong giao diện** (nhánh guard 30 giây trước đây `return null` trước chỗ bắn) |
| `backend/src/modules/contacts/contact-routes.ts` | thêm sự kiện `contact.phone_set` |
| `backend/src/app.ts` | bật người thử lại lúc khởi động |
| `backend/src/config/index.ts` | thêm `webhookAllowLoopback` |

Ba điều đáng nhớ:

1. **Ký HMAC trên chuỗi payload ĐÃ LƯU**, không ký lại từ object — `JSON.stringify` không
   cam kết cho ra y hệt giữa hai lần, ký lại là lần thử thứ hai có chữ ký khác lần đầu và
   bên nhận trả 401.
2. **Chỉ 2xx mới tính là đã giao.** 4xx cũng thử lại đủ lượt: bên nhận có thể đang trả 401
   vì chưa kịp nạp khoá sau một lần triển khai.
3. **Tin Sale gõ trong giao diện ZaloCRM trước đây KHÔNG báo ra ngoài** — nhánh chống echo
   `return null` trước chỗ bắn webhook. Bên nhận vì thế không bao giờ biết Sale đã trả lời,
   và đồng hồ chăm sóc của phiếu cứ chạy như chưa ai làm gì.

🔴 `WEBHOOK_ALLOW_LOOPBACK=1` **chỉ dùng ở máy lẻ**. Bật trên máy chủ thật là mở đường cho
người trong tổ chức dò mạng nội bộ qua ô địa chỉ webhook.

---

## Chưa làm (các việc còn lại của kế hoạch tích hợp)

- **F4** — mở rộng Public API (giai đoạn 3).
- **F5** — nút “Tạo lead Sata” trong màn chat.
- **F6** — nghĩa vụ giấy phép (bảng ở trên).
- **F7** — khoá cứng tính năng AI bằng biến môi trường. Hiện mọi khoá AI để trống nên không
  có gì gọi ra ngoài, nhưng đó là *chưa cấu hình*, không phải *đã khoá*.
