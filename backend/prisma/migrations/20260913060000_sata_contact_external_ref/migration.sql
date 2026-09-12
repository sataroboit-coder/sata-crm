-- Bản phái sinh Sata (F4) — khoá bản ghi tương ứng bên hệ quản trị Sata.
-- THUẦN THÊM: cột nullable + một chỉ mục duy nhất. Không đụng dữ liệu đang có
-- (mọi dòng cũ nhận NULL, và NULL không tham gia ràng buộc duy nhất trong Postgres).
ALTER TABLE "contacts" ADD COLUMN "external_ref" TEXT;

CREATE UNIQUE INDEX "contacts_org_id_external_ref_key" ON "contacts"("org_id", "external_ref");
