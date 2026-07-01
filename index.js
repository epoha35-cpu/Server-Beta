const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
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
app.use(express.static(path.join(__dirname)));

// ===== HTTP СЕРВЕР =====
const server = http.createServer(app);

// ===== WEBSOCKET СЕРВЕР =====
const wss = new WebSocket.Server({ server });

// Хранилище подключений: { userId: WebSocket }
const clients = new Map();

wss.on('connection', (ws) => {
  console.log('🔌 Новое WebSocket-подключение');

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      console.log('📨 Получено WS-сообщение:', data);

      // ===== АВТОРИЗАЦИЯ WEBSOCKET =====
      if (data.type === 'auth') {
        ws.userId = data.userId;
        clients.set(data.userId, ws);
        console.log(`✅ Пользователь ${data.userId} подключен к WebSocket`);
        return;
      }

      // ===== НОВОЕ СООБЩЕНИЕ =====
      if (data.type === 'new_message') {
        const { chatId, fromUserId, text } = data;
        console.log(`📨 Новое сообщение от ${fromUserId} в чат ${chatId}: ${text}`);
        
        if (!chatId || !fromUserId || !text) {
          console.log('❌ Ошибка: не все поля заполнены');
          return;
        }

        // 1. Сохраняем сообщение в БД
        const messageId = Date.now().toString(36);
        await pool.query(
          'INSERT INTO messages (id, chat_id, from_user_id, text) VALUES ($1, $2, $3, $4)',
          [messageId, chatId, fromUserId, text]
        );
        
        // 2. Обновляем время чата
        await pool.query(
          'UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
          [chatId]
        );

        // 3. Находим получателя
        const chatResult = await pool.query(
          'SELECT user_id, partner_id FROM chats WHERE id = $1',
          [chatId]
        );

        if (chatResult.rows.length > 0) {
          const chat = chatResult.rows[0];
          // Определяем получателя (НЕ отправителя)
          const receiverId = chat.user_id === fromUserId ? chat.partner_id : chat.user_id;
          console.log(`📤 Отправляем сообщение получателю: ${receiverId}`);
          
          // 4. Отправляем сообщение ТОЛЬКО получателю
          const receiverWs = clients.get(receiverId);
          if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
            receiverWs.send(JSON.stringify({
              type: 'new_message',
              chatId: chatId,
              fromUserId: fromUserId,
              text: text,
              createdAt: new Date().toISOString()
            }));
            console.log(`✅ Сообщение отправлено пользователю ${receiverId}`);
          } else {
            console.log(`⚠️ Пользователь ${receiverId} не в сети`);
          }
        } else {
          console.log(`❌ Чат ${chatId} не найден`);
        }
        return;
      }

      // ===== НОВЫЙ ЧАТ =====
      if (data.type === 'new_chat') {
        const { userId, partnerId, chatId } = data;
        console.log(`📨 Новый чат: ${userId} ↔ ${partnerId}`);
        
        const partnerWs = clients.get(partnerId);
        if (partnerWs && partnerWs.readyState === WebSocket.OPEN) {
          partnerWs.send(JSON.stringify({
            type: 'new_chat',
            chatId: chatId,
            partnerId: userId
          }));
          console.log(`✅ Уведомление о новом чате отправлено ${partnerId}`);
        } else {
          console.log(`⚠️ Пользователь ${partnerId} не в сети`);
        }
        return;
      }

    } catch (error) {
      console.error('❌ Ошибка WebSocket:', error);
    }
  });

  ws.on('close', () => {
    if (ws.userId) {
      clients.delete(ws.userId);
      console.log(`🔌 Пользователь ${ws.userId} отключился`);
    }
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket ошибка:', error);
  });
});

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================
async function getUserById(id) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0];
}

async function getChats(userId) {
  const result = await pool.query(
    `SELECT c.*, u.name as partner_name, u.color as partner_color, u.is_admin as partner_is_admin
     FROM chats c
     JOIN users u ON u.id = c.partner_id
     WHERE c.user_id = $1
     ORDER BY c.updated_at DESC`,
    [userId]
  );
  return result.rows;
}

async function getMessages(chatId) {
  const result = await pool.query(
    'SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at ASC',
    [chatId]
  );
  return result.rows;
}

// ============================================
// ИНИЦИАЛИЗАЦИЯ БАЗЫ
// ============================================
async function initDatabase() {
  try {
    console.log('🔄 Проверка подключения...');
    await pool.query('SELECT NOW()');
    console.log('✅ Подключение к БД установлено!');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        password VARCHAR(100) NOT NULL,
        color VARCHAR(20) DEFAULT '#6c8cff',
        is_admin BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS chats (
        id VARCHAR(50) PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        partner_id VARCHAR(50) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (partner_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(50) PRIMARY KEY,
        chat_id VARCHAR(50) NOT NULL,
        from_user_id VARCHAR(50) NOT NULL,
        text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_chats_user_id ON chats(user_id);
      CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
    `);

    console.log('✅ Таблицы созданы!');
    return true;
  } catch (error) {
    console.error('❌ Ошибка БД:', error.message);
    return false;
  }
}

// ============================================
// API ЭНДПОИНТЫ (ТОЛЬКО ДЛЯ HTTP)
// ============================================

// 1. РЕГИСТРАЦИЯ
app.post('/api/register', async (req, res) => {
  const { id, name, password, color } = req.body;
  console.log('📝 Регистрация:', id, name);
  
  if (!id || !name || !password) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }
  try {
    const existing = await getUserById(id);
    if (existing) {
      return res.status(400).json({ error: 'Пользователь уже существует' });
    }
    await pool.query(
      'INSERT INTO users (id, name, password, color, is_admin) VALUES ($1, $2, $3, $4, $5)',
      [id, name, password, color || '#6c8cff', false]
    );
    console.log('✅ Пользователь зарегистрирован:', id);
    res.json({ success: true, user: { id, name, isAdmin: false, color: color || '#6c8cff' } });
  } catch (error) {
    console.error('❌ Ошибка регистрации:', error.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 2. ВХОД
app.post('/api/login', async (req, res) => {
  const { id, password } = req.body;
  console.log('🔑 Вход:', id);
  
  if (!id || !password) {
    return res.status(400).json({ error: 'Заполните ID и пароль' });
  }
  try {
    const user = await getUserById(id);
    if (!user) {
      return res.status(401).json({ error: 'Пользователь не найден' });
    }
    if (user.password !== password) {
      return res.status(401).json({ error: 'Неверный пароль' });
    }
    console.log('✅ Вход выполнен:', id);
    res.json({
      success: true,
      user: { id: user.id, name: user.name, isAdmin: user.is_admin || false, color: user.color }
    });
  } catch (error) {
    console.error('❌ Ошибка входа:', error.message);
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
    console.error('❌ Ошибка получения пользователей:', error.message);
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
    const chats = await getChats(userId);
    const chatsWithMessages = await Promise.all(chats.map(async (chat) => {
      const messages = await getMessages(chat.id);
      return { ...chat, messages: messages };
    }));
    res.json(chatsWithMessages);
  } catch (error) {
    console.error('❌ Ошибка получения чатов:', error.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 5. СОЗДАТЬ ЧАТ
app.post('/api/chats', async (req, res) => {
  const { userId, partnerId } = req.body;
  console.log('📝 Создание чата:', userId, '→', partnerId);
  
  if (!userId || !partnerId) {
    return res.status(400).json({ error: 'Не указаны userId или partnerId' });
  }
  try {
    const partner = await getUserById(partnerId);
    if (!partner) {
      return res.status(400).json({ error: 'Пользователь не найден' });
    }
    const existing = await pool.query(
      'SELECT * FROM chats WHERE user_id = $1 AND partner_id = $2',
      [userId, partnerId]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Чат уже существует' });
    }
    const chatId = Date.now().toString(36);
    
    // Создаём чат для первого пользователя
    await pool.query(
      'INSERT INTO chats (id, user_id, partner_id) VALUES ($1, $2, $3)',
      [chatId, userId, partnerId]
    );
    
    // Создаём зеркальный чат для второго пользователя
    const mirrorChatId = chatId + '_mirror';
    await pool.query(
      'INSERT INTO chats (id, user_id, partner_id) VALUES ($1, $2, $3)',
      [mirrorChatId, partnerId, userId]
    );
    
    // Уведомляем второго пользователя через WebSocket
    const partnerWs = clients.get(partnerId);
    if (partnerWs && partnerWs.readyState === WebSocket.OPEN) {
      partnerWs.send(JSON.stringify({
        type: 'new_chat',
        chatId: mirrorChatId,
        partnerId: userId
      }));
      console.log(`✅ Уведомление о новом чате отправлено ${partnerId}`);
    } else {
      console.log(`⚠️ Пользователь ${partnerId} не в сети, чат будет доступен после перезагрузки`);
    }
    
    console.log('✅ Чат создан:', chatId);
    res.json({ success: true, chatId });
  } catch (error) {
    console.error('❌ Ошибка создания чата:', error.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 6. СОХРАНИТЬ СООБЩЕНИЕ (HTTP — ЗАПАСНОЙ ВАРИАНТ)
app.post('/api/messages', async (req, res) => {
  const { chatId, fromUserId, text } = req.body;
  console.log('📨 HTTP сохранение (запасной вариант):', { chatId, fromUserId, text: text?.substring(0, 30) });
  
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
    console.error('❌ Ошибка сохранения сообщения:', error.message);
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
    console.error('❌ Ошибка удаления чата:', error.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 8. СДЕЛАТЬ АДМИНОМ
app.post('/api/admin/make', async (req, res) => {
  const { userId, adminId } = req.body;
  try {
    if (adminId === userId) {
      const user = await getUserById(userId);
      if (!user) {
        return res.status(400).json({ error: 'Пользователь не найден' });
      }
      await pool.query('UPDATE users SET is_admin = true WHERE id = $1', [userId]);
      return res.json({ success: true });
    }
    const admin = await pool.query('SELECT is_admin FROM users WHERE id = $1', [adminId]);
    if (admin.rows.length === 0 || !admin.rows[0].is_admin) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    await pool.query('UPDATE users SET is_admin = true WHERE id = $1', [userId]);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
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
    console.error('❌ Ошибка удаления:', error.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 10. УДАЛИТЬ ВСЕХ (АДМИН)
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
    console.error('❌ Ошибка:', error.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 11. HEALTH CHECK
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Сервер работает!' });
});

// ===== ЗАПУСК =====
server.listen(port, async () => {
  console.log(`🚀 Сервер запущен на порту ${port}`);
  console.log(`🔌 WebSocket доступен по адресу: ws://localhost:${port}`);
  await initDatabase();
  console.log(`✅ Сервер полностью готов!`);
  console.log(`🌐 Открой: http://localhost:${port}`);
});
