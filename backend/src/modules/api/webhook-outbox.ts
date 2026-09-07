// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
// Phần bổ sung của bản phái sinh: Copyright (C) 2026 Sata Robo
/**
 * F2 — Hàng đợi gửi webhook, thay cho "bắn rồi quên".
 *
 * VÌ SAO CẦN: bản gốc gọi `fetch(...).catch(log)`. Bên nhận chậm một nhịp là tin
 * **mất hẳn** và không ai biết — không lưu mã HTTP, không thử lại, không có vết.
 * Bên nhận ở đây (site quản trị Sata) chạy trên nền tảng serverless: lần gọi đầu sau
 * một quãng rảnh rỗi hoàn toàn có thể quá 10 giây. Với tin nhắn của khách thì
 * "thỉnh thoảng mất một tin" là hỏng, không phải bất tiện.
 *
 * ── CÁCH LÀM ─────────────────────────────────────────────────────────────────
 * Mỗi sự kiện ghi MỘT DÒNG rồi mới gửi. Gửi được thì đánh dấu đã giao; hỏng thì hẹn
 * giờ thử lại. Người thử lại quét theo `next_attempt_at`.
 *
 * Lịch thử lại: **1 giây · 30 giây · 5 phút**. Nhịp đầu ngắn để vượt một cú khởi động
 * lạnh; nhịp cuối đủ dài để vượt một lần triển khai lại. Hết ba lượt thì đánh `failed`
 * và DỪNG — giữ mãi một hàng đợi không ai đọc chỉ làm nó phình.
 *
 * ── HAI ĐIỀU KHÔNG ĐƯỢC ĐỔI ──────────────────────────────────────────────────
 * 1. Chữ ký HMAC tính trên **chuỗi payload đã lưu**, không phải ký lại từ object.
 *    `JSON.stringify` không cam kết cho ra y hệt giữa hai lần; ký lại là lần thử thứ
 *    hai có chữ ký khác lần đầu và bên nhận trả 401.
 * 2. **Chỉ mã 2xx mới là đã giao.** 4xx cũng phải thử lại đủ lượt rồi mới bỏ: bên
 *    nhận có thể đang trả 401 vì chưa kịp nạp khoá bí mật sau một lần triển khai.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import crypto from 'node:crypto';

/** Giây chờ trước mỗi lượt thử lại, tính theo số lần đã thử. */
const LICH_THU_LAI_GIAY = [1, 30, 300];
export const SO_LUOT_TOI_DA = LICH_THU_LAI_GIAY.length;

/** Mỗi vòng quét xử lý tối đa ngần này dòng — chặn một cơn dồn ứ làm nghẽn tiến trình. */
const TRAN_MOI_VONG = 50;

function chuKy(payload: string, secret: string | null): string {
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Gửi MỘT dòng. Trả về true nếu đã giao.
 * Không bao giờ ném — mọi lỗi thành trạng thái trên dòng đó.
 */
async function giaoMotDong(dong: {
  id: string;
  orgId: string;
  event: string;
  payload: string;
  url: string;
  attempts: number;
}): Promise<boolean> {
  // Đọc bí mật ở THỜI ĐIỂM GỬI, không phải lúc xếp hàng: người vận hành có thể vừa
  // đặt khoá xong, và những dòng xếp trước đó vẫn phải ký được bằng khoá mới.
  const secretSetting = await prisma.appSetting.findFirst({
    where: { orgId: dong.orgId, settingKey: 'webhook_secret' },
  });

  let status = 0;
  let loi: string | null = null;
  try {
    const res = await fetch(dong.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': chuKy(dong.payload, secretSetting?.valuePlain ?? null),
        'X-Webhook-Event': dong.event,
      },
      body: dong.payload,
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    if (!res.ok) {
      // Đọc một mẩu thân để dò lỗi — CẮT NGẮN, và nó chỉ vào log/DB của chính mình.
      loi = (await res.text().catch(() => '')).slice(0, 500);
    }
  } catch (err) {
    loi = (err as Error)?.message?.slice(0, 500) ?? 'lỗi mạng';
  }

  const daGiao = status >= 200 && status < 300;
  if (daGiao) {
    await prisma.webhookOutbox.update({
      where: { id: dong.id },
      data: { status: 'delivered', attempts: dong.attempts + 1, lastStatus: status, deliveredAt: new Date() },
    });
    return true;
  }

  const soLuot = dong.attempts + 1;
  const conLuot = soLuot < SO_LUOT_TOI_DA;
  await prisma.webhookOutbox.update({
    where: { id: dong.id },
    data: {
      status: conLuot ? 'pending' : 'failed',
      attempts: soLuot,
      lastStatus: status || null,
      lastError: loi,
      nextAttemptAt: new Date(Date.now() + (LICH_THU_LAI_GIAY[soLuot] ?? 300) * 1000),
    },
  });
  if (!conLuot) {
    // Hết lượt là BỎ HẲN một sự kiện — phải kêu to, đừng để nó chìm trong log debug.
    logger.error(
      { event: dong.event, orgId: dong.orgId, status, err: loi },
      '[webhook-outbox] BỎ CUỘC sau khi thử hết lượt — sự kiện này sẽ không tới bên nhận',
    );
  } else {
    logger.warn({ event: dong.event, status, luot: soLuot }, '[webhook-outbox] giao hụt, sẽ thử lại');
  }
  return false;
}

/** Xếp một sự kiện vào hàng đợi rồi thử giao ngay. Không chặn người gọi. */
export async function xepHang(orgId: string, event: string, url: string, payload: string): Promise<void> {
  const dong = await prisma.webhookOutbox.create({
    data: { orgId, event, url, payload, nextAttemptAt: new Date() },
    select: { id: true, orgId: true, event: true, payload: true, url: true, attempts: true },
  });
  // Thử ngay, nhưng KHÔNG await ở đường gọi: tin nhắn của khách không được chờ webhook.
  void giaoMotDong(dong).catch((err) =>
    logger.warn({ err: (err as Error)?.message }, '[webhook-outbox] lỗi ngoài dự kiến khi giao'),
  );
}

/** Một vòng quét: lấy các dòng tới hạn và thử lại. Trả về số dòng đã xử lý. */
export async function quetMotVong(now = new Date()): Promise<number> {
  const dsDong = await prisma.webhookOutbox.findMany({
    where: { status: 'pending', nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: 'asc' },
    take: TRAN_MOI_VONG,
    select: { id: true, orgId: true, event: true, payload: true, url: true, attempts: true },
  });
  for (const dong of dsDong) {
    await giaoMotDong(dong);
  }
  return dsDong.length;
}

let dongHo: NodeJS.Timeout | null = null;

/** Bật người thử lại. Gọi một lần lúc khởi động. */
export function batNguoiThuLai(chuKyGiay = 10): void {
  if (dongHo) return;
  dongHo = setInterval(() => {
    void quetMotVong().catch((err) =>
      logger.warn({ err: (err as Error)?.message }, '[webhook-outbox] vòng quét lỗi'),
    );
  }, chuKyGiay * 1000);
  // unref: người thử lại KHÔNG được giữ tiến trình sống khi mọi thứ khác đã đóng.
  dongHo.unref?.();
  logger.info(`[webhook-outbox] người thử lại đã bật (mỗi ${chuKyGiay}s)`);
}
