// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
// Phần bổ sung của bản phái sinh: Copyright (C) 2026 Sata Robo
/**
 * Nhóm quyền mặc định cho tài khoản sinh từ vé SSO của Sata.
 *
 * ── 🔴 VÌ SAO TỆP NÀY PHẢI TỒN TẠI ─────────────────────────────────────────
 * `userHasGrant` (permission-group-service.ts) kết thúc bằng:
 *
 *     if (user.role === 'owner' || user.role === 'admin') return true;
 *     return false;
 *
 * Nghĩa là tài khoản KHÔNG có nhóm quyền và KHÔNG phải admin thì **không được gì cả**.
 * Đường SSO trước bản vá này tạo tài khoản với `permissionGroupId = null`, nên một tư
 * vấn viên vào tới nơi rồi nhận **403 ngay ở màn danh sách hội thoại** —
 * `GET /api/v1/conversations` là route duy nhất trong chat có `requireGrant`. Đo thật
 * ngày 13/09/2026: hai tài khoản sale thật, cả hai đều 403.
 *
 * Và chiều ngược lại cũng hỏng: cấp `role = 'admin'` cho quản lý cơ sở là đưa họ qua
 * dòng `return true` ở trên — tức toàn quyền trên `settings` (nơi chứa khoá Public API),
 * `permission_group`, `user`, `zalo_account`, `audit_log`. Bên Sata vì thế đã hạ quản lý
 * cơ sở xuống `member`; tầm nhìn rộng của họ nay đến từ `ZaloAccountAccess`.
 *
 * ── Bộ quyền chọn thế nào ───────────────────────────────────────────────────
 * KHÔNG chọn theo cảm tính: kiểm kê TOÀN BỘ `requireGrant(...)` trong mã fork rồi lấy
 * đúng phần một người trực hộp thư phải đi qua.
 *
 *   conversation.access  — danh sách hội thoại (`chat-routes.ts:419`). Thiếu = 403.
 *   contact.access       — danh sách khách hàng.
 *   friend.access        — danh bạ của nick.
 *   media.access/create  — xem và gửi ảnh/tệp đính kèm.
 *
 * CỐ Ý KHÔNG CÓ, và mỗi thứ vì một lý do cụ thể:
 *   settings.*        — chứa khoá Public API và cấu hình kênh;
 *   permission_group.*, user.*, department.* — tự nâng quyền cho chính mình;
 *   zalo_account.*    — gỡ/đăng xuất nick của cả cơ sở;
 *   audit_log.*       — xoá dấu vết;
 *   broadcast/sequence/trigger/block/customer_list/webhook — gửi hàng loạt ra ngoài;
 *   *.view_all        — cờ bỏ qua phạm vi. Tầm nhìn PHẢI đi qua `ZaloAccountAccess` để
 *                       chỉ có MỘT cơ chế quyết định ai thấy nick nào.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';

/** Tên nhóm — cũng là khoá tra trong một org. Đổi tên là sinh nhóm thứ hai. */
export const TEN_NHOM_SATA = 'Sata · Nhân viên CSKH';

/**
 * Bộ quyền của nhóm. Chỉ khai `true`; thiếu khoá nghĩa là KHÔNG có quyền
 * (`hasGrant` đọc thiếu thành false), nên không cần liệt kê hàng chục `false`.
 */
export const QUYEN_NHOM_SATA = {
  conversation: { access: true },
  contact: { access: true },
  friend: { access: true },
  media: { access: true, create: true },
} as const;

/**
 * Trả id nhóm quyền của org, tạo nếu chưa có.
 *
 * Idempotent và chịu được đua: hai vé SSO về cùng lúc cho một org mới thì cả hai cùng
 * gọi hàm này. `create` thua cuộc đụng khoá duy nhất → đọc lại bản của người thắng thay
 * vì ném lỗi ra giữa đường đăng nhập.
 *
 * ⚠️ KHÔNG đè `grants` của nhóm đang có. Người vận hành có thể đã chỉnh tay cho hợp
 * thực tế; mỗi lần đăng nhập lại nắn về mặc định là lặng lẽ huỷ quyết định của họ.
 */
export async function nhomQuyenSata(orgId: string): Promise<string> {
  const dangCo = await prisma.permissionGroup.findFirst({
    where: { orgId, name: TEN_NHOM_SATA },
    select: { id: true },
  });
  if (dangCo) return dangCo.id;

  try {
    const moi = await prisma.permissionGroup.create({
      data: {
        id: randomUUID(),
        orgId,
        name: TEN_NHOM_SATA,
        // `isSystem` để màn phân quyền không cho xoá: xoá nó là mọi tài khoản Sata mất
        // sạch quyền cùng lúc, và triệu chứng là "cả đội bỗng dưng 403".
        isSystem: true,
        grants: QUYEN_NHOM_SATA,
      },
      select: { id: true },
    });
    return moi.id;
  } catch {
    const thang = await prisma.permissionGroup.findFirst({
      where: { orgId, name: TEN_NHOM_SATA },
      select: { id: true },
    });
    if (thang) return thang.id;
    throw new Error('Không tạo được nhóm quyền mặc định cho tài khoản SSO');
  }
}
