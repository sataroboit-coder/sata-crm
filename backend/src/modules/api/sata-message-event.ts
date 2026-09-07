// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
// Phần bổ sung của bản phái sinh: Copyright (C) 2026 Sata Robo
/**
 * F2 — dựng phần `data` GIÀU NGỮ CẢNH cho sự kiện `message.received` / `message.sent`.
 *
 * VÌ SAO CẦN: bản gốc chỉ gửi `messageId`, `conversationId`, `senderUid`, `content`,
 * `contentType`, `sentAt`. Bên nhận (site quản trị Sata) không suy ra được ba thứ
 * thiết yếu, và mỗi thứ thiếu làm hỏng một việc khác nhau:
 *
 *  · `zaloAccountId` — tin này về NICK NÀO. Thiếu nó thì bên nhận phải dùng một hằng
 *    làm khoá tài khoản, và một khách nhắn hai nick sẽ bị gộp thành MỘT hội thoại.
 *  · `threadId` / `threadType` — ai là KHÁCH trong hội thoại này, và có phải hội thoại
 *    nhóm không. Với tin ĐI thì `senderUid` là uid của chính nick mình, không phải khách.
 *  · `sentByExternalId` — NHÂN VIÊN NÀO gõ. Thiếu nó thì không ghi được mốc "đã chạm
 *    khách" lên đúng phiếu và đồng hồ chăm sóc không bao giờ được làm mới.
 *
 * Kèm `contactId` + `contact.phone` để bên nhận nối hội thoại với phiếu khách ngay ở
 * tin đầu, thay vì để nó nằm mồ côi chờ nối tay.
 *
 * ⚠️ Tên trường ở đây là HỢP ĐỒNG với bên nhận. Đổi tên là bên kia trả
 * `200 + FAILED` kèm mã lỗi (chứ không im lặng), nhưng vẫn là hỏng.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';

export type NguCanhTinNhan = {
  messageId: string;
  conversationId: string;
  /** Nick của công ty nhận/gửi tin. */
  zaloAccountId: string;
  /** uid của KHÁCH trong hội thoại (không phải người gửi). */
  threadId: string | null;
  /** 'user' | 'group' — bên nhận loại bỏ hội thoại nhóm. */
  threadType: string | null;
  senderUid: string | null;
  senderName: string | null;
  content: string | null;
  contentType: string;
  sentAt: Date;
  contactId: string | null;
  /** `null` khi chưa biết số — bình thường, không phải lỗi. */
  contactPhone: string | null;
  /** `User.externalId` của nhân viên đã gõ; `null` với tin của khách hoặc tin máy gửi. */
  sentByExternalId: string | null;
};

/**
 * Đọc thêm hai mẩu dữ liệu mà chỗ gọi không có sẵn.
 * KHÔNG BAO GIỜ NÉM: webhook là việc phụ, hỏng thì gửi payload nghèo hơn chứ không
 * được làm vỡ đường xử lý tin nhắn.
 */
export async function dungNguCanhTinNhan(input: {
  messageId: string;
  conversationId: string;
  zaloAccountId: string;
  threadId?: string | null;
  threadType?: string | null;
  senderUid?: string | null;
  senderName?: string | null;
  content?: string | null;
  contentType?: string | null;
  sentAt: Date;
  contactId?: string | null;
  /** `Message.repliedByUserId` — người bấm Gửi trong giao diện. */
  repliedByUserId?: string | null;
}): Promise<NguCanhTinNhan> {
  let contactPhone: string | null = null;
  let sentByExternalId: string | null = null;

  try {
    if (input.contactId) {
      const c = await prisma.contact.findUnique({
        where: { id: input.contactId },
        select: { phone: true },
      });
      contactPhone = c?.phone ?? null;
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, '[sata-webhook] không đọc được SĐT liên hệ');
  }

  try {
    if (input.repliedByUserId) {
      const u = await prisma.user.findUnique({
        where: { id: input.repliedByUserId },
        select: { externalId: true },
      });
      // `externalId` rỗng nghĩa là tài khoản này KHÔNG đến từ Sata (tạo tay trong
      // ZaloCRM). Để `null` chứ không rơi về id nội bộ: bên nhận tra `null` sẽ ghi
      // "không rõ ai gõ", còn tra một id lạ thì im lặng không khớp ai cả.
      sentByExternalId = u?.externalId ?? null;
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, '[sata-webhook] không đọc được externalId người gửi');
  }

  return {
    messageId: input.messageId,
    conversationId: input.conversationId,
    zaloAccountId: input.zaloAccountId,
    threadId: input.threadId ?? null,
    threadType: input.threadType ?? null,
    senderUid: input.senderUid ?? null,
    senderName: input.senderName ?? null,
    content: input.content ?? null,
    contentType: input.contentType || 'text',
    sentAt: input.sentAt,
    contactId: input.contactId ?? null,
    contactPhone,
    sentByExternalId,
  };
}
