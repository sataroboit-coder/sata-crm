// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * webhook-service.ts — fire-and-forget webhook delivery for org-configured endpoints.
 * Signs payloads with HMAC-SHA256 if webhook_secret is configured.
 *
 * Security: the webhook URL is set by org admins (AppSetting `webhook_url`)
 * and is therefore attacker-controllable from inside an org. We validate
 * it through the shared SSRF guard before issuing the fetch.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { assertSafeOutboundUrl, SsrfBlockedError } from '../../shared/utils/ssrf-guard.js';
import { xepHang } from './webhook-outbox.js';
import { config as appConfig } from '../../config/index.js';

export async function emitWebhook(orgId: string, event: string, data: any): Promise<void> {
  try {
    const config = await prisma.appSetting.findFirst({
      where: { orgId, settingKey: 'webhook_url' },
    });
    if (!config?.valuePlain) return;

    // SSRF guard — reject loopback/private/metadata hosts before issuing fetch.
    let safeUrl: URL;
    try {
      safeUrl = assertSafeOutboundUrl(config.valuePlain);
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        // ── F2 (bản phái sinh Sata Robo) — lối thoát CHỈ cho máy lẻ ──────────────
        // Bộ gác SSRF chặn loopback/mạng nội bộ, và đúng như vậy: địa chỉ webhook do
        // quản trị viên của tổ chức đặt, tức người trong nhà cũng có thể trỏ nó vào
        // dịch vụ nội bộ để dò. Nhưng khi dựng thử trên MỘT máy, site quản trị nằm ở
        // `localhost` — không có lối thoát thì không thử được gì.
        //
        // 🔴 `WEBHOOK_ALLOW_LOOPBACK` CHỈ dùng ở máy lẻ. Bật trên máy chủ thật là tự
        // mở đường cho người trong tổ chức dò mạng nội bộ. Mặc định TẮT.
        if (appConfig.webhookAllowLoopback) {
          logger.warn(
            `[webhook] WEBHOOK_ALLOW_LOOPBACK đang bật — bỏ qua bộ gác SSRF cho ${config.valuePlain}. ` +
              'Chỉ được dùng ở máy phát triển.',
          );
          safeUrl = new URL(config.valuePlain);
        } else {
          logger.warn(`[webhook] Blocked unsafe webhook_url for org ${orgId}: ${err.message}`);
          return;
        }
      } else {
        throw err;
      }
    }

    const payload = JSON.stringify({ event, timestamp: new Date().toISOString(), data });

    // ── F2 (bản phái sinh Sata Robo) — xếp hàng thay vì "bắn rồi quên" ─────────
    // Chuỗi `payload` ở trên được lưu NGUYÊN VĂN và ký ở thời điểm giao. Xem
    // `webhook-outbox.ts` để biết vì sao không được ký lại từ object.
    await xepHang(orgId, event, safeUrl.toString(), payload);
  } catch (err) {
    logger.error('[webhook] Error emitting webhook:', err);
  }
}
