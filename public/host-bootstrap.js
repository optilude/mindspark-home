'use strict';

function scopedStorage(kind, prefix) {
  const keys = () => {
    const storage = window[kind], out = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key.startsWith(prefix)) out.push(key.slice(prefix.length));
    }
    return out;
  };
  return {
    getItem(key) { return window[kind].getItem(prefix + key); },
    setItem(key, value) { window[kind].setItem(prefix + key, value); },
    removeItem(key) { window[kind].removeItem(prefix + key); },
    clear() { for (const key of keys()) this.removeItem(key); },
    key(index) { return keys()[index] ?? null; },
    get length() { return keys().length; },
  };
}
// Classic-script lexical bindings scope all existing editor storage calls,
// including its inline pre-paint script, without replacing browser APIs.
const workspaceId = location.pathname.split('/')[2];
const localStorage = scopedStorage('localStorage', 'mindspark-home:' + workspaceId + ':');
const sessionStorage = scopedStorage('sessionStorage', 'mindspark-home:' + workspaceId + ':');

window.MINDSPARK_HOST = (() => {
  let csrf;
  const tags = new Map();
  function onError(error) {
    console.error('MindSpark Home:', error);
    const show = () => {
      let banner = document.getElementById('home-error');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'home-error';
        banner.setAttribute('role', 'alert');
        Object.assign(banner.style, { position: 'fixed', bottom: '8px', left: '8px', right: '8px',
          zIndex: '100000', background: '#7e2020', color: 'white', padding: '12px', borderRadius: '8px' });
        document.body.append(banner);
      }
      banner.replaceChildren(document.createTextNode(error.message + ' '));
      const link = document.createElement('a');
      link.href = '/';
      link.textContent = 'Sign in / Library';
      link.style.color = 'white';
      banner.append(link);
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
  }
  async function request(path, options = {}) {
    try {
      const response = await fetch(path, {
        ...options, cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf || '', ...options.headers },
      });
      if (!response.ok) {
        const json = (response.headers.get('content-type') || '').includes('application/json');
        const data = json ? await response.json() : null;
        const error = new Error(data?.error || 'Request failed (HTTP ' + response.status + '). Check the server/proxy and export unsaved edits.');
        if (response.status === 412) error.conflict = true;
        throw error;
      }
      return response;
    } catch (error) { onError(error); throw error; }
  }
  const store = {
    async list() { return (await request('./api/maps')).json(); },
    async get(id) {
      const response = await request('./api/maps/' + encodeURIComponent(id));
      tags.set(id, response.headers.get('etag'));
      return response.json();
    },
    async save(map) {
      const body = JSON.stringify(map);
      const tag = tags.get(map.id);
      const response = await request('./api/maps/' + encodeURIComponent(map.id), {
        method: 'PUT', body,
        keepalive: new Blob([body]).size < 60000,
        headers: tag ? { 'If-Match': tag } : { 'If-None-Match': '*' },
      });
      tags.set(map.id, response.headers.get('etag'));
    },
    async remove(id) { await request('./api/maps/' + encodeURIComponent(id), { method: 'DELETE' }); },
    async history(id) { return (await request('./api/maps/' + encodeURIComponent(id) + '/versions')).json(); },
    async version(id, ts) { return (await request('./api/maps/' + encodeURIComponent(id) + '/versions/' + ts)).json(); },
  };
  async function ready() {
    const response = await request('/api/session');
    const user = await response.json();
    if (user.id !== workspaceId) throw new Error('Account changed. Export any edits and return to your library.');
    csrf = user.csrf;
    await store.list();
    const link = document.createElement('a');
    link.href = '/library';
    link.textContent = 'Library / ' + user.username;
    link.title = 'Manage folders, account and maps';
    Object.assign(link.style, { display: 'block', padding: '8px 0', fontWeight: '600' });
    document.querySelector('.side-foot').prepend(link);
  }
  return { store, ready, onError, shareBase: location.origin + '/' };
})();
