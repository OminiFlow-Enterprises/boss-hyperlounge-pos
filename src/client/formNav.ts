import type { KeyboardEvent as ReactKeyboardEvent } from "react";

const lastSelectInitial = new WeakMap<HTMLSelectElement, string>();

export function selectByFirstLetter(e: ReactKeyboardEvent<HTMLSelectElement>, onSelect: (value: string) => void) {
  if (e.altKey || e.ctrlKey || e.metaKey || !/^[a-z]$/i.test(e.key)) return;
  e.preventDefault();
  if (e.repeat) return;
  const select = e.currentTarget;
  const initial = e.key.toLowerCase();
  const previous = lastSelectInitial.get(select);
  if (previous === undefined) {
    select.addEventListener("blur", () => { lastSelectInitial.delete(select); }, { once: true });
  }
  lastSelectInitial.set(select, initial);
  const matches = Array.from(select.options).filter((item) =>
    !item.disabled && item.text.trim().toLowerCase().startsWith(initial));
  if (!matches.length) return;
  const current = previous === initial ? matches.findIndex((item) => item.selected) : -1;
  onSelect(matches[(current + 1) % matches.length].value);
}

type ArrowDir = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

const FORM_ROOT = ".dialog, .xfer-dlg, .item-xfer-dlg, .im-dlg, .su-dlg, .kot-add-dlg, .adv-form, .set-filter, .rpt-bar, .login-dlg, .login-box, .um-screen";

function textLike(el: HTMLInputElement) {
  return !["checkbox", "radio", "button", "submit", "reset", "file", "hidden", "image"].includes(el.type);
}

function formFields(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>("input, select, textarea, button")).filter((el) => {
    if (el.closest(".cap-btns, .caption-btns")) return false;
    if (el.tabIndex < 0) return false;
    if ((el as HTMLInputElement).disabled) return false;
    if (el instanceof HTMLInputElement && !textLike(el) && el.type !== "checkbox" && el.type !== "radio") return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  });
}

function crossGap(a1: number, a2: number, b1: number, b2: number) {
  const overlap = Math.min(a2, b2) - Math.max(a1, b1);
  return overlap > 0 ? 0 : -overlap;
}

function nearestField(from: HTMLElement, dir: ArrowDir, fields: HTMLElement[]) {
  const a = from.getBoundingClientRect();
  const ax = (a.left + a.right) / 2;
  const ay = (a.top + a.bottom) / 2;
  const scored: Array<{ el: HTMLElement; main: number; cross: number; center: number }> = [];
  for (const el of fields) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    let main = 0;
    let cross = 0;
    if (dir === "ArrowRight") {
      main = b.left - a.right;
      cross = crossGap(a.top, a.bottom, b.top, b.bottom);
    } else if (dir === "ArrowLeft") {
      main = a.left - b.right;
      cross = crossGap(a.top, a.bottom, b.top, b.bottom);
    } else if (dir === "ArrowDown") {
      main = b.top - a.bottom;
      cross = crossGap(a.left, a.right, b.left, b.right);
    } else {
      main = a.top - b.bottom;
      cross = crossGap(a.left, a.right, b.left, b.right);
    }
    if (main < -4) continue;
    const bx = (b.left + b.right) / 2;
    const by = (b.top + b.bottom) / 2;
    const center = dir === "ArrowLeft" || dir === "ArrowRight" ? Math.abs(by - ay) : Math.abs(bx - ax);
    scored.push({ el, main: Math.max(0, main), cross, center });
  }
  const aligned = scored.filter((s) => s.cross <= 10);
  const pool = aligned.length ? aligned : scored;
  pool.sort((p, q) => p.main - q.main || p.center - q.center || p.cross - q.cross);
  return pool[0]?.el ?? null;
}

function focusFormField(el: HTMLElement) {
  el.focus();
  if (el instanceof HTMLInputElement && textLike(el) && el.dataset.edit !== "text") {
    el.dataset.replace = "1";
    el.select();
  }
  if (el.closest(".bill-grid-wrap, .item-xfer-grid")) {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

export function moveFormFocus(e: KeyboardEvent) {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "ArrowUp" && e.key !== "ArrowDown") return false;
  const active = document.activeElement as HTMLElement | null;
  if (!active?.matches("input, select, textarea, button")) return false;
  if (active instanceof HTMLSelectElement && (e.key === "ArrowUp" || e.key === "ArrowDown")) return false;
  if (active.dataset.list === "open") return false;
  // "1" owns every arrow. "ud" owns Up/Down only (dropdowns). Text edits keep Left/Right for the caret.
  if (active.dataset.cycle === "1" || active.classList.contains("xfer-outlet-box")) return false;
  if (active.dataset.cycle === "ud" && (e.key === "ArrowUp" || e.key === "ArrowDown")) return false;
  if (
    (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
    active instanceof HTMLInputElement &&
    textLike(active) &&
    active.dataset.edit === "text"
  ) return false;
  if (active.closest(".cap-btns, .caption-btns")) return false;
  const root = active.closest(FORM_ROOT);
  if (!root) return false;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  const next = nearestField(active, e.key, formFields(root as HTMLElement));
  if (next) focusFormField(next);
  return true;
}

export function cardNoDigits(raw: string) {
  return String(raw ?? "").replace(/\D/g, "").slice(0, 4);
}

export function cardNoReady(raw: string) {
  return /^\d{4}$/.test(String(raw ?? "").trim());
}

export function stayOnCard(el: HTMLInputElement | null | undefined) {
  if (!el) return;
  const end = cardNoDigits(el.value).length;
  requestAnimationFrame(() => {
    el.focus();
    delete el.dataset.replace;
    try { el.setSelectionRange(end, end); } catch { /* read-only */ }
  });
}

export function armReplaceOnFocus(e: FocusEvent) {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || !textLike(el)) return;
  if (el.dataset.edit === "text") return;
  if (el.dataset.num === "card") {
    const n = el.value.replace(/\D/g, "").length;
    if (n > 0 && n < 4) return;
  }
  el.dataset.replace = "1";
  const apply = () => {
    if (document.activeElement === el && el.dataset.replace === "1") el.select();
  };
  apply();
  requestAnimationFrame(apply);
  setTimeout(apply, 0);
}

export function replaceOnFirstKey(e: KeyboardEvent) {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || el.dataset.replace !== "1") return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const edits = e.key.length === 1 || e.key === "Backspace" || e.key === "Delete";
  if (!edits) return;
  el.select();
  delete el.dataset.replace;
}

function numericMode(el: HTMLInputElement) {
  if (el.dataset.num === "card" || el.dataset.num === "int" || el.dataset.num === "dec") return el.dataset.num;
  return "";
}

function numericTextOk(text: string, mode: "int" | "dec" | "card", el: HTMLInputElement) {
  if (mode === "card") {
    if (!/^\d+$/.test(text)) return false;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    return /^\d{0,4}$/.test(next);
  }
  if (mode === "int") return /^\d*$/.test(text);
  if (!/^[\d.]*$/.test(text)) return false;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const next = el.value.slice(0, start) + text + el.value.slice(end);
  return (next.match(/\./g) ?? []).length <= 1;
}

export function blockLetters(e: KeyboardEvent) {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || el.readOnly) return;
  const mode = numericMode(el);
  if (!mode) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.length !== 1) return;
  if (numericTextOk(e.key, mode, el)) return;
  e.preventDefault();
  e.stopPropagation();
}

export function blockLetterInsert(e: InputEvent) {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || el.readOnly) return;
  const mode = numericMode(el);
  if (!mode || e.data == null) return;
  if (mode === "card") return;
  if (!e.inputType.startsWith("insert")) return;
  if (numericTextOk(e.data, mode, el)) return;
  e.preventDefault();
  e.stopPropagation();
}
