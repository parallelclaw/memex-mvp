/**
 * Nexara transcription — POST /audio/transcriptions.
 *
 * Endpoint: https://api.nexara.ru/api/v1/audio/transcriptions
 * Auth:     Authorization: Bearer <key>
 *
 * Telegram voice messages arrive as audio/ogg (Opus). Nexara's docs note
 * that ogg/opus may need ffmpeg conversion to mp3 first; this implementation
 * sends the raw OGG. If transcription fails on a particular file, install
 * ffmpeg and we can add a conversion step later.
 */

const ENDPOINT = 'https://api.nexara.ru/api/v1/audio/transcriptions';

/**
 * @param {object} opts
 * @param {Buffer|Uint8Array} opts.audioBuffer
 * @param {string} opts.apiKey
 * @param {string} [opts.filename='voice.oga']
 * @param {string} [opts.mimeType='audio/ogg']
 * @param {string} [opts.language='ru']
 * @returns {Promise<{ text: string, duration?: number, language?: string, raw: object }>}
 */
export async function transcribe({
  audioBuffer,
  apiKey,
  filename = 'voice.oga',
  mimeType = 'audio/ogg',
  language = 'ru',
}) {
  if (!apiKey) throw new Error('nexara: apiKey required');
  if (!audioBuffer) throw new Error('nexara: audioBuffer required');

  const blob = new Blob([audioBuffer], { type: mimeType });
  const form = new FormData();
  form.append('file', blob, filename);
  form.append('response_format', 'verbose_json');
  form.append('language', language);

  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(120000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`nexara HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const json = await resp.json();
  if (!json || typeof json.text !== 'string') {
    throw new Error('nexara: response missing .text field');
  }
  return {
    text: json.text.trim(),
    duration: typeof json.duration === 'number' ? json.duration : undefined,
    language: typeof json.language === 'string' ? json.language : undefined,
    raw: json,
  };
}
