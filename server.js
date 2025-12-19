const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Хранилище пользователей и сообщений в памяти (можно заменить на БД)
const users = new Map(); // userId -> { socketId, phoneNumber, name, password, country, ... }
const messages = new Map(); // chatId -> [messages]
const userSockets = new Map(); // socketId -> userId
const usersByPhone = new Map(); // phoneNumber -> userId (для быстрого поиска)

// Генерация chatId (одинаковый для двух пользователей)
function getChatId(userId1, userId2) {
  return [userId1, userId2].sort().join('_');
}

// Подключение клиента
io.on('connection', (socket) => {
  console.log('✅ Client connected:', socket.id);

  // Регистрация пользователя (с генерацией ID на сервере)
  socket.on('register', (data, callback) => {
    const { phoneNumber, name, password, country } = data;

    if (!phoneNumber) {
      if (callback) callback({ success: false, error: 'Missing phoneNumber' });
      return;
    }

    // Нормализуем телефон
    const normalizedPhone = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;

    // Проверяем, не зарегистрирован ли уже пользователь с таким телефоном
    if (usersByPhone.has(normalizedPhone)) {
      const existingUserId = usersByPhone.get(normalizedPhone);
      if (callback) callback({ success: false, error: 'User already exists', userId: existingUserId });
      return;
    }

    // Генерируем короткий ID (7 символов)
    const generateShortId = (length = 7) => {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let result = '';
      for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return result;
    };

    let userId = generateShortId(7);
    let attempts = 0;
    // Проверяем уникальность ID (максимум 5 попыток)
    while (users.has(userId) && attempts < 5) {
      userId = generateShortId(7);
      attempts++;
    }

    if (users.has(userId)) {
      if (callback) callback({ success: false, error: 'Failed to generate unique ID' });
      return;
    }

    // Хэшируем пароль (простой SHA-256, в продакшене использовать bcrypt)
    const crypto = require('crypto');
    const hashedPassword = crypto.createHash('sha256').update(password || '').digest('hex');

    users.set(userId, {
      socketId: socket.id,
      phoneNumber: normalizedPhone,
      name: name || '',
      password: hashedPassword,
      country: country || '',
      language: 'en',
      lastSeen: Date.now(),
      createdAt: Date.now()
    });

    usersByPhone.set(normalizedPhone, userId);
    userSockets.set(socket.id, userId);

    console.log(`📝 User registered: ${userId} (${normalizedPhone}, ${country})`);
    if (callback) callback({ success: true, userId, message: 'Registration successful' });
  });

  // Логин пользователя
  socket.on('login', (data, callback) => {
    const { phoneNumber, password } = data;

    if (!phoneNumber || !password) {
      if (callback) callback({ success: false, error: 'Missing phoneNumber or password' });
      return;
    }

    const normalizedPhone = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
    const userId = usersByPhone.get(normalizedPhone);

    if (!userId || !users.has(userId)) {
      if (callback) callback({ success: false, error: 'User not found' });
      return;
    }

    const user = users.get(userId);
    const crypto = require('crypto');
    const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

    if (user.password !== hashedPassword) {
      if (callback) callback({ success: false, error: 'Invalid password' });
      return;
    }

    // Обновляем socketId и lastSeen
    user.socketId = socket.id;
    user.lastSeen = Date.now();
    userSockets.set(socket.id, userId);

    console.log(`🔐 User logged in: ${userId} (${normalizedPhone})`);
    if (callback) callback({
      success: true,
      userId,
      user: {
        id: userId,
        phoneNumber: user.phoneNumber,
        name: user.name,
        country: user.country,
        language: user.language,
        lastSeen: user.lastSeen
      }
    });
  });

  // Поиск пользователя по ID
  socket.on('find_user_by_id', (data, callback) => {
    const { userId } = data;

    if (!userId) {
      callback({ error: 'Missing userId' });
      return;
    }

    const user = users.get(userId);
    if (user) {
      callback({
        success: true,
        user: {
          id: userId,
          phoneNumber: user.phoneNumber,
          name: user.name,
          country: user.country,
          language: user.language,
          lastSeen: user.lastSeen
        }
      });
    } else {
      callback({ success: false, error: 'User not found' });
    }
  });

  // Поиск пользователя по телефону
  socket.on('find_user_by_phone', (data, callback) => {
    const { phoneNumber } = data;

    if (!phoneNumber) {
      callback({ error: 'Missing phoneNumber' });
      return;
    }

    // Нормализация телефона
    const normalizedPhone = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;

    // Поиск пользователя
    let foundUser = null;
    for (const [userId, user] of users.entries()) {
      if (user.phoneNumber === normalizedPhone || user.phoneNumber === phoneNumber) {
        foundUser = {
          id: userId,
          phoneNumber: user.phoneNumber,
          name: user.name,
          country: user.country,
          language: user.language,
          lastSeen: user.lastSeen
        };
        break;
      }
    }

    if (foundUser) {
      callback({ success: true, user: foundUser });
    } else {
      callback({ success: false, error: 'User not found' });
    }
  });

  // Получить всех пользователей
  socket.on('get_all_users', (callback) => {
    const allUsers = Array.from(users.entries()).map(([userId, user]) => ({
      id: userId,
      phoneNumber: user.phoneNumber,
      name: user.name,
      language: user.language,
      lastSeen: user.lastSeen
    }));

    callback({ success: true, users: allUsers });
  });

  // Присоединение к чату
  socket.on('join_chat', (data) => {
    const { chatId, userId } = data;

    if (!chatId || !userId) {
      socket.emit('join_error', { message: 'Missing chatId or userId' });
      return;
    }

    socket.join(chatId);
    console.log(`💬 User ${userId} joined chat: ${chatId}`);

    // Отправляем историю сообщений
    const chatMessages = messages.get(chatId) || [];
    socket.emit('chat_history', { chatId, messages: chatMessages });
  });

  // Отправка сообщения
  socket.on('send_message', (data) => {
    const { chatId, message } = data;

    if (!chatId || !message) {
      socket.emit('message_error', { message: 'Missing chatId or message' });
      return;
    }

    // Сохраняем сообщение
    if (!messages.has(chatId)) {
      messages.set(chatId, []);
    }

    const messageData = {
      ...message,
      timestamp: message.timestamp || Date.now(),
      userId: message.userId || userSockets.get(socket.id) || 'unknown' // Добавляем userId если его нет
    };

    messages.get(chatId).push(messageData);

    // Отправляем всем участникам чата
    io.to(chatId).emit('new_message', {
      chatId,
      message: messageData
    });

    console.log(`📨 Message sent in chat ${chatId} by ${messageData.userId}`);
  });

  // Отключение
  socket.on('disconnect', () => {
    const userId = userSockets.get(socket.id);
    if (userId) {
      const user = users.get(userId);
      if (user) {
        user.lastSeen = Date.now();
        user.socketId = null; // Убираем socketId, но оставляем пользователя в системе
      }
      userSockets.delete(socket.id);
      console.log(`❌ User ${userId} disconnected`);
    } else {
      console.log(`❌ Client disconnected: ${socket.id}`);
    }
  });
});

// REST API для проверки статуса
app.get('/health', (req, res) => {
  res.json({ status: 'ok', users: users.size, chats: messages.size });
});

// REST API для поиска пользователя по телефону
app.get('/user/:phone', (req, res) => {
  const phone = req.params.phone;
  const normalizedPhone = phone.startsWith('+') ? phone : `+${phone}`;

  const userId = usersByPhone.get(normalizedPhone);
  if (!userId || !users.has(userId)) {
    return res.status(404).json({ error: 'User not found', phone: normalizedPhone });
  }

  const user = users.get(userId);
  res.json({
    success: true,
    user: {
      id: userId,
      phoneNumber: user.phoneNumber,
      name: user.name,
      country: user.country,
      language: user.language,
      lastSeen: user.lastSeen,
      createdAt: user.createdAt
    }
  });
});

// REST API для получения всех пользователей
app.get('/users', (req, res) => {
  const allUsers = Array.from(users.entries()).map(([userId, user]) => ({
    id: userId,
    phoneNumber: user.phoneNumber,
    name: user.name,
    country: user.country,
    language: user.language,
    lastSeen: user.lastSeen,
    createdAt: user.createdAt
  }));

  res.json({ success: true, users: allUsers, count: allUsers.length });
});

// REST API для очистки всех пользователей
app.delete('/users', (req, res) => {
  const usersCount = users.size;
  const messagesCount = messages.size;

  users.clear();
  usersByPhone.clear();
  userSockets.clear();
  messages.clear();

  console.log(`🗑️ Cleared all data: ${usersCount} users, ${messagesCount} chats`);
  res.json({
    success: true,
    message: 'All users and messages cleared',
    deleted: {
      users: usersCount,
      chats: messagesCount
    }
  });
});

// REST API для очистки только пользователей (сообщения остаются)
app.delete('/users/clear', (req, res) => {
  const usersCount = users.size;

  users.clear();
  usersByPhone.clear();
  userSockets.clear();

  console.log(`🗑️ Cleared all users: ${usersCount} users`);
  res.json({
    success: true,
    message: 'All users cleared',
    deleted: {
      users: usersCount
    }
  });
});

// ОЧИСТКА ВСЕХ ПОЛЬЗОВАТЕЛЕЙ ПРИ СТАРТЕ
console.log('🗑️ Clearing all users on startup...');
users.clear();
usersByPhone.clear();
userSockets.clear();
messages.clear();
console.log('✅ All users cleared!');

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Socket.IO ready for connections`);
  console.log(`💡 To clear all users: DELETE http://localhost:${PORT}/users`);
  console.log(`🌐 Server accessible from: http://0.0.0.0:${PORT}`);
});

