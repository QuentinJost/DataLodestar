// Commit / Rollback bar of the results and table webviews, shown while the connection has pending changes.
(function () {
  /** state: { pending, redis, connection } from the extension; send(type) posts 'commit' or 'rollback'. */
  function update(bar, state, send) {
    bar.classList.toggle('hidden', !state.pending);
    bar.replaceChildren();
    if (!state.pending) return;
    const label = document.createElement('span');
    label.textContent = state.redis ? `MULTI open on ${state.connection}` : `Uncommitted changes on ${state.connection}`;
    const button = (text, type, secondary) => {
      const b = document.createElement('button');
      b.textContent = text;
      if (secondary) b.className = 'secondary';
      // Disabled until the extension sends the new state: one click, one commit.
      b.addEventListener('click', () => {
        bar.querySelectorAll('button').forEach((x) => (x.disabled = true));
        send(type);
      });
      return b;
    };
    bar.append(label, button(state.redis ? 'EXEC' : 'Commit', 'commit'), button(state.redis ? 'DISCARD' : 'Rollback', 'rollback', true));
  }

  window.SqlTxBar = { update };
})();
