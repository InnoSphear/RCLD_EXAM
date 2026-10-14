const router = require('express').Router();

router.use('/auth', require('./auth'));
router.use('/users', require('./users'));
router.use('/students', require('./students'));
router.use('/academics', require('./academics'));
router.use('/questions', require('./questions'));
router.use('/exams', require('./exams'));
router.use('/exam-attempts', require('./attempts'));
router.use('/results', require('./results'));
router.use('/exports', require('./exports'));
router.use('/admin', require('./admin'));
router.use('/student', require('./studentPortal'));

router.get('/health', (req, res) => {
  const mongoose = require('mongoose');
  res.json({
    success: true,
    data: {
      status: mongoose.connection.readyState === 1 ? 'ok' : 'degraded',
      db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      serverTime: new Date(),
    },
  });
});

module.exports = router;
