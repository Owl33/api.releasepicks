const SENSITIVE_KEYS = [
  'password',
  'pw',
  'token',
  'authorization',
  'auth',
  'apiKey',
  'secret',
  'cookie',
  'set-cookie',
];

export function maskSensitive(obj: any, depth = 0): any {
  if (obj == null) return obj;
  if (depth > 4) return '[truncated]';
  if (Array.isArray(obj)) return obj.map((v) => maskSensitive(v, depth + 1));
  if (typeof obj === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.includes(k.toLowerCase())) out[k] = '[masked]';
      else out[k] = maskSensitive(v, depth + 1);
    }
    return out;
  }
  return obj;
}
