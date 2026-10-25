'use strict';
// ABOUTME: Управляет owner-only Groq intake в Telegram Mini App для отдельного native Hermes PROD.
// ABOUTME: Использует только HTTPS и тот же origin; сервер сверяет его с защищённой конфигурацией.
(async () => {
  const status = document.getElementById('status');
  const area = document.getElementById('form-area');
  const webapp = window.Telegram && window.Telegram.WebApp;
  const fail = 'Не удалось выполнить запрос. Откройте приложение заново из Telegram. Не отправляйте ключ в чат.';
  if (location.protocol !== 'https:' || !webapp || !webapp.initData) {
    status.textContent = 'Откройте эту форму кнопкой Mini App в личной переписке с ботом Telegram. Авторизация обязательна.';
    return;
  }
  webapp.ready();
  async function post(path, data) {
    const response = await fetch('/connect/groq/' + path, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(data), cache: 'no-store', credentials: 'omit', redirect: 'error'
    });
    return {ok: response.ok, data: await response.json()};
  }
  let auth;
  try {
    auth = await post('authorize', {init_data: webapp.initData});
  } catch (_) {
    status.textContent = fail;
    return;
  }
  status.textContent = auth.data.message || fail;
  if (!auth.ok || auth.data.status !== 'authorized' || typeof auth.data.operation_token !== 'string') return;
  let operation = auth.data.operation_token;
  auth = null;
  // The input is created only after the server has authenticated the owner.
  const form = document.createElement('form');
  form.autocomplete = 'off';
  const label = document.createElement('label');
  label.textContent = 'API-ключ Groq (начинается с gsk_)';
  const input = document.createElement('input');
  input.id = 'groq-key';
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.autocapitalize = 'none';
  input.required = true;
  input.minLength = 36;
  input.maxLength = 128;
  input.pattern = 'gsk_[A-Za-z0-9_\\-]{32,124}';
  label.htmlFor = input.id;
  const button = document.createElement('button');
  button.type = 'submit';
  button.textContent = 'Проверить и сохранить';
  form.append(label, input, button);
  area.append(form);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!operation || !form.reportValidity()) return;
    button.disabled = true;
    input.disabled = true;
    let key = input.value;
    input.value = '';
    let token = operation;
    operation = null;
    status.textContent = 'Проверяем ключ через Groq…';
    try {
      const pending = post('submit', {init_data: webapp.initData, operation_token: token, api_key: key});
      key = null;
      token = null;
      const result = await pending;
      status.textContent = result.data.message || fail;
    } catch (_) {
      status.textContent = fail;
    } finally {
      key = null;
      token = null;
      form.remove();
    }
  });
  setTimeout(() => {
    if (operation) {
      operation = null;
      input.value = '';
      form.remove();
      status.textContent = 'Срок действия формы истёк. Откройте приложение заново из Telegram.';
    }
  }, 600000);
})();
