import { compare, hash } from "bcryptjs";

// docs/database.md specifies bcrypt cost 12 for stored password hashes.
const SALT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  return compare(plain, hashed);
}
