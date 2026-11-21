(function (root) {
  'use strict';

  // Shared desktop/Web table. The established Lite table is the visual source;
  // availability and queue adoption still use Pro's strict per-file policy.
  function render(view, host, { choice, adopt, check, changed, formatBytes }) {
    const model = root.BioProjectView;
    const policy = root.BioProjectSources;
    function node(tag, text) {
      const element = document.createElement(tag);
      if (text !== undefined) element.textContent = text;
      return element;
    }
    function button(text, action, disabled, className = 'project-check') {
      const element = node('button', text);
      element.type = 'button';
      element.className = 'btn btn-sm ' + className;
      element.disabled = Boolean(disabled);
      element.onclick = action;
      return element;
    }

    const table = node('table');
    table.className = 'project-table' + (view.human ? ' hra-files' : '');
    const head = node('thead');
    const headings = node('tr');
    headings.appendChild(node('th', view.human ? '文件' : 'Run 编号'));
    for (const column of view.columns) {
      const heading = node('th', column.label);
      heading.scope = 'col';
      headings.appendChild(heading);
    }
    head.appendChild(headings);
    table.appendChild(head);

    const body = node('tbody');
    for (const row of model.visible(view)) {
      const tr = node('tr');
      const identity = node('td');
      const label = node('label');
      const checkbox = node('input');
      checkbox.type = 'checkbox';
      checkbox.checked = row.checked;
      checkbox.setAttribute('aria-label', '选择 ' + row.key);
      checkbox.onchange = () => {
        row.checked = checkbox.checked;
        model.sync(view);
        changed();
      };
      const filename = node('span', view.human ? view.files.get(row.indices[0]).file.name : row.key);
      filename.className = 'project-filename';
      filename.title = filename.textContent;
      label.append(checkbox, filename);
      identity.appendChild(label);
      if (view.human) identity.appendChild(node('small', view.files.get(row.indices[0]).file.run));
      if (row.indices.some(index => view.files.get(index).manual)) identity.appendChild(button('恢复自动', () => {
        for (const index of row.indices) view.files.get(index).manual = '';
        changed();
      }, false, 'project-reset'));
      tr.appendChild(identity);

      for (const column of view.columns) {
        const cell = node('td');
        let any = false;
        let done = true;
        for (const index of row.indices) {
          const item = view.files.get(index);
          const sources = item.sources.filter(source => model.inColumn(view, source, column.id));
          done = done && item.checkedColumns.has(column.id);
          for (const source of sources) {
            any = true;
            const valid = policy.chooseProjectSource(item.file, [source]).source;
            const recommended = choice(item).source?.url === source.url;
            const prefix = item.manual === source.url ? '已手选 · ' : recommended ? '推荐 · ' : '';
            const protocol = new URL(source.url).protocol.slice(0, -1).toUpperCase();
            const mate = /_([12])\.(?:fastq|fq)\.gz$/i.exec(item.file.name)?.[1];
            const caption = (valid ? `${protocol} · ${item.file.format.toUpperCase()}` : `${protocol} · ${source.pending ? '待核验' : '未通过'}`) + (mate ? ` · R${mate}` : '');
            const pick = button(prefix + caption, () => {
              // A Run's manually selected format wins over earlier format choices.
              for (const other of row.indices) {
                const previous = view.files.get(other);
                if (previous.file.format !== item.file.format) previous.manual = '';
              }
              item.manual = source.url;
              changed();
            }, !valid, 'project-adopt');
            pick.title = [item.file.name, source.url, source.reason, item.note, item.file.md5 && 'MD5 ' + item.file.md5]
              .filter(Boolean).join('\n');
            cell.appendChild(pick);
            if (valid) {
              const timing = node('small', `${formatBytes(source.size)} · ${source.latencyMs} ms`);
              timing.className = 'project-timing';
              cell.appendChild(timing);
            }
          }
        }
        if (!any) {
          cell.textContent = done ? '未获文件' : '待核验';
          cell.className = 'project-state-pending';
          cell.title = row.indices.map(index => view.files.get(index).note).filter(Boolean).join('\n');
        }
        tr.appendChild(cell);
      }
      body.appendChild(tr);
    }
    table.appendChild(body);

    const foot = node('tfoot');
    const actions = node('tr');
    const automatic = node('td');
    actions.appendChild(automatic);
    for (const column of view.columns) {
      const cell = node('td');
      cell.className = 'project-column-actions';
      const completed = view.rows.filter(row => row.indices.length && row.indices.every(index => view.files.get(index).checkedColumns.has(column.id))).length;
      const usable = view.rows.filter(row => row.checked && model.columnItems(view, row, column.id, choice).length).length;
      const stats = node('div', `${view.recommended === column.id ? '推荐 · ' : ''}已核 ${completed}/${view.rows.length}`);
      stats.className = 'project-stats';
      if (view.recommended === column.id) stats.title = '依据首 Run 完整文件组中最慢文件的响应时间推荐；响应时间不等于下载吞吐。';
      cell.appendChild(stats);
      cell.appendChild(button('校验全部', () => check(column.id, false), !!view.terminal || view.loading));
      cell.appendChild(button(`加入队列 (${usable} ${view.human ? '文件' : 'Run'})`, () => adopt(column.id), !!view.terminal || view.loading || !usable, 'project-adopt'));
      actions.appendChild(cell);
    }
    foot.appendChild(actions);
    table.appendChild(foot);
    actions.className = 'project-actions-row';
    host.replaceChildren(table);
  }

  root.BioProjectTable = { render };
})(typeof globalThis !== 'undefined' ? globalThis : this);
