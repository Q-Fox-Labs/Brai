// ABOUTME: Создаёт HTML и текст письма с одноразовым кодом Brai.
// ABOUTME: Шаблон не загружает внешние изображения и сохраняет ведущие нули.
/** Возвращает готовое письмо; принимает только шестизначный цифровой код. */
export function otpEmail(otp:string) {
 if(!/^\d{6}$/.test(otp))throw new Error("Invalid OTP format");
 const subject="Код входа в Brai";
 const text=`BRAI — is All You Need\n\nВаш код входа: ${otp}\n\nКод действует 5 минут.\nЕсли вы не запрашивали вход, просто проигнорируйте это письмо.`;
 const html=`<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"></head><body style="margin:0;background:#f1f5f9;color:#0f172a;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="480" style="width:100%;max-width:480px;background:#fff;border:1px solid #e2e8f0;border-radius:16px" cellspacing="0" cellpadding="0"><tr><td style="padding:32px"><p style="margin:0 0 28px;font-weight:bold;letter-spacing:2px">BRAI</p><h1 style="font-size:24px;margin:0 0 16px">Ваш код входа</h1><p style="margin:0 0 20px;line-height:1.5">Введите этот код в Brai. Он действует 5 минут.</p><p style="margin:0 0 28px;padding:20px 8px;text-align:center;background:#f1f5f9;border-radius:10px;font-family:monospace;font-size:36px;font-weight:bold;letter-spacing:6px">${otp}</p><p style="font-size:14px;line-height:1.5;margin:0;color:#475569">Если вы не запрашивали вход, просто проигнорируйте это письмо.</p></td></tr></table></td></tr></table></body></html>`;
 return {subject,text,html};
}
