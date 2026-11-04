import {productText} from '../shared/product-text.mjs';

/** HTTP LAN pages may not expose randomUUID; getRandomValues remains available. */
export function newRequestId(cryptoSource = globalThis.crypto) {
  if (typeof cryptoSource?.randomUUID === 'function') return cryptoSource.randomUUID();
  if (typeof cryptoSource?.getRandomValues !== 'function') throw new Error('当前浏览器不支持安全的请求编号，请更换浏览器。');
  const bytes = cryptoSource.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 8)+'-'+hex.slice(8, 12)+'-'+hex.slice(12, 16)+'-'+hex.slice(16, 20)+'-'+hex.slice(20);
}

export function clientFetch(path, options = {}) {
  const base = globalThis.location?.origin || 'http://localhost';
  const url = new URL(path, base);
  if (url.origin !== base || !url.pathname.startsWith('/api/')) throw new Error('只能访问当前 MioBot 后台。');
  const headers = new Headers(options.headers || {});
  headers.set('X-Personal-Agent', '1');
  if (options.body !== undefined && !(globalThis.FormData && options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(url.pathname + url.search, {...options, credentials: 'same-origin', headers});
}

export async function api(path, method = 'GET', body, requestOptions = {}) {
  const response = await clientFetch('/api' + path, {...requestOptions, method, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  let value;
  try { value = await response.json(); }
  catch { throw Object.assign(new Error('后台没有返回有效结果，请重新连接。'), {status: response.status, code: 'INVALID_RESPONSE'}); }
  if (!response.ok) {
    const detail = value?.error;
    const error = new Error(productText(typeof detail === 'string' ? detail : detail?.message || '操作未完成'));
    error.status = response.status; error.code = value?.code || detail?.code;
    throw error;
  }
  return value;
}
