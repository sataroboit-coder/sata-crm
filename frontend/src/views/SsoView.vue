<!--
  SPDX-License-Identifier: AGPL-3.0-or-later
  Copyright (C) 2026 Nguyễn Tiến Lộc
  Phần bổ sung của bản phái sinh: Copyright (C) 2026 Sata Robo

  F1 — trang trung chuyển đăng nhập một lần từ site quản trị Sata Robo.

  Site Sata nhúng trang này trong iframe với địa chỉ dạng:
      /sso#token=<vé>&next=/chat?compose=84xxxxxxxxx

  ⚠️ VÉ NẰM SAU DẤU `#`, KHÔNG PHẢI `?` — và đó là chủ đích, không phải tuỳ tiện.
  Phần fragment không được trình duyệt gửi lên máy chủ: nó không vào log truy cập,
  không vào header Referer. Vé trong query string thì nằm lại trong log của mọi
  proxy trên đường đi.

  Trang này CỐ Ý không hiện gì ngoài một dòng trạng thái: nó sống chưa tới một giây,
  và nằm trong khung nhúng nên mọi thứ vẽ ra ở đây chỉ là một cú nháy khó chịu.
-->
<template>
  <div class="sso-wrap">
    <p v-if="loi" class="sso-loi">
      {{ loi }}
      <br />
      <small>Đóng khung này và mở lại từ site quản trị. Vé đăng nhập chỉ sống 60 giây.</small>
    </p>
    <p v-else class="sso-cho">Đang mở phiên làm việc…</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();
const loi = ref('');

/** Chỉ nhận đường dẫn NỘI BỘ. Chặn `next` trỏ ra ngoài (mở chuyển hướng). */
function duongDanAnToan(raw: string | null): string {
  if (!raw) return '/';
  // Phải bắt đầu bằng đúng MỘT dấu `/`. `//evil.com` là URL tuyệt đối theo giao thức
  // hiện tại — trông như đường dẫn nội bộ nhưng đưa người dùng ra khỏi hệ thống.
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

onMounted(async () => {
  // `location.hash` gồm cả dấu `#` đứng đầu — cắt đi rồi mới phân tích.
  const params = new URLSearchParams(window.location.hash.slice(1));
  const ticket = params.get('token');
  const next = duongDanAnToan(params.get('next'));

  if (!ticket) {
    loi.value = 'Thiếu vé đăng nhập.';
    return;
  }

  try {
    await auth.ssoLogin(ticket);
  } catch (err: unknown) {
    const res = (err as { response?: { data?: { error?: string } } })?.response;
    loi.value = res?.data?.error || 'Không mở được phiên làm việc.';
    return;
  }

  // Xoá vé khỏi thanh địa chỉ TRƯỚC khi điều hướng: không để nó nằm lại trong lịch sử
  // duyệt hay bị người dùng chép nguyên URL đi chỗ khác. `replaceState` không tạo mục
  // lịch sử mới nên nút Quay lại cũng không lôi vé về.
  window.history.replaceState(null, '', window.location.pathname);
  await router.replace(next);
});
</script>

<style scoped>
.sso-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  padding: 24px;
  text-align: center;
}
.sso-cho {
  color: #6b7280;
  font-size: 14px;
}
.sso-loi {
  color: #b91c1c;
  font-size: 14px;
  line-height: 1.6;
}
.sso-loi small {
  color: #6b7280;
}
</style>
