-- Синтетические демо-данные. Применяйте только для демонстрации (DEMO_MODE=1).
-- Время считается относительно момента загрузки: now - N часов.

INSERT OR IGNORE INTO users (id, username, first_name, last_name, role, department, balance, earned_total, member_checked_at, created_at) VALUES
  (1001, 'anna_admin',  'Анна',  'Соколова', 'admin',    'Управление',      420, 620,  9999999999999, strftime('%s','now')*1000 - 864000000),
  (1002, 'igor_lead',   'Игорь', 'Белов',    'manager',  'Сервис',          260, 260,  9999999999999, strftime('%s','now')*1000 - 864000000),
  (1003, 'maria_eng',   'Мария', 'Ким',      'employee', 'Проектирование',  735, 935,  9999999999999, strftime('%s','now')*1000 - 864000000),
  (1004, 'petr_tech',   'Пётр',  'Орлов',    'employee', 'Сервис',          180, 180,  9999999999999, strftime('%s','now')*1000 - 864000000),
  (1005, 'olga_sales',  'Ольга', 'Миронова', 'employee', 'Продажи',         95,  95,   9999999999999, strftime('%s','now')*1000 - 864000000);

UPDATE users SET position = CASE id WHEN 1001 THEN 'Операционный директор' WHEN 1002 THEN 'Руководитель сервисного отдела' WHEN 1003 THEN 'Инженер-проектировщик' WHEN 1004 THEN 'Сервисный инженер' WHEN 1005 THEN 'Менеджер по продажам' END WHERE id BETWEEN 1001 AND 1005 AND position IS NULL;
UPDATE categories SET responsible_id = 1002 WHERE id IN (1, 3);
UPDATE categories SET responsible_id = 1001 WHERE responsible_id IS NULL;

INSERT OR IGNORE INTO qr_points (id, tag, title, created_at) VALUES
  (1, 'office-msk', 'Офис продаж, Москва', strftime('%s','now')*1000 - 864000000),
  (2, 'service-van', 'Сервисный автомобиль', strftime('%s','now')*1000 - 864000000);

INSERT OR IGNORE INTO tickets (id, title, description, search, category_id, priority, status, source, author_id, anonymous, client_name, client_contact, client_token, qr_tag, reward, base_reward, assignee_id, winner_solution_id, resolution, deadline_at, first_response_at, resolved_at, created_at, updated_at) VALUES
  (1, 'Монтажники неделю ждут кабель с центрального склада',
      'На объектах простаивают бригады: заявка на кабель КПСВВ уходит в закупки письмом и теряется. Срок поставки 5–7 дней.',
      'монтажники неделю ждут кабель с центрального склада на объектах простаивают бригады: заявка на кабель кпсвв уходит в закупки письмом и теряется. срок поставки 5–7 дней.',
      3, 'high', 'discussion', 'employee', 1004, 0, NULL, NULL, NULL, NULL, 144, 120, NULL, NULL, NULL,
      strftime('%s','now')*1000 - 20*3600000, strftime('%s','now')*1000 - 40*3600000, NULL,
      strftime('%s','now')*1000 - 72*3600000, strftime('%s','now')*1000 - 10*3600000),
  (2, 'Камеры на объекте ЖК «Северный» отключаются ночью',
      'Клиент сообщает: после 2:00 пропадает изображение с 4 камер в паркинге. Утром всё работает.',
      'камеры на объекте жк «северный» отключаются ночью клиент сообщает: после 2:00 пропадает изображение с 4 камер в паркинге. утром всё работает.',
      1, 'high', 'new', 'client', NULL, 0, 'УК «Северный»', '+7 900 000-00-00', 'demo-token-0002', 'office-msk', 120, 120, NULL, NULL, NULL,
      strftime('%s','now')*1000 + 18*3600000, NULL, NULL,
      strftime('%s','now')*1000 - 6*3600000, strftime('%s','now')*1000 - 6*3600000),
  (3, 'Нет шаблона КП для систем контроля доступа',
      'Каждый менеджер собирает коммерческое предложение по СКУД с нуля, уходит 2–3 часа.',
      'нет шаблона кп для систем контроля доступа каждый менеджер собирает коммерческое предложение по скуд с нуля, уходит 2–3 часа.',
      2, 'medium', 'in_progress', 'employee', 1005, 0, NULL, NULL, NULL, NULL, 60, 60, 1003, 2, NULL,
      strftime('%s','now')*1000 + 30*3600000, strftime('%s','now')*1000 - 40*3600000, NULL,
      strftime('%s','now')*1000 - 42*3600000, strftime('%s','now')*1000 - 20*3600000),
  (4, 'Дублирование сделок между Битрикс24 и 1С УТ',
      'Сделку вносим в Б24, потом руками переносим заказ в 1С. Ошибки в артикулах и ценах.',
      'дублирование сделок между битрикс24 и 1с ут сделку вносим в б24, потом руками переносим заказ в 1с. ошибки в артикулах и ценах.',
      5, 'medium', 'review', 'employee', 1003, 1, NULL, NULL, NULL, NULL, 60, 60, 1004, NULL,
      'Настроили обмен заказами через REST Б24 → 1С раз в 15 минут, проверено на 20 сделках.',
      strftime('%s','now')*1000 + 10*3600000, strftime('%s','now')*1000 - 55*3600000, NULL,
      strftime('%s','now')*1000 - 60*3600000, strftime('%s','now')*1000 - 3*3600000),
  (5, 'Холодно в переговорной №2',
      'Кондиционер дует прямо на стол, клиенты жалуются.',
      'холодно в переговорной №2 кондиционер дует прямо на стол, клиенты жалуются.',
      6, 'low', 'done', 'employee', 1005, 0, NULL, NULL, NULL, NULL, 30, 30, 1004, NULL,
      'Переставили стол и поменяли направление жалюзи кондиционера.',
      strftime('%s','now')*1000 + 100*3600000, strftime('%s','now')*1000 - 90*3600000, strftime('%s','now')*1000 - 80*3600000,
      strftime('%s','now')*1000 - 96*3600000, strftime('%s','now')*1000 - 80*3600000);

INSERT OR IGNORE INTO solutions (id, ticket_id, user_id, text, is_winner, created_at) VALUES
  (1, 1, 1003, 'Завести в Битрикс24 смарт-процесс «Заявка на материалы» с SLA 24 часа и автоуведомлением закупщику.', 0, strftime('%s','now')*1000 - 40*3600000),
  (2, 3, 1003, 'Сделать конструктор КП в Google Таблицах: выбор оборудования из прайса → автоматический расчёт и PDF.', 1, strftime('%s','now')*1000 - 40*3600000),
  (3, 3, 1004, 'Собрать 3 типовых КП (малый офис, БЦ, ЖК) и хранить в общей папке.', 0, strftime('%s','now')*1000 - 38*3600000),
  (4, 1, 1004, 'Держать на каждом участке неснижаемый остаток 2 бухты кабеля.', 0, strftime('%s','now')*1000 - 30*3600000);

INSERT OR IGNORE INTO solution_votes (solution_id, user_id) VALUES (1, 1004), (1, 1005), (2, 1005), (4, 1002);

INSERT OR IGNORE INTO participants (ticket_id, user_id, joined_at) VALUES
  (1, 1003, strftime('%s','now')*1000 - 40*3600000), (1, 1004, strftime('%s','now')*1000 - 30*3600000),
  (3, 1003, strftime('%s','now')*1000 - 40*3600000), (3, 1004, strftime('%s','now')*1000 - 38*3600000),
  (4, 1004, strftime('%s','now')*1000 - 55*3600000);

INSERT OR IGNORE INTO comments (id, ticket_id, user_id, text, created_at) VALUES
  (1, 1, 1002, 'Согласен, по прошлому месяцу 6 дней простоя бригад. Жду варианты до пятницы.', strftime('%s','now')*1000 - 35*3600000);

INSERT OR IGNORE INTO coin_tx (user_id, amount, kind, reason, ticket_id, created_at) VALUES
  (1003, 60, 'win',  'Лучшее решение по задаче #3', 3, strftime('%s','now')*1000 - 20*3600000),
  (1004, 30, 'win',  'Решение задачи #5', 5, strftime('%s','now')*1000 - 80*3600000),
  (1004, 15, 'done', 'Внедрение решения #5', 5, strftime('%s','now')*1000 - 80*3600000),
  (1004, 20, 'ontime','Точно в срок #5', 5, strftime('%s','now')*1000 - 80*3600000),
  (1005, 10, 'report','Полезное обращение #5', 5, strftime('%s','now')*1000 - 80*3600000);
