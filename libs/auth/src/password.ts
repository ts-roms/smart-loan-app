import argon2 from 'argon2';

/**
 * Hash a password with Argon2id at sensible defaults. The cost is tuned
 * for ~50ms on a modern server — fast enough for login throughput, slow
 * enough to make offline attacks expensive.
 */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
