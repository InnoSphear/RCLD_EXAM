const router = require('express').Router();
const { authenticate } = require('../middlewares/auth');
const { validate } = require('../middlewares/validate');
const c = require('../controllers/attemptController');

router.use(authenticate);

router.get('/mine', c.myAttempts);
router.post('/start', validate({ examId: 'required|string' }), c.startAttempt);
router.get('/:id', c.getAttempt);
router.put('/:id/answers', c.saveAnswer);
router.post('/:id/submit', c.submitAttempt);
router.get('/:id/result', c.attemptResult);

module.exports = router;
