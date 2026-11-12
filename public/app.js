// Модус Идеи — Telegram Mini App (без сборки, чистый JS)
const tg = window.Telegram?.WebApp;
const S = {
  me: null, level: null, cfg: null, tickets: [], now: Date.now(),
  tab: 'board', filter: 'all', q: '', adminTab: 'stats', topPeriod: 'month',
  demoUser: null, openTicketId: null, users: null,
};
const COLUMNS = ['new', 'discussion', 'in_progress', 'review', 'done'];
const ROLE_LABEL = { employee: 'Сотрудник', manager: 'Руководитель', admin: 'Администратор', owner: 'Собственник' };
const ROLE_RANK = { employee: 1, manager: 2, admin: 3, owner: 4 };
const TX_ICON = { win: '🏆', done: '🚀', ontime: '⏱', proposal: '💡', report: '👁', manual: '🎖', redeem: '🎁', refund: '↩️' };
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isManager = () => (ROLE_RANK[S.me?.role] || 0) >= ROLE_RANK.manager;
const isAdmin = () => (ROLE_RANK[S.me?.role] || 0) >= ROLE_RANK.admin;
const isOwner = () => S.me?.role === 'owner';
try { S.demoUser = localStorage.getItem('demoUser'); } catch { /* приватный режим */ }

// ---------- API ----------
async function api(path, { method, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (tg?.initData) headers['x-init-data'] = tg.initData;
  else if (S.demoUser) headers['x-demo-user'] = S.demoUser;
  const res = await fetch(path, { method: method || (body ? 'POST' : 'GET'), headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Нет связи с сервером');
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- Утилиты ----------
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2600);
}
const haptic = (type = 'light') => { try { tg?.HapticFeedback?.impactOccurred(type); } catch { /* вне Telegram */ } };
const success = () => { try { tg?.HapticFeedback?.notificationOccurred('success'); } catch { /* вне Telegram */ } };

function confirmAsk(text) {
  return new Promise((resolve) => {
    if (tg?.showConfirm && tg.initData) tg.showConfirm(text, resolve);
    else resolve(window.confirm(text));
  });
}

async function act(fn, okText) {
  try {
    const r = await fn();
    if (okText) { toast(okText); success(); }
    return r;
  } catch (e) {
    toast(e.message);
    try { tg?.HapticFeedback?.notificationOccurred('error'); } catch { /* вне Telegram */ }
    return null;
  }
}

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} дн назад` : new Date(ts).toLocaleDateString('ru-RU');
}
function dueInfo(t) {
  if (['done', 'rejected'].includes(t.status)) return null;
  const left = t.deadline_at - Date.now();
  const h = Math.abs(left) / 36e5;
  const txt = h < 24 ? `${Math.max(1, Math.round(h))} ч` : `${Math.round(h / 24)} дн`;
  if (left < 0) return { cls: 'over', text: `просрочено ${txt}` };
  return { cls: left < 12 * 36e5 ? 'soon' : '', text: `${txt}` };
}
const initials = (name) => (name || '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
function avatar(u, cls = '') {
  const name = u.user_name || [u.first_name, u.last_name].filter(Boolean).join(' ');
  return u.photo_url
    ? `<img class="avatar ${cls}" src="${esc(u.photo_url)}" alt="">`
    : `<span class="avatar ${cls}">${esc(initials(name))}</span>`;
}
const fmt = (n) => Number(n || 0).toLocaleString('ru-RU');
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const hours = (h) => (h == null ? '—' : h < 48 ? `${h.toFixed(1)} ч` : `${(h / 24).toFixed(1)} дн`);

// ---------- Запуск ----------
const DESKTOP_PLATFORMS = ['tdesktop', 'macos', 'web', 'weba', 'webk', 'unigram'];
const isDesktopTg = () => Boolean(tg?.initData) && DESKTOP_PLATFORMS.includes(tg.platform);

// Кнопка в шапке: войти в полный экран и выйти из него (только на компьютере)
function fullscreenButton() {
  if (!isDesktopTg() || !tg.isVersionAtLeast?.('8.0')) return '';
  return `<button class="fs-btn" id="fs-btn" title="${tg.isFullscreen ? 'Выйти из полного экрана' : 'На весь экран'}">${tg.isFullscreen ? '🗗' : '⛶'}</button>`;
}

async function boot() {
  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor('#ffffff'); tg.setBackgroundColor('#dbe2eb'); tg.setBottomBarColor?.('#dbe2eb'); } catch { /* старые клиенты */ }
    tg.BackButton?.onClick(closeSheet);
    // На компьютере приложение сразу раскрывается на весь экран, как сайт
    if (isDesktopTg() && tg.isVersionAtLeast?.('8.0') && !tg.isFullscreen) {
      try { tg.requestFullscreen(); } catch { /* клиент не поддерживает полный экран */ }
    }
    tg.onEvent?.('fullscreenChanged', () => {
      document.body.classList.toggle('tg-fullscreen', Boolean(tg.isFullscreen));
      const b = $('#fs-btn');
      if (b) { b.textContent = tg.isFullscreen ? '🗗' : '⛶'; b.title = tg.isFullscreen ? 'Выйти из полного экрана' : 'На весь экран'; }
    });
  }
  document.body.classList.toggle('desktop', isDesktopTg() || (!tg?.initData && window.innerWidth >= 900));
  if (!tg?.initData && !S.demoUser) return showGate();
  try {
    const data = await api('/api/auth', { method: 'POST' });
    S.me = data.user; S.level = data.level; S.cfg = data.config;
  } catch (e) {
    if (!tg?.initData && e.status === 401) { S.demoUser = null; return showGate(); }
    return showError(e.message);
  }
  // Разрешение боту писать в личку — для уведомлений о решениях и коинах
  try {
    if (tg?.initData && !localStorage.getItem('askedWrite')) {
      tg.requestWriteAccess?.();
      localStorage.setItem('askedWrite', '1');
    }
  } catch { /* не критично */ }
  // Регистрация: при первом входе сотрудник обязательно указывает должность
  if (!S.me.position) return showOnboarding();
  return startApp();
}

async function startApp() {
  $('#topbar').hidden = false;
  const start = tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('t');
  // Собственник по ссылке-приглашению сразу попадает в раздел «Команда»
  if (isOwner() && String(start || '').startsWith('own')) { S.tab = 'admin'; S.adminTab = 'report'; toast('Вы зарегистрированы как собственник'); }
  else if (isOwner()) S.adminTab = 'report';
  renderTabbar();
  if (S.tab === 'admin') return renderAdmin();
  await loadBoard();
  const startId = start && Number(String(start).replace(/^t/, ''));
  if (startId) openTicket(startId);
}

async function showGate() {
  const view = $('#view');
  $('#topbar').innerHTML = '';
  let meta = {};
  try { meta = await api('/api/public/meta'); } catch { /* нет сети */ }
  if (meta.demo && meta.demoUsers?.length) {
    view.innerHTML = `<div class="gate"><img class="brand-logo" src="/brand-logo.svg" alt="Модус Трейд"><h2>Модус Идеи</h2>
      <p class="muted">Демо-режим: выберите, под кем войти. В Telegram вход происходит автоматически.</p>
      <div class="demo-users">${meta.demoUsers.map((u) => `<button class="btn plain block" data-demo="${u.id}">
        ${esc(u.first_name)} ${esc(u.last_name)} · <span class="muted">${ROLE_LABEL[u.role]}, ${esc(u.department || '')}</span></button>`).join('')}</div></div>`;
    view.querySelectorAll('[data-demo]').forEach((b) => b.addEventListener('click', () => {
      S.demoUser = b.dataset.demo;
      try { localStorage.setItem('demoUser', S.demoUser); } catch { /* приватный режим */ }
      view.innerHTML = '<div class="loader">Загрузка…</div>';
      boot();
    }));
    return;
  }
  const bot = meta.bot ? `<a class="btn" href="https://t.me/${esc(meta.bot)}">Открыть в Telegram</a>` : '';
  view.innerHTML = `<div class="gate"><img class="brand-logo" src="/brand-logo.svg" alt="Модус Трейд"><h2>Модус Идеи</h2>
    <p class="muted">Приложение работает внутри Telegram. Откройте его из рабочей группы или через бота.</p>${bot}</div>`;
}

function showOnboarding() {
  $('#topbar').hidden = true;
  $('#tabbar').hidden = true;
  const name = [S.me.first_name, S.me.last_name].filter(Boolean).join(' ');
  const list = (id, items) => `<datalist id="${id}">${items.map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`;
  const positions = [...new Set([...(S.cfg.positions || []), 'Менеджер по продажам', 'Инженер-проектировщик', 'Сервисный инженер',
    'Монтажник', 'Специалист по закупкам', 'Программист', 'Руководитель отдела', 'Бухгалтер'])];
  const departments = [...new Set([...(S.cfg.departments || []), 'Продажи', 'Проектирование', 'Сервис', 'Монтаж', 'Закупки и склад', 'IT-разработка', 'Управление'])];
  $('#view').innerHTML = `<div class="gate" style="padding-top:32px">
    <img class="brand-logo" src="/brand-logo.svg" alt="Модус Трейд">
    <h2>Добро пожаловать, ${esc(S.me.first_name || 'коллега')}!</h2>
    <p class="muted" style="margin:0">Завершите регистрацию: укажите должность — по ней коллеги и руководители поймут, к кому обращаться.</p>
    <div class="box" style="width:100%;max-width:440px;text-align:left;display:flex;flex-direction:column;gap:14px">
      <div class="row">${avatar(S.me)}<div class="grow"><b>${esc(name)}</b><div class="small muted">${S.me.username ? '@' + esc(S.me.username) : 'Telegram'}</div></div></div>
      <label class="field"><span>Должность *</span><input class="input" id="ob-position" list="ob-positions" maxlength="80"
        placeholder="Например: сервисный инженер" value="${isOwner() ? 'Собственник' : ''}">${list('ob-positions', positions)}</label>
      <label class="field"><span>Отдел</span><input class="input" id="ob-department" list="ob-departments" maxlength="80"
        placeholder="Например: Сервис" value="${esc(S.me.department || '')}">${list('ob-departments', departments)}</label>
      <button class="btn block" id="ob-save">Завершить регистрацию</button>
    </div></div>`;
  $('#ob-save').addEventListener('click', async (e) => {
    const position = $('#ob-position').value.trim();
    if (position.length < 2) { toast('Укажите вашу должность'); $('#ob-position').focus(); return; }
    e.target.disabled = true;
    const r = await act(() => api('/api/profile', { body: { position, department: $('#ob-department').value } }), 'Регистрация завершена');
    e.target.disabled = false;
    if (!r) return;
    S.me = r.user;
    startApp();
  });
}

function showError(msg) {
  $('#view').innerHTML = `<div class="gate"><img class="brand-logo" src="/brand-logo.svg" alt="Модус Трейд"><h2>Нет доступа</h2><p class="muted">${esc(msg)}</p></div>`;
}

// ---------- Навигация ----------
function renderTabbar() {
  const tabs = [['board', '🗂', 'Доска'], ['mine', '📋', 'Мои'], ['coins', '<i class="mc"></i>', 'Коины'], ['top', '🏆', 'Рейтинг']];
  if (isOwner()) tabs.push(['admin', '👔', 'Команда']);
  else if (isManager()) tabs.push(['admin', '⚙️', 'Управление']);
  const bar = $('#tabbar');
  bar.hidden = false;
  bar.innerHTML = tabs.map(([id, ic, label]) => `<button class="tab ${S.tab === id ? 'on' : ''}" data-tab="${id}"><span class="ic">${ic}</span>${label}</button>`).join('');
  bar.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
}

function switchTab(tab) {
  S.tab = tab;
  haptic('soft');
  renderTabbar();
  window.scrollTo(0, 0);
  ({ board: loadBoard, mine: renderMine, coins: renderCoins, top: renderTop, admin: renderAdmin })[tab]();
}

function renderTopbar(title, extra = '') {
  $('#topbar').innerHTML = `<div class="row"><img class="brand-logo" src="/brand-logo.svg" alt="Модус Трейд"><span class="brand-sep"></span><h1 class="grow">${title}</h1>${extra}
    <button class="coin-chip" id="balance-chip"><i class="mc"></i>${fmt(S.me.balance)}</button>${fullscreenButton()}</div>`;
  $('#balance-chip').addEventListener('click', () => switchTab('coins'));
  $('#fs-btn')?.addEventListener('click', () => {
    try { tg.isFullscreen ? tg.exitFullscreen() : tg.requestFullscreen(); } catch { /* не поддерживается */ }
  });
}

// ---------- Доска ----------
async function loadBoard() {
  renderTopbar('Доска задач');
  if (!S.tickets.length) $('#view').innerHTML = '<div class="loader">Загрузка…</div>';
  const data = await act(() => api('/api/board'));
  if (!data) return;
  S.tickets = data.tickets;
  if (S.tab === 'board') renderBoard();
}

function filteredTickets() {
  const q = S.q.trim().toLowerCase();
  return S.tickets.filter((t) => {
    if (q && !`${t.title} ${t.description} #${t.id}`.toLowerCase().includes(q)) return false;
    switch (S.filter) {
      case 'mine': return t.mine || t.joined || t.assignee_id === S.me.id;
      case 'client': return t.source === 'client';
      case 'hot': return t.hot || (dueInfo(t)?.cls === 'over');
      case 'free': return ['new', 'discussion'].includes(t.status);
      default: return true;
    }
  });
}

function renderBoard() {
  const view = $('#view');
  const chips = [['all', 'Все'], ['free', 'Ждут решения'], ['hot', '🔥 Горящие'], ['mine', 'Мои'], ['client', '📱 От клиентов']];
  const list = filteredTickets();
  view.innerHTML = `
    <div class="toolbar">
      <input class="search" id="search" placeholder="Поиск по задачам" value="${esc(S.q)}">
      <div class="chips">${chips.map(([id, l]) => `<button class="chip ${S.filter === id ? 'on' : ''}" data-filter="${id}">${l}</button>`).join('')}</div>
    </div>
    <div class="board">${COLUMNS.map((st) => {
      const items = list.filter((t) => t.status === st);
      return `<section class="column st-${st}"><div class="column-head"><span>${S.cfg.statuses[st]}</span><span class="count">${items.length}</span></div>
        <div class="column-body">${items.map(cardHtml).join('') || '<div class="empty">Пусто</div>'}</div></section>`;
    }).join('')}</div>
    <button class="fab" id="fab" aria-label="Новое обращение"><span class="plus">+</span>Сообщить</button>`;
  $('#search').addEventListener('input', (e) => {
    S.q = e.target.value;
    const pos = e.target.selectionStart;
    renderBoard();
    const input = $('#search');
    input.focus();
    input.setSelectionRange(pos, pos);
  });
  view.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { S.filter = b.dataset.filter; renderBoard(); }));
  view.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openTicket(Number(b.dataset.open))));
  $('#fab').addEventListener('click', openNewTicket);
}

function cardHtml(t) {
  const due = dueInfo(t);
  return `<button class="card p-${t.priority}" data-open="${t.id}">
    <div class="card-top">
      <span class="pill" style="--c:${esc(t.category_color)}">${esc(t.category_emoji)} ${esc(t.category_name)}</span>
      ${t.source === 'client' ? '<span class="tag client">QR</span>' : ''}
      ${t.hot ? '<span class="tag hot">🔥</span>' : ''}
      ${t.joined ? '<span class="tag joined">я в деле</span>' : ''}
      ${t.assignee_id && t.assignee_id === t.author_id && !t.winner_solution_id ? '<span class="tag self">сам</span>' : ''}
    </div>
    <div class="card-title">${esc(t.title)}</div>
    <div class="card-meta">
      <span class="reward-n"><i class="mc"></i>${t.reward}</span>
      ${t.solutions_count ? `<span>💡 ${t.solutions_count}</span>` : ''}
      ${t.participants_count ? `<span>👥 ${t.participants_count}</span>` : ''}
      ${t.assignee_name ? `<span>👤 ${esc(t.assignee_name.split(' ')[0])}</span>` : ''}
      ${due ? `<span class="due ${due.cls}">⏱ ${due.text}</span>` : ''}
      <span class="muted">#${t.id}</span>
    </div>
  </button>`;
}

// ---------- Шторка ----------
function openSheet(html) {
  const sheet = $('#sheet');
  sheet.innerHTML = html;
  sheet.hidden = false;
  $('#sheet-backdrop').hidden = false;
  document.body.style.overflow = 'hidden';
  tg?.BackButton?.show();
  sheet.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheet));
  sheet.scrollTop = 0;
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
  document.body.style.overflow = '';
  S.openTicketId = null;
  tg?.BackButton?.hide();
}
document.addEventListener('DOMContentLoaded', () => $('#sheet-backdrop').addEventListener('click', closeSheet));

// ---------- Новое обращение ----------
function openNewTicket() {
  const cats = S.cfg.categories;
  let catId = null;
  openSheet(`
    <div class="sheet-head"><button class="x" data-close>✕</button><b class="grow">Новое обращение</b></div>
    <div class="sheet-body">
      <div class="field"><span>Категория</span>
        <div class="cat-grid">${cats.map((c) => `<button class="cat-opt" data-cat="${c.id}">${esc(c.emoji)} ${esc(c.name)}</button>`).join('')}</div></div>
      <label class="field"><span>Проблема или идея — коротко</span><input class="input" id="nt-title" maxlength="140" placeholder="Например: долго согласуем закупку кабеля"></label>
      <div class="similar" id="nt-similar"></div>
      <label class="field"><span>Подробности</span><textarea class="textarea" id="nt-desc" maxlength="4000" placeholder="Что происходит, где, как часто, к чему приводит"></textarea></label>
      <label class="field"><span>Как решить (необязательно)</span><textarea class="textarea" id="nt-sol" maxlength="3000" placeholder="Если знаете, как исправить — опишите"></textarea></label>
      <label class="field"><span>Срочность</span><select class="select" id="nt-pri">
        ${Object.entries(S.cfg.priorities).map(([k, p]) => `<option value="${k}" ${k === 'medium' ? 'selected' : ''}>${p.label} — решить за ${p.hours < 48 ? p.hours + ' ч' : p.hours / 24 + ' дн'}, награда ${p.reward} МК</option>`).join('')}
      </select></label>
      <label class="check"><input type="checkbox" id="nt-anon"> Попросить команду анонимно (автора не увидит никто)</label>
      <div class="notice"><i class="mc"></i>Когда задача будет решена, вы получите +${S.cfg.coins.report} МК за полезное обращение.</div>
      <div class="mode-grid">
        <button class="mode-btn self" data-mode="self"><span class="e">🛠</span><span class="t">Сделаю сам</span>
          <span class="d">Вы — исполнитель. После приёмки руководителем получите всю награду</span></button>
        <button class="mode-btn team" data-mode="team"><span class="e">🙋</span><span class="t">Попросить команду</span>
          <span class="d">Карточка уйдёт на доску, коллеги предложат решения</span></button>
      </div>
    </div>`);
  const sheet = $('#sheet');
  sheet.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
    catId = Number(b.dataset.cat);
    sheet.querySelectorAll('[data-cat]').forEach((x) => x.classList.toggle('on', x === b));
    haptic('soft');
  }));
  let timer;
  $('#nt-title').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = e.target.value;
      const box = $('#nt-similar');
      if (q.length < 6 || !box) return;
      const r = await api('/api/tickets/similar?q=' + encodeURIComponent(q)).catch(() => ({ items: [] }));
      box.innerHTML = r.items.length
        ? `<div class="notice warn">Похожие обращения уже есть — возможно, стоит присоединиться к ним:${r.items.map((i) =>
          `<a href="#" data-sim="${i.id}">#${i.id} ${esc(i.title)} · ${S.cfg.statuses[i.status]}</a>`).join('')}</div>`
        : '';
      box.querySelectorAll('[data-sim]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); openTicket(Number(a.dataset.sim)); }));
    }, 450);
  });
  sheet.querySelectorAll('[data-mode]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!catId) return toast('Выберите категорию');
    const mode = btn.dataset.mode;
    const buttons = sheet.querySelectorAll('[data-mode]');
    buttons.forEach((b) => (b.disabled = true));
    const r = await act(() => api('/api/tickets', { body: {
      category_id: catId, title: $('#nt-title').value, description: $('#nt-desc').value, mode,
      solution: $('#nt-sol').value, priority: $('#nt-pri').value, anonymous: mode === 'team' && $('#nt-anon').checked,
    } }), mode === 'self' ? 'Задача ваша — удачи!' : 'Запрос отправлен команде');
    buttons.forEach((b) => (b.disabled = false));
    if (r) { closeSheet(); S.filter = 'all'; await loadBoard(); }
  }));
}

// ---------- Карточка задачи ----------
async function openTicket(id) {
  S.openTicketId = id;
  if ($('#sheet').hidden) openSheet('<div class="sheet-head"><button class="x" data-close>✕</button></div><div class="loader">Загрузка…</div>');
  const data = await act(() => api(`/api/tickets/${id}`));
  if (!data || S.openTicketId !== id) return;
  if (isManager() && !S.users) S.users = (await api('/api/users').catch(() => ({ users: [] }))).users;
  renderTicket(data);
}

async function refreshTicket(id) {
  await openTicket(id);
  loadBoard();
}

function renderTicket({ ticket: t, solutions, participants, comments, events }) {
  const st = S.cfg.statuses;
  const due = dueInfo(t);
  const stepIdx = COLUMNS.indexOf(t.status);
  const amAssignee = t.assignee_id === S.me.id;
  const canPropose = ['new', 'discussion'].includes(t.status);
  const open = ['new', 'discussion', 'in_progress', 'review'].includes(t.status);
  const doneBonus = Math.round(t.reward * S.cfg.coins.doneShare);

  const actions = [];
  if (open) actions.push(`<button class="btn ${t.joined ? 'plain' : 'ghost'} sm" data-a="join">${t.joined ? '✓ Вы участник' : '🙋 Подключиться'}</button>`);
  if (amAssignee && t.status === 'in_progress') actions.push('<button class="btn sm" data-a="review">📤 Сдать на проверку</button>');
  if (isManager()) {
    if (t.status === 'new') actions.push('<button class="btn plain sm" data-a="discussion">💬 Открыть обсуждение</button>');
    if (['new', 'discussion'].includes(t.status) && t.assignee_id) actions.push('<button class="btn plain sm" data-a="in_progress">▶️ В работу</button>');
    if (['in_progress', 'review'].includes(t.status)) actions.push('<button class="btn ok sm" data-a="done">✅ Принять и начислить</button>');
    if (t.status === 'review') actions.push('<button class="btn plain sm" data-a="return">↩️ Вернуть</button>');
    if (open) actions.push('<button class="btn danger sm" data-a="rejected">Отклонить</button>');
    if (t.status === 'rejected') actions.push('<button class="btn plain sm" data-a="reopen">Вернуть в обсуждение</button>');
  }

  openSheet(`
    <div class="sheet-head"><button class="x" data-close>✕</button><b class="grow">Задача #${t.id}</b>
      <span class="pill" style="--c:${esc(t.category_color)}">${esc(t.category_emoji)} ${esc(t.category_name)}</span></div>
    <div class="sheet-body">
      <div class="steps">${COLUMNS.map((_, i) => `<i class="${t.status !== 'rejected' && i <= stepIdx ? 'on' : ''}"></i>`).join('')}</div>
      <div class="row wrap small">
        <b>${st[t.status]}</b><span class="muted">·</span>
        <span class="muted">${S.cfg.priorities[t.priority].label} приоритет</span>
        ${due ? `<span class="due ${due.cls}">· ⏱ ${due.cls === 'over' ? due.text : 'осталось ' + due.text}</span>` : ''}
        ${t.source === 'client' ? '<span class="tag client">от клиента по QR</span>' : ''}
      </div>
      <h2 class="t-title">${esc(t.title)}</h2>
      ${t.description ? `<p class="t-desc">${esc(t.description)}</p>` : ''}

      <div class="reward-box">
        <div class="n"><i class="mc"></i>${t.reward}</div>
        <div class="small grow">${t.hot ? '<b>🔥 Награда выросла — задачу долго никто не брал.</b><br>' : ''}
          За лучшее решение. Исполнителю ещё +${doneBonus} МК за внедрение и +${S.cfg.coins.onTime} МК, если в срок. Каждому предложившему — +${S.cfg.coins.proposal} МК.</div>
      </div>

      <dl class="kv box">
        <dt>Автор</dt><dd>${t.source === 'client' ? `Клиент${t.client_name ? ': ' + esc(t.client_name) : ''}` : esc(t.author_name || '—')}</dd>
        ${t.client_contact ? `<dt>Контакт</dt><dd>${esc(t.client_contact)}</dd>` : ''}
        <dt>Создано</dt><dd>${ago(t.created_at)}</dd>
        <dt>Исполнитель</dt><dd>${esc(t.assignee_name || 'не назначен')}</dd>
        <dt>Участники</dt><dd class="row wrap">${participants.map((p) => avatar(p, 'sm')).join('') || '<span class="muted">пока никого</span>'}</dd>
      </dl>

      ${t.resolution ? `<div class="box"><h3>${t.status === 'rejected' ? 'Причина отклонения' : 'Результат'}</h3><p class="t-desc">${esc(t.resolution)}</p></div>` : ''}
      ${actions.length ? `<div class="actions">${actions.join('')}</div>` : ''}
      ${isManager() && open ? managerTools(t) : ''}

      <div class="box">
        <h3>💡 Решения ${solutions.length ? `<span class="muted">${solutions.length}</span>` : ''}</h3>
        <div class="list" style="gap:8px">${solutions.map((s) => solutionHtml(s, t)).join('') || '<div class="muted small">Решений пока нет. Предложите первым — это +' + S.cfg.coins.proposal + ' МК и шанс получить ' + t.reward + ' МК.</div>'}</div>
        ${canPropose ? `<div class="field" style="margin-top:10px"><textarea class="textarea" id="sol-text" placeholder="Как бы вы решили эту проблему?"></textarea>
          <button class="btn block" id="sol-send" style="margin-top:6px">Предложить решение</button></div>` : ''}
      </div>

      <div class="box">
        <h3>💬 Обсуждение</h3>
        <div class="list" style="gap:10px">${comments.map((c) => `<div class="comment">${avatar(c, 'sm')}<div class="bubble">
          <div class="small"><b>${esc(c.user_name || 'Система')}</b> <span class="muted">· ${ago(c.created_at)}</span></div><p>${esc(c.text)}</p></div></div>`).join('') || '<div class="muted small">Комментариев нет</div>'}</div>
        <div class="row" style="margin-top:10px"><input class="input grow" id="cm-text" placeholder="Комментарий или вопрос"><button class="btn" id="cm-send">➤</button></div>
      </div>

      <details class="box"><summary class="small muted">История изменений</summary><div class="history" style="margin-top:8px">
        ${events.map((e) => `<div>${ago(e.created_at)} — ${esc(e.user_name || 'Система')}: ${esc(eventText(e))}</div>`).join('')}</div></details>
    </div>`);

  const sheet = $('#sheet');
  sheet.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => ticketAction(t, b.dataset.a)));
  sheet.querySelectorAll('[data-vote]').forEach((b) => b.addEventListener('click', async () => {
    haptic('soft');
    if (await act(() => api(`/api/solutions/${b.dataset.vote}/vote`, { method: 'POST' }))) openTicket(t.id);
  }));
  sheet.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmAsk(`Выбрать это решение лучшим? Автор получит ${t.reward} МК и станет исполнителем.`))) return;
    if (await act(() => api(`/api/tickets/${t.id}/winner`, { body: { solution_id: Number(b.dataset.win) } }), '🏆 Победитель выбран')) refreshTicket(t.id);
  }));
  $('#sol-send')?.addEventListener('click', async () => {
    if (await act(() => api(`/api/tickets/${t.id}/solutions`, { body: { text: $('#sol-text').value } }), 'Решение отправлено')) refreshTicket(t.id);
  });
  const sendComment = async () => {
    const text = $('#cm-text').value;
    if (!text.trim()) return;
    if (await act(() => api(`/api/tickets/${t.id}/comments`, { body: { text } }))) openTicket(t.id);
  };
  $('#cm-send').addEventListener('click', sendComment);
  $('#cm-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendComment(); });
  $('#mt-save')?.addEventListener('click', async () => {
    const body = {
      priority: $('#mt-pri').value, category_id: Number($('#mt-cat').value),
      assignee_id: $('#mt-asg').value ? Number($('#mt-asg').value) : null,
    };
    const reward = $('#mt-reward');
    if (reward && Number(reward.value) !== t.reward) body.reward = Number(reward.value);
    if (await act(() => api(`/api/tickets/${t.id}`, { method: 'PATCH', body }), 'Сохранено')) refreshTicket(t.id);
  });
}

function solutionHtml(s, t) {
  const canWin = isManager() && ['new', 'discussion'].includes(t.status) && !t.winner_solution_id;
  return `<div class="solution ${s.is_winner ? 'win' : ''}">
    <div class="row">${avatar(s, 'sm')}<b class="small grow">${esc(s.user_name)}${s.is_winner ? ' · 🏆 лучшее решение' : ''}</b><span class="muted small">${ago(s.created_at)}</span></div>
    <p>${esc(s.text)}</p>
    <div class="row">
      <button class="vote ${s.voted ? 'on' : ''}" data-vote="${s.id}" ${s.mine ? 'disabled title="Своё решение"' : ''}>👍 ${s.votes}</button>
      <span class="grow"></span>
      ${canWin ? `<button class="btn sm" data-win="${s.id}">🏆 Выбрать лучшим</button>` : ''}
    </div></div>`;
}

function managerTools(t) {
  const users = (S.users || []).filter((u) => u.active);
  return `<details class="box"><summary class="small"><b>⚙️ Параметры задачи</b></summary>
    <div class="sheet-body" style="padding:10px 0 0">
      <label class="field"><span>Категория</span><select class="select" id="mt-cat">${S.cfg.categories.map((c) => `<option value="${c.id}" ${c.id === t.category_id ? 'selected' : ''}>${esc(c.emoji)} ${esc(c.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Приоритет (меняет срок)</span><select class="select" id="mt-pri">${Object.entries(S.cfg.priorities).map(([k, p]) => `<option value="${k}" ${k === t.priority ? 'selected' : ''}>${p.label}</option>`).join('')}</select></label>
      ${t.winner_solution_id ? '' : `<label class="field"><span>Награда, МК</span><input class="input" id="mt-reward" type="number" min="0" max="10000" value="${t.reward}"></label>`}
      <label class="field"><span>Исполнитель (без конкурса решений)</span><select class="select" id="mt-asg"><option value="">— не назначен —</option>
        ${users.map((u) => `<option value="${u.id}" ${u.id === t.assignee_id ? 'selected' : ''}>${esc(u.first_name)} ${esc(u.last_name)}${u.department ? ' · ' + esc(u.department) : ''}</option>`).join('')}</select></label>
      <button class="btn plain block" id="mt-save">Сохранить</button>
    </div></details>`;
}

function eventText(e) {
  const st = S.cfg.statuses;
  switch (e.type) {
    case 'created': return 'создал(а) обращение' + (e.data ? ` (${e.data})` : '');
    case 'joined': return 'подключился(-ась)';
    case 'solution': return 'предложил(а) решение';
    case 'winner': return `выбрано лучшее решение: ${e.data}`;
    case 'edited': return `изменения: ${e.data || ''}`;
    case 'status': {
      const [to, ...rest] = (e.data || '').split(': ');
      return `статус → ${st[to] || to}${rest.length ? ': ' + rest.join(': ') : ''}`;
    }
    default: return e.type;
  }
}

async function askText(title, placeholder, required = true) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-backdrop';
    wrap.style.zIndex = 30;
    wrap.innerHTML = `<div class="box" style="position:absolute;left:16px;right:16px;top:20%;max-width:480px;margin:auto">
      <h3>${esc(title)}</h3><textarea class="textarea" placeholder="${esc(placeholder)}"></textarea>
      <div class="row" style="margin-top:10px"><button class="btn plain grow" data-r="0">Отмена</button><button class="btn grow" data-r="1">Готово</button></div></div>`;
    document.body.appendChild(wrap);
    const ta = wrap.querySelector('textarea');
    ta.focus();
    wrap.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => {
      const v = ta.value.trim();
      if (b.dataset.r === '1' && required && v.length < 5) return toast('Напишите пару слов');
      wrap.remove();
      resolve(b.dataset.r === '1' ? v : null);
    }));
  });
}

async function ticketAction(t, a) {
  haptic();
  const setStatus = async (status, text, okText) => {
    if (await act(() => api(`/api/tickets/${t.id}/status`, { body: { status, text } }), okText)) refreshTicket(t.id);
  };
  switch (a) {
    case 'join':
      if (await act(() => api(`/api/tickets/${t.id}/join`, { method: 'POST' }))) refreshTicket(t.id);
      break;
    case 'discussion': return setStatus('discussion', '', 'Обсуждение открыто');
    case 'reopen': return setStatus('discussion', '', 'Задача возвращена');
    case 'in_progress': return setStatus('in_progress', '', 'Задача в работе');
    case 'review': {
      const text = await askText('Что сделано?', 'Опишите результат — руководитель проверит и начислит коины');
      if (text) setStatus('review', text, 'Отправлено на проверку');
      break;
    }
    case 'done': {
      const text = await askText('Итог для автора и клиента', 'Что сделано и как проблема решена', !t.resolution);
      if (text !== null) setStatus('done', text, '✅ Задача решена, коины начислены');
      break;
    }
    case 'return': {
      const text = await askText('Что доработать?', 'Комментарий исполнителю');
      if (text) setStatus('in_progress', text, 'Возвращено в работу');
      break;
    }
    case 'rejected': {
      const text = await askText('Причина отклонения', 'Например: дубликат #12, не в зоне ответственности');
      if (text) setStatus('rejected', text, 'Отклонено');
      break;
    }
    default:
  }
}

// ---------- Мои ----------
async function renderMine() {
  renderTopbar('Мои задачи');
  const view = $('#view');
  view.innerHTML = '<div class="loader">Загрузка…</div>';
  const d = await act(() => api('/api/me'));
  if (!d) return;
  const groups = { assignee: 'Я исполнитель', participant: 'Я участвую', author: 'Мои обращения' };
  view.innerHTML = `<div class="page">${Object.entries(groups).map(([rel, title]) => {
    const items = d.tickets.filter((t) => t.relation === rel);
    return `<div class="box"><h3>${title} <span class="muted">${items.length}</span></h3><div class="list">
      ${items.map((t) => { const due = dueInfo(t); return `<button class="list-item btn" data-open="${t.id}">
        <div class="grow"><div>${esc(t.title)}</div><div class="small muted">#${t.id} · ${S.cfg.statuses[t.status]}${due ? ` · <span class="due ${due.cls}">⏱ ${due.text}</span>` : ''}</div></div>
        <span class="amount"><i class="mc"></i>${t.reward}</span></button>`; }).join('') || '<div class="muted small">Пока пусто</div>'}
    </div></div>`;
  }).join('')}</div>`;
  view.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openTicket(Number(b.dataset.open))));
}

// ---------- Коины ----------
async function renderCoins() {
  renderTopbar('Модус-коины');
  const view = $('#view');
  view.innerHTML = '<div class="loader">Загрузка…</div>';
  const [d, s] = await Promise.all([act(() => api('/api/me')), act(() => api('/api/shop'))]);
  if (!d || !s) return;
  S.me = d.user; S.level = d.level;
  renderTopbar('Модус-коины');
  const lv = d.level;
  const progress = lv.next ? (d.user.earned_total - lv.min) / (lv.next.min - lv.min) : 1;
  const c = S.cfg.coins;
  view.innerHTML = `<div class="page">
    <div class="box hero">
      <div class="muted small">Ваш баланс</div>
      <div class="big"><i class="mc"></i>${fmt(d.user.balance)}</div>
      <div class="small"><b>Уровень ${lv.index}: ${lv.name}</b> · заработано всего ${fmt(d.user.earned_total)} МК</div>
      <div class="progress"><i style="width:${Math.min(100, progress * 100)}%"></i></div>
      <div class="small muted">${lv.next ? `До уровня «${lv.next.name}» — ${fmt(lv.next.min - d.user.earned_total)} МК` : 'Максимальный уровень!'}</div>
    </div>

    <div class="box"><h3>🎁 Обменять коины</h3><div class="shop-grid">
      ${s.rewards.map((r) => `<div class="reward"><span class="e">${esc(r.emoji)}</span><span class="t">${esc(r.title)}</span>
        <span class="d">${esc(r.description)}</span>
        <button class="btn sm ${d.user.balance >= r.price ? '' : 'plain'}" data-buy="${r.id}" data-price="${r.price}" data-title="${esc(r.title)}" ${d.user.balance >= r.price ? '' : 'disabled'}><i class="mc"></i>${fmt(r.price)}</button></div>`).join('')}
    </div></div>

    ${d.redemptions.length ? `<div class="box"><h3>Мои заявки на обмен</h3><div class="list">${d.redemptions.map((r) => `<div class="list-item">
      <span>${esc(r.emoji)}</span><div class="grow"><div>${esc(r.title)}</div><div class="small muted">${ago(r.created_at)}${r.note ? ' · ' + esc(r.note) : ''}</div></div>
      <span class="small ${r.status === 'approved' ? 'amount plus' : r.status === 'rejected' ? 'amount minus' : 'muted'}">${{ pending: 'на рассмотрении', approved: 'одобрено', rejected: 'отклонено' }[r.status]}</span></div>`).join('')}</div></div>` : ''}

    <div class="box"><h3>🏅 Достижения</h3><div class="ach-grid">
      ${d.achievements.map((a) => `<div class="ach ${a.got ? '' : 'off'}" title="${esc(a.hint)}"><span class="e">${a.emoji}</span><b>${esc(a.title)}</b><div class="muted">${esc(a.hint)}</div></div>`).join('')}
    </div></div>

    <div class="box"><h3>Как заработать</h3><ul class="rules">
      <li>💡 Предложить решение — <b>+${c.proposal}</b> каждому участнику, когда задача закрыта</li>
      <li>🏆 Ваше решение выбрали лучшим — <b>награда задачи</b> (${S.cfg.priorities.low.reward}–${S.cfg.priorities.high.reward} МК)</li>
      <li>🚀 Внедрили решение — <b>+${Math.round(c.doneShare * 100)}%</b> от награды</li>
      <li>⏱ Успели до дедлайна — <b>+${c.onTime}</b></li>
      <li>👁 Сообщили о реальной проблеме — <b>+${c.report}</b></li>
      <li>🔥 Горящие задачи: если за ${c.hotAfterHours} ч никто не взялся, награда растёт на ${Math.round(c.hotStep * 100)}% в день (до x${c.hotMax})</li>
    </ul></div>

    <div class="box"><h3>История</h3><div class="list">${d.tx.map((x) => `<div class="list-item"><span>${TX_ICON[x.kind] || '<i class="mc"></i>'}</span>
      <div class="grow"><div class="small">${esc(x.reason)}</div><div class="small muted">${ago(x.created_at)}</div></div>
      <span class="amount ${x.amount > 0 ? 'plus' : 'minus'}">${x.amount > 0 ? '+' : ''}${x.amount}</span></div>`).join('') || '<div class="muted small">Здесь появятся начисления</div>'}</div></div>
  </div>`;
  view.querySelectorAll('[data-buy]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmAsk(`Обменять ${b.dataset.price} МК на «${b.dataset.title}»? Заявку подтвердит администратор.`))) return;
    if (await act(() => api(`/api/shop/${b.dataset.buy}/redeem`, { method: 'POST' }), '🎁 Заявка отправлена')) renderCoins();
  }));
}

// ---------- Рейтинг ----------
async function renderTop() {
  renderTopbar('Рейтинг');
  const view = $('#view');
  const d = await act(() => api('/api/leaderboard?period=' + S.topPeriod));
  if (!d) return;
  const medal = ['🥇', '🥈', '🥉'];
  view.innerHTML = `<div class="page">
    <div class="seg"><button data-p="month" class="${S.topPeriod === 'month' ? 'on' : ''}">Этот месяц</button><button data-p="all" class="${S.topPeriod === 'all' ? 'on' : ''}">За всё время</button></div>
    <div class="box"><div class="list">${d.rows.map((r, i) => `<div class="list-item" ${r.id === S.me.id ? 'style="background:var(--soft);border-radius:10px;padding-left:6px"' : ''}>
      <span style="width:24px;text-align:center">${medal[i] || i + 1}</span>${avatar(r)}
      <div class="grow"><div>${esc(r.first_name)} ${esc(r.last_name)}</div><div class="small muted">${esc(r.department || '')} · ${r.level.name}</div></div>
      <span class="amount"><i class="mc"></i>${fmt(r.score)}</span></div>`).join('') || '<div class="muted small">Пока никто не заработал коины в этом периоде — станьте первым!</div>'}</div></div>
  </div>`;
  view.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => { S.topPeriod = b.dataset.p; renderTop(); }));
}

// ---------- Управление ----------
function renderAdmin() {
  renderTopbar(isOwner() ? 'Команда' : 'Управление');
  const tabs = isAdmin() ? [['report', 'Доклад'], ['team', 'Команда'], ['stats', 'Аналитика']] : [['stats', 'Аналитика']];
  if (isAdmin()) tabs.push(['users', 'Люди'], ['config', 'Настройки'], ['redeem', 'Обмен'], ['qr', 'QR-коды'], ['settings', 'Справочники']);
  if (!tabs.some(([id]) => id === S.adminTab)) S.adminTab = tabs[0][0];
  $('#view').innerHTML = `<div class="page"><div class="seg">${tabs.map(([id, l]) => `<button data-at="${id}" class="${S.adminTab === id ? 'on' : ''}">${l}</button>`).join('')}</div><div id="admin-body"><div class="loader">Загрузка…</div></div></div>`;
  $('#view').querySelectorAll('[data-at]').forEach((b) => b.addEventListener('click', () => { S.adminTab = b.dataset.at; renderAdmin(); }));
  ({ report: adminReport, team: adminTeam, stats: adminStats, redeem: adminRedeem, qr: adminQr, users: adminUsers, config: adminConfig, settings: adminSettings })[S.adminTab]();
}

// Настройки приложения: правила Модус-коинов, сроки, переключатели, рабочая группа
async function adminConfig() {
  const d = await act(() => api('/api/settings'));
  if (!d) return;
  const P = d.priority;
  const C = d.coins;
  const numField = (id, label, value, hint = '') => `<label class="field"><span>${label}</span>
    <input class="input" type="number" inputmode="decimal" id="${id}" value="${value}">${hint ? `<span class="small muted">${hint}</span>` : ''}</label>`;
  $('#admin-body').innerHTML = `<div class="page" style="padding:0">
    <div class="box"><h3>Компания</h3>
      <label class="field"><span>Название (видно клиентам на QR-форме и на плакатах)</span><input class="input" id="cf-company" maxlength="80" value="${esc(d.company)}"></label></div>
    <div class="box"><h3>Награды и сроки по приоритету</h3>
      ${Object.entries(P).map(([k, p]) => `<div class="row" style="align-items:flex-end;margin-bottom:10px">
        <b style="width:84px;padding-bottom:12px">${esc(p.label)}</b>
        <div class="grow">${numField(`cf-r-${k}`, 'Награда, МК', p.reward)}</div>
        <div class="grow">${numField(`cf-h-${k}`, 'Срок, часов', p.hours)}</div></div>`).join('')}</div>
    <div class="box"><h3>Бонусы <i class="mc"></i></h3>
      <div class="kpis" style="gap:10px">
        ${numField('cf-done', 'За внедрение, % от награды', Math.round(C.doneShare * 100))}
        ${numField('cf-ontime', 'Закрыто в срок, МК', C.onTime)}
        ${numField('cf-proposal', 'За предложенное решение, МК', C.proposal)}
        ${numField('cf-report', 'Автору обращения, МК', C.report)}
      </div></div>
    <div class="box"><h3>🔥 Горящие задачи</h3>
      <div class="kpis" style="gap:10px">
        ${numField('cf-hot-after', 'Становится горящей через, ч', C.hotAfterHours)}
        ${numField('cf-hot-step', 'Рост награды в сутки, %', Math.round(C.hotStep * 100))}
        ${numField('cf-hot-max', 'Максимум, × от награды', C.hotMax)}
      </div></div>
    <div class="box"><h3>Функции</h3><div class="list">
      <label class="check list-item"><input type="checkbox" id="cf-digest" ${d.digest ? 'checked' : ''}> Утренняя сводка в рабочей группе (горящие и просроченные задачи)</label>
      <label class="check list-item"><input type="checkbox" id="cf-qr" ${d.clientQr ? 'checked' : ''}> Приём обращений клиентов по QR-кодам</label>
      <label class="check list-item"><input type="checkbox" id="cf-weekly" ${d.weeklyReport ? 'checked' : ''}> Доклад собственнику в Telegram каждый понедельник</label>
    </div></div>
    <button class="btn block" id="cf-save">Сохранить настройки</button>
    <button class="btn plain block" id="cf-reset">Вернуть значения по умолчанию</button>
    <div class="box"><h3>Рабочая группа</h3>
      ${d.group ? `<p style="margin:0 0 10px">Подключена: <b>${esc(d.group.title || d.group.id)}</b>. Войти могут только её участники.</p>
        <button class="btn danger" id="cf-unbind">Отвязать группу</button>`
        : '<p class="muted" style="margin:0">Не подключена. Добавьте бота в рабочую группу и отправьте там /bind.</p>'}
      <p class="small muted" style="margin:10px 0 0">Бот: @${esc(d.bot || '—')}. Главный администратор задаётся на сервере (ADMIN_IDS).</p></div>
  </div>`;
  const v = (id) => $(`#${id}`).value;
  const collect = () => ({
    company: v('cf-company'),
    priority: Object.fromEntries(Object.keys(P).map((k) => [k, { reward: Number(v(`cf-r-${k}`)), hours: Number(v(`cf-h-${k}`)) }])),
    coins: {
      doneShare: Number(v('cf-done')) / 100, onTime: Number(v('cf-ontime')), proposal: Number(v('cf-proposal')), report: Number(v('cf-report')),
      hotAfterHours: Number(v('cf-hot-after')), hotStep: Number(v('cf-hot-step')) / 100, hotMax: Number(v('cf-hot-max')),
    },
    digest: $('#cf-digest').checked, clientQr: $('#cf-qr').checked, weeklyReport: $('#cf-weekly').checked,
  });
  const save = async (body) => {
    if (await act(() => api('/api/settings', { body }), 'Настройки сохранены')) {
      const fresh = await api('/api/auth', { method: 'POST' }).catch(() => null);
      if (fresh) { S.cfg = fresh.config; S.me = fresh.user; }
      adminConfig();
    }
  };
  $('#cf-save').addEventListener('click', () => save(collect()));
  $('#cf-reset').addEventListener('click', async () => {
    if (!(await confirmAsk('Вернуть награды, сроки и бонусы к значениям по умолчанию?'))) return;
    save({ ...collect(), priority: d.defaults.priority, coins: d.defaults.coins });
  });
  $('#cf-unbind')?.addEventListener('click', async () => {
    if (!(await confirmAsk('Отвязать рабочую группу? Пока не привяжете новую командой /bind, новые сотрудники не смогут войти.'))) return;
    if (await act(() => api('/api/settings/unbind', { method: 'POST' }), 'Группа отвязана')) adminConfig();
  });
}

// Помощник собственника: доклад о нерешённых и решённых проблемах и о том, кто решает, а кто нет
async function adminReport() {
  S.reportDays = S.reportDays || 7;
  const r = await act(() => api(`/api/report?days=${S.reportDays}`));
  if (!r) return;
  const s = r.summary;
  const groups = ['solver', 'active', 'overdue', 'idle', 'fresh'].map((v) => [v, r.staff.filter((p) => p.verdict === v)]).filter(([, l]) => l.length);
  const ticketRow = (t, extra, i) => `<button class="list-item btn" data-t="${t.id}" ${i >= 10 ? 'data-more hidden' : ''}><span class="grow"><b>#${t.id}</b> ${esc(t.title)}<div class="small muted">${extra}</div></span><span class="muted">→</span></button>`;
  const moreBtn = (list) => (list.length > 10 ? `<button class="btn plain sm block" data-show-more style="margin-top:8px">Показать все (${list.length})</button>` : '');
  $('#admin-body').innerHTML = `<div class="page" style="padding:0">
    <div class="box invite"><h3>🤖 Помощник собственника</h3>
      <p class="muted small" style="margin:0">Доклад собирается автоматически из данных доски: что решено, что висит и кто из сотрудников реально решает проблемы.${S.me.role === 'owner' ? ' Каждый понедельник он приходит вам в Telegram.' : ''}</p>
      <div class="seg" style="background:rgba(255,255,255,.12)">${[7, 30, 90].map((d) => `<button data-days="${d}" class="${S.reportDays === d ? 'on' : ''}" style="color:#fff">${d} дней</button>`).join('')}</div>
      <button class="btn" id="rp-send">Прислать доклад в Telegram</button></div>
    <div class="kpis">
      <div class="kpi"><div class="v">${s.created}</div><div class="l">Поступило за период</div></div>
      <div class="kpi"><div class="v">${s.done}</div><div class="l">Решено${s.done ? ` · в срок ${Math.round((s.ontime / s.done) * 100)}%` : ''}</div></div>
      <div class="kpi"><div class="v">${s.open}</div><div class="l">Не решено сейчас</div></div>
      <div class="kpi"><div class="v" style="color:${s.overdue ? 'var(--red)' : 'inherit'}">${s.overdue}</div><div class="l">Просрочено</div></div>
    </div>
    <div class="box"><h3>Главное</h3><ul class="rules">${r.insights.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>
    <div class="box"><h3>Кто решает, а кто нет</h3>${groups.map(([v, list]) => `
      <div class="small muted" style="margin:6px 0;font-weight:800">${r.verdicts[v].icon} ${r.verdicts[v].label} · ${list.length}</div>
      ${list.map((p) => `<div class="member"><div class="row">${avatar(p)}<div class="grow"><b>${esc(p.name)}</b>
        <div class="small muted">${esc(p.position || ROLE_LABEL[p.role] || '')}${p.department ? ' · ' + esc(p.department) : ''} · ${p.last_at ? 'активность ' + ago(p.last_at) : 'ни разу не участвовал(а)'}</div></div>
        <span class="coin-chip"><i class="mc"></i>+${fmt(p.coins)}</span></div>
        <div class="member-stats">
          <div><b>${p.done}</b><span>закрыл(а)</span></div>
          <div><b>${p.solutions}</b><span>решений</span></div>
          <div><b>${p.in_work}</b><span>в работе</span></div>
          <div class="${p.overdue ? 'warn' : ''}"><b>${p.overdue}</b><span>просрочено</span></div>
        </div></div>`).join('')}`).join('') || '<div class="empty">Сотрудников пока нет</div>'}
      <details style="margin-top:12px"><summary class="small muted">Как считается</summary><p class="small muted">
        🏆 «Решает» — за период закрыл(а) задачу или его/её решение выбрано лучшим, без просрочек. ⚠️ «Держит просрочку» — есть задачи в работе с истёкшим сроком.
        ✅ «Участвует» — сообщал(а) о проблемах, предлагал(а) решения или комментировал(а). 💤 «Нет активности» — за период ни одного действия.
        🆕 «Новый» — зарегистрировался(-ась) в этом периоде. Порядок — по вкладу: закрытые задачи, победы, сроки, решения.</p></details></div>
    <div class="box"><h3>Нерешённые проблемы · ${r.open.length}</h3><div class="list">${r.open.map((t, i) => ticketRow(t,
      `${t.overdue ? '<span class="due over">просрочено</span> · ' : ''}${S.cfg.statuses[t.status]} · ${t.assignee_name ? '👤 ' + esc(t.assignee_name) : 'нет исполнителя'} · 💡 ${t.solutions_count} · ${ago(t.created_at)}`, i)).join('') || '<div class="empty">Все проблемы решены 🎉</div>'}</div>${moreBtn(r.open)}</div>
    <div class="box"><h3>Решено за ${r.days} дн. · ${r.solved.length}</h3><div class="list">${r.solved.map((t, i) => ticketRow(t,
      `${t.assignee_name ? '👤 ' + esc(t.assignee_name) : ''} · за ${hours(t.hours)} · ${t.ontime ? 'в срок' : '<span class="due over">с опозданием</span>'}`, i)).join('') || '<div class="empty">За период ничего не решено</div>'}</div>${moreBtn(r.solved)}</div>
  </div>`;
  const body = $('#admin-body');
  body.querySelectorAll('[data-show-more]').forEach((b) => b.addEventListener('click', () => {
    b.closest('.box').querySelectorAll('[data-more]').forEach((x) => (x.hidden = false));
    b.remove();
  }));
  body.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', () => { S.reportDays = Number(b.dataset.days); adminReport(); }));
  body.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => openTicket(Number(b.dataset.t))));
  $('#rp-send').addEventListener('click', () => act(() => api('/api/report/send', { body: { days: S.reportDays } }), 'Доклад отправлен в Telegram'));
}

// Работа команды: вклад каждого сотрудника и живая лента событий
async function adminTeam() {
  const d = await act(() => api('/api/team'));
  if (!d) return;
  const active = d.people.filter((p) => p.last_at);
  const openNow = d.people.reduce((a, p) => a + p.active, 0);
  const overdue = d.people.reduce((a, p) => a + p.overdue, 0);
  $('#admin-body').innerHTML = `<div class="page" style="padding:0">
    <div class="kpis">
      <div class="kpi"><div class="v">${d.people.length}</div><div class="l">Сотрудников в системе</div></div>
      <div class="kpi"><div class="v">${active.length}</div><div class="l">Проявляли активность</div></div>
      <div class="kpi"><div class="v">${openNow}</div><div class="l">Задач в работе</div></div>
      <div class="kpi"><div class="v" style="color:${overdue ? 'var(--red)' : 'inherit'}">${overdue}</div><div class="l">Просрочено исполнителями</div></div>
    </div>
    <div class="box"><h3>Лента событий</h3>${d.feed.length ? d.feed.map((e) => `<div class="feed-item"><span class="dot"></span><div class="grow">
      <b>${esc(e.user_name || 'Система')}</b> ${esc(eventText(e))} — <a href="#" data-t="${e.ticket_id}">#${e.ticket_id} ${esc(e.title)}</a>
      <div class="small muted">${ago(e.created_at)}</div></div></div>`).join('') : '<div class="empty">Пока событий нет</div>'}</div>
    <div class="box"><h3>Сотрудники</h3>${d.people.map((p) => `<div class="member">
      <div class="row">${avatar(p)}<div class="grow"><b>${esc(p.first_name)} ${esc(p.last_name)}</b>
        <div class="small muted">${esc(p.position || ROLE_LABEL[p.role] || p.role)}${p.department ? ' · ' + esc(p.department) : ''} · ${p.last_at ? 'активность ' + ago(p.last_at) : 'ещё не участвовал(а)'}</div></div>
        <span class="coin-chip"><i class="mc"></i>${fmt(p.earned_total)}</span></div>
      <div class="member-stats">
        <div><b>${p.reports}</b><span>обращений</span></div>
        <div><b>${p.solutions}</b><span>решений</span></div>
        <div><b>${p.active}</b><span>в работе</span></div>
        <div class="${p.overdue ? 'warn' : ''}"><b>${p.done}</b><span>${p.overdue ? `закрыто · ${p.overdue} просроч.` : 'закрыто'}</span></div>
      </div></div>`).join('')}</div>
  </div>`;
  $('#admin-body').querySelectorAll('[data-t]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); openTicket(Number(a.dataset.t)); }));
}

async function adminStats() {
  const d = await act(() => api('/api/stats'));
  if (!d) return;
  const maxCat = Math.max(1, ...d.byCategory.map((c) => c.total));
  $('#admin-body').innerHTML = `<div class="page" style="padding:0">
    ${S.cfg.groupBound ? '' : '<div class="notice warn">Рабочая группа не подключена: добавьте бота в группу и отправьте там /bind.</div>'}
    <div class="kpis">
      <div class="kpi"><div class="v">${d.total}</div><div class="l">Всего обращений</div></div>
      <div class="kpi"><div class="v">${pct(d.reviewedShare)}</div><div class="l">Взяты в рассмотрение</div></div>
      <div class="kpi"><div class="v">${pct(d.resultShare)}</div><div class="l">С зафиксированным результатом</div></div>
      <div class="kpi"><div class="v">${d.done}</div><div class="l">Реализовано улучшений</div></div>
      <div class="kpi"><div class="v">${hours(d.avgFirstResponseHours)}</div><div class="l">Время до первой реакции</div></div>
      <div class="kpi"><div class="v">${hours(d.avgResolutionHours)}</div><div class="l">Среднее время решения</div></div>
      <div class="kpi"><div class="v" style="color:${d.overdue ? 'var(--danger)' : 'inherit'}">${d.overdue}</div><div class="l">Просрочено сейчас</div></div>
      <div class="kpi"><div class="v">${fmt(d.coins.issued)}</div><div class="l">МК выдано · ${fmt(d.coins.spent)} обменяно</div></div>
    </div>
    <div class="box"><h3>Повторяющиеся проблемы по категориям</h3>${d.byCategory.map((c) => `<div style="margin-bottom:10px">
      <div class="row small"><span class="grow">${esc(c.emoji)} ${esc(c.name)}</span><span class="muted">${c.total} всего · ${c.open || 0} открыто · ${c.last30 || 0} за 30 дн</span></div>
      <div class="bar" style="--c:${esc(c.color)}"><i style="width:${(c.total / maxCat) * 100}%"></i></div></div>`).join('')}</div>
    <div class="box"><h3>Источники</h3><div class="list">
      ${d.bySource.map((s) => `<div class="list-item"><span class="grow">${s.source === 'client' ? '📱 Клиенты (QR)' : '👥 Сотрудники'}</span><b>${s.n}</b></div>`).join('')}
      ${d.byQr.map((q) => `<div class="list-item small"><span class="grow muted">QR: ${esc(q.title)}</span><span>${q.n}</span></div>`).join('')}
    </div></div>
    ${d.top.length ? `<div class="box"><h3>Чаще всего побеждают</h3><div class="list">${d.top.map((t) => `<div class="list-item"><span class="grow">${esc(t.name)}</span><b>🏆 ${t.wins}</b></div>`).join('')}</div></div>` : ''}
  </div>`;
}

async function adminRedeem() {
  const d = await act(() => api('/api/redemptions'));
  if (!d) return;
  const label = { pending: 'ждёт решения', approved: 'одобрено', rejected: 'отклонено' };
  $('#admin-body').innerHTML = `<div class="box"><div class="list">${d.items.map((r) => `<div class="list-item">
    <span style="font-size:22px">${esc(r.emoji)}</span>
    <div class="grow"><div><b>${esc(r.user_name)}</b> <span class="muted small">${esc(r.department || '')}</span></div>
      <div class="small">${esc(r.title)} · <i class="mc"></i>${fmt(r.price)}</div><div class="small muted">${ago(r.created_at)} · ${label[r.status]}</div></div>
    ${r.status === 'pending' ? `<div class="row"><button class="btn ok sm" data-ok="${r.id}">✓</button><button class="btn danger sm" data-no="${r.id}">✕</button></div>` : ''}
  </div>`).join('') || '<div class="muted small">Заявок пока нет</div>'}</div></div>`;
  const decide = async (id, action) => {
    const note = action === 'reject' ? await askText('Причина отказа', 'Коины вернутся сотруднику', false) : '';
    if (note === null) return;
    if (await act(() => api(`/api/redemptions/${id}`, { body: { action, note } }), action === 'approve' ? 'Одобрено' : 'Отклонено, коины возвращены')) adminRedeem();
  };
  $('#admin-body').querySelectorAll('[data-ok]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.ok, 'approve')));
  $('#admin-body').querySelectorAll('[data-no]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.no, 'reject')));
}

function qrSvg(text) {
  if (!window.qrcode) return '<div class="muted small">QR</div>';
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

function openExternal(url) {
  if (tg?.openLink && tg.initData) tg.openLink(url);
  else window.open(url, '_blank');
}

async function adminQr() {
  const d = await act(() => api('/api/qr'));
  if (!d) return;
  const general = d.base;
  $('#admin-body').innerHTML = `<div class="page" style="padding:0">
    <div class="notice">Клиент сканирует QR, без регистрации описывает проблему — карточка сразу попадает на доску с пометкой «QR» и высоким приоритетом. Клиент получает ссылку для отслеживания статуса.</div>
    <div class="box"><h3>Новая точка</h3><div class="row"><input class="input grow" id="qr-title" placeholder="Где повесим: офис, объект, сервисная машина…"><button class="btn" id="qr-add">Создать</button></div></div>
    ${[{ id: 0, title: 'Общий QR (без точки)', tag: '', tickets: null }, ...d.items].map((q) => {
      const url = general + (q.tag ? '?p=' + encodeURIComponent(q.tag) : '');
      return `<div class="box qr-card"><div class="qr">${qrSvg(url)}</div><div class="grow">
        <b>${esc(q.title)}</b>${q.tickets != null ? `<div class="small muted">обращений: ${q.tickets}</div>` : ''}
        <div class="small muted" style="word-break:break-all">${esc(url)}</div>
        <div class="row wrap" style="margin-top:6px"><button class="btn sm" data-poster="${esc(q.tag)}" data-title="${esc(q.title)}">🖨 Плакат</button>
          <button class="btn plain sm" data-copy="${esc(url)}">Копировать</button>
          ${q.id ? `<button class="btn danger sm" data-del="${q.id}">Удалить</button>` : ''}</div></div></div>`;
    }).join('')}
  </div>`;
  const body = $('#admin-body');
  $('#qr-add').addEventListener('click', async () => {
    if (await act(() => api('/api/qr', { body: { title: $('#qr-title').value } }), 'QR-код создан')) adminQr();
  });
  body.querySelectorAll('[data-poster]').forEach((b) => b.addEventListener('click', () => {
    const p = new URLSearchParams({ p: b.dataset.poster, title: b.dataset.title, company: S.cfg.company });
    openExternal(`${location.origin}/poster.html?${p}`);
  }));
  body.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Ссылка скопирована'); } catch { toast(b.dataset.copy); }
  }));
  body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmAsk('Удалить точку? Напечатанный QR продолжит работать как общий.'))) return;
    if (await act(() => api(`/api/qr/${b.dataset.del}`, { method: 'DELETE' }))) adminQr();
  }));
}

async function adminUsers() {
  const d = await act(() => api('/api/users'));
  if (!d) return;
  S.users = d.users;
  const roleOptions = (u) => Object.entries(ROLE_LABEL)
    .filter(([k]) => k !== 'owner' || isOwner() || u.role === 'owner')
    .map(([k, l]) => `<option value="${k}" ${k === u.role ? 'selected' : ''}>${l}</option>`).join('');
  const locked = (u) => u.id === S.me.id || (u.role === 'owner' && !isOwner());
  const people = d.users.filter((u) => !u.deleted_at);
  const removed = d.users.filter((u) => u.deleted_at);
  $('#admin-body').innerHTML = `<div class="box invite"><h3>Регистрация собственника</h3>
    <p class="muted small" style="margin:0">Собственник видит всю работу команды и получает уведомления обо всех обращениях и решениях. Ему не нужно состоять в рабочей группе. Ссылка одноразовая, действует 7 дней.</p>
    <div id="invite-out"></div><button class="btn" id="invite-btn">Создать ссылку-приглашение</button></div>
    <div class="box"><h3>Сотрудники · ${people.length}</h3><div class="list">${people.map((u) => `<div class="list-item" style="flex-wrap:wrap">
    ${avatar(u)}<div class="grow"><div>${esc(u.first_name)} ${esc(u.last_name)} ${u.active ? '' : '<span class="tag">отключён</span>'}</div>
      <div class="small muted">${u.username ? '@' + esc(u.username) + ' · ' : ''}<i class="mc"></i>${fmt(u.balance)} · всего ${fmt(u.earned_total)}</div></div>
    <input class="input" data-pos="${u.id}" value="${esc(u.position || '')}" placeholder="Должность — не указана" style="width:100%">
    <div class="row" style="width:100%">
      <select class="select" data-role="${u.id}" ${locked(u) ? 'disabled' : ''} style="flex:1;min-width:0">${roleOptions(u)}</select>
      <input class="input" data-dep="${u.id}" value="${esc(u.department || '')}" placeholder="Отдел" style="flex:1;min-width:0">
    </div>
    <div class="row" style="width:100%;justify-content:flex-end">
      <button class="btn plain sm" data-coins="${u.id}" title="Начислить коины"><i class="mc"></i>Коины</button>
      ${locked(u) ? '' : `<button class="btn plain sm" data-active="${u.id}" data-v="${u.active ? 0 : 1}">${u.active ? '⏸ Отключить' : '▶ Включить'}</button>
        <button class="btn danger sm" data-del="${u.id}" data-name="${esc(u.first_name)} ${esc(u.last_name)}">🗑 Удалить</button>`}
    </div></div>`).join('')}</div>
    <p class="small muted" style="margin:10px 0 0">«Отключить» временно закрывает доступ. «Удалить» убирает сотрудника из приложения, его история задач и коинов сохраняется в отчётах.</p></div>
    ${removed.length ? `<details class="box"><summary><b>Удалённые · ${removed.length}</b></summary><div class="list" style="margin-top:10px">${removed.map((u) => `<div class="list-item">
      ${avatar(u)}<div class="grow"><div>${esc(u.first_name)} ${esc(u.last_name)}</div><div class="small muted">удалён ${ago(u.deleted_at)}</div></div>
      <button class="btn plain sm" data-restore="${u.id}">Восстановить</button></div>`).join('')}</div></details>` : ''}`;
  const body = $('#admin-body');
  body.querySelectorAll('[data-pos]').forEach((i) => i.addEventListener('change', () => act(() => api(`/api/users/${i.dataset.pos}`, { method: 'PATCH', body: { position: i.value } }), 'Должность сохранена')));
  body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmAsk(`Удалить сотрудника «${b.dataset.name}»? Он больше не сможет войти в приложение.`))) return;
    const kick = S.cfg.groupBound && await confirmAsk('Исключить его и из рабочей Telegram-группы? (бот должен быть администратором группы)');
    const r = await act(() => api(`/api/users/${b.dataset.del}`, { method: 'DELETE', body: { kick } }), 'Сотрудник удалён');
    if (!r) return;
    if (r.openAssigned) toast(`У него ${r.openAssigned} задач(и) в работе — назначьте нового исполнителя`);
    else if (kick && !r.kicked) toast('Удалён из приложения, но из группы исключить не удалось: у бота нет прав администратора');
    adminUsers();
  }));
  body.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
    if (await act(() => api(`/api/users/${b.dataset.restore}/restore`, { method: 'POST' }), 'Сотрудник восстановлен')) adminUsers();
  }));
  $('#invite-btn').addEventListener('click', async () => {
    const r = await act(() => api('/api/owner-invite', { method: 'POST' }), 'Ссылка создана');
    if (!r) return;
    $('#invite-out').innerHTML = `<code>${esc(r.link)}</code><p class="muted small" style="margin:0">Перешлите её собственнику в Telegram. Новая ссылка отменяет предыдущую.</p>`;
    try { await navigator.clipboard.writeText(r.link); toast('Ссылка скопирована'); } catch { /* скопируйте вручную */ }
  });
  body.querySelectorAll('[data-role]').forEach((s) => s.addEventListener('change', () => act(() => api(`/api/users/${s.dataset.role}`, { method: 'PATCH', body: { role: s.value } }), 'Роль изменена')));
  body.querySelectorAll('[data-dep]').forEach((i) => i.addEventListener('change', () => act(() => api(`/api/users/${i.dataset.dep}`, { method: 'PATCH', body: { department: i.value } }), 'Сохранено')));
  body.querySelectorAll('[data-active]').forEach((b) => b.addEventListener('click', async () => {
    if (await act(() => api(`/api/users/${b.dataset.active}`, { method: 'PATCH', body: { active: b.dataset.v === '1' } }), 'Готово')) adminUsers();
  }));
  body.querySelectorAll('[data-coins]').forEach((b) => b.addEventListener('click', async () => {
    const amount = Number(window.prompt('Сколько коинов начислить (минус — списать)?', '50'));
    if (!amount) return;
    const reason = await askText('За что?', 'Например: помог с запуском объекта в выходные', false);
    if (reason === null) return;
    if (await act(() => api(`/api/users/${b.dataset.coins}/coins`, { body: { amount, reason } }), 'Коины начислены')) adminUsers();
  }));
}

async function adminSettings() {
  const [shopData, usersData] = await Promise.all([act(() => api('/api/shop?all=1')), act(() => api('/api/users'))]);
  if (!shopData || !usersData) return;
  const managers = usersData.users.filter((u) => u.role !== 'employee' && u.active);
  const cats = S.cfg.categories;
  $('#admin-body').innerHTML = `<div class="page" style="padding:0">
    <div class="box"><h3>Категории и маршрутизация</h3><p class="small muted" style="margin-top:0">Ответственный получает уведомления о новых обращениях и решениях своей категории. «Для клиентов» — категория видна в QR-форме.</p>
      <div class="list">${cats.map((c) => `<div class="list-item" style="flex-wrap:wrap" data-cat-row="${c.id}">
        <input class="input" data-f="emoji" value="${esc(c.emoji)}" style="width:52px;text-align:center">
        <input class="input grow" data-f="name" value="${esc(c.name)}">
        <div class="row" style="width:100%">
          <select class="select grow" data-f="responsible_id"><option value="">Ответственный: все руководители</option>${managers.map((m) => `<option value="${m.id}" ${m.id === c.responsible_id ? 'selected' : ''}>${esc(m.first_name)} ${esc(m.last_name)}</option>`).join('')}</select>
          <label class="check small"><input type="checkbox" data-f="public" ${c.public ? 'checked' : ''}>Для клиентов</label>
          <input type="color" data-f="color" value="${esc(c.color)}" style="width:36px;height:36px;border:0;background:none">
          <button class="btn plain sm" data-save-cat="${c.id}">💾</button>
        </div></div>`).join('')}</div>
      <div class="row" style="margin-top:10px"><input class="input grow" id="new-cat" placeholder="Новая категория"><button class="btn" id="add-cat">+</button></div>
    </div>
    <div class="box"><h3>Магазин наград</h3><div class="list">${shopData.rewards.map((r) => `<div class="list-item" style="flex-wrap:wrap" data-rw-row="${r.id}">
        <input class="input" data-f="emoji" value="${esc(r.emoji)}" style="width:52px;text-align:center">
        <input class="input grow" data-f="title" value="${esc(r.title)}">
        <div class="row" style="width:100%">
          <input class="input grow" data-f="description" value="${esc(r.description)}" placeholder="Описание">
          <input class="input" data-f="price" type="number" value="${r.price}" style="width:90px">
          <label class="check small"><input type="checkbox" data-f="active" ${r.active ? 'checked' : ''}>Вкл</label>
          <button class="btn plain sm" data-save-rw="${r.id}">💾</button>
        </div></div>`).join('')}</div>
      <div class="row" style="margin-top:10px"><input class="input grow" id="new-rw" placeholder="Новая награда"><input class="input" id="new-rw-price" type="number" placeholder="Цена" style="width:90px"><button class="btn" id="add-rw">+</button></div>
    </div>
  </div>`;
  const body = $('#admin-body');
  const read = (row) => Object.fromEntries([...row.querySelectorAll('[data-f]')].map((el) => [el.dataset.f, el.type === 'checkbox' ? el.checked : el.value]));
  const reloadCfg = async () => { const a = await api('/api/auth', { method: 'POST' }); S.cfg = a.config; };
  body.querySelectorAll('[data-save-cat]').forEach((b) => b.addEventListener('click', async () => {
    const row = body.querySelector(`[data-cat-row="${b.dataset.saveCat}"]`);
    const cat = cats.find((c) => c.id === Number(b.dataset.saveCat));
    if (await act(() => api('/api/categories', { body: { ...cat, ...read(row), id: cat.id } }), 'Категория сохранена')) await reloadCfg();
  }));
  $('#add-cat').addEventListener('click', async () => {
    if (await act(() => api('/api/categories', { body: { name: $('#new-cat').value, public: false } }), 'Категория добавлена')) { await reloadCfg(); adminSettings(); }
  });
  body.querySelectorAll('[data-save-rw]').forEach((b) => b.addEventListener('click', async () => {
    const row = body.querySelector(`[data-rw-row="${b.dataset.saveRw}"]`);
    const rw = shopData.rewards.find((r) => r.id === Number(b.dataset.saveRw));
    await act(() => api('/api/rewards', { body: { ...rw, ...read(row), id: rw.id } }), 'Награда сохранена');
  }));
  $('#add-rw').addEventListener('click', async () => {
    if (await act(() => api('/api/rewards', { body: { title: $('#new-rw').value, price: $('#new-rw-price').value } }), 'Награда добавлена')) adminSettings();
  });
}

boot();
