const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({ users: [] });
});

router.post('/', (req, res) => {
  const { name, email } = req.body;
  res.status(201).json({ id: 1, name, email });
});

router.get('/:id', (req, res) => {
  res.json({ id: req.params.id, name: 'Test User' });
});

router.put('/:id', (req, res) => {
  res.json({ id: req.params.id, ...req.body });
});

router.delete('/:id', (req, res) => {
  res.status(204).send();
});

module.exports = router;
