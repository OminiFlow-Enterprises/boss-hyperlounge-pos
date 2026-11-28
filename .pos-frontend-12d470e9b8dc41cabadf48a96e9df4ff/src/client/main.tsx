import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

function uppercaseEntry(target: EventTarget | null) {
  const field = target instanceof HTMLTextAreaElement
    || (target instanceof HTMLInputElement && ["text", "search"].includes(target.type))
    ? target
    : null;
  if (!field || field.readOnly) return false;
  const value = field.value;
  const upper = value.toUpperCase();
  if (upper === value) return false;
  const { selectionStart, selectionEnd, selectionDirection } = field;
  // Use the native setter so React detects the normalized value as user input.
  const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, upper);
  if (selectionStart !== null && selectionEnd !== null) {
    field.setSelectionRange(
      value.slice(0, selectionStart).toUpperCase().length,
      value.slice(0, selectionEnd).toUpperCase().length,
      selectionDirection ?? undefined,
    );
  }
  return true;
}

document.addEventListener("input", (event) => {
  if (!(event as InputEvent).isComposing) uppercaseEntry(event.target);
}, true);

document.addEventListener("compositionend", (event) => {
  const target = event.target;
  queueMicrotask(() => {
    if (uppercaseEntry(target)) target?.dispatchEvent(new Event("input", { bubbles: true }));
  });
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
