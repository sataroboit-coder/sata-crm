// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
// Phần bổ sung của bản phái sinh: Copyright (C) 2026 Sata Robo
/**
 * F1 — Đăng nhập một lần (SSO) từ site quản trị Sata Robo.
 *
 * BÀI TOÁN: nhân viên đã đăng nhập site quản trị Sata rồi; bắt họ nhập tài khoản lần
 * thứ hai để dùng màn chat nhúng là vô lý, và đẻ ra một bộ mật khẩu thứ hai phải quản.
 * Ở đây Sata ký một VÉ ngắn hạn, ZaloCRM đổi vé lấy phiên của chính mình.
 *
 * ── LUỒNG ────────────────────────────────────────────────────────────────────
 *   Sata ký vé (HS256, sống 60 giây)  →  đặt trong #fragment của URL iframe
 *   →  trang /sso của giao diện này đọc fragment  →  POST /api/v1/auth/sso
 *   →  kiểm vé  →  tạo/cập nhật người dùng  →  trả token + refreshToken như đăng nhập thường.
 *
 * ── VÌ SAO VÉ ĐẶT TRONG #fragment, KHÔNG PHẢI ?query ─────────────────────────
 * Phần sau dấu `#` KHÔNG được trình duyệt gửi lên máy chủ, không vào log truy cập,
 * không vào header Referer khi trang gọi tài nguyên khác. Vé trong query string thì
 * nằm lại trong log của mọi proxy trên đường đi.
 *
 * ── BỐN LỚP KIỂM, MỖI LỚP CHẶN MỘT KIỂU TẤN CÔNG ─────────────────────────────
 *  1. Chữ ký HS256 bằng bí mật CHUNG (SATA_SSO_SECRET) — chặn vé bịa.
 *  2. Hạn dùng ≤ 60 giây (ép ở đây, không tin `exp` trong vé) — thu hẹp cửa sổ dùng lại
 *     vé rò rỉ. Người ký có thể đặt exp dài; bên nhận mới là bên quyết.
 *  3. `jti` dùng đúng MỘT LẦN (ghi Redis tới khi hết hạn) — chặn phát lại. Không có
 *     Redis thì TỪ CHỐI, không âm thầm bỏ qua: bỏ qua nghĩa là mất hẳn lớp chống phát lại.
 *  4. `orgCode` phải khớp một tổ chức có thật — chặn vé hợp lệ của org này dùng cho org kia.
 *
 * 🔴 KHÔNG khai `SATA_SSO_SECRET` = TẮT HẲN đường này (404). Đây là cổng mở-có-chủ-đích:
 * không cấu hình thì bản phái sinh chạy y hệt bản gốc.
 */
import jwt from 'jsonwebtoken';
import { prisma } from '../../shared/database/prisma-client.js';
import { runSystemQuery } from '../../shared/tenant/tenant-context.js';
import { getRedis } from '../../shared/redis-client.js';
import { config } from '../../config/index.js';
import { logger } from '../../shared/utils/logger.js';
import type { JwtPayload } from './auth-service.js';
import { nhomQuyenSata } from './sata-nhom-quyen.js';

/**
 * Giá trị `passwordHash` của tài khoản CHỈ đăng nhập bằng SSO.
 *
 * Cố ý KHÔNG phải một chuỗi bcrypt hợp lệ: mọi lần so mật khẩu đều trượt, nên tài khoản
 * này vào được đúng một đường là vé SSO. Nó cũng là DẤU NHẬN BIẾT để phân biệt "tài
 * khoản không dùng mật khẩu" với "tài khoản có mật khẩu và đang nợ lần đổi đầu tiên".
 */
const HASH_CHI_SSO = '!sso-only-no-password';

/** Trần hạn dùng của vé, tính bằng giây. Bên nhận ép, không tin bên ký. */
export const SSO_MAX_AGE_SECONDS = 60;

/** Vai bên Sata → vai trong tổ chức này. Chỉ hai đích; không có đường thành 'owner'. */
const VAI_HOP_LE = new Set(['admin', 'member']);

export class SsoError extends Error {
  constructor(
    readonly code:
      | 'SSO_DISABLED'
      | 'INVALID_TICKET'
      | 'TICKET_EXPIRED'
      | 'TICKET_REPLAYED'
      | 'REPLAY_STORE_DOWN'
      | 'UNKNOWN_ORG'
      | 'BAD_CLAIMS',
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'SsoError';
  }
}

type ClaimsVe = {
  sub: string; // User.id bên Sata — khoá đối chiếu bất biến
  orgCode: string;
  role: string; // 'admin' | 'member'
  fullName: string;
  email?: string | null;
  jti: string;
  iat: number;
  exp: number;
};

/** SSO chỉ bật khi có bí mật chung. Không có = tính năng không tồn tại. */
export function ssoEnabled(): boolean {
  return Boolean(config.sataSsoSecret);
}

/**
 * Kiểm vé và trả claims. THUẦN (không chạm DB) để test được không cần hạ tầng.
 * Ném `SsoError` cho mọi ca hỏng — không bao giờ trả về claims nửa vời.
 */
export function verifySsoTicket(token: string, now = Date.now()): ClaimsVe {
  const secret = config.sataSsoSecret;
  if (!secret) throw new SsoError('SSO_DISABLED', 'SSO chưa được cấu hình', 404);

  let raw: unknown;
  try {
    // `algorithms` khai tường minh: thiếu nó thì vé ký bằng thuật toán khác (kể cả
    // 'none' ở các bản thư viện cũ) có thể lọt. Đây là lỗ kinh điển của JWT.
    raw = jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch (err) {
    const msg = (err as Error)?.message ?? '';
    if (msg.includes('expired')) {
      throw new SsoError('TICKET_EXPIRED', 'Vé đăng nhập đã hết hạn', 401);
    }
    throw new SsoError('INVALID_TICKET', 'Vé đăng nhập không hợp lệ', 401);
  }

  if (!raw || typeof raw !== 'object') {
    throw new SsoError('BAD_CLAIMS', 'Vé đăng nhập không hợp lệ', 401);
  }
  const c = raw as Record<string, unknown>;

  const sub = typeof c.sub === 'string' ? c.sub.trim() : '';
  const orgCode = typeof c.orgCode === 'string' ? c.orgCode.trim() : '';
  const role = typeof c.role === 'string' ? c.role.trim() : '';
  const fullName = typeof c.fullName === 'string' ? c.fullName.trim() : '';
  const jti = typeof c.jti === 'string' ? c.jti.trim() : '';
  const iat = typeof c.iat === 'number' ? c.iat : 0;
  const exp = typeof c.exp === 'number' ? c.exp : 0;

  if (!sub || !orgCode || !jti || !iat || !exp) {
    throw new SsoError('BAD_CLAIMS', 'Vé thiếu trường bắt buộc', 401);
  }
  if (!VAI_HOP_LE.has(role)) {
    // Fail-closed: vai lạ KHÔNG rơi về 'member'. Rơi về là biến một lỗi cấu hình bên
    // Sata thành một tài khoản có thật ở đây, im lặng.
    throw new SsoError('BAD_CLAIMS', 'Vai không hợp lệ', 401);
  }
  if (!/^[a-z0-9-]{1,32}$/.test(orgCode)) {
    throw new SsoError('BAD_CLAIMS', 'orgCode sai khuôn', 401);
  }

  // Trần tuổi vé do BÊN NHẬN ép. `jwt.verify` đã kiểm `exp`, nhưng `exp` do bên ký đặt
  // và có thể là 24 giờ. Ta chỉ chấp nhận vé vừa mới ký.
  const tuoiGiay = Math.floor(now / 1000) - iat;
  if (tuoiGiay > SSO_MAX_AGE_SECONDS) {
    throw new SsoError('TICKET_EXPIRED', 'Vé đăng nhập đã hết hạn', 401);
  }
  // Lệch đồng hồ nhẹ giữa hai máy là bình thường; âm quá 60 giây thì vé "đến từ tương lai".
  if (tuoiGiay < -SSO_MAX_AGE_SECONDS) {
    throw new SsoError('INVALID_TICKET', 'Vé có thời điểm ký không hợp lệ', 401);
  }

  return { sub, orgCode, role, fullName, email: typeof c.email === 'string' ? c.email : null, jti, iat, exp };
}

/**
 * Đánh dấu `jti` đã dùng. Trả false nếu vé này DÙNG RỒI.
 *
 * 🔴 Redis chết ⇒ NÉM, không cho qua. Cho qua nghĩa là im lặng bỏ lớp chống phát lại
 * đúng lúc hệ thống đang có sự cố — kiểu hỏng tệ nhất vì không ai thấy.
 */
async function danhDauDaDung(jti: string): Promise<void> {
  const redis = await getRedis();
  if (!redis) {
    throw new SsoError(
      'REPLAY_STORE_DOWN',
      'Không kiểm được vé đã dùng hay chưa — tạm thời từ chối',
      503,
    );
  }
  // NX + EX: đặt được = lần đầu. Hết hạn theo trần tuổi vé (thêm biên cho lệch đồng hồ)
  // nên khoá không phình mãi.
  const ok = await redis.set(`sata:sso:jti:${jti}`, '1', 'EX', SSO_MAX_AGE_SECONDS * 2, 'NX');
  if (ok !== 'OK') {
    throw new SsoError('TICKET_REPLAYED', 'Vé đăng nhập đã được dùng', 401);
  }
}

/**
 * Đổi vé lấy phiên: kiểm vé → tra tổ chức → tạo/cập nhật người dùng.
 * Trả payload y hệt `login()` để nơi gọi cấp token bằng đúng một đường.
 */
export async function ssoLogin(token: string): Promise<JwtPayload> {
  const claims = verifySsoTicket(token);
  await danhDauDaDung(claims.jti);

  // runSystemQuery: chưa biết tenant nào cho tới khi tra xong org (giống `login`).
  const org = await runSystemQuery(() =>
    prisma.organization.findUnique({ where: { code: claims.orgCode }, select: { id: true } }),
  );
  if (!org) {
    throw new SsoError('UNKNOWN_ORG', 'Tổ chức chưa được khai mã', 404);
  }

  const user = await runSystemQuery(async () => {
    const dangCo = await prisma.user.findFirst({
      where: { orgId: org.id, externalId: claims.sub },
      select: {
        id: true,
        isActive: true,
        role: true,
        fullName: true,
        passwordChangedAt: true,
        passwordHash: true,
        permissionGroupId: true,
      },
    });

    if (dangCo) {
      // CẬP NHẬT có chọn lọc — chỉ những thứ bên Sata là nguồn sự thật.
      // KHÔNG đụng `passwordHash` (tài khoản có thể vẫn đăng nhập kiểu thường),
      // KHÔNG đụng `jwtTokenVersion`, và KHÔNG hồi sinh tài khoản đã bị khoá:
      // khoá là quyết định của người quản trị bên này, một vé SSO không được lật lại.
      if (!dangCo.isActive) {
        throw new SsoError('BAD_CLAIMS', 'Tài khoản đã bị khoá', 403);
      }
      const doiVai = dangCo.role !== claims.role;
      const doiTen = Boolean(claims.fullName) && dangCo.fullName !== claims.fullName;
      // `passwordChangedAt = null` nghĩa là "đang nợ lần đổi mật khẩu đầu tiên", và bộ
      // gác của giao diện đá MỌI đường về /setup-password khi thấy nó. Tài khoản sinh
      // từ SSO thì KHÔNG BAO GIỜ được giao mật khẩu nào, nên màn đó đòi một thứ không
      // tồn tại và người dùng kẹt vĩnh viễn — trong khung nhúng thì hiện ra là một
      // mảng trắng, không một dòng lỗi. Vá cho cả tài khoản CŨ tạo trước bản này.
      // Điều kiện HẸP có chủ đích: chỉ gỡ cờ cho tài khoản CHỈ-SSO (mang đúng chuỗi
      // `passwordHash` giả bên dưới). Một tài khoản có mật khẩu thật mà đang nợ lần đổi
      // đầu tiên thì cờ đó là hàng rào an ninh có thật — vé SSO không được phép hạ nó.
      const noDoiMatKhau =
        dangCo.passwordChangedAt === null && dangCo.passwordHash === HASH_CHI_SSO;
      // Tài khoản tạo TRƯỚC bản vá 13/09/2026 mang `permissionGroupId = null` ⇒ 403 ở
      // mọi route có `requireGrant`. Vá khi họ đăng nhập lại, KHÔNG đè nhóm đang có:
      // người vận hành có thể đã chuyển họ sang nhóm rộng/hẹp hơn có chủ đích.
      const thieuNhomQuyen = dangCo.permissionGroupId === null;
      if (doiVai || doiTen || noDoiMatKhau || thieuNhomQuyen) {
        await prisma.user.update({
          where: { id: dangCo.id },
          data: {
            ...(doiVai ? { role: claims.role } : {}),
            ...(doiTen ? { fullName: claims.fullName } : {}),
            ...(noDoiMatKhau ? { passwordChangedAt: new Date() } : {}),
            ...(thieuNhomQuyen ? { permissionGroupId: await nhomQuyenSata(org.id) } : {}),
          },
        });
      }
      return { id: dangCo.id };
    }

    // Tài khoản mới: KHÔNG có mật khẩu dùng được. `passwordHash` nhận một chuỗi không
    // phải bcrypt hợp lệ, nên mọi lần thử đăng nhập bằng mật khẩu đều trượt — vào được
    // chỉ qua SSO. Đặt chuỗi rỗng thì một số đường so sánh có thể xử lý bất ngờ.
    const chung = {
      orgId: org.id,
      externalId: claims.sub,
      fullName: claims.fullName || claims.sub,
      role: claims.role,
      passwordHash: HASH_CHI_SSO,
      isActive: true,
      // Không có nhóm quyền thì `userHasGrant` trả false cho MỌI thứ (trừ role admin),
      // tức tài khoản vào được nhưng nhận 403 ở màn đầu tiên. Xem `sata-nhom-quyen.ts`.
      permissionGroupId: await nhomQuyenSata(org.id),
      // KHÔNG để null: null là cờ "phải đổi mật khẩu lần đầu" và bộ gác giao diện sẽ
      // nhốt tài khoản này ở /setup-password — một màn đòi "mật khẩu admin giao" mà
      // tài khoản SSO không hề có. Đặt mốc thời gian tạo = "khoản này không dùng mật
      // khẩu, không nợ lần đổi nào".
      passwordChangedAt: new Date(),
    };

    // ⚠️ `User.email` là DUY NHẤT TOÀN CỤC ở lược đồ này, không phải duy nhất trong một
    // tổ chức. Mà chốt kiến trúc lại là "một nhân viên phụ trách hai cơ sở thì có hai
    // tài khoản, mỗi org một cái" — nên tài khoản thứ hai của cùng một người CHẮC CHẮN
    // đụng email của tài khoản thứ nhất.
    //
    // Email ở đây chỉ để hiển thị cho dễ nhận mặt; danh tính thật là `externalId`. Vậy
    // nên: thử kèm email, đụng thì tạo lại KHÔNG kèm email. Thà một tài khoản thiếu
    // email hiển thị còn hơn một cú 500 chặn người ta vào làm việc.
    // (Bắt đúng mã P2002 chứ không nuốt mọi lỗi — lỗi khác vẫn phải nổi lên.)
    let moi: { id: string };
    try {
      moi = await prisma.user.create({
        data: { ...chung, email: claims.email || null },
        select: { id: true },
      });
    } catch (err) {
      const trungEmail =
        (err as { code?: string })?.code === 'P2002' &&
        JSON.stringify((err as { meta?: unknown })?.meta ?? '').includes('email');
      if (!trungEmail) throw err;
      logger.info(
        { orgCode: claims.orgCode, sub: claims.sub },
        '[sata-sso] email đã thuộc tài khoản khác — tạo tài khoản không kèm email',
      );
      moi = await prisma.user.create({ data: { ...chung, email: null }, select: { id: true } });
    }
    logger.info({ orgCode: claims.orgCode, userId: moi.id }, '[sata-sso] tạo tài khoản mới từ vé SSO');
    return { id: moi.id };
  });

  const day = await runSystemQuery(() =>
    prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { id: true, email: true, phone: true, role: true, orgId: true, jwtTokenVersion: true },
    }),
  );

  return {
    id: day.id,
    email: day.email ?? day.phone ?? day.id,
    role: day.role,
    orgId: day.orgId,
    tv: day.jwtTokenVersion,
  };
}
