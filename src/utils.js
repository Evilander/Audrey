/**
 * @param {Buffer} bufA
 * @param {Buffer} bufB
 * @param {import('./embedding.js').EmbeddingProvider} provider
 * @returns {number}
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
 * @param {string} dateStr
 * @param {Date} now
 * @returns {number}
 */
export function daysBetween(dateStr, now) {
  return Math.max(0, (now.getTime() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * @param {string | null | undefined} str
 * @param {*} [fallback=null]
 * @returns {*}
 */
export function safeJsonParse(str, fallback = null) {
  if (!str) return fallback;
  try { return JSON.parse(str); }
  catch { return fallback; }
}
