const encoder = new TextEncoder();
function hex(bytes: ArrayBuffer | Uint8Array) {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export function token() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}
export async function digest(value: string) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}
export function constantTime(a: string, b: string) {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}
export async function hashPassword(password: string, salt = token()) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: encoder.encode(salt),
      iterations: 100000,
    },
    key,
    256,
  );
  return `pbkdf2-sha256:100000:${salt}:${hex(bits)}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [algorithm, rounds, salt] = stored.split(':');
  if (algorithm !== 'pbkdf2-sha256' || rounds !== '100000' || !salt)
    return false;
  return constantTime(await hashPassword(password, salt), stored);
}
