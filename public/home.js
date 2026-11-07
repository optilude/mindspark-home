'use strict';
const $ = id => document.getElementById(id);
let user, library, current;
const allMaps = Symbol('all');
current = allMaps;
function message(error) { $('message').textContent = error.message; console.error(error); }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': user?.csrf || '',
      'X-Workspace-Id': user?.id || '', ...options.headers } });
  const json = (response.headers.get('content-type') || '').includes('application/json');
  const data = response.status === 204 || !json ? null : await response.json();
  if (!response.ok) {
    if (response.status === 401 && user) {
      user = null;
      showLogin();
    }
    throw new Error(data?.error || 'Request failed (HTTP ' + response.status + '). Check the server/proxy.');
  }
  if (!json && response.status !== 204) throw new Error('Server/proxy returned an unexpected response.');
  return data;
}
function act(fn) {
  return async event => {
    const button = event?.currentTarget;
    if (button?.tagName === 'BUTTON') button.disabled = true;
    $('message').textContent = '';
    try { await fn(event); } catch (error) { message(error); }
    finally { if (button?.tagName === 'BUTTON') button.disabled = false; }
  };
}
function showLogin() {
  $('login').hidden = false; $('library').hidden = true;
  $('logout').hidden = $('password').hidden = true; $('identity').textContent = '';
}
function button(text, fn) {
  const element = document.createElement('button');
  element.textContent = text;
  element.onclick = act(fn);
  return element;
}
function pathFor(id) {
  const parts = [], seen = new Set();
  while (id) {
    if (seen.has(id)) throw new Error('Invalid folder hierarchy.');
    seen.add(id);
    const folder = library.folders.find(f => f.id === id);
    if (!folder) throw new Error('Folder not found.');
    parts.unshift(folder.name);
    id = folder.parent;
  }
  return '/' + parts.join('/');
}
function choose(id) { current = id; render(); }
function render() {
  if (current !== allMaps && current !== null && !library.folders.some(f => f.id === current)) current = null;
  $('location').textContent = current === allMaps ? 'All maps' : current === null ? 'Unfiled / root folders' : pathFor(current);
  for (const id of ['renameFolder', 'moveFolder', 'deleteFolder']) $(id).hidden = current === allMaps || current === null;
  const tree = (parent, ancestors = new Set()) => {
    const ul = document.createElement('ul');
    for (const folder of library.folders.filter(f => f.parent === parent)) {
      if (ancestors.has(folder.id)) throw new Error('Invalid folder hierarchy.');
      const li = document.createElement('li'), item = button(folder.name, () => choose(folder.id));
      if (folder.id === current) item.setAttribute('aria-current', 'page');
      li.append(item, tree(folder.id, new Set([...ancestors, folder.id])));
      ul.append(li);
    }
    return ul;
  };
  $('folders').replaceChildren(tree(null));
  $('subfolders').replaceChildren();
  if (current !== allMaps)
    for (const folder of library.folders.filter(f => f.parent === current))
      $('subfolders').append(button('Folder: ' + folder.name, () => choose(folder.id)), document.createTextNode(' '));
  $('maps').replaceChildren();
  const maps = library.maps.filter(m => current === allMaps || m.folder === current);
  for (const map of maps) {
    const li = document.createElement('li'), link = document.createElement('a'), time = document.createElement('time');
    link.href = `/w/${user.id}/?map=${encodeURIComponent(map.id)}`;
    link.textContent = map.title;
    time.dateTime = new Date(map.updated).toISOString();
    time.textContent = new Date(map.updated).toLocaleString();
    li.append(link, time, button('Move', () => moveMap(map)), button('Delete', async () => {
      await form('Delete map', [{ name: 'confirm', label: `Type DELETE to permanently delete "${map.title}" and its history.` }], async values => {
        if (values.confirm !== 'DELETE') throw new Error('Type DELETE to confirm.');
        await api(`/w/${user.id}/api/maps/${map.id}`, { method: 'DELETE' }); await refresh();
      });
    }));
    if (current === allMaps) {
      const location = document.createElement('small');
      location.textContent = map.folder ? pathFor(map.folder) : 'Unfiled';
      li.append(location);
    }
    $('maps').append(li);
  }
  if (!maps.length) $('maps').textContent = 'No maps here yet.';
}
async function refresh() {
  library = await api('/api/library');
  $('login').hidden = true; $('library').hidden = false;
  $('logout').hidden = $('password').hidden = false; $('identity').textContent = user.username;
  render();
}
function destinations(exclude) {
  const blocked = new Set(exclude ? [exclude] : []);
  let changed;
  do {
    changed = false;
    for (const folder of library.folders)
      if (blocked.has(folder.parent) && !blocked.has(folder.id)) { blocked.add(folder.id); changed = true; }
  } while (changed);
  return [{ value: '', label: 'Root / Unfiled' },
    ...library.folders.filter(f => !blocked.has(f.id)).map(f => ({ value: f.id, label: pathFor(f.id) }))];
}
function form(title, fields, submit) {
  $('dialogTitle').textContent = title; $('dialogError').textContent = ''; $('fields').replaceChildren();
  for (const spec of fields) {
    const label = document.createElement('label');
    label.textContent = spec.label;
    const input = document.createElement(spec.options ? 'select' : 'input');
    input.name = spec.name;
    if (spec.options) {
      for (const option of spec.options) {
        const element = document.createElement('option');
        element.value = option.value; element.textContent = option.label; input.append(element);
      }
    } else { input.type = spec.type || 'text'; input.required = true; input.autocomplete = spec.autocomplete || 'off'; }
    input.value = spec.value || '';
    label.append(input); $('fields').append(label);
  }
  $('dialogForm').onsubmit = async event => {
    event.preventDefault(); $('submit').disabled = true; $('dialogError').textContent = '';
    try { await submit(Object.fromEntries(new FormData(event.currentTarget))); $('dialog').close(); }
    catch (error) { $('dialogError').textContent = error.message; console.error(error); }
    finally { $('submit').disabled = false; }
  };
  $('dialog').showModal();
}
function moveMap(map) {
  return form('Move map', [{ name: 'folder', label: 'Destination folder', options: destinations(), value: map.folder }],
    async values => { await api(`/api/library/maps/${map.id}/folder`, { method: 'PATCH', body: JSON.stringify({ folder: values.folder || null }) }); await refresh(); });
}
$('cancel').onclick = () => $('dialog').close();
$('all').onclick = () => choose(allMaps);
$('root').onclick = () => choose(null);
$('refresh').onclick = act(refresh);
$('newFolder').onclick = act(() => form('New folder', [{ name: 'name', label: 'Folder name' }],
  async values => { await api('/api/folders', { method: 'POST', body: JSON.stringify({ name: values.name, parent: current === allMaps ? null : current }) }); await refresh(); }));
$('renameFolder').onclick = act(() => form('Rename folder', [{ name: 'name', label: 'Folder name', value: library.folders.find(f => f.id === current).name }],
  async values => { await api('/api/folders/' + current, { method: 'PATCH', body: JSON.stringify(values) }); await refresh(); }));
$('moveFolder').onclick = act(() => form('Move folder', [{ name: 'parent', label: 'Destination', options: destinations(current) }],
  async values => { await api('/api/folders/' + current, { method: 'PATCH', body: JSON.stringify({ parent: values.parent || null }) }); await refresh(); }));
$('deleteFolder').onclick = act(() => form('Delete empty folder', [{ name: 'confirm', label: 'Type DELETE to confirm. Non-empty folders cannot be deleted.' }],
  async values => { if (values.confirm !== 'DELETE') throw new Error('Type DELETE to confirm.'); await api('/api/folders/' + current, { method: 'DELETE' }); current = null; await refresh(); }));
$('newMap').onclick = act(() => form('New map', [{ name: 'title', label: 'Map title' }], async values => {
  const id = crypto.randomUUID(), rootId = crypto.randomUUID();
  const map = { id, title: values.title, rootId, color: '#e0613a',
    nodes: { [rootId]: { id: rootId, parent: null, text: values.title, x: 0, y: 0, side: 'root', color: '#fff' } }, links: [] };
  await api(`/w/${user.id}/api/maps/${id}`, { method: 'PUT', headers: { 'If-None-Match': '*' }, body: JSON.stringify(map) });
  if (current !== allMaps && current !== null) {
    try { await api(`/api/library/maps/${id}/folder`, { method: 'PATCH', body: JSON.stringify({ folder: current }) }); }
    catch (error) { await refresh(); throw new Error('Map was created in Unfiled, but could not be moved: ' + error.message); }
  }
  location.href = `/w/${user.id}/?map=${id}`;
}));
$('logout').onclick = act(async () => { await api('/api/logout', { method: 'POST' }); user = null; showLogin(); });
$('password').onclick = act(() => form('Change password (signs out all sessions)', [
  { name: 'current', label: 'Current password', type: 'password', autocomplete: 'current-password' },
  { name: 'password', label: 'New password (at least 8 characters)', type: 'password', autocomplete: 'new-password' },
], async values => { await api('/api/password', { method: 'POST', body: JSON.stringify(values) }); user = null; showLogin(); }));
async function signedIn() {
  user = await api('/api/session');
  if (location.hash.startsWith('#view=')) {
    location.replace(`/w/${user.id}/${location.hash}`);
    return;
  }
  await refresh();
}
$('login').onsubmit = act(async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const input = Object.fromEntries(new FormData(form));
  await api('/api/login', { method: 'POST', body: JSON.stringify(input) });
  form.reset();
  await signedIn();
});
(async () => {
  const response = await fetch('/api/session', { cache: 'no-store' });
  if (response.status === 401) { showLogin(); return; }
  if (!response.ok) throw new Error('Could not check your session. Refresh or check the server logs.');
  user = await response.json();
  await signedIn();
})().catch(message);
