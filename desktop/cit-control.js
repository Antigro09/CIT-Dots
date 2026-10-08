import UI from "./app/ui.js";

// The enclosing local app sends only broker-observed cursor/control state.
// Credentials and file contents never pass through this bridge.
const options = new URLSearchParams(window.location.hash.slice(1));
const parentOrigin = options.get("cit_parent_origin");
const dotId = options.get("cit_dot_id");
let state = { mode: "agent", cursor: null };
let lastStateAt = 0;

const style = document.createElement("style");
style.textContent = `
  #cit-agent-cursor {
    position: fixed; left: 0; top: 0; z-index: 1000;
    pointer-events: none; display: none; color: #a78bfa;
    filter: drop-shadow(0 1px 2px #0009);
  }
  #cit-agent-cursor svg { display: block; width: 22px; height: 28px; }
  #cit-agent-cursor span {
    position: absolute; left: 18px; top: 20px; padding: 3px 6px;
    background: #4c358b; color: white; border-radius: 4px;
    font: 10px/1.3 system-ui, sans-serif; white-space: nowrap;
  }
`;
document.head.append(style);
const overlay = document.createElement("div");
overlay.id = "cit-agent-cursor";
overlay.setAttribute("aria-hidden", "true");
const pointer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
pointer.setAttribute("viewBox", "0 0 22 28");
const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
arrow.setAttribute("d", "M1 1L19 15L11 17L8 25L1 1Z");
arrow.setAttribute("fill", "#a78bfa");
arrow.setAttribute("stroke", "#fff");
arrow.setAttribute("stroke-width", "1.5");
pointer.append(arrow);
const label = document.createElement("span");
label.textContent = "Agent";
overlay.append(pointer, label);
document.body.append(overlay);

function render() {
  // A stale/disconnected app stays view-only until fresh control state arrives.
  const fresh = Date.now() - lastStateAt < 3000;
  const human = state.mode === "human" && fresh;
  if (UI.rfb) UI.rfb.viewOnly = !human;
  document.documentElement.dataset.citControlMode = human ? "human" : "agent";
  const canvas = document.querySelector("#noVNC_container canvas");
  const cursor = state.cursor;
  if (
    human ||
    !fresh ||
    !canvas ||
    !cursor ||
    ![cursor.x, cursor.y, cursor.width, cursor.height].every(Number.isFinite) ||
    cursor.width <= 0 ||
    cursor.height <= 0
  ) {
    overlay.style.display = "none";
    return;
  }
  const rectangle = canvas.getBoundingClientRect();
  const x = rectangle.left + (cursor.x / cursor.width) * rectangle.width;
  const y = rectangle.top + (cursor.y / cursor.height) * rectangle.height;
  const outside =
    x < Math.max(0, rectangle.left) ||
    y < Math.max(0, rectangle.top) ||
    x >= Math.min(window.innerWidth, rectangle.right) ||
    y >= Math.min(window.innerHeight, rectangle.bottom);
  overlay.style.display = outside ? "none" : "block";
  overlay.style.transform = `translate(${x}px, ${y}px)`;
  overlay.dataset.x = String(cursor.x);
  overlay.dataset.y = String(cursor.y);
  overlay.dataset.width = String(cursor.width);
  overlay.dataset.height = String(cursor.height);
}

window.addEventListener("message", (event) => {
  if (
    !parentOrigin ||
    !dotId ||
    event.source !== window.parent ||
    event.origin !== parentOrigin ||
    event.data?.type !== "cit-desktop-control" ||
    event.data.dotId !== dotId ||
    !["agent", "human"].includes(event.data.mode)
  )
    return;
  state = { mode: event.data.mode, cursor: event.data.cursor ?? null };
  lastStateAt = Date.now();
  render();
});
window.addEventListener("resize", render);
document.addEventListener("scroll", render, true);
setInterval(render, 100);

if (parentOrigin && dotId && window.parent !== window)
  window.parent.postMessage({ type: "cit-desktop-ready", dotId }, parentOrigin);
render();
