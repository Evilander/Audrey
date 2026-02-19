/**
 * Cosine similarity between two embedding buffers.
 * @param {Buffer} bufA - First embedding buffer
 * @param {Buffer} bufB - Second embedding buffer
 * @param {{ bufferToVector: (buf: Buffer) => number[] }} provider - Embedding provider with bufferToVector method
 * @returns {number} Similarity score in [-1, 1]
 */
export function cosineSimilarity(bufA, bufB, provider) {
  const a = provider.bufferToVector(bufA);
  const b = provider.bufferToVector(bufB);
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

/**
 * Days between a date string and now.
 * @param {string} dateStr - ISO date string
 * @param {Date} now - Current date
 * @returns {number} Days elapsed (minimum 0)
 */
export function daysBetween(dateStr, now) {
  return Math.max(0, (now.getTime() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Safely parse JSON with fallback.
 * @param {string|null} str - JSON string to parse
 * @param {*} fallback - Value to return if parsing fails
 * @returns {*} Parsed value or fallback
 */
export function safeJsonParse(str, fallback = null) {
  if (!str) return fallback;
  try { return JSON.parse(str); }
  catch { return fallback; }
}
