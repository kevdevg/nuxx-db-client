let counter = Math.floor(Math.random() * 0xffffff);
const machineAndPid = Array.from({ length: 5 }, () =>
  Math.floor(Math.random() * 256)
    .toString(16)
    .padStart(2, '0')
).join('');

/**
 * Generates a valid 24-hex-character MongoDB ObjectId on the client (4-byte timestamp +
 * 5-byte random process unique + 3-byte incrementing counter) with zero external dependencies.
 */
export function generateObjectId(): string {
  const timestamp = Math.floor(Date.now() / 1000)
    .toString(16)
    .padStart(8, '0');
  counter = (counter + 1) & 0xffffff;
  const countHex = counter.toString(16).padStart(6, '0');
  return `${timestamp}${machineAndPid}${countHex}`;
}

export function isValidObjectId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-fA-F0-9]{24}$/.test(id);
}
