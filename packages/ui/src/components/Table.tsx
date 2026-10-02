import type { ReactNode } from "react";
export interface Column<R> { key: string; header: ReactNode; cell: (row: R) => ReactNode; width?: number | string; num?: boolean }
export function Table<R>({ columns, rows, rowKey, empty, onRow }: { columns: Column<R>[]; rows: R[]; rowKey: (r: R) => string; empty?: ReactNode; onRow?: (r: R) => void }) {
  return (
    <table className="table">
      <thead><tr>{columns.map((c) => <th key={c.key} style={{ width: c.width }}>{c.header}</th>)}</tr></thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={columns.length} className="t-muted" style={{ padding: 20, textAlign: "center" }}>{empty ?? "—"}</td></tr>}
        {rows.map((r) => (
          <tr key={rowKey(r)} onClick={onRow ? () => onRow(r) : undefined} style={onRow ? { cursor: "pointer" } : undefined}>
            {columns.map((c) => <td key={c.key} className={c.num ? "num" : undefined}>{c.cell(r)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
