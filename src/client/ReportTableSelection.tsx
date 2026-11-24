import { useLayoutEffect, useRef, type ReactNode } from "react";

const controls = "button, input, select, textarea, a, [contenteditable]";
const directions: Record<string, [number, number] | undefined> = {
  ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
};

type Position = { row: number; column: number };
type Selection = { table: HTMLTableElement; anchor: Position; active: Position };

function tableCells(table: HTMLTableElement) {
  return Array.from(table.rows, (row) =>
    Array.from(row.cells).flatMap((cell) => Array<HTMLTableCellElement>(cell.colSpan).fill(cell)),
  );
}

export function ReportTableSelection({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let selection: Selection | undefined;
    let highlighted = new Set<HTMLTableCellElement>();
    let copiedRows: string[][] = [];

    function clear() {
      selection?.table.classList.remove("report-range-active");
      highlighted.forEach((cell) => cell.classList.remove("report-range-cell"));
      highlighted = new Set();
      copiedRows = [];
      selection = undefined;
    }

    function paint(next: Selection, cells: ReturnType<typeof tableCells>) {
      clear();
      selection = next;
      const { table, anchor, active } = next;
      const headerRows = table.tHead?.rows.length ?? 0;
      const entireColumns = anchor.row < headerRows && active.row < headerRows;
      const top = entireColumns ? 0 : Math.min(anchor.row, active.row);
      const bottom = entireColumns ? cells.length - 1 : Math.max(anchor.row, active.row);
      const left = Math.min(anchor.column, active.column);
      const right = Math.max(anchor.column, active.column);
      table.classList.add("report-range-active");
      copiedRows = cells.slice(top, bottom + 1).map((row) =>
        Array.from({ length: right - left + 1 }, (_, offset) => {
          const cell = row[left + offset];
          if (!cell || highlighted.has(cell)) return "";
          highlighted.add(cell);
          cell.classList.add("report-range-cell");
          return cell.innerText.trim().replace(/[\t\r\n]+/g, " ");
        }),
      );
    }

    function selectableCell(target: EventTarget | null) {
      if (!(target instanceof Element)) return null;
      const cell = target.closest<HTMLTableCellElement>("td, th");
      if (!cell || !root?.contains(cell) || cell.closest("[role=dialog], .bill-dlg, .settle-dlg, .su-dlg, .kot-view, .cs-dlg, .fn-table, .st-form")) return null;
      if (target.closest(controls) && !cell.closest("thead")) return null;
      return cell;
    }

    function mouseDown(event: MouseEvent) {
      if (event.shiftKey && selectableCell(event.target)) event.preventDefault();
    }

    function click(event: MouseEvent) {
      const cell = selectableCell(event.target);
      const table = cell?.closest("table");
      if (!cell || !table) {
        clear();
        return;
      }
      const row = (cell.parentElement as HTMLTableRowElement).rowIndex;
      const cells = tableCells(table);
      const active = { row, column: cells[row].indexOf(cell) };
      const anchor = event.shiftKey && selection?.table === table ? selection.anchor : active;
      const sorting = !event.shiftKey && event.target instanceof Element && event.target.closest("button");
      if (sorting) {
        clear();
        return;
      }
      table.tabIndex = -1;
      table.focus({ preventScroll: true });
      paint({ table, anchor, active }, cells);
      if (event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    function ownsFocus(event: Event) {
      return selection && event.target instanceof Element &&
        event.target.closest("table") === selection.table && !event.target.closest(controls);
    }

    function keydown(event: KeyboardEvent) {
      const delta = directions[event.key];
      if (!selection || !ownsFocus(event) || !delta) return;
      if (!event.shiftKey) {
        clear();
        return;
      }
      const { table, anchor, active } = selection;
      const cells = tableCells(table);
      const width = Math.max(...cells.map((row) => row.length));
      const row = Math.max(0, Math.min(cells.length - 1, active.row + delta[0]));
      const column = Math.max(0, Math.min(width - 1, active.column + delta[1]));
      event.preventDefault();
      event.stopImmediatePropagation();
      paint({ table, anchor, active: { row, column } }, cells);
      cells[row]?.[column]?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }

    function copy(event: ClipboardEvent) {
      if (!ownsFocus(event) || !copiedRows.length || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", copiedRows.map((row) => row.join("\t")).join("\n"));
      event.preventDefault();
    }

    const observer = new MutationObserver((changes) => {
      const table = selection?.table;
      if (table && (!root.contains(table) || changes.some((change) => table.contains(change.target)))) clear();
    });
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    root.addEventListener("mousedown", mouseDown, true);
    root.addEventListener("click", click, true);
    root.addEventListener("copy", copy);
    window.addEventListener("keydown", keydown, true);
    return () => {
      observer.disconnect();
      root.removeEventListener("mousedown", mouseDown, true);
      root.removeEventListener("click", click, true);
      root.removeEventListener("copy", copy);
      window.removeEventListener("keydown", keydown, true);
      clear();
    };
  }, []);

  return <div className="report-table-selection" ref={rootRef}>{children}</div>;
}
