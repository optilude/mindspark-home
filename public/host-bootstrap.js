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
  let currentFolder = null, account, navigation;
  const tags = new Map();
  const folderAssignments = new Map();
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
  async function library() {
    return (await request('/api/library', { headers: { 'X-Workspace-Id': workspaceId } })).json();
  }
  function showContext(data, folder) {
    HomeNavigation.chain(data.folders, folder);
    currentFolder = folder;
    if (!navigation) {
      navigation = document.createElement('nav');
      navigation.id = 'home-navigation';
      navigation.setAttribute('aria-label', 'Workspace navigation');
      navigation.innerHTML = '<a id="home-back">Back to folders</a><span id="home-path"></span><span id="home-account"></span>';
      document.body.prepend(navigation);
    }
    document.getElementById('home-back').href = HomeNavigation.folderUrl(folder);
    HomeNavigation.breadcrumbs(document.getElementById('home-path'), data.folders, folder);
    document.getElementById('home-account').textContent = account.username;
    const url = new URL(location.href);
    if (folder) url.searchParams.set('folder', folder); else url.searchParams.delete('folder');
    window.history.replaceState(null, '', url);
  }
  const store = {
    async list() {
      const data = await library();
      showContext(data, currentFolder);
      const ids = new Set(data.maps.filter(m => m.folder === currentFolder).map(m => m.id));
      return (await (await request('./api/maps')).json()).filter(m => ids.has(m.id));
    },
    async get(id) {
      const response = await request('./api/maps/' + encodeURIComponent(id));
      tags.set(id, response.headers.get('etag'));
      const data = await library(), entry = data.maps.find(m => m.id === id);
      if (!entry) throw new Error('Map no longer exists in your library.');
      showContext(data, entry.folder);
      return response.json();
    },
    async save(map) {
      const folder = currentFolder;
      const body = JSON.stringify(map);
      const tag = tags.get(map.id);
      if (!tag && folder) folderAssignments.set(map.id, folder);
      const response = await request('./api/maps/' + encodeURIComponent(map.id), {
        method: 'PUT', body,
        keepalive: new Blob([body]).size < 60000,
        headers: tag ? { 'If-Match': tag } : { 'If-None-Match': '*' },
      });
      tags.set(map.id, response.headers.get('etag'));
      if (folderAssignments.has(map.id)) {
        await request('/api/library/maps/' + encodeURIComponent(map.id) + '/folder', {
          method: 'PATCH', body: JSON.stringify({ folder: folderAssignments.get(map.id) }),
        });
        folderAssignments.delete(map.id);
      }
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
    account = user;
    const data = await library(), params = new URLSearchParams(location.search);
    const mapId = params.get('map'), entry = mapId ? data.maps.find(m => m.id === mapId) : null;
    if (mapId && !entry) throw new Error('Map not found in your library.');
    showContext(data, entry ? entry.folder : params.get('folder') || null);
  }
  return { store, ready, onError, shareBase: location.origin + '/' };
})();
