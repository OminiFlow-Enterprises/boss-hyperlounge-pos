import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { AlertBox, CapBtns, ConfirmAsk } from "./BillDialogs";
import { itemMatchScore } from "../shared/itemSearch";

const DEPTS = ["CAFE", "BAR", "THE BOSS CLUB", "RESTAURANT", "NC"] as const;

type Rate = {
  dept: string;
  rate: number;
  hsn: string;
  inclusive: boolean;
  discount: boolean;
  enabled: boolean;
};

type MasterItem = {
  id: string;
  sku: string;
  name: string;
  costPrice: number;
  salesGroup: string;
  itemGroup: string;
  veg: boolean;
  stockItem: string;
  allowComplimentary: boolean;
  hideInWeb: boolean;
  nameHindi: string;
  mixItem: boolean;
  logo: string;
  basePrice: number;
  rates: Rate[];
};

type Master = {
  items: MasterItem[];
  salesGroups: string[];
  itemGroups: string[];
  nextCode: string;
};

type RateForm = {
  dept: string;
  rate: string;
  hsn: string;
  inclusive: boolean;
  discount: boolean;
  enabled: boolean;
};

function money(paise: number) {
  return (Number(paise) / 100).toFixed(2);
}

function blankRates(): RateForm[] {
  return DEPTS.map((dept) => ({
    dept,
    rate: "0.00",
    hsn: "",
    inclusive: false,
    discount: true,
    enabled: true,
  }));
}

function moneyText(value: string) {
  const cleaned = value.replace(/[^\d.]/g, "");
  const dot = cleaned.indexOf(".");
  if (dot < 0) return cleaned;
  return `${cleaned.slice(0, dot + 1)}${cleaned.slice(dot + 1).replace(/\./g, "").slice(0, 2)}`;
}

function fixedMoney(value: string) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "0.00";
  return n.toFixed(2);
}

export function ItemMasterDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [items, setItems] = useState<MasterItem[]>([]);
  const [salesGroups, setSalesGroups] = useState<string[]>([]);
  const [itemGroups, setItemGroups] = useState<string[]>([]);
  const [nextCode, setNextCode] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [salesGroup, setSalesGroup] = useState("");
  const [itemGroup, setItemGroup] = useState("");
  const [cost, setCost] = useState("0.00");
  const [veg, setVeg] = useState(true);
  const [stockItem, setStockItem] = useState("");
  const [comp, setComp] = useState(false);
  const [hideWeb, setHideWeb] = useState(false);
  const [hindi, setHindi] = useState("");
  const [mix, setMix] = useState(false);
  const [logo, setLogo] = useState("");
  const [rates, setRates] = useState<RateForm[]>(blankRates);
  const [deptSel, setDeptSel] = useState(0);
  const [listSel, setListSel] = useState(0);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState("");
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [askDelete, setAskDelete] = useState<MasterItem | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const blockEsc = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  blockEsc.current = groupOpen || Boolean(askDelete);

  function applyMaster(data: Master) {
    setItems(data.items);
    setSalesGroups(data.salesGroups);
    setItemGroups(data.itemGroups);
    setNextCode(data.nextCode);
    return data;
  }

  async function reload() {
    const data = await api.get<Master>("/api/items/master");
    return applyMaster(data);
  }

  useEffect(() => {
    reload()
      .then((d) => {
        setSku((s) => s || d.nextCode);
        nameRef.current?.focus();
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Could not load items"));
  }, []);

  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (blockEsc.current) return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, []);

  useEffect(() => {
    if (!groupOpen) return;
    function keys(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setGroupOpen(false);
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, [groupOpen]);

  const shown = useMemo(() => {
    const q = name.trim();
    if (!q) return items;
    return items
      .map((item) => ({ item, score: itemMatchScore(item.name, item.sku, q) }))
      .filter((row): row is { item: MasterItem; score: number } => row.score != null)
      .sort((a, b) => a.score - b.score || a.item.name.localeCompare(b.item.name))
      .map((row) => row.item);
  }, [items, name]);

  useEffect(() => {
    listRef.current?.querySelector("tr.on")?.scrollIntoView({ block: "nearest" });
  }, [listSel, shown.length]);

  useEffect(() => {
    if (listSel > shown.length - 1) setListSel(0);
  }, [shown.length, listSel]);

  function startNew(code?: string) {
    setEditingId(null);
    setName("");
    setSku(code ?? nextCode);
    setSalesGroup("");
    setItemGroup("");
    setCost("0.00");
    setVeg(true);
    setStockItem("");
    setComp(false);
    setHideWeb(false);
    setHindi("");
    setMix(false);
    setLogo("");
    setRates(blankRates());
    setDeptSel(0);
    setErr("");
    setTimeout(() => nameRef.current?.focus(), 0);
  }

  function edit(item: MasterItem) {
    const idx = items.findIndex((it) => it.id === item.id);
    if (idx >= 0) setListSel(idx);
    setEditingId(item.id);
    setName(item.name);
    setSku(item.sku);
    setSalesGroup(item.salesGroup);
    setItemGroup(item.itemGroup);
    setCost(money(item.costPrice));
    setVeg(item.veg);
    setStockItem(item.stockItem || "");
    setComp(item.allowComplimentary);
    setHideWeb(item.hideInWeb);
    setHindi(item.nameHindi);
    setMix(item.mixItem);
    setLogo(item.logo || "");
    setRates(
      DEPTS.map((dept) => {
        const r = item.rates.find((x) => x.dept === dept);
        return {
          dept,
          rate: money(r?.rate ?? item.basePrice),
          hsn: r?.hsn ?? "",
          inclusive: r?.inclusive ?? false,
          discount: r?.discount ?? true,
          enabled: r?.enabled ?? true,
        };
      }),
    );
    setDeptSel(0);
    setErr("");
    setStatus("");
    setTimeout(() => {
      nameRef.current?.focus();
      nameRef.current?.select();
    }, 0);
  }

  function patchRate(index: number, patch: Partial<RateForm>) {
    setRates((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    setDeptSel(index);
  }

  function focusDept(index: number, col: "rate" | "hsn") {
    const next = Math.max(0, Math.min(DEPTS.length - 1, index));
    setDeptSel(next);
    requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLInputElement>(`[data-dept="${next}"][data-col="${col}"]`)?.focus();
    });
  }

  function onDeptKey(e: React.KeyboardEvent<HTMLInputElement>, index: number, col: "rate" | "hsn") {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusDept(index + 1, col);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusDept(index - 1, col);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (col === "rate") focusDept(index, "hsn");
      else if (index < DEPTS.length - 1) focusDept(index + 1, "rate");
      else rootRef.current?.querySelector<HTMLButtonElement>("[data-act='save']")?.focus();
    }
  }

  function enterNext(e: React.KeyboardEvent<HTMLElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    const nodes = [...root.querySelectorAll<HTMLElement>("input, select, button")].filter((el) => {
      if (el.tabIndex < 0) return false;
      if ((el as HTMLInputElement).disabled) return false;
      const type = el.getAttribute("type");
      if (type === "file" || type === "radio" || type === "checkbox") return false;
      return true;
    });
    const i = nodes.indexOf(e.currentTarget);
    nodes[i + 1]?.focus();
  }

  async function save() {
    if (busy.current) return;
    if (!name.trim()) {
      setErr("Enter Item Name");
      nameRef.current?.focus();
      return;
    }
    if (!sku.trim()) {
      setErr("Enter Item Code");
      return;
    }
    busy.current = true;
    setErr("");
    const body = {
      name: name.trim(),
      sku: sku.trim(),
      salesGroup,
      itemGroup,
      costPrice: Number(cost) || 0,
      veg,
      stockItem,
      allowComplimentary: comp,
      hideInWeb: hideWeb,
      nameHindi: hindi.trim(),
      mixItem: mix,
      logo,
      rates: rates.map((r) => ({
        dept: r.dept,
        rate: Number(r.rate) || 0,
        hsn: r.hsn.trim(),
        inclusive: r.inclusive,
        discount: r.discount,
        enabled: r.enabled,
      })),
    };
    try {
      if (editingId) {
        const saved = await api.put<MasterItem>(`/api/items/${editingId}`, body);
        const data = await reload();
        const fresh = data.items.find((it) => it.id === saved.id);
        if (fresh) edit(fresh);
        setStatus("Saved");
      } else {
        await api.post("/api/items", body);
        const data = await reload();
        startNew(data.nextCode);
        setStatus("Saved");
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save item");
    } finally {
      busy.current = false;
    }
  }

  async function confirmDelete() {
    if (!askDelete) return;
    const id = askDelete.id;
    setAskDelete(null);
    try {
      await api.del(`/api/items/${id}`);
      const data = await reload();
      onSaved();
      if (editingId === id) startNew(data.nextCode);
      setStatus("Deleted");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not delete item");
    }
  }

  async function saveGroup() {
    const trimmed = groupName.trim();
    if (!trimmed) return;
    try {
      const data = await api.post<{ name: string; itemGroups: string[] }>("/api/item-groups", { name: trimmed });
      setItemGroups(data.itemGroups);
      setItemGroup(data.name);
      setGroupOpen(false);
      setGroupName("");
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not add item group");
    }
  }

  function onLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 150_000) {
      setErr("Logo too large");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setLogo(String(reader.result ?? ""));
      setErr("");
    };
    reader.readAsDataURL(file);
  }

  function onListKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setListSel((i) => Math.min(Math.max(shown.length - 1, 0), i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setListSel((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = shown[listSel];
      if (item) edit(item);
    } else if (e.key === "Delete") {
      e.preventDefault();
      const item = shown[listSel];
      if (item) setAskDelete(item);
    }
  }

  const salesOptions = [...new Set([...(salesGroup ? [salesGroup] : []), ...salesGroups])];
  const groupOptions = [...new Set([...(itemGroup ? [itemGroup] : []), ...itemGroups])];

  return (
    <div className="im-mask">
      <div className="im-dlg" role="dialog" aria-label="Item Master" ref={rootRef}>
        <div className="dialog-cap">
          <span className="cap-dot" />
          Item Master
          <CapBtns onClose={onClose} />
        </div>
        <div className="im-body">
          <div className="im-row">
            <button type="button" className="fn" onClick={() => startNew()}>Add Item</button>
            <span className="im-lbl">Item Name</span>
            <input
              ref={nameRef}
              className="win im-grow"
              value={name}
              autoComplete="off"
              onChange={(e) => { setName(e.target.value); setStatus(""); }}
              onKeyDown={enterNext}
            />
            <span className="im-lbl">Item Code :</span>
            <input
              className="win im-code"
              value={sku}
              autoComplete="off"
              onChange={(e) => { setSku(e.target.value); setStatus(""); }}
              onKeyDown={enterNext}
            />
          </div>
          <div className="im-row">
            <span className="im-lbl">Sales Group :</span>
            <select className="win im-sales" value={salesGroup} onChange={(e) => setSalesGroup(e.target.value)} onKeyDown={enterNext}>
              <option value="">Select</option>
              {salesOptions.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
            <span className="im-lbl push">Item Group :</span>
            <select className="win im-sel" value={itemGroup} onChange={(e) => setItemGroup(e.target.value)} onKeyDown={enterNext}>
              <option value="">Select</option>
              {groupOptions.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
            <button type="button" className="im-plus" title="Add item group" onClick={() => { setGroupName(""); setGroupOpen(true); }}>+</button>
          </div>
          <div className="im-row">
            <span className="im-lbl">Cost Price :</span>
            <input
              className="win im-money"
              value={cost}
              onChange={(e) => setCost(moneyText(e.target.value))}
              onBlur={(e) => setCost(fixedMoney(e.target.value))}
              onKeyDown={enterNext}
            />
            <span className="im-lbl push">Veg</span>
            <label className="chk"><input type="radio" name="im-veg" checked={veg} onChange={() => setVeg(true)} /> Yes</label>
            <label className="chk"><input type="radio" name="im-veg" checked={!veg} onChange={() => setVeg(false)} /> No</label>
          </div>
          <div className="im-row">
            <span className="im-lbl">Stock Item :</span>
            <select className="win im-sel" value={stockItem} onChange={(e) => setStockItem(e.target.value)} onKeyDown={enterNext}>
              <option value="">Select</option>
              <option value="Yes">Yes</option>
              <option value="No">No</option>
            </select>
            <label className="chk push"><input type="checkbox" checked={comp} onChange={(e) => setComp(e.target.checked)} /> Allow Complimentary</label>
            <label className="chk"><input type="checkbox" checked={hideWeb} onChange={(e) => setHideWeb(e.target.checked)} /> Hide in Web</label>
          </div>
          <div className="im-row">
            <span className="im-lbl im-hindi-lbl">Item Name in Hindi :</span>
            <input className="win im-grow" value={hindi} onChange={(e) => setHindi(e.target.value)} onKeyDown={enterNext} />
          </div>

          <div className="im-mid">
            <div className="im-depts-wrap">
              <table className="im-depts">
                <colgroup>
                  <col />
                  <col className="c-rate" />
                  <col className="c-hsn" />
                  <col className="c-flag" />
                  <col className="c-flag" />
                  <col className="c-box" />
                </colgroup>
                <thead>
                  <tr>
                    <th>DeptName</th>
                    <th>Rate</th>
                    <th>HSN</th>
                    <th>Inclusive</th>
                    <th>Discount</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rates.map((r, i) => (
                    <tr key={r.dept} className={i === deptSel ? "on" : ""} onClick={() => setDeptSel(i)}>
                      <td>{r.dept}</td>
                      <td>
                        <input
                          className="cell num"
                          data-dept={i}
                          data-col="rate"
                          value={r.rate}
                          onChange={(e) => patchRate(i, { rate: moneyText(e.target.value) })}
                          onBlur={(e) => patchRate(i, { rate: fixedMoney(e.target.value) })}
                          onFocus={() => setDeptSel(i)}
                          onKeyDown={(e) => onDeptKey(e, i, "rate")}
                        />
                      </td>
                      <td>
                        <input
                          className="cell"
                          data-dept={i}
                          data-col="hsn"
                          value={r.hsn}
                          onChange={(e) => patchRate(i, { hsn: e.target.value })}
                          onFocus={() => setDeptSel(i)}
                          onKeyDown={(e) => onDeptKey(e, i, "hsn")}
                        />
                      </td>
                      <td className="mid"><input type="checkbox" checked={r.inclusive} onChange={(e) => patchRate(i, { inclusive: e.target.checked })} /></td>
                      <td className="mid"><input type="checkbox" checked={r.discount} onChange={(e) => patchRate(i, { discount: e.target.checked })} /></td>
                      <td className="mid"><input type="checkbox" checked={r.enabled} onChange={(e) => patchRate(i, { enabled: e.target.checked })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="im-side">
              <button type="button" className="fn" onClick={() => fileRef.current?.click()}>Upload Logo</button>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={onLogo} />
              {logo ? <img className="im-logo" src={logo} alt="" /> : null}
              <button type="button" className="fn" onClick={() => focusDept(deptSel, "hsn")}>HSN Code</button>
              <button type="button" className={`fn ${mix ? "im-mix" : ""}`} onClick={() => setMix((v) => !v)}>Mix Item</button>
              <div className="im-gap" />
              <button type="button" className="fn" data-act="save" onClick={() => void save()}>Save</button>
              <button type="button" className="fn" onClick={() => { startNew(); setStatus(""); }}>Cancel</button>
              <button type="button" className="fn" onClick={onClose}>Exit</button>
            </div>
          </div>
          {(err || status) && <AlertBox message={err || status} onClose={() => { setErr(""); setStatus(""); }} />}
        </div>

        <div className="im-details">
          <div className="im-details-cap">Item Details</div>
          <div className="im-grid" ref={listRef} tabIndex={0} onKeyDown={onListKey}>
            <table>
              <colgroup>
                <col className="c-arr" />
                <col />
                <col className="c-code" />
                <col className="c-cost" />
                <col className="c-act" />
                <col className="c-act" />
                <col className="c-act" />
              </colgroup>
              <thead>
                <tr>
                  <th />
                  <th>ItemName</th>
                  <th>ItemCode</th>
                  <th>CostPrice</th>
                  <th>Edit</th>
                  <th>Edit</th>
                  <th>Delete</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((item, i) => (
                  <tr
                    key={item.id}
                    className={i === listSel ? "on" : ""}
                    onClick={() => setListSel(i)}
                    onDoubleClick={() => edit(item)}
                  >
                    <td className="arr">{i === listSel ? "►" : ""}</td>
                    <td className="name">{item.name}</td>
                    <td>{item.sku}</td>
                    <td className="num">{money(item.costPrice)}</td>
                    <td><button type="button" tabIndex={-1} className="link" onClick={() => edit(item)}>Edit</button></td>
                    <td><button type="button" tabIndex={-1} className="link" onClick={() => edit(item)}>Edit</button></td>
                    <td><button type="button" tabIndex={-1} className="link" onClick={() => setAskDelete(item)}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {groupOpen && (
        <div className="dialog im-group" role="dialog" aria-label="Item Group">
          <div className="dialog-cap">
            <span className="cap-dot" />
            Item Group
            <CapBtns onClose={() => setGroupOpen(false)} chrome={false} />
          </div>
          <div className="im-group-body">
            <span>Name</span>
            <input
              className="win"
              autoFocus
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void saveGroup(); }
                if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setGroupOpen(false); }
              }}
            />
            <div className="im-group-btns">
              <button type="button" className="fn" onClick={() => void saveGroup()}>OK</button>
              <button type="button" className="fn" onClick={() => setGroupOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {askDelete && (
        <ConfirmAsk
          message={`Delete ${askDelete.name}?`}
          onYes={() => void confirmDelete()}
          onNo={() => setAskDelete(null)}
        />
      )}
    </div>
  );
}
