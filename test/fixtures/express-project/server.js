const express = require('express');
const app = express();
const userRouter = require('./routes/users');
const authMiddleware = require('./middleware/auth');

app.use(express.json());
app.use(authMiddleware);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/users', userRouter);

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
