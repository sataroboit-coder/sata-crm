-- ════════════════════════════════════════════════════════════════════════════
-- F2 (bản phái sinh Sata Robo) — hàng đợi gửi webhook, thay cho "bắn rồi quên".
--
-- CHẠY THẾ NÀO:
--   docker compose exec -T app sh -lc "npx prisma migrate deploy"
--   docker compose restart app
--
-- THUẦN THÊM: một bảng mới, không đụng bảng nào đang có.
-- Lăn ngược = DROP TABLE "webhook_outbox".
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "webhook_outbox" (
    "id"     TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "event"  TEXT NOT NULL,

    -- Chuỗi JSON ĐÃ serialize. Chữ ký HMAC tính trên chính chuỗi này, nên phải lưu
    -- nguyên văn: ký lại từ object thì lần thử sau có thể ra chữ ký khác và bị 401.
    "payload" TEXT NOT NULL,
    "url"     TEXT NOT NULL,

    "status"          TEXT NOT NULL DEFAULT 'pending',
    "attempts"        INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL,
    "last_status"     INTEGER,
    "last_error"      TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at"    TIMESTAMP(3),

    CONSTRAINT "webhook_outbox_pkey" PRIMARY KEY ("id")
);

-- Người thử lại quét đúng theo cặp này.
CREATE INDEX IF NOT EXISTS "webhook_outbox_status_next_attempt_at_idx"
  ON "webhook_outbox"("status", "next_attempt_at");

-- Xem lịch sử theo tổ chức khi đi dò sự cố.
CREATE INDEX IF NOT EXISTS "webhook_outbox_org_id_created_at_idx"
  ON "webhook_outbox"("org_id", "created_at");
