import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { AlertBox, CapBtns, ConfirmAsk } from "./BillDialogs";

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

type DropId = "" | "sales" | "group" | "stock";

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

function scrollBoxRow(box: HTMLElement | null, row: HTMLElement | null) {
  if (!box || !row) return;
  const head = box.querySelector("thead")?.getBoundingClientRect().height ?? 0;
  const top = row.offsetTop;
  const bottom = top + row.offsetHeight;
  if (top < box.scrollTop + head) box.scrollTop = Math.max(0, top - head);
  else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
}

function WinCombo({
  inputRef,
  value,
  options,
  open,
  onOpen,
  onChange,
  onEnter,
  narrow,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  options: string[];
  open: boolean;
  onOpen: (open: boolean) => void;
  onChange: (value: string) => void;
  onEnter: () => void;
  narrow?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const typed = useRef("");
  const typedAt = useRef(0);
  const all = useMemo(() => {
    const rest = options.filter((o) => o);
    return value && !rest.includes(value) ? ["", ...rest, value] : ["", ...rest];
  }, [options, value]);

  function at(v: string) {
    const i = all.indexOf(v);
    return i < 0 ? 0 : i;
  }

  useLayoutEffect(() => {
    if (!open) return;
    const box = listRef.current;
    const row = box?.querySelector(".on") as HTMLElement | null;
    scrollBoxRow(box, row);
  }, [open, value, all.length]);

  function move(dir: 1 | -1) {
    const next = all[Math.max(0, Math.min(all.length - 1, at(value) + dir))] ?? "";
    onChange(next);
    onOpen(true);
  }

  function jump(ch: string) {
    const now = Date.now();
    const prefix = (now - typedAt.current < 700 ? typed.current : "") + ch.toLowerCase();
    typed.current = prefix;
    typedAt.current = now;
    const cur = at(value);
    const order = prefix.length === 1
      ? [...all.slice(cur + 1), ...all.slice(0, cur + 1)]
      : [...all.slice(cur), ...all.slice(0, cur)];
    const hit = order.find((opt) => opt && opt.toLowerCase().startsWith(prefix));
    if (!hit) return;
    onChange(hit);
    onOpen(true);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      move(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      onOpen(false);
      onEnter();
      return;
    }
    if (e.key === "Escape") {
      if (!open) return;
      e.preventDefault();
      e.stopPropagation();
      onOpen(false);
      return;
    }
    if (e.key === "F4" || (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp"))) {
      e.preventDefault();
      e.stopPropagation();
      onOpen(!open);
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      jump(e.key);
    }
  }

  return (
    <div className={narrow ? "im-combo im-narrow" : "im-combo"}>
      <input
        ref={inputRef}
        className="win"
        readOnly
        data-cycle="ud"
        data-list={open ? "open" : undefined}
        value={value || "Select"}
        title={value || "Select"}
        onKeyDown={onKey}
        onBlur={() => window.setTimeout(() => {
          if (document.activeElement === inputRef.current) return;
          onOpen(false);
        }, 140)}
      />
      <button
        type="button"
        className="im-drop-btn"
        tabIndex={-1}
        aria-label="Open list"
        onMouseDown={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
          onOpen(!open);
        }}
      />
      {open && (
        <div className="im-combo-list" ref={listRef} onMouseDown={(e) => e.preventDefault()}>
          {all.map((opt) => (
            <div
              key={opt || "select"}
              className={opt === value ? "on" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(opt);
                onOpen(false);
                inputRef.current?.focus();
              }}
            >
              {opt || "Select"}
            </div>
          ))}
        </div>
      )}
    </div>
  );
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
  const [veg, setVeg] = useState(false);
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
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [askDelete, setAskDelete] = useState<MasterItem | null>(null);
  const [openDrop, setOpenDrop] = useState<DropId>("");
  const nameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const salesRef = useRef<HTMLInputElement>(null);
  const groupRef = useRef<HTMLInputElement>(null);
  const costRef = useRef<HTMLInputElement>(null);
  const stockRef = useRef<HTMLInputElement>(null);
  const hideRef = useRef<HTMLInputElement>(null);
  const hindiRef = useRef<HTMLInputElement>(null);
  const hsnRef = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const deptRef = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const blockEsc = useRef(false);
  const openDropRef = useRef<DropId>("");
  const findBuf = useRef("");
  const findAt = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  openDropRef.current = openDrop;
  blockEsc.current = groupOpen || Boolean(askDelete) || Boolean(err);

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
    nameRef.current?.focus();
    reload()
      .then((d) => {
        setSku((s) => s || d.nextCode);
        const active = document.activeElement;
        if (!active || active === document.body || active === nameRef.current) nameRef.current?.focus();
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Could not load items"));
  }, []);

  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (openDropRef.current) {
        e.preventDefault();
        e.stopPropagation();
        setOpenDrop("");
        return;
      }
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

  useEffect(() => {
    if (listSel > items.length - 1) setListSel(items.length ? items.length - 1 : 0);
  }, [items.length, listSel]);

  useLayoutEffect(() => {
    scrollBoxRow(listRef.current, listRef.current?.querySelector("tbody tr.on") ?? null);
  }, [listSel, items.length]);

  function focusName(selectAll = false) {
    const el = nameRef.current;
    if (!el) return;
    el.focus();
    if (selectAll) el.select();
    else {
      const n = el.value.length;
      try { el.setSelectionRange(n, n); } catch { /* empty */ }
    }
  }

  function startNew(code?: string) {
    setEditingId(null);
    setName("");
    setSku(code ?? nextCode);
    setSalesGroup("");
    setItemGroup("");
    setCost("0.00");
    setVeg(false);
    setStockItem("");
    setComp(false);
    setHideWeb(false);
    setHindi("");
    setMix(false);
    setLogo("");
    setRates(blankRates());
    setDeptSel(0);
    setOpenDrop("");
    setErr("");
    setTimeout(() => focusName(false), 0);
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
    setOpenDrop("");
    setErr("");
    setTimeout(() => focusName(true), 0);
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
      else hsnRef.current?.focus();
    }
  }

  function onDeptNav(e: React.KeyboardEvent) {
    if ((e.target as HTMLElement).closest("input, button, select")) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setDeptSel((i) => Math.min(DEPTS.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setDeptSel((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      focusDept(deptSel, "rate");
    }
  }

  function onVegKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      stockRef.current?.focus();
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown" && e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const yes = e.key === "ArrowLeft" || e.key === "ArrowUp";
    setVeg(yes);
    requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLInputElement>(yes ? "[data-veg='yes']" : "[data-veg='no']")?.focus();
    });
  }

  function onSideHsnKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setDeptSel((i) => Math.max(0, Math.min(DEPTS.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      saveRef.current?.focus();
    }
  }

  async function save() {
    if (busy.current) return;
    if (!name.trim()) {
      setErr("Enter Item Name");
      focusName(false);
      return;
    }
    if (!sku.trim()) {
      setErr("Enter Item Code");
      codeRef.current?.focus();
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
      } else {
        await api.post("/api/items", body);
        const data = await reload();
        startNew(data.nextCode);
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
      setListSel((i) => Math.max(0, Math.min(i, Math.max(0, data.items.length - 1))));
      if (editingId === id) startNew(data.nextCode);
      else listRef.current?.focus();
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
      setTimeout(() => groupRef.current?.focus(), 0);
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

  function jumpList(ch: string) {
    const now = Date.now();
    const prefix = (now - findAt.current < 800 ? findBuf.current : "") + ch.toLowerCase();
    findBuf.current = prefix;
    findAt.current = now;
    const rows = items.map((it, i) => ({ it, i }));
    const order = prefix.length === 1
      ? [...rows.slice(listSel + 1), ...rows.slice(0, listSel + 1)]
      : [...rows.slice(listSel), ...rows.slice(0, listSel)];
    const hit = order.find(({ it }) => it.name.toLowerCase().startsWith(prefix) || it.sku.toLowerCase().startsWith(prefix));
    if (hit) setListSel(hit.i);
  }

  function onListKey(e: React.KeyboardEvent) {
    if ((e.target as HTMLElement).closest("button")) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setListSel((i) => Math.min(Math.max(items.length - 1, 0), i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setListSel((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[listSel];
      if (item) edit(item);
    } else if (e.key === "Delete") {
      e.preventDefault();
      const item = items[listSel];
      if (item) setAskDelete(item);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      jumpList(e.key);
    }
  }

  const sideHsn = rates[deptSel]?.hsn ?? "";

  return (
    <div className="im-mask">
      <div className="im-dlg" role="dialog" aria-label="Item Master" ref={rootRef}>
        <div className="dialog-cap">
          <span className="cap-dot" />
          Item Master
          <CapBtns onClose={onClose} />
        </div>
        <div className="im-upper">
          <div className="im-main">
            <button type="button" className="fn im-add" onClick={() => startNew()}>Add Item</button>
            <div className="im-form">
              <span className="im-lbl">Item Name :</span>
              <input
                ref={nameRef}
                className="win"
                data-edit="text"
                value={name}
                maxLength={80}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  codeRef.current?.focus();
                }}
              />
              <span className="im-lbl">Item Code :</span>
              <input
                ref={codeRef}
                className="win"
                data-edit="text"
                value={sku}
                maxLength={32}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setSku(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  salesRef.current?.focus();
                }}
              />

              <span className="im-lbl">Sales Group :</span>
              <WinCombo
                inputRef={salesRef}
                value={salesGroup}
                options={salesGroups}
                open={openDrop === "sales"}
                onOpen={(next) => setOpenDrop((cur) => next ? "sales" : cur === "sales" ? "" : cur)}
                onChange={setSalesGroup}
                onEnter={() => groupRef.current?.focus()}
              />
              <span className="im-lbl">Item Group :</span>
              <div className="im-group-field">
                <WinCombo
                  inputRef={groupRef}
                  value={itemGroup}
                  options={itemGroups}
                  open={openDrop === "group"}
                  onOpen={(next) => setOpenDrop((cur) => next ? "group" : cur === "group" ? "" : cur)}
                  onChange={setItemGroup}
                  onEnter={() => costRef.current?.focus()}
                />
                <button
                  type="button"
                  className="im-plus"
                  title="Add item group"
                  onClick={() => { setGroupName(""); setGroupOpen(true); }}
                >
                  +
                </button>
              </div>

              <span className="im-lbl">Cost Price :</span>
              <input
                ref={costRef}
                className="win im-money"
                data-num="dec"
                value={cost}
                onChange={(e) => setCost(moneyText(e.target.value))}
                onBlur={(e) => setCost(fixedMoney(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  rootRef.current?.querySelector<HTMLInputElement>(veg ? "[data-veg='yes']" : "[data-veg='no']")?.focus();
                }}
              />
              <span />
              <div className="im-yn">
                <label className="chk">
                  <input type="radio" name="im-veg" data-veg="yes" data-cycle="1" checked={veg} onChange={() => setVeg(true)} onKeyDown={onVegKey} />
                  Yes
                </label>
                <label className="chk">
                  <input type="radio" name="im-veg" data-veg="no" data-cycle="1" checked={!veg} onChange={() => setVeg(false)} onKeyDown={onVegKey} />
                  No
                </label>
              </div>

              <span className="im-lbl">Stock Item :</span>
              <WinCombo
                inputRef={stockRef}
                value={stockItem}
                options={["Yes", "No"]}
                narrow
                open={openDrop === "stock"}
                onOpen={(next) => setOpenDrop((cur) => next ? "stock" : cur === "stock" ? "" : cur)}
                onChange={setStockItem}
                onEnter={() => hindiRef.current?.focus()}
              />
              <span />
              <div className="im-flags">
                <label className="chk">
                  <input
                    type="checkbox"
                    checked={comp}
                    onChange={(e) => setComp(e.target.checked)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      hideRef.current?.focus();
                    }}
                  />
                  Allow Complimentary
                </label>
                <label className="chk">
                  <input
                    ref={hideRef}
                    type="checkbox"
                    checked={hideWeb}
                    onChange={(e) => setHideWeb(e.target.checked)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      hindiRef.current?.focus();
                    }}
                  />
                  Hide in Web
                </label>
              </div>

              <span className="im-lbl">Item Name in Hindi :</span>
              <input
                ref={hindiRef}
                className="win im-span"
                data-edit="text"
                value={hindi}
                maxLength={80}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setHindi(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  focusDept(deptSel, "rate");
                }}
              />
            </div>

            <div
              className="im-depts-wrap"
              ref={deptRef}
              tabIndex={-1}
              onKeyDown={onDeptNav}
              onMouseDown={(e) => {
                if ((e.target as HTMLElement).closest("input")) return;
                deptRef.current?.focus();
              }}
            >
              <table className="im-depts">
                <colgroup>
                  <col className="c-arr" />
                  <col />
                  <col className="c-rate" />
                  <col className="c-hsn" />
                  <col className="c-flag" />
                  <col className="c-flag" />
                  <col className="c-box" />
                </colgroup>
                <thead>
                  <tr>
                    <th />
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
                    <tr
                      key={r.dept}
                      className={i === deptSel ? "on" : ""}
                      onMouseDown={() => setDeptSel(i)}
                    >
                      <td className="arr">{i === deptSel ? "►" : ""}</td>
                      <td>{r.dept}</td>
                      <td>
                        <input
                          className="cell num"
                          data-dept={i}
                          data-col="rate"
                          data-cycle="1"
                          data-num="dec"
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
                          data-cycle="1"
                          data-edit="text"
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
          </div>

          <div className="im-rail">
            <div className="im-logo-box" onClick={() => fileRef.current?.click()}>
              {logo ? <img src={logo} alt="" /> : null}
            </div>
            <button type="button" className="im-upload" onClick={() => fileRef.current?.click()}>Upload Logo</button>
            <input ref={fileRef} type="file" accept="image/*" hidden tabIndex={-1} onChange={onLogo} />
            <div className="im-hsn-lbl">HSN Code :</div>
            <input
              ref={hsnRef}
              className="win"
              data-edit="text"
              data-cycle="ud"
              value={sideHsn}
              maxLength={20}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => patchRate(deptSel, { hsn: e.target.value })}
              onKeyDown={onSideHsnKey}
            />
            <button type="button" className={`fn im-mix-btn ${mix ? "im-mix" : ""}`} onClick={() => setMix((v) => !v)}>Mix Item</button>
            <button ref={saveRef} type="button" className="fn" data-act="save" onClick={() => void save()}>Save</button>
            <button type="button" className="fn" onClick={() => startNew()}>Cancel</button>
            <button type="button" className="fn" onClick={onClose}>Exit</button>
          </div>
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
              </colgroup>
              <thead>
                <tr>
                  <th />
                  <th>ItemName</th>
                  <th>ItemCode</th>
                  <th>CostPrice</th>
                  <th className="act">Edit</th>
                  <th className="act">Delete</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, i) => (
                  <tr
                    key={item.id}
                    className={i === listSel ? "on" : ""}
                    onMouseDown={(e) => {
                      if ((e.target as HTMLElement).closest("button")) return;
                      setListSel(i);
                      listRef.current?.focus();
                    }}
                    onDoubleClick={() => edit(item)}
                  >
                    <td className="arr">{i === listSel ? "►" : ""}</td>
                    <td className="name">{item.name}</td>
                    <td>{item.sku}</td>
                    <td className="num">{money(item.costPrice)}</td>
                    <td className="act">
                      <button
                        type="button"
                        tabIndex={-1}
                        className="fn"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => edit(item)}
                      >
                        Edit
                      </button>
                    </td>
                    <td className="act">
                      <button
                        type="button"
                        tabIndex={-1}
                        className="fn"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setAskDelete(item)}
                      >
                        Delete
                      </button>
                    </td>
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
              data-edit="text"
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
          onNo={() => { setAskDelete(null); listRef.current?.focus(); }}
        />
      )}
      {err && <AlertBox message={err} onClose={() => { setErr(""); nameRef.current?.focus(); }} />}
    </div>
  );
}
