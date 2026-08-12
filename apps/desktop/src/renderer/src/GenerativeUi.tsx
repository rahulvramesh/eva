import { useState } from "react";
import { CalendarBlank, Check, CheckCircle, Circle, Clock, ListChecks, Pause, Play, ShieldCheck, Trash, WarningCircle } from "@phosphor-icons/react";
import type { ToolCall, UiBlock } from "../../../../../packages/protocol/src/index";

type Props = {
  block: UiBlock;
  toolCalls: ToolCall[];
  onChoice: (selected: string[]) => void;
  onApprove: (toolCallId: string) => void;
  onReject: (toolCallId: string) => void;
  onReminderStatus: (status: "active" | "paused") => void;
  onReminderDelete: () => void;
};

export function GenerativeUiBlock({ block, toolCalls, onChoice, onApprove, onReject, onReminderStatus, onReminderDelete }: Props) {
  if (block.kind === "plan") return <PlanCard block={block} />;
  if (block.kind === "choice") return <ChoiceCard block={block} onSubmit={onChoice} />;
  if (block.kind === "table") return <TableCard block={block} />;
  if (block.kind === "reminder") return <ReminderCard block={block} onStatus={onReminderStatus} onDelete={onReminderDelete} />;
  const tool = toolCalls.find((candidate) => candidate.id === block.toolCallId);
  return <ApprovalCard block={block} tool={tool} onApprove={onApprove} onReject={onReject} />;
}

function PlanCard({ block }: { block: Extract<UiBlock, { kind: "plan" }> }) {
  return <section className="genui-card genui-plan"><header><ListChecks weight="bold" /><div><small>Plan</small><strong>{block.title}</strong></div></header><ol>{block.steps.map((step) => <li className={step.status} key={step.id}>{step.status === "complete" ? <CheckCircle weight="fill" /> : step.status === "error" ? <WarningCircle weight="fill" /> : <Circle weight={step.status === "running" ? "fill" : "regular"} />}<span>{step.label}</span><small>{step.status}</small></li>)}</ol></section>;
}

function ChoiceCard({ block, onSubmit }: { block: Extract<UiBlock, { kind: "choice" }>; onSubmit: (selected: string[]) => void }) {
  const [selected, setSelected] = useState<string[]>(block.selected);
  const locked = block.status === "submitted";
  const toggle = (id: string) => setSelected((current) => block.allowMultiple ? current.includes(id) ? current.filter((value) => value !== id) : [...current, id] : [id]);
  return <section className="genui-card genui-choice"><header><small>Choose</small><strong>{block.question}</strong></header><div className="genui-options">{block.options.map((option) => { const active = selected.includes(option.id); return <button type="button" disabled={locked} className={active ? "selected" : ""} key={option.id} onClick={() => toggle(option.id)}><span className="choice-check">{active && <Check weight="bold" />}</span><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></button>; })}</div>{!locked && <button type="button" className="genui-primary" disabled={!selected.length} onClick={() => onSubmit(selected)}>Continue</button>}{locked && <div className="genui-complete"><CheckCircle weight="fill" /> Choice submitted</div>}</section>;
}

function TableCard({ block }: { block: Extract<UiBlock, { kind: "table" }> }) {
  return <section className="genui-card genui-table">{block.title && <header><small>Overview</small><strong>{block.title}</strong></header>}<div className="genui-table-scroll"><table><thead><tr>{block.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{block.rows.map((row, index) => <tr key={index}>{block.columns.map((column) => <td key={column.key}>{formatCell(row[column.key])}</td>)}</tr>)}</tbody></table></div>{block.caption && <p>{block.caption}</p>}</section>;
}

function ReminderCard({ block, onStatus, onDelete }: { block: Extract<UiBlock, { kind: "reminder" }>; onStatus: (status: "active" | "paused") => void; onDelete: () => void }) {
  return <section className="genui-card genui-reminder"><header><CalendarBlank weight="fill" /><div><small>Reminder</small><strong>{block.title}</strong></div><span className={`genui-badge ${block.status}`}>{block.status}</span></header><div className="reminder-time"><Clock weight="bold" /><span>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: block.timezone }).format(new Date(block.runAt))}<small>{block.timezone} · {block.recurrence === "none" ? "one time" : block.recurrence}</small></span></div>{block.notes && <p>{block.notes}</p>}<footer><span>{block.appEnabled ? "App" : ""}{block.appEnabled && block.emailEnabled ? " + " : ""}{block.emailEnabled ? "Email" : ""}</span>{block.status !== "completed" && <button type="button" onClick={() => onStatus(block.status === "active" ? "paused" : "active")}>{block.status === "active" ? <Pause weight="fill" /> : <Play weight="fill" />}{block.status === "active" ? "Pause" : "Resume"}</button>}<button type="button" className="danger" onClick={onDelete}><Trash weight="bold" /> Delete</button></footer></section>;
}

function ApprovalCard({ block, tool, onApprove, onReject }: { block: Extract<UiBlock, { kind: "approval" }>; tool?: ToolCall; onApprove: (id: string) => void; onReject: (id: string) => void }) {
  const pending = tool?.status === "pending";
  const action = tool?.name === "python_session" ? "Run Python" : "Run command";
  return <section className="genui-card genui-approval"><header><ShieldCheck weight="fill" /><div><small>Approval required · {block.risk} risk</small><strong>{block.title}</strong></div></header><code>{block.description}</code>{pending ? <footer><button type="button" onClick={() => onReject(block.toolCallId)}>Reject</button><button type="button" className="genui-primary" onClick={() => onApprove(block.toolCallId)}>{action}</button></footer> : <div className="genui-complete"><CheckCircle weight="fill" /> {tool?.status ? `Tool ${tool.status}` : "Approval unavailable"}</div>}</section>;
}

function formatCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "boolean" ? value ? "Yes" : "No" : String(value);
}
