const DRAG_DISTANCE = 5;
const EDGE_SIZE = 56;
const SCROLL_SPEED = 1000;
const MOVE_TIMING = { duration: 150, easing: "cubic-bezier(.2,.7,.25,1)" };

// The floating card and gap are temporary DOM. The board commits the final
// move to Markdown once, after a pointer is released over a column.
export function bindBoardDrag(columns, moveCard) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const motions = new Map();
  let drag;
  let blockClick = false;

  columns.addEventListener("pointerdown", grab);
  columns.addEventListener("click", (event) => {
    if (blockClick && event.detail > 0) {
      event.preventDefault();
      event.stopPropagation();
      blockClick = false;
    }
  }, true);

  function grab(event) {
    if (drag || !event.isPrimary || event.button !== 0) return;
    blockClick = false;
    const card = event.target.closest(".board-card");
    const handle = event.target.closest(".board-card-grip");
    if (!card || event.target.closest("a, .board-card-delete") || (event.pointerType === "touch" && !handle)) return;

    drag = {
      id: event.pointerId,
      card,
      fromColumn: Number(card.closest(".board-column").dataset.column),
      fromCard: Number(card.dataset.card),
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      events: new AbortController(),
    };
    const { signal } = drag.events;
    window.addEventListener("pointermove", follow, { signal });
    window.addEventListener("pointerup", release, { signal });
    window.addEventListener("pointercancel", cancelPointer, { signal });
    columns.addEventListener("lostpointercapture", (event) => {
      // Touch starts with implicit capture on the grip. Its capture is
      // transferred to the board when the card is lifted.
      if (event.target === columns) cancelPointer(event);
    }, { signal });
    window.addEventListener("blur", cancelDrag, { signal });
    window.addEventListener("keydown", (key) => {
      if (key.key === "Escape") {
        key.preventDefault();
        cancelDrag();
      }
    }, { capture: true, signal });
  }

  function follow(event) {
    if (event.pointerId !== drag.id) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.preview) {
      if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < DRAG_DISTANCE) return;
      liftCard();
      draw();
    }
    event.preventDefault();
  }

  function liftCard() {
    const { card } = drag;
    const bounds = card.getBoundingClientRect();
    drag.offsetX = drag.startX - bounds.left;
    drag.offsetY = drag.startY - bounds.top;
    drag.preview = card.cloneNode(true);
    drag.preview.inert = true;
    drag.preview.classList.add("board-drag-preview");
    drag.preview.style.width = bounds.width + "px";
    document.body.append(drag.preview);

    drag.gap = document.createElement("li");
    drag.gap.className = "board-drop-gap";
    drag.gap.setAttribute("aria-hidden", "true");
    drag.gap.style.height = bounds.height + "px";
    card.before(drag.gap);
    card.hidden = true;
    columns.classList.add("is-dragging");
    columns.setPointerCapture(drag.id);
  }

  function draw(time) {
    if (time !== undefined && drag.lastFrame !== undefined) {
      scrollAtEdge(Math.min(time - drag.lastFrame, 32) / 1000);
    }
    drag.lastFrame = time;
    const moved = drag.x !== drag.drawnX || drag.y !== drag.drawnY;
    if (moved) {
      drag.preview.style.setProperty("--drag-x", drag.x - drag.offsetX + "px");
      drag.preview.style.setProperty("--drag-y", drag.y - drag.offsetY + "px");
      drag.drawnX = drag.x;
      drag.drawnY = drag.y;
    }
    if (moved || columns.scrollLeft !== drag.scrollLeft || scrollY !== drag.scrollY) {
      drag.scrollLeft = columns.scrollLeft;
      drag.scrollY = scrollY;
      updateGap();
    }
    drag.frame = requestAnimationFrame(draw);
  }

  function scrollAtEdge(seconds) {
    const { x, y } = drag;
    const bounds = columns.getBoundingClientRect();
    if (x < bounds.left || x > bounds.right) return;
    if (y >= bounds.top && y <= bounds.bottom) {
      const left = edgeSpeed(x, Math.max(bounds.left, 0), Math.min(bounds.right, innerWidth)) * seconds;
      if (left) columns.scrollBy({ left, behavior: "instant" });
    }
    const top = edgeSpeed(y, 0, innerHeight) * seconds;
    if (top) window.scrollBy({ top, behavior: "instant" });
  }

  function updateGap() {
    const column = document.elementFromPoint(drag.x, drag.y)?.closest(".board-column");
    drag.destination = null;
    if (!column || !columns.contains(column)) return;

    const list = column.querySelector(".board-card-list");
    const listTop = list.getBoundingClientRect().top;
    let before = null;
    for (const card of list.children) {
      if (!card.matches(".board-card") || card.hidden) continue;
      if (drag.y < listTop + card.offsetTop + card.offsetHeight / 2) {
        before = card;
        break;
      }
    }
    drag.destination = {
      column: Number(column.dataset.column),
      before: before ? Number(before.dataset.card) : undefined,
    };
    const oldList = drag.gap.parentElement;
    if (oldList === list && (
      drag.gap.nextElementSibling === before
      || (drag.gap.nextElementSibling === drag.card && drag.card.nextElementSibling === before)
    )) return;

    // Use layout coordinates when picking a slot so a card in the middle of
    // an animation cannot push the gap back across the pointer.
    const positions = new Map();
    if (!motion.matches) {
      for (const cards of new Set([oldList, list])) {
        for (const card of cards.children) {
          if (card.matches(".board-card") && !card.hidden) positions.set(card, card.getBoundingClientRect().top);
        }
      }
    }
    list.insertBefore(drag.gap, before);
    for (const [card, top] of positions) {
      motions.get(card)?.cancel();
      const delta = top - card.getBoundingClientRect().top;
      if (Math.abs(delta) > 1) {
        motions.set(card, card.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], MOVE_TIMING));
      }
    }
  }

  function release(event) {
    if (event.pointerId !== drag.id) return;
    if (drag.preview) {
      drag.x = event.clientX;
      drag.y = event.clientY;
      updateGap();
      event.preventDefault();
    }
    finish(drag.destination);
  }

  function cancelPointer(event) {
    if (event.pointerId === drag.id) cancelDrag();
  }

  function cancelDrag() {
    finish(null);
  }

  function finish(destination) {
    const state = drag;
    drag = null;
    state.events.abort();
    if (!state.preview) return;

    cancelAnimationFrame(state.frame);
    if (columns.hasPointerCapture(state.id)) columns.releasePointerCapture(state.id);
    for (const animation of motions.values()) animation.cancel();
    motions.clear();
    state.preview.remove();
    state.gap.remove();
    state.card.hidden = false;
    columns.classList.remove("is-dragging");
    blockClick = true;

    const settled = destination && moveCard(state.fromColumn, state.fromCard, destination.column, destination.before);
    if (!motion.matches) {
      const card = settled || state.card;
      const bounds = card.getBoundingClientRect();
      const x = state.x - state.offsetX - bounds.left;
      const y = state.y - state.offsetY - bounds.top;
      card.animate([{ transform: `translate(${x}px, ${y}px) rotate(2deg)` }, { transform: "none" }], MOVE_TIMING);
    }
  }

  return () => { if (drag) cancelDrag(); };
}

function edgeSpeed(position, start, end) {
  if (position < start || position > end) return 0;
  const edge = Math.min(EDGE_SIZE, (end - start) / 2);
  const fromStart = position - start;
  const fromEnd = end - position;
  if (fromStart < edge) return -SCROLL_SPEED * (1 - fromStart / edge) ** 2;
  if (fromEnd < edge) return SCROLL_SPEED * (1 - fromEnd / edge) ** 2;
  return 0;
}
