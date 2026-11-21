import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { AlertBox, CapBtns, ConfirmAsk } from "./BillDialogs";

export type CompAccount = { id: string; code: number; name: string };

export function ComplimentaryMasterDialog({
  onClose,
  onSaved,
  onDeleted,
}: {
  onClose: () => void;
  onSaved?: (row: CompAccount) => void;
  onDeleted?: (id: string) => void;
}) {
  const [rows, setRows] = useState<CompAccount[]>([]);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [warn, setWarn] = useState("");
  const [askDelete, setAskDelete] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  async function load(pickId?: string | null) {
    const list = await api.get<CompAccount[]>("/api/complimentary");
    setRows(list);
    const next = (list.reduce((m, r) => Math.max(m, r.code), 0) || 0) + 1;
    if (pickId) {
      const row = list.find((r) => r.id === pickId);
      if (row) {
        setEditId(row.id);
        setCode(String(row.code));
        setName(row.name);
        setSel(Math.max(0, list.findIndex((r) => r.id === row.id)));
        return;
      }
    }
    setEditId(null);
    setCode(String(next));
    setName("");
  }

  useEffect(() => {
    void load().then(() => nameRef.current?.focus());
    function keys(e: KeyboardEvent) {
      if (document.querySelector(".cm-dlg .alert-dlg, .cm-dlg .confirm-dlg, .confirm-overlay")) return;
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, []);

  function blank() {
    const next = (rows.reduce((m, r) => Math.max(m, r.code), 0) || 0) + 1;
    setEditId(null);
    setCode(String(next));
    setName("");
    nameRef.current?.focus();
  }

  function edit(row: CompAccount, index: number) {
    setEditId(row.id);
    setCode(String(row.code));
    setName(row.name);
    setSel(index);
    requestAnimationFrame(() => {
      nameRef.current?.focus();
      nameRef.current?.select();
    });
  }

  async function save() {
    const clean = name.trim();
    if (!clean) {
      setWarn("Enter Name");
      nameRef.current?.focus();
      return;
    }
    try {
      const row = editId
        ? await api.put<CompAccount>(`/api/complimentary/${editId}`, { name: clean })
        : await api.post<CompAccount>("/api/complimentary", { name: clean });
      await load(null);
      onSaved?.(row);
    } catch (e) {
      setWarn(e instanceof Error ? e.message : "Could not save");
    }
  }

  async function remove(id: string) {
    setAskDelete(null);
    try {
      await api.del(`/api/complimentary/${id}`);
      if (editId === id) blank();
      await load(null);
      onDeleted?.(id);
    } catch (e) {
      setWarn(e instanceof Error ? e.message : "Could not delete");
    }
  }

  return (
    <div className="dialog cm-dlg" role="dialog" aria-label="Complimentary Master">
      <div className="dialog-cap">
        <span className="cap-dot" />
        Complimentary Master
        <CapBtns onClose={onClose} />
      </div>
      <div className="cm-body">
        <div className="cm-form">
          <label>Code :</label>
          <input className="win cm-code" value={code} readOnly tabIndex={-1} />
          <label>Name :</label>
          <input
            ref={nameRef}
            className="win green cm-name"
            value={name}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              e.stopPropagation();
              void save();
            }}
          />
          <span className="cm-req">*</span>
          <button type="button" className="fn" onClick={() => void save()}>Save</button>
          <button type="button" className="fn" onClick={blank}>Cancel</button>
          <button type="button" className="fn" onClick={onClose}>Exit</button>
        </div>
        <div className="cm-grid">
          <table>
            <colgroup>
              <col />
              <col className="c-code" />
              <col className="c-act" />
              <col className="c-act" />
            </colgroup>
            <thead>
              <tr>
                <th>Customer Name</th>
                <th>Customer Code</th>
                <th>Edit</th>
                <th>Delete</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={row.id}
                  className={(editId ? editId === row.id : i === sel) ? "on" : ""}
                  onClick={() => setSel(i)}
                  onDoubleClick={() => edit(row, i)}
                >
                  <td>{row.name}</td>
                  <td>{row.code}</td>
                  <td><button type="button" className="fn" onClick={() => edit(row, i)}>Edit</button></td>
                  <td><button type="button" className="fn" onClick={() => setAskDelete(row.id)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {warn && <AlertBox message={warn} onClose={() => { setWarn(""); nameRef.current?.focus(); }} />}
      {askDelete && (
        <ConfirmAsk
          message="Delete this complimentary account?"
          onYes={() => void remove(askDelete)}
          onNo={() => setAskDelete(null)}
        />
      )}
    </div>
  );
}
