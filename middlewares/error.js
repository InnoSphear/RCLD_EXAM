class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function notFound(req, res) {
  res.status(404).json({ success: false, message: 'Route not found' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      success: false,
      message: err.message,
      details: err.details,
    });
  }
  if (err.name === 'ValidationError') {
    const details = Object.fromEntries(Object.entries(err.errors || {}).map(([k, v]) => [k, v.message]));
    return res.status(400).json({ success: false, message: 'Validation failed', details });
  }
  if (err.name === 'CastError') {
    return res.status(400).json({ success: false, message: `Invalid value for ${err.path}` });
  }
  if (err.code === 11000) {
    const fields = Object.keys(err.keyValue || {});
    return res.status(409).json({
      success: false,
      message: `Duplicate value for: ${fields.join(', ') || 'field'}`,
      details: err.keyValue,
    });
  }
  if (err.name === 'MulterError') {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large' : err.message;
    return res.status(400).json({ success: false, message: msg });
  }
  console.error('[error]', err.message);
  if (process.env.NODE_ENV !== 'production') console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' ? { error: err.message } : {}),
  });
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { ApiError, errorHandler, notFound, asyncHandler };
