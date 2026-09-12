// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * public-api-routes.ts — External REST API authenticated via API key (X-Api-Key header).
 * Provides read/write access to contacts, conversations, appointments, and message sending.
 * All routes prefixed /api/public/ — no JWT required, orgId injected from API key lookup.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { getRedis } from '../../shared/redis-client.js';

// ── API key auth middleware ────────────────────────────────────────────────────

async function apiKeyAuth(request: FastifyRequest, reply: FastifyReply) {
  const apiKey = request.headers['x-api-key'] as string;
  if (!apiKey) return reply.status(401).send({ error: 'API key required' });

  const setting = await prisma.appSetting.findFirst({
    where: { settingKey: 'public_api_key', valuePlain: apiKey },
  });
  if (!setting) return reply.status(401).send({ error: 'Invalid API key' });

  (request as any).orgId = setting.orgId;
}

// ── Route registration ────────────────────────────────────────────────────────

export async function publicApiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', apiKeyAuth);

  // ── Contacts ─────────────────────────────────────────────────────────────

  app.get('/api/public/contacts', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { search = '', status = '', limit = '20' } = request.query as Record<string, string>;

      const where: any = { orgId };
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { fullName: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
          { email: { contains: search, mode: 'insensitive' } },
        ];
      }

      const contacts = await prisma.contact.findMany({
        where,
        select: {
          id: true, fullName: true, phone: true, email: true,
          source: true, status: true, notes: true, tags: true,
          createdAt: true, updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: Math.min(parseInt(limit) || 20, 100),
      });

      return { contacts };
    } catch (err) {
      logger.error('[public-api] GET /contacts error:', err);
      return reply.status(500).send({ error: 'Failed to fetch contacts' });
    }
  });

  app.get('/api/public/contacts/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { id } = request.params as { id: string };

      const contact = await prisma.contact.findFirst({
        where: { id, orgId },
        include: {
          appointments: { orderBy: { appointmentDate: 'desc' }, take: 5 },
          _count: { select: { conversations: true } },
        },
      });

      if (!contact) return reply.status(404).send({ error: 'Contact not found' });
      return contact;
    } catch (err) {
      logger.error('[public-api] GET /contacts/:id error:', err);
      return reply.status(500).send({ error: 'Failed to fetch contact' });
    }
  });

  app.post('/api/public/contacts', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const body = request.body as Record<string, any>;

      if (!body?.fullName && !body?.phone) {
        return reply.status(400).send({ error: 'fullName or phone is required' });
      }

      const contact = await prisma.contact.create({
        data: {
          orgId,
          fullName: body.fullName,
          phone: body.phone,
          email: body.email,
          source: body.source,
          status: body.status ?? 'new',
          notes: body.notes,
          tags: body.tags ?? [],
        },
      });

      return reply.status(201).send(contact);
    } catch (err) {
      logger.error('[public-api] POST /contacts error:', err);
      return reply.status(500).send({ error: 'Failed to create contact' });
    }
  });

  app.put('/api/public/contacts/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { id } = request.params as { id: string };
      const body = request.body as Record<string, any>;

      const existing = await prisma.contact.findFirst({ where: { id, orgId }, select: { id: true } });
      if (!existing) return reply.status(404).send({ error: 'Contact not found' });

      const updated = await prisma.contact.update({
        where: { id },
        data: {
          fullName: body.fullName,
          phone: body.phone,
          email: body.email,
          source: body.source,
          status: body.status,
          notes: body.notes,
          tags: body.tags,
        },
      });

      return updated;
    } catch (err) {
      logger.error('[public-api] PUT /contacts/:id error:', err);
      return reply.status(500).send({ error: 'Failed to update contact' });
    }
  });

  // ── Conversations ─────────────────────────────────────────────────────────

  app.get('/api/public/conversations', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { limit = '20', since } = request.query as Record<string, string>;

      // F4 (bản phái sinh Sata) — `since`: chỉ trả hội thoại có tin MỚI HƠN mốc này.
      // Bên kia chạy đối soát định kỳ; không có bộ lọc thì mỗi lượt phải kéo cả danh
      // sách rồi tự bỏ đi, tức càng chạy dày càng tốn. Mốc SAI KHUÔN bị BỎ QUA chứ
      // không trả 400: một mốc hỏng làm im lưới an toàn thì tệ hơn là quét thừa.
      const moc = since ? new Date(since) : null;
      const locTheoMoc = moc && !Number.isNaN(moc.getTime()) ? { gte: moc } : undefined;

      const conversations = await prisma.conversation.findMany({
        where: {
          orgId,
          deletedAt: null,
          ...(locTheoMoc ? { lastMessageAt: locTheoMoc } : {}),
        },
        select: {
          id: true, threadType: true, externalThreadId: true,
          // F4: `zaloAccountId` là nick nào đang giữ hội thoại. Thiếu nó thì bên kia
          // không gắn được hội thoại vào cơ sở nào — mọi hội thoại thành "mồ côi".
          zaloAccountId: true,
          lastMessageAt: true, unreadCount: true, isReplied: true,
          contact: {
            select: { id: true, fullName: true, phone: true, avatarUrl: true, externalRef: true },
          },
        },
        // Sắp theo ĐÚNG cột đang lọc: `since` + `orderBy` khác cột thì phân trang theo
        // mốc sẽ nhảy cóc và bỏ sót hội thoại.
        orderBy: { lastMessageAt: 'desc' },
        take: Math.min(parseInt(limit) || 20, 100),
      });

      return { conversations };
    } catch (err) {
      logger.error('[public-api] GET /conversations error:', err);
      return reply.status(500).send({ error: 'Failed to fetch conversations' });
    }
  });

  // F4 (bản phái sinh Sata) — MỘT hội thoại. Bên kia cần nó khi chỉ cầm `conversationId`
  // (từ webhook) và muốn biết nick/cơ sở/liên hệ mà không phải kéo cả danh sách về lọc.
  app.get('/api/public/conversations/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { id } = request.params as { id: string };

      // `orgId` nằm TRONG `where` chứ không kiểm sau khi đọc: khoá API chỉ mở đúng một
      // tổ chức, và một id đoán mò không được phép trả về dữ liệu của tổ chức khác.
      const conversation = await prisma.conversation.findFirst({
        where: { id, orgId, deletedAt: null },
        select: {
          id: true, threadType: true, externalThreadId: true, zaloAccountId: true,
          lastMessageAt: true, unreadCount: true, isReplied: true,
          contact: {
            select: { id: true, fullName: true, phone: true, avatarUrl: true, externalRef: true },
          },
        },
      });
      if (!conversation) return reply.status(404).send({ error: 'Conversation not found' });

      return { conversation };
    } catch (err) {
      logger.error('[public-api] GET /conversations/:id error:', err);
      return reply.status(500).send({ error: 'Failed to fetch conversation' });
    }
  });

  app.get('/api/public/conversations/:id/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { id } = request.params as { id: string };
      const { limit = '50' } = request.query as Record<string, string>;

      const conv = await prisma.conversation.findFirst({ where: { id, orgId }, select: { id: true } });
      if (!conv) return reply.status(404).send({ error: 'Conversation not found' });

      const messages = await prisma.message.findMany({
        where: { conversationId: id, isDeleted: false },
        orderBy: { sentAt: 'desc' },
        take: Math.min(parseInt(limit) || 50, 200),
        select: {
          id: true, senderType: true, senderName: true,
          content: true, contentType: true, sentAt: true, attachments: true,
        },
      });

      return { messages };
    } catch (err) {
      logger.error('[public-api] GET /conversations/:id/messages error:', err);
      return reply.status(500).send({ error: 'Failed to fetch messages' });
    }
  });

  // ── F4 (bản phái sinh Sata) — gắn khoá phiếu bên Sata vào liên hệ ─────────
  //
  // Để màn chat mở đúng phiếu khách bên Sata. Không dò theo số điện thoại: cùng một số
  // có thể nằm ở hai phiếu của hai cơ sở, và dò theo số là mở nhầm phiếu của cơ sở khác.

  app.put('/api/public/contacts/:id/external-ref', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { id } = request.params as { id: string };
      const body = request.body as Record<string, unknown> | undefined;

      // `null` là GỠ liên kết — hợp lệ và cần thiết (phiếu bên kia bị gộp hoặc xoá).
      // Phân biệt rõ "gỡ" với "thiếu trường": thiếu trường là lỗi gọi, trả 400.
      const raw = body?.externalRef;
      if (raw !== null && typeof raw !== 'string') {
        return reply.status(400).send({ error: 'externalRef must be a string or null' });
      }
      const externalRef = typeof raw === 'string' ? raw.trim() : null;
      if (externalRef !== null && (!externalRef || externalRef.length > 191)) {
        return reply.status(400).send({ error: 'externalRef must be 1-191 characters' });
      }

      const contact = await prisma.contact.findFirst({ where: { id, orgId }, select: { id: true } });
      if (!contact) return reply.status(404).send({ error: 'Contact not found' });

      try {
        const updated = await prisma.contact.update({
          where: { id },
          data: { externalRef },
          select: { id: true, externalRef: true },
        });
        return { contact: updated };
      } catch (err) {
        // Khoá đã thuộc liên hệ KHÁC. Trả 409 kèm mã chứ không đè: đè là âm thầm đổi
        // chủ một liên kết mà không ai biết, và dấu hiệu thật ở đây là hai liên hệ
        // trùng người — việc phải xử là GỘP, không phải ghi lại.
        if ((err as { code?: string })?.code === 'P2002') {
          return reply.status(409).send({
            error: 'externalRef đã thuộc một liên hệ khác trong tổ chức này',
            code: 'EXTERNAL_REF_TAKEN',
          });
        }
        throw err;
      }
    } catch (err) {
      logger.error('[public-api] PUT /contacts/:id/external-ref error:', err);
      return reply.status(500).send({ error: 'Failed to set external ref' });
    }
  });

  // ── Appointments ──────────────────────────────────────────────────────────

  app.get('/api/public/appointments', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { from, to } = request.query as Record<string, string>;

      const where: any = { orgId };
      if (from || to) {
        where.appointmentDate = {};
        if (from) where.appointmentDate.gte = new Date(from);
        if (to) where.appointmentDate.lte = new Date(to);
      }

      const appointments = await prisma.appointment.findMany({
        where,
        include: { contact: { select: { id: true, fullName: true, phone: true } } },
        orderBy: { appointmentDate: 'asc' },
        take: 100,
      });

      return { appointments };
    } catch (err) {
      logger.error('[public-api] GET /appointments error:', err);
      return reply.status(500).send({ error: 'Failed to fetch appointments' });
    }
  });

  app.post('/api/public/appointments', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const body = request.body as Record<string, any>;

      if (!body?.contactId || !body?.appointmentDate) {
        return reply.status(400).send({ error: 'contactId and appointmentDate are required' });
      }

      const contact = await prisma.contact.findFirst({ where: { id: body.contactId, orgId }, select: { id: true } });
      if (!contact) return reply.status(404).send({ error: 'Contact not found' });

      const appointment = await prisma.appointment.create({
        data: {
          orgId,
          contactId: body.contactId,
          appointmentDate: new Date(body.appointmentDate),
          appointmentTime: body.appointmentTime,
          type: body.type,
          notes: body.notes,
        },
      });

      return reply.status(201).send(appointment);
    } catch (err) {
      logger.error('[public-api] POST /appointments error:', err);
      return reply.status(500).send({ error: 'Failed to create appointment' });
    }
  });

  // ── Messages send ─────────────────────────────────────────────────────────

  app.post('/api/public/messages/send', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const body = request.body as Record<string, any>;

      if (!body?.zaloAccountId || !body?.threadId || !body?.content) {
        return reply.status(400).send({ error: 'zaloAccountId, threadId, and content are required' });
      }

      // Verify account belongs to org
      const account = await prisma.zaloAccount.findFirst({
        where: { id: body.zaloAccountId, orgId },
        select: { id: true, status: true, archivedAt: true },
      });
      if (!account) return reply.status(404).send({ error: 'Zalo account not found' });
      // T7b (YC2 2026-06-20): nick ĐÃ XÓA (archivedAt) → 409, trước check kết nối.
      if (account.archivedAt) {
        return reply.status(409).send({ error: 'Nick này đã bị xóa — không gửi được. Kết nối lại nick để tiếp tục.', code: 'NICK_ARCHIVED' });
      }
      if (account.status !== 'connected') {
        return reply.status(422).send({ error: 'Zalo account is not connected' });
      }

      // ── F4 (bản phái sinh Sata) — ĐI QUA TRẦN TỐC ĐỘ ───────────────────────
      // Bản gốc gửi thẳng, không hỏi trần. Đường trong giao diện thì có hỏi
      // (`chat-routes.ts`), nên một khoá API gửi dày có thể đốt hết hạn mức của nick
      // mà chính người đang chat không hiểu vì sao mình bị chặn — và tệ hơn, Zalo khoá
      // nick là mất cả kênh liên lạc với khách, không chỉ mất một tin.
      const { zaloRateLimiter } = await import('../zalo/zalo-rate-limiter.js');
      const tran = await zaloRateLimiter.checkLimits(body.zaloAccountId);
      if (!tran.allowed) {
        return reply.status(429).send({ error: tran.reason, code: 'RATE_LIMITED' });
      }

      // ── Chống gửi trùng ────────────────────────────────────────────────────
      // Bên gọi có hàng đợi gửi lại: mất phản hồi là nó thử lại, và nếu tin ĐÃ tới Zalo
      // thì khách nhận hai lần. Đây là kiểu hỏng KHÔNG lùi được — tin đã ra khỏi hệ
      // thống. Khoá `idempotencyKey` giữ 10 phút cùng `msgId` đã trả; lần gọi lại trả
      // đúng kết quả cũ và KHÔNG gửi thêm.
      //
      // Redis chết ⇒ GỬI BÌNH THƯỜNG, không chặn: mất chống-trùng còn hơn mất cả kênh
      // gửi. Ngược hướng fail-closed của vé SSO, và cố ý — bên đó chặn kẻ giả mạo, bên
      // này chỉ chặn một bản sao.
      const khoaChongTrung =
        typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
          ? `sata:send-idem:${orgId}:${body.idempotencyKey.trim().slice(0, 128)}`
          : null;
      const redis = khoaChongTrung ? await getRedis() : null;
      if (redis && khoaChongTrung) {
        const daCo = await redis.get(khoaChongTrung);
        if (daCo !== null) {
          return { success: true, msgId: daCo || null, duplicate: true };
        }
      }

      // Dynamically import zaloPool to avoid circular deps
      const { zaloPool } = await import('../zalo/zalo-pool.js');
      const api = zaloPool.getApi(body.zaloAccountId);
      if (!api) return reply.status(422).send({ error: 'Zalo account not active in pool' });

      const threadType = body.threadType === 'group' ? 1 : 0;
      zaloRateLimiter.recordSend(body.zaloAccountId);
      const ketQua = await api.sendMessage(body.content, body.threadId, threadType);

      // zca-js trả `{ message: { msgId } | null, attachment: [{ msgId }] }` — cùng cách
      // bóc như `chat-routes.ts`. `msgId` là thứ bên nhận dùng để khớp tin này với bản
      // echo về sau; thiếu nó thì họ phải đoán theo nội dung + thời gian.
      const kq = ketQua as unknown as {
        message?: { msgId?: number | string } | null;
        attachment?: Array<{ msgId?: number | string }>;
      };
      const msgId = String(kq?.message?.msgId ?? kq?.attachment?.[0]?.msgId ?? '') || null;
      if (!msgId) {
        logger.warn('[public-api] sendMessage không trả msgId — bên nhận sẽ phải tự khớp echo');
      }

      // Ghi khoá SAU khi gửi xong: ghi trước mà gửi hỏng thì lần thử lại bị coi là trùng
      // và tin không bao giờ đi.
      if (redis && khoaChongTrung) {
        await redis.set(khoaChongTrung, msgId ?? '', 'EX', 600);
      }

      // ⚠️ CỐ Ý KHÔNG tự lưu `Message` ở đây. Zalo dội tin của chính mình về qua
      // `selfListen`, và `message-handler.ts` lưu nó rồi bắn `message.sent` — chép thêm
      // một đường lưu nữa là hai bản ghi cho một tin, hoặc một cuộc đua khoá trùng.
      return { success: true, msgId };
    } catch (err) {
      logger.error('[public-api] POST /messages/send error:', err);
      return reply.status(500).send({ error: 'Failed to send message' });
    }
  });
}
