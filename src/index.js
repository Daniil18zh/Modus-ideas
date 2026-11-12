// Модус Идеи — Cloudflare Worker: API Mini App, публичная QR-форма, Telegram-бот, ежедневный cron.
import { verifyInitData, tgApi, escHtml, safeEqual } from './telegram.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const ROLE_RANK = { employee: 1, manager: 2, admin: 3, owner: 4 };
const OWNER_INVITE_TTL = 7 * 24 * 3600e3;
const PRIORITY = {
  low: { reward: 30, hours: 168, label: 'Низкий' },
  medium: { reward: 60, hours: 72, label: 'Средний' },
  high: { reward: 120, hours: 24, label: 'Высокий' },
};
// Правила начисления Модус-коинов
const COINS = {
  proposal: 5,        // каждому, кто предложил решение, когда задача закрыта
  report: 10,         // автору полезного обращения, когда задача закрыта
  doneShare: 0.5,     // исполнителю: +50% награды за внедрение
  onTime: 20,         // исполнителю: задача закрыта до дедлайна
  hotStep: 0.2,       // «горящая» задача: +20% базовой награды в сутки…
  hotMax: 2,          // …но не больше x2
  hotAfterHours: 48,  // если 48 ч никто не взялся
};
// Значения по умолчанию; администратор меняет их в «Управление → Настройки» (хранятся в settings.config)
const DEFAULTS = { priority: structuredClone(PRIORITY), coins: { ...COINS } };
const APP = { company: '', digest: true, clientQr: true, weeklyReport: true };
const LIMITS = {
  reward: [0, 10000], hours: [1, 2160], proposal: [0, 1000], report: [0, 1000], doneShare: [0, 3],
  onTime: [0, 1000], hotStep: [0, 1], hotMax: [1, 5], hotAfterHours: [1, 720],
};
let configLoadedAt = 0;

async function loadConfig(env, force = false) {
  if (!force && Date.now() - configLoadedAt < 30e3) return;
  const saved = JSON.parse((await getSetting(env, 'config')) || '{}');
  for (const [k, p] of Object.entries(PRIORITY)) {
    Object.assign(p, DEFAULTS.priority[k]);
    for (const f of ['reward', 'hours']) if (Number.isFinite(saved.priority?.[k]?.[f])) p[f] = saved.priority[k][f];
  }
  Object.assign(COINS, DEFAULTS.coins);
  for (const f of Object.keys(COINS)) if (Number.isFinite(saved.coins?.[f])) COINS[f] = saved.coins[f];
  APP.company = saved.company || env.COMPANY_NAME || 'Компания';
  APP.digest = saved.digest !== false;
  APP.clientQr = saved.clientQr !== false;
  APP.weeklyReport = saved.weeklyReport !== false;
  configLoadedAt = Date.now();
}

const LEVELS = [
  [0, 'Новичок'], [100, 'Участник'], [300, 'Специалист'],
  [700, 'Эксперт'], [1500, 'Мастер'], [3000, 'Легенда'],
];
const STATUS_LABEL = {
  new: 'Новое', discussion: 'Обсуждение', in_progress: 'В работе',
  review: 'На проверке', done: 'Решено', rejected: 'Отклонено',
};
// Переходы статусов: откуда можно прийти и кто может это сделать
const TRANSITIONS = {
  discussion: { from: ['new', 'rejected'], who: 'manager' },
  in_progress: { from: ['new', 'discussion', 'review'], who: 'manager' },
  review: { from: ['in_progress'], who: 'assignee' },
  done: { from: ['in_progress', 'review'], who: 'manager' },
  rejected: { from: ['new', 'discussion', 'in_progress', 'review'], who: 'manager' },
};
const OPEN_STATUSES = ['new', 'discussion', 'in_progress', 'review'];

let ORIGIN = '';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

// ---------- D1 helpers ----------
const stmt = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const all = async (env, sql, ...args) => (await stmt(env, sql, ...args).all()).results;
const one = (env, sql, ...args) => stmt(env, sql, ...args).first();
const run = (env, sql, ...args) => stmt(env, sql, ...args).run();

async function getSetting(env, key) {
  const row = await one(env, 'SELECT value FROM settings WHERE key = ?', key);
  return row?.value ?? null;
}
const setSetting = (env, key, value) =>
  run(env, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));

function coinStmts(env, userId, amount, kind, reason, ticketId = null) {
  const earned = amount > 0 && kind !== 'refund' ? amount : 0;
  return [
    stmt(env, 'INSERT INTO coin_tx (user_id, amount, kind, reason, ticket_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', userId, amount, kind, reason, ticketId, Date.now()),
    stmt(env, 'UPDATE users SET balance = balance + ?, earned_total = earned_total + ? WHERE id = ?', amount, earned, userId),
  ];
}
const eventStmt = (env, ticketId, userId, type, data = null) =>
  stmt(env, 'INSERT INTO events (ticket_id, user_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)', ticketId, userId, type, data, Date.now());

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const fullName = (u) => [u?.first_name, u?.last_name].filter(Boolean).join(' ') || (u?.username ? '@' + u.username : 'Сотрудник');
const searchText = (...parts) => parts.join(' ').toLowerCase();
const levelOf = (earned) => {
  let idx = 0;
  LEVELS.forEach(([min], i) => { if (earned >= min) idx = i; });
  const next = LEVELS[idx + 1];
  return { index: idx + 1, name: LEVELS[idx][1], min: LEVELS[idx][0], next: next ? { name: next[1], min: next[0] } : null };
};

// ---------- Entry ----------
// Секреты, заданные через пайп в консоли Windows, приходят с \r\n в конце
const cleanEnv = (env) => ({ ...env, BOT_TOKEN: (env.BOT_TOKEN || '').trim(), WEBHOOK_SECRET: (env.WEBHOOK_SECRET || '').trim() });

export default {
  async fetch(request, env, ctx) {
    env = cleanEnv(env);
    const url = new URL(request.url);
    ORIGIN = url.origin;
    const path = url.pathname;
    try {
      if (path.startsWith('/api/') || path === '/tg/webhook') await loadConfig(env);
      if (path.startsWith('/api/public/')) return await publicApi(request, env, ctx, url);
      if (path.startsWith('/api/')) return await privateApi(request, env, ctx, url);
      if (path === '/tg/webhook') return await webhook(request, env, ctx);
      if (path === '/setup') return await setup(env, url);
      return env.ASSETS.fetch(request);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Внутренняя ошибка сервера' }, 500);
    }
  },
  async scheduled(_event, env, ctx) {
    env = cleanEnv(env);
    ctx.waitUntil(loadConfig(env, true).then(() => dailyJob(env)));
  },
};

// ---------- Auth: регистрация через Telegram, доступ только участникам рабочей группы ----------
async function isGroupMember(env, userId) {
  const groupId = (await getSetting(env, 'group_id')) || env.GROUP_ID;
  if (!groupId) return null;
  const res = await tgApi(env, 'getChatMember', { chat_id: groupId, user_id: userId });
  if (!res?.ok) return false;
  const { status, is_member } = res.result;
  return ['creator', 'administrator', 'member'].includes(status) || (status === 'restricted' && is_member);
}

async function authenticate(request, env) {
  const initData = request.headers.get('x-init-data');
  if (!initData) {
    const demoId = Number(request.headers.get('x-demo-user'));
    // Демо-вход только под синтетическими пользователями 1000–1999, никогда под реальными
    if (env.DEMO_MODE === '1' && demoId >= 1000 && demoId <= 1999) {
      const demo = await one(env, 'SELECT * FROM users WHERE id = ? AND active = 1', demoId);
      if (demo) return withOwnerRole(demo);
    }
    fail(401, 'Откройте приложение через Telegram');
  }
  const verified = await verifyInitData(initData, env.BOT_TOKEN);
  if (!verified) fail(401, 'Сессия Telegram устарела — закройте и откройте приложение заново');
  const tgUser = verified.user;
  const now = Date.now();

  const admins = String(env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
  let user = await one(env, 'SELECT * FROM users WHERE id = ?', tgUser.id);
  if (user?.deleted_at) fail(403, 'Учётная запись удалена администратором');
  // Администраторы задаются только через ADMIN_IDS; остальные роли назначает администратор в приложении
  const envAdmin = admins.includes(tgUser.id);
  let role = user?.role || 'employee';
  if (envAdmin) role = 'admin';
  // Собственник регистрируется по одноразовой ссылке-приглашению и может не состоять в рабочей группе.
  // В базе это флаг is_owner поверх роли admin.
  let isOwnerFlag = user?.is_owner ? 1 : 0;
  if (!isOwnerFlag && await claimOwnerInvite(env, verified.startParam)) isOwnerFlag = 1;
  if (isOwnerFlag) role = 'admin';

  const recheck = !user || now - (user.member_checked_at || 0) > 6 * HOUR;
  if (recheck && !envAdmin && !isOwnerFlag) {
    const member = await isGroupMember(env, tgUser.id);
    if (member === null) fail(403, 'Рабочая группа ещё не подключена. Администратору: добавьте бота в группу и отправьте там /bind');
    if (!member) fail(403, 'Доступ только для участников рабочей Telegram-группы компании');
  }

  const profile = [tgUser.username || null, tgUser.first_name || '', tgUser.last_name || '', tgUser.photo_url || null];
  if (!user) {
    await run(env, 'INSERT INTO users (id, username, first_name, last_name, photo_url, role, is_owner, member_checked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      tgUser.id, ...profile, role, isOwnerFlag, now, now);
  } else {
    await run(env, 'UPDATE users SET username = ?, first_name = ?, last_name = ?, photo_url = ?, role = ?, is_owner = ?, member_checked_at = ? WHERE id = ?',
      ...profile, role, isOwnerFlag, recheck ? now : user.member_checked_at, tgUser.id);
  }
  user = withOwnerRole(await one(env, 'SELECT * FROM users WHERE id = ?', tgUser.id));
  if (user.deleted_at) fail(403, 'Учётная запись удалена администратором');
  if (!user.active) fail(403, 'Учётная запись отключена администратором');
  return user;
}

// Для приложения собственник — отдельная роль «owner», в базе — флаг is_owner
const withOwnerRole = (u) => (u && u.is_owner ? { ...u, role: 'owner' } : u);
const ROLE_SQL = "CASE WHEN u.is_owner = 1 THEN 'owner' ELSE u.role END";

async function claimOwnerInvite(env, startParam) {
  if (!startParam || !startParam.startsWith('own')) return false;
  const invite = JSON.parse((await getSetting(env, 'owner_invite')) || 'null');
  if (!invite || invite.exp < Date.now() || !safeEqual(startParam.slice(3), invite.token)) return false;
  // Приглашение одноразовое: удаляем сразу, повторный вход по той же ссылке ничего не даст
  await setSetting(env, 'owner_invite', '');
  return true;
}

// ---------- Private API ----------
const route = (method, path, handler, minRole) => [method, new RegExp('^' + path.replace(':id', '(\\d+)') + '$'), handler, minRole];
const ROUTES = [
  route('POST', '/api/auth', authMe),
  route('POST', '/api/profile', saveProfile),
  route('GET', '/api/board', board),
  route('GET', '/api/tickets/similar', similar),
  route('POST', '/api/tickets', createTicket),
  route('GET', '/api/tickets/:id', getTicket),
  route('PATCH', '/api/tickets/:id', updateTicket, 'manager'),
  route('POST', '/api/tickets/:id/join', joinTicket),
  route('POST', '/api/tickets/:id/solutions', addSolution),
  route('POST', '/api/tickets/:id/comments', addComment),
  route('POST', '/api/tickets/:id/status', setStatus),
  route('POST', '/api/tickets/:id/winner', chooseWinner, 'manager'),
  route('POST', '/api/solutions/:id/vote', vote),
  route('GET', '/api/me', me),
  route('GET', '/api/leaderboard', leaderboard),
  route('GET', '/api/shop', shop),
  route('POST', '/api/shop/:id/redeem', redeem),
  route('GET', '/api/stats', stats, 'manager'),
  route('GET', '/api/users', listUsers, 'manager'),
  route('PATCH', '/api/users/:id', updateUser, 'admin'),
  route('POST', '/api/users/:id/coins', grantCoins, 'admin'),
  route('POST', '/api/owner-invite', ownerInvite, 'admin'),
  route('DELETE', '/api/users/:id', deleteUser, 'admin'),
  route('POST', '/api/users/:id/restore', restoreUser, 'admin'),
  route('GET', '/api/report', getReport, 'admin'),
  route('POST', '/api/report/send', sendReport, 'admin'),
  route('GET', '/api/settings', getSettings, 'admin'),
  route('POST', '/api/settings', saveSettings, 'admin'),
  route('POST', '/api/settings/unbind', unbindGroup, 'admin'),
  route('GET', '/api/team', team, 'admin'),
  route('GET', '/api/redemptions', listRedemptions, 'admin'),
  route('POST', '/api/redemptions/:id', decideRedemption, 'admin'),
  route('POST', '/api/categories', upsertCategory, 'admin'),
  route('POST', '/api/rewards', upsertReward, 'admin'),
  route('GET', '/api/qr', listQr, 'admin'),
  route('POST', '/api/qr', createQr, 'admin'),
  route('DELETE', '/api/qr/:id', deleteQr, 'admin'),
];

async function privateApi(request, env, ctx, url) {
  for (const [method, pattern, handler, minRole] of ROUTES) {
    if (method !== request.method) continue;
    const match = pattern.exec(url.pathname);
    if (!match) continue;
    const user = await authenticate(request, env);
    if (minRole && ROLE_RANK[user.role] < ROLE_RANK[minRole]) fail(403, 'Недостаточно прав');
    const body = request.method === 'GET' ? {} : await request.json().catch(() => ({}));
    const c = { env, ctx, user, url, body, id: match[1] ? Number(match[1]) : null, isManager: ROLE_RANK[user.role] >= 2 };
    return json(await handler(c));
  }
  fail(404, 'Метод не найден');
}

const publicUser = (u) => ({
  id: u.id, username: u.username, first_name: u.first_name, last_name: u.last_name, photo_url: u.photo_url,
  role: u.role, position: u.position, department: u.department, balance: u.balance, earned_total: u.earned_total,
});

// Анкета при первом входе: сотрудник сам указывает должность (обязательно) и отдел
async function saveProfile({ env, user, body }) {
  const position = str(body.position, 80);
  if (position.length < 2) fail(400, 'Укажите вашу должность');
  const department = str(body.department, 80) || user.department || null;
  await run(env, 'UPDATE users SET position = ?, department = ? WHERE id = ?', position, department, user.id);
  const fresh = withOwnerRole(await one(env, 'SELECT * FROM users WHERE id = ?', user.id));
  return { user: publicUser(fresh) };
}

async function appConfig(env) {
  const categories = await all(env, 'SELECT * FROM categories WHERE active = 1 ORDER BY sort, id');
  return {
    company: APP.company,
    categories,
    priorities: PRIORITY,
    statuses: STATUS_LABEL,
    coins: COINS,
    levels: LEVELS,
    groupBound: Boolean((await getSetting(env, 'group_id')) || env.GROUP_ID),
    // Подсказки для анкеты: уже существующие должности и отделы компании
    positions: (await all(env, "SELECT DISTINCT position AS v FROM users WHERE position IS NOT NULL AND position != '' AND deleted_at IS NULL ORDER BY 1 LIMIT 50")).map((r) => r.v),
    departments: (await all(env, "SELECT DISTINCT department AS v FROM users WHERE department IS NOT NULL AND department != '' AND deleted_at IS NULL ORDER BY 1 LIMIT 50")).map((r) => r.v),
  };
}

async function authMe({ env, user }) {
  return { user: publicUser(user), level: levelOf(user.earned_total), config: await appConfig(env) };
}

// Убирает из карточки то, что не положено видеть роли
function ticketView(t, user, isManager) {
  const v = { ...t };
  delete v.search; delete v.ip_hash; delete v.client_token;
  v.mine = t.author_id === user.id;
  v.hot = t.reward > t.base_reward;
  if (t.anonymous && !v.mine) { v.author_id = null; v.author_name = 'Анонимно'; }
  if (!isManager) { delete v.client_contact; delete v.client_name; }
  return v;
}

// В анонимном обращении скрываем автора и в решениях, участниках, комментариях и истории
function maskAuthor(rows, t, user) {
  if (!t.anonymous || t.author_id === user.id) return rows;
  return rows.map((r) => (('user_id' in r ? r.user_id : r.id) === t.author_id
    ? { ...r, id: r.user_id === undefined ? 0 : r.id, user_id: null, user_name: 'Анонимно', first_name: 'Анонимно', last_name: '', photo_url: null }
    : r));
}

const TICKET_SELECT = `SELECT t.*,
  c.name AS category_name, c.emoji AS category_emoji, c.color AS category_color,
  au.first_name || ' ' || au.last_name AS author_name,
  asg.first_name || ' ' || asg.last_name AS assignee_name,
  (SELECT COUNT(*) FROM solutions s WHERE s.ticket_id = t.id) AS solutions_count,
  (SELECT COUNT(*) FROM participants p WHERE p.ticket_id = t.id) AS participants_count,
  EXISTS (SELECT 1 FROM participants p WHERE p.ticket_id = t.id AND p.user_id = ?1) AS joined
  FROM tickets t
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN users au ON au.id = t.author_id
  LEFT JOIN users asg ON asg.id = t.assignee_id`;

async function board({ env, user, isManager }) {
  const rows = await all(env, `${TICKET_SELECT}
    WHERE t.status IN ('new','discussion','in_progress','review') OR t.updated_at > ?2
    ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.updated_at DESC`,
    user.id, Date.now() - 30 * DAY);
  return { tickets: rows.map((t) => ticketView(t, user, isManager)), now: Date.now() };
}

// Поиск похожих обращений — чтобы не плодить дубли и видеть повторяющиеся проблемы
async function similar({ env, url }) {
  const words = (url.searchParams.get('q') || '').toLowerCase().split(/[^a-zа-яё0-9]+/i)
    .filter((w) => w.length >= 4).map((w) => w.slice(0, Math.max(4, w.length - 2))).slice(0, 5);
  if (!words.length) return { items: [] };
  const where = words.map(() => 'search LIKE ?').join(' OR ');
  const items = await all(env, `SELECT id, title, status FROM tickets WHERE status != 'rejected' AND (${where}) ORDER BY updated_at DESC LIMIT 5`,
    ...words.map((w) => `%${w}%`));
  return { items };
}

async function getCategory(env, id) {
  const cat = await one(env, 'SELECT * FROM categories WHERE id = ? AND active = 1', Number(id));
  if (!cat) fail(400, 'Выберите категорию');
  return cat;
}

async function createTicket({ env, ctx, user, body }) {
  const title = str(body.title, 140);
  const description = str(body.description, 4000);
  const solution = str(body.solution, 3000);
  if (title.length < 5) fail(400, 'Опишите проблему короче, но понятнее (от 5 символов)');
  const cat = await getCategory(env, body.category_id);
  const priority = PRIORITY[body.priority] ? body.priority : 'medium';
  // «Сделаю сам» — автор сразу становится исполнителем; «Попросить команду» — карточка ждёт решений коллег
  const self = body.mode === 'self';
  const anonymous = !self && body.anonymous ? 1 : 0;
  const now = Date.now();
  const res = await run(env, `INSERT INTO tickets (title, description, search, category_id, priority, status, source, author_id, anonymous,
      reward, base_reward, assignee_id, first_response_at, deadline_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'employee', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    title, description, searchText(title, description), cat.id, priority, self ? 'in_progress' : 'new', user.id, anonymous,
    PRIORITY[priority].reward, PRIORITY[priority].reward, self ? user.id : null, self ? now : null,
    now + PRIORITY[priority].hours * HOUR, now, now);
  const id = res.meta.last_row_id;
  const batch = [eventStmt(env, id, anonymous ? null : user.id, 'created', self ? 'взял(а) в работу сам(а)' : null)];
  if (solution.length >= 5) {
    batch.push(
      stmt(env, 'INSERT INTO solutions (ticket_id, user_id, text, created_at) VALUES (?, ?, ?, ?)', id, user.id, solution, now),
      stmt(env, 'INSERT OR IGNORE INTO participants (ticket_id, user_id, joined_at) VALUES (?, ?, ?)', id, user.id, now),
    );
  }
  await env.DB.batch(batch);
  ctx.waitUntil(announceTicket(env, id));
  return { id };
}

async function loadTicket(env, id) {
  const t = await one(env, 'SELECT * FROM tickets WHERE id = ?', id);
  if (!t) fail(404, 'Обращение не найдено');
  return t;
}

async function getTicket({ env, user, id, isManager }) {
  const t = await one(env, `${TICKET_SELECT} WHERE t.id = ?2`, user.id, id);
  if (!t) fail(404, 'Обращение не найдено');
  const [solutions, participants, comments, events] = await Promise.all([
    all(env, `SELECT s.*, u.first_name || ' ' || u.last_name AS user_name, u.photo_url,
        (SELECT COUNT(*) FROM solution_votes v WHERE v.solution_id = s.id) AS votes,
        EXISTS (SELECT 1 FROM solution_votes v WHERE v.solution_id = s.id AND v.user_id = ?2) AS voted
      FROM solutions s JOIN users u ON u.id = s.user_id WHERE s.ticket_id = ?1
      ORDER BY s.is_winner DESC, votes DESC, s.created_at`, id, user.id),
    all(env, `SELECT u.id, u.first_name, u.last_name, u.photo_url FROM participants p JOIN users u ON u.id = p.user_id
      WHERE p.ticket_id = ? ORDER BY p.joined_at`, id),
    all(env, `SELECT cm.id, cm.text, cm.created_at, cm.user_id, u.first_name || ' ' || u.last_name AS user_name, u.role
      FROM comments cm LEFT JOIN users u ON u.id = cm.user_id WHERE cm.ticket_id = ? ORDER BY cm.created_at`, id),
    all(env, `SELECT e.type, e.data, e.created_at, e.user_id, u.first_name || ' ' || u.last_name AS user_name
      FROM events e LEFT JOIN users u ON u.id = e.user_id WHERE e.ticket_id = ? ORDER BY e.created_at DESC LIMIT 30`, id),
  ]);
  const view = ticketView(t, user, isManager);
  return {
    ticket: view,
    solutions: maskAuthor(solutions.map((s) => ({ ...s, mine: s.user_id === user.id })), t, user),
    participants: maskAuthor(participants, t, user),
    comments: maskAuthor(comments, t, user),
    events: maskAuthor(events, t, user).map(({ user_id, ...e }) => e),
  };
}

async function updateTicket({ env, user, id, body }) {
  const t = await loadTicket(env, id);
  const sets = [];
  const args = [];
  const changes = [];
  if (body.title !== undefined) {
    const title = str(body.title, 140);
    if (title.length < 5) fail(400, 'Слишком короткий заголовок');
    sets.push('title = ?', 'search = ?'); args.push(title, searchText(title, t.description));
  }
  if (body.category_id !== undefined) {
    const cat = await getCategory(env, body.category_id);
    sets.push('category_id = ?'); args.push(cat.id); changes.push(`категория: ${cat.name}`);
  }
  if (body.priority !== undefined && PRIORITY[body.priority] && body.priority !== t.priority) {
    const p = PRIORITY[body.priority];
    sets.push('priority = ?', 'deadline_at = ?'); args.push(body.priority, t.created_at + p.hours * HOUR);
    if (body.reward === undefined && !t.winner_solution_id) {
      sets.push('reward = ?', 'base_reward = ?'); args.push(p.reward, p.reward);
    }
    changes.push(`приоритет: ${p.label}`);
  }
  if (body.reward !== undefined && !t.winner_solution_id) {
    const reward = Math.max(0, Math.min(10000, Math.round(Number(body.reward) || 0)));
    sets.push('reward = ?', 'base_reward = ?'); args.push(reward, reward); changes.push(`награда: ${reward} МК`);
  }
  if (body.deadline_at !== undefined) {
    const d = Number(body.deadline_at);
    if (!d) fail(400, 'Некорректный срок');
    sets.push('deadline_at = ?'); args.push(d); changes.push('срок изменён');
  }
  if (body.assignee_id !== undefined) {
    const a = body.assignee_id ? await one(env, 'SELECT * FROM users WHERE id = ? AND active = 1', Number(body.assignee_id)) : null;
    if (body.assignee_id && !a) fail(400, 'Исполнитель не найден');
    sets.push('assignee_id = ?'); args.push(a?.id ?? null); changes.push(`исполнитель: ${a ? fullName(a) : '—'}`);
  }
  if (!sets.length) return { ok: true };
  sets.push('updated_at = ?', 'first_response_at = COALESCE(first_response_at, ?)'); args.push(Date.now(), Date.now());
  await env.DB.batch([
    stmt(env, `UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`, ...args, id),
    eventStmt(env, id, user.id, 'edited', changes.join('; ')),
  ]);
  return { ok: true };
}

// Любое действие не автора считается первой реакцией; новая карточка с активностью уходит в «Обсуждение»
function activityStmts(env, t, user) {
  const now = Date.now();
  const list = [stmt(env, 'UPDATE tickets SET updated_at = ? WHERE id = ?', now, t.id)];
  if (t.author_id !== user.id) list.push(stmt(env, 'UPDATE tickets SET first_response_at = COALESCE(first_response_at, ?) WHERE id = ?', now, t.id));
  if (t.status === 'new') list.push(stmt(env, "UPDATE tickets SET status = 'discussion' WHERE id = ?", t.id), eventStmt(env, t.id, null, 'status', 'discussion'));
  return list;
}

async function joinTicket({ env, user, id }) {
  const t = await loadTicket(env, id);
  if (!OPEN_STATUSES.includes(t.status)) fail(400, 'Задача уже закрыта');
  const exists = await one(env, 'SELECT 1 FROM participants WHERE ticket_id = ? AND user_id = ?', id, user.id);
  if (exists) {
    await run(env, 'DELETE FROM participants WHERE ticket_id = ? AND user_id = ?', id, user.id);
    return { joined: false };
  }
  await env.DB.batch([
    stmt(env, 'INSERT INTO participants (ticket_id, user_id, joined_at) VALUES (?, ?, ?)', id, user.id, Date.now()),
    eventStmt(env, id, user.id, 'joined'),
    ...activityStmts(env, t, user),
  ]);
  return { joined: true };
}

async function addSolution({ env, ctx, user, id, body }) {
  const t = await loadTicket(env, id);
  if (!['new', 'discussion'].includes(t.status)) fail(400, 'Приём решений по этой задаче закрыт');
  const text = str(body.text, 3000);
  if (text.length < 10) fail(400, 'Опишите решение подробнее (от 10 символов)');
  const now = Date.now();
  await env.DB.batch([
    stmt(env, 'INSERT INTO solutions (ticket_id, user_id, text, created_at) VALUES (?, ?, ?, ?)', id, user.id, text, now),
    stmt(env, 'INSERT OR IGNORE INTO participants (ticket_id, user_id, joined_at) VALUES (?, ?, ?)', id, user.id, now),
    eventStmt(env, id, user.id, 'solution'),
    ...activityStmts(env, t, user),
  ]);
  const cat = await one(env, 'SELECT responsible_id FROM categories WHERE id = ?', t.category_id);
  const html = `💡 Новое решение по задаче #${id} «${escHtml(t.title)}» от ${escHtml(fullName(user))}`;
  const skip = [user.id];
  if (cat?.responsible_id && cat.responsible_id !== user.id) {
    ctx.waitUntil(dm(env, cat.responsible_id, html, id));
    skip.push(cat.responsible_id);
  }
  ctx.waitUntil(notifyOwners(env, html, id, skip));
  return { ok: true };
}

async function vote({ env, user, id }) {
  const s = await one(env, 'SELECT * FROM solutions WHERE id = ?', id);
  if (!s) fail(404, 'Решение не найдено');
  if (s.user_id === user.id) fail(400, 'Нельзя голосовать за своё решение');
  const res = await run(env, 'DELETE FROM solution_votes WHERE solution_id = ? AND user_id = ?', id, user.id);
  if (res.meta.changes) return { voted: false };
  await run(env, 'INSERT INTO solution_votes (solution_id, user_id) VALUES (?, ?)', id, user.id);
  return { voted: true };
}

async function addComment({ env, ctx, user, id, body }) {
  const t = await loadTicket(env, id);
  const text = str(body.text, 2000);
  if (!text) fail(400, 'Пустой комментарий');
  const list = [stmt(env, 'INSERT INTO comments (ticket_id, user_id, text, created_at) VALUES (?, ?, ?, ?)', id, user.id, text, Date.now())];
  if (OPEN_STATUSES.includes(t.status)) list.push(...activityStmts(env, t, user));
  await env.DB.batch(list);
  const notifyIds = new Set([t.author_id, t.assignee_id].filter((x) => x && x !== user.id));
  for (const uid of notifyIds) {
    ctx.waitUntil(dm(env, uid, `💬 ${escHtml(fullName(user))} в задаче #${id}:\n${escHtml(text.slice(0, 300))}`, id));
  }
  return { ok: true };
}

async function chooseWinner({ env, ctx, user, id, body }) {
  const t = await loadTicket(env, id);
  if (!['new', 'discussion'].includes(t.status) || t.winner_solution_id) fail(400, 'Победитель уже выбран или задача закрыта');
  const s = await one(env, 'SELECT * FROM solutions WHERE id = ? AND ticket_id = ?', Number(body.solution_id), id);
  if (!s) fail(404, 'Решение не найдено');
  if (s.user_id === user.id) fail(403, 'Своё решение лучшим выбирает другой руководитель');
  const winner = await one(env, 'SELECT * FROM users WHERE id = ?', s.user_id);
  const now = Date.now();
  const hot = t.reward > t.base_reward;
  // Условие в UPDATE защищает от двойного выбора при одновременных нажатиях
  const upd = await run(env, `UPDATE tickets SET winner_solution_id = ?, assignee_id = ?, status = 'in_progress', updated_at = ?,
      first_response_at = COALESCE(first_response_at, ?) WHERE id = ? AND winner_solution_id IS NULL AND status IN ('new','discussion')`,
    s.id, s.user_id, now, now, id);
  if (!upd.meta.changes) fail(409, 'Победитель уже выбран');
  await env.DB.batch([
    stmt(env, 'UPDATE solutions SET is_winner = 1 WHERE id = ?', s.id),
    ...coinStmts(env, s.user_id, t.reward, 'win', `${hot ? '🔥 ' : ''}Лучшее решение по задаче #${id}`, id),
    eventStmt(env, id, user.id, 'winner', fullName(winner)),
  ]);
  ctx.waitUntil(Promise.all([
    dm(env, s.user_id, `🏆 Ваше решение выбрано лучшим в задаче #${id} «${escHtml(t.title)}»!\n+${t.reward} Модус-коинов. Теперь вы исполнитель — внедрите решение и получите ещё +${Math.round(t.reward * COINS.doneShare)} МК (и +${COINS.onTime} МК, если успеете в срок).`, id),
    t.author_id && t.author_id !== s.user_id ? dm(env, t.author_id, `✅ По вашему обращению #${id} выбрано решение, задача взята в работу.`, id) : null,
    notifyOwners(env, `🏆 ${escHtml(fullName(user))} выбрал(а) решение ${escHtml(fullName(winner))} в задаче #${id} «${escHtml(t.title)}»`, id, [user.id, s.user_id, t.author_id]),
  ]));
  return { ok: true };
}

async function setStatus({ env, ctx, user, id, body, isManager }) {
  const t = await loadTicket(env, id);
  const to = body.status;
  const rule = TRANSITIONS[to];
  if (!rule || !rule.from.includes(t.status)) fail(400, 'Такой переход статуса недоступен');
  if (rule.who === 'manager' && !isManager) fail(403, 'Это действие доступно руководителю');
  if (rule.who === 'assignee' && !isManager && t.assignee_id !== user.id) fail(403, 'Сдать задачу может только исполнитель');
  if (to === 'in_progress' && !t.assignee_id) fail(400, 'Выберите лучшее решение или назначьте исполнителя');
  if (to === 'done' && t.assignee_id === user.id) fail(403, 'Свою работу принимает другой руководитель');
  const text = str(body.text, 3000);
  if ((to === 'review' || to === 'rejected') && text.length < 5) fail(400, to === 'review' ? 'Опишите, что сделано' : 'Укажите причину отклонения');
  if (to === 'done' && !text && !t.resolution) fail(400, 'Опишите результат');

  const now = Date.now();
  // Условие по статусу защищает от двойного начисления при повторном нажатии
  const upd = await run(env, `UPDATE tickets SET status = ?, updated_at = ?, first_response_at = COALESCE(first_response_at, ?),
      resolution = COALESCE(?, resolution), resolved_at = ? WHERE id = ? AND status = ?`,
    to, now, now, text || null, ['done', 'rejected'].includes(to) ? now : null, id, t.status);
  if (!upd.meta.changes) fail(409, 'Статус уже изменён, обновите карточку');
  const list = [eventStmt(env, id, user.id, 'status', to + (text ? `: ${text.slice(0, 200)}` : ''))];
  const payouts = [];
  if (to === 'done') {
    if (t.assignee_id) {
      if (!t.winner_solution_id) payouts.push([t.assignee_id, t.reward, 'win', `Решение задачи #${id}`]);
      payouts.push([t.assignee_id, Math.round(t.reward * COINS.doneShare), 'done', `Внедрение решения #${id}`]);
      if (now <= t.deadline_at) payouts.push([t.assignee_id, COINS.onTime, 'ontime', `Точно в срок #${id}`]);
    }
    const proposers = await all(env, 'SELECT DISTINCT user_id FROM solutions WHERE ticket_id = ? AND user_id != ?', id, t.assignee_id ?? 0);
    for (const p of proposers) payouts.push([p.user_id, COINS.proposal, 'proposal', `Участие в решении #${id}`]);
    if (t.source === 'employee' && t.author_id) payouts.push([t.author_id, COINS.report, 'report', `Полезное обращение #${id}`]);
    for (const [uid, amount, kind, reason] of payouts) list.push(...coinStmts(env, uid, amount, kind, reason, id));
  }
  await env.DB.batch(list);

  const notes = [];
  if (to === 'review') notes.push(notifyManagers(env, t, `🔎 Задача #${id} «${escHtml(t.title)}» сдана на проверку: ${escHtml(text)}`));
  if (to === 'in_progress' && t.status === 'review' && t.assignee_id) notes.push(dm(env, t.assignee_id, `↩️ Задача #${id} возвращена в работу${text ? ': ' + escHtml(text) : ''}`, id));
  if (to === 'in_progress' && t.status !== 'review' && t.assignee_id) notes.push(dm(env, t.assignee_id, `📌 Вам назначена задача #${id} «${escHtml(t.title)}». Награда ${t.reward} МК.`, id));
  if (to === 'done' || to === 'rejected') {
    if (t.author_id) notes.push(dm(env, t.author_id, `${to === 'done' ? '✅ Решено' : '⛔ Отклонено'}: ваше обращение #${id} «${escHtml(t.title)}»\n${escHtml(text || t.resolution || '')}`, id));
    const sums = new Map();
    for (const [uid, amount] of payouts) sums.set(uid, (sums.get(uid) || 0) + amount);
    for (const [uid, amount] of sums) notes.push(dm(env, uid, `🪙 +${amount} Модус-коинов за задачу #${id}`, id));
    notes.push(notifyOwners(env, `${to === 'done' ? '✅ Решено' : '⛔ Отклонено'} ${escHtml(fullName(user))}: задача #${id} «${escHtml(t.title)}»\n${escHtml(text || t.resolution || '')}`, id, [user.id, t.author_id]));
  }
  ctx.waitUntil(Promise.all(notes));
  return { ok: true };
}

// ---------- Коины, рейтинг, магазин ----------
async function me({ env, user }) {
  const [tx, redemptions, counts, hotWins, tickets] = await Promise.all([
    all(env, 'SELECT * FROM coin_tx WHERE user_id = ? ORDER BY created_at DESC LIMIT 60', user.id),
    all(env, `SELECT r.*, w.title, w.emoji FROM redemptions r JOIN rewards w ON w.id = r.reward_id
      WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 30`, user.id),
    one(env, `SELECT
        (SELECT COUNT(*) FROM solutions WHERE user_id = ?1) AS solutions,
        (SELECT COUNT(*) FROM solutions WHERE user_id = ?1 AND is_winner = 1) AS wins,
        (SELECT COUNT(*) FROM coin_tx WHERE user_id = ?1 AND kind = 'ontime') AS ontime,
        (SELECT COUNT(*) FROM coin_tx WHERE user_id = ?1 AND kind = 'done') AS done,
        (SELECT COUNT(*) FROM tickets WHERE author_id = ?1) AS reports`, user.id),
    one(env, `SELECT COUNT(*) AS n FROM tickets t JOIN solutions s ON s.id = t.winner_solution_id
      WHERE s.user_id = ? AND t.reward > t.base_reward`, user.id),
    all(env, `SELECT t.id, t.title, t.status, t.reward, t.deadline_at, t.updated_at,
        CASE WHEN t.author_id = ?1 THEN 'author' WHEN t.assignee_id = ?1 THEN 'assignee' ELSE 'participant' END AS relation
      FROM tickets t WHERE t.author_id = ?1 OR t.assignee_id = ?1
        OR EXISTS (SELECT 1 FROM participants p WHERE p.ticket_id = t.id AND p.user_id = ?1)
      ORDER BY t.updated_at DESC LIMIT 50`, user.id),
  ]);
  const ach = [
    { id: 'first', emoji: '🌱', title: 'Первый шаг', hint: 'Предложить первое решение', got: counts.solutions >= 1 },
    { id: 'win1', emoji: '🏆', title: 'Победитель', hint: 'Решение выбрано лучшим', got: counts.wins >= 1 },
    { id: 'win5', emoji: '🧠', title: 'Решала', hint: '5 побед', got: counts.wins >= 5 },
    { id: 'ontime', emoji: '⏱', title: 'Точно в срок', hint: '5 задач закрыто до дедлайна', got: counts.ontime >= 5 },
    { id: 'eye', emoji: '👁', title: 'Зоркий глаз', hint: '5 обращений', got: counts.reports >= 5 },
    { id: 'fire', emoji: '🔥', title: 'Пожарный', hint: 'Взять «горящую» задачу', got: hotWins.n >= 1 },
    { id: 'legend', emoji: '👑', title: 'Легенда', hint: '3000 МК за всё время', got: user.earned_total >= 3000 },
  ];
  return { user: publicUser(user), level: levelOf(user.earned_total), counts, achievements: ach, tx, redemptions, tickets };
}

async function leaderboard({ env, url }) {
  const period = url.searchParams.get('period') === 'all' ? 'all' : 'month';
  const d = new Date();
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const rows = period === 'all'
    ? await all(env, `SELECT id, first_name, last_name, photo_url, department, earned_total AS score FROM users
        WHERE active = 1 AND earned_total > 0 ORDER BY earned_total DESC LIMIT 50`)
    : await all(env, `SELECT u.id, u.first_name, u.last_name, u.photo_url, u.department, u.earned_total, SUM(x.amount) AS score
        FROM coin_tx x JOIN users u ON u.id = x.user_id
        WHERE x.amount > 0 AND x.kind != 'refund' AND x.created_at >= ? AND u.active = 1
        GROUP BY u.id ORDER BY score DESC LIMIT 50`, monthStart);
  return { period, rows: rows.map((r) => ({ ...r, level: levelOf(r.earned_total ?? r.score) })) };
}

async function shop({ env, user, url }) {
  const showAll = url.searchParams.get('all') === '1' && ROLE_RANK[user.role] >= ROLE_RANK.admin;
  const rewards = await all(env, `SELECT * FROM rewards ${showAll ? '' : 'WHERE active = 1'} ORDER BY sort, price`);
  return { rewards, balance: user.balance };
}

async function redeem({ env, ctx, user, id }) {
  const reward = await one(env, 'SELECT * FROM rewards WHERE id = ? AND active = 1', id);
  if (!reward) fail(404, 'Награда не найдена');
  const now = Date.now();
  // Одна транзакция: списание идёт только при достаточном балансе, записи — только если списание прошло
  const [debit] = await env.DB.batch([
    stmt(env, 'UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', reward.price, user.id, reward.price),
    stmt(env, 'INSERT INTO redemptions (user_id, reward_id, price, created_at) SELECT ?, ?, ?, ? WHERE changes() > 0', user.id, reward.id, reward.price, now),
    stmt(env, 'INSERT INTO coin_tx (user_id, amount, kind, reason, created_at) SELECT ?, ?, ?, ?, ? WHERE changes() > 0', user.id, -reward.price, 'redeem', `Обмен: ${reward.title}`, now),
  ]);
  if (!debit.meta.changes) fail(400, `Недостаточно коинов: нужно ${reward.price} МК`);
  const admins = await all(env, "SELECT id FROM users WHERE role = 'admin' AND active = 1");
  ctx.waitUntil(Promise.all(admins.map((a) => dm(env, a.id, `🎁 ${escHtml(fullName(user))} обменивает ${reward.price} МК на «${escHtml(reward.title)}». Подтвердите в разделе «Управление → Обмен».`))));
  return { ok: true };
}

async function listRedemptions({ env }) {
  const items = await all(env, `SELECT r.*, w.title, w.emoji, u.first_name || ' ' || u.last_name AS user_name, u.department
    FROM redemptions r JOIN rewards w ON w.id = r.reward_id JOIN users u ON u.id = r.user_id
    ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC LIMIT 100`);
  return { items };
}

async function decideRedemption({ env, ctx, user, id, body }) {
  const r = await one(env, 'SELECT r.*, w.title FROM redemptions r JOIN rewards w ON w.id = r.reward_id WHERE r.id = ?', id);
  if (!r || r.status !== 'pending') fail(400, 'Заявка уже обработана');
  const approve = body.action === 'approve';
  const note = str(body.note, 500) || null;
  const now = Date.now();
  const decide = stmt(env, "UPDATE redemptions SET status = ?, note = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
    approve ? 'approved' : 'rejected', note, user.id, now, id);
  // Отказ и возврат коинов — в одной транзакции и только если заявка ещё ждала решения
  const [res] = await env.DB.batch(approve ? [decide] : [
    decide,
    stmt(env, "INSERT INTO coin_tx (user_id, amount, kind, reason, created_at) SELECT ?, ?, 'refund', ?, ? WHERE changes() > 0", r.user_id, r.price, `Возврат: ${r.title}`, now),
    stmt(env, 'UPDATE users SET balance = balance + ? WHERE id = ? AND changes() > 0', r.price, r.user_id),
  ]);
  if (!res.meta.changes) fail(409, 'Заявка уже обработана');
  ctx.waitUntil(dm(env, r.user_id, approve
    ? `🎉 Обмен одобрен: «${escHtml(r.title)}». ${note ? escHtml(note) : 'С вами свяжутся для оформления.'}`
    : `↩️ Обмен «${escHtml(r.title)}» отклонён, ${r.price} МК возвращены.${note ? ' ' + escHtml(note) : ''}`));
  return { ok: true };
}

// ---------- Администрирование ----------
async function listUsers({ env }) {
  const users = await all(env, `SELECT u.id, u.username, u.first_name, u.last_name, u.photo_url, ${ROLE_SQL} AS role, u.position, u.department, u.balance, u.earned_total, u.active, u.deleted_at
    FROM users u ORDER BY u.deleted_at IS NOT NULL, u.active DESC, u.first_name`);
  return { users };
}

async function updateUser({ env, user, id, body }) {
  const target = await one(env, 'SELECT * FROM users WHERE id = ?', id);
  if (!target) fail(404, 'Пользователь не найден');
  if (id === user.id && (body.role !== undefined || body.active !== undefined)) fail(400, 'Нельзя менять роль или доступ самому себе');
  // Собственника и роль собственника меняет только другой собственник
  if ((target.is_owner || body.role === 'owner') && user.role !== 'owner' && (body.role !== undefined || body.active !== undefined)) {
    fail(403, 'Роль собственника меняет только собственник');
  }
  const next = body.role !== undefined && ROLE_RANK[body.role] ? body.role : (target.is_owner ? 'owner' : target.role);
  const role = next === 'owner' ? 'admin' : next;
  const department = body.department !== undefined ? str(body.department, 80) || null : target.department;
  const position = body.position !== undefined ? str(body.position, 80) || null : target.position;
  const active = body.active !== undefined ? (body.active ? 1 : 0) : target.active;
  await run(env, 'UPDATE users SET role = ?, is_owner = ?, position = ?, department = ?, active = ? WHERE id = ?',
    role, next === 'owner' ? 1 : 0, position, department, active, id);
  return { ok: true };
}

// Одноразовая ссылка: открывший её в Telegram становится собственником (действует 7 дней или до первого входа)
async function ownerInvite({ env }) {
  const token = crypto.randomUUID().replace(/-/g, '');
  await setSetting(env, 'owner_invite', JSON.stringify({ token, exp: Date.now() + OWNER_INVITE_TTL }));
  const link = await appLink(env, 'own' + token);
  if (!link) fail(400, 'Включите Mini App бота в BotFather, чтобы создавать приглашения');
  return { link, expiresAt: Date.now() + OWNER_INVITE_TTL };
}

// Работа команды для собственника: вклад каждого сотрудника и лента событий
async function team({ env, user }) {
  const now = Date.now();
  const [people, feed] = await Promise.all([
    all(env, `SELECT u.id, u.first_name, u.last_name, u.photo_url, ${ROLE_SQL} AS role, u.position, u.department, u.earned_total,
        (SELECT COUNT(*) FROM tickets t WHERE t.author_id = u.id AND t.anonymous = 0) AS reports,
        (SELECT COUNT(*) FROM solutions s WHERE s.user_id = u.id) AS solutions,
        (SELECT COUNT(*) FROM solutions s WHERE s.user_id = u.id AND s.is_winner = 1) AS wins,
        (SELECT COUNT(*) FROM tickets t WHERE t.assignee_id = u.id AND t.status IN ('in_progress','review')) AS active,
        (SELECT COUNT(*) FROM tickets t WHERE t.assignee_id = u.id AND t.status = 'done') AS done,
        (SELECT COUNT(*) FROM tickets t WHERE t.assignee_id = u.id AND t.status IN ('in_progress','review') AND t.deadline_at < ?1) AS overdue,
        (SELECT MAX(e.created_at) FROM events e WHERE e.user_id = u.id) AS last_at
      FROM users u WHERE u.active = 1 AND u.deleted_at IS NULL ORDER BY last_at IS NULL, last_at DESC`, now),
    all(env, `SELECT e.type, e.data, e.created_at, e.ticket_id, e.user_id, t.title, t.anonymous, t.author_id,
        u.first_name || ' ' || u.last_name AS user_name
      FROM events e JOIN tickets t ON t.id = e.ticket_id LEFT JOIN users u ON u.id = e.user_id
      ORDER BY e.created_at DESC LIMIT 60`),
  ]);
  return {
    people,
    feed: feed.map(({ user_id, author_id, anonymous, ...e }) => ({
      ...e, user_name: anonymous && user_id === author_id && user_id !== user.id ? 'Анонимно' : e.user_name,
    })),
  };
}

const adminIds = (env) => String(env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean);

// Удаление сотрудника: доступ закрывается навсегда, история задач и коинов сохраняется для отчётности
async function deleteUser({ env, user, id, body }) {
  if (id === user.id) fail(400, 'Нельзя удалить самого себя');
  const target = await one(env, 'SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', id);
  if (!target) fail(404, 'Сотрудник не найден');
  if (target.is_owner && user.role !== 'owner') fail(403, 'Собственника удаляет только собственник');
  if (adminIds(env).includes(id)) fail(403, 'Главный администратор задаётся в настройках сервера (ADMIN_IDS)');
  await env.DB.batch([
    stmt(env, "UPDATE users SET active = 0, deleted_at = ?, role = 'employee', is_owner = 0, photo_url = NULL WHERE id = ?", Date.now(), id),
    stmt(env, 'UPDATE categories SET responsible_id = NULL WHERE responsible_id = ?', id),
    stmt(env, 'DELETE FROM participants WHERE user_id = ?', id),
  ]);
  const open = await one(env, "SELECT COUNT(*) AS n FROM tickets WHERE assignee_id = ? AND status IN ('in_progress','review')", id);
  let kicked = false;
  if (body.kick) {
    // Исключение из рабочей группы: бан и сразу разбан — человек выходит из группы, но может быть приглашён снова
    const groupId = await getSetting(env, 'group_id');
    if (groupId) {
      const ban = await tgApi(env, 'banChatMember', { chat_id: groupId, user_id: id });
      kicked = Boolean(ban?.ok);
      if (kicked) await tgApi(env, 'unbanChatMember', { chat_id: groupId, user_id: id, only_if_banned: true });
    }
  }
  return { ok: true, openAssigned: open.n, kicked };
}

async function restoreUser({ env, id }) {
  const res = await run(env, 'UPDATE users SET deleted_at = NULL, active = 1 WHERE id = ? AND deleted_at IS NOT NULL', id);
  if (!res.meta.changes) fail(404, 'Удалённый сотрудник не найден');
  return { ok: true };
}

async function getSettings({ env }) {
  const groupId = (await getSetting(env, 'group_id')) || env.GROUP_ID || null;
  let group = null;
  if (groupId) {
    const chat = await tgApi(env, 'getChat', { chat_id: groupId });
    group = { id: groupId, title: chat?.result?.title || null };
  }
  return {
    company: APP.company, digest: APP.digest, clientQr: APP.clientQr, weeklyReport: APP.weeklyReport,
    priority: PRIORITY, coins: COINS, defaults: DEFAULTS, group,
    bot: await getSetting(env, 'bot_username'),
  };
}

async function saveSettings({ env, body }) {
  const num = (v, [min, max], name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) fail(400, `${name}: значение от ${min} до ${max}`);
    return n;
  };
  const priority = {};
  for (const k of Object.keys(PRIORITY)) {
    priority[k] = {
      reward: Math.round(num(body.priority?.[k]?.reward, LIMITS.reward, `Награда (${PRIORITY[k].label})`)),
      hours: Math.round(num(body.priority?.[k]?.hours, LIMITS.hours, `Срок (${PRIORITY[k].label})`)),
    };
  }
  const coins = {};
  const names = { proposal: 'За предложение', report: 'За обращение', doneShare: 'Доля за внедрение', onTime: 'Бонус за срок',
    hotStep: 'Рост горящей награды', hotMax: 'Максимум горящей награды', hotAfterHours: 'Горящая через' };
  for (const k of Object.keys(COINS)) coins[k] = num(body.coins?.[k], LIMITS[k], names[k]);
  const company = str(body.company, 80);
  if (company.length < 2) fail(400, 'Укажите название компании');
  await setSetting(env, 'config', JSON.stringify({ priority, coins, company, digest: body.digest !== false, clientQr: body.clientQr !== false, weeklyReport: body.weeklyReport !== false }));
  await loadConfig(env, true);
  return { ok: true };
}

async function unbindGroup({ env }) {
  await setSetting(env, 'group_id', '');
  await setSetting(env, 'pinned_msg', '');
  return { ok: true };
}

async function grantCoins({ env, ctx, id, body }) {
  const amount = Math.round(Number(body.amount) || 0);
  if (!amount || Math.abs(amount) > 5000) fail(400, 'Сумма от -5000 до 5000');
  const reason = str(body.reason, 200) || 'Бонус от руководства';
  if (!(await one(env, 'SELECT 1 FROM users WHERE id = ?', id))) fail(404, 'Пользователь не найден');
  await env.DB.batch(coinStmts(env, id, amount, 'manual', reason));
  ctx.waitUntil(dm(env, id, `🪙 ${amount > 0 ? '+' : ''}${amount} Модус-коинов: ${escHtml(reason)}`));
  return { ok: true };
}

async function upsertCategory({ env, body }) {
  const name = str(body.name, 60);
  if (name.length < 2) fail(400, 'Укажите название категории');
  const fields = [name, str(body.emoji, 8) || '📌', /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : '#6b7fa8',
    body.responsible_id ? Number(body.responsible_id) : null, body.public ? 1 : 0, body.active === false ? 0 : 1, Number(body.sort) || 100];
  if (body.id) await run(env, 'UPDATE categories SET name = ?, emoji = ?, color = ?, responsible_id = ?, public = ?, active = ?, sort = ? WHERE id = ?', ...fields, Number(body.id));
  else await run(env, 'INSERT INTO categories (name, emoji, color, responsible_id, public, active, sort) VALUES (?, ?, ?, ?, ?, ?, ?)', ...fields);
  return { ok: true };
}

async function upsertReward({ env, body }) {
  const title = str(body.title, 80);
  const price = Math.round(Number(body.price) || 0);
  if (title.length < 2 || price < 1) fail(400, 'Укажите название и цену');
  const fields = [title, str(body.description, 300), str(body.emoji, 8) || '🎁', price, body.active === false ? 0 : 1, Number(body.sort) || 100];
  if (body.id) await run(env, 'UPDATE rewards SET title = ?, description = ?, emoji = ?, price = ?, active = ?, sort = ? WHERE id = ?', ...fields, Number(body.id));
  else await run(env, 'INSERT INTO rewards (title, description, emoji, price, active, sort) VALUES (?, ?, ?, ?, ?, ?)', ...fields);
  return { ok: true };
}

async function listQr({ env }) {
  const items = await all(env, `SELECT q.*, (SELECT COUNT(*) FROM tickets t WHERE t.qr_tag = q.tag) AS tickets
    FROM qr_points q ORDER BY q.created_at DESC`);
  return { items, base: `${ORIGIN}/c/` };
}

async function createQr({ env, body }) {
  const title = str(body.title, 80);
  if (title.length < 2) fail(400, 'Укажите, где будет висеть QR-код');
  const tag = crypto.randomUUID().slice(0, 8);
  await run(env, 'INSERT INTO qr_points (tag, title, created_at) VALUES (?, ?, ?)', tag, title, Date.now());
  return { ok: true, tag };
}

async function deleteQr({ env, id }) {
  await run(env, 'DELETE FROM qr_points WHERE id = ?', id);
  return { ok: true };
}

async function stats({ env }) {
  const now = Date.now();
  const [byStatus, byCategory, bySource, byQr, timing, overdue, coins, top] = await Promise.all([
    all(env, 'SELECT status, COUNT(*) AS n FROM tickets GROUP BY status'),
    all(env, `SELECT c.id, c.name, c.emoji, c.color, COUNT(t.id) AS total,
        SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN t.status IN ('new','discussion','in_progress','review') THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN t.created_at > ?1 THEN 1 ELSE 0 END) AS last30
      FROM categories c LEFT JOIN tickets t ON t.category_id = c.id GROUP BY c.id ORDER BY total DESC`, now - 30 * DAY),
    all(env, 'SELECT source, COUNT(*) AS n FROM tickets GROUP BY source'),
    all(env, 'SELECT q.title, COUNT(t.id) AS n FROM qr_points q LEFT JOIN tickets t ON t.qr_tag = q.tag GROUP BY q.id ORDER BY n DESC'),
    one(env, `SELECT AVG(first_response_at - created_at) AS first_response,
        (SELECT AVG(resolved_at - created_at) FROM tickets WHERE status = 'done') AS resolution
      FROM tickets WHERE first_response_at IS NOT NULL`),
    one(env, "SELECT COUNT(*) AS n FROM tickets WHERE status IN ('new','discussion','in_progress','review') AND deadline_at < ?", now),
    one(env, `SELECT COALESCE(SUM(CASE WHEN amount > 0 AND kind != 'refund' THEN amount END), 0) AS issued,
        COALESCE(-SUM(CASE WHEN kind = 'redeem' THEN amount END), 0) - COALESCE(SUM(CASE WHEN kind = 'refund' THEN amount END), 0) AS spent
      FROM coin_tx`),
    all(env, `SELECT u.first_name || ' ' || u.last_name AS name, COUNT(*) AS wins FROM solutions s JOIN users u ON u.id = s.user_id
      WHERE s.is_winner = 1 GROUP BY u.id ORDER BY wins DESC LIMIT 5`),
  ]);
  const total = byStatus.reduce((a, r) => a + r.n, 0);
  const count = (s) => byStatus.find((r) => r.status === s)?.n || 0;
  return {
    total,
    byStatus,
    reviewedShare: total ? (total - count('new')) / total : 0,
    resultShare: total ? (count('done') + count('rejected')) / total : 0,
    done: count('done'),
    overdue: overdue.n,
    avgFirstResponseHours: timing?.first_response ? timing.first_response / HOUR : null,
    avgResolutionHours: timing?.resolution ? timing.resolution / HOUR : null,
    byCategory, bySource, byQr, coins, top,
  };
}

// ---------- Помощник собственника: доклад о проблемах и активности сотрудников ----------
// Оценка сотрудника строится только на фактах из доски, правила открыты и показаны в докладе
const VERDICT = {
  overdue: { icon: '⚠️', label: 'Держит просрочку' },
  solver: { icon: '🏆', label: 'Решает проблемы' },
  active: { icon: '✅', label: 'Участвует' },
  fresh: { icon: '🆕', label: 'Новый сотрудник' },
  idle: { icon: '💤', label: 'Нет активности' },
};

function verdictOf(p, since) {
  if (p.overdue > 0) return 'overdue';
  if (p.done > 0 || p.wins > 0) return 'solver';
  if (p.reports + p.solutions + p.comments > 0) return 'active';
  if (p.created_at >= since) return 'fresh';
  return 'idle';
}

async function buildReport(env, days) {
  const now = Date.now();
  const since = now - days * DAY;
  const OPEN = "('new','discussion','in_progress','review')";
  const [summary, open, solved, people, cats] = await Promise.all([
    one(env, `SELECT
        (SELECT COUNT(*) FROM tickets WHERE created_at >= ?1) AS created,
        (SELECT COUNT(*) FROM tickets WHERE status = 'done' AND resolved_at >= ?1) AS done,
        (SELECT COUNT(*) FROM tickets WHERE status = 'rejected' AND resolved_at >= ?1) AS rejected,
        (SELECT COUNT(*) FROM tickets WHERE status IN ${OPEN}) AS open,
        (SELECT COUNT(*) FROM tickets WHERE status IN ${OPEN} AND deadline_at < ?2) AS overdue,
        (SELECT COUNT(*) FROM tickets t WHERE t.status IN ('new','discussion') AND t.created_at < ?3
          AND NOT EXISTS (SELECT 1 FROM solutions s WHERE s.ticket_id = t.id)) AS stale,
        (SELECT AVG(resolved_at - created_at) FROM tickets WHERE status = 'done' AND resolved_at >= ?1) AS avg_resolve,
        (SELECT COUNT(*) FROM tickets WHERE status = 'done' AND resolved_at >= ?1 AND resolved_at <= deadline_at) AS ontime`,
      since, now, now - 48 * HOUR),
    all(env, `SELECT t.id, t.title, t.status, t.priority, t.created_at, t.deadline_at, t.reward, t.source,
        u.first_name || ' ' || u.last_name AS assignee_name, c.emoji AS category_emoji, c.name AS category_name,
        (SELECT COUNT(*) FROM solutions s WHERE s.ticket_id = t.id) AS solutions_count
      FROM tickets t LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.status IN ${OPEN}
      ORDER BY t.deadline_at < ?1 DESC, t.deadline_at ASC LIMIT 40`, now),
    all(env, `SELECT t.id, t.title, t.resolved_at, t.created_at, t.deadline_at, u.first_name || ' ' || u.last_name AS assignee_name
      FROM tickets t LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.status = 'done' AND t.resolved_at >= ?1 ORDER BY t.resolved_at DESC LIMIT 40`, since),
    all(env, `SELECT u.id, u.first_name, u.last_name, u.photo_url, u.role, u.position, u.department, u.created_at,
        (SELECT COUNT(*) FROM tickets t WHERE t.author_id = u.id AND t.anonymous = 0 AND t.created_at >= ?1) AS reports,
        (SELECT COUNT(*) FROM solutions s WHERE s.user_id = u.id AND s.created_at >= ?1) AS solutions,
        (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id AND c.created_at >= ?1) AS comments,
        (SELECT COUNT(*) FROM coin_tx x WHERE x.user_id = u.id AND x.kind = 'win' AND x.created_at >= ?1) AS wins,
        (SELECT COUNT(*) FROM coin_tx x WHERE x.user_id = u.id AND x.kind = 'done' AND x.created_at >= ?1) AS done,
        (SELECT COUNT(*) FROM coin_tx x WHERE x.user_id = u.id AND x.kind = 'ontime' AND x.created_at >= ?1) AS ontime,
        (SELECT COALESCE(SUM(x.amount), 0) FROM coin_tx x WHERE x.user_id = u.id AND x.amount > 0 AND x.kind != 'refund' AND x.created_at >= ?1) AS coins,
        (SELECT COUNT(*) FROM tickets t WHERE t.assignee_id = u.id AND t.status IN ('in_progress','review')) AS in_work,
        (SELECT COUNT(*) FROM tickets t WHERE t.assignee_id = u.id AND t.status IN ('in_progress','review') AND t.deadline_at < ?2) AS overdue,
        (SELECT MAX(e.created_at) FROM events e WHERE e.user_id = u.id) AS last_at
      FROM users u WHERE u.active = 1 AND u.deleted_at IS NULL AND u.is_owner = 0`, since, now),
    all(env, `SELECT c.emoji, c.name, COUNT(t.id) AS n FROM tickets t JOIN categories c ON c.id = t.category_id
      WHERE t.status IN ${OPEN} GROUP BY c.id ORDER BY n DESC LIMIT 3`),
  ]);

  const staff = people.map((p) => {
    const v = verdictOf(p, since);
    const score = p.done * 10 + p.wins * 5 + p.ontime * 3 + p.solutions * 2 + p.reports + p.comments * 0.5 - p.overdue * 8;
    return { ...p, name: fullName(p), verdict: v, verdict_icon: VERDICT[v].icon, verdict_label: VERDICT[v].label, score: Math.round(score) };
  }).sort((a, b) => b.score - a.score || (b.last_at || 0) - (a.last_at || 0));

  // Выводы для собственника: что требует внимания прямо сейчас
  const insights = [];
  const overdueOwners = staff.filter((p) => p.overdue).map((p) => `${p.name} — ${p.overdue}`);
  if (summary.overdue) insights.push(`⏰ Просрочено задач: ${summary.overdue}.${overdueOwners.length ? ' Больше всего у: ' + overdueOwners.slice(0, 3).join(', ') + '.' : ''}`);
  if (summary.stale) insights.push(`🧊 ${summary.stale} обращ. висят больше 48 ч без единого решения — назначьте исполнителя или повысьте награду.`);
  const idle = staff.filter((p) => p.verdict === 'idle');
  if (idle.length) insights.push(`💤 Без активности за ${days} дн.: ${idle.slice(0, 6).map((p) => p.name).join(', ')}${idle.length > 6 ? ` и ещё ${idle.length - 6}` : ''}.`);
  const best = staff.filter((p) => p.verdict === 'solver').sort((a, b) => b.done - a.done || b.wins - a.wins).slice(0, 3);
  if (best.length) insights.push(`🏆 Больше всех решают: ${best.map((p) => `${p.name} (${p.done} закрыто)`).join(', ')}.`);
  if (summary.created) insights.push(`📈 За период поступило ${summary.created}, закрыто ${summary.done} (${Math.round((summary.done / summary.created) * 100)}%)${summary.done ? `, в срок — ${Math.round((summary.ontime / summary.done) * 100)}%` : ''}.`);
  if (cats[0]?.n) insights.push(`📌 Больше всего открытых проблем в категории «${cats[0].name}» — ${cats[0].n}.`);
  if (!insights.length) insights.push('Пока данных мало: за период не было обращений и активности.');

  return {
    days, from: since, to: now,
    summary: { ...summary, avg_resolve_hours: summary.avg_resolve ? summary.avg_resolve / HOUR : null },
    open: open.map((t) => ({ ...t, overdue: t.deadline_at < now })),
    solved: solved.map((t) => ({ ...t, ontime: t.resolved_at <= t.deadline_at, hours: (t.resolved_at - t.created_at) / HOUR })),
    staff, insights, verdicts: VERDICT,
  };
}

function reportHtml(r) {
  const s = r.summary;
  const hrs = (h) => (h == null ? '—' : h < 48 ? `${Math.round(h)} ч` : `${Math.round(h / 24)} дн`);
  const lines = [
    `📋 <b>Доклад для собственника за ${r.days} дн.</b>`,
    `Поступило: ${s.created} · закрыто: ${s.done} · отклонено: ${s.rejected}`,
    `Открыто сейчас: ${s.open} · просрочено: ${s.overdue} · среднее время решения: ${hrs(s.avg_resolve_hours)}`,
    '', '<b>Главное</b>', ...r.insights.map((i) => escHtml(i)),
    '', '<b>Сотрудники</b>',
    ...r.staff.slice(0, 15).map((p) => `${p.verdict_icon} ${escHtml(p.name)} — закрыто ${p.done}, решений ${p.solutions}, в работе ${p.in_work}${p.overdue ? `, <b>просрочено ${p.overdue}</b>` : ''}`),
  ];
  const urgent = r.open.filter((t) => t.overdue).slice(0, 8);
  if (urgent.length) lines.push('', '<b>Просроченные задачи</b>', ...urgent.map((t) => `• #${t.id} ${escHtml(t.title)} — ${escHtml(t.assignee_name || 'нет исполнителя')}`));
  return lines.join('\n').slice(0, 4000);
}

async function getReport({ env, url }) {
  const days = [7, 30, 90].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 7;
  return buildReport(env, days);
}

async function sendReport({ env, user, body }) {
  const days = [7, 30, 90].includes(Number(body.days)) ? Number(body.days) : 7;
  const res = await tgApi(env, 'sendMessage', {
    chat_id: user.id, text: reportHtml(await buildReport(env, days)), parse_mode: 'HTML', reply_markup: await openButton(env, null, false),
  });
  if (!res?.ok) fail(400, 'Не удалось отправить: откройте бота в личке и нажмите «Старт»');
  return { ok: true };
}

// ---------- Публичная QR-форма для клиентов ----------
async function publicApi(request, env, ctx, url) {
  const path = url.pathname;
  if (path === '/api/public/meta' && request.method === 'GET') {
    const categories = await all(env, 'SELECT id, name, emoji FROM categories WHERE active = 1 AND public = 1 ORDER BY sort, id');
    const tag = url.searchParams.get('p');
    const point = tag ? await one(env, 'SELECT title FROM qr_points WHERE tag = ?', tag) : null;
    const demoUsers = env.DEMO_MODE === '1'
      ? await all(env, 'SELECT id, first_name, last_name, role, department FROM users WHERE id BETWEEN 1000 AND 1999 ORDER BY id')
      : [];
    return json({ company: APP.company, clientQr: APP.clientQr, categories, point: point?.title || null, demo: env.DEMO_MODE === '1', demoUsers, bot: await getSetting(env, 'bot_username') });
  }
  if (path === '/api/public/report' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    if (body.website) return json({ ok: true }); // honeypot для ботов
    if (!APP.clientQr) fail(403, 'Приём обращений по QR временно отключён');
    const title = str(body.title, 140);
    const description = str(body.description, 4000);
    if (title.length < 5) fail(400, 'Кратко опишите проблему (от 5 символов)');
    const cat = await one(env, 'SELECT * FROM categories WHERE id = ? AND active = 1 AND public = 1', Number(body.category_id));
    if (!cat) fail(400, 'Выберите тему обращения');
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    const ipHash = await sha256(ip + (env.WEBHOOK_SECRET || ''));
    const now = Date.now();
    const recent = await one(env, 'SELECT COUNT(*) AS n FROM tickets WHERE ip_hash = ? AND created_at > ?', ipHash, now - HOUR);
    if (recent.n >= 5) fail(429, 'Слишком много обращений, попробуйте позже');
    const total = await one(env, "SELECT COUNT(*) AS n FROM tickets WHERE source = 'client' AND created_at > ?", now - HOUR);
    if (total.n >= 60) fail(429, 'Сервис перегружен, попробуйте через несколько минут');
    const tag = str(body.p, 40);
    const point = tag ? await one(env, 'SELECT tag FROM qr_points WHERE tag = ?', tag) : null;
    const token = crypto.randomUUID().replace(/-/g, '');
    const priority = 'high'; // клиентские обращения — всегда высокий приоритет
    const res = await run(env, `INSERT INTO tickets (title, description, search, category_id, priority, status, source, client_name, client_contact,
        client_token, ip_hash, qr_tag, reward, base_reward, deadline_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'new', 'client', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      title, description, searchText(title, description), cat.id, priority, str(body.name, 80) || null, str(body.contact, 120) || null,
      token, ipHash, point?.tag || null, PRIORITY[priority].reward, PRIORITY[priority].reward, now + PRIORITY[priority].hours * HOUR, now, now);
    const id = res.meta.last_row_id;
    await run(env, 'INSERT INTO events (ticket_id, user_id, type, data, created_at) VALUES (?, NULL, ?, ?, ?)', id, 'created', 'QR-форма клиента', now);
    ctx.waitUntil(announceTicket(env, id));
    return json({ ok: true, id, token });
  }
  if (path === '/api/public/status' && request.method === 'GET') {
    const token = url.searchParams.get('t') || '';
    const t = token.length >= 16 ? await one(env, `SELECT t.id, t.title, t.status, t.created_at, t.updated_at, t.resolution, c.name AS category
      FROM tickets t LEFT JOIN categories c ON c.id = t.category_id WHERE t.client_token = ?`, token) : null;
    if (!t) fail(404, 'Обращение не найдено');
    if (!['done', 'rejected'].includes(t.status)) t.resolution = null;
    return json({ ticket: { ...t, status_label: STATUS_LABEL[t.status] } });
  }
  fail(404, 'Не найдено');
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Уведомления через бота ----------
async function appLink(env, startParam) {
  const bot = (await getSetting(env, 'bot_username')) || env.BOT_USERNAME;
  if (bot && env.APP_SHORT_NAME) return `https://t.me/${bot}/${env.APP_SHORT_NAME}${startParam ? '?startapp=' + startParam : ''}`;
  // Главный Mini App бота (BotFather → Bot Settings → Configure Mini App) открывается ссылкой ?startapp
  if (bot && env.MAIN_APP === '1') return `https://t.me/${bot}?startapp${startParam ? '=' + startParam : ''}`;
  return null;
}

async function openButton(env, ticketId, isGroup) {
  const link = await appLink(env, ticketId ? `t${ticketId}` : '');
  const text = ticketId ? 'Открыть карточку' : '🚀 Войти в Модус Идеи';
  if (link) return { inline_keyboard: [[{ text, url: link }]] };
  const origin = (await getSetting(env, 'origin')) || ORIGIN;
  if (!isGroup && origin) return { inline_keyboard: [[{ text, web_app: { url: `${origin}/${ticketId ? '?t=' + ticketId : ''}` } }]] };
  return undefined;
}

async function dm(env, userId, html, ticketId) {
  if (!userId || userId < 100000) return; // у демо-пользователей нет чата с ботом
  await tgApi(env, 'sendMessage', { chat_id: userId, text: html, parse_mode: 'HTML', reply_markup: await openButton(env, ticketId, false) });
}

const ownerIds = async (env) => (await all(env, 'SELECT id FROM users WHERE is_owner = 1 AND active = 1')).map((u) => u.id);

// Собственник видит всю работу команды: получает копию каждого важного события
async function notifyOwners(env, html, ticketId, skip = []) {
  const ids = (await ownerIds(env)).filter((id) => !skip.includes(id));
  await Promise.all(ids.map((uid) => dm(env, uid, html, ticketId)));
}

async function notifyManagers(env, t, html, skip = []) {
  const cat = await one(env, 'SELECT responsible_id FROM categories WHERE id = ?', t.category_id);
  const ids = cat?.responsible_id ? [cat.responsible_id]
    : (await all(env, "SELECT id FROM users WHERE role IN ('manager','admin') AND active = 1")).map((u) => u.id);
  const all_ = new Set([...ids, ...(await ownerIds(env))].filter((id) => !skip.includes(id)));
  await Promise.all([...all_].map((uid) => dm(env, uid, html, t.id)));
}

async function announceTicket(env, id) {
  const t = await one(env, `SELECT t.*, c.name AS category, c.emoji, u.first_name || ' ' || u.last_name AS assignee_name
    FROM tickets t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = ?`, id);
  const self = t.assignee_id && t.assignee_id === t.author_id;
  const html = `${t.source === 'client' ? '📱 <b>Обращение клиента</b>' : self ? '🛠 <b>Взял(а) в работу</b>' : '🆕 <b>Новое обращение</b>'} #${t.id}\n` +
    `${t.emoji} ${escHtml(t.category)} · ${PRIORITY[t.priority].label} приоритет · 🪙 ${t.reward} МК\n\n<b>${escHtml(t.title)}</b>\n${escHtml(t.description.slice(0, 400))}` +
    (self ? `\n\n👤 Исполнитель: ${escHtml(t.assignee_name)}` : '');
  const groupId = (await getSetting(env, 'group_id')) || env.GROUP_ID;
  const jobs = [notifyManagers(env, t, html, [t.author_id])];
  const tail = self ? '\n\nМожно помочь советом в обсуждении 👇' : '\n\nПодключайтесь и предлагайте решения 👇';
  if (groupId) jobs.push(tgApi(env, 'sendMessage', { chat_id: groupId, text: html + tail, parse_mode: 'HTML', reply_markup: await openButton(env, id, true) }));
  await Promise.all(jobs);
}

const PINNED_TEXT = [
  '💡 <b>Модус Идеи</b> — приложение ГК «Модус Трейд», где команда вместе решает рабочие проблемы.',
  '',
  '<b>Как это работает</b>',
  '1️⃣ Видите проблему — нажмите «Сообщить» и выберите: «Сделаю сам» или «Попросить команду».',
  '2️⃣ Коллеги предлагают решения и голосуют за лучшие.',
  '3️⃣ Руководитель выбирает лучшее решение — его автор становится исполнителем.',
  '4️⃣ Работу приняли — участники получают Модус-коины 🪙',
  '',
  '<b>На что обменять коины</b>',
  'Обед, мерч, денежные премии, дополнительный выходной, дни к отпуску и путёвка в тёплые страны.',
  '',
  '🔥 Задачи, за которые долго никто не берётся, становятся «горящими» — награда за них растёт.',
  '📱 Клиенты сообщают о проблемах через QR-коды на объектах — эти обращения тоже приходят на доску.',
  '',
  '👇 <b>Вход в приложение — кнопка ниже.</b> Она всегда закреплена вверху группы. При первом входе укажите свою должность.',
].join('\n');

// Сообщение с кнопкой входа, закреплённое в рабочей группе (нужны права администратора у бота)
async function postPinnedButton(env, chatId) {
  const sent = await tgApi(env, 'sendMessage', {
    chat_id: chatId, parse_mode: 'HTML',
    text: PINNED_TEXT,
    reply_markup: await openButton(env, null, true),
  });
  if (!sent?.ok) return;
  const prev = await getSetting(env, 'pinned_msg');
  const pin = await tgApi(env, 'pinChatMessage', { chat_id: chatId, message_id: sent.result.message_id, disable_notification: true });
  if (pin?.ok) {
    if (prev) await tgApi(env, 'unpinChatMessage', { chat_id: chatId, message_id: Number(prev) });
    await setSetting(env, 'pinned_msg', String(sent.result.message_id));
  } else {
    await tgApi(env, 'sendMessage', { chat_id: chatId, text: 'Чтобы кнопка всегда была наверху группы, сделайте бота администратором с правом «Закреплять сообщения» и отправьте /app ещё раз.' });
  }
}

// ---------- Telegram webhook ----------
async function webhook(request, env, ctx) {
  if (!env.WEBHOOK_SECRET || !safeEqual(request.headers.get('x-telegram-bot-api-secret-token') || '', env.WEBHOOK_SECRET)) {
    return new Response('forbidden', { status: 403 });
  }
  const update = await request.json().catch(() => ({}));
  ctx.waitUntil(handleUpdate(env, update).catch((e) => console.error('update', e)));
  return new Response('ok');
}

async function handleUpdate(env, update) {
  const mcm = update.my_chat_member;
  if (mcm && ['group', 'supergroup'].includes(mcm.chat.type) && ['member', 'administrator'].includes(mcm.new_chat_member.status)) {
    const bound = String(mcm.chat.id) === String(await getSetting(env, 'group_id'));
    // Бота сделали админом привязанной группы — сразу закрепляем кнопку входа
    if (bound && mcm.new_chat_member.status === 'administrator' && mcm.new_chat_member.can_pin_messages !== false) {
      await postPinnedButton(env, mcm.chat.id);
    } else if (!bound && mcm.old_chat_member?.status !== 'member') {
      await tgApi(env, 'sendMessage', { chat_id: mcm.chat.id, text: '👋 Привет! Я бот «Модус Идеи». Администратор приложения, отправьте здесь /bind — и вход в приложение будет только для участников этой группы.' });
    }
    return;
  }
  const msg = update.message;
  if (!msg) return;
  if (msg.migrate_to_chat_id && String(msg.chat.id) === (await getSetting(env, 'group_id'))) {
    await setSetting(env, 'group_id', msg.migrate_to_chat_id);
    return;
  }
  if (!msg.text) return;
  const cmd = msg.text.split(/[\s@]/)[0].toLowerCase();
  const isGroup = ['group', 'supergroup'].includes(msg.chat.type);

  if (!isGroup && cmd === '/start') {
    const origin = (await getSetting(env, 'origin')) || ORIGIN;
    await tgApi(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: '💡 <b>Модус Идеи</b> — доска проблем и решений компании.\n\nПредлагайте решения, получайте Модус-коины и обменивайте их на премии, выходные, дни к отпуску и путёвки.\n\nВход доступен участникам рабочей группы.\n\nВаш Telegram ID: <code>' + msg.from.id + '</code>',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: 'Открыть приложение', web_app: { url: `${origin}/` } }]] },
    });
    return;
  }
  if (isGroup && cmd === '/bind') {
    const admins = String(env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim()));
    if (!admins.includes(msg.from.id)) {
      await tgApi(env, 'sendMessage', { chat_id: msg.chat.id, text: 'Привязать группу может только администратор приложения (сначала откройте приложение в личке бота).' });
      return;
    }
    await setSetting(env, 'group_id', msg.chat.id);
    await tgApi(env, 'sendMessage', { chat_id: msg.chat.id, text: '✅ Группа подключена. Теперь войти в «Модус Идеи» могут только её участники.' });
    await postPinnedButton(env, msg.chat.id);
    return;
  }
  if (isGroup && (cmd === '/app' || cmd === '/start')) {
    if (await openButton(env, null, true)) return postPinnedButton(env, msg.chat.id);
    const bot = await getSetting(env, 'bot_username');
    await tgApi(env, 'sendMessage', { chat_id: msg.chat.id, text: `💡 Откройте приложение в личке бота: https://t.me/${bot}` });
  }
}

// /setup?key=WEBHOOK_SECRET — регистрирует webhook, кнопку меню и команды бота
async function setup(env, url) {
  if (!env.WEBHOOK_SECRET || !safeEqual(url.searchParams.get('key') || '', env.WEBHOOK_SECRET)) fail(403, 'Неверный ключ');
  const bot = await tgApi(env, 'getMe', {});
  if (!bot?.ok) fail(400, 'Проверьте BOT_TOKEN');
  await setSetting(env, 'bot_username', bot.result.username);
  await setSetting(env, 'origin', url.origin);
  return json({
    bot: bot.result.username,
    webhook: await tgApi(env, 'setWebhook', {
      url: `${url.origin}/tg/webhook`, secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ['message', 'my_chat_member'], drop_pending_updates: true,
    }),
    menu: await tgApi(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Модус Идеи', web_app: { url: `${url.origin}/` } } }),
    commands: await tgApi(env, 'setMyCommands', {
      commands: [{ command: 'start', description: 'Открыть приложение' }, { command: 'app', description: 'Кнопка входа (в группе)' }, { command: 'bind', description: 'Привязать рабочую группу' }],
    }),
    clientFormUrl: `${url.origin}/c/`,
  });
}

// ---------- Ежедневная задача ----------
async function dailyJob(env) {
  const now = Date.now();
  // «Горящие» задачи: никто не взялся за 48 ч — награда растёт на 20% в сутки, максимум x2
  await run(env, `UPDATE tickets SET reward = MIN(base_reward * ?, reward + CAST(ROUND(base_reward * ?) AS INTEGER))
    WHERE status IN ('new','discussion') AND winner_solution_id IS NULL AND created_at < ?`,
    COINS.hotMax, COINS.hotStep, now - COINS.hotAfterHours * HOUR);
  // По понедельникам помощник присылает собственникам доклад за неделю
  if (APP.weeklyReport && new Date(now).getUTCDay() === 1) {
    const owners = await ownerIds(env);
    if (owners.length) {
      const html = reportHtml(await buildReport(env, 7));
      await Promise.all(owners.map((id) => dm(env, id, html)));
    }
  }
  const groupId = (await getSetting(env, 'group_id')) || env.GROUP_ID;
  if (!groupId || !APP.digest) return;
  const [overdue, hot] = await Promise.all([
    all(env, "SELECT id, title, status FROM tickets WHERE status IN ('new','discussion','in_progress','review') AND deadline_at < ? ORDER BY deadline_at LIMIT 10", now),
    all(env, "SELECT id, title, reward FROM tickets WHERE status IN ('new','discussion') AND reward > base_reward ORDER BY reward DESC LIMIT 5"),
  ]);
  if (!overdue.length && !hot.length) return;
  let text = '☀️ <b>Доброе утро! Сводка «Модус Идеи»</b>\n';
  if (hot.length) text += '\n🔥 <b>Горящие задачи — награда выросла:</b>\n' + hot.map((t) => `• #${t.id} ${escHtml(t.title)} — ${t.reward} МК`).join('\n');
  if (overdue.length) text += '\n\n⏰ <b>Просрочены:</b>\n' + overdue.map((t) => `• #${t.id} ${escHtml(t.title)} (${STATUS_LABEL[t.status]})`).join('\n');
  await tgApi(env, 'sendMessage', { chat_id: groupId, text, parse_mode: 'HTML', reply_markup: await openButton(env, null, true) });
}
