-- ════════════════════════════════════════════════════════════════════════════
-- F1 (bản phái sinh Sata Robo) — hai cột phục vụ đăng nhập một lần từ site Sata.
--
-- CHẠY THẾ NÀO:
--   docker compose exec -T app sh -lc "npx prisma migrate deploy"
--   docker compose restart app
--
-- THUẦN THÊM: hai cột NULLABLE + hai ràng buộc duy nhất. Không đụng cột nào đang
-- có, không đổi kiểu, không xoá. Dữ liệu cũ chạy y như trước, chỉ là chưa nhận SSO
-- cho tới khi người vận hành đặt `code` cho tổ chức.
-- Lăn ngược = bỏ hai ràng buộc rồi bỏ hai cột.
-- ════════════════════════════════════════════════════════════════════════════

-- Mã tổ chức ổn định, người vận hành đặt. Vé SSO đối chiếu bằng mã này chứ không
-- bằng uuid (uuid đổi mỗi lần dựng lại máy chủ, và không ai gõ được).
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "code" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_code_key" ON "organizations"("code");

-- Khoá đối chiếu người dùng: = User.id bên Sata (claim `sub` của vé SSO).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "external_id" TEXT;

-- Duy nhất TRONG MỘT TỔ CHỨC, không toàn cục: một nhân viên phụ trách hai cơ sở thì
-- có hai tài khoản, mỗi org một cái.
-- NULL không tính vào ràng buộc duy nhất của Postgres, nên mọi tài khoản tạo tay
-- (chưa có external_id) cùng tồn tại bình thường.
CREATE UNIQUE INDEX IF NOT EXISTS "users_org_id_external_id_key"
  ON "users"("org_id", "external_id");
