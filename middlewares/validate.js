const { ApiError } = require('./error');

// Tiny declarative validator: validates req.body fields and merges sanitized values.
// Rules: { email: 'required|email', name: 'required|string|max:120', age: 'integer|min:0' }
function validate(rules, source = 'body') {
  return (req, res, next) => {
    const data = req[source] || {};
    const details = {};
    const out = {};
    const parse = (ruleStr) => ruleStr.split('|');
    const testField = (key, rulesList) => {
      let value = data[key];
      for (const rule of rulesList) {
        const [name, arg] = rule.split(':');
        switch (name) {
          case 'required':
            if (value === undefined || value === null || String(value).trim() === '') {
              details[key] = `${key} is required`;
              return;
            }
            break;
          case 'email':
            if (value !== undefined && value !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) {
              details[key] = `${key} must be a valid email`;
              return;
            }
            break;
          case 'string':
            if (value !== undefined && value !== null && typeof value !== 'string' && typeof value !== 'number') {
              details[key] = `${key} must be a string`;
              return;
            }
            if (value !== undefined && value !== null) value = String(value);
            break;
          case 'integer':
            if (value !== undefined && value !== '' && value !== null && !Number.isInteger(Number(value))) {
              details[key] = `${key} must be an integer`;
              return;
            }
            if (value !== undefined && value !== '' && value !== null) value = Number(value);
            break;
          case 'number':
            if (value !== undefined && value !== '' && value !== null && Number.isNaN(Number(value))) {
              details[key] = `${key} must be a number`;
              return;
            }
            if (value !== undefined && value !== '' && value !== null) value = Number(value);
            break;
          case 'min':
            if (value !== undefined && value !== '' && Number(value) < Number(arg)) {
              details[key] = `${key} must be at least ${arg}`;
              return;
            }
            break;
          case 'max':
            if (value !== undefined && value !== '' && String(value).length > Number(arg)) {
              details[key] = `${key} must be at most ${arg} characters`;
              return;
            }
            break;
          case 'in':
            if (value !== undefined && value !== '' && !arg.split(',').includes(String(value))) {
              details[key] = `${key} must be one of: ${arg}`;
              return;
            }
            break;
          case 'iso':
            if (value !== undefined && value !== '' && Number.isNaN(Date.parse(value))) {
              details[key] = `${key} must be a valid date`;
              return;
            }
            break;
          case 'array':
            if (value !== undefined && value !== null && !Array.isArray(value)) {
              details[key] = `${key} must be an array`;
              return;
            }
            break;
          case 'boolean':
            if (value !== undefined && value !== null && typeof value !== 'boolean') {
              details[key] = `${key} must be a boolean`;
              return;
            }
            break;
          case 'default':
            if (value === undefined || value === '') value = arg;
            break;
          default:
            break;
        }
      }
      out[key] = value === '' && rulesList.includes('default') ? (arg ?? value) : value;
    };
    for (const [key, ruleStr] of Object.entries(rules)) {
      testField(key, parse(ruleStr));
    }
    if (Object.keys(details).length) throw new ApiError(400, 'Validation failed', details);
    req.validated = { ...(req.validated || {}), ...out };
    next();
  };
}

module.exports = { validate };
