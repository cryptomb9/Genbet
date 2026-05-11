const locks = new Set<string>();

export function acquireLock(key: string): (() => void) | null {
  if (locks.has(key)) return null;
  locks.add(key);
  return () => {
    locks.delete(key);
  };
}
