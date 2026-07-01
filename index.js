const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

console.log('🚀 Запуск сервера...');

// ===== ПОДКЛЮЧЕНИЕ К БАЗЕ =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});

// ===== МИДЛВАРЫ =====
app.use(cors());
app.use(express.json());

// ============================================
// ВСЕ API-МАРШРУТЫ (ДО СТАТИКИ!)
// ============================================

// 1. РЕГИСТРАЦИЯ
app.post('/api/register', async (req, res) => {
  const { id, name, password, color } = req.body;
  try {
    const existing = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Пользователь уже существует' });
    }
    await pool.query(
      'INSERT INTO users (id, name, password, color, is_admin) VALUES ($1, $2, $3, $4, $5)',
      [id, name, password, color || '#6c8cff', false]
    );
    res.json({ success: true, user: { id, name, isAdmin: false, color: color || '#6c8cff' } });
  } catch (error) {
    console.error('Ошибка регистрации:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 2. ВХОД
app.post('/api/login', async (req, res) => {
  const { id, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Пользователь не найден' });
    }
    const user = result.rows[0];
    if (user.password !== password) {
      return res.status(401).json({ error: 'Неверный пароль' });
    }
    res.json({
      success: true,
      user: { id: user.id, name: user.name, isAdmin: user.is_admin || false, color: user.color }
    });
  } catch (error) {
    console.error('Ошибка входа:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 3. ПОЛУЧИТЬ ВСЕХ ПОЛЬЗОВАТЕЛЕЙ
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, color, is_admin FROM users');
    const list = result.rows.map(u => ({
      id: u.id,
      name: u.name,
      color: u.color,
      isAdmin: u.is_admin || false
    }));
    res.json(list);
  } catch (error) {
    console.error('Ошибка получения пользователей:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 4. ПОЛУЧИТЬ ЧАТЫ
app.get('/api/chats', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) {
    return res.status(400).json({ error: 'Не указан userId' });
  }
  try {
    const result = await pool.query(
      `SELECT c.*, u.name as partner_name, u.color as partner_color, u.is_admin as partner_is_admin
       FROM chats c
       JOIN users u ON u.id = c.partner_id
       WHERE c.user_id = $1
       ORDER BY c.updated_at DESC`,
      [userId]
    );
    
    const chats = await Promise.all(result.rows.map(async (chat) => {
      const messages = await pool.query(
        'SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at ASC',
        [chat.id]
      );
      return { ...chat, messages: messages.rows };
    }));
    
    res.json(chats);
  } catch (error) {
    console.error('Ошибка получения чатов:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 5. СОЗДАТЬ ЧАТ
app.post('/api/chats', async (req, res) => {
  const { userId, partnerId } = req.body;
  if (!userId || !partnerId) {
    return res.status(400).json({ error: 'Не указаны userId или partnerId' });
  }
  try {
    const existing = await pool.query(
      'SELECT * FROM chats WHERE user_id = $1 AND partner_id = $2',
      [userId, partnerId]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Чат уже существует' });
    }
    const chatId = Date.now().toString(36);
    await pool.query(
      'INSERT INTO chats (id, user_id, partner_id) VALUES ($1, $2, $3)',
      [chatId, userId, partnerId]
    );
    await pool.query(
      'INSERT INTO chats (id, user_id, partner_id) VALUES ($1, $2, $3)',
      [chatId + '_mirror', partnerId, userId]
    );
    res.json({ success: true, chatId });
  } catch (error) {
    console.error('Ошибка создания чата:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 6. ОТПРАВИТЬ СООБЩЕНИЕ
app.post('/api/messages', async (req, res) => {
  const { chatId, fromUserId, text } = req.body;
  if (!chatId || !fromUserId || !text) {
    return res.status(400).json({ error: 'Не все поля заполнены' });
  }
  try {
    const messageId = Date.now().toString(36);
    await pool.query(
      'INSERT INTO messages (id, chat_id, from_user_id, text) VALUES ($1, $2, $3, $4)',
      [messageId, chatId, fromUserId, text]
    );
    await pool.query(
      'UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [chatId]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка отправки сообщения:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 7. УДАЛИТЬ ЧАТ
app.delete('/api/chats', async (req, res) => {
  const { userId, chatId } = req.body;
  if (!userId || !chatId) {
    return res.status(400).json({ error: 'Не указаны userId или chatId' });
  }
  try {
    await pool.query('DELETE FROM chats WHERE user_id = $1 AND id = $2', [userId, chatId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка удаления чата:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 8. СДЕЛАТЬ АДМИНОМ
app.post('/api/admin/make', async (req, res) => {
  const { userId, adminId } = req.body;
  try {
    const admin = await pool.query('SELECT is_admin FROM users WHERE id = $1', [adminId]);
    if (admin.rows.length === 0 || !admin.rows[0].is_admin) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    await pool.query('UPDATE users SET is_admin = true WHERE id = $1', [userId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 9. УДАЛИТЬ ПОЛЬЗОВАТЕЛЯ (АДМИН)
app.delete('/api/admin/users', async (req, res) => {
  const { userId, adminId } = req.body;
  try {
    const admin = await pool.query('SELECT is_admin FROM users WHERE id = $1', [adminId]);
    if (admin.rows.length === 0 || !admin.rows[0].is_admin) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    if (userId === adminId) {
      return res.status(400).json({ error: 'Нельзя удалить самого себя' });
    }
    await pool.query('DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE user_id = $1 OR partner_id = $1)', [userId]);
    await pool.query('DELETE FROM chats WHERE user_id = $1 OR partner_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка удаления:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 10. УДАЛИТЬ ВСЕХ ПОЛЬЗОВАТЕЛЕЙ (АДМИН)
app.delete('/api/admin/users/all', async (req, res) => {
  const { adminId } = req.body;
  try {
    const admin = await pool.query('SELECT is_admin FROM users WHERE id = $1', [adminId]);
    if (admin.rows.length === 0 || !admin.rows[0].is_admin) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    await pool.query('DELETE FROM messages');
    await pool.query('DELETE FROM chats');
    await pool.query('DELETE FROM users');
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 11. ПОЛУЧИТЬ ОДИН ЧАТ
app.get('/api/chat', async (req, res) => {
  const chatId = req.query.chatId;
  const userId = req.query.userId;
  if (!chatId || !userId) {
    return res.status(400).json({ error: 'Не указаны chatId или userId' });
  }
  try {
    const result = await pool.query('SELECT * FROM chats WHERE id = $1 AND user_id = $2', [chatId, userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Чат не найден' });
    }
    const chat = result.rows[0];
    const messages = await pool.query('SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at ASC', [chatId]);
    chat.messages = messages.rows;
    res.json(chat);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 12. HEALTH CHECK
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Сервер работает!' });
});

// ============================================
// СТАТИЧЕСКИЕ ФАЙЛЫ
// ============================================
const path = require('path');
app.use(express.static(path.join(__dirname)));

// ЯВНАЯ ОТДАЧА index.html ДЛЯ ГЛАВНОЙ СТРАНИЦЫ
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ===== ЗАПУСК =====
app.listen(port, async () => {
  console.log(`🚀 Сервер запущен на порту ${port}`);
  await initDatabase();
  console.log(`🌐 Открой: http://localhost:${port}`);
});
