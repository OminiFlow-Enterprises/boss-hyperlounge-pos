import { formatUiLabel } from "./formatUiLabel";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { AlertBox, ConfirmAsk } from "./BillDialogs";
import {
  RIGHTS_TREE,
  applyRight,
  billPreset,
  blankOutlets,
  flagsPreset,
  mergeOutlets,
  rightsPreset,
  type BillFlags,
  type OutletRight,
  type RightNode,
  type UserFlags,
  type UserRoleLabel,
} from "../shared/userRights";

type Account = {
  id: string;
  username: string;
  userRole: UserRoleLabel;
  configured: boolean;
  discount: string;
  oldDateRecord: number;
  misReport: string;
  flags: UserFlags | null;
  bill: BillFlags | null;
  rights: Record<string, boolean> | null;
  outlets: OutletRight[] | null;
};

const MIS = ["Full", "User", "None"];

function blankFlags(): UserFlags {
  return {
    hideCollection: false,
    hideEstimate: false,
    allowComplementary: false,
    advanceCardUpdate: false,
    showCheckinRooms: false,
  };
}

function blankBill(): BillFlags {
  return {
    serviceCharge: false,
    discount: false,
    itemQty: false,
    itemRate: false,
    tableTransfer: false,
    itemTransfer: false,
  };
}

function fixedMoney(value: string) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "0.00";
  return n.toFixed(2);
}

function nodeState(node: RightNode, rights: Record<string, boolean>): "on" | "off" | "some" {
  if (!node.children?.length) return rights[node.id] ? "on" : "off";
  const kids = node.children.map((child) => nodeState(child, rights));
  if (kids.every((k) => k === "on")) return "on";
  if (kids.every((k) => k === "off")) return "off";
  return "some";
}

function RightRow({
  node,
  rights,
  open,
  depth,
  onToggle,
  onOpen,
}: {
  node: RightNode;
  rights: Record<string, boolean>;
  open: Record<string, boolean>;
  depth: number;
  onToggle: (id: string, on: boolean) => void;
  onOpen: (id: string) => void;
}) {
  const box = useRef<HTMLInputElement>(null);
  const state = nodeState(node, rights);
  useEffect(() => {
    if (box.current) box.current.indeterminate = state === "some";
  }, [state]);
  const expanded = Boolean(open[node.id]);
  return (
    <>
      <div className="um-node" style={{ paddingLeft: 4 + depth * 16 }}>
        {node.children?.length ? (
          <button
            type="button"
            className="um-plus"
            tabIndex={-1}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onOpen(node.id);
            }}
          >
            {expanded ? "−" : "+"}
          </button>
        ) : (
          <span className="um-plus spacer" />
        )}
        <label>
          <input
            ref={box}
            type="checkbox"
            checked={state === "on"}
            onChange={(e) => onToggle(node.id, e.target.checked)}
          />
          <span>{node.label}</span>
        </label>
      </div>
      {expanded && node.children?.map((child) => (
        <RightRow
          key={child.id}
          node={child}
          rights={rights}
          open={open}
          depth={depth + 1}
          onToggle={onToggle}
          onOpen={onOpen}
        />
      ))}
    </>
  );
}

export function UserMaster({ selfId, onExit }: { selfId: string; onExit: () => void }) {
  const [users, setUsers] = useState<Account[]>([]);
  const [listSel, setListSel] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [userRole, setUserRole] = useState<"" | UserRoleLabel>("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [discount, setDiscount] = useState("0.00");
  const [oldDate, setOldDate] = useState("1");
  const [mis, setMis] = useState("Full");
  const [flags, setFlags] = useState<UserFlags>(blankFlags);
  const [bill, setBill] = useState<BillFlags>(blankBill);
  const [rights, setRights] = useState<Record<string, boolean>>({});
  const [openNodes, setOpenNodes] = useState<Record<string, boolean>>({});
  const [outlets, setOutlets] = useState<OutletRight[]>(blankOutlets);
  const [outletSel, setOutletSel] = useState(0);
  const [alertText, setAlertText] = useState("");
  const [askDelete, setAskDelete] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);
  const userRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    userRef.current?.focus();
    void load();
  }, []);

  useEffect(() => {
    const row = listRef.current?.querySelector("tr.on");
    row?.scrollIntoView({ block: "nearest" });
  }, [listSel, users.length]);

  async function load() {
    const rows = await api.get<Account[]>("/api/staff");
    setUsers(rows);
    setListSel((i) => Math.min(i, Math.max(0, rows.length - 1)));
    return rows;
  }

  function clearForm() {
    setEditingId(null);
    setUsername("");
    setUserRole("");
    setPassword("");
    setPassword2("");
    setDiscount("0.00");
    setOldDate("1");
    setMis("Full");
    setFlags(blankFlags());
    setBill(blankBill());
    setRights({});
    setOutlets(blankOutlets());
    setOutletSel(0);
    userRef.current?.focus();
  }

  function edit(row: Account) {
    const role = row.userRole;
    setEditingId(row.id);
    setUsername(row.username);
    setUserRole(role);
    setPassword("");
    setPassword2("");
    setDiscount(row.discount || "0.00");
    setOldDate(String(row.oldDateRecord ?? 1));
    setMis(row.misReport || "Full");
    setFlags(row.flags ?? flagsPreset(role));
    setBill(row.bill ?? billPreset(role));
    setRights(row.rights ?? rightsPreset(role));
    setOutlets(mergeOutlets(row.outlets));
    setOutletSel(0);
    setListSel(Math.max(0, users.findIndex((u) => u.id === row.id)));
    userRef.current?.focus();
    userRef.current?.select();
  }

  function changeRole(next: string) {
    if (next !== "ADMIN" && next !== "OPERATOR") {
      setUserRole("");
      return;
    }
    setUserRole(next);
    setRights(rightsPreset(next));
    setFlags(flagsPreset(next));
    setBill(billPreset(next));
  }

  function body() {
    return {
      username: username.trim(),
      userRole,
      password,
      discount,
      oldDateRecord: Number(oldDate) || 1,
      misReport: mis,
      flags,
      bill,
      rights,
      outlets,
    };
  }

  async function save() {
    if (busy) return;
    if (!username.trim()) {
      setAlertText("Enter username");
      return;
    }
    if (userRole !== "ADMIN" && userRole !== "OPERATOR") {
      setAlertText("Select user role");
      return;
    }
    if (!editingId && !password) {
      setAlertText("Enter password");
      return;
    }
    if (password || password2) {
      if (password !== password2) {
        setAlertText("Re-Type Password does not match");
        return;
      }
    }
    setBusy(true);
    try {
      if (editingId) await api.put(`/api/staff/${editingId}`, body());
      else await api.post("/api/staff", body());
      await load();
      clearForm();
    } catch (err) {
      setAlertText(err instanceof ApiError ? err.message : "Could not save user");
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: Account) {
    setAskDelete(null);
    try {
      await api.del(`/api/staff/${row.id}`);
      if (editingId === row.id) clearForm();
      await load();
    } catch (err) {
      setAlertText(err instanceof ApiError ? err.message : "Could not delete user");
    }
  }

  function onListKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setListSel((i) => Math.min(users.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setListSel((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = users[listSel];
      if (row) edit(row);
    } else if (e.key === "Delete") {
      e.preventDefault();
      const row = users[listSel];
      if (row) setAskDelete(row);
    }
  }

  function enterNext(e: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    const fields = Array.from(root.querySelectorAll<HTMLElement>("input, select, button")).filter((el) => {
      if (el.tabIndex < 0) return false;
      if (el.closest(".um-list, .cap-btns")) return false;
      if ((el as HTMLInputElement).disabled) return false;
      return el.getBoundingClientRect().width > 0;
    });
    const index = fields.indexOf(e.currentTarget);
    const next = fields[index + 1];
    if (next) {
      next.focus();
      if (next instanceof HTMLInputElement && next.type !== "checkbox") next.select();
    }
  }

  return (
    <div className="um-screen" ref={rootRef}>
      <fieldset className="um-form">
        <legend>Add User Account</legend>
        <label className="um-field">
          <span>Username :</span>
          <input ref={userRef} className="win" value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={enterNext} />
        </label>
        <label className="um-field">
          <span>User Role :</span>
          <select className="win" data-cycle="1" value={userRole} onChange={(e) => changeRole(e.target.value)} onKeyDown={enterNext}>
            <option value="">Select</option>
            <option value="ADMIN">Admin</option>
            <option value="OPERATOR">Operator</option>
          </select>
        </label>
        <label className="um-field">
          <span>Password :</span>
          <input className="win" type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} onKeyDown={enterNext} />
        </label>
        <label className="um-field">
          <span>Re-Type Password :</span>
          <input className="win" type="password" value={password2} autoComplete="new-password" onChange={(e) => setPassword2(e.target.value)} onKeyDown={enterNext} />
        </label>
        <label className="um-field">
          <span>Discount :</span>
          <input
            className="win um-short"
            data-num="dec"
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
            onBlur={() => setDiscount(fixedMoney(discount))}
            onKeyDown={enterNext}
          />
        </label>
        <label className="um-field">
          <span>Old Date Record :</span>
          <input className="win um-short" data-num="int" value={oldDate} onChange={(e) => setOldDate(e.target.value)} onKeyDown={enterNext} />
        </label>
        <label className="um-field">
          <span>MIS Report :</span>
          <select className="win" data-cycle="1" value={mis} onChange={(e) => setMis(e.target.value)} onKeyDown={enterNext}>
            {MIS.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <div className="um-checks">
          <Check label="Hide Collection" checked={flags.hideCollection} onChange={(v) => setFlags({ ...flags, hideCollection: v })} />
          <Check label="Hide Estimate" checked={flags.hideEstimate} onChange={(v) => setFlags({ ...flags, hideEstimate: v })} />
          <Check label="Allow Complementary" checked={flags.allowComplementary} onChange={(v) => setFlags({ ...flags, allowComplementary: v })} />
          <Check label="Advance Card Update" checked={flags.advanceCardUpdate} onChange={(v) => setFlags({ ...flags, advanceCardUpdate: v })} />
          <Check label="Show Checkin Rooms" checked={flags.showCheckinRooms} onChange={(v) => setFlags({ ...flags, showCheckinRooms: v })} />
        </div>
        <fieldset className="um-bill">
          <legend>Outlet Bill Update Options</legend>
          <Check label="Service Charge Update" checked={bill.serviceCharge} onChange={(v) => setBill({ ...bill, serviceCharge: v })} />
          <Check label="Discount On Update" checked={bill.discount} onChange={(v) => setBill({ ...bill, discount: v })} />
          <Check label="Item Quantity Update" checked={bill.itemQty} onChange={(v) => setBill({ ...bill, itemQty: v })} />
          <Check label="Item Rate Update" checked={bill.itemRate} onChange={(v) => setBill({ ...bill, itemRate: v })} />
          <div className="um-checks">
            <Check label="Table Transfer" checked={bill.tableTransfer} onChange={(v) => setBill({ ...bill, tableTransfer: v })} />
            <Check label="Item Transfer" checked={bill.itemTransfer} onChange={(v) => setBill({ ...bill, itemTransfer: v })} />
          </div>
        </fieldset>
      </fieldset>

      <div className="um-rights">
        <div className="um-rights-lbl">User Rights :</div>
        <div className="um-rights-box">
          {RIGHTS_TREE.map((node) => (
            <RightRow
              key={node.id}
              node={node}
              rights={rights}
              open={openNodes}
              depth={0}
              onToggle={(id, on) => setRights((prev) => applyRight(prev, id, on))}
              onOpen={(id) => setOpenNodes((prev) => ({ ...prev, [id]: !prev[id] }))}
            />
          ))}
        </div>
      </div>

      <div
        className="um-list"
        tabIndex={0}
        data-list="open"
        ref={listRef}
        onKeyDown={onListKey}
      >
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>User Role</th>
              <th>Edit</th>
              <th>Delete</th>
            </tr>
          </thead>
          <tbody>
            {users.map((row, i) => (
              <tr
                key={row.id}
                className={i === listSel ? "on" : ""}
                onClick={() => setListSel(i)}
                onDoubleClick={() => edit(row)}
              >
                <td>{row.username}</td>
                <td>{row.userRole}</td>
                <td>
                  <button type="button" className="um-link" tabIndex={-1} onClick={() => edit(row)}>Edit</button>
                </td>
                <td>
                  <button
                    type="button"
                    className="um-link"
                    tabIndex={-1}
                    onClick={() => {
                      if (row.id === selfId) setAlertText("Cannot delete the logged in user");
                      else setAskDelete(row);
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="um-outlet-wrap" data-list="open">
        <table className="um-outlets">
          <colgroup>
            <col className="c-out" />
            <col className="c-disc" />
            <col className="c-kot" />
          </colgroup>
          <thead>
            <tr>
              <th>Outlet</th>
              <th>Disc.%</th>
              <th>Minus KOT</th>
            </tr>
          </thead>
          <tbody>
            {outlets.map((row, i) => (
              <tr key={row.outlet} className={i === outletSel ? "on" : ""} onClick={() => setOutletSel(i)}>
                <td>{formatUiLabel(row.outlet)}</td>
                <td>
                  <input
                    className="cell"
                    data-num="dec"
                    value={row.disc}
                    onChange={(e) => {
                      const disc = e.target.value;
                      setOutlets((prev) => prev.map((item, n) => n === i ? { ...item, disc } : item));
                    }}
                    onBlur={() => {
                      setOutlets((prev) => prev.map((item, n) => {
                        if (n !== i) return item;
                        const disc = item.disc.trim();
                        return { ...item, disc: disc === "" ? "" : fixedMoney(disc) };
                      }));
                    }}
                    onKeyDown={enterNext}
                  />
                </td>
                <td>
                  <select
                    className="cell"
                    data-cycle="1"
                    value={row.minusKot}
                    onChange={(e) => {
                      const minusKot = e.target.value === "No" ? "No" : "Yes";
                      setOutlets((prev) => prev.map((item, n) => n === i ? { ...item, minusKot } : item));
                    }}
                    onKeyDown={enterNext}
                  >
                    <option value="Yes">Yes</option>
                    <option value="No">No</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="um-actions">
        <button type="button" className="fn" onClick={() => void save()}>Save</button>
        <button type="button" className="fn" onClick={clearForm}>Cancel</button>
        <button type="button" className="fn" onClick={onExit}>Exit</button>
      </div>

      {askDelete && (
        <ConfirmAsk
          message="Do you want to delete this user?"
          onYes={() => void remove(askDelete)}
          onNo={() => setAskDelete(null)}
        />
      )}
      {alertText && <AlertBox message={alertText} onClose={() => setAlertText("")} />}
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="chk">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
