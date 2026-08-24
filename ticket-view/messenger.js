// ============================================================
// GigaHelpDesk Bubble — Messenger-style ticket view
// Injected at runtime (see main.js -> injectMessengerUI) into the
// real ticket page loaded in the embedded BrowserView. Nothing here
// talks to a different backend or changes what data exists — it only
// re-lays-out the DOM that the site itself already rendered, and
// relies on messenger.css (inserted alongside this) for the visuals.
//
// Safe by construction:
//  - Only activates on /admin/tickets/<id> detail pages.
//  - Moves existing DOM nodes (appendChild/insertBefore), never
//    innerHTML-clones them, so all the site's own event listeners,
//    jQuery/select2 bindings, and form actions keep working.
//  - Nothing is deleted. Sections that look "removed" are only
//    collapsed (max-height:0 / width:0) behind a toggle, or hidden
//    only when confirmed genuinely empty ("No initial details...").
//  - A "Classic View" button flips ghz-messenger-view off instantly
//    if anything looks wrong, no reload needed.
// ============================================================
(function () {
  if (!/^\/admin\/tickets\/\d+/.test(window.location.pathname)) return;
  if (window.__ghzMessengerInit) return;
  window.__ghzMessengerInit = true;

  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function byTitle(cards, needle) {
    return cards.find(c => {
      const t = c.querySelector(':scope > .card-header .card-title');
      return t && t.textContent.trim().toLowerCase().includes(needle);
    });
  }

  function build() {
    const html = document.documentElement;
    const containerFluid = document.querySelector('.content-wrapper .container-fluid');
    if (!containerFluid) return; // page shape not what we expect — leave it alone

    const rows = $$(':scope > .row', containerFluid);
    const infoRow1 = rows.find(r => r.querySelector('.ticket-info-card'));
    const infoRow2 = rows.find(r => r.querySelector('.ticket-sla-kpi-card'));
    const chatRow = rows.find(r => r.querySelector('.ticket-sidebar-card'));
    if (!chatRow) return; // couldn't find the conversation row — bail out safely

    const chatMain = chatRow.querySelector(':scope > [class*="col-lg-8"]') || chatRow.children[0];
    const chatSidebar = chatRow.querySelector('.ticket-sidebar-card')
      ? chatRow.querySelector('.ticket-sidebar-card').closest('[class*="col-lg-4"]')
      : null;

    // ---- Toolbar (built once, inserted right after the sticky header) ----
    const toolbar = document.createElement('div');
    toolbar.className = 'ghz-toolbar';

    function makeToggle(label, countText) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghz-toggle-btn';
      b.innerHTML = label + (countText != null ? ' <span class="ghz-count">' + countText + '</span>' : '');
      return b;
    }

    // -- Ticket Info / SLA drawer (open by default — the panel is sized
    //    with this content in mind, so leaving it collapsed just leaves
    //    blank space) --
    if (infoRow1 || infoRow2) {
      const infoWrap = document.createElement('div');
      infoWrap.className = 'ghz-info-rows';
      const anchor = infoRow1 || infoRow2;
      anchor.parentNode.insertBefore(infoWrap, anchor);
      if (infoRow1) infoWrap.appendChild(infoRow1);
      if (infoRow2) infoWrap.appendChild(infoRow2);

      const infoBtn = makeToggle('&#128203; Ticket / Requester / SLA Info');
      infoBtn.addEventListener('click', function () {
        const open = infoWrap.classList.toggle('ghz-open');
        infoBtn.classList.toggle('ghz-active', open);
      });
      toolbar.appendChild(infoBtn);
    }

    // -- Route/SLA & History drawer (open by default, same reasoning) --
    if (chatSidebar) {
      chatSidebar.classList.add('ghz-chat-sidebar');
      const sideBtn = makeToggle('&#128272; Route / SLA & History');
      sideBtn.addEventListener('click', function () {
        const open = chatSidebar.classList.toggle('ghz-open');
        sideBtn.classList.toggle('ghz-active', open);
      });
      toolbar.appendChild(sideBtn);
    }

    if (chatMain) chatMain.classList.add('ghz-chat-main');
    chatRow.classList.add('ghz-chat-row');

    // -- Cards inside the main column: Conversation / Add Comment / Files --
    const cardsInMain = chatMain ? $$(':scope > .card', chatMain) : [];
    const conversationCard = byTitle(cardsInMain, 'conversation');
    const composerCard = byTitle(cardsInMain, 'add comment');
    const filesCard = byTitle(cardsInMain, 'files attached');

    let conversationBody = null;
    if (conversationCard) {
      conversationCard.classList.add('ghz-conversation-card');
      conversationBody = conversationCard.querySelector(':scope > .card-body');
      if (conversationBody) conversationBody.classList.add('ghz-conversation-body');

      // The requester's opening message reads as the first chat bubble.
      const originalAlert = conversationCard.querySelector('.alert.alert-light.border');
      if (originalAlert) originalAlert.classList.add('ghz-original-request');

      // "Initial Details" nested card — hide only if genuinely empty.
      const initialDetailsCard = conversationCard.querySelector('.card.border.mb-3');
      if (initialDetailsCard && /no initial details were submitted/i.test(initialDetailsCard.textContent)) {
        initialDetailsCard.style.display = 'none';
      }
    }
    if (composerCard) composerCard.classList.add('ghz-composer-card');

    if (filesCard) {
      filesCard.classList.add('ghz-files-card');
      const countBadge = filesCard.querySelector('.card-header .badge');
      const filesBtn = makeToggle('&#128206; Files', countBadge ? countBadge.textContent.trim() : '0');
      filesBtn.addEventListener('click', function () {
        const open = filesCard.classList.toggle('ghz-open');
        filesBtn.classList.toggle('ghz-active', open);
      });
      toolbar.appendChild(filesBtn);
    }

    toolbar.appendChild(document.createElement('span')).className = 'ghz-toolbar-spacer';
    const classicBtn = document.createElement('button');
    classicBtn.type = 'button';
    classicBtn.className = 'ghz-toggle-btn ghz-classic-btn';
    classicBtn.textContent = 'Classic View';
    classicBtn.title = 'Switch back to the site\'s normal layout';
    classicBtn.addEventListener('click', function () {
      const isMessenger = html.classList.toggle('ghz-messenger-view');
      classicBtn.textContent = isMessenger ? 'Classic View' : 'Chat View';
    });
    toolbar.appendChild(classicBtn);

    const summaryCard = document.querySelector('.admin-ticket-summary-card');
    (summaryCard ? summaryCard.parentNode : containerFluid).insertBefore(
      toolbar,
      summaryCard ? summaryCard.nextSibling : containerFluid.firstChild
    );

    // ---- Group consecutive messages from the same sender (Messenger-style) ----
    function regroup() {
      if (!conversationBody) return;
      const items = $$('.ticket-thread-item', conversationBody);
      let prevKey = null;
      items.forEach(item => {
        const isSystem = item.classList.contains('is-system');
        const dir = item.classList.contains('is-outgoing') ? 'out' : 'in';
        const name = (item.querySelector('.ticket-thread-name') || {}).textContent || '';
        const key = isSystem ? null : dir + '|' + name.trim();
        if (!isSystem && key && key === prevKey) {
          item.classList.add('ghz-grouped');
        } else {
          item.classList.remove('ghz-grouped');
        }
        prevKey = isSystem ? null : key;
      });
    }
    regroup();

    // ---- Keep the latest message in view, including live-polled ones ----
    function scrollToBottom() {
      if (conversationBody) conversationBody.scrollTop = conversationBody.scrollHeight;
    }
    scrollToBottom();

    const threadContainer = document.querySelector('[data-ticket-conversation]');
    if (threadContainer && 'MutationObserver' in window) {
      const obs = new MutationObserver(() => { regroup(); scrollToBottom(); });
      obs.observe(threadContainer, { childList: true });
    }

    html.classList.add('ghz-messenger-view');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
