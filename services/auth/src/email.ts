// ABOUTME: Создаёт HTML и текст письма с одноразовым кодом в дизайне Brai-old.
// ABOUTME: Сохраняет ведущие нули; адрес того же логотипа строится из origin приложения.

/**
 * Возвращает исходный шаблон Brai-old с темой письма текущего auth.
 * @param otp Строка ровно из шести цифр; ведущие нули сохраняются.
 * @param origin Публичный origin приложения, которое публикует исходный брендовый PNG.
 * @throws Error Если формат кода отличается от шести цифр.
 * @throws TypeError Если origin не является корректным абсолютным URL.
 */
export function otpEmail(otp: string, origin: string) {
  if (!/^\d{6}$/.test(otp)) throw new Error("Invalid OTP format");
  // AIDEV-NOTE: После строгой проверки код состоит только из цифр и не требует HTML escaping.
  const safeOtp = otp;
  // AIDEV-NOTE: Старый brai.one URL недоступен; приложение публикует тот же PNG в /brand.
  const LOGO_URL = new URL("/brand/brai-logo-email-white-bg.png", origin).href;
  return {
    subject: "Код входа в Brai",
    text: [
      'Ваш одноразовый код',
      '',
      'Введите этот код в Brai, чтобы завершить вход.',
      '',
      otp,
      '',
      'Код действует 5 минут.',
      'Если вы не запрашивали код, просто проигнорируйте это письмо.',
      '',
      'Brai · brai.one'
    ].join('\n'),
    html: `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ваш одноразовый код Brai</title>
    <style>
      @media only screen and (max-width: 620px) {
        .email-wrap { padding: 20px 12px !important; }
        .email-card { width: 100% !important; }
        .card-pad { padding: 30px 22px !important; }
        .otp-code { font-size: 40px !important; letter-spacing: 4px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#f4f4f5;color:#18181b;font-family:Arial,'Helvetica Neue',Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Введите одноразовый код Brai. Код действует 5 минут.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background:#f4f4f5;">
      <tr>
        <td class="email-wrap" align="center" style="padding:40px 16px;">
          <table role="presentation" class="email-card" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;border-collapse:separate;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px;box-shadow:0 18px 44px rgba(24,24,27,0.08);overflow:hidden;">
            <tr>
              <td class="card-pad" style="padding:40px 44px 34px;text-align:center;">
                <img src="${LOGO_URL}" width="150" height="80" alt="Brai" style="display:block;width:150px;height:auto;margin:0 auto 28px;border:0;">
                <h1 style="margin:0;color:#18181b;font-size:24px;line-height:1.25;font-weight:700;">Ваш одноразовый код</h1>
                <p style="margin:14px 0 0;color:#52525b;font-size:16px;line-height:1.55;">Введите этот код в Brai, чтобы завершить вход.</p>
                <div class="otp-code" style="margin:30px 0 24px;color:#18181b;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:48px;line-height:1.1;font-weight:800;letter-spacing:6px;white-space:nowrap;">${safeOtp}</div>
                <div style="width:56px;height:3px;margin:0 auto 24px;background:#ef3b2f;border-radius:999px;line-height:3px;font-size:3px;">&nbsp;</div>
                <p style="margin:0;color:#18181b;font-size:15px;line-height:1.55;font-weight:700;">Код действует 5 минут.</p>
                <p style="margin:12px 0 0;color:#71717a;font-size:14px;line-height:1.55;">Если вы не запрашивали код, просто проигнорируйте это письмо.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 24px;border-top:1px solid #f1f1f3;text-align:center;color:#a1a1aa;font-size:12px;line-height:1.5;">Brai · brai.one</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
  };
}
