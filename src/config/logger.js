export const log = {
    debug: (...a) => console.log('[DEBUG]', ...a),
    info: (...a) => console.log('[INFO]', ...a),
    warn: (...a) => console.warn('[WARN]', ...a),
    error: (...a) => console.error('[ERROR]', ...a)
  };
  