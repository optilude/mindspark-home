'use strict';
const $ = id => document.getElementById(id);
let user, library;
let current = new URLSearchParams(location.search).get('folder') || null;
const collapsed = new Set();
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
  return HomeNavigation.chain(library.folders, id).map(f => f.name).join(' / ');
}
function choose(id) {
  current = id;
  for (const folder of HomeNavigation.chain(library.folders, id)) if (folder.id !== id) collapsed.delete(folder.id);
  history.pushState(null, '', HomeNavigation.folderUrl(id));
  render();
}
function icon(kind) {
  const element = document.createElement('span');
  element.className = kind + '-icon';
  element.setAttribute('aria-hidden', 'true');
  return element;
}
function folderMenu(folder) {
  return menu(folder.name, [
    ['New subfolder', () => newFolder(folder.id)],
    ['Rename', () => form('Rename folder', [{ name: 'name', label: 'Folder name', value: folder.name }],
      async values => { await api('/api/folders/' + folder.id, { method: 'PATCH', body: JSON.stringify(values) }); await refresh(); })],
    ['Move', () => form('Move folder', [{ name: 'parent', label: 'Destination', options: destinations(folder.id), value: folder.parent }],
      async values => { await api('/api/folders/' + folder.id, { method: 'PATCH', body: JSON.stringify({ parent: values.parent || null }) }); await refresh(); })],
    ['Delete', () => form('Delete empty folder', [{ name: 'confirm', label: 'Type DELETE to confirm. Non-empty folders cannot be deleted.' }],
      async values => { if (values.confirm !== 'DELETE') throw new Error('Type DELETE to confirm.'); await api('/api/folders/' + folder.id, { method: 'DELETE' }); await refresh(); })],
  ]);
}
function menu(name, actions) {
  const details = document.createElement('details'), summary = document.createElement('summary'), items = document.createElement('div');
  details.className = 'item-menu';
  summary.textContent = '...';
  summary.setAttribute('aria-label', 'Actions for ' + name);
  items.className = 'menu-items';
  for (const [label, fn] of actions) items.append(button(label, () => { details.open = false; return fn(); }));
  details.append(summary, items);
  details.addEventListener('toggle', () => {
    if (details.open) for (const other of document.querySelectorAll('.item-menu')) if (other !== details) other.open = false;
  });
  return details;
}
function render() {
  if (current && !library.folders.some(f => f.id === current)) {
    current = null;
    history.replaceState(null, '', HomeNavigation.folderUrl(null));
  }
  HomeNavigation.breadcrumbs($('breadcrumbs'), library.folders, current);
  $('location').textContent = current ? library.folders.find(f => f.id === current).name : 'My maps';
  const tree = (parent, ancestors = new Set()) => {
    const ul = document.createElement('ul');
    for (const folder of library.folders.filter(f => f.parent === parent)) {
      if (ancestors.has(folder.id)) throw new Error('Invalid folder hierarchy.');
      const li = document.createElement('li'), row = document.createElement('div'), item = button(folder.name, () => choose(folder.id));
      row.className = 'tree-row';
      item.className = 'folder-name';
      item.prepend(icon('folder'));
      if (folder.id === current) item.setAttribute('aria-current', 'page');
      const children = tree(folder.id, new Set([...ancestors, folder.id]));
      const toggle = button('', () => {
        if (collapsed.has(folder.id)) collapsed.delete(folder.id); else collapsed.add(folder.id);
        render();
      });
      toggle.className = 'tree-toggle';
      toggle.setAttribute('aria-label', (collapsed.has(folder.id) ? 'Expand ' : 'Collapse ') + folder.name);
      toggle.setAttribute('aria-expanded', String(!collapsed.has(folder.id)));
      toggle.disabled = !children.childNodes.length;
      children.hidden = collapsed.has(folder.id);
      row.append(toggle, item, folderMenu(folder));
      li.append(row, children);
      ul.append(li);
    }
    return ul;
  };
  const root = button('My maps', () => choose(null));
  root.className = 'folder-name root-folder';
  root.prepend(icon('folder'));
  if (current === null) root.setAttribute('aria-current', 'page');
  $('folders').replaceChildren(root, tree(null));
  $('maps').replaceChildren();
  for (const folder of library.folders.filter(f => f.parent === current)) {
    const li = document.createElement('li'), open = button(folder.name, () => choose(folder.id));
    open.className = 'file-name';
    open.prepend(icon('folder'));
    li.append(open, document.createElement('span'), folderMenu(folder));
    $('maps').append(li);
  }
  const maps = library.maps.filter(m => m.folder === current);
  for (const map of maps) {
    const li = document.createElement('li'), link = document.createElement('a'), time = document.createElement('time');
    link.href = `/w/${user.id}/?map=${encodeURIComponent(map.id)}` + (current ? '&folder=' + encodeURIComponent(current) : '');
    link.textContent = map.title;
    link.className = 'file-name';
    link.prepend(icon('map'));
    time.dateTime = new Date(map.updated).toISOString();
    time.textContent = new Date(map.updated).toLocaleString();
    li.append(link, time, menu(map.title, [['Move', () => moveMap(map)], ['Delete', async () => {
      await form('Delete map', [{ name: 'confirm', label: `Type DELETE to permanently delete "${map.title}" and its history.` }], async values => {
        if (values.confirm !== 'DELETE') throw new Error('Type DELETE to confirm.');
        await api(`/w/${user.id}/api/maps/${map.id}`, { method: 'DELETE' }); await refresh();
      });
    }]]));
    $('maps').append(li);
  }
  if (!$('maps').childNodes.length) $('maps').textContent = 'This folder is empty. Create a map or folder to get started.';
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
  return [{ value: '', label: 'My maps' },
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
window.addEventListener('popstate', () => { current = new URLSearchParams(location.search).get('folder') || null; if (library) render(); });
document.addEventListener('click', event => {
  for (const item of document.querySelectorAll('.item-menu')) if (!item.contains(event.target)) item.open = false;
});
document.addEventListener('contextmenu', event => {
  const item = event.target.closest('.tree-row, #maps li')?.querySelector('.item-menu');
  if (item) { event.preventDefault(); item.open = true; }
});
$('refresh').onclick = act(refresh);
function newFolder(parent) {
  return form('New folder', [{ name: 'name', label: 'Folder name' }],
    async values => { await api('/api/folders', { method: 'POST', body: JSON.stringify({ name: values.name, parent }) }); collapsed.delete(parent); await refresh(); });
}
$('newFolder').onclick = act(() => newFolder(current));
$('newMap').onclick = act(() => form('New map', [{ name: 'title', label: 'Map title' }], async values => {
  const id = crypto.randomUUID(), rootId = crypto.randomUUID();
  const map = { id, title: values.title, rootId, color: '#e0613a',
    nodes: { [rootId]: { id: rootId, parent: null, text: values.title, x: 0, y: 0, side: 'root', color: '#fff' } }, links: [] };
  await api(`/w/${user.id}/api/maps/${id}`, { method: 'PUT', headers: { 'If-None-Match': '*' }, body: JSON.stringify(map) });
  if (current !== null) {
    try { await api(`/api/library/maps/${id}/folder`, { method: 'PATCH', body: JSON.stringify({ folder: current }) }); }
    catch (error) { await refresh(); throw new Error('Map was created in My maps, but could not be moved: ' + error.message); }
  }
  location.href = `/w/${user.id}/?map=${id}` + (current ? '&folder=' + encodeURIComponent(current) : '');
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
