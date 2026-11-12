-- Модус Идеи — схема D1 (SQLite). Время хранится в миллисекундах (Date.now()).

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,               -- Telegram user id
  username TEXT,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  photo_url TEXT,
  role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee','manager','admin')),
  is_owner INTEGER NOT NULL DEFAULT 0,      -- собственник: регистрируется по приглашению, видит работу всей команды
  deleted_at INTEGER,                       -- удалён администратором: доступ закрыт, история сохраняется
  position TEXT,                            -- должность, указывает сам сотрудник при первом входе
  department TEXT,
  balance INTEGER NOT NULL DEFAULT 0,
  earned_total INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  member_checked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '📌',
  color TEXT NOT NULL DEFAULT '#6b7fa8',
  responsible_id INTEGER REFERENCES users(id),
  public INTEGER NOT NULL DEFAULT 1,    -- доступна клиентам в QR-форме
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  search TEXT NOT NULL DEFAULT '',      -- title+description в нижнем регистре (SQLite lower() не знает кириллицу)
  category_id INTEGER REFERENCES categories(id),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','discussion','in_progress','review','done','rejected')),
  source TEXT NOT NULL DEFAULT 'employee' CHECK (source IN ('employee','client')),
  author_id INTEGER REFERENCES users(id),
  anonymous INTEGER NOT NULL DEFAULT 0,
  client_name TEXT,
  client_contact TEXT,
  client_token TEXT UNIQUE,
  ip_hash TEXT,
  qr_tag TEXT,
  reward INTEGER NOT NULL DEFAULT 60,
  base_reward INTEGER NOT NULL DEFAULT 60,
  assignee_id INTEGER REFERENCES users(id),
  winner_solution_id INTEGER,
  resolution TEXT,
  deadline_at INTEGER NOT NULL,
  first_response_at INTEGER,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_tickets_author ON tickets(author_id);

CREATE TABLE IF NOT EXISTS participants (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (ticket_id, user_id)
);

CREATE TABLE IF NOT EXISTS solutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  is_winner INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_solutions_ticket ON solutions(ticket_id);

CREATE TABLE IF NOT EXISTS solution_votes (
  solution_id INTEGER NOT NULL REFERENCES solutions(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (solution_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  user_id INTEGER REFERENCES users(id),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  user_id INTEGER,
  type TEXT NOT NULL,
  data TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ticket ON events(ticket_id);

CREATE TABLE IF NOT EXISTS coin_tx (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  kind TEXT NOT NULL,                   -- proposal | win | done | ontime | report | manual | redeem | refund
  reason TEXT NOT NULL,
  ticket_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coin_tx_user ON coin_tx(user_id, created_at);

CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT '🎁',
  price INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  reward_id INTEGER NOT NULL REFERENCES rewards(id),
  price INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  note TEXT,
  decided_by INTEGER,
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS qr_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Справочники по умолчанию
INSERT OR IGNORE INTO categories (id, name, emoji, color, public, sort) VALUES
  (1, 'Сервис и монтаж',     '🛠', '#5b8def', 1, 10),
  (2, 'Продажи и клиенты',   '🤝', '#3fa27a', 1, 20),
  (3, 'Закупки и склад',     '📦', '#c98a2e', 1, 30),
  (4, 'Проектирование',      '📐', '#8b6fd6', 0, 40),
  (5, 'IT и 1С / Битрикс24', '💻', '#2f9bb3', 0, 50),
  (6, 'Офис и условия труда','🏢', '#d16a8a', 0, 60),
  (7, 'Идея / улучшение',    '💡', '#d4a72c', 0, 70);

INSERT OR IGNORE INTO rewards (id, title, description, emoji, price, sort) VALUES
  (1, 'Обед за счёт компании', 'Бизнес-ланч в любой рабочий день',            '🍱', 80,   10),
  (2, 'Мерч «Модус»',          'Худи, термокружка или рюкзак на выбор',       '🎁', 150,  20),
  (3, 'Премия 3 000 ₽',        'Добавляется к ближайшей зарплате',            '💰', 300,  30),
  (4, 'Дополнительный выходной','Согласуйте дату с руководителем',            '🛋', 400,  40),
  (5, '+1 день к отпуску',     'Оплачиваемый день к ежегодному отпуску',      '🏖', 500,  50),
  (6, 'Премия 10 000 ₽',       'Добавляется к ближайшей зарплате',            '💸', 900,  60),
  (7, 'Путёвка в тёплые страны','Тур на двоих, 7 ночей, в период отпуска',    '✈️', 6000, 70);
