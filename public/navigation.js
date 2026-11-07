'use strict';
const HomeNavigation = {
  folderUrl(id) { return '/library' + (id ? '?folder=' + encodeURIComponent(id) : ''); },
  chain(folders, id) {
    const chain = [{ id: null, name: 'My maps' }], seen = new Set(), parents = [];
    while (id) {
      if (seen.has(id)) throw new Error('Invalid folder hierarchy.');
      seen.add(id);
      const folder = folders.find(f => f.id === id);
      if (!folder) throw new Error('Folder not found.');
      parents.unshift(folder);
      id = folder.parent;
    }
    return chain.concat(parents);
  },
  breadcrumbs(element, folders, id) {
    element.replaceChildren();
    for (const folder of this.chain(folders, id)) {
      if (element.childNodes.length) element.append(document.createTextNode(' / '));
      const link = document.createElement('a');
      link.href = this.folderUrl(folder.id);
      link.textContent = folder.name;
      if (folder.id === id) link.setAttribute('aria-current', 'page');
      element.append(link);
    }
  },
};
