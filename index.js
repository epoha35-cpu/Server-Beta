const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

console.log('🚀 Старт сервера...');

// 1. Просто подключение
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 5000, // 5 секунд на подключение
});

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// 2. Тестовый эндпоинт (проверка, что сервер жив)
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', message: 'pong' });
});

// 3. Запуск
app.listen(port, () => {
  console.log(`✅ Сервер запущен на порту ${port}`);
});
