/**
 * backend/src/auth.js — JWT helpers for magic link authentication
 * Uses jose (already a project dependency) with HS256 symmetric signing.
 */

import * as jose from 'jose';

function secretKey(secret) {
  return new TextEncoder().encode(secret);
}

export async function signJWT(payload, secret, expiresIn = '1h') {
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secretKey(secret));
}

export async function verifyJWT(token, secret) {
  try {
    const { payload } = await jose.jwtVerify(token, secretKey(secret));
    return payload;
  } catch {
    return null;
  }
}

// 1-hour token embedded in the magic link email
export async function generateMagicToken(email, conversationId, visitorId, origin, secret) {
  return signJWT(
    { type: 'magic', email, conversationId, visitorId, origin },
    secret,
    '1h'
  );
}

// 30-day token stored in localStorage as wa_auth_token
export async function generateAuthToken(userId, email, secret) {
  return signJWT(
    { type: 'auth', sub: userId, email },
    secret,
    '30d'
  );
}
